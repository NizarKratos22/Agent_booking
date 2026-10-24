import { Inject, Injectable, Logger } from '@nestjs/common';
import { DateTime } from 'luxon';
import { PatientNotesService } from '../admin/patient-notes.service';
import { CabinetConfig } from '../config/cabinet.schema';
import { NOTIFIER, Notifier } from '../notify/notifier.port';
import { AgentTools } from './agent-tools.service';
import { CallLog } from './call-log.service';
import { isEmergency } from './emergency';
import { GeminiClient, GeminiContent, toFunctionDeclaration } from './gemini.client';
import { CHAT_TOOLS, systemPrompt } from './tools';
import { WhatsAppMedia } from './whatsapp-media';

/**
 * Amira on WhatsApp. A patient's text or voice note on the cabinet's number is answered in the
 * same chat by Gemini, with the same system prompt and booking tools as the phone agent:
 *  - a voice note is first transcribed (one Gemini call, same as the eval engine), so the
 *    emergency regexes and the call log work on text and the history stays text-only;
 *  - the emergency rule runs before the model on every message and alerts the doctor;
 *  - mode `off` (STOP) answers a fixed line pointing at the cabinet phone, no model call;
 *  - one conversation per (cabinet, phone) is kept in memory for two hours, so "the 10:00 one"
 *    means the slot offered a minute ago; a restart forgets it, the patient just repeats;
 *  - every turn is appended to the call log under `wa:<phone>` — the same regression corpus;
 *  - a model or network failure becomes a short apology with the cabinet phone, never silence.
 * Without GEMINI_API_KEY the agent is disabled and patient messages are logged and left alone.
 */

export interface InboundChatMessage {
  id: string;
  type: string;
  text?: string;
  mediaId?: string;
  mimeType?: string;
}

const SESSION_TTL_MS = 2 * 60 * 60 * 1000;
/** Contents kept per conversation (a turn with two tool calls is about five contents). */
const MAX_HISTORY = 40;
const MAX_SESSIONS = 5000;
const REPLY_MAX = 4096;

const TRANSCRIBE_HINT =
  'Transcris mot à mot ce message vocal envoyé à un cabinet dentaire tunisien. Tunisien (derja) en écriture arabe, ' +
  'mots français en lettres latines tels que prononcés (rendez-vous, détartrage, docteur), nombres en chiffres. ' +
  'Réponds uniquement avec la transcription, sans commentaire.';

const agentOff = (cfg: CabinetConfig) => `${cfg.name}: توا السكرتارية هي اللي تجاوب. اتصل بينا على ${cfg.phone_line}.`;
const voiceUnavailable = (cfg: CabinetConfig) => `${cfg.name}: سامحني، ما نجمتش نسمع الفوكال. تنجم تكتبلي؟`;
const fallback = (cfg: CabinetConfig) => `${cfg.name}: سامحني، صارت مشكلة تقنية. اتصل بينا على ${cfg.phone_line} وإلا عاود بعد شوية.`;

@Injectable()
export class WhatsAppChatService {
  private readonly log = new Logger(WhatsAppChatService.name);
  private readonly sessions = new Map<string, { contents: GeminiContent[]; at: number }>();

  constructor(
    private readonly tools: AgentTools,
    private readonly gemini: GeminiClient,
    private readonly media: WhatsAppMedia,
    private readonly notes: PatientNotesService,
    private readonly callLog: CallLog,
    @Inject(NOTIFIER) private readonly notify: Notifier,
  ) {}

  enabled(): boolean {
    return GeminiClient.configured();
  }

