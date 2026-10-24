import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { readFileSync } from 'fs';
import { calendar_v3, google } from 'googleapis';
import { DateTime } from 'luxon';
import { CabinetService } from '../config/cabinet.service';
import { normalizePhone } from '../config/phone';
import { Booking, BusyBlock, CalendarPort } from './calendar.port';

/**
 * Google Calendar adapter. One Google calendar per cabinet (`cabinet.calendar.calendar_id`),
 * shared with the service account with "Make changes to events". It is the calendar the
 * secretary already uses, so:
 *
 *  - busy() counts every opaque event, ours or not: the secretary's appointments, the dentist
 *    typing at the chair, an all-day "Vacances". Transparent ("free") events do not block.
 *  - A booking is an event tagged in `extendedProperties.private` (kind=booking, phone, type,
 *    status...), so a Booking is rebuilt from the event alone. Manual blocks are kind=block.
 *  - Google has no transactions, so book()/move() are write-then-verify: write the event,
 *    re-read the slot, and if something else holds it undo our write and return null.
 *    A human's event always wins; between two agent writes the earlier `updated` wins and the
 *    event id breaks a tie. Both racers apply the same rule, so exactly one keeps the slot.
 *  - cancel() sets the Google status to cancelled (what the UI's delete does): the slot frees,
 *    the event stays retrievable by id with status cancelled, so get() still answers.
 */

/** The slice of the Google Calendar v3 client the adapter uses; injectable so tests run against a fake. */
export interface GoogleEventsApi {
  list(params: calendar_v3.Params$Resource$Events$List): Promise<{ data: calendar_v3.Schema$Events }>;
  get(params: calendar_v3.Params$Resource$Events$Get): Promise<{ data: calendar_v3.Schema$Event }>;
  insert(params: calendar_v3.Params$Resource$Events$Insert): Promise<{ data: calendar_v3.Schema$Event }>;
  patch(params: calendar_v3.Params$Resource$Events$Patch): Promise<{ data: calendar_v3.Schema$Event }>;
  delete(params: calendar_v3.Params$Resource$Events$Delete): Promise<unknown>;
}
export const GOOGLE_EVENTS_API = Symbol('GOOGLE_EVENTS_API');

const SCOPES = ['https://www.googleapis.com/auth/calendar'];

/** Service-account client from GOOGLE_SERVICE_ACCOUNT_JSON: a key-file path, or the key JSON itself. */
export function googleEventsApiFromEnv(): GoogleEventsApi {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON?.trim();
  if (!raw) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is not set (path to the service-account key file, or its JSON)');
  const credentials = JSON.parse(raw.startsWith('{') ? raw : readFileSync(raw, 'utf-8'));
  const auth = new google.auth.GoogleAuth({ credentials, scopes: SCOPES });
  return google.calendar({ version: 'v3', auth }).events;
}

type Priv = Record<string, string>;
type Event = calendar_v3.Schema$Event;

function privOf(ev: Event): Priv {
  return (ev.extendedProperties?.private ?? {}) as Priv;
}
function isBookingEvent(ev: Event): boolean {
  return privOf(ev).kind === 'booking';
}
/** Not written by us: the secretary, the dentist, an imported holiday. */
function isForeign(ev: Event): boolean {
  return !privOf(ev).kind;
}
function isOpaque(ev: Event): boolean {
  return ev.status !== 'cancelled' && ev.transparency !== 'transparent' && privOf(ev).status !== 'cancelled';
}
/** Timed events carry dateTime; all-day events carry date (end.date is already the exclusive next day). */
function evTime(t: calendar_v3.Schema$EventDateTime | undefined, zone: string): DateTime | null {
  if (t?.dateTime) return DateTime.fromISO(t.dateTime, { zone });
  if (t?.date) return DateTime.fromISO(t.date, { zone }).startOf('day');
  return null;
}
/** Who claimed first: Google's `updated` is RFC 3339 UTC, so string order is time order; id breaks ties. */
function claimKey(ev: Event): string {
  return `${ev.updated ?? ev.created ?? ''}|${ev.id ?? ''}`;
}
function isNotFound(e: any): boolean {
  const status = e?.response?.status ?? e?.status ?? Number(e?.code);
  return status === 404 || status === 410;
}

