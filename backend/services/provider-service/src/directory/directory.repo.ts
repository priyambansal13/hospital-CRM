import { Injectable } from '@nestjs/common';
import { type Queryable, TenantDbRouter } from '@mc/tenancy';

export interface DoctorFilters {
  q?: string;
  specialty?: string;     // specialty code
  branchId?: string;
  language?: string;
  gender?: string;
  mode?: string;
  status?: 'ACTIVE' | 'ANY';
  cursor?: string;        // "<name>|<id>" of the last row
  limit: number;
}

const DOCTOR_SELECT = `
  SELECT d.id, d.user_id, d.email, d.full_name, d.gender, d.registration_no, d.qualifications, d.experience_years,
         d.languages, d.bio, d.photo_url, d.consult_modes, d.status, d.version, d.created_at,
         coalesce((SELECT json_agg(json_build_object('code', s.code, 'name', s.name, 'primary', ds.is_primary) ORDER BY ds.is_primary DESC, s.name)
                   FROM doctor_specialties ds JOIN specialties s ON s.id = ds.specialty_id WHERE ds.doctor_id = d.id), '[]') AS specialties,
         coalesce((SELECT json_agg(json_build_object('id', db.branch_id, 'name', b.name, 'fee', db.consultation_fee, 'followupFee', db.followup_fee) ORDER BY b.name)
                   FROM doctor_branches db LEFT JOIN branches b ON b.id = db.branch_id WHERE db.doctor_id = d.id), '[]') AS branches
  FROM doctors d`;

export interface DoctorDto {
  id: string; userId: string | null; email: string; name: string; gender: string | null; registrationNo: string;
  qualifications: string[]; experienceYears: number | null; languages: string[]; bio: string | null; photoUrl: string | null;
  consultModes: string[]; status: string; version: number;
  specialties: { code: string; name: string; primary: boolean }[];
  branches: { id: string; name: string | null; fee: number; followupFee: number | null }[];
}

export const toDoctor = (r: any): DoctorDto => ({
  id: r.id, userId: r.user_id, email: r.email, name: r.full_name, gender: r.gender, registrationNo: r.registration_no,
  qualifications: r.qualifications, experienceYears: r.experience_years, languages: r.languages, bio: r.bio, photoUrl: r.photo_url,
  consultModes: r.consult_modes, status: r.status, version: r.version, specialties: r.specialties,
  branches: r.branches.map((b: any) => ({ ...b, fee: Number(b.fee), followupFee: b.followupFee == null ? null : Number(b.followupFee) })),
});

/** What patients see: no email, registration number or internal ids. */
export const toPublicDoctor = (d: DoctorDto) => ({
  id: d.id, name: d.name, gender: d.gender, qualifications: d.qualifications, experienceYears: d.experienceYears,
  languages: d.languages, bio: d.bio, photoUrl: d.photoUrl, consultModes: d.consultModes, specialties: d.specialties,
  branches: d.branches.map((b) => ({ id: b.id, name: b.name, fee: b.fee })),
});

@Injectable()
export class DirectoryRepo {
  constructor(private readonly db: TenantDbRouter) {}

  async findDoctor(id: string, c?: Queryable): Promise<DoctorDto | undefined> {
    const { rows } = await (c ?? (await this.db.current())).query(`${DOCTOR_SELECT} WHERE d.id = $1`, [id]);
    return rows[0] && toDoctor(rows[0]);
  }

  /** Filtered, keyset-paginated doctor list (sorted by name). */
  async listDoctors(f: DoctorFilters): Promise<{ items: DoctorDto[]; nextCursor: string | null }> {
    const where: string[] = [];
    const params: unknown[] = [];
    const p = (v: unknown) => { params.push(v); return `$${params.length}`; };
    if (f.status !== 'ANY') where.push(`d.status = 'ACTIVE'`);
    if (f.q) {
      const q = p(f.q);
      where.push(`(d.full_name ILIKE '%' || ${q} || '%' OR public.similarity(d.full_name, ${q}) > 0.3
        OR EXISTS (SELECT 1 FROM doctor_specialties ds JOIN specialties s ON s.id = ds.specialty_id WHERE ds.doctor_id = d.id AND s.name ILIKE '%' || ${q} || '%'))`);
    }
    if (f.specialty) where.push(`EXISTS (SELECT 1 FROM doctor_specialties ds JOIN specialties s ON s.id = ds.specialty_id WHERE ds.doctor_id = d.id AND s.code = ${p(f.specialty)})`);
    if (f.branchId) where.push(`EXISTS (SELECT 1 FROM doctor_branches db WHERE db.doctor_id = d.id AND db.branch_id = ${p(f.branchId)})`);
    if (f.language) where.push(`${p(f.language)} = ANY (d.languages)`);
    if (f.gender) where.push(`d.gender = ${p(f.gender)}`);
    if (f.mode) where.push(`${p(f.mode)} = ANY (d.consult_modes)`);
    if (f.cursor) {
      const i = f.cursor.lastIndexOf('|');
      where.push(`(d.full_name, d.id) > (${p(f.cursor.slice(0, i))}, ${p(f.cursor.slice(i + 1))}::uuid)`);
    }
    const sql = `${DOCTOR_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY d.full_name, d.id LIMIT ${p(f.limit + 1)}`;
    const { rows } = await this.db.query(sql, params);
    const items = rows.slice(0, f.limit).map(toDoctor);
    const last = items.at(-1);
    return { items, nextCursor: rows.length > f.limit && last ? `${last.name}|${last.id}` : null };
  }
}
