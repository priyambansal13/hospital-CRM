import { Chip } from '@mc/ui';
import { fmtDay, fmtTime, type SlotDays } from './booking';

/** Date chips + time buttons. Each time is a link (works without JS); hrefFor decides where a chosen slot goes. */
export function SlotPicker({ data, selected, dateHref, slotHref }: { data: SlotDays; selected?: string; dateHref: (date: string) => string; slotHref: (slotId: string) => string }) {
  if (!data.days.length) return <p className="mc-muted">No online appointments are open in the next 2 weeks.</p>;
  const day = data.days.find((d) => d.date === selected) ?? data.days[0];
  const byBranch = new Map<string, typeof day.slots>();
  for (const s of day.slots) byBranch.set(s.branch.name, [...(byBranch.get(s.branch.name) ?? []), s]);
  return (
    <div className="mc-slot-picker">
      <nav className="mc-chips" aria-label="Dates">
        {data.days.map((d) => <Chip key={d.date} href={dateHref(d.date)} active={d.date === day.date}>{fmtDay(d.date)} · {d.slots.length}</Chip>)}
      </nav>
      {[...byBranch.entries()].map(([branch, slots]) => (
        <section key={branch} aria-label={`${fmtDay(day.date, { weekday: 'long', day: 'numeric', month: 'long' })} at ${branch}`}>
          <h3 className="mc-meta" style={{ margin: '16px 0 8px' }}>{fmtDay(day.date, { weekday: 'long', day: 'numeric', month: 'long' })} · {branch}{slots[0].fee != null ? ` · ₹${slots[0].fee}` : ''}</h3>
          <div className="mc-times">
            {slots.map((s) => <a key={s.slotId} className="mc-time" href={slotHref(s.slotId)}>{fmtTime(s.localTime)}{s.mode === 'VIDEO' ? ' · Video' : ''}</a>)}
          </div>
        </section>
      ))}
    </div>
  );
}
