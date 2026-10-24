import { Body, Controller, Headers, HttpCode, Inject, Post, UnauthorizedException } from '@nestjs/common';
import { DateTime } from 'luxon';
import { PatientNotesService } from '../admin/patient-notes.service';
import { CabinetService } from '../config/cabinet.service';
import { NOTIFIER, Notifier } from '../notify/notifier.port';
import { AgentTools } from './agent-tools.service';
import { CallLog } from './call-log.service';
import { isEmergency } from './emergency';
import { PATIENT_TOOLS, systemPrompt } from './tools';

/**
 * Vapi server-URL webhook. Three message types matter:
 *  - assistant-request: Vapi asks us which assistant config to use for this inbound call
 *    → we look up the cabinet by the called number and return prompt + tools.
 *  - tool-calls: the model wants to run a tool → dispatch through AgentTools (shared with the
 *    WhatsApp chat agent).
 *  - transcript / end-of-call-report: we log, run the emergency check on user turns,
 *    and send the WhatsApp confirmation after the call.
 * Retell's shape is close enough that a second controller is a thin remap.
 */
@Controller('webhooks/vapi')
export class VapiController {
  constructor(
    private readonly tools: AgentTools,
    private readonly cabinets: CabinetService,
    private readonly log: CallLog,
    @Inject(NOTIFIER) private readonly notify: Notifier,
    private readonly notes: PatientNotesService,
  ) {}

  @Post()
  @HttpCode(200)
  async handle(@Body() body: any, @Headers('x-vapi-secret') secret?: string) {
    if (process.env.VAPI_SECRET && secret !== process.env.VAPI_SECRET) throw new UnauthorizedException();
    const msg = body?.message ?? body;
    const type: string = msg?.type;
    const call = msg?.call ?? {};
    const calledNumber: string = call?.phoneNumber?.number ?? call?.phoneNumberId ?? process.env.DEFAULT_CABINET_NUMBER ?? '';
    const callerPhone: string = call?.customer?.number ?? 'unknown';
    const callId: string = call?.id ?? 'local';
    const cfg = this.cabinets.byPhoneNumber(calledNumber) ?? this.cabinets.get(process.env.DEFAULT_CABINET_ID ?? 'demo');

    switch (type) {
      case 'assistant-request': {
        const now = DateTime.now().setZone(cfg.timezone).setLocale('fr').toFormat("cccc d LLLL yyyy, HH'h'mm");
        return {
          assistant: {
            name: `${cfg.name} — Amira`,
            firstMessage: `عسلامة، ${cfg.name}، أميرة معاك. كيفاش نجم نعاونك؟`,
            model: {
              provider: process.env.LLM_PROVIDER ?? 'google',
              model: process.env.LLM_MODEL ?? 'gemini-2.5-flash',
              temperature: 0.3,
              messages: [
                {
                  role: 'system',
                  content: systemPrompt(cfg, callerPhone, now, this.notes.for(cfg.id, callerPhone).map((n) => n.text)),
                },
              ],
              tools: PATIENT_TOOLS,
            },
            transcriber: { provider: process.env.STT_PROVIDER ?? 'deepgram', model: process.env.STT_MODEL ?? 'nova-3', language: 'ar' },
            voice: { provider: process.env.TTS_PROVIDER ?? 'azure', voiceId: process.env.TTS_VOICE ?? 'ar-TN-HediNeural' },
            endCallPhrases: ['بالسلامة', 'au revoir'],
            serverMessages: ['tool-calls', 'transcript', 'end-of-call-report'],
          },
        };
      }

      case 'transcript': {
        if (msg.role === 'user' && msg.transcriptType === 'final') {
          this.log.append(callId, cfg.id, 'user', msg.transcript);
          if (isEmergency(msg.transcript)) {
            this.log.flag(callId, 'emergency');
            // Belt and braces: the prompt should transfer, but we also alert staff immediately.
            await this.notify.notifyStaff(cfg.phone_doctor, `URGENCE appel ${callerPhone}: "${msg.transcript}"`, true);
          }
        } else if (msg.role === 'assistant' && msg.transcriptType === 'final') {
          this.log.append(callId, cfg.id, 'assistant', msg.transcript);
        }
        return {};
      }

      case 'tool-calls': {
        const results = [];
        for (const tc of msg.toolCallList ?? msg.toolCalls ?? []) {
          const name: string = tc.function?.name ?? tc.name;
          const args = typeof tc.function?.arguments === 'string' ? JSON.parse(tc.function.arguments) : (tc.function?.arguments ?? tc.arguments ?? {});
          const result = await this.tools.dispatch(cfg.id, name, args, callerPhone, callId, 'phone');
          this.log.append(callId, cfg.id, 'tool', `${name}(${JSON.stringify(args)}) → ${JSON.stringify(result)}`);
          results.push({ toolCallId: tc.id, result: JSON.stringify(result) });
        }
        return { results };
      }

      case 'end-of-call-report': {
        this.log.close(callId, msg.endedReason, msg.durationSeconds);
        return {};
      }

      default:
        return {};
    }
  }
}
