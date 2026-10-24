import { Inject, Injectable } from '@nestjs/common';
import { DateTime } from 'luxon';
import { CALENDAR, CalendarPort, Booking } from '../calendar/calendar.port';
import { CabinetService } from '../config/cabinet.service';
import { freeSlots, pickOffers, slotLabelAr, slotLabelFr, Slot } from './slots';

/**
 * The tools the LLM calls. Every method is idempotent-safe, returns plain JSON
 * the model can read back to the caller, and never throws for business errors
 * (the model needs a message to say, not a stack trace).
 */
@Injectable()
export class BookingService {
  constructor(
    @Inject(CALENDAR) private readonly cal: CalendarPort,
    private readonly cabinets: CabinetService,
  ) {}

  private now(cabinetId: string): DateTime {
    return DateTime.now().setZone(this.cabinets.get(cabinetId).timezone);
  }

  private fmt(s: Slot, zone: string) {
    const st = s.start.setZone(zone);
    return { start: st.toISO(), label_ar: slotLabelAr(st), label_fr: slotLabelFr(st) };
  }

  async get_availability(cabinetId: string, typeId: string, fromISO?: string, days = 7) {
    const cfg = this.cabinets.get(cabinetId);
    const type = cfg.types.find((t) => t.id === typeId);
    if (!type) return { ok: false, error: 'unknown_type', types: cfg.types.map((t) => t.id) };
    const now = this.now(cabinetId);
    const from = fromISO ? DateTime.fromISO(fromISO, { zone: cfg.timezone }) : now;
    const to = from.plus({ days });
    const busy = await this.cal.busy(cabinetId, from, to);
    const slots = freeSlots(cfg, type, busy, from, to, now);
    return {
      ok: true,
      type: { id: type.id, label_ar: type.label_ar, minutes: type.minutes },
      offers: pickOffers(slots, 3).map((s) => this.fmt(s, cfg.timezone)),
      total_free: slots.length,
    };
  }

  async book(cabinetId: string, args: { patient_phone: string; patient_name: string; type_id: string; start: string; source?: string }) {
    const cfg = this.cabinets.get(cabinetId);
    if (cfg.mode === 'off') return { ok: false, error: 'agent_off' };
    const type = cfg.types.find((t) => t.id === args.type_id);
    if (!type) return { ok: false, error: 'unknown_type' };
    const start = DateTime.fromISO(args.start, { zone: cfg.timezone });
    if (!start.isValid) return { ok: false, error: 'bad_start' };
    const end = start.plus({ minutes: type.minutes });

    // Re-validate against opening hours and live busy state at write time.
    const busy = await this.cal.busy(cabinetId, start.startOf('day'), end.endOf('day'));
    const stillFree = freeSlots(cfg, type, busy, start, end, this.now(cabinetId)).some((s) => s.start.equals(start));
    if (!stillFree) {
      const alt = await this.get_availability(cabinetId, type.id, start.toISO()!, 3);
      return { ok: false, error: 'slot_taken', alternatives: alt.ok ? alt.offers : [] };
    }

    const booking = await this.cal.book({
      cabinet_id: cabinetId,
      start: start.toISO()!,
      end: end.toISO()!,
      type_id: type.id,
      patient_phone: args.patient_phone,
      patient_name: args.patient_name,
      source: args.source ?? 'agent',
    });
    if (!booking) {
      const alt = await this.get_availability(cabinetId, type.id, start.toISO()!, 3);
      return { ok: false, error: 'slot_taken', alternatives: alt.ok ? alt.offers : [] };
    }
    return { ok: true, booking: this.publicBooking(booking, cfg.timezone) };
  }

  async find_my_bookings(cabinetId: string, patientPhone: string) {
    const cfg = this.cabinets.get(cabinetId);
    const list = await this.cal.findByPhone(cabinetId, patientPhone, this.now(cabinetId));
    return { ok: true, bookings: list.map((b) => this.publicBooking(b, cfg.timezone)) };
  }

