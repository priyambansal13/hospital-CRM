/**
 * Which branches each ":branch" permission covers (review B-1). A grant without a branch covers every branch, so one
 * such grant makes the permission hospital-wide; otherwise the permission covers the union of the grants' branches.
 * Only ":branch" permissions are narrowed: hospital-wide (":tenant") and personal (":own", ":treating") ones are not.
 */
export function scopesOf(grants: { grants_all: boolean; perms: string[]; branch_id?: string | null }[], active: Set<string>) {
  const wide = new Set<string>();
  const at = new Map<string, Set<string>>();
  for (const g of grants) {
    const perms = g.grants_all ? [...active].filter((p) => !p.endsWith(':own')) : g.perms;
    for (const p of perms) {
      if (!p.endsWith(':branch') || !active.has(p)) continue;
      if (!g.branch_id) wide.add(p);
      else at.set(p, (at.get(p) ?? new Set()).add(g.branch_id));
    }
  }
  const branchScopes: Record<string, string[]> = {};
  for (const [p, b] of at) if (!wide.has(p)) branchScopes[p] = [...b].sort();
  const anyWide = grants.some((g) => !g.branch_id);
  const branchIds = anyWide ? null : [...new Set(grants.map((g) => g.branch_id!))].sort();
  return { branchScopes, branchIds };
}
