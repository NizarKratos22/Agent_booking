import { Inject, Injectable, Optional } from '@nestjs/common';
import { GRAPH_API } from '../notify/meta-whatsapp.notifier';

/**
 * Downloads a WhatsApp media object (a patient's voice note) through the Graph API: GET /{media-id}
 * answers with a short-lived URL and the MIME type, then GET that URL with the same bearer returns
 * the bytes. Both calls use WA_ACCESS_TOKEN, so voice notes need the sending configuration too.
 */
export type MediaFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; arrayBuffer(): Promise<ArrayBuffer> }>;
export const WA_MEDIA_FETCH = Symbol('WA_MEDIA_FETCH');

const TIMEOUT_MS = 20_000;
/** WhatsApp caps audio at 16 MB; a voice note is a few hundred KB. */
export const MEDIA_MAX_BYTES = 16 * 1024 * 1024;

@Injectable()
export class WhatsAppMedia {
  private readonly fetchFn: MediaFetch;

  constructor(@Optional() @Inject(WA_MEDIA_FETCH) fetchFn?: MediaFetch) {
    this.fetchFn = fetchFn ?? (globalThis.fetch as unknown as MediaFetch);
  }

  configured(): boolean {
    return Boolean(process.env.WA_ACCESS_TOKEN?.trim());
  }

  async download(mediaId: string): Promise<{ bytes: Buffer; mimeType: string }> {
    const token = process.env.WA_ACCESS_TOKEN?.trim();
    if (!token) throw new Error('WA_ACCESS_TOKEN is not set');
    const headers = { Authorization: `Bearer ${token}` };
    const lookup = await this.fetchFn(`${GRAPH_API}/${encodeURIComponent(mediaId)}`, { method: 'GET', headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
    const info = (await lookup.json().catch(() => ({}))) as { url?: string; mime_type?: string; file_size?: number; error?: { code?: number } };
    if (!lookup.ok || !info.url) throw new Error(`media ${mediaId}: lookup failed (http ${lookup.status}, code ${info.error?.code ?? '?'})`);
    if ((info.file_size ?? 0) > MEDIA_MAX_BYTES) throw new Error(`media ${mediaId}: ${info.file_size} bytes is over the limit`);
    const file = await this.fetchFn(info.url, { method: 'GET', headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!file.ok) throw new Error(`media ${mediaId}: download failed (http ${file.status})`);
    const bytes = Buffer.from(await file.arrayBuffer());
    if (bytes.length > MEDIA_MAX_BYTES) throw new Error(`media ${mediaId}: ${bytes.length} bytes is over the limit`);
    // "audio/ogg; codecs=opus" → "audio/ogg": the model wants the bare type.
    return { bytes, mimeType: (info.mime_type ?? 'audio/ogg').split(';')[0].trim() };
  }
}
