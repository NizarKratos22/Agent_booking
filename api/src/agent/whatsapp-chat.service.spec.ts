import { mkdtempSync, readdirSync, readFileSync } from 'fs';
import { DateTime, Settings } from 'luxon';
import { tmpdir } from 'os';
import { join } from 'path';
import { AdminChatService } from '../admin/admin-chat.service';
import { PatientNotesService } from '../admin/patient-notes.service';
import { inboundMessages, WhatsAppController } from '../admin/whatsapp.controller';
import { BookingService } from '../booking/booking.service';
import { MemoryCalendar } from '../calendar/memory.calendar';
import { CabinetConfig } from '../config/cabinet.schema';
import { CabinetService } from '../config/cabinet.service';
import { GRAPH_API } from '../notify/meta-whatsapp.notifier';
import { ConsoleNotifier } from '../notify/notifier.port';
import { AgentTools } from './agent-tools.service';
import { CallLog } from './call-log.service';
import { GeminiClient, GeminiContent, GeminiPart } from './gemini.client';
import { trimHistory, WhatsAppChatService } from './whatsapp-chat.service';
import { WhatsAppMedia } from './whatsapp-media';
import demo from '../../cabinets/demo.json';

const cfg = CabinetConfig.parse(demo);
const ZONE = 'Africa/Tunis';
const NOW = DateTime.fromISO('2026-10-26T09:00:00', { zone: ZONE }); // Monday
Settings.now = () => NOW.toMillis();
const PATIENT = '+21655555555';
const BUSINESS = '21670000000'; // demo whatsapp_patient_from, as Meta reports it

beforeAll(() => jest.spyOn(console, 'log').mockImplementation(() => undefined));
afterAll(() => jest.restoreAllMocks());

const saved = { ...process.env };
beforeEach(() => {
  process.env.GEMINI_API_KEY = 'g-test';
  process.env.WA_ACCESS_TOKEN = 'wa-token';
});
afterEach(() => {
  for (const k of ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'WA_ACCESS_TOKEN']) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

type Step = GeminiPart[] | { status: number; body: unknown };
const text = (t: string): GeminiPart => ({ text: t });
const call = (name: string, args: Record<string, unknown>): GeminiPart => ({ functionCall: { name, args }, thoughtSignature: `sig-${name}` });

function make(script: Step[] = [], media: { lookup?: { ok: boolean; status: number; body: unknown }; bytes?: Buffer } = {}) {
  process.env.CABINETS_DIR = mkdtempSync(join(tmpdir(), 'darija-chat-cab-'));
  process.env.PATIENT_NOTES_DIR = mkdtempSync(join(tmpdir(), 'darija-chat-notes-'));
  const logDir = mkdtempSync(join(tmpdir(), 'darija-chat-log-'));
  process.env.CALL_LOG_DIR = logDir;
  const cabinets = new CabinetService();
  cabinets.upsert(cfg, false);
  const cal = new MemoryCalendar();
  const booking = new BookingService(cal, cabinets);
  const notifier = new ConsoleNotifier();
  const callLog = new CallLog();
  const notes = new PatientNotesService();
  const tools = new AgentTools(booking, cabinets, callLog, notifier);

  const gemini: { url: string; body: any }[] = [];
  const geminiFetch = async (url: string, init: { body: string }) => {
    gemini.push({ url, body: JSON.parse(init.body) });
    const next = script.shift();
    if (!next) throw new Error('fake Gemini: script exhausted');
    if (Array.isArray(next)) return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { role: 'model', parts: next } }] }) };
    return { ok: false, status: next.status, json: async () => next.body };
  };
  const mediaCalls: { url: string; headers: Record<string, string> }[] = [];
  const mediaFetch = async (url: string, init: { headers: Record<string, string> }) => {
    mediaCalls.push({ url, headers: init.headers });
    if (url.startsWith(GRAPH_API)) {
      const r = media.lookup ?? { ok: true, status: 200, body: { url: 'https://lookaside.fbsbx.com/whatsapp_business/attachments/x', mime_type: 'audio/ogg; codecs=opus', file_size: 1234, id: 'media123' } };
      return { ok: r.ok, status: r.status, json: async () => r.body, arrayBuffer: async () => new ArrayBuffer(0) };
    }
    const bytes = media.bytes ?? Buffer.from('OggS fake opus');
    return { ok: true, status: 200, json: async () => ({}), arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
  };

  const chat = new WhatsAppChatService(tools, new GeminiClient(geminiFetch as any), new WhatsAppMedia(mediaFetch as any), notes, callLog, notifier);
  const admin = new AdminChatService(cabinets, notifier, booking, notes);
  const ctrl = new WhatsAppController(admin, booking, cabinets, notifier, chat);
  const logLines = () => readdirSync(logDir).flatMap((f) => readFileSync(join(logDir, f), 'utf-8').trim().split('\n').map((l) => JSON.parse(l)));
  return { cabinets, cal, booking, notifier, chat, ctrl, gemini, mediaCalls, logLines };
}

