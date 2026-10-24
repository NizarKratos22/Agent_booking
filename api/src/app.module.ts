import { Module } from '@nestjs/common';
import { CabinetService } from './config/cabinet.service';
import { CALENDAR } from './calendar/calendar.port';
import { MemoryCalendar } from './calendar/memory.calendar';
import { GoogleCalendar } from './calendar/google.calendar';
import { CalendarRouter } from './calendar/calendar.router';
import { BookingService } from './booking/booking.service';
import { NOTIFIER, ConsoleNotifier, Notifier } from './notify/notifier.port';
import { FetchLike, MetaWhatsAppNotifier, WA_FETCH, isMetaWhatsAppConfigured } from './notify/meta-whatsapp.notifier';
import { VapiController } from './agent/vapi.controller';
import { CallLog } from './agent/call-log.service';
import { AgentTools } from './agent/agent-tools.service';
import { GeminiClient } from './agent/gemini.client';
import { WhatsAppMedia } from './agent/whatsapp-media';
import { WhatsAppChatService } from './agent/whatsapp-chat.service';
import { AdminChatService } from './admin/admin-chat.service';
import { PatientNotesService } from './admin/patient-notes.service';
import { WhatsAppController } from './admin/whatsapp.controller';
import { HealthController } from './health.controller';

@Module({
  controllers: [VapiController, WhatsAppController, HealthController],
  providers: [
    CabinetService,
    BookingService,
    CallLog,
    AdminChatService,
    PatientNotesService,
    // The model's tools, shared by the phone webhook and the WhatsApp chat agent. The chat agent
    // itself is disabled (patient messages logged, not answered) until GEMINI_API_KEY is set.
    AgentTools,
    GeminiClient,
    WhatsAppMedia,
    WhatsAppChatService,
    // Each cabinet's `calendar.provider` (memory | google) picks its adapter; the Google client
    // is only built on first use, so a memory-only stack boots without GOOGLE_SERVICE_ACCOUNT_JSON.
    MemoryCalendar,
    GoogleCalendar,
    { provide: CALENDAR, useClass: CalendarRouter },
    // MetaWhatsAppNotifier once WA_PHONE_NUMBER_ID and WA_ACCESS_TOKEN are both set (the VAPI_SECRET /
    // WA_APP_SECRET opt-in shape); ConsoleNotifier, which only logs, otherwise. Decided when the app boots.
    {
      provide: NOTIFIER,
      useFactory: (fetchFn?: FetchLike): Notifier => (isMetaWhatsAppConfigured() ? new MetaWhatsAppNotifier(fetchFn) : new ConsoleNotifier()),
      inject: [{ token: WA_FETCH, optional: true }],
    },
  ],
})
export class AppModule {}
