import { Body, Controller, ForbiddenException, Get, Headers, HttpCode, Inject, Logger, Optional, Post, Query, Req, UnauthorizedException } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'crypto';
import { WhatsAppChatService } from '../agent/whatsapp-chat.service';
import { BookingService } from '../booking/booking.service';
import { CabinetConfig } from '../config/cabinet.schema';
import { CabinetService } from '../config/cabinet.service';
import { normalizePhone } from '../config/phone';
import { BookingReply, isInboundAware, parseBookingReply } from '../notify/meta-whatsapp.notifier';
import { NOTIFIER, Notifier } from '../notify/notifier.port';
import { AdminChatService } from './admin-chat.service';

/**
 * Meta WhatsApp Cloud API webhook for the cabinet's WhatsApp Business number.
 *  - GET is the verification handshake Meta runs when the URL is saved in the app dashboard:
 *    echo hub.challenge when hub.verify_token equals WA_VERIFY_TOKEN.
 *  - POST carries inbound messages and delivery statuses. It always answers 200 — Meta retries
 *    anything else for days and never dedupes — and the `seen` set absorbs those retries.
 *  - X-Hub-Signature-256 (HMAC-SHA256 of the raw body with the app secret) is enforced when
 *    WA_APP_SECRET is set, the same opt-in shape as VAPI_SECRET. main.ts keeps the raw body.
 * Three kinds of message are acted on, in this order: a patient's tap on Confirmer / Annuler under
 * a booking message (payload `confirm:<id>` / `cancel:<id>`); an admin command (STOP/START, MODE…)
 * from a `whatsapp_admin` number; and, when the chat agent is bound, a patient's text or voice
 * note, answered by Amira in the chat. The cabinet for a patient is the one whose WhatsApp number
 * received the message (metadata.display_phone_number).
 */

export interface InboundMessage {
  id: string;
  from: string;
  type: string;
  text?: string;
  /** Template quick-reply payload or interactive reply id: `confirm:<bookingId>` / `cancel:<bookingId>`. */
  payload?: string;
  /** The business number that received it (metadata.display_phone_number): picks the cabinet. */
  to?: string;
  /** Voice note: the media id to download and its MIME type ("audio/ogg; codecs=opus"). */
  mediaId?: string;
  mimeType?: string;
}

/** Flatten Meta's entry → changes → value.messages envelope. Statuses and read receipts fall out. */
export function inboundMessages(body: any): InboundMessage[] {
  const out: InboundMessage[] = [];
  for (const entry of body?.entry ?? [])
    for (const change of entry?.changes ?? []) {
      const to = change?.value?.metadata?.display_phone_number;
      for (const m of change?.value?.messages ?? [])
        out.push({
          id: String(m.id ?? ''),
          from: String(m.from ?? ''),
          type: String(m.type ?? ''),
          text: messageText(m),
          payload: messagePayload(m),
          to: to ? String(to) : undefined,
          ...(m.type === 'audio' && m.audio?.id ? { mediaId: String(m.audio.id), mimeType: m.audio.mime_type ? String(m.audio.mime_type) : undefined } : {}),
        });
    }
  return out;
}

function messageText(m: any): string | undefined {
  switch (m.type) {
    case 'text':
      return m.text?.body;
    case 'button': // quick-reply on a template (confirmer / annuler)
      return m.button?.text;
    case 'interactive':
      return m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title;
    default:
      return undefined;
  }
}

function messagePayload(m: any): string | undefined {
  switch (m.type) {
    case 'button':
      return m.button?.payload;
    case 'interactive':
      return m.interactive?.button_reply?.id ?? m.interactive?.list_reply?.id;
    default:
      return undefined;
  }
}

export function validSignature(rawBody: Buffer | undefined, header: string | undefined, secret: string | undefined): boolean {
  if (!secret) return true;
  if (!rawBody || !header?.startsWith('sha256=')) return false;
  const expected = Buffer.from(createHmac('sha256', secret).update(rawBody).digest('hex'), 'hex');
  const got = Buffer.from(header.slice('sha256='.length), 'hex');
  return got.length === expected.length && timingSafeEqual(got, expected);
}

@Controller('webhooks/whatsapp')
export class WhatsAppController {
  private readonly log = new Logger(WhatsAppController.name);
  private readonly seen = new Set<string>();

