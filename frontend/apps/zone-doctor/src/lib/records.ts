import 'server-only';

export interface Diagnosis { code: string | null; description: string; isPrimary?: boolean }
export interface RxItem { drugName: string; strength: string | null; form: string | null; dosage: string; durationDays: number | null; instructions: string | null }
export interface Prescription { id: string; prescriptionNo: string; issuedAt: string; followUpOn: string | null; advice: string | null; doctor: { name: string }; patient: { id: string; name: string; mrn: string; age: number | null; gender: string | null }; diagnoses: Diagnosis[]; items: RxItem[] }
export interface Encounter {
  id: string; appointmentId: string | null; status: 'OPEN' | 'SIGNED' | 'AMENDED'; startedAt: string; signedAt: string | null; version: number;
  patient: { id: string; name: string; mrn: string; age: number | null; gender: string | null };
  doctor: { id: string; name: string };
  vitals: { bp?: string; pulse?: number; tempC?: number; weightKg?: number; heightCm?: number; spo2?: number; respRate?: number };
  chiefComplaint: string | null; notes?: string | null; diagnoses: Diagnosis[]; prescriptions: Prescription[];
  amendments: { reason: string; changed: string[]; at: string; by: string | null }[];
  access?: { purpose: string; breakGlassUntil: string | null };
}
export interface Chart { patient: Encounter['patient'] & { dob: string | null }; access: { purpose: string; breakGlassUntil: string | null }; encounters: Encounter[] }

export const day = (iso: string) => new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' }).format(new Date(iso));
export const time = (iso: string) => new Intl.DateTimeFormat('en-IN', { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' }).format(new Date(iso));
export const vitalsLine = (v: Encounter['vitals']) => [v.bp && `BP ${v.bp}`, v.pulse && `pulse ${v.pulse}`, v.tempC && `${v.tempC} °C`, v.spo2 && `SpO₂ ${v.spo2}%`, v.weightKg && `${v.weightKg} kg`].filter(Boolean).join(' · ');