  async reschedule(cabinetId: string, bookingId: string, newStart: string) {
    const cfg = this.cabinets.get(cabinetId);
    const b = await this.cal.get(cabinetId, bookingId);
    if (!b) return { ok: false, error: 'not_found' };
    const type = cfg.types.find((t) => t.id === b.type_id)!;
    const start = DateTime.fromISO(newStart, { zone: cfg.timezone });
    const end = start.plus({ minutes: type.minutes });
    const busy = (await this.cal.busy(cabinetId, start.startOf('day'), end.endOf('day'))).filter((x) => x.booking_id !== bookingId);
    const stillFree = freeSlots(cfg, type, busy, start, end, this.now(cabinetId)).some((s) => s.start.equals(start));
    if (!stillFree) {
      const alt = await this.get_availability(cabinetId, type.id, start.toISO()!, 3);
      return { ok: false, error: 'slot_taken', alternatives: alt.ok ? alt.offers : [] };
    }
    const moved = await this.cal.move(cabinetId, bookingId, start, end);
    if (!moved) return { ok: false, error: 'slot_taken' };
    return { ok: true, booking: this.publicBooking(moved, cfg.timezone) };
  }

  async cancel(cabinetId: string, bookingId: string) {
    const ok = await this.cal.cancel(cabinetId, bookingId);
    return ok ? { ok: true } : { ok: false, error: 'not_found' };
  }

  /** The patient tapped Confirmer under the WhatsApp booking message. Idempotent; a cancelled booking stays cancelled. */
  async confirm(cabinetId: string, bookingId: string) {
    const cfg = this.cabinets.get(cabinetId);
    const b = await this.cal.get(cabinetId, bookingId);
    if (!b) return { ok: false, error: 'not_found' };
    if (b.status === 'cancelled') return { ok: false, error: 'cancelled' };
    if (b.status !== 'confirmed') await this.cal.setStatus(cabinetId, bookingId, 'confirmed');
    return { ok: true, booking: this.publicBooking({ ...b, status: 'confirmed' }, cfg.timezone) };
  }

  /** Admin: list a day for the secretary. */
  async list_day(cabinetId: string, dateISO: string) {
    const cfg = this.cabinets.get(cabinetId);
    const day = DateTime.fromISO(dateISO, { zone: cfg.timezone }).startOf('day');
    const list = await this.cal.list(cabinetId, day, day.plus({ days: 1 }));
    return { ok: true, date: day.toISODate(), bookings: list.map((b) => this.publicBooking(b, cfg.timezone)) };
  }

  /** Admin: block a range (close Friday, lunch). */
  async block_slots(cabinetId: string, fromISO: string, toISO: string, reason: string) {
    const cfg = this.cabinets.get(cabinetId);
    const from = DateTime.fromISO(fromISO, { zone: cfg.timezone });
    const to = DateTime.fromISO(toISO, { zone: cfg.timezone });
    const affected = await this.cal.list(cabinetId, from, to);
    await this.cal.block(cabinetId, from, to, reason);
    return { ok: true, affected: affected.map((b) => this.publicBooking(b, cfg.timezone)) };
  }

  /**
   * Admin: "doctor is 30 minutes late" — shift every remaining booking today.
   * Returns the moved bookings so the caller can notify patients. Does not notify itself.
   */
  async shift_day(cabinetId: string, minutes: number, dateISO?: string) {
    const cfg = this.cabinets.get(cabinetId);
    const now = this.now(cabinetId);
    const day = dateISO ? DateTime.fromISO(dateISO, { zone: cfg.timezone }).startOf('day') : now.startOf('day');
    const list = (await this.cal.list(cabinetId, day, day.plus({ days: 1 }))).filter((b) => DateTime.fromISO(b.start) >= now);
    // Move latest first so earlier ones do not collide with the next.
    const moved: Booking[] = [];
    for (const b of [...list].reverse()) {
      const s = DateTime.fromISO(b.start).setZone(cfg.timezone).plus({ minutes });
      const e = DateTime.fromISO(b.end).setZone(cfg.timezone).plus({ minutes });
      const m = await this.cal.move(cabinetId, b.id, s, e);
      if (m) moved.push(m);
    }
    return { ok: true, moved: moved.reverse().map((b) => this.publicBooking(b, cfg.timezone)) };
  }

  private publicBooking(b: Booking, zone: string) {
    const st = DateTime.fromISO(b.start).setZone(zone);
    return {
      id: b.id,
      start: st.toISO(),
      label_ar: slotLabelAr(st),
      label_fr: slotLabelFr(st),
      type_id: b.type_id,
      patient_name: b.patient_name,
      patient_phone: b.patient_phone,
      status: b.status,
    };
  }
}