@Injectable()
export class GoogleCalendar implements CalendarPort {
  private readonly log = new Logger(GoogleCalendar.name);
  private api?: GoogleEventsApi;

  constructor(
    private readonly cabinets: CabinetService,
    @Optional() @Inject(GOOGLE_EVENTS_API) api?: GoogleEventsApi,
  ) {
    this.api = api;
  }

  /** Built on first use so a stack with only memory cabinets boots without Google credentials. */
  private get events(): GoogleEventsApi {
    return (this.api ??= googleEventsApiFromEnv());
  }

  private calendarId(cabinetId: string): string {
    const cal = this.cabinets.get(cabinetId).calendar;
    if (cal.provider !== 'google') throw new Error(`cabinet ${cabinetId} is not on the google calendar provider`);
    return cal.calendar_id;
  }

  private zone(cabinetId: string): string {
    return this.cabinets.get(cabinetId).timezone;
  }

  // ---- reads -------------------------------------------------------------------------

  async busy(cabinetId: string, from: DateTime, to: DateTime): Promise<BusyBlock[]> {
    const zone = this.zone(cabinetId);
    const events = await this.overlapping(this.calendarId(cabinetId), zone, from, to);
    return events
      .map((ev) => ({
        start: evTime(ev.start, zone)!.toISO()!,
        end: evTime(ev.end, zone)!.toISO()!,
        booking_id: isBookingEvent(ev) ? ev.id! : undefined,
      }))
      .sort((a, b) => a.start.localeCompare(b.start));
  }

  async get(cabinetId: string, bookingId: string): Promise<Booking | null> {
    const ev = await this.getEvent(this.calendarId(cabinetId), bookingId);
    const b = ev && this.toBooking(ev, this.zone(cabinetId));
    return b && b.cabinet_id === cabinetId ? b : null;
  }

  async findByPhone(cabinetId: string, phone: string, after: DateTime): Promise<Booking[]> {
    const zone = this.zone(cabinetId);
    const events = await this.listAll(this.calendarId(cabinetId), {
      timeMin: after.toISO()!,
      privateExtendedProperty: ['kind=booking', `patient_phone=${normalizePhone(phone)}`],
    });
    return this.toBookings(events, zone).filter((b) => b.status !== 'cancelled' && DateTime.fromISO(b.start) >= after);
  }

  async list(cabinetId: string, from: DateTime, to: DateTime): Promise<Booking[]> {
    const zone = this.zone(cabinetId);
    const events = await this.listAll(this.calendarId(cabinetId), {
      timeMin: from.toISO()!,
      timeMax: to.toISO()!,
      privateExtendedProperty: ['kind=booking'],
    });
    return this.toBookings(events, zone).filter((b) => {
      const s = DateTime.fromISO(b.start);
      return b.status !== 'cancelled' && s >= from && s < to;
    });
  }

  // ---- writes ------------------------------------------------------------------------

  async book(b: Omit<Booking, 'id' | 'status'>): Promise<Booking | null> {
    const calendarId = this.calendarId(b.cabinet_id);
    const zone = this.zone(b.cabinet_id);
    const start = DateTime.fromISO(b.start, { zone });
    const end = DateTime.fromISO(b.end, { zone });
    if ((await this.overlapping(calendarId, zone, start, end)).length) return null;

    const { data: ev } = await this.events.insert({ calendarId, requestBody: this.eventBody({ ...b, status: 'confirmed' }, zone) });
    if (await this.lostRace(calendarId, zone, ev, start, end)) {
      await this.undo(() => this.events.delete({ calendarId, eventId: ev.id! }), `delete ${ev.id} after losing the slot`);
      return null;
    }
    return this.toBooking(ev, zone);
  }

