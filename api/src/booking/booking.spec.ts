import { DateTime, Settings } from 'luxon';
import { BookingService } from './booking.service';
import { MemoryCalendar } from '../calendar/memory.calendar';
import { CabinetService } from '../config/cabinet.service';
import { CabinetConfig } from '../config/cabinet.schema';
import { freeSlots } from './slots';
import demo from '../../cabinets/demo.json';

const cfg = CabinetConfig.parse(demo);

// Freeze "now" to a Monday 09:00 Tunis time so tests are deterministic.
const NOW = DateTime.fromISO('2026-10-26T09:00:00', { zone: 'Africa/Tunis' });
Settings.now = () => NOW.toMillis();

function makeService() {
  process.env.CABINETS_DIR = '/nonexistent-' + Math.random(); // avoid disk
  const cabinets = new CabinetService();
  cabinets.upsert(cfg, false);
  const cal = new MemoryCalendar();
  return { svc: new BookingService(cal, cabinets), cal, cabinets };
}

describe('freeSlots', () => {
  const type = cfg.types.find((t) => t.id === 'cleaning')!; // 30 min

  it('respects opening hours, lunch and the step', () => {
    const slots = freeSlots(cfg, type, [], NOW, NOW.plus({ days: 1 }).startOf('day'), NOW);
    const starts = slots.map((s) => s.start.toFormat('HH:mm'));
    expect(starts[0]).toBe('09:00'); // not before now
    expect(starts).toContain('12:00'); // 12:00-12:30 fits before 12:30 close
    expect(starts).not.toContain('12:15'); // would end 12:45, past lunch
    expect(starts).toContain('14:00');
    expect(starts).not.toContain('17:15'); // last_booking 17:00
  });

  it('skips busy intervals', () => {
    const busy = [{ start: NOW.set({ hour: 10 }).toISO()!, end: NOW.set({ hour: 11 }).toISO()! }];
    const slots = freeSlots(cfg, type, busy, NOW, NOW.endOf('day'), NOW);
    const starts = slots.map((s) => s.start.toFormat('HH:mm'));
    expect(starts).not.toContain('10:00');
    expect(starts).not.toContain('10:30');
    expect(starts).not.toContain('09:45'); // 09:45-10:15 overlaps
    expect(starts).toContain('11:00');
  });

  it('returns nothing on a closed day (Sunday)', () => {
    const sunday = NOW.plus({ days: 6 }).startOf('day');
    const slots = freeSlots(cfg, type, [], sunday, sunday.endOf('day'), NOW);
    expect(slots).toHaveLength(0);
  });
});

describe('BookingService', () => {
  it('offers slots and books one, with Arabic labels', async () => {
    const { svc } = makeService();
    const av = await svc.get_availability('demo', 'cleaning');
    expect(av.ok).toBe(true);
    expect(av.offers!.length).toBe(3);
    expect(av.offers![0].label_ar).toMatch(/^الاثنين \d{2}:\d{2}$/);

    const r = await svc.book('demo', { patient_phone: '+21620123456', patient_name: 'Mme Trabelsi', type_id: 'cleaning', start: av.offers![0].start! });
    expect(r.ok).toBe(true);
    expect(r.booking!.patient_name).toBe('Mme Trabelsi');
  });

  it('refuses a double booking and returns alternatives', async () => {
    const { svc } = makeService();
    const av = await svc.get_availability('demo', 'cleaning');
    const slot = av.offers![0].start!;
    const a = await svc.book('demo', { patient_phone: '+2161', patient_name: 'A', type_id: 'cleaning', start: slot });
    const b = await svc.book('demo', { patient_phone: '+2162', patient_name: 'B', type_id: 'cleaning', start: slot });
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(false);
    expect(b.error).toBe('slot_taken');
    expect(b.alternatives!.length).toBeGreaterThan(0);
    expect(b.alternatives![0].start).not.toBe(slot);
  });

  it('survives a concurrent race for the same slot', async () => {
    const { svc } = makeService();
    const av = await svc.get_availability('demo', 'consultation');
    const slot = av.offers![0].start!;
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) => svc.book('demo', { patient_phone: `+216${i}`, patient_name: `P${i}`, type_id: 'consultation', start: slot })),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
  });

  it('refuses a booking outside opening hours', async () => {
    const { svc } = makeService();
    const r = await svc.book('demo', { patient_phone: '+2161', patient_name: 'A', type_id: 'cleaning', start: NOW.set({ hour: 13 }).toISO()! });
    expect(r.ok).toBe(false);
  });

  it('refuses when the agent is off', async () => {
    const { svc, cabinets } = makeService();
    cabinets.upsert({ ...cfg, mode: 'off' }, false);
    const r = await svc.book('demo', { patient_phone: '+2161', patient_name: 'A', type_id: 'cleaning', start: NOW.set({ hour: 10 }).toISO()! });
    expect(r).toEqual({ ok: false, error: 'agent_off' });
  });

  it('reschedules into a free slot and finds bookings by phone', async () => {
    const { svc } = makeService();
    const first = await svc.book('demo', { patient_phone: '+2161', patient_name: 'A', type_id: 'cleaning', start: NOW.set({ hour: 10 }).toISO()! });
    const mine = await svc.find_my_bookings('demo', '+2161');
    expect(mine.bookings).toHaveLength(1);
    const moved = await svc.reschedule('demo', first.booking!.id, NOW.set({ hour: 15 }).toISO()!);
    expect(moved.ok).toBe(true);
    expect(moved.booking!.label_ar).toBe('الاثنين 15:00');
  });

  it('shift_day moves remaining bookings and keeps order', async () => {
    const { svc } = makeService();
    await svc.book('demo', { patient_phone: '+2161', patient_name: 'A', type_id: 'consultation', start: NOW.set({ hour: 10, minute: 0 }).toISO()! });
    await svc.book('demo', { patient_phone: '+2162', patient_name: 'B', type_id: 'consultation', start: NOW.set({ hour: 10, minute: 15 }).toISO()! });
    const r = await svc.shift_day('demo', 30);
    expect(r.moved.map((b) => b.label_ar)).toEqual(['الاثنين 10:30', 'الاثنين 10:45']);
  });

  it('block_slots reports affected bookings', async () => {
    const { svc } = makeService();
    await svc.book('demo', { patient_phone: '+2161', patient_name: 'A', type_id: 'consultation', start: NOW.set({ hour: 10 }).toISO()! });
    const r = await svc.block_slots('demo', NOW.startOf('day').toISO()!, NOW.endOf('day').toISO()!, 'closed');
    expect(r.affected).toHaveLength(1);
    const av = await svc.get_availability('demo', 'consultation', NOW.toISO()!, 1);
    // Nothing today; whatever is free is tomorrow.
    expect(av.offers!.every((o) => !o.start!.startsWith(NOW.toISODate()!))).toBe(true);
  });
});
