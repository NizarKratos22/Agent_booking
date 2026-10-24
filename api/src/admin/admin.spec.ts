import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { createHmac } from 'crypto';
import { mkdtempSync, readFileSync } from 'fs';
import { DateTime } from 'luxon';
import { tmpdir } from 'os';
import { join } from 'path';
import { BookingService } from '../booking/booking.service';
import { Booking } from '../calendar/calendar.port';
import { MemoryCalendar } from '../calendar/memory.calendar';
import { CabinetConfig } from '../config/cabinet.schema';
import { CabinetService } from '../config/cabinet.service';
import { normalizePhone } from '../config/phone';
import { FetchLike, MetaWhatsAppNotifier } from '../notify/meta-whatsapp.notifier';
import { ConsoleNotifier } from '../notify/notifier.port';
import { AdminChatService } from './admin-chat.service';
import { parseAdminCommand } from './commands';
import { PatientNotesService } from './patient-notes.service';
import { inboundMessages, validSignature, WhatsAppController } from './whatsapp.controller';
import demo from '../../cabinets/demo.json';

const cfg = CabinetConfig.parse(demo);
const ADMIN = '21620000001'; // Meta sends the sender without the plus
const PATIENT = '21655555555';
const PATIENT_E164 = '+21655555555';
const CABINET_WA = '21670000000'; // demo's whatsapp_patient_from, as metadata.display_phone_number

beforeAll(() => jest.spyOn(console, 'log').mockImplementation(() => undefined));
afterAll(() => jest.restoreAllMocks());

const env = { ...process.env };
afterEach(() => {
  for (const k of ['WA_APP_SECRET', 'WA_VERIFY_TOKEN', 'WA_PHONE_NUMBER_ID', 'WA_ACCESS_TOKEN', 'WA_TEMPLATE_BOOKING']) delete process.env[k];
  Object.assign(process.env, env);
});

function make() {
  const dir = mkdtempSync(join(tmpdir(), 'darija-admin-'));
  process.env.CABINETS_DIR = dir;
  process.env.PATIENT_NOTES_DIR = mkdtempSync(join(tmpdir(), 'darija-admin-notes-'));
  const cabinets = new CabinetService();
  cabinets.upsert(cfg); // writes demo.json, so persistence is observable
  const cal = new MemoryCalendar();
  const booking = new BookingService(cal, cabinets);
  const notifier = new ConsoleNotifier();
  const admin = new AdminChatService(cabinets, notifier, booking, new PatientNotesService());
  const onDisk = () => JSON.parse(readFileSync(join(dir, 'demo.json'), 'utf-8')).mode;
  return { cabinets, cal, booking, notifier, admin, onDisk, ctrl: new WhatsAppController(admin, booking, cabinets, notifier) };
}

type Kind = 'text' | 'button' | 'interactive';
function message(id: string, from: string, type: Kind, text: string, data: string) {
  const base = { id, from, timestamp: '1', type };
  if (type === 'text') return { ...base, text: { body: text } };
  if (type === 'button') return { ...base, button: { text, payload: data } }; // quick reply under a template
  return { ...base, interactive: { type: 'button_reply', button_reply: { id: data, title: text } } };
}

/** What Meta posts for one inbound message; `data` is the button payload / reply id, `to` the business number. */
const payload = (id: string, text: string, from = ADMIN, type: Kind = 'text', data = text, to = CABINET_WA) => ({
  object: 'whatsapp_business_account',
  entry: [
    {
      id: '1',
      changes: [
        {
          field: 'messages',
          value: {
            messaging_product: 'whatsapp',
            metadata: { display_phone_number: to, phone_number_id: '111' },
            contacts: [{ wa_id: from, profile: { name: 'Dr' } }],
            messages: [message(id, from, type, text, data)],
          },
        },
      ],
    },
  ],
});
const statusOnly = () => ({
  object: 'whatsapp_business_account',
  entry: [{ id: '1', changes: [{ field: 'messages', value: { statuses: [{ id: 'wamid.x', status: 'delivered', recipient_id: PATIENT }] } }] }],
});
const sign = (raw: string, secret: string) => 'sha256=' + createHmac('sha256', secret).update(raw).digest('hex');

describe('normalizePhone', () => {
  it.each([
    ['+216 20 000 001', '+21620000001'],
    ['21620000001', '+21620000001'],
    ['+21620000001', '+21620000001'],
    ['(216) 20-000-001', '+21620000001'],
    ['', ''],
  ])('%s → %s', (raw, want) => expect(normalizePhone(raw)).toBe(want));
});

