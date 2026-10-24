import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { createHmac } from 'crypto';
import { copyFileSync, mkdtempSync, readFileSync } from 'fs';
import { AddressInfo } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';
import { AppModule } from './app.module';

/**
 * Boots the real module graph once: proves the DI wiring (CalendarRouter over Memory + Google
 * with its optional client, AdminChatService, both webhooks) and the raw-body signature path
 * through Express — things the unit specs construct by hand and cannot see.
 */
jest.setTimeout(30_000);

describe('AppModule', () => {
  let app: INestApplication;
  let url: string;
  const cabinetsDir = mkdtempSync(join(tmpdir(), 'darija-boot-cabinets-'));

  beforeAll(async () => {
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    copyFileSync(join(__dirname, '..', 'cabinets', 'demo.json'), join(cabinetsDir, 'demo.json'));
    process.env.CABINETS_DIR = cabinetsDir;
    process.env.CALL_LOG_DIR = mkdtempSync(join(tmpdir(), 'darija-boot-logs-'));
    process.env.PATIENT_NOTES_DIR = mkdtempSync(join(tmpdir(), 'darija-boot-notes-'));
    process.env.WA_VERIFY_TOKEN = 'tok';
    process.env.WA_APP_SECRET = 's3';
    delete process.env.VAPI_SECRET;
    delete process.env.GOOGLE_SERVICE_ACCOUNT_JSON; // the demo cabinet is on memory: boot must not need Google
    app = await NestFactory.create(AppModule, { rawBody: true, logger: false });
    await app.listen(0, '127.0.0.1');
    url = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await app.close();
    jest.restoreAllMocks();
  });

  it('serves /health', async () => {
    const r = await fetch(`${url}/health`);
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true });
  });

  it('answers the WhatsApp verification handshake', async () => {
    const ok = await fetch(`${url}/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=tok&hub.challenge=4242`);
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe('4242');
    const bad = await fetch(`${url}/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=1`);
    expect(bad.status).toBe(403);
  });

  it('verifies the signature over the raw body and runs STOP end to end', async () => {
    const raw = JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [{ changes: [{ value: { messages: [{ id: 'wamid.boot', from: '21620000001', type: 'text', text: { body: 'STOP' } }] } }] }],
    });
    const post = (sig: string) =>
      fetch(`${url}/webhooks/whatsapp`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': sig }, body: raw });

    expect((await post('sha256=00')).status).toBe(401);
    const ok = await post('sha256=' + createHmac('sha256', 's3').update(raw).digest('hex'));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true, handled: 1 });
    expect(JSON.parse(readFileSync(join(cabinetsDir, 'demo.json'), 'utf-8')).mode).toBe('off');
  });

  it('the Vapi assistant-request now carries the stop instruction', async () => {
    const r = await fetch(`${url}/webhooks/vapi`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: { type: 'assistant-request', call: { id: 'c1', phoneNumber: { number: '+21670000000' }, customer: { number: '+21620123456' } } } }),
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { assistant: { model: { messages: { content: string }[] } } };
    expect(body.assistant.model.messages[0].content).toContain('MODE ARRÊT');
  });
});
