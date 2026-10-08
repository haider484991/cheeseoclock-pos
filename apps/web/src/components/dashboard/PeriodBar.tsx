import type { Period, PeriodKey } from '@/lib/dashboard/period';
import { CustomRange } from './CustomRange';
import { Chip, ChipRow } from './ui';

/**
 * The one filter row a page's figures follow (dataviz: date range first,
 * above everything it scopes). Links, so the page stays server-rendered and
 * the back button works; "Pick dates" opens two date boxes.
 */

const LABELS: Array<[PeriodKey, string]> = [
  ['today', 'Today'],
  ['yesterday', 'Yesterday'],
  ['this_week', 'This week'],
  ['last_week', 'Last week'],
  ['this_month', 'This month'],
  ['last_month', 'Last month'],
  ['last_30', 'Last 30 days'],
];

export function PeriodBar({ period, base, keep = '', today }: { period: Period; base: string; keep?: string; today: string }) {
  const join = (q: string) => `${base}?${q}${keep ? `&${keep}` : ''}`;
  return (
    <div className="mb-1">
      <ChipRow label="Period">
        {LABELS.map(([key, label]) => (
          <Chip key={key} href={join(`p=${key}`)} active={period.key === key}>
            {label}
          </Chip>
        ))}
        <CustomRange base={base} keep={keep} from={period.from} to={period.to} today={today} active={period.key === 'custom'} />
      </ChipRow>
    </div>
  );
}
