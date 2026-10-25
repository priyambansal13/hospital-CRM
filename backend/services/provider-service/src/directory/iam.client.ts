import { Injectable } from '@nestjs/common';
import { DomainError } from '@mc/nest-common';

/** iam-service internal API: create (or reuse) the staff login for a new doctor. */
@Injectable()
export class IamClient {
  private readonly base = process.env.SVC_URL_IAM ?? 'http://localhost:4402';

  async onboardDoctor(tenantId: string, input: { email: string; name: string; invitedBy: string }): Promise<{ userId: string }> {
    const res = await fetch(`${this.base}/internal/tenants/${tenantId}/staff`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-internal-token': process.env.INTERNAL_API_TOKEN ?? '' },
      body: JSON.stringify({ ...input, roles: ['DOCTOR'] }),
    });
    if (!res.ok) throw new DomainError(502, 'IAM_UNAVAILABLE', `could not create the doctor's login (${res.status})`);
    return (await res.json()) as { userId: string };
  }
}