  async move(cabinetId: string, bookingId: string, newStart: DateTime, newEnd: DateTime): Promise<Booking | null> {
    const calendarId = this.calendarId(cabinetId);
    const zone = this.zone(cabinetId);
    const current = await this.getEvent(calendarId, bookingId);
    if (!current || !isBookingEvent(current) || current.status === 'cancelled') return null;
    const start = newStart.setZone(zone);
    const end = newEnd.setZone(zone);
    if ((await this.overlapping(calendarId, zone, start, end, bookingId)).length) return null;

    const priv: Priv = { ...privOf(current), status: 'confirmed' };
    const { data: moved } = await this.events.patch({
      calendarId,
      eventId: bookingId,
      requestBody: {
        start: { dateTime: start.toISO()!, timeZone: zone },
        end: { dateTime: end.toISO()!, timeZone: zone },
        status: 'confirmed',
        summary: this.summary(priv),
        extendedProperties: { private: priv },
      },
    });
    if (await this.lostRace(calendarId, zone, moved, start, end)) {
      await this.undo(
        () => this.events.patch({ calendarId, eventId: bookingId, requestBody: { start: current.start, end: current.end } }),
        `move ${bookingId} back to ${current.start?.dateTime} after losing the slot`,
      );
      return null;
    }
    return this.toBooking(moved, zone);
  }

  async cancel(cabinetId: string, bookingId: string): Promise<boolean> {
    const ev = await this.getEvent(this.calendarId(cabinetId), bookingId);
    if (!ev || !isBookingEvent(ev) || privOf(ev).cabinet_id !== cabinetId) return false;
    await this.setStatus(cabinetId, bookingId, 'cancelled');
    return true;
  }

  async setStatus(cabinetId: string, bookingId: string, status: Booking['status']): Promise<void> {
    const calendarId = this.calendarId(cabinetId);
    const ev = await this.getEvent(calendarId, bookingId);
    if (!ev || !isBookingEvent(ev)) return;
    const priv: Priv = { ...privOf(ev), status };
    await this.events.patch({
      calendarId,
      eventId: bookingId,
      requestBody: { status: status === 'cancelled' ? 'cancelled' : 'confirmed', summary: this.summary(priv), extendedProperties: { private: priv } },
    });
  }

  async block(cabinetId: string, from: DateTime, to: DateTime, reason: string): Promise<void> {
    const zone = this.zone(cabinetId);
    await this.events.insert({
      calendarId: this.calendarId(cabinetId),
      requestBody: {
        summary: reason,
        start: { dateTime: from.setZone(zone).toISO()!, timeZone: zone },
        end: { dateTime: to.setZone(zone).toISO()!, timeZone: zone },
        transparency: 'opaque',
        reminders: { useDefault: false },
        extendedProperties: { private: { kind: 'block', cabinet_id: cabinetId, reason } },
      },
    });
  }

  // ---- internals ---------------------------------------------------------------------

  /** Opaque events touching [start, end), minus `ignoreId`. Reads live every time; nothing is cached. */
  private async overlapping(calendarId: string, zone: string, start: DateTime, end: DateTime, ignoreId?: string): Promise<Event[]> {
    const events = await this.listAll(calendarId, { timeMin: start.toISO()!, timeMax: end.toISO()! });
    return events.filter((ev) => {
      if (ev.id === ignoreId || !isOpaque(ev)) return false;
      const s = evTime(ev.start, zone);
      const e = evTime(ev.end, zone);
      return !!s && !!e && s < end && e > start;
    });
  }

  /** After our write landed: does anything else hold the slot with a better claim? */
  private async lostRace(calendarId: string, zone: string, mine: Event, start: DateTime, end: DateTime): Promise<boolean> {
    const rivals = await this.overlapping(calendarId, zone, start, end, mine.id!);
    const myKey = claimKey(mine);
    return rivals.some((ev) => isForeign(ev) || claimKey(ev) <= myKey);
  }