describe('CabinetService.byWhatsAppNumber', () => {
  it('finds the cabinet by its WhatsApp Business number in any format', () => {
    const { cabinets } = make();
    expect(cabinets.byWhatsAppNumber(CABINET_WA)?.id).toBe('demo');
    expect(cabinets.byWhatsAppNumber('+216 70 000 000')?.id).toBe('demo');
    expect(cabinets.byWhatsAppNumber('21699999999')).toBeUndefined();
    expect(cabinets.byWhatsAppNumber('')).toBeUndefined();
  });
});

describe('parseAdminCommand', () => {
  it.each(['STOP', 'stop', '🛑 Stop', 'Arrêt', 'arrete', 'Arrêtez tout svp', 'pause', 'وقف', 'أوقف الروبوت', '7bes', 'barka'])('stop: %s', (t) =>
    expect(parseAdminCommand(t).kind).toBe('stop'),
  );
  it.each(['START', 'start stp', 'Reprends', 'Démarre', 'reprise', 'go', 'شغل', 'ابدا', 'chghal', 'kammel'])('start: %s', (t) =>
    expect(parseAdminCommand(t).kind).toBe('start'),
  );
  it.each(['help', '?', 'Aide', 'مساعدة', '3awen'])('help: %s', (t) => expect(parseAdminCommand(t).kind).toBe('help'));
  it.each(['On ferme vendredi', 'Bonjour', 'Le patient Trabelsi a annulé', 'stopper les frais', 'started'])('unknown: %s', (t) =>
    expect(parseAdminCommand(t)).toEqual({ kind: 'unknown', text: t }),
  );
});

describe('AdminChatService', () => {
  it('STOP turns the agent off and persists it; START restores the previous mode', async () => {
    const { admin, cabinets, notifier, onDisk } = make();
    expect(cabinets.get('demo').mode).toBe('learning');

    const stop = await admin.handle('+21620000001', 'STOP');
    expect(stop).toMatch(/START/);
    expect(cabinets.get('demo').mode).toBe('off');
    expect(onDisk()).toBe('off');
    expect(notifier.sent).toEqual([expect.objectContaining({ to: '+21620000001', kind: 'staff', text: stop })]);

    const start = await admin.handle('+21620000001', 'START');
    expect(start).toMatch(/apprentissage/);
    expect(cabinets.get('demo').mode).toBe('learning');
    expect(onDisk()).toBe('learning');
  });

  it('START after a restart (no remembered mode) comes back in learning', async () => {
    const { admin, cabinets } = make();
    cabinets.upsert({ ...cfg, mode: 'off' });
    expect(await admin.handle('+21620000001', 'start')).toMatch(/apprentissage/);
    expect(cabinets.get('demo').mode).toBe('learning');
  });

  it('a cabinet that was on comes back on', async () => {
    const { admin, cabinets } = make();
    cabinets.upsert({ ...cfg, mode: 'on' });
    await admin.handle('+21620000002', 'وقف');
    expect(cabinets.get('demo').mode).toBe('off');
    expect(await admin.handle('+21620000002', 'شغل')).toMatch(/actif/);
    expect(cabinets.get('demo').mode).toBe('on');
  });

  it('START while running says so and writes nothing', async () => {
    const { admin, cabinets, onDisk } = make();
    expect(await admin.handle('+21620000001', 'START')).toMatch(/déjà active/);
    expect(cabinets.get('demo').mode).toBe('learning');
    expect(onDisk()).toBe('learning');
  });

  it('ignores senders that are not admins of any cabinet', async () => {
    const { admin, cabinets, notifier } = make();
    expect(await admin.handle('+21655555555', 'STOP')).toBeNull();
    expect(cabinets.get('demo').mode).toBe('learning');
    expect(notifier.sent).toHaveLength(0);
  });

  it('anything else answers with the command list', async () => {
    const { admin } = make();
    const reply = await admin.handle('+21620000001', 'Bonjour Amira');
    expect(reply).toMatch(/pas compris/);
    expect(reply).toMatch(/STOP/);
    expect(reply).toMatch(/START/);
    expect(await admin.handle('+21620000001', '?')).not.toMatch(/pas compris/);
  });
});

