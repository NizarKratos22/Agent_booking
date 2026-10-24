import { Inject, Injectable } from '@nestjs/common';
import { BookingService } from '../booking/booking.service';
import { CabinetService } from '../config/cabinet.service';
import { NOTIFIER, Notifier } from '../notify/notifier.port';
import { CallLog } from './call-log.service';
import { AgentChannel } from './tools';

export type ToolResult = Record<string, unknown>;

/**
 * The tools the model calls, dispatched the same way whichever channel the model is on: the Vapi
 * phone webhook and the WhatsApp chat agent both hand a function call here. Every result is plain
 * JSON the model reads back to the patient; business errors are results, never exceptions. The
 * side effects live here too — the Confirmer / Annuler message after `book`, the staff alert for
 * `leave_message` — so a booking made in chat is confirmed exactly like one made on the phone.
 */
@Injectable()
export class AgentTools {
  constructor(
    private readonly booking: BookingService,
    private readonly cabinets: CabinetService,
    private readonly log: CallLog,
    @Inject(NOTIFIER) private readonly notify: Notifier,
  ) {}

  async dispatch(cabinetId: string, name: string, a: any, callerPhone: string, callId: string, channel: AgentChannel = 'phone'): Promise<ToolResult> {
    const cfg = this.cabinets.get(cabinetId);
    switch (name) {
      case 'get_availability':
        return this.booking.get_availability(cabinetId, a.type_id, a.from);
      case 'book': {
        const r = await this.booking.book(cabinetId, { ...a, patient_phone: a.patient_phone || callerPhone });
        if (r.ok && r.booking) {
          const t = cfg.types.find((x) => x.id === r.booking!.type_id)!;
          await this.notify.sendBookingButtons(
            r.booking.patient_phone,
            `${cfg.name}: موعدك ${t.label_ar} ${r.booking.label_ar}. ${cfg.address_ar}. تحب تأكد ولا تبدل؟`,
            r.booking.id,
          );
        }
        return r;
      }
      case 'find_my_bookings':
        return this.booking.find_my_bookings(cabinetId, a.patient_phone || callerPhone);
      case 'reschedule': {
        const r = await this.booking.reschedule(cabinetId, a.booking_id, a.new_start);
        // On the phone the patient hears it and gets a WhatsApp line; in the chat the reply itself says it.
        if (r.ok && r.booking && channel === 'phone') await this.notify.sendWhatsApp(r.booking.patient_phone, `${cfg.name}: موعدك ولى ${r.booking.label_ar}.`);
        return r;
      }
      case 'cancel':
        return this.booking.cancel(cabinetId, a.booking_id);
      case 'transfer': {
        if (channel !== 'phone') return { ok: false, error: 'no_transfer_on_chat', call_instead: cfg.phone_line };
        const target = a.target === 'doctor' ? cfg.phone_doctor : cfg.phone_secretary;
        this.log.flag(callId, `transfer:${a.target}`);
        // Vapi executes the transfer when the tool result carries a destination.
        return { ok: true, destination: { type: 'number', number: target, message: 'نحولك توا' }, reason: a.reason };
      }
      case 'leave_message': {
        await this.notify.notifyStaff(cfg.phone_secretary, `Message de ${a.patient_phone || callerPhone}: ${a.text}`, !!a.urgent);
        return { ok: true };
      }
      default:
        return { ok: false, error: 'unknown_tool' };
    }
  }
}
