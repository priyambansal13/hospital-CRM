import { Controller, Get, Inject, Param, Query } from '@nestjs/common';
import { Internal, notFound, PLACEMENTS } from '@mc/nest-common';
import { type PlacementSource, TenantContext, TenantDbRouter } from '@mc/tenancy';
import { z } from 'zod';

const Codes = z.object({ codes: z.string().regex(/^[A-Z]\d{2}(,[A-Z]\d{2}){0,19}$/) });

/**
 * ai-assistant-service (Phase 29, care gaps): patients with a signed diagnosis in these ICD-10 categories. Only who
 * (ids and the name for the greeting), never notes; the codes asked for are the hospital's fixed care-gap rules.
 */
@Controller('internal/tenants/:tenantId/care-gaps')
export class InternalCareGapsController {
  constructor(private readonly db: TenantDbRouter, @Inject(PLACEMENTS) private readonly placements: PlacementSource) {}

  @Get('candidates')
  @Internal()
  async candidates(@Param('tenantId') t: string, @Query() q: unknown) {
    if (!z.uuid().safeParse(t).success) throw notFound('tenant');
    const { codes } = Codes.parse(q);
    return TenantContext.run(await this.placements.get(t), async () => {
      const { rows } = await this.db.query(
        `SELECT p.id, p.account_person_id, p.name, max(e.signed_at) diagnosed_at
         FROM diagnoses d JOIN encounters e ON e.id = d.encounter_id JOIN patients p ON p.id = e.patient_id
         WHERE e.status IN ('SIGNED','AMENDED') AND d.icd10_code LIKE ANY($1) AND p.account_person_id IS NOT NULL
         GROUP BY p.id, p.account_person_id, p.name ORDER BY p.id LIMIT 5000`, [codes.split(',').map((c) => `${c}%`)]);
      return rows.map((r) => ({ patientId: r.id, accountPersonId: r.account_person_id, name: r.name, diagnosedAt: r.diagnosed_at }));
    });
  }
}