  constructor(
    private readonly admin: AdminChatService,
    private readonly booking: BookingService,
    private readonly cabinets: CabinetService,
    @Inject(NOTIFIER) private readonly notify: Notifier,
    @Optional() private readonly chat?: WhatsAppChatService,
  ) {}

  @Get()
  verify(@Query('hub.mode') mode?: string, @Query('hub.verify_token') token?: string, @Query('hub.challenge') challenge?: string): string {
    const expected = process.env.WA_VERIFY_TOKEN;
    if (mode === 'subscribe' && expected && token === expected && challenge) return challenge;
    throw new ForbiddenException();
  }

  @Post()
  @HttpCode(200)
  async receive(@Req() req: { rawBody?: Buffer }, @Body() body: any, @Headers('x-hub-signature-256') signature?: string) {
    if (!validSignature(req?.rawBody, signature, process.env.WA_APP_SECRET)) throw new UnauthorizedException();
    let handled = 0;
    for (const m of inboundMessages(body)) {
      if (!m.id || this.seen.has(m.id)) continue;
      this.remember(m.id);
      const from = normalizePhone(m.from);
      // Any inbound message opens Meta's 24 h window for free-form replies to that number.
      if (isInboundAware(this.notify)) this.notify.markInbound(from);
      const reply = parseBookingReply(m.payload);
      if (reply) {
        if (await this.patientReply(m, from, reply)) handled++;
        continue;
      }
      if (this.cabinets.byWhatsAppAdmin(from)) {
        if (!m.text) continue; // admins type their commands
        await this.admin.handle(from, m.text);
        handled++;
        continue;
      }
      const cfg = m.to ? this.cabinets.byWhatsAppNumber(m.to) : undefined;
      if (!cfg) {
        this.log.warn(`${m.type} from ${from}: no cabinet has WhatsApp number ${m.to ?? '(missing)'}`);
        continue;
      }
      if (!this.chat) {
        this.log.log(`ignored ${m.type} from patient ${from} (no chat agent bound)`);
        continue;
      }
      if ((await this.chat.handle(cfg, from, m)) !== null) handled++;
    }
    return { ok: true, handled };
  }

  /** Confirmer / Annuler tapped under a booking message: act on the calendar, answer the patient. */
  private async patientReply(m: InboundMessage, from: string, reply: BookingReply): Promise<boolean> {
    const cfg = m.to ? this.cabinets.byWhatsAppNumber(m.to) : undefined;
    if (!cfg) {
      this.log.warn(`${reply.action} from ${from}: no cabinet has WhatsApp number ${m.to ?? '(missing)'}`);
      return false;
    }
    let r: { ok: boolean; error?: string; label?: string };
    if (reply.action === 'confirm') {
      const c = await this.booking.confirm(cfg.id, reply.bookingId);
      r = { ok: c.ok, error: c.error, label: c.booking?.label_ar };
    } else r = await this.booking.cancel(cfg.id, reply.bookingId);
    this.log.log(`patient ${from} → ${cfg.id}: ${reply.action} ${reply.bookingId} → ${r.ok ? 'ok' : (r.error ?? 'error')}`);
    await this.notify.sendWhatsApp(from, patientAnswer(cfg, reply.action, r.ok, r.error, r.label ?? ''));
    return true;
  }

  private remember(id: string): void {
    this.seen.add(id);
    if (this.seen.size > 2000) this.seen.delete(this.seen.values().next().value!);
  }
}

/** What the patient reads after the tap. Darija, like every patient-facing message. */
function patientAnswer(cfg: CabinetConfig, action: BookingReply['action'], ok: boolean, error: string | undefined, labelAr: string): string {
  if (ok && action === 'confirm') return `✅ ${cfg.name}: موعدك مأكد، ${labelAr}. نستناوك!`;
  if (ok) return `${cfg.name}: تم إلغاء موعدك. كي تحب موعد جديد، اتصل بينا على ${cfg.phone_line}.`;
  if (error === 'cancelled') return `${cfg.name}: الموعد هذا ملغي. اتصل بينا على ${cfg.phone_line} باش تاخذ موعد جديد.`;
  return `${cfg.name}: ما لقيناش الموعد هذا. اتصل بينا على ${cfg.phone_line} باش نعاونوك.`;
}
