import { Inject, Injectable, Logger } from '@nestjs/common';
import { DateTime } from 'luxon';
import { BookingService } from '../booking/booking.service';
import { CabinetConfig } from '../config/cabinet.schema';
import { CabinetService } from '../config/cabinet.service';
import { NOTIFIER, Notifier } from '../notify/notifier.port';
import { AdminCommand, parseAdminCommand } from './commands';
import { PatientNotesService } from './patient-notes.service';
import { dayLabelFr, rangeLabelFr, resolveDay, resolveRange } from './when';

type Mode = CabinetConfig['mode'];
const MODE_FR: Record<Mode, string> = { on: 'actif', learning: 'apprentissage', off: 'arrêt' };
const MODE_MEANING_FR: Record<Mode, string> = {
  on: 'Amira réserve directement.',
  learning: 'Amira prend un message dès le moindre doute.',
  off: 'Amira ne réserve rien et transfère chaque appel au secrétariat.',
};
const MAX_SHIFT_MINUTES = 240;

/**
 * Executes admin commands for the cabinet the sender administers and answers in French (the
 * staff language in this codebase). STOP persists `mode: off`, so BookingService refuses every
 * booking (`agent_off`) and the phone prompt transfers every call, across restarts; START puts
 * the cabinet back in the mode it had before STOP, or `learning` when that is unknown (restart).
 * shift_day is the only command that messages patients: a late doctor means every remaining
 * patient today gets the new time on WhatsApp. Business errors come back as a reply, never as
 * a thrown error — Meta must always get its 200.
 */
@Injectable()
export class AdminChatService {
  private readonly log = new Logger(AdminChatService.name);
  private readonly modeBeforeStop = new Map<string, Mode>();

  constructor(
    private readonly cabinets: CabinetService,
    @Inject(NOTIFIER) private readonly notify: Notifier,
    private readonly booking: BookingService,
    private readonly notes: PatientNotesService,
  ) {}

  /**
   * One inbound admin text → one reply, sent to the sender and returned. Returns null and does
   * nothing when the sender is in no cabinet's `whatsapp_admin`: patients never reach a command.
   */
  async handle(from: string, text: string): Promise<string | null> {
    const cfg = this.cabinets.byWhatsAppAdmin(from);
    if (!cfg) return null;
    const cmd = parseAdminCommand(text);
    let reply: string;
    try {
      reply = await this.execute(cfg, cmd, from);
    } catch (e) {
      this.log.error(`admin ${from} → ${cfg.id}: ${cmd.kind} failed: ${(e as Error).message}`);
      reply = `❌ Commande ${cmd.kind} non exécutée: ${(e as Error).message}`;
    }
    this.log.log(`admin ${from} → ${cfg.id}: ${cmd.kind}`);
    await this.notify.notifyStaff(from, reply);
    return reply;
  }

  private async execute(cfg: CabinetConfig, cmd: AdminCommand, from: string): Promise<string> {
    switch (cmd.kind) {
      case 'stop':
        this.setMode(cfg, 'off');
        return `⏸ Amira est arrêtée pour ${cfg.name}. Elle ne prend plus aucun rendez-vous et transfère chaque appel au secrétariat. Envoyez START pour reprendre.`;

      case 'start': {
        if (cfg.mode !== 'off') return `▶️ Amira est déjà active pour ${cfg.name} (mode ${MODE_FR[cfg.mode]}).`;
        const mode = this.modeBeforeStop.get(cfg.id) ?? 'learning';
        this.setMode(cfg, mode);
        return `▶️ Amira reprend pour ${cfg.name} en mode ${MODE_FR[mode]}.`;
      }

      case 'set_mode': {
        if (!cmd.mode) return 'Mode inconnu. Envoyez: MODE on, MODE apprentissage ou MODE off.';
        this.setMode(cfg, cmd.mode);
        return `⚙️ Mode ${MODE_FR[cmd.mode]}. ${MODE_MEANING_FR[cmd.mode]}`;
      }

      case 'shift_day':
        return this.shiftDay(cfg, cmd.minutes);

      case 'block_slots':
        return this.blockSlots(cfg, cmd);

      case 'list_day': {
        const day = resolveDay(cmd.day, this.now(cfg));
        if (!day.isValid) return 'Date invalide. Exemples: RDV, RDV demain, RDV vendredi, RDV 31/10.';
        const r = await this.booking.list_day(cfg.id, day.toISODate()!);
        const label = dayLabelFr(day);
        if (!r.bookings.length) return `📅 ${label} — aucun rendez-vous.`;
        return [`📅 ${label} — ${r.bookings.length} rendez-vous`, ...r.bookings.map((b) => this.line(cfg, b))].join('\n');
      }

      case 'add_patient_note': {
        if (!cmd.phone) return 'Numéro manquant. Exemple: NOTE 20123456 patient anxieux, prévoir 10 min de plus.';
        if (!cmd.text) return `Texte manquant. Exemple: NOTE ${cmd.phone.replace('+216', '')} patient anxieux.`;
        const list = this.notes.add(cfg.id, cmd.phone, cmd.text, from);
        return `📝 Note ajoutée pour ${cmd.phone} (${list.length} note${list.length > 1 ? 's' : ''}): « ${cmd.text} ». Amira la lira quand ce patient appellera, sans jamais la citer.`;
      }

      case 'help':
        return help(cfg);
      case 'unknown':
        return help(cfg, cmd.text);
    }
  }

