import { calendar_v3 } from 'googleapis';
import { mkdtempSync } from 'fs';
import { DateTime, Settings } from 'luxon';
import { tmpdir } from 'os';
import { join } from 'path';
import { BookingService } from '../booking/booking.service';
import { CabinetConfig } from '../config/cabinet.schema';
import { CabinetService } from '../config/cabinet.service';
import { CalendarRouter } from './calendar.router';
import { GoogleCalendar, GoogleEventsApi } from './google.calendar';
import { MemoryCalendar } from './memory.calendar';
import demo from '../../cabinets/demo.json';

const CAL_ID = 'bensalem@group.calendar.google.com';
const ZONE = 'Africa/Tunis';
const cfg = CabinetConfig.parse({ ...demo, calendar: { provider: 'google', calendar_id: CAL_ID } });
/** Monday 2026-10-26 at h:m, Tunis time. */
const T = (h: number, m = 0) => DateTime.fromISO('2026-10-26T00:00:00', { zone: ZONE }).set({ hour: h, minute: m });
const NOW = T(9);
Settings.now = () => NOW.toMillis();

type Ev = calendar_v3.Schema$Event;
const clone = <X>(x: X): X => JSON.parse(JSON.stringify(x));
const evStart = (ev: Ev) => (ev.start?.dateTime ? DateTime.fromISO(ev.start.dateTime) : DateTime.fromISO(ev.start!.date!, { zone: ZONE }));
const evEnd = (ev: Ev) => (ev.end?.dateTime ? DateTime.fromISO(ev.end.dateTime) : DateTime.fromISO(ev.end!.date!, { zone: ZONE }));

/**
 * In-memory stand-in for the Events resource with Google's query semantics: the time window
 * (end > timeMin, start < timeMax), privateExtendedProperty filters, soft delete (status
 * cancelled, still readable by id), monotonic `updated`, and paging.
 */
class FakeGoogleEvents implements GoogleEventsApi {
  store = new Map<string, Ev>();
  calls: string[] = [];
  pageSize = 2;
  frozenClock = false;
  afterInsert?: (ev: Ev) => void;
  afterPatch?: (ev: Ev) => void;
  private n = 0;
  private clock = DateTime.fromISO('2026-10-23T08:00:00.000Z');

  private tick(): string {
    if (!this.frozenClock) this.clock = this.clock.plus({ milliseconds: 1 });
    return this.clock.toUTC().toISO()!;
  }
  private check(calendarId?: string | null): void {
    if (calendarId !== CAL_ID) throw new Error(`unexpected calendarId ${calendarId}`);
  }
  private notFound(): Error {
    return Object.assign(new Error('Not Found'), { code: 404, response: { status: 404 } });
  }
  /** An event the secretary typed in the Google UI: no private properties. */
  seed(ev: Ev): Ev {
    const id = ev.id ?? `foreign${++this.n}`;
    const t = this.tick();
    const full: Ev = { status: 'confirmed', ...ev, id, created: t, updated: t };
    this.store.set(id, full);
    return full;
  }
  live(): Ev[] {
    return [...this.store.values()].filter((e) => e.status !== 'cancelled');
  }