const wa = (n: ConsoleNotifier) => n.sent.filter((s) => s.kind === 'wa');
const msg = (t: string, id = 'm1') => ({ id, type: 'text', text: t });

describe('WhatsAppChatService', () => {
  it('answers a patient text in the chat and keeps the conversation for the next message', async () => {
    const { chat, notifier, gemini, logLines } = make([[text('أهلا! شنوة نوع الموعد؟')], [call('get_availability', { type_id: 'cleaning' })], [text('الاثنين 10:00 ولا 10:30؟')]]);

    expect(await chat.handle(cfg, PATIENT, msg('نحب rdv'))).toBe('أهلا! شنوة نوع الموعد؟');
    expect(wa(notifier)).toEqual([expect.objectContaining({ to: PATIENT, text: 'أهلا! شنوة نوع الموعد؟' })]);
    const first = gemini[0].body;
    expect(first.systemInstruction.parts[0].text).toContain('CANAL WHATSAPP');
    expect(first.systemInstruction.parts[0].text).toContain(PATIENT);
    expect(first.tools[0].functionDeclarations.map((d: any) => d.name)).not.toContain('transfer');
    expect(first.contents).toEqual([{ role: 'user', parts: [text('نحب rdv')] }]);

    expect(await chat.handle(cfg, PATIENT, msg('تنظيف', 'm2'))).toBe('الاثنين 10:00 ولا 10:30؟');
    const second = gemini[1].body;
    expect(second.contents.map((c: GeminiContent) => c.role)).toEqual(['user', 'model', 'user']); // history + new turn
    const answer = gemini[2].body.contents.at(-1).parts[0].functionResponse;
    expect(answer.name).toBe('get_availability');
    expect(answer.response.ok).toBe(true);
    expect(answer.response.offers).toHaveLength(3); // the real slot engine answered

    const roles = logLines().filter((l) => l.call === `wa:${PATIENT}`).map((l) => l.role);
    expect(roles).toEqual(['user', 'assistant', 'user', 'tool', 'assistant']);
  });

  it('books through the shared tools: the calendar changes and the Confirmer / Annuler message goes out', async () => {
    const start = NOW.set({ hour: 10 }).toISO()!;
    const { chat, notifier, cal } = make([[call('book', { type_id: 'consultation', start, patient_name: 'Sami', patient_phone: PATIENT })], [text('تم، موعدك الاثنين 10:00.')]]);
    expect(await chat.handle(cfg, PATIENT, msg('إي، الاثنين 10:00 Sami'))).toBe('تم، موعدك الاثنين 10:00.');
    const booked = await cal.list('demo', NOW.startOf('day'), NOW.endOf('day'));
    expect(booked).toHaveLength(1);
    expect(booked[0].patient_phone).toBe(PATIENT);
    expect(notifier.sent.map((s) => s.kind.split(':')[0])).toEqual(['buttons', 'wa']);
    expect(notifier.sent[0].to).toBe(PATIENT);
  });

  it('an emergency alerts the doctor before the model answers', async () => {
    const { chat, notifier, gemini } = make([[text(`اتصل توا على ${cfg.phone_line}`)]]);
    await chat.handle(cfg, PATIENT, msg('عندي وجيعة قوية ما نجمش نستنى'));
    expect(notifier.sent[0]).toMatchObject({ kind: 'staff', urgent: true, to: cfg.phone_doctor });
    expect(notifier.sent[0].text).toContain('وجيعة قوية');
    expect(notifier.sent[1]).toMatchObject({ kind: 'wa', to: PATIENT });
    expect(gemini).toHaveLength(1);
  });

  it('mode off answers a fixed line with the cabinet phone and never calls the model', async () => {
    const { chat, cabinets, notifier, gemini } = make();
    cabinets.upsert({ ...cfg, mode: 'off' }, false);
    const reply = await chat.handle(cabinets.get('demo'), PATIENT, msg('نحب rdv'));
    expect(reply).toContain(cfg.phone_line);
    expect(wa(notifier)).toHaveLength(1);
    expect(gemini).toHaveLength(0);
  });

  it('without GEMINI_API_KEY nothing is sent', async () => {
    const { chat, notifier } = make();
    delete process.env.GEMINI_API_KEY;
    expect(chat.enabled()).toBe(false);
    expect(await chat.handle(cfg, PATIENT, msg('نحب rdv'))).toBeNull();
    expect(notifier.sent).toHaveLength(0);
  });

  it('a voice note is downloaded with the token, transcribed, then answered like text', async () => {
    const bytes = Buffer.from('OggS this is opus');
    const { chat, gemini, mediaCalls, logLines } = make([[text('نحب نأخذ rendez-vous غدوة')], [text('شنوة نوع الموعد؟')]], { bytes });
    const reply = await chat.handle(cfg, PATIENT, { id: 'v1', type: 'audio', mediaId: 'media123', mimeType: 'audio/ogg; codecs=opus' });
    expect(reply).toBe('شنوة نوع الموعد؟');
    expect(mediaCalls.map((c) => c.url)).toEqual([`${GRAPH_API}/media123`, 'https://lookaside.fbsbx.com/whatsapp_business/attachments/x']);
    expect(mediaCalls.every((c) => c.headers.Authorization === 'Bearer wa-token')).toBe(true);
    const transcription = gemini[0].body;
    expect(transcription.systemInstruction).toBeUndefined();
    expect(transcription.contents[0].parts[1].inlineData).toEqual({ mimeType: 'audio/ogg', data: bytes.toString('base64') });
    expect(gemini[1].body.contents.at(-1)).toEqual({ role: 'user', parts: [text('نحب نأخذ rendez-vous غدوة')] });
    expect(logLines().find((l) => l.role === 'user').text).toBe('[vocal] نحب نأخذ rendez-vous غدوة');
  });

  it('a voice note that cannot be fetched gets a written-please reply and no model call', async () => {
    const { chat, notifier, gemini } = make([], { lookup: { ok: false, status: 400, body: { error: { code: 100 } } } });
    const reply = await chat.handle(cfg, PATIENT, { id: 'v1', type: 'audio', mediaId: 'bad' });
    expect(reply).toContain('تكتبلي');
    expect(wa(notifier)).toHaveLength(1);
    expect(gemini).toHaveLength(0);
  });

  it('without WA_ACCESS_TOKEN voice notes are declined but texts still work', async () => {
    const { chat, mediaCalls } = make([[text('ok')]]);
    delete process.env.WA_ACCESS_TOKEN;
    expect(await chat.handle(cfg, PATIENT, { id: 'v1', type: 'audio', mediaId: 'media123' })).toContain('تكتبلي');
    expect(mediaCalls).toHaveLength(0);
    expect(await chat.handle(cfg, PATIENT, msg('salut'))).toBe('ok');
  });

  it('a model failure becomes an apology with the cabinet phone, never silence', async () => {
    const { chat, notifier } = make([{ status: 500, body: { error: { message: 'boom' } } }]);
    const reply = await chat.handle(cfg, PATIENT, msg('نحب rdv'));
    expect(reply).toContain(cfg.phone_line);
    expect(wa(notifier)).toHaveLength(1);
  });

  it('stickers, images and empty texts are ignored', async () => {
    const { chat, notifier } = make();
    expect(await chat.handle(cfg, PATIENT, { id: 's1', type: 'sticker' })).toBeNull();
    expect(await chat.handle(cfg, PATIENT, msg('   '))).toBeNull();
    expect(notifier.sent).toHaveLength(0);
  });

  it('trimHistory keeps the tail and starts it on a patient turn', () => {
    const contents: GeminiContent[] = [];
    for (let i = 0; i < 25; i++) {
      contents.push({ role: 'user', parts: [text(`q${i}`)] }, { role: 'model', parts: [call('get_availability', {})] }, { role: 'user', parts: [{ functionResponse: { name: 'get_availability', response: {} } }] }, { role: 'model', parts: [text(`a${i}`)] });
    }
    const kept = trimHistory(contents);
    expect(kept.length).toBeLessThanOrEqual(40);
    expect(kept[0].role).toBe('user');
    expect(kept[0].parts[0].text).toMatch(/^q/);
    expect(kept.at(-1)!.parts[0].text).toBe('a24');
    expect(trimHistory(contents.slice(0, 8))).toHaveLength(8);
  });
});

