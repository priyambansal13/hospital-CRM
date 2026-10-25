import { Injectable } from '@nestjs/common';
import { DomainError, notFound } from '@mc/nest-common';

export interface PatientAccess { id: string; mrn: string; fullName: string; accountPersonId: string }

/** patient-service internal API: may this person act for this patient? */
@Injectable()
export class PatientsClient {
  private readonly base = process.env.SVC_URL_PATIENT ?? 'http://localhost:4406';

  async access(tenantId: string, patientId: string, personId: string): Promise<PatientAccess> {
    const res = await fetch(`${this.base}/internal/tenants/${tenantId}/patients/${patientId}/access/${personId}`, { headers: { 'x-internal-token': process.env.INTERNAL_API_TOKEN ?? '' } });
    if (res.status === 404) throw notFound('patient');
    if (!res.ok) throw new DomainError(502, 'PATIENTS_UNAVAILABLE', `patient-service ${res.status}`);
    return (await res.json()) as PatientAccess;
  }

  /** Any patient of this hospital (front desk: the caller has checked the staff member's permission). */
  async get(tenantId: string, patientId: string): Promise<PatientAccess> {
    const res = await fetch(`${this.base}/internal/tenants/${tenantId}/patients/${patientId}`, { headers: { 'x-internal-token': process.env.INTERNAL_API_TOKEN ?? '' } });
    if (res.status === 404) throw notFound('patient');
    if (!res.ok) throw new DomainError(502, 'PATIENTS_UNAVAILABLE', `patient-service ${res.status}`);
    return (await res.json()) as PatientAccess;
  }
}
