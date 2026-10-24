import { GeminiClient, GeminiContent, GeminiPart, MAX_TOOL_ROUNDS, toFunctionDeclaration } from './gemini.client';
import { CHAT_TOOLS, PATIENT_TOOLS } from './tools';

const saved = { ...process.env };
beforeEach(() => {
  process.env.GEMINI_API_KEY = 'g-test';
  delete process.env.GOOGLE_API_KEY;
  delete process.env.GEMINI_CHAT_MODEL;
});
afterAll(() => {
  for (const k of ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_CHAT_MODEL']) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

type Step = GeminiPart[] | { status: number; body: unknown };

/** Scripted Gemini: each request consumes the next step; parts become one candidate, an object an HTTP error. */
function fakeGemini(script: Step[]) {
  const calls: { url: string; headers: Record<string, string>; body: any }[] = [];
  const fetchFn = async (url: string, init: { headers: Record<string, string>; body: string }) => {
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    const next = script.shift();
    if (!next) throw new Error('fake Gemini: script exhausted');
    if (Array.isArray(next)) return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { role: 'model', parts: next }, finishReason: 'STOP' }] }) };
    return { ok: false, status: next.status, json: async () => next.body };
  };
  return { client: new GeminiClient(fetchFn as any), calls };
}
const text = (t: string): GeminiPart => ({ text: t });
const call = (name: string, args: Record<string, unknown>): GeminiPart => ({ functionCall: { name, args }, thoughtSignature: `sig-${name}` });

describe('toFunctionDeclaration', () => {
  it('turns the OpenAI-style tools into Gemini declarations with capitalised types', () => {
    const d = toFunctionDeclaration(PATIENT_TOOLS[0]) as any;
    expect(d.name).toBe('get_availability');
    expect(d.parameters.type).toBe('OBJECT');
    expect(d.parameters.properties.type_id.type).toBe('STRING');
    expect(d.parameters.properties.type_id.description).toMatch(/Appointment type/);
    expect(d.parameters.required).toEqual(['type_id']);
    const transfer = toFunctionDeclaration(PATIENT_TOOLS.find((t) => t.function.name === 'transfer')!) as any;
    expect(transfer.parameters.properties.target.enum).toEqual(['secretary', 'doctor']);
  });

  it('the chat tool set has everything but transfer', () => {
    expect(CHAT_TOOLS.map((t) => t.function.name)).toEqual(['get_availability', 'book', 'find_my_bookings', 'reschedule', 'cancel', 'leave_message']);
  });
});

