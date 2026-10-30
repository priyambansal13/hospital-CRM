import { z } from 'zod';

/** Vital signs, as recorded by the nurse (triage) or the doctor (visit note). */
export const Vitals = z.object({
  bp: z.string().regex(/^\d{2,3}\/\d{2,3}$/, 'blood pressure like 120/80').optional(),
  pulse: z.number().int().min(20).max(250).optional(), tempC: z.number().min(30).max(45).optional(),
  weightKg: z.number().min(0.3).max(400).optional(), heightCm: z.number().min(20).max(260).optional(),
  spo2: z.number().int().min(50).max(100).optional(), respRate: z.number().int().min(4).max(80).optional(),
}).strict();