  /** One inbound patient message → one reply in the chat. Returns the reply, or null when nothing was sent. */
  async handle(cfg: CabinetConfig, from: string, msg: InboundChatMessage): Promise<string | null> {
    if (!this.enabled()) {
      this.log.warn(`chat from ${from} → ${cfg.id} ignored: GEMINI_API_KEY not set`);
      return null;
    }
    const callId = `wa:${from}`;
    let text = msg.text?.trim() ?? '';
    if (msg.type === 'audio' && msg.mediaId) {
      const transcript = await this.transcribeVoiceNote(from, msg.mediaId, msg.mimeType);
      if (!transcript) return this.reply(cfg, from, callId, voiceUnavailable(cfg));
      text = transcript;
      this.callLog.append(callId, cfg.id, 'user', `[vocal] ${text}`);
    } else if (!text) {
      return null; // a sticker, an image, a location: nothing to answer
    } else {
      this.callLog.append(callId, cfg.id, 'user', text);
    }

    if (isEmergency(text)) {
      this.callLog.flag(callId, 'emergency');
      await this.notify.notifyStaff(cfg.phone_doctor, `URGENCE WhatsApp ${from}: "${text}"`, true);
    }
    if (cfg.mode === 'off') return this.reply(cfg, from, callId, agentOff(cfg));

    const now = DateTime.now().setZone(cfg.timezone).setLocale('fr').toFormat("cccc d LLLL yyyy, HH'h'mm");
    const system = systemPrompt(cfg, from, now, this.notes.for(cfg.id, from).map((n) => n.text), 'whatsapp');
    const session = this.session(cfg.id, from);
    try {
      const turn = await this.gemini.chat({
        system,
        history: session.contents,
        user: [{ text }],
        tools: CHAT_TOOLS.map(toFunctionDeclaration),
        run: async (name, args) => {
          const result = await this.tools.dispatch(cfg.id, name, args, from, callId, 'whatsapp');
          this.callLog.append(callId, cfg.id, 'tool', `${name}(${JSON.stringify(args)}) → ${JSON.stringify(result)}`);
          return result;
        },
      });
      session.contents = trimHistory([...session.contents, ...turn.contents]);
      session.at = Date.now();
      return this.reply(cfg, from, callId, turn.text || fallback(cfg));
    } catch (e) {
      this.log.error(`chat ${from} → ${cfg.id}: ${(e as Error).message}`);
      return this.reply(cfg, from, callId, fallback(cfg));
    }
  }

  /** The transcript of a voice note, or null when it cannot be fetched or heard. */
  private async transcribeVoiceNote(from: string, mediaId: string, mimeType?: string): Promise<string | null> {
    if (!this.media.configured()) {
      this.log.warn(`voice note from ${from} ignored: WA_ACCESS_TOKEN not set`);
      return null;
    }
    try {
      const { bytes, mimeType: detected } = await this.media.download(mediaId);
      const text = await this.gemini.transcribe(bytes, mimeType?.split(';')[0].trim() || detected, TRANSCRIBE_HINT);
      return text || null;
    } catch (e) {
      this.log.error(`voice note from ${from}: ${(e as Error).message}`);
      return null;
    }
  }

  private async reply(cfg: CabinetConfig, to: string, callId: string, text: string): Promise<string> {
    const body = text.length > REPLY_MAX ? `${text.slice(0, REPLY_MAX - 1)}…` : text;
    await this.notify.sendWhatsApp(to, body);
    this.callLog.append(callId, cfg.id, 'assistant', body);
    return body;
  }

  private session(cabinetId: string, phone: string): { contents: GeminiContent[]; at: number } {
    const key = `${cabinetId}:${phone}`;
    const now = Date.now();
    let s = this.sessions.get(key);
    if (s && now - s.at > SESSION_TTL_MS) s = undefined;
    if (!s) {
      if (this.sessions.size >= MAX_SESSIONS) for (const [k, v] of this.sessions) if (now - v.at > SESSION_TTL_MS) this.sessions.delete(k);
      s = { contents: [], at: now };
      this.sessions.set(key, s);
    }
    return s;
  }

  /** Test helper: forget every conversation. */
  reset(): void {
    this.sessions.clear();
  }
}

/** Keep the last MAX_HISTORY contents, cut at a patient turn so no tool answer is left without its call. */
export function trimHistory(contents: GeminiContent[]): GeminiContent[] {
  if (contents.length <= MAX_HISTORY) return contents;
  const from = contents.length - MAX_HISTORY;
  for (let i = from; i < contents.length; i++) {
    if (contents[i].role === 'user' && contents[i].parts.some((p) => p.text !== undefined)) return contents.slice(i);
  }
  return [];
}
