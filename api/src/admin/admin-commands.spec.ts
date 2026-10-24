import { mkdtempSync, readFileSync } from 'fs';
import { DateTime, Settings } from 'luxon';
import { tmpdir } from 'os';
import { join } from 'path';
import { systemPrompt } from '../agent/tools';
import { BookingService } from '../booking/booking.service';
import { MemoryCalendar } from '../calendar/memory.calendar';
import { CabinetConfig } from '../config/cabinet.schema';
import { CabinetService } from '../config/cabinet.service';
import { ConsoleNotifier } from '../notify/notifier.port';
import { AdminChatService } from './admin-chat.service';
import { parseAdminCommand } from './commands';
import { PatientNotesService } from './patient-notes.service';
import { parseMinutes, parseWhen, resolveDay, resolveRange } from './when';
import demo from '../../cabinets/demo.json';

const cfg = CabinetConfig.parse(demo);
const ZONE = 'Africa/Tunis';
// Monday 2026-10-26 09:00 Tunis, like booking.spec.
const NOW = DateTime.fromISO('2026-10-26T09:00:00', { zone: ZONE });
Settings.now = () => NOW.toMillis();
const ADMIN = '+21620000001';

beforeAll(() => jest.spyOn(console, 'log').mockImplementation(() => undefined));
afterAll(() => jest.restoreAllMocks());

describe('parseAdminCommand with arguments', () => {
  it.each([
    ['MODE on', 'on'],
    ['mode apprentissage', 'learning'],
    ['Mode off', 'off'],
    ['mode actif', 'on'],
    ['وضع تعلم', 'learning'],
    ['MODE', null],
    ['mode banane', null],
  ])('set_mode: %s', (t, mode) => expect(parseAdminCommand(t)).toEqual({ kind: 'set_mode', mode }));

  it.each([
    ['RETARD 30', 30],
    ['retard 30 min', 30],
    ['Retard 1h', 60],
    ['retard 1h30', 90],
    ['+45', 45],
    ['تأخير 20', 20],
    ['تأخير ٢٠', 20],
    ['late 15', 15],
    ['décale 10', 10],
    ['avance 15', -15],
    ['retard', null],
  ])('shift_day: %s', (t, minutes) => expect(parseAdminCommand(t)).toEqual({ kind: 'shift_day', minutes }));

  it('block_slots: day, part of day and reason', () => {
    const friday = { type: 'weekday', weekday: 5 };
    expect(parseAdminCommand('BLOQUE vendredi')).toEqual({ kind: 'block_slots', day: friday, part: 'all', reason: 'fermé' });
    expect(parseAdminCommand('ferme demain après-midi')).toEqual({ kind: 'block_slots', day: { type: 'tomorrow' }, part: 'afternoon', reason: 'fermé' });
    expect(parseAdminCommand('bloque vendredi 14h-16h dentiste absent')).toEqual({
      kind: 'block_slots',
      day: friday,
      part: { start: '14:00', end: '16:00' },
      reason: 'dentiste absent',
    });
    expect(parseAdminCommand('Bloque 31/10 matin congrès')).toEqual({ kind: 'block_slots', day: { type: 'date', day: 31, month: 10 }, part: 'morning', reason: 'congrès' });
    expect(parseAdminCommand('bloque lundi 15h')).toEqual({ kind: 'block_slots', day: { type: 'weekday', weekday: 1 }, part: { start: '15:00', end: '24:00' }, reason: 'fermé' });
    expect(parseAdminCommand('سكر الجمعة')).toEqual({ kind: 'block_slots', day: friday, part: 'all', reason: 'fermé' });
    expect(parseAdminCommand('sakker ghodwa 9-12')).toEqual({ kind: 'block_slots', day: { type: 'tomorrow' }, part: { start: '09:00', end: '12:00' }, reason: 'fermé' });
    expect(parseAdminCommand('bloque')).toEqual({ kind: 'block_slots', day: { type: 'today' }, part: 'all', reason: 'fermé' });
  });

  it.each([
    ['RDV', { type: 'today' }],
    ['rdv demain', { type: 'tomorrow' }],
    ['Agenda vendredi', { type: 'weekday', weekday: 5 }],
    ['liste 31/10', { type: 'date', day: 31, month: 10 }],
    ['مواعيد غدوة', { type: 'tomorrow' }],
    ['demain', { type: 'tomorrow' }],
    ['Vendredi ?', { type: 'weekday', weekday: 5 }],
    ['lyoum', { type: 'today' }],
  ])('list_day: %s', (t, day) => expect(parseAdminCommand(t)).toEqual({ kind: 'list_day', day }));

  it('add_patient_note: phone forms a secretary types', () => {
    const note = (phone: string | null, text: string) => ({ kind: 'add_patient_note', phone, text });
    expect(parseAdminCommand('NOTE 20123456 patient anxieux, prévoir 10 min')).toEqual(note('+21620123456', 'patient anxieux, prévoir 10 min'));
    expect(parseAdminCommand('note +216 20 123 456 doit 50 TND')).toEqual(note('+21620123456', 'doit 50 TND'));
    expect(parseAdminCommand('note 20 123 456 2 dents à extraire')).toEqual(note('+21620123456', '2 dents à extraire'));
    expect(parseAdminCommand('note 0021620123456 carnet CNAM')).toEqual(note('+21620123456', 'carnet CNAM'));
    expect(parseAdminCommand('ملاحظة 20123456 يخاف من الإبرة')).toEqual(note('+21620123456', 'يخاف من الإبرة'));
    expect(parseAdminCommand('note anxieux')).toEqual(note(null, 'anxieux'));
    expect(parseAdminCommand('note 20123456')).toEqual(note('+21620123456', ''));
  });

  it.each(['On ferme vendredi', 'Bonjour', 'Le patient Trabelsi a annulé', 'started', 'notez bien'])('still unknown: %s', (t) =>
    expect(parseAdminCommand(t).kind).toBe('unknown'),
  );
});

