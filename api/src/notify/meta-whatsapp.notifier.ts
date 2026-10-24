import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { normalizePhone } from '../config/phone';
import { Notifier } from './notifier.port';

/**
 * WhatsApp Cloud API (Meta Graph API) implementation of the Notifier port.
 *
 *  - One endpoint: POST graph.facebook.com/v21.0/{WA_PHONE_NUMBER_ID}/messages with the
 *    WA_ACCESS_TOKEN bearer, through Node 20's global fetch (no SDK). Numbers go out as digits
 *    without the plus, Meta's format.
 *  - Free-form messages (text, interactive reply buttons) are only accepted inside the 24 h
 *    customer-service window that opens when the recipient writes to the number. A booking made
 *    on the phone is almost always outside it, so the confirmation goes out as the approved
 *    template WA_TEMPLATE_BOOKING ({{1}} = the text, quick replies Confirmer / Annuler) when no
 *    inbound message from that number is known in the last 24 h — the webhook feeds markInbound —
 *    or when Meta refuses the interactive send with the window error (131047).
 *  - Staff messages (the emergency alert to the doctor, a patient's message for the secretary) are
 *    text and follow the same rule with WA_TEMPLATE_STAFF ({{1}} = the text, 🚨 URGENT prefix kept).
 *    Admin replies answer a message the admin just sent, so they stay free-form.
 *  - Button ids and template payloads are `confirm:<bookingId>` / `cancel:<bookingId>`; the
 *    webhook parses them with parseBookingReply and acts on the calendar.
 *  - Nothing here throws. A send is logged with the Meta message id on success and the HTTP
 *    status plus error code on failure — never the token, never the message body — and the
 *    caller, a Vapi tool call in the middle of a phone conversation, carries on.
 */

export const GRAPH_API = 'https://graph.facebook.com/v21.0';
/** Meta's customer-service window: free-form messages are accepted this long after the last inbound. */
export const WINDOW_MS = 24 * 60 * 60 * 1000;
/** 131047 "Re-engagement message": more than 24 hours since the recipient last wrote to this number. */
const WINDOW_ERROR_CODES = new Set([131047]);
const TIMEOUT_MS = 10_000;
const TEXT_MAX = 4096;
const INTERACTIVE_BODY_MAX = 1024;
const BUTTON_TITLES = { confirm: 'Confirmer', cancel: 'Annuler' } as const;

/** The slice of fetch the notifier uses; injectable so tests run against a fake. */
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
export const WA_FETCH = Symbol('WA_FETCH');

/** Both sending variables present: the app binds MetaWhatsAppNotifier instead of ConsoleNotifier. */
export function isMetaWhatsAppConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.WA_PHONE_NUMBER_ID?.trim() && env.WA_ACCESS_TOKEN?.trim());
}

/** What a patient's tap on Confirmer / Annuler carries back (button payload or interactive reply id). */
export type BookingReply = { action: 'confirm' | 'cancel'; bookingId: string };
export function parseBookingReply(payload: string | undefined): BookingReply | undefined {
  const m = /^(confirm|cancel):(\S+)$/.exec(payload?.trim() ?? '');
  return m ? { action: m[1] as BookingReply['action'], bookingId: m[2] } : undefined;
}

/** A notifier that wants to know when a number last wrote to us (to pick free-form vs template). */
export interface InboundAware {
  markInbound(phone: string, at?: number): void;
}
export function isInboundAware(n: unknown): n is InboundAware {
  return typeof (n as Partial<InboundAware> | undefined)?.markInbound === 'function';
}

type SendResult = { ok: true; id: string } | { ok: false; status: number; code?: number };
type GraphResponse = {
  messages?: { id?: string }[];
  error?: { code?: number; error_subcode?: number; type?: string };
};

@Injectable()
export class MetaWhatsAppNotifier implements Notifier, InboundAware {
  private readonly log = new Logger(MetaWhatsAppNotifier.name);
  private readonly fetchFn: FetchLike;
  /** E.164 → epoch ms of the last inbound this process saw. Lost on restart: then the template is used, which is always valid. */
  private readonly lastInbound = new Map<string, number>();

  constructor(@Optional() @Inject(WA_FETCH) fetchFn?: FetchLike) {
    this.fetchFn = fetchFn ?? (globalThis.fetch as unknown as FetchLike);
    this.log.log(
      `WhatsApp Cloud API notifier bound: phone number id ${process.env.WA_PHONE_NUMBER_ID?.trim() || '(unset)'}, ` +
        `templates (${templateLang()}): booking ${bookingTemplateName() ?? 'none'}, staff ${staffTemplateName() ?? 'none'}`,
    );
  }

  markInbound(phone: string, at: number = Date.now()): void {
    const p = normalizePhone(phone);
    if (p) this.lastInbound.set(p, at);
  }

  /** True when the number wrote to us in the last 24 h, as far as this process has seen. */
  inWindow(phone: string, now: number = Date.now()): boolean {
    const at = this.lastInbound.get(normalizePhone(phone));
    return at !== undefined && now - at < WINDOW_MS;
  }

  async sendWhatsApp(to: string, text: string): Promise<void> {
    await this.send('text', to, textMessage(text));
  }

  async sendBookingButtons(to: string, text: string, bookingId: string): Promise<void> {
    const name = bookingTemplateName();
    await this.freeFormOrTemplate(to, ['booking buttons', 'booking template'], bookingButtons(text, bookingId), name ? bookingTemplate(name, text, bookingId) : undefined);
  }

