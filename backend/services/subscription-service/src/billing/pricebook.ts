import type { Catalog } from '@mc/entitlements-sdk/catalog';
import { modulesDir } from '@mc/entitlements-sdk/catalog';
import type { Queryable } from '@mc/tenancy';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import type { PriceComponent } from './calculator.js';

const Component = z.object({
  model: z.enum(['FLAT', 'PER_SEAT', 'PER_BRANCH', 'TIERED']),
  unit: z.enum(['doctor', 'branch']).optional(),
  amount: z.number().min(0).optional(),
  included: z.number().int().min(0).default(0),
  tiers: z.array(z.object({ upTo: z.number().int().positive().nullable(), amount: z.number().min(0) })).optional(),
}).refine((c) => c.model === 'TIERED' ? !!c.tiers?.length && c.tiers.at(-1)!.upTo === null : c.amount != null, 'TIERED needs tiers ending in upTo: null; others an amount');

const PriceBookFile = z.object({
  priceBooks: z.array(z.object({
    code: z.string().regex(/^[A-Z0-9_]{3,30}$/),
    name: z.string(),
    currency: z.string().length(3),
    gstPercent: z.number().min(0).max(50),
    default: z.boolean().default(false),
    plans: z.record(z.string(), z.array(Component)).default({}),
    usage: z.record(z.string(), z.object({ amount: z.number().min(0) })).default({}),
    coupons: z.array(z.object({
      code: z.string().regex(/^[A-Z0-9_]{3,30}$/), description: z.string(),
      percentOff: z.number().positive().max(100).optional(), amountOff: z.number().positive().optional(),
      months: z.number().int().positive().optional(), maxRedemptions: z.number().int().positive().optional(), validUntil: z.string().optional(),
    }).refine((c) => !!c.percentOff !== !!c.amountOff, 'percentOff or amountOff')).default([]),
  })).min(1),
});

/** Load backend/modules/pricebook.yaml, check usage prices name METERED features, and write it to the database. */
export async function seedPriceBooks(c: Queryable, modules: Catalog, file = join(modulesDir(), 'pricebook.yaml')) {
  const books = PriceBookFile.parse(parseYaml(readFileSync(file, 'utf8'))).priceBooks;
  if (books.filter((b) => b.default).length !== 1) throw new Error('pricebook.yaml: exactly one price book must be the default');
  const metered = new Set([...modules.modules.values()].flatMap((m) => m.features.filter((f) => f.type === 'METERED').map((f) => f.key)));
  for (const b of books) {
    for (const k of Object.keys(b.usage)) if (!metered.has(k)) throw new Error(`pricebook ${b.code}: ${k} is not a METERED feature`);
    await c.query(`INSERT INTO price_books (code, name, currency, gst_percent, is_default) VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT (code) DO UPDATE SET name = $2, currency = $3, gst_percent = $4, is_default = $5, updated_at = now()`, [b.code, b.name, b.currency, b.gstPercent, b.default]);
    await c.query('DELETE FROM price_components WHERE price_book_code = $1', [b.code]);
    for (const [plan, comps] of Object.entries(b.plans)) {
      for (const x of comps) await c.query('INSERT INTO price_components (price_book_code, plan_code, model, unit, amount, included, tiers) VALUES ($1,$2,$3,$4,$5,$6,$7)', [b.code, plan, x.model, x.unit ?? null, x.amount ?? null, x.included, x.tiers ? JSON.stringify(x.tiers) : null]);
    }
    for (const [feature, u] of Object.entries(b.usage)) await c.query(`INSERT INTO price_components (price_book_code, feature_key, model, amount) VALUES ($1,$2,'USAGE',$3)`, [b.code, feature, u.amount]);
    for (const cp of b.coupons) {
      await c.query(`INSERT INTO coupons (code, description, percent_off, amount_off, months, max_redemptions, valid_until) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (code) DO NOTHING`,
        [cp.code, cp.description, cp.percentOff ?? null, cp.amountOff ?? null, cp.months ?? null, cp.maxRedemptions ?? null, cp.validUntil ?? null]);
    }
  }
}

export interface PriceBook { code: string; name: string; currency: string; gstPercent: number; plans: Map<string, PriceComponent[]>; usage: Map<string, number> }

export async function loadPriceBook(c: Queryable, code?: string | null): Promise<PriceBook> {
  const { rows: [b] } = await c.query(code ? 'SELECT * FROM price_books WHERE code = $1' : 'SELECT * FROM price_books WHERE is_default', code ? [code] : []);
  if (!b) throw new Error(`no price book ${code ?? '(default)'}`);
  const { rows } = await c.query('SELECT * FROM price_components WHERE price_book_code = $1 ORDER BY id', [b.code]);
  const plans = new Map<string, PriceComponent[]>();
  const usage = new Map<string, number>();
  for (const r of rows) {
    if (r.feature_key) usage.set(r.feature_key, Number(r.amount));
    else plans.set(r.plan_code, [...(plans.get(r.plan_code) ?? []), { model: r.model, unit: r.unit ?? undefined, amount: r.amount == null ? undefined : Number(r.amount), included: r.included, tiers: r.tiers ?? undefined }]);
  }
  return { code: b.code, name: b.name, currency: b.currency, gstPercent: Number(b.gst_percent), plans, usage };
}