describe('when', () => {
  const iso = (r: { from: DateTime; to: DateTime }) => [r.from.toISO(), r.to.toISO()];

  it('resolves relative days in the cabinet zone', () => {
    expect(resolveDay({ type: 'today' }, NOW).toISODate()).toBe('2026-10-26');
    expect(resolveDay({ type: 'tomorrow' }, NOW).toISODate()).toBe('2026-10-27');
    expect(resolveDay({ type: 'weekday', weekday: 1 }, NOW).toISODate()).toBe('2026-10-26'); // today is Monday
    expect(resolveDay({ type: 'weekday', weekday: 5 }, NOW).toISODate()).toBe('2026-10-30');
    expect(resolveDay({ type: 'date', day: 31, month: 10 }, NOW).toISODate()).toBe('2026-10-31');
    expect(resolveDay({ type: 'date', day: 5, month: 1 }, NOW).toISODate()).toBe('2027-01-05'); // already past this year
    expect(resolveDay({ type: 'date', day: 5, month: 1, year: 2026 }, NOW).toISODate()).toBe('2026-01-05');
    expect(resolveDay({ type: 'date', day: 31, month: 2 }, NOW).isValid).toBe(false);
  });

  it('resolves parts of the day', () => {
    const day = NOW.startOf('day');
    expect(iso(resolveRange(day, 'all')!)).toEqual([day.toISO(), day.plus({ days: 1 }).toISO()]);
    expect(iso(resolveRange(day, 'morning')!)).toEqual([day.toISO(), day.set({ hour: 13 }).toISO()]);
    expect(iso(resolveRange(day, 'afternoon')!)).toEqual([day.set({ hour: 13 }).toISO(), day.plus({ days: 1 }).toISO()]);
    expect(iso(resolveRange(day, { start: '14:00', end: '16:30' })!)).toEqual([day.set({ hour: 14 }).toISO(), day.set({ hour: 16, minute: 30 }).toISO()]);
    expect(iso(resolveRange(day, { start: '15:00', end: '24:00' })!)[1]).toBe(day.plus({ days: 1 }).toISO());
    expect(resolveRange(day, { start: '16:00', end: '14:00' })).toBeNull();
    expect(resolveRange(day, { start: '25:00', end: '26:00' })).toBeNull();
  });

  it('parses minutes', () => {
    expect(parseMinutes('30')).toBe(30);
    expect(parseMinutes('30mn')).toBe(30);
    expect(parseMinutes('1h30')).toBe(90);
    expect(parseMinutes('2h')).toBe(120);
    expect(parseMinutes('٣٠')).toBe(30);
    expect(parseMinutes('demain')).toBeNull();
  });

  it('keeps the leftover text as the reason, without French filler words', () => {
    expect(parseWhen('le vendredi 14h-16h pour congrès')).toEqual({ day: { type: 'weekday', weekday: 5 }, part: { start: '14:00', end: '16:00' }, rest: 'congrès' });
    expect(parseWhen('')).toEqual({ day: null, part: 'all', rest: '' });
  });
});

