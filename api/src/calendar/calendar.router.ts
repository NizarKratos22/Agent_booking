import { Injectable } from '@nestjs/common';
import { DateTime } from 'luxon';
import { CabinetService } from '../config/cabinet.service';
import { Booking, BusyBlock, CalendarPort } from './calendar.port';
import { GoogleCalendar } from './google.calendar';
import { MemoryCalendar } from './memory.calendar';

/**
 * The CALENDAR provider the app binds: each cabinet's `calendar.provider` picks the adapter,
 * so a demo cabinet on `memory` and a pilot cabinet on `google` run in one process.
 */
@Injectable()
export class CalendarRouter implements CalendarPort {
  constructor(
    private readonly cabinets: CabinetService,
    private readonly memory: MemoryCalendar,
    private readonly google: GoogleCalendar,
  ) {}

  private for(cabinetId: string): CalendarPort {
    return this.cabinets.get(cabinetId).calendar.provider === 'google' ? this.google : this.memory;
  }

  busy(cabinetId: string, from: DateTime, to: DateTime): Promise<BusyBlock[]> {
    return this.for(cabinetId).busy(cabinetId, from, to);
  }
  book(b: Omit<Booking, 'id' | 'status'>): Promise<Booking | null> {
    return this.for(b.cabinet_id).book(b);
  }
  get(cabinetId: string, bookingId: string): Promise<Booking | null> {
    return this.for(cabinetId).get(cabinetId, bookingId);
  }
  findByPhone(cabinetId: string, phone: string, after: DateTime): Promise<Booking[]> {
    return this.for(cabinetId).findByPhone(cabinetId, phone, after);
  }
  cancel(cabinetId: string, bookingId: string): Promise<boolean> {
    return this.for(cabinetId).cancel(cabinetId, bookingId);
  }
  move(cabinetId: string, bookingId: string, newStart: DateTime, newEnd: DateTime): Promise<Booking | null> {
    return this.for(cabinetId).move(cabinetId, bookingId, newStart, newEnd);
  }
  block(cabinetId: string, from: DateTime, to: DateTime, reason: string): Promise<void> {
    return this.for(cabinetId).block(cabinetId, from, to, reason);
  }
  list(cabinetId: string, from: DateTime, to: DateTime): Promise<Booking[]> {
    return this.for(cabinetId).list(cabinetId, from, to);
  }
  setStatus(cabinetId: string, bookingId: string, status: Booking['status']): Promise<void> {
    return this.for(cabinetId).setStatus(cabinetId, bookingId, status);
  }
}