  async list(p: calendar_v3.Params$Resource$Events$List) {
    this.calls.push('list');
    this.check(p.calendarId);
    const tMin = p.timeMin ? DateTime.fromISO(p.timeMin) : undefined;
    const tMax = p.timeMax ? DateTime.fromISO(p.timeMax) : undefined;
    const filters = ([] as string[]).concat(p.privateExtendedProperty ?? []).map((f) => f.split('=') as [string, string]);
    const items = [...this.store.values()]
      .filter((ev) => p.showDeleted || ev.status !== 'cancelled')
      .filter((ev) => (!tMin || evEnd(ev) > tMin) && (!tMax || evStart(ev) < tMax))
      .filter((ev) => filters.every(([k, v]) => ev.extendedProperties?.private?.[k] === v))
      .sort((a, b) => evStart(a).toMillis() - evStart(b).toMillis());
    const offset = Number(p.pageToken ?? 0);
    const page = items.slice(offset, offset + this.pageSize);
    const nextPageToken = offset + this.pageSize < items.length ? String(offset + this.pageSize) : undefined;
    return { data: { items: page.map(clone), nextPageToken } };
  }
  async get(p: calendar_v3.Params$Resource$Events$Get) {
    this.calls.push('get');
    this.check(p.calendarId);
    const ev = this.store.get(p.eventId!);
    if (!ev) throw this.notFound();
    return { data: clone(ev) };
  }
  async insert(p: calendar_v3.Params$Resource$Events$Insert) {
    this.calls.push('insert');
    this.check(p.calendarId);
    const id = `ev${++this.n}`;
    const t = this.tick();
    const ev: Ev = { status: 'confirmed', ...clone(p.requestBody!), id, created: t, updated: t };
    this.store.set(id, ev);
    this.afterInsert?.(ev);
    return { data: clone(ev) };
  }
  async patch(p: calendar_v3.Params$Resource$Events$Patch) {
    this.calls.push('patch');
    this.check(p.calendarId);
    const ev = this.store.get(p.eventId!);
    if (!ev) throw this.notFound();
    Object.assign(ev, clone(p.requestBody!));
    ev.updated = this.tick();
    this.afterPatch?.(ev);
    return { data: clone(ev) };
  }
  async delete(p: calendar_v3.Params$Resource$Events$Delete) {
    this.calls.push('delete');
    this.check(p.calendarId);
    const ev = this.store.get(p.eventId!);
    if (!ev) throw this.notFound();
    ev.status = 'cancelled';
    ev.updated = this.tick();
    return {};
  }
}

function make() {
  process.env.CABINETS_DIR = mkdtempSync(join(tmpdir(), 'darija-cal-'));
  const cabinets = new CabinetService();
  cabinets.upsert(cfg, false);
  const api = new FakeGoogleEvents();
  const cal = new GoogleCalendar(cabinets, api);
  return { cal, api, cabinets };
}

const patient = (name: string, phone: string, start: DateTime, minutes = 30, type_id = 'cleaning') => ({
  cabinet_id: 'demo',
  start: start.toISO()!,
  end: start.plus({ minutes }).toISO()!,
  type_id,
  patient_phone: phone,
  patient_name: name,
  source: 'agent',
});
const timed = (start: DateTime, minutes: number, extra: Partial<Ev> = {}): Ev => ({
  summary: 'secretary event',
  start: { dateTime: start.toISO()! },
  end: { dateTime: start.plus({ minutes }).toISO()! },
  ...extra,
});