describe('WhatsAppController', () => {
  it('answers Meta’s verification handshake only with the configured token', () => {
    const { ctrl } = make();
    process.env.WA_VERIFY_TOKEN = 'tok';
    expect(ctrl.verify('subscribe', 'tok', '1158201444')).toBe('1158201444');
    expect(() => ctrl.verify('subscribe', 'wrong', '1')).toThrow(ForbiddenException);
    expect(() => ctrl.verify('unsubscribe', 'tok', '1')).toThrow(ForbiddenException);
    delete process.env.WA_VERIFY_TOKEN;
    expect(() => ctrl.verify('subscribe', '', '1')).toThrow(ForbiddenException);
  });

  it('flattens Meta’s envelope — text, template quick reply, interactive reply — and drops status callbacks', () => {
    const body = { entry: [...payload('wamid.1', 'STOP').entry, ...statusOnly().entry, ...payload('wamid.2', 'START', PATIENT, 'button').entry] };
    expect(inboundMessages(body)).toEqual([
      { id: 'wamid.1', from: ADMIN, type: 'text', text: 'STOP', to: CABINET_WA },
      { id: 'wamid.2', from: PATIENT, type: 'button', text: 'START', payload: 'START', to: CABINET_WA },
    ]);
    expect(inboundMessages(payload('wamid.3', 'Confirmer', PATIENT, 'interactive', 'confirm:b1'))).toEqual([
      { id: 'wamid.3', from: PATIENT, type: 'interactive', text: 'Confirmer', payload: 'confirm:b1', to: CABINET_WA },
    ]);
    expect(inboundMessages({})).toEqual([]);
  });

  it('checks X-Hub-Signature-256 over the raw body', () => {
    const raw = Buffer.from('{"a":1}');
    expect(validSignature(raw, sign('{"a":1}', 's3'), 's3')).toBe(true);
    expect(validSignature(raw, sign('{"a":2}', 's3'), 's3')).toBe(false);
    expect(validSignature(raw, 'sha256=zz', 's3')).toBe(false);
    expect(validSignature(raw, undefined, 's3')).toBe(false);
    expect(validSignature(undefined, sign('{"a":1}', 's3'), 's3')).toBe(false);
    expect(validSignature(undefined, undefined, undefined)).toBe(true); // no secret configured: dev mode
  });

  it('handles a signed STOP once, even when Meta retries the delivery', async () => {
    const { ctrl, cabinets, notifier } = make();
    process.env.WA_APP_SECRET = 's3';
    const raw = JSON.stringify(payload('wamid.1', 'STOP'));
    const req = { rawBody: Buffer.from(raw) };

    expect(await ctrl.receive(req, JSON.parse(raw), sign(raw, 's3'))).toEqual({ ok: true, handled: 1 });
    expect(cabinets.get('demo').mode).toBe('off');
    expect(await ctrl.receive(req, JSON.parse(raw), sign(raw, 's3'))).toEqual({ ok: true, handled: 0 });
    expect(notifier.sent).toHaveLength(1);
  });

  it('rejects a bad or missing signature when WA_APP_SECRET is set', async () => {
    const { ctrl, cabinets } = make();
    process.env.WA_APP_SECRET = 's3';
    const raw = JSON.stringify(payload('wamid.1', 'STOP'));
    await expect(ctrl.receive({ rawBody: Buffer.from(raw) }, JSON.parse(raw), 'sha256=00')).rejects.toThrow(UnauthorizedException);
    await expect(ctrl.receive({ rawBody: Buffer.from(raw) }, JSON.parse(raw), undefined)).rejects.toThrow(UnauthorizedException);
    expect(cabinets.get('demo').mode).toBe('learning');
  });

  it('accepts unsigned posts while no secret is configured (local smoke tests)', async () => {
    const { ctrl, cabinets } = make();
    const body = payload('wamid.9', 'START', ADMIN, 'button');
    cabinets.upsert({ ...cfg, mode: 'off' });
    expect(await ctrl.receive({}, body, undefined)).toEqual({ ok: true, handled: 1 });
    expect(cabinets.get('demo').mode).toBe('learning');
  });

  it('acknowledges statuses and patient messages without acting on them', async () => {
    const { ctrl, cabinets, notifier } = make();
    expect(await ctrl.receive({}, statusOnly(), undefined)).toEqual({ ok: true, handled: 0 });
    expect(await ctrl.receive({}, payload('wamid.p', 'STOP', PATIENT), undefined)).toEqual({ ok: true, handled: 0 });
    expect(cabinets.get('demo').mode).toBe('learning');
    expect(notifier.sent).toHaveLength(0);
  });
});