  private async shiftDay(cfg: CabinetConfig, minutes: number | null): Promise<string> {
    if (minutes === null || minutes === 0) return 'Durée manquante. Exemples: RETARD 30, RETARD 1h30, AVANCE 15.';
    if (Math.abs(minutes) > MAX_SHIFT_MINUTES) return `Décalage trop grand (max ${MAX_SHIFT_MINUTES} min). Pour fermer, envoyez BLOQUE.`;
    const r = await this.booking.shift_day(cfg.id, minutes);
    const word = minutes > 0 ? 'retard' : "d'avance";
    if (!r.moved.length) return `⏩ ${Math.abs(minutes)} min de ${word}: aucun rendez-vous restant aujourd'hui.`;
    for (const b of r.moved) {
      const type = this.typeLabel(cfg, b.type_id);
      const text =
        minutes > 0
          ? `${cfg.name}: سماحنا، الدكتور تأخر ${minutes} دقيقة. موعدك (${type}) ولى ${b.label_ar}.`
          : `${cfg.name}: موعدك (${type}) تقدم ${-minutes} دقيقة، ولى ${b.label_ar}. إذا ما تنجمش، كلمنا.`;
      await this.notify.sendWhatsApp(b.patient_phone, text);
    }
    const lines = r.moved.map((b) => {
      const now = DateTime.fromISO(b.start!).setZone(cfg.timezone);
      return `${now.minus({ minutes }).toFormat('HH:mm')} → ${now.toFormat('HH:mm')} ${b.patient_name}`;
    });
    return [`⏩ ${Math.abs(minutes)} min de ${word} aujourd'hui: ${r.moved.length} rendez-vous déplacé${r.moved.length > 1 ? 's' : ''}, patients prévenus par WhatsApp.`, ...lines].join('\n');
  }

  private async blockSlots(cfg: CabinetConfig, cmd: Extract<AdminCommand, { kind: 'block_slots' }>): Promise<string> {
    const now = this.now(cfg);
    const day = resolveDay(cmd.day, now);
    if (!day.isValid) return 'Date invalide. Exemples: BLOQUE vendredi, BLOQUE 31/10 matin, BLOQUE demain 14h-16h.';
    const range = resolveRange(day, cmd.part);
    if (!range) return 'Horaire invalide. Exemples: BLOQUE demain matin, BLOQUE vendredi 14h-16h, BLOQUE lundi 15h.';
    if (range.to <= now) return 'Cette période est déjà passée.';
    const r = await this.booking.block_slots(cfg.id, range.from.toISO()!, range.to.toISO()!, cmd.reason);
    const head = `⛔ ${dayLabelFr(day)}, ${rangeLabelFr(day, range, cmd.part)}: bloqué (${cmd.reason}).`;
    if (!r.affected.length) return `${head}\nAucun rendez-vous touché.`;
    return [head, `${r.affected.length} rendez-vous à déplacer:`, ...r.affected.map((b) => this.line(cfg, b))].join('\n');
  }

  private setMode(cfg: CabinetConfig, mode: Mode): void {
    if (cfg.mode === mode) return;
    if (mode === 'off') this.modeBeforeStop.set(cfg.id, cfg.mode);
    else this.modeBeforeStop.delete(cfg.id);
    this.cabinets.upsert({ ...cfg, mode });
  }

  private now(cfg: CabinetConfig): DateTime {
    return DateTime.now().setZone(cfg.timezone);
  }

  private typeLabel(cfg: CabinetConfig, typeId: string): string {
    return cfg.types.find((t) => t.id === typeId)?.label_fr ?? typeId;
  }

  private line(cfg: CabinetConfig, b: { start: string | null; patient_name: string; patient_phone: string; type_id: string; status: string }): string {
    const at = DateTime.fromISO(b.start!).setZone(cfg.timezone).toFormat('HH:mm');
    return `${at} ${b.patient_name} – ${this.typeLabel(cfg, b.type_id)} (${b.patient_phone})${b.status === 'unconfirmed' ? ' ?' : ''}`;
  }
}

function help(cfg: CabinetConfig, unknown?: string): string {
  return [
    unknown ? `Je n'ai pas compris « ${unknown.slice(0, 40)} ».` : undefined,
    `Amira — ${cfg.name} (mode ${MODE_FR[cfg.mode]})`,
    'STOP / START → arrêter Amira (appels au secrétariat) / reprendre',
    'MODE on | apprentissage | off',
    'RDV [demain | vendredi | 31/10] → les rendez-vous du jour',
    'RETARD 30 → décale les rendez-vous restants, prévient les patients',
    'BLOQUE vendredi [matin | 14h-16h] [raison] → ferme un créneau',
    'NOTE 20123456 texte → mémo qu’Amira lit quand ce patient appelle',
  ]
    .filter(Boolean)
    .join('\n');
}
