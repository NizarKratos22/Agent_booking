import { z } from 'zod';

/**
 * Per-cabinet configuration. One file per cabinet in ./cabinets/<id>.json.
 * This is what the 30-minute install conversation with the secretary produces.
 */

export const TimeRange = z.object({
  start: z.string().regex(/^\d{2}:\d{2}$/), // "08:30"
  end: z.string().regex(/^\d{2}:\d{2}$/),
});

export const AppointmentType = z.object({
  id: z.string(), // "cleaning"
  label_ar: z.string(), // "تنظيف"
  label_fr: z.string(), // "Détartrage"
  minutes: z.number().int().positive(),
  /** Pricing policy per type: exact price, a range, or defer to the doctor. */
  price: z
    .discriminatedUnion('policy', [
      z.object({ policy: z.literal('exact'), tnd: z.number() }),
      z.object({ policy: z.literal('range'), min_tnd: z.number(), max_tnd: z.number() }),
      z.object({ policy: z.literal('defer') }),
    ])
    .default({ policy: 'defer' }),
});

export const CabinetConfig = z.object({
  id: z.string(),
  name: z.string(), // "Cabinet Dr. Ben Salem"
  doctor_name: z.string(),
  timezone: z.string().default('Africa/Tunis'),
  address_ar: z.string(),
  address_fr: z.string(),
  /** The number patients call (the cabinet forwards to it, or it is the cabinet line). Routes inbound calls to this config. */
  phone_line: z.string(),
  phone_secretary: z.string(), // transfer target
  phone_doctor: z.string(), // emergency fallback
  whatsapp_patient_from: z.string(), // the cabinet's WhatsApp Business number
  whatsapp_admin: z.array(z.string()), // numbers allowed to give admin instructions
  /** 1 = Monday ... 7 = Sunday (ISO). Missing day = closed. */
  hours: z.record(z.string().regex(/^[1-7]$/), z.array(TimeRange)),
  /** Last new-patient booking start time, e.g. "17:00". */
  last_booking: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  slot_step_minutes: z.number().int().positive().default(15),
  types: z.array(AppointmentType).min(1),
  faq: z.array(z.object({ q: z.string(), a_ar: z.string(), a_fr: z.string() })).default([]),
  /** on | off | learning (learning = take messages more, book less) */
  mode: z.enum(['on', 'off', 'learning']).default('learning'),
  calendar: z.discriminatedUnion('provider', [
    z.object({ provider: z.literal('memory') }),
    z.object({ provider: z.literal('google'), calendar_id: z.string() }),
  ]),
});

export type CabinetConfig = z.infer<typeof CabinetConfig>;
export type AppointmentType = z.infer<typeof AppointmentType>;