describe('GeminiClient.chat', () => {
  const tools = CHAT_TOOLS.map(toFunctionDeclaration);
  const run = jest.fn(async (name: string) => ({ ok: true, tool: name }));
  beforeEach(() => run.mockClear());

  it('sends system instruction, history, tools and the user turn; returns the text', async () => {
    const { client, calls } = fakeGemini([[text('عسلامة، كيفاش نعاونك؟')]]);
    const history: GeminiContent[] = [{ role: 'user', parts: [text('salut')] }, { role: 'model', parts: [text('bonjour')] }];
    const turn = await client.chat({ system: 'SYS', history, user: [text('نحب rdv')], tools, run });
    expect(turn.text).toBe('عسلامة، كيفاش نعاونك؟');
    expect(turn.toolCalls).toEqual([]);
    expect(turn.contents).toEqual([{ role: 'user', parts: [text('نحب rdv')] }, { role: 'model', parts: [text('عسلامة، كيفاش نعاونك؟')] }]);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent');
    expect(calls[0].headers['x-goog-api-key']).toBe('g-test');
    expect(calls[0].body.systemInstruction).toEqual({ parts: [{ text: 'SYS' }] });
    expect(calls[0].body.contents).toEqual([...history, { role: 'user', parts: [text('نحب rdv')] }]);
    expect(calls[0].body.tools[0].functionDeclarations).toHaveLength(6);
    expect(calls[0].body.generationConfig).toEqual({ temperature: 0.3 });
    expect(run).not.toHaveBeenCalled();
  });

  it('runs function calls, answers them with the signed model turn kept verbatim, and returns the final text', async () => {
    const { client, calls } = fakeGemini([[call('get_availability', { type_id: 'cleaning' })], [text('الاثنين 10:00 ولا الثلاثاء 09:00؟')]]);
    const turn = await client.chat({ system: 'SYS', history: [], user: [text('تنظيف')], tools, run });
    expect(turn.text).toBe('الاثنين 10:00 ولا الثلاثاء 09:00؟');
    expect(run).toHaveBeenCalledWith('get_availability', { type_id: 'cleaning' });
    expect(turn.toolCalls).toEqual([{ name: 'get_availability', args: { type_id: 'cleaning' }, result: { ok: true, tool: 'get_availability' } }]);
    expect(turn.contents.map((c) => c.role)).toEqual(['user', 'model', 'user', 'model']);
    expect(turn.contents[1].parts[0].thoughtSignature).toBe('sig-get_availability');
    expect(turn.contents[2].parts).toEqual([{ functionResponse: { name: 'get_availability', response: { ok: true, tool: 'get_availability' } } }]);
    // The second request carries the user turn, the model's call (with its signature) and our answer.
    expect(calls[1].body.contents).toEqual(turn.contents.slice(0, 3));
  });

  it('answers parallel calls in one turn with one functionResponse part each', async () => {
    const { client } = fakeGemini([[call('find_my_bookings', { patient_phone: '+2161' }), call('get_availability', { type_id: 'consultation' })], [text('ok')]]);
    const turn = await client.chat({ system: 'SYS', history: [], user: [text('x')], tools, run });
    expect(run).toHaveBeenCalledTimes(2);
    expect(turn.contents[2].parts.map((p) => p.functionResponse!.name)).toEqual(['find_my_bookings', 'get_availability']);
  });

  it('stops a model that never stops calling tools', async () => {
    const { client } = fakeGemini(Array.from({ length: MAX_TOOL_ROUNDS + 1 }, () => [call('get_availability', {})]));
    await expect(client.chat({ system: 'SYS', history: [], user: [text('x')], tools, run })).rejects.toThrow(/kept calling tools/);
  });

  it('surfaces HTTP errors and empty answers as errors', async () => {
    const { client: a } = fakeGemini([{ status: 429, body: { error: { message: 'quota exceeded' } } }]);
    await expect(a.chat({ system: 'SYS', history: [], user: [text('x')], tools, run })).rejects.toThrow(/http 429: quota exceeded/);
    const { client: b } = fakeGemini([[]]);
    await expect(b.chat({ system: 'SYS', history: [], user: [text('x')], tools, run })).rejects.toThrow(/no content/);
  });

  it('needs a key, accepts GOOGLE_API_KEY, and honours GEMINI_CHAT_MODEL', async () => {
    delete process.env.GEMINI_API_KEY;
    expect(GeminiClient.configured()).toBe(false);
    const { client, calls } = fakeGemini([[text('ok')]]);
    await expect(client.chat({ system: 'SYS', history: [], user: [text('x')], tools: [], run })).rejects.toThrow(/GEMINI_API_KEY is not set/);
    process.env.GOOGLE_API_KEY = 'g2';
    process.env.GEMINI_CHAT_MODEL = 'gemini-2.5-pro';
    expect(GeminiClient.configured()).toBe(true);
    await client.chat({ system: 'SYS', history: [], user: [text('x')], tools: [], run });
    expect(calls[0].url).toContain('gemini-2.5-pro:generateContent');
    expect(calls[0].headers['x-goog-api-key']).toBe('g2');
    expect(calls[0].body.tools).toBeUndefined();
  });
});

describe('GeminiClient.transcribe', () => {
  it('sends the clip inline with the hint and returns the text', async () => {
    const { client, calls } = fakeGemini([[text(' نحب نأخذ rendez-vous ')]]);
    const audio = Buffer.from('OggS fake opus');
    expect(await client.transcribe(audio, 'audio/ogg', 'HINT')).toBe('نحب نأخذ rendez-vous');
    const parts = calls[0].body.contents[0].parts;
    expect(parts[0]).toEqual({ text: 'HINT' });
    expect(parts[1].inlineData).toEqual({ mimeType: 'audio/ogg', data: audio.toString('base64') });
    expect(calls[0].body.systemInstruction).toBeUndefined();
    expect(calls[0].body.generationConfig).toEqual({ temperature: 0 });
  });
});
