import { Injectable } from '@nestjs/common';
import { slugify } from '@mc/nest-common';
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
  SELECT d.id, d.slug, d.user_id, d.email, d.full_name, d.gender, d.registration_no, d.qualifications, d.experience_years,
         d.languages, d.bio, d.photo_url, d.consult_modes, d.status, d.version, d.created_at,
         coalesce((SELECT json_agg(json_build_object('code', s.code, 'name', s.name, 'primary', ds.is_primary) ORDER BY ds.is_primary DESC, s.name)
                   FROM doctor_specialties ds JOIN specialties s ON s.id = ds.specialty_id WHERE ds.doctor_id = d.id), '[]') AS specialties,
         coalesce((SELECT json_agg(json_build_object('id', db.branch_id, 'name', b.name, 'fee', db.consultation_fee, 'followupFee', db.followup_fee) ORDER BY b.name)
                   FROM doctor_branches db LEFT JOIN branches b ON b.id = db.branch_id WHERE db.doctor_id = d.id), '[]') AS branches
  FROM doctors d`;

export interface DoctorDto {
  id: string; slug: string | null; userId: string | null; email: string; name: string; gender: string | null; registrationNo: string;
  qualifications: string[]; experienceYears: number | null; languages: string[]; bio: string | null; photoUrl: string | null;
  consultModes: string[]; status: string; version: number;
  specialties: { code: string; name: string; primary: boolean }[];
  branches: { id: string; name: string | null; fee: number; followupFee: number | null }[];
}

export const toDoctor = (r: any): DoctorDto => ({
  id: r.id, slug: r.slug, userId: r.user_id, email: r.email, name: r.full_name, gender: r.gender, registrationNo: r.registration_no,
  qualifications: r.qualifications, experienceYears: r.experience_years, languages: r.languages, bio: r.bio, photoUrl: r.photo_url,
  consultModes: r.consult_modes, status: r.status, version: r.version, specialties: r.specialties,
  branches: r.branches.map((b: any) => ({ ...b, fee: Number(b.fee), followupFee: b.followupFee == null ? null : Number(b.followupFee) })),
});

/** What patients see: no email, registration number or internal ids. */
export const toPublicDoctor = (d: DoctorDto) => ({
  id: d.id, slug: d.slug, name: d.name, gender: d.gender, qualifications: d.qualifications, experienceYears: d.experienceYears,
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

  /** A doctor by their web address: the current slug, or one they had before (the caller redirects to the current one). */
  async findBySlug(slug: string): Promise<DoctorDto | undefined> {
    const { rows } = await (await this.db.current()).query(
      `${DOCTOR_SELECT} WHERE d.slug = $1 OR d.id = (SELECT doctor_id FROM retired_slugs WHERE slug = $1) ORDER BY (d.slug = $1) DESC LIMIT 1`, [slug]);
    return rows[0] && toDoctor(rows[0]);
  }

  /**
   * Give a doctor the web address their name and main specialty call for ("ananya-sharma-cardiology", "-2" when taken).
   * Nothing changes while the current slug still fits; otherwise the old one is retired so old links keep working.
   * Call inside the transaction that changed the doctor.
   */
  async assignSlug(c: Queryable, id: string) {
    await c.query(`SELECT pg_advisory_xact_lock(hashtext('doctor-slug'))`);
    const { rows: [d] } = await c.query(
      `SELECT d.slug, d.full_name, (SELECT s.name FROM doctor_specialties ds JOIN specialties s ON s.id = ds.specialty_id
         WHERE ds.doctor_id = d.id ORDER BY ds.is_primary DESC, s.name LIMIT 1) AS specialty FROM doctors d WHERE d.id = $1`, [id]);
    if (!d) return;
    const base = slugify(`${d.full_name} ${d.specialty ?? ''}`).slice(0, 76).replace(/-+$/, '') || 'doctor';
    if (d.slug && (d.slug === base || new RegExp(`^${base}-\\d+$`).test(d.slug))) return;
    const { rows } = await c.query(
      `SELECT slug FROM doctors WHERE (slug = $1 OR slug LIKE $1 || '-%') AND id <> $2
       UNION SELECT slug FROM retired_slugs WHERE (slug = $1 OR slug LIKE $1 || '-%') AND doctor_id <> $2`, [base, id]);
    const taken = new Set(rows.map((r) => r.slug as string));
    let slug = base;
    for (let n = 2; taken.has(slug); n++) slug = `${base}-${n}`;
    await c.query('DELETE FROM retired_slugs WHERE slug = $1', [slug]); // taking back an address this doctor had before
    if (d.slug) await c.query('INSERT INTO retired_slugs (slug, doctor_id) VALUES ($1,$2) ON CONFLICT (slug) DO UPDATE SET doctor_id = $2, retired_at = now()', [d.slug, id]);
    await c.query('UPDATE doctors SET slug = $2 WHERE id = $1', [id, slug]);
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