  async notifyStaff(to: string, text: string, urgent = false): Promise<void> {
    const body = urgent ? `🚨 URGENT ${text}` : text;
    const kind = urgent ? 'staff urgent' : 'staff';
    const name = staffTemplateName();
    await this.freeFormOrTemplate(to, [kind, `${kind} template`], textMessage(body), name ? staffTemplate(name, body) : undefined);
  }

  /**
   * Free-form inside the 24 h window; the approved template straight away when the window is known
   * to be closed, or after Meta refuses the free-form send with the window error. Without a template
   * the free-form send is still attempted (the window may be open without our knowing) and logged.
   */
  private async freeFormOrTemplate(
    to: string,
    [kind, templateKind]: [string, string],
    freeForm: Record<string, unknown>,
    template?: Record<string, unknown>,
  ): Promise<void> {
    if (template && !this.inWindow(to)) {
      await this.send(templateKind, to, template);
      return;
    }
    const r = await this.send(kind, to, freeForm);
    if (!r.ok && template && r.code !== undefined && WINDOW_ERROR_CODES.has(r.code)) {
      this.lastInbound.delete(normalizePhone(to)); // Meta knows the window better than we do
      await this.send(templateKind, to, template);
    }
  }

  private async send(kind: string, to: string, message: Record<string, unknown>): Promise<SendResult> {
    const phoneNumberId = process.env.WA_PHONE_NUMBER_ID?.trim();
    const token = process.env.WA_ACCESS_TOKEN?.trim();
    const recipient = normalizePhone(to).replace(/^\+/, '');
    if (!phoneNumberId || !token) {
      this.log.error(`${kind} → ${recipient || '?'}: not sent, WA_PHONE_NUMBER_ID / WA_ACCESS_TOKEN missing`);
      return { ok: false, status: 0 };
    }
    if (!recipient) {
      this.log.error(`${kind}: not sent, no recipient number`);
      return { ok: false, status: 0 };
    }
    const body = JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to: recipient, ...message });
    try {
      const res = await this.fetchFn(`${GRAPH_API}/${encodeURIComponent(phoneNumberId)}/messages`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const data = (await res.json().catch(() => ({}))) as GraphResponse;
      if (res.ok && !data.error) {
        const id = data.messages?.[0]?.id ?? '?';
        this.log.log(`${kind} → ${recipient}: sent ${id}`);
        return { ok: true, id };
      }
      const code = data.error?.code;
      const sub = data.error?.error_subcode;
      const line = `${kind} → ${recipient}: refused, http ${res.status}, code ${code ?? '?'}${sub ? `/${sub}` : ''}`;
      if (code !== undefined && WINDOW_ERROR_CODES.has(code)) this.log.warn(`${line} (outside the 24 h window)`);
      else this.log.error(line);
      return { ok: false, status: res.status, code };
    } catch (e) {
      this.log.error(`${kind} → ${recipient}: not sent (${(e as Error)?.name ?? 'error'})`);
      return { ok: false, status: 0 };
    }
  }
}

// ---- payloads -----------------------------------------------------------------------------

function bookingTemplateName(): string | undefined {
  return process.env.WA_TEMPLATE_BOOKING?.trim() || undefined;
}
function staffTemplateName(): string | undefined {
  return process.env.WA_TEMPLATE_STAFF?.trim() || undefined;
}
function templateLang(): string {
  return process.env.WA_TEMPLATE_LANG?.trim() || 'ar';
}
function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
/** Template parameters may not contain newlines, tabs or runs of spaces. */
function templateParam(text: string): string {
  return clip(text.replace(/\s+/g, ' ').trim(), INTERACTIVE_BODY_MAX);
}

function textMessage(text: string) {
  return { type: 'text', text: { preview_url: false, body: clip(text, TEXT_MAX) } };
}

/** Interactive reply buttons: free-form, so inside the window only. */
function bookingButtons(text: string, bookingId: string) {
  return {
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: clip(text, INTERACTIVE_BODY_MAX) },
      action: {
        buttons: [
          { type: 'reply', reply: { id: `confirm:${bookingId}`, title: BUTTON_TITLES.confirm } },
          { type: 'reply', reply: { id: `cancel:${bookingId}`, title: BUTTON_TITLES.cancel } },
        ],
      },
    },
  };
}

/** The approved staff template: body `{{1}}` only; an urgent alert keeps its 🚨 URGENT prefix inside the parameter. */
function staffTemplate(name: string, text: string) {
  return {
    type: 'template',
    template: {
      name,
      language: { code: templateLang() },
      components: [{ type: 'body', parameters: [{ type: 'text', text: templateParam(text) }] }],
    },
  };
}

/** The approved booking template: body `{{1}}` and two quick-reply buttons (index 0 Confirmer, 1 Annuler). */
function bookingTemplate(name: string, text: string, bookingId: string) {
  return {
    type: 'template',
    template: {
      name,
      language: { code: templateLang() },
      components: [
        { type: 'body', parameters: [{ type: 'text', text: templateParam(text) }] },
        { type: 'button', sub_type: 'quick_reply', index: '0', parameters: [{ type: 'payload', payload: `confirm:${bookingId}` }] },
        { type: 'button', sub_type: 'quick_reply', index: '1', parameters: [{ type: 'payload', payload: `cancel:${bookingId}` }] },
      ],
    },
  };
}