  private async undo(action: () => Promise<unknown>, what: string): Promise<void> {
    try {
      await action();
    } catch (e) {
      this.log.error(`could not ${what}: ${(e as Error).message}. The calendar may show two events on one slot.`);
    }
  }

  private async listAll(calendarId: string, params: Omit<calendar_v3.Params$Resource$Events$List, 'calendarId'>): Promise<Event[]> {
    const items: Event[] = [];
    let pageToken: string | undefined;
    do {
      const { data } = await this.events.list({ calendarId, singleEvents: true, orderBy: 'startTime', maxResults: 2500, ...params, pageToken });
      items.push(...(data.items ?? []));
      pageToken = data.nextPageToken ?? undefined;
    } while (pageToken);
    return items;
  }

  private async getEvent(calendarId: string, eventId: string): Promise<Event | null> {
    try {
      return (await this.events.get({ calendarId, eventId })).data;
    } catch (e) {
      if (isNotFound(e)) return null;
      throw e;
    }
  }

  private summary(p: Priv): string {
    const cfg = this.cabinets.get(p.cabinet_id);
    const label = cfg.types.find((t) => t.id === p.type_id)?.label_fr ?? p.type_id;
    return `${p.status === 'unconfirmed' ? '? ' : ''}${p.patient_name} – ${label}`;
  }

  private eventBody(b: Omit<Booking, 'id'>, zone: string): Event {
    const priv: Priv = {
      kind: 'booking',
      cabinet_id: b.cabinet_id,
      type_id: b.type_id,
      patient_phone: normalizePhone(b.patient_phone),
      patient_name: b.patient_name,
      source: b.source,
      status: b.status,
      ...(b.notes ? { notes: b.notes } : {}),
    };
    const label = this.cabinets.get(b.cabinet_id).types.find((t) => t.id === b.type_id)?.label_fr ?? b.type_id;
    return {
      summary: this.summary(priv),
      description: [`Tél: ${priv.patient_phone}`, `Type: ${label} (${b.type_id})`, `Source: ${b.source}`, b.notes].filter(Boolean).join('\n'),
      start: { dateTime: DateTime.fromISO(b.start, { zone }).toISO()!, timeZone: zone },
      end: { dateTime: DateTime.fromISO(b.end, { zone }).toISO()!, timeZone: zone },
      status: b.status === 'cancelled' ? 'cancelled' : 'confirmed',
      transparency: 'opaque',
      // We send WhatsApp reminders ourselves; Google must not mail the service account.
      reminders: { useDefault: false },
      extendedProperties: { private: priv },
    };
  }

  private toBookings(events: Event[], zone: string): Booking[] {
    return events
      .map((ev) => this.toBooking(ev, zone))
      .filter((b): b is Booking => !!b)
      .sort((a, b) => a.start.localeCompare(b.start));
  }

  private toBooking(ev: Event, zone: string): Booking | null {
    const p = privOf(ev);
    const start = evTime(ev.start, zone);
    const end = evTime(ev.end, zone);
    if (p.kind !== 'booking' || !ev.id || !start || !end) return null;
    const status: Booking['status'] =
      ev.status === 'cancelled' || p.status === 'cancelled' ? 'cancelled' : p.status === 'unconfirmed' ? 'unconfirmed' : 'confirmed';
    return {
      id: ev.id,
      cabinet_id: p.cabinet_id ?? '',
      start: start.toISO()!,
      end: end.toISO()!,
      type_id: p.type_id ?? '',
      patient_phone: p.patient_phone ?? '',
      patient_name: p.patient_name ?? '',
      source: p.source ?? 'agent',
      status,
      ...(p.notes ? { notes: p.notes } : {}),
    };
  }
}
