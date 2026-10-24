import { Inject, Injectable, Logger, Optional } from '@nestjs/common';

/**
 * Gemini over the REST API (generateContent), through Node 20's global fetch — no SDK. Two uses:
 *  - chat(): one conversational turn with function calling. The model may call tools; each call
 *    is run through the caller's runner and answered with a functionResponse part, until the
 *    model writes text. Model parts go back into the history verbatim, because Gemini 2.5 signs
 *    its function calls (thoughtSignature) and expects the signature back.
 *  - transcribe(): one audio clip in, text out — the same call eval/stt_eval.py's gemini engine makes.
 * The key never reaches a log line.
 */

export type GeminiFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
export const GEMINI_FETCH = Symbol('GEMINI_FETCH');

export const GEMINI_API = 'https://generativelanguage.googleapis.com/v1beta';
const DEFAULT_MODEL = 'gemini-2.5-flash';
const TIMEOUT_MS = 30_000;
/** Tool rounds per turn: get_availability → book → find_my_bookings is 3; six leaves room without looping forever. */
export const MAX_TOOL_ROUNDS = 6;

export type GeminiPart = {
  text?: string;
  functionCall?: { name: string; args?: Record<string, unknown> };
  functionResponse?: { name: string; response: Record<string, unknown> };
  inlineData?: { mimeType: string; data: string };
  thoughtSignature?: string;
};
export type GeminiContent = { role: 'user' | 'model'; parts: GeminiPart[] };
export type FunctionDeclaration = { name: string; description: string; parameters: unknown };
export type ToolRunner = (name: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>;
export interface ChatTurn {
  text: string;
  /** Everything to append to the history: the user turn, each model turn, each tool answer. */
  contents: GeminiContent[];
  toolCalls: { name: string; args: Record<string, unknown>; result: Record<string, unknown> }[];
}

/** One OpenAI-style tool (PATIENT_TOOLS) → a Gemini function declaration; Gemini's schema spells types in capitals. */
export function toFunctionDeclaration(tool: { function: { name: string; description: string; parameters: unknown } }): FunctionDeclaration {
  return { name: tool.function.name, description: tool.function.description, parameters: upperTypes(tool.function.parameters) };
}

function upperTypes(schema: any): any {
  if (Array.isArray(schema)) return schema.map(upperTypes);
  if (!schema || typeof schema !== 'object') return schema;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(schema)) {
    if (k === 'type' && typeof v === 'string') out[k] = v.toUpperCase();
    else if (k === 'properties' && v && typeof v === 'object') out[k] = Object.fromEntries(Object.entries(v as object).map(([n, s]) => [n, upperTypes(s)]));
    else out[k] = upperTypes(v);
  }
  return out;
}

@Injectable()
export class GeminiClient {
  private readonly log = new Logger(GeminiClient.name);
  private readonly fetchFn: GeminiFetch;

  constructor(@Optional() @Inject(GEMINI_FETCH) fetchFn?: GeminiFetch) {
    this.fetchFn = fetchFn ?? (globalThis.fetch as unknown as GeminiFetch);
  }

  static configured(env: NodeJS.ProcessEnv = process.env): boolean {
    return Boolean((env.GEMINI_API_KEY ?? env.GOOGLE_API_KEY)?.trim());
  }

  model(): string {
    return process.env.GEMINI_CHAT_MODEL?.trim() || DEFAULT_MODEL;
  }

  async chat(opts: {
    system: string;
    history: GeminiContent[];
    user: GeminiPart[];
    tools: FunctionDeclaration[];
    run: ToolRunner;
    temperature?: number;
  }): Promise<ChatTurn> {
    const added: GeminiContent[] = [{ role: 'user', parts: opts.user }];
    const toolCalls: ChatTurn['toolCalls'] = [];
    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
      const parts = await this.generate({
        systemInstruction: { parts: [{ text: opts.system }] },
        contents: [...opts.history, ...added],
        ...(opts.tools.length ? { tools: [{ functionDeclarations: opts.tools }] } : {}),
        generationConfig: { temperature: opts.temperature ?? 0.3 },
      });
      added.push({ role: 'model', parts });
      const calls = parts.filter((p) => p.functionCall);
      if (!calls.length) return { text: parts.map((p) => p.text ?? '').join('').trim(), contents: added, toolCalls };
      const answers: GeminiPart[] = [];
      for (const p of calls) {
        const { name, args = {} } = p.functionCall!;
        const result = await opts.run(name, args);
        toolCalls.push({ name, args, result });
        answers.push({ functionResponse: { name, response: result } });
      }
      added.push({ role: 'user', parts: answers });
    }
    throw new Error(`Gemini kept calling tools after ${MAX_TOOL_ROUNDS} rounds`);
  }

  async transcribe(audio: Buffer, mimeType: string, hint: string): Promise<string> {
    const parts = await this.generate({
      contents: [{ role: 'user', parts: [{ text: hint }, { inlineData: { mimeType, data: audio.toString('base64') } }] }],
      generationConfig: { temperature: 0 },
    });
    return parts.map((p) => p.text ?? '').join('').trim();
  }

  private async generate(body: Record<string, unknown>): Promise<GeminiPart[]> {
    const key = (process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY)?.trim();
    if (!key) throw new Error('GEMINI_API_KEY is not set');
    const res = await this.fetchFn(`${GEMINI_API}/models/${this.model()}:generateContent`, {
      method: 'POST',
      headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const data = (await res.json().catch(() => ({}))) as any;
    if (!res.ok) throw new Error(`Gemini http ${res.status}: ${data?.error?.message ?? 'no detail'}`);
    const parts = data?.candidates?.[0]?.content?.parts;
    if (!Array.isArray(parts) || !parts.length) {
      throw new Error(`Gemini returned no content (${data?.promptFeedback?.blockReason ?? data?.candidates?.[0]?.finishReason ?? 'empty'})`);
    }
    return parts as GeminiPart[];
  }
}
