import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { copyFileSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { AppModule } from '../app.module';
import { FetchLike, isMetaWhatsAppConfigured, MetaWhatsAppNotifier, parseBookingReply, WINDOW_MS } from './meta-whatsapp.notifier';
import { ConsoleNotifier, NOTIFIER } from './notifier.port';

jest.setTimeout(30_000);

const TOKEN = 'EAAG-secret-token-never-logged';
const URL = 'https://graph.facebook.com/v21.0/111/messages';
const PATIENT = '+216 20 123 456'; // as a config file or normalizePhone writes it
const DIGITS = '21620123456'; // as Meta wants it
const TEXT = 'Cabinet Dr. Ben Salem: موعدك تنظيف الثلاثاء 10:00. تحب تأكد ولا تبدل؟';

type Call = { url: string; init: Parameters<FetchLike>[1] };
type Reply = { status: number; body?: unknown; broken?: boolean } | Error;
const sentOk = (n: number): Reply => ({ status: 200, body: { messaging_product: 'whatsapp', contacts: [{ input: DIGITS, wa_id: DIGITS }], messages: [{ id: `wamid.out.${n}` }] } });
const refused = (code: number, status = 400): Reply => ({ status, body: { error: { message: 'redacted', type: 'OAuthException', code, error_subcode: 2494010, fbtrace_id: 'AbC' } } });

/** Records every Graph call; answers from the queue, then with successes. */
function fakeFetch(queue: Reply[] = []) {
  const calls: Call[] = [];
  const fn: FetchLike = async (url, init) => {
    calls.push({ url, init });
    const next = queue.shift() ?? sentOk(calls.length);
    if (next instanceof Error) throw next;
    return {
      ok: next.status < 300,
      status: next.status,
      json: async () => {
        if (next.broken) throw new SyntaxError('Unexpected token <');
        return next.body;
      },
    };
  };
  return { fn, calls, bodies: () => calls.map((c) => JSON.parse(c.init.body)) };
}

const logs: string[] = [];
beforeEach(() => {
  logs.length = 0;
  for (const level of ['log', 'warn', 'error', 'debug', 'verbose'] as const)
    jest.spyOn(Logger.prototype as any, level).mockImplementation((message: unknown) => {
      logs.push(String(message));
    });
  process.env.WA_PHONE_NUMBER_ID = '111';
  process.env.WA_ACCESS_TOKEN = TOKEN;
  delete process.env.WA_TEMPLATE_BOOKING;
  delete process.env.WA_TEMPLATE_STAFF;
  delete process.env.WA_TEMPLATE_LANG;
});
afterEach(() => {
  jest.restoreAllMocks();
  for (const k of ['WA_PHONE_NUMBER_ID', 'WA_ACCESS_TOKEN', 'WA_TEMPLATE_BOOKING', 'WA_TEMPLATE_STAFF', 'WA_TEMPLATE_LANG']) delete process.env[k];
});

describe('parseBookingReply', () => {
  it.each([
    ['confirm:b-1', { action: 'confirm', bookingId: 'b-1' }],
    ['cancel:3f9a', { action: 'cancel', bookingId: '3f9a' }],
    [' confirm:x ', { action: 'confirm', bookingId: 'x' }],
  ])('%s', (payload, want) => expect(parseBookingReply(payload)).toEqual(want));
  it.each(['START', 'Confirmer', 'confirm:', 'confirm', 'confirm:a b', '', undefined])('not a booking reply: %s', (payload) =>
    expect(parseBookingReply(payload)).toBeUndefined(),
  );
});

describe('isMetaWhatsAppConfigured', () => {
  it('needs both variables, non-blank', () => {
    expect(isMetaWhatsAppConfigured({ WA_PHONE_NUMBER_ID: '1', WA_ACCESS_TOKEN: 't' })).toBe(true);
    expect(isMetaWhatsAppConfigured({ WA_PHONE_NUMBER_ID: '1' })).toBe(false);
    expect(isMetaWhatsAppConfigured({ WA_ACCESS_TOKEN: 't' })).toBe(false);
    expect(isMetaWhatsAppConfigured({ WA_PHONE_NUMBER_ID: ' ', WA_ACCESS_TOKEN: 't' })).toBe(false);
    expect(isMetaWhatsAppConfigured({})).toBe(false);
  });
});

describe('MetaWhatsAppNotifier', () => {
  it('sendWhatsApp posts a text to Graph with the bearer token, the number without plus, and logs the message id', async () => {
    const f = fakeFetch();
    const n = new MetaWhatsAppNotifier(f.fn);
    await n.sendWhatsApp(PATIENT, 'سلام');
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0].url).toBe(URL);
    expect(f.calls[0].init.method).toBe('POST');
    expect(f.calls[0].init.headers).toEqual({ Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' });
    expect(f.calls[0].init.signal).toBeInstanceOf(AbortSignal);
    expect(f.bodies()[0]).toEqual({ messaging_product: 'whatsapp', recipient_type: 'individual', to: DIGITS, type: 'text', text: { preview_url: false, body: 'سلام' } });
    expect(logs).toContainEqual(expect.stringMatching(/text → 21620123456: sent wamid\.out\.1/));
  });

  it('never logs the token nor the message body, on success or failure', async () => {
    const f = fakeFetch([refused(190, 401), new TypeError('fetch failed')]);
    const n = new MetaWhatsAppNotifier(f.fn);
    await n.sendWhatsApp(PATIENT, TEXT);
    await n.notifyStaff('+21620000002', TEXT, true);
    await n.sendBookingButtons(PATIENT, TEXT, 'b1');
    const all = logs.join('\n');
    expect(all).not.toContain(TOKEN);
    expect(all).not.toContain('secret');
    expect(all).not.toContain(TEXT);
    expect(all).not.toContain('تنظيف');
    expect(all).toMatch(/text → 21620123456: refused, http 401, code 190\/2494010/);
    expect(all).toMatch(/staff urgent → 21620000002: not sent \(TypeError\)/);
    expect(all).toMatch(/booking buttons → 21620123456: sent wamid\.out\.3/);
  });

  it('sendBookingButtons inside the 24 h window: interactive reply buttons confirm:<id> / cancel:<id>', async () => {
    const f = fakeFetch();
    const n = new MetaWhatsAppNotifier(f.fn);
    n.markInbound(DIGITS); // Meta's format, as the webhook sees it
    await n.sendBookingButtons(PATIENT, TEXT, 'bk-42');
    expect(f.bodies()).toEqual([
      {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: DIGITS,
        type: 'interactive',
        interactive: {
          type: 'button',
          body: { text: TEXT },
          action: {
            buttons: [
              { type: 'reply', reply: { id: 'confirm:bk-42', title: 'Confirmer' } },
              { type: 'reply', reply: { id: 'cancel:bk-42', title: 'Annuler' } },
            ],
          },
        },
      },
    ]);
  });

  it('without a template it still tries the interactive message and only logs the window refusal', async () => {
    const f = fakeFetch([refused(131047)]);
    const n = new MetaWhatsAppNotifier(f.fn);
    await expect(n.sendBookingButtons(PATIENT, TEXT, 'bk-1')).resolves.toBeUndefined();
    expect(f.bodies().map((b) => b.type)).toEqual(['interactive']);
    expect(logs).toContainEqual(expect.stringMatching(/refused, http 400, code 131047\/2494010 \(outside the 24 h window\)/));
  });

  it('with WA_TEMPLATE_BOOKING and no inbound in 24 h: the approved template, {{1}} flattened, the two payloads', async () => {
    process.env.WA_TEMPLATE_BOOKING = 'booking_confirm';
    const f = fakeFetch();
    const n = new MetaWhatsAppNotifier(f.fn);
    n.markInbound(PATIENT, Date.now() - WINDOW_MS - 1000); // wrote to us more than 24 h ago: window closed
    await n.sendBookingButtons(PATIENT, `${TEXT}\n\n\t  العنوان.`, 'bk-7');
    expect(f.bodies()).toEqual([
      {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: DIGITS,
        type: 'template',
        template: {
          name: 'booking_confirm',
          language: { code: 'ar' },
          components: [
            { type: 'body', parameters: [{ type: 'text', text: `${TEXT} العنوان.` }] },
            { type: 'button', sub_type: 'quick_reply', index: '0', parameters: [{ type: 'payload', payload: 'confirm:bk-7' }] },
            { type: 'button', sub_type: 'quick_reply', index: '1', parameters: [{ type: 'payload', payload: 'cancel:bk-7' }] },
          ],
        },
      },
    ]);
    expect(logs).toContainEqual(expect.stringMatching(/booking template → 21620123456: sent wamid\.out\.1/));
  });

  it('WA_TEMPLATE_LANG picks the template language', async () => {
    process.env.WA_TEMPLATE_BOOKING = 'booking_confirm';
    process.env.WA_TEMPLATE_LANG = 'fr';
    const f = fakeFetch();
    await new MetaWhatsAppNotifier(f.fn).sendBookingButtons(PATIENT, TEXT, 'bk-8');
    expect(f.bodies()[0].template.language).toEqual({ code: 'fr' });
  });

  it('inside the window but refused with 131047: falls back to the template and forgets the window', async () => {
    process.env.WA_TEMPLATE_BOOKING = 'booking_confirm';
    const f = fakeFetch([refused(131047)]);
    const n = new MetaWhatsAppNotifier(f.fn);
    n.markInbound(PATIENT);
    await n.sendBookingButtons(PATIENT, TEXT, 'bk-9');
    expect(f.bodies().map((b) => b.type)).toEqual(['interactive', 'template']);
    expect(f.bodies()[1].template.components[1].parameters[0].payload).toBe('confirm:bk-9');
    expect(n.inWindow(PATIENT)).toBe(false);
    await n.sendBookingButtons(PATIENT, TEXT, 'bk-10');
    expect(f.bodies().map((b) => b.type)).toEqual(['interactive', 'template', 'template']);
  });

  it('any other refusal of the interactive message is not retried as a template', async () => {
    process.env.WA_TEMPLATE_BOOKING = 'booking_confirm';
    const f = fakeFetch([refused(131026)]); // undeliverable: not a WhatsApp number
    const n = new MetaWhatsAppNotifier(f.fn);
    n.markInbound(PATIENT);
    await n.sendBookingButtons(PATIENT, TEXT, 'bk-11');
    expect(f.calls).toHaveLength(1);
    expect(logs).toContainEqual(expect.stringMatching(/booking buttons → 21620123456: refused, http 400, code 131026/));
  });

  it('notifyStaff: plain text, prefixed 🚨 URGENT when urgent', async () => {
    const f = fakeFetch();
    const n = new MetaWhatsAppNotifier(f.fn);
    await n.notifyStaff('+21620000002', 'Message de +21655555555: parking?');
    await n.notifyStaff('+216 20 000 002', 'URGENCE appel +21655555555: "ولدي طاح"', true);
    expect(f.bodies().map((b) => [b.to, b.type, b.text.body])).toEqual([
      ['21620000002', 'text', 'Message de +21655555555: parking?'],
      ['21620000002', 'text', '🚨 URGENT URGENCE appel +21655555555: "ولدي طاح"'],
    ]);
  });

  it('notifyStaff with WA_TEMPLATE_STAFF and no inbound in 24 h: the staff template, {{1}} = the text, prefix kept, flattened', async () => {
    process.env.WA_TEMPLATE_STAFF = 'staff_notice';
    process.env.WA_TEMPLATE_LANG = 'fr';
    const f = fakeFetch();
    const n = new MetaWhatsAppNotifier(f.fn);
    await n.notifyStaff('+21620000002', 'URGENCE appel +21655555555:\n"ولدي طاح"', true);
    await n.notifyStaff('+216 20 000 001', 'Message de +21655555555: parking?');
    const staffTemplate = (to: string, text: string) => ({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'template',
      template: { name: 'staff_notice', language: { code: 'fr' }, components: [{ type: 'body', parameters: [{ type: 'text', text }] }] },
    });
    expect(f.bodies()).toEqual([
      staffTemplate('21620000002', '🚨 URGENT URGENCE appel +21655555555: "ولدي طاح"'),
      staffTemplate('21620000001', 'Message de +21655555555: parking?'),
    ]);
    expect(logs).toContainEqual(expect.stringMatching(/staff urgent template → 21620000002: sent wamid\.out\.1/));
    expect(logs).toContainEqual(expect.stringMatching(/staff template → 21620000001: sent wamid\.out\.2/));
  });

  it('notifyStaff inside the window stays text (an admin reply answers a message just received); 131047 falls back to the template', async () => {
    process.env.WA_TEMPLATE_STAFF = 'staff_notice';
    const f = fakeFetch([sentOk(1), refused(131047)]);
    const n = new MetaWhatsAppNotifier(f.fn);
    n.markInbound('21620000001'); // the admin just texted STOP
    await n.notifyStaff('+21620000001', '⏸ Amira est arrêtée.');
    expect(f.bodies().map((b) => b.type)).toEqual(['text']);
    await n.notifyStaff('+21620000001', 'Message de +21655555555: parking?');
    expect(f.bodies().map((b) => b.type)).toEqual(['text', 'text', 'template']);
    expect(f.bodies()[2].template.components[0].parameters[0].text).toBe('Message de +21655555555: parking?');
    expect(n.inWindow('+21620000001')).toBe(false);
  });

  it('without WA_TEMPLATE_STAFF a staff alert outside the window is attempted once and the refusal logged', async () => {
    const f = fakeFetch([refused(131047)]);
    const n = new MetaWhatsAppNotifier(f.fn);
    await expect(n.notifyStaff('+21620000002', 'URGENCE appel +21655555555', true)).resolves.toBeUndefined();
    expect(f.bodies().map((b) => b.type)).toEqual(['text']);
    expect(logs).toContainEqual(expect.stringMatching(/staff urgent → 21620000002: refused, http 400, code 131047\/2494010 \(outside the 24 h window\)/));
  });

  it('a failed send never throws into the caller: refused, network error, non-JSON body, missing config, no number', async () => {
    const f = fakeFetch([refused(100), new TypeError('fetch failed'), { status: 502, broken: true }]);
    const n = new MetaWhatsAppNotifier(f.fn);
    await expect(n.sendWhatsApp(PATIENT, 'a')).resolves.toBeUndefined();
    await expect(n.sendWhatsApp(PATIENT, 'b')).resolves.toBeUndefined();
    await expect(n.sendWhatsApp(PATIENT, 'c')).resolves.toBeUndefined();
    await expect(n.sendWhatsApp('', 'd')).resolves.toBeUndefined();
    delete process.env.WA_ACCESS_TOKEN;
    await expect(n.sendWhatsApp(PATIENT, 'e')).resolves.toBeUndefined();
    expect(f.calls).toHaveLength(3); // nothing goes out without a number or without the token
    const all = logs.join('\n');
    expect(all).toMatch(/refused, http 400, code 100/);
    expect(all).toMatch(/not sent \(TypeError\)/);
    expect(all).toMatch(/refused, http 502, code \?/);
    expect(all).toMatch(/not sent, no recipient number/);
    expect(all).toMatch(/not sent, WA_PHONE_NUMBER_ID \/ WA_ACCESS_TOKEN missing/);
  });

  it('a message longer than Meta allows is clipped, not refused', async () => {
    const f = fakeFetch();
    const n = new MetaWhatsAppNotifier(f.fn);
    n.markInbound(PATIENT);
    await n.sendWhatsApp(PATIENT, 'x'.repeat(5000));
    await n.sendBookingButtons(PATIENT, 'y'.repeat(2000), 'bk');
    expect(f.bodies()[0].text.body).toHaveLength(4096);
    expect(f.bodies()[0].text.body.endsWith('…')).toBe(true);
    expect(f.bodies()[1].interactive.body.text).toHaveLength(1024);
  });

  it('markInbound / inWindow: 24 h from the last inbound, whatever the phone format', () => {
    const n = new MetaWhatsAppNotifier(fakeFetch().fn);
    expect(n.inWindow(PATIENT)).toBe(false);
    n.markInbound(DIGITS, 1_000_000);
    expect(n.inWindow(PATIENT, 1_000_000 + WINDOW_MS - 1)).toBe(true);
    expect(n.inWindow('+21620123456', 1_000_000 + WINDOW_MS)).toBe(false);
    n.markInbound('', 5); // nothing to remember
    expect(n.inWindow('', 5)).toBe(false);
  });

  it('uses the global fetch when none is injected', async () => {
    const real = globalThis.fetch;
    const mock = jest.fn(async () => ({ ok: true, status: 200, json: async () => ({ messages: [{ id: 'wamid.real' }] }) }));
    globalThis.fetch = mock as unknown as typeof fetch;
    try {
      await new MetaWhatsAppNotifier().sendWhatsApp(PATIENT, 'hi');
    } finally {
      globalThis.fetch = real;
    }
    expect(mock).toHaveBeenCalledTimes(1);
    expect(mock.mock.calls[0] as unknown[]).toEqual([URL, expect.objectContaining({ method: 'POST' })]);
    expect(logs).toContainEqual(expect.stringMatching(/sent wamid\.real/));
  });
});

describe('AppModule NOTIFIER binding', () => {
  beforeAll(() => {
    const cabinetsDir = mkdtempSync(join(tmpdir(), 'darija-notify-boot-cabinets-'));
    copyFileSync(join(__dirname, '..', '..', 'cabinets', 'demo.json'), join(cabinetsDir, 'demo.json'));
    process.env.CABINETS_DIR = cabinetsDir;
    process.env.CALL_LOG_DIR = mkdtempSync(join(tmpdir(), 'darija-notify-boot-logs-'));
    process.env.PATIENT_NOTES_DIR = mkdtempSync(join(tmpdir(), 'darija-notify-boot-notes-'));
    delete process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  });

  it('binds MetaWhatsAppNotifier when WA_PHONE_NUMBER_ID and WA_ACCESS_TOKEN are set, ConsoleNotifier otherwise', async () => {
    const meta = await NestFactory.createApplicationContext(AppModule, { logger: false });
    try {
      expect(meta.get(NOTIFIER)).toBeInstanceOf(MetaWhatsAppNotifier);
      expect(logs).toContainEqual(expect.stringMatching(/WhatsApp Cloud API notifier bound: phone number id 111/));
    } finally {
      await meta.close();
    }

    delete process.env.WA_ACCESS_TOKEN;
    const plain = await NestFactory.createApplicationContext(AppModule, { logger: false });
    try {
      expect(plain.get(NOTIFIER)).toBeInstanceOf(ConsoleNotifier);
    } finally {
      await plain.close();
    }
  });
});
