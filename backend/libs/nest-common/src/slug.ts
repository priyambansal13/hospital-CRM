/**
 * A readable web address part from a name: "Dr. Ananya Sharma Obstetrics & Gynecology" → "ananya-sharma-obstetrics-and-gynecology".
 * Lower case ASCII letters, digits and single hyphens; accents are dropped; at most 80 characters, cut at a hyphen.
 * Provider's migration 0003 backfills doctors with the same rules in SQL: keep the two in step.
 */
export function slugify(name: string): string {
  const s = name
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/^\s*dr\.?\s+/, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (s.length <= 80) return s;
  const cut = s.slice(0, 80);
  return cut.includes('-') ? cut.slice(0, cut.lastIndexOf('-')) : cut;
}