describe('WhatsAppController — patient Confirmer / Annuler replies', () => {
  /** A booking of the demo cabinet tomorrow at 10:00, in the state the Google adapter creates them. */
  async function withBooking(status: Booking['status'] = 'unconfirmed') {
    const ctx = make();
    const start = DateTime.now().setZone(cfg.timezone).plus({ days: 1 }).startOf('day').set({ hour: 10 });
    const b = (await ctx.cal.book({
      cabinet_id: 'demo',
      start: start.toISO()!,
      end: start.plus({ minutes: 30 }).toISO()!,
      type_id: 'cleaning',
      patient_phone: PATIENT_E164,
      patient_name: 'Trabelsi',
      source: 'agent',
    }))!;
    await ctx.cal.setStatus('demo', b.id, status);
    return { ...ctx, b };
  }

  it('Confirmer on the template (quick-reply payload) confirms the booking and answers the patient, once', async () => {
    const { ctrl, cal, notifier, b } = await withBooking();
    const body = payload('wamid.c1', 'Confirmer', PATIENT, 'button', `confirm:${b.id}`);
    expect(await ctrl.receive({}, body, undefined)).toEqual({ ok: true, handled: 1 });
    expect((await cal.get('demo', b.id))!.status).toBe('confirmed');
    expect(notifier.sent).toEqual([expect.objectContaining({ to: PATIENT_E164, kind: 'wa', text: expect.stringContaining('مأكد') })]);
    expect(notifier.sent[0].text).toContain(cfg.name);

    expect(await ctrl.receive({}, body, undefined)).toEqual({ ok: true, handled: 0 }); // Meta retry
    expect(notifier.sent).toHaveLength(1);
  });

  it('Annuler on the interactive message (button_reply id) cancels it and frees the slot', async () => {
    const { ctrl, cal, notifier, b } = await withBooking();
    const body = payload('wamid.x1', 'Annuler', PATIENT, 'interactive', `cancel:${b.id}`);
    expect(await ctrl.receive({}, body, undefined)).toEqual({ ok: true, handled: 1 });
    expect((await cal.get('demo', b.id))!.status).toBe('cancelled');
    expect(await cal.busy('demo', DateTime.fromISO(b.start).minus({ hours: 1 }), DateTime.fromISO(b.end).plus({ hours: 1 }))).toEqual([]);
    expect(notifier.sent).toEqual([expect.objectContaining({ to: PATIENT_E164, kind: 'wa', text: expect.stringContaining('إلغاء') })]);
  });

  it('Confirmer on a booking cancelled meanwhile says so and leaves it cancelled', async () => {
    const { ctrl, cal, notifier, b } = await withBooking('cancelled');
    expect(await ctrl.receive({}, payload('wamid.c2', 'Confirmer', PATIENT, 'button', `confirm:${b.id}`), undefined)).toEqual({ ok: true, handled: 1 });
    expect((await cal.get('demo', b.id))!.status).toBe('cancelled');
    expect(notifier.sent[0].text).toMatch(/ملغي/);
  });

  it('an unknown booking id answers the patient with the cabinet line and touches nothing', async () => {
    const { ctrl, cal, notifier, b } = await withBooking();
    expect(await ctrl.receive({}, payload('wamid.u1', 'Annuler', PATIENT, 'button', 'cancel:nope'), undefined)).toEqual({ ok: true, handled: 1 });
    expect((await cal.get('demo', b.id))!.status).toBe('unconfirmed');
    expect(notifier.sent).toEqual([expect.objectContaining({ to: PATIENT_E164, kind: 'wa', text: expect.stringContaining(cfg.phone_line) })]);
  });

  it('a tap received on a number that is no cabinet’s WhatsApp line is ignored', async () => {
    const { ctrl, cal, notifier, b } = await withBooking();
    const body = payload('wamid.o1', 'Confirmer', PATIENT, 'button', `confirm:${b.id}`, '21699999999');
    expect(await ctrl.receive({}, body, undefined)).toEqual({ ok: true, handled: 0 });
    expect((await cal.get('demo', b.id))!.status).toBe('unconfirmed');
    expect(notifier.sent).toHaveLength(0);
  });

  it('an admin’s Confirmer tap is a patient reply too, not a command', async () => {
    const { ctrl, cal, cabinets, b } = await withBooking();
    expect(await ctrl.receive({}, payload('wamid.a1', 'Confirmer', ADMIN, 'button', `confirm:${b.id}`), undefined)).toEqual({ ok: true, handled: 1 });
    expect((await cal.get('demo', b.id))!.status).toBe('confirmed');
    expect(cabinets.get('demo').mode).toBe('learning');
  });

  it('with the Meta notifier the answer goes out as free-form text: the tap itself opened the 24 h window', async () => {
    process.env.WA_PHONE_NUMBER_ID = '111';
    process.env.WA_ACCESS_TOKEN = 't0k';
    process.env.WA_TEMPLATE_BOOKING = 'booking_confirm';
    const calls: { url: string; body: any }[] = [];
    const fetchFn: FetchLike = async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body) });
      return { ok: true, status: 200, json: async () => ({ messages: [{ id: 'wamid.out' }] }) };
    };
    const { admin, booking, cabinets, cal, b } = await withBooking();
    const meta = new MetaWhatsAppNotifier(fetchFn);
    const ctrl = new WhatsAppController(admin, booking, cabinets, meta);

    expect(await ctrl.receive({}, payload('wamid.m1', 'Confirmer', PATIENT, 'button', `confirm:${b.id}`), undefined)).toEqual({ ok: true, handled: 1 });
    expect((await cal.get('demo', b.id))!.status).toBe('confirmed');
    expect(meta.inWindow(PATIENT_E164)).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://graph.facebook.com/v21.0/111/messages');
    expect(calls[0].body).toMatchObject({ to: PATIENT, type: 'text', text: { body: expect.stringContaining('مأكد') } });
  });
});
