import { DateTime } from 'luxon';

/**
 * The calendar is the single source of truth for every booking, whoever makes it
 * (agent, secretary, dentist at the chair). The agent only ever reads and writes
 * through this port; it never caches availability.
 */

export interface Booking {
  id: string;
  cabinet_id: string;
  /** ISO 8601 with offset, in the cabinet's timezone. */
  start: string;
  end: string;
  type_id: string;
  patient_phone: string;
  patient_name: string;
  /** 'agent' | 'secretary' | 'doctor' — who created it. */
  source: string;
  status: 'confirmed' | 'cancelled' | 'unconfirmed';
  notes?: string;
}

export interface BusyBlock {
  start: string;
  end: string;
  /** booking id when it is one; undefined for manual blocks (lunch, vacation). */
  booking_id?: string;
}

export interface CalendarPort {
  /** Every occupied interval in [from, to), bookings and blocks alike. */
  busy(cabinetId: string, from: DateTime, to: DateTime): Promise<BusyBlock[]>;

  /**
   * Atomically create the booking if the slot is still free. Returns null on conflict.
   * Implementations MUST re-check availability at write time.
   */
  book(b: Omit<Booking, 'id' | 'status'>): Promise<Booking | null>;

  get(cabinetId: string, bookingId: string): Promise<Booking | null>;
  /** Most recent non-cancelled booking for this phone, if any. */
  findByPhone(cabinetId: string, phone: string, after: DateTime): Promise<Booking[]>;

  cancel(cabinetId: string, bookingId: string): Promise<boolean>;
  /** Move an existing booking; atomic like book(). Returns null on conflict. */
  move(cabinetId: string, bookingId: string, newStart: DateTime, newEnd: DateTime): Promise<Booking | null>;

  /** Manual block (lunch, "close Friday"). */
  block(cabinetId: string, from: DateTime, to: DateTime, reason: string): Promise<void>;
  /** Bookings whose start is within [from, to) — for list_day and shift_day. */
  list(cabinetId: string, from: DateTime, to: DateTime): Promise<Booking[]>;
  setStatus(cabinetId: string, bookingId: string, status: Booking['status']): Promise<void>;
}

export const CALENDAR = Symbol('CALENDAR');
