import { Injectable } from '@nestjs/common';
import { DateTime } from 'luxon';
import { randomUUID } from 'crypto';
import { Booking, BusyBlock, CalendarPort } from './calendar.port';

/**
 * In-memory calendar for tests and the first demo. Same semantics as the Google
 * adapter: book() and move() re-check the slot at write time.
 */
@Injectable()
export class MemoryCalendar implements CalendarPort {
  private bookings = new Map<string, Booking>();
  private blocks: (BusyBlock & { cabinet_id: string; reason: string })[] = [];

  private overlaps(cabinetId: string, start: DateTime, end: DateTime, ignoreId?: string): boolean {
    for (const b of this.bookings.values()) {
      if (b.cabinet_id !== cabinetId || b.status === 'cancelled' || b.id === ignoreId) continue;
      if (DateTime.fromISO(b.start) < end && DateTime.fromISO(b.end) > start) return true;
    }
    for (const bl of this.blocks) {
      if (bl.cabinet_id !== cabinetId) continue;
      if (DateTime.fromISO(bl.start) < end && DateTime.fromISO(bl.end) > start) return true;
    }
    return false;
  }

  async busy(cabinetId: string, from: DateTime, to: DateTime): Promise<BusyBlock[]> {
    const out: BusyBlock[] = [];
    for (const b of this.bookings.values()) {
      if (b.cabinet_id !== cabinetId || b.status === 'cancelled') continue;
      if (DateTime.fromISO(b.start) < to && DateTime.fromISO(b.end) > from)
        out.push({ start: b.start, end: b.end, booking_id: b.id });
    }
    for (const bl of this.blocks) {
      if (bl.cabinet_id !== cabinetId) continue;
      if (DateTime.fromISO(bl.start) < to && DateTime.fromISO(bl.end) > from) out.push({ start: bl.start, end: bl.end });
    }
    return out.sort((a, b) => a.start.localeCompare(b.start));
  }

  async book(b: Omit<Booking, 'id' | 'status'>): Promise<Booking | null> {
    const start = DateTime.fromISO(b.start);
    const end = DateTime.fromISO(b.end);
    if (this.overlaps(b.cabinet_id, start, end)) return null;
    const booking: Booking = { ...b, id: randomUUID(), status: 'confirmed' };
    this.bookings.set(booking.id, booking);
    return booking;
  }

  async get(cabinetId: string, bookingId: string): Promise<Booking | null> {
    const b = this.bookings.get(bookingId);
    return b && b.cabinet_id === cabinetId ? b : null;
  }

  async findByPhone(cabinetId: string, phone: string, after: DateTime): Promise<Booking[]> {
    return [...this.bookings.values()]
      .filter(
        (b) =>
          b.cabinet_id === cabinetId &&
          b.patient_phone === phone &&
          b.status !== 'cancelled' &&
          DateTime.fromISO(b.start) >= after,
      )
      .sort((a, b) => a.start.localeCompare(b.start));
  }

  async cancel(cabinetId: string, bookingId: string): Promise<boolean> {
    const b = await this.get(cabinetId, bookingId);
    if (!b) return false;
    b.status = 'cancelled';
    return true;
  }

  async move(cabinetId: string, bookingId: string, newStart: DateTime, newEnd: DateTime): Promise<Booking | null> {
    const b = await this.get(cabinetId, bookingId);
    if (!b) return null;
    if (this.overlaps(cabinetId, newStart, newEnd, bookingId)) return null;
    b.start = newStart.toISO()!;
    b.end = newEnd.toISO()!;
    b.status = 'confirmed';
    return b;
  }

  async block(cabinetId: string, from: DateTime, to: DateTime, reason: string): Promise<void> {
    this.blocks.push({ cabinet_id: cabinetId, start: from.toISO()!, end: to.toISO()!, reason });
  }

  async list(cabinetId: string, from: DateTime, to: DateTime): Promise<Booking[]> {
    return [...this.bookings.values()]
      .filter((b) => b.cabinet_id === cabinetId && b.status !== 'cancelled')
      .filter((b) => DateTime.fromISO(b.start) >= from && DateTime.fromISO(b.start) < to)
      .sort((a, b) => a.start.localeCompare(b.start));
  }

  async setStatus(cabinetId: string, bookingId: string, status: Booking['status']): Promise<void> {
    const b = await this.get(cabinetId, bookingId);
    if (b) b.status = status;
  }

  /** test helper */
  reset(): void {
    this.bookings.clear();
    this.blocks = [];
  }
}