function make() {
  process.env.CABINETS_DIR = mkdtempSync(join(tmpdir(), 'darija-cmd-cab-'));
  const notesDir = mkdtempSync(join(tmpdir(), 'darija-cmd-notes-'));
  process.env.PATIENT_NOTES_DIR = notesDir;
  const cabinets = new CabinetService();
  cabinets.upsert(cfg);
  const cal = new MemoryCalendar();
  const booking = new BookingService(cal, cabinets);
  const notifier = new ConsoleNotifier();
  const notes = new PatientNotesService();
  const admin = new AdminChatService(cabinets, notifier, booking, notes);
  const book = (name: string, phone: string, hour: number, minute = 0, type_id = 'consultation') =>
    booking.book('demo', { patient_phone: phone, patient_name: name, type_id, start: NOW.set({ hour, minute }).toISO()! });
  return { cabinets, booking, notifier, notes, admin, notesDir, book };
}

describe('AdminChatService commands', () => {
  it('set_mode changes and persists the mode; START returns to the mode set before off', async () => {
    const { admin, cabinets } = make();
    expect(await admin.handle(ADMIN, 'MODE on')).toMatch(/Mode actif/);
    expect(cabinets.get('demo').mode).toBe('on');
    expect(await admin.handle(ADMIN, 'mode off')).toMatch(/Mode arrêt/);
    expect(cabinets.get('demo').mode).toBe('off');
    expect(await admin.handle(ADMIN, 'START')).toMatch(/mode actif/);
    expect(cabinets.get('demo').mode).toBe('on');
    expect(await admin.handle(ADMIN, 'mode banane')).toMatch(/Mode inconnu/);
    expect(cabinets.get('demo').mode).toBe('on');
  });

  it('list_day lists the day with time, name, type and phone', async () => {
    const { admin, book } = make();
    expect(await admin.handle(ADMIN, 'RDV')).toBe('📅 lundi 26 octobre — aucun rendez-vous.');
    await book('Mme Trabelsi', '+21620123456', 10);
    await book('Ali', '+21699000000', 11, 30, 'cleaning');
    const reply = await admin.handle(ADMIN, 'rdv');
    expect(reply).toBe(['📅 lundi 26 octobre — 2 rendez-vous', '10:00 Mme Trabelsi – Consultation (+21620123456)', '11:30 Ali – Détartrage (+21699000000)'].join('\n'));
    expect(await admin.handle(ADMIN, 'rdv demain')).toMatch(/mardi 27 octobre — aucun/);
    expect(await admin.handle(ADMIN, 'RDV 31/02')).toMatch(/Date invalide/);
  });

  it('shift_day moves the remaining bookings and tells every moved patient on WhatsApp', async () => {
    const { admin, book, notifier } = make();
    await book('A', '+2161', 10);
    await book('B', '+2162', 11);
    const reply = await admin.handle(ADMIN, 'RETARD 30');
    expect(reply).toBe(['⏩ 30 min de retard aujourd\'hui: 2 rendez-vous déplacés, patients prévenus par WhatsApp.', '10:00 → 10:30 A', '11:00 → 11:30 B'].join('\n'));
    const wa = notifier.sent.filter((s) => s.kind === 'wa');
    expect(wa.map((s) => s.to)).toEqual(['+2161', '+2162']);
    expect(wa[0].text).toContain('30 دقيقة');
    expect(wa[0].text).toContain('الاثنين 10:30');
    expect(await admin.handle(ADMIN, 'rdv')).toMatch(/10:30 A[\s\S]*11:30 B/);

    expect(await admin.handle(ADMIN, 'retard')).toMatch(/Durée manquante/);
    expect(await admin.handle(ADMIN, 'retard 500')).toMatch(/trop grand/);
  });

  it('shift_day with nothing left says so and messages nobody', async () => {
    const { admin, notifier } = make();
    expect(await admin.handle(ADMIN, 'avance 15')).toMatch(/aucun rendez-vous restant/);
    expect(notifier.sent.filter((s) => s.kind === 'wa')).toHaveLength(0);
  });

  it('block_slots closes the range, lists the bookings to move, and removes the slots from availability', async () => {
    const { admin, book, booking } = make();
    await book('A', '+2161', 15);
    const reply = await admin.handle(ADMIN, "BLOQUE aujourd'hui après-midi réunion");
    expect(reply).toBe(["⛔ lundi 26 octobre, l'après-midi: bloqué (réunion).", '1 rendez-vous à déplacer:', '15:00 A – Consultation (+2161)'].join('\n'));
    const av = await booking.get_availability('demo', 'consultation', NOW.toISO()!, 1);
    expect(av.offers!.every((o) => DateTime.fromISO(o.start!).setZone(ZONE).hour < 13)).toBe(true);

    expect(await admin.handle(ADMIN, 'bloque vendredi 14h-16h')).toBe('⛔ vendredi 30 octobre, 14:00–16:00: bloqué (fermé).\nAucun rendez-vous touché.');
    expect(await admin.handle(ADMIN, 'BLOQUE 31/02')).toMatch(/Date invalide/);
    expect(await admin.handle(ADMIN, 'bloque demain 16h-14h')).toMatch(/Horaire invalide/);
    expect(await admin.handle(ADMIN, "bloque aujourd'hui 7h-8h")).toMatch(/déjà passée/);
  });

  it('add_patient_note stores the memo and the prompt carries it when that patient calls', async () => {
    const { admin, notes, notesDir } = make();
    expect(await admin.handle(ADMIN, 'NOTE 20123456 patient anxieux')).toMatch(/Note ajoutée pour \+21620123456 \(1 note\): « patient anxieux »/);
    expect(await admin.handle(ADMIN, 'note 20 123 456 doit 50 TND')).toMatch(/\(2 notes\)/);
    expect(Object.keys(JSON.parse(readFileSync(join(notesDir, 'demo.json'), 'utf-8')))).toEqual(['+21620123456']);
    const list = notes.for('demo', '21620123456');
    expect(list.map((n) => n.text)).toEqual(['patient anxieux', 'doit 50 TND']);
    expect(list[0].by).toBe(ADMIN);

    const prompt = systemPrompt(cfg, '+21620123456', 'lundi', list.map((n) => n.text));
    expect(prompt).toContain('NOTES DU CABINET SUR CE PATIENT');
    expect(prompt).toContain('- patient anxieux');
    expect(systemPrompt(cfg, '+21600000000', 'lundi', notes.for('demo', '+21600000000').map((n) => n.text))).not.toContain('NOTES DU CABINET');

    expect(await admin.handle(ADMIN, 'note anxieux')).toMatch(/Numéro manquant/);
    expect(await admin.handle(ADMIN, 'note 20123456')).toMatch(/Texte manquant/);
  });

  it('help lists every command', async () => {
    const { admin } = make();
    const reply = (await admin.handle(ADMIN, 'help'))!;
    for (const k of ['STOP', 'START', 'MODE', 'RDV', 'RETARD', 'BLOQUE', 'NOTE']) expect(reply).toContain(k);
  });

  it('a failing calendar becomes a reply, never a thrown error', async () => {
    const { admin, booking, notifier } = make();
    jest.spyOn(booking, 'list_day').mockRejectedValue(new Error('calendar down'));
    const reply = await admin.handle(ADMIN, 'RDV');
    expect(reply).toBe('❌ Commande list_day non exécutée: calendar down');
    expect(notifier.sent.at(-1)).toMatchObject({ to: ADMIN, text: reply });
  });
});