describe('GoogleCalendar', () => {
  it('books as a tagged event the secretary can read, and rebuilds the booking from it', async () => {
    const { cal, api } = make();
    const b = await cal.book(patient('Mme Trabelsi', '+21620123456', T(10)));
    expect(b).toMatchObject({ id: 'ev1', status: 'confirmed', patient_name: 'Mme Trabelsi', type_id: 'cleaning', cabinet_id: 'demo' });
    expect(DateTime.fromISO(b!.start).toMillis()).toBe(T(10).toMillis());

    const ev = api.store.get('ev1')!;
    expect(ev.summary).toBe('Mme Trabelsi – Détartrage');
    expect(ev.description).toContain('+21620123456');
    expect(ev.extendedProperties!.private).toMatchObject({ kind: 'booking', patient_phone: '+21620123456', status: 'confirmed' });
    expect(ev.reminders).toEqual({ useDefault: false });
    expect(ev.start!.timeZone).toBe(ZONE);

    expect(await cal.get('demo', 'ev1')).toEqual(b);
    expect(await cal.get('demo', 'nope')).toBeNull();
  });

  it('busy() counts the secretary’s events, all-day blocks and our bookings; ignores free and cancelled ones', async () => {
    const { cal, api } = make();
    api.seed(timed(T(10), 30)); // typed by the secretary
    api.seed({ summary: 'Vacances', start: { date: '2026-10-27' }, end: { date: '2026-10-28' } });
    api.seed(timed(T(11), 30, { transparency: 'transparent', summary: 'rappel' })); // "free" → not busy
    api.seed(timed(T(16), 30, { status: 'cancelled' }));
    const b = await cal.book(patient('A', '+2161', T(14)));
    await cal.block('demo', T(12, 30), T(14), 'déjeuner');

    const busy = await cal.busy('demo', T(0), T(0).plus({ days: 2 }));
    expect(busy.map((x) => [DateTime.fromISO(x.start).setZone(ZONE).toFormat('dd HH:mm'), x.booking_id ?? '-'])).toEqual([
      ['26 10:00', '-'],
      ['26 12:30', '-'],
      ['26 14:00', b!.id],
      ['27 00:00', '-'],
    ]);
    const vac = busy[3];
    expect(DateTime.fromISO(vac.end).diff(DateTime.fromISO(vac.start), 'hours').hours).toBe(24);
  });

  it('refuses a slot already held before writing anything', async () => {
    const { cal, api } = make();
    api.seed(timed(T(10), 60));
    expect(await cal.book(patient('B', '+2162', T(10, 30)))).toBeNull();
    expect(api.calls).not.toContain('insert');
  });

  it('pages through long listings', async () => {
    const { cal, api } = make();
    api.pageSize = 2;
    for (const h of [8, 9, 10, 11, 12]) api.seed(timed(T(h), 30));
    expect(await cal.busy('demo', T(0), T(23))).toHaveLength(5);
  });

  it('five agents racing for one slot: exactly one booking survives', async () => {
    const { cal, api } = make();
    const results = await Promise.all(Array.from({ length: 5 }, (_, i) => cal.book(patient(`P${i}`, `+216${i}`, T(10)))));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(api.live()).toHaveLength(1);
    expect(api.live()[0].id).toBe(results.find(Boolean)!.id);
  });

  it('breaks a same-millisecond tie deterministically', async () => {
    const { cal, api } = make();
    api.frozenClock = true;
    const results = await Promise.all([cal.book(patient('A', '+2161', T(10))), cal.book(patient('B', '+2162', T(10)))]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(api.live()).toHaveLength(1);
  });

  it('a human’s event written during the race always wins', async () => {
    const { cal, api } = make();
    api.afterInsert = () => {
      api.afterInsert = undefined;
      api.seed(timed(T(10), 30, { summary: 'typed by the secretary a moment later' }));
    };
    expect(await cal.book(patient('A', '+2161', T(10)))).toBeNull();
    expect(api.live().map((e) => e.summary)).toEqual(['typed by the secretary a moment later']);
  });

  it('move() re-checks at write time and reverts when the target is taken', async () => {
    const { cal, api } = make();
    await cal.book(patient('A', '+2161', T(10)));
    const b = (await cal.book(patient('B', '+2162', T(11))))!;

    expect(await cal.move('demo', b.id, T(10, 15), T(10, 45))).toBeNull(); // pre-check
    expect(api.store.get(b.id)!.start!.dateTime).toBe(T(11).toISO());

    api.afterPatch = () => {
      api.afterPatch = undefined;
      api.seed(timed(T(15), 30)); // lands between our write and our verification
    };
    expect(await cal.move('demo', b.id, T(15), T(15, 30))).toBeNull(); // lost → reverted
    expect(api.store.get(b.id)!.start!.dateTime).toBe(T(11).toISO());

    const moved = await cal.move('demo', b.id, T(10, 30), T(11));
    expect(DateTime.fromISO(moved!.start).toMillis()).toBe(T(10, 30).toMillis());
    expect(api.store.get(b.id)!.start!.dateTime).toBe(T(10, 30).toISO());
    expect(await cal.move('demo', 'nope', T(12), T(12, 30))).toBeNull();
  });

  it('findByPhone and list see only our bookings, with phones normalised', async () => {
    const { cal, api } = make();
    api.seed(timed(T(9), 30));
    await cal.book(patient('A', '216 20 123 456', T(10))); // no plus, spaces
    await cal.book(patient('A', '+21620123456', T(15)));
    await cal.book(patient('B', '+21699', T(11)));

    const mine = await cal.findByPhone('demo', '+21620123456', T(0));
    expect(mine.map((b) => DateTime.fromISO(b.start).setZone(ZONE).toFormat('HH:mm'))).toEqual(['10:00', '15:00']);
    expect(await cal.findByPhone('demo', '+21620123456', T(12))).toHaveLength(1);
    expect(await cal.findByPhone('demo', '+21600000000', T(0))).toHaveLength(0);

    const day = await cal.list('demo', T(0), T(0).plus({ days: 1 }));
    expect(day.map((b) => b.patient_name)).toEqual(['A', 'B', 'A']);
    expect(await cal.list('demo', T(12), T(14))).toHaveLength(0);
  });

  it('cancel frees the slot, keeps the record readable, and refuses what is not ours', async () => {
    const { cal, api } = make();
    const b = (await cal.book(patient('A', '+2161', T(10))))!;
    const foreign = api.seed(timed(T(12), 30));

    expect(await cal.cancel('demo', b.id)).toBe(true);
    expect(await cal.busy('demo', T(10), T(10, 30))).toEqual([]);
    expect((await cal.get('demo', b.id))!.status).toBe('cancelled');
    expect(await cal.findByPhone('demo', '+2161', T(0))).toHaveLength(0);
    expect(await cal.cancel('demo', 'nope')).toBe(false);
    expect(await cal.cancel('demo', foreign.id!)).toBe(false);
    expect(api.store.get(foreign.id!)!.status).toBe('confirmed');

    expect(await cal.book(patient('C', '+2163', T(10)))).not.toBeNull(); // slot is free again
  });

  it('setStatus flags an unconfirmed booking in the summary', async () => {
    const { cal, api } = make();
    const b = (await cal.book(patient('A', '+2161', T(10))))!;
    await cal.setStatus('demo', b.id, 'unconfirmed');
    expect(api.store.get(b.id)!.summary).toBe('? A – Détartrage');
    expect((await cal.get('demo', b.id))!.status).toBe('unconfirmed');
    await cal.setStatus('demo', b.id, 'confirmed');
    expect(api.store.get(b.id)!.summary).toBe('A – Détartrage');
  });

  it('refuses a cabinet that is not on the google provider', async () => {
    const { cal, cabinets } = make();
    cabinets.upsert({ ...cfg, id: 'mem', calendar: { provider: 'memory' } }, false);
    await expect(cal.busy('mem', T(0), T(1))).rejects.toThrow(/not on the google/);
  });
});

describe('CalendarRouter', () => {
  it('sends each cabinet to the adapter its config names', async () => {
    const { cabinets, api } = make();
    cabinets.upsert({ ...cfg, id: 'mem', calendar: { provider: 'memory' } }, false);
    const memory = new MemoryCalendar();
    const router = new CalendarRouter(cabinets, memory, new GoogleCalendar(cabinets, api));

    await router.book({ ...patient('M', '+2161', T(10)), cabinet_id: 'mem' });
    await router.book(patient('G', '+2162', T(10)));
    expect((await memory.list('mem', T(0), T(23))).map((b) => b.patient_name)).toEqual(['M']);
    expect(api.live().map((e) => e.extendedProperties!.private!.patient_name)).toEqual(['G']);
  });
});

describe('BookingService over GoogleCalendar', () => {
  it('offers, books, refuses a double booking with alternatives, and shifts the day', async () => {
    const { cal, cabinets, api } = make();
    const svc = new BookingService(cal, cabinets);
    api.seed(timed(T(9), 60)); // the secretary already filled 09:00–10:00

    const av = await svc.get_availability('demo', 'cleaning');
    expect(av.ok).toBe(true);
    expect(av.offers![0].start).toBe(T(10).toISO()); // first free after the secretary's block

    const a = await svc.book('demo', { patient_phone: '+2161', patient_name: 'A', type_id: 'cleaning', start: av.offers![0].start! });
    const b = await svc.book('demo', { patient_phone: '+2162', patient_name: 'B', type_id: 'cleaning', start: av.offers![0].start! });
    expect(a.ok).toBe(true);
    expect(b).toMatchObject({ ok: false, error: 'slot_taken' });
    expect(b.alternatives!.length).toBeGreaterThan(0);

    await svc.book('demo', { patient_phone: '+2163', patient_name: 'C', type_id: 'cleaning', start: T(11).toISO()! });
    const shifted = await svc.shift_day('demo', 30);
    expect(shifted.moved.map((m) => DateTime.fromISO(m.start!).setZone(ZONE).toFormat('HH:mm'))).toEqual(['10:30', '11:30']);
    expect(api.live().filter((e) => e.extendedProperties?.private?.kind === 'booking').map((e) => evStart(e).setZone(ZONE).toFormat('HH:mm')).sort()).toEqual([
      '10:30',
      '11:30',
    ]);
  });
});