const envelope = (messages: unknown[], to = BUSINESS) => ({
  object: 'whatsapp_business_account',
  entry: [{ id: '1', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { display_phone_number: to, phone_number_id: '111' }, messages } }] }],
});

describe('WhatsAppController routing', () => {
  it('parses a voice note into mediaId and mimeType', () => {
    const [m] = inboundMessages(envelope([{ id: 'v1', from: '21655555555', type: 'audio', audio: { id: 'media123', mime_type: 'audio/ogg; codecs=opus', voice: true } }]));
    expect(m).toMatchObject({ id: 'v1', type: 'audio', mediaId: 'media123', mimeType: 'audio/ogg; codecs=opus', to: BUSINESS });
    expect(m.text).toBeUndefined();
  });

  it('sends a patient text to Amira, an admin text to the commands, and drops unknown business numbers', async () => {
    const { ctrl, notifier, gemini } = make([[text('أهلا!')]]);
    expect(await ctrl.receive({}, envelope([{ id: 'p1', from: '21655555555', type: 'text', text: { body: 'نحب rdv' } }]), undefined)).toEqual({ ok: true, handled: 1 });
    expect(wa(notifier)).toEqual([expect.objectContaining({ to: PATIENT, text: 'أهلا!' })]);

    expect(await ctrl.receive({}, envelope([{ id: 'a1', from: '21620000001', type: 'text', text: { body: 'RDV' } }]), undefined)).toEqual({ ok: true, handled: 1 });
    expect(notifier.sent.at(-1)).toMatchObject({ kind: 'staff', to: '+21620000001' });
    expect(gemini).toHaveLength(1); // the admin command did not go to the model

    expect(await ctrl.receive({}, envelope([{ id: 'p2', from: '21655555555', type: 'text', text: { body: 'salut' } }], '21699999999'), undefined)).toEqual({ ok: true, handled: 0 });
    expect(gemini).toHaveLength(1);
  });

  it('routes a patient voice note through the media download and the model', async () => {
    const { ctrl, notifier, mediaCalls } = make([[text('نحب rdv')], [text('شنوة نوع الموعد؟')]]);
    const body = envelope([{ id: 'v1', from: '21655555555', type: 'audio', audio: { id: 'media123', mime_type: 'audio/ogg; codecs=opus', voice: true } }]);
    expect(await ctrl.receive({}, body, undefined)).toEqual({ ok: true, handled: 1 });
    expect(mediaCalls).toHaveLength(2);
    expect(wa(notifier).at(-1)!.text).toBe('شنوة نوع الموعد؟');
  });

  it('without a chat agent bound, patient texts are ignored as before', async () => {
    const { notifier } = make();
    const cabinets = new CabinetService();
    cabinets.upsert(cfg, false);
    const cal = new MemoryCalendar();
    const booking = new BookingService(cal, cabinets);
    const notes = new PatientNotesService();
    const ctrl = new WhatsAppController(new AdminChatService(cabinets, notifier, booking, notes), booking, cabinets, notifier);
    expect(await ctrl.receive({}, envelope([{ id: 'p1', from: '21655555555', type: 'text', text: { body: 'نحب rdv' } }]), undefined)).toEqual({ ok: true, handled: 0 });
    expect(notifier.sent).toHaveLength(0);
  });
});
