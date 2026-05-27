/** Date-range presets used by the Reports UI. */
export type RangePreset = 'today' | 'yesterday' | '7d' | '30d' | 'thisMonth' | 'custom';

export interface DateRange {
  sinceIso: string;
  untilIso: string;
}

export function rangeForPreset(preset: RangePreset): DateRange {
  const now = new Date();
  const start = new Date(now);
  const end = new Date(now);
  switch (preset) {
    case 'today':
      start.setHours(0, 0, 0, 0);
      end.setDate(end.getDate() + 1);
      end.setHours(0, 0, 0, 0);
      break;
    case 'yesterday':
      start.setDate(start.getDate() - 1);
      start.setHours(0, 0, 0, 0);
      end.setHours(0, 0, 0, 0);
      break;
    case '7d':
      start.setDate(start.getDate() - 6);
      start.setHours(0, 0, 0, 0);
      end.setDate(end.getDate() + 1);
      end.setHours(0, 0, 0, 0);
      break;
    case '30d':
      start.setDate(start.getDate() - 29);
      start.setHours(0, 0, 0, 0);
      end.setDate(end.getDate() + 1);
      end.setHours(0, 0, 0, 0);
      break;
    case 'thisMonth':
      start.setDate(1);
      start.setHours(0, 0, 0, 0);
      end.setMonth(end.getMonth() + 1, 1);
      end.setHours(0, 0, 0, 0);
      break;
    case 'custom':
      // Caller is responsible for setting sinceIso/untilIso explicitly.
      break;
  }
  return { sinceIso: start.toISOString(), untilIso: end.toISOString() };
}

export function fmtDay(iso: string): string {
  return iso.slice(0, 10);
}

export function fmtDateInput(iso: string): string {
  return iso.slice(0, 10);
}

export function dateInputToIso(date: string, endOfDay: boolean): string {
  const d = new Date(date + 'T00:00:00');
  if (endOfDay) d.setDate(d.getDate() + 1);
  return d.toISOString();
}
