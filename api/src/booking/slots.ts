import { DateTime, Interval } from 'luxon';
import { CabinetConfig, AppointmentType } from '../config/cabinet.schema';
import { BusyBlock } from '../calendar/calendar.port';

export interface Slot {
  start: DateTime;
  end: DateTime;
}

/**
 * Pure function: opening hours + busy intervals + appointment duration → free slots.
 * No I/O, so it is unit-testable and the same code runs in the agent and in tests.
 */
export function freeSlots(
  cfg: CabinetConfig,
  type: AppointmentType,
  busy: BusyBlock[],
  from: DateTime,
  to: DateTime,
  now: DateTime,
): Slot[] {
  const zone = cfg.timezone;
  const step = cfg.slot_step_minutes;
  const busyIv = busy.map((b) => Interval.fromDateTimes(DateTime.fromISO(b.start).setZone(zone), DateTime.fromISO(b.end).setZone(zone)));
  const out: Slot[] = [];

  let day = from.setZone(zone).startOf('day');
  const endDay = to.setZone(zone).startOf('day');
  while (day <= endDay) {
    const ranges = cfg.hours[String(day.weekday)] ?? [];
    for (const r of ranges) {
      const [sh, sm] = r.start.split(':').map(Number);
      const [eh, em] = r.end.split(':').map(Number);
      const open = day.set({ hour: sh, minute: sm });
      let close = day.set({ hour: eh, minute: em });
      if (cfg.last_booking) {
        const [lh, lm] = cfg.last_booking.split(':').map(Number);
        const last = day.set({ hour: lh, minute: lm }).plus({ minutes: type.minutes });
        if (last < close) close = last;
      }
      for (let s = open; s.plus({ minutes: type.minutes }) <= close; s = s.plus({ minutes: step })) {
        const e = s.plus({ minutes: type.minutes });
        if (e <= now || s < from || e > to) continue;
        const iv = Interval.fromDateTimes(s, e);
        if (busyIv.some((b) => b.overlaps(iv))) continue;
        out.push({ start: s, end: e });
      }
    }
    day = day.plus({ days: 1 });
  }
  return out;
}

/** Pick a short, spread-out list to read to a caller: first N, favouring distinct days. */
export function pickOffers(slots: Slot[], n = 3): Slot[] {
  const byDay = new Map<string, Slot[]>();
  for (const s of slots) {
    const k = s.start.toISODate()!;
    if (!byDay.has(k)) byDay.set(k, []);
    byDay.get(k)!.push(s);
  }
  const out: Slot[] = [];
  // round-robin across days so the caller hears "today 10:30, tomorrow 9:00, Friday 14:00"
  const lists = [...byDay.values()];
  let i = 0;
  while (out.length < n && lists.some((l) => l.length)) {
    const l = lists[i % lists.length];
    if (l.length) out.push(l.shift()!);
    i++;
  }
  return out;
}

/** "الجمعة 10:00" style label the TTS can read. */
export function slotLabelAr(s: DateTime): string {
  const days = ['', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت', 'الأحد'];
  return `${days[s.weekday]} ${s.toFormat('HH:mm')}`;
}

export function slotLabelFr(s: DateTime): string {
  return s.setLocale('fr').toFormat("cccc d LLLL 'à' HH'h'mm");
}
