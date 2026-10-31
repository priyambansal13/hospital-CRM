import { parseSummaryTurn, type Summary } from '../copilot/summary.js';

/**
 * The dev provider's pre-visit summary: built straight from the facts, every line citing them, so the copilot works
 * (and its citation check, screens and tests run) without calling Google. Gemini writes the real one.
 */
export function devSummary(turn: string): Summary {
  const parsed = parseSummaryTurn(turn);
  if (!parsed) return { sections: [] };
  const f = parsed.facts;
  const refs = (p: string) => Object.keys(f).filter((r) => r.startsWith(p)).sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
  const sections: Summary['sections'] = [];
  const push = (title: string, lines: { text: string; refs: string[] }[]) => { if (lines.length) sections.push({ title, lines: lines.slice(0, 5) }); };

  push('Today', refs('T').map((r) => {
    const t = f[r];
    const v = t.vitals ? Object.entries(t.vitals).map(([k, x]) => `${k} ${x}`).join(', ') : '';
    return { text: `${t.complaint ?? 'No complaint recorded'} (triage ${String(t.priority).toLowerCase()})${v ? `; ${v}` : ''}`, refs: [r] };
  }));

  const problems = new Map<string, string[]>();
  for (const r of refs('E')) for (const d of (f[r].diagnoses ?? []) as string[]) problems.set(d.replace(/, primary$/, ''), [...(problems.get(d.replace(/, primary$/, '')) ?? []), r]);
  push('Active problems', [...problems].map(([d, rs]) => ({ text: `${d}, last ${f[rs[0]].date}`, refs: rs })));

  push('Current medicines', refs('P').filter((r) => f[r].stillCurrent).flatMap((r) => (f[r].medicines as string[]).map((m) => ({ text: `${m} (until ${f[r].coversUntil})`, refs: [r] }))));

  push('Allergies', refs('A').map((r) => ({ text: `${f[r].substance}: ${String(f[r].severity).toLowerCase()}${f[r].reaction ? `, ${f[r].reaction}` : ''}`, refs: [r] })));

  const labs = refs('L');
  push('Recent abnormal results', labs.flatMap((r, i) => ((f[r].values ?? []) as any[]).filter((v) => v.flag !== 'NORMAL').map((v) => {
    const older = labs.slice(i + 1).map((o) => ({ o, x: ((f[o].values ?? []) as any[]).find((y) => y.name === v.name) })).find((y) => y.x);
    const unit = v.unit ? ` ${v.unit}` : '';
    return {
      text: `${v.name} ${v.value}${unit} (${String(v.flag).toLowerCase().replace('_', ' ')}${v.normalRange ? `, normal ${v.normalRange}` : ''}) on ${f[r].date}${older ? `, was ${older.x.value}${unit} on ${f[older.o].date}` : ''}`,
      refs: older ? [r, older.o] : [r],
    };
  })));

  const last = refs('P')[0];
  if (last && (f[last].advice || f[last].followUpOn)) push('Last visit plan', [{ text: [f[last].advice, f[last].followUpOn ? `follow-up on ${f[last].followUpOn}` : null].filter(Boolean).join('; '), refs: [last] }]);
  return { sections };
}
