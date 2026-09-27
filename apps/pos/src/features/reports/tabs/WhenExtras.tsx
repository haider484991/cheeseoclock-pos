/**
 * Reports → When, Phase 7 (costing spec 4.10): the weekday × hour heatmap
 * (an average day, closed days left out), the parts of the day, and notes on
 * days — Eid, rain, load-shedding, closed — which a manager or the owner adds
 * here (report.view; synced to the other till and kept in the history).
 */
import { useState } from 'react';
import { Button, cn } from '@cheeseoclock/ui';
import { formatCents } from '@cheeseoclock/pos-domain';
import {
  DAY_NOTE_TAGS,
  DAY_NOTE_TAG_LABEL,
  excludedFromForecastByDefault,
  type DayNoteInput,
  type DayNoteTag,
  type ReportDayNote,
  type ReportDayparts,
  type ReportHeatmap,
} from '@cheeseoclock/shared-types';
import { StickyNote, Trash2 } from 'lucide-react';
import { Heatmap } from '../charts';
import { DataTable, Panel } from '../reportUi';
import { fmtDay, WEEKDAYS } from '../dateRange';
import { hourLabel, percentOf } from '../reportFormat';
import { dayNoteText, daypartHoursText, dayOutsidePeriod } from '../ownerWeekFormat';
export { HEATMAP_MIN_DAYS, heatmapShown } from '../ownerWeekFormat';

const WEEKDAY_FULL = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'] as const;

/** Average orders in tenths as the owner reads them: "2.5". */
function tenths(t: number): string {
  return (t / 10).toFixed(t % 10 === 0 ? 0 : 1);
}

/** A square's figures, in words: "Fri 8 pm: Rs 4,000 and 2.5 orders on an average Friday (4 of them counted)". */
function heatCellText(heatmap: ReportHeatmap, c: ReportHeatmap['cells'][number]): string {
  return `${WEEKDAYS[c.weekday]} ${hourLabel(c.hour)}: ${formatCents(c.avgNetSalesCents)} and ${tenths(c.avgOrdersTenths)} ${c.avgOrdersTenths === 10 ? 'order' : 'orders'} on an average ${WEEKDAY_FULL[c.weekday]} (${heatmap.dayCounts[c.weekday] ?? 0} of them counted)`;
}

export function HeatmapPanel({ heatmap }: { heatmap: ReportHeatmap }) {
  const [mode, setMode] = useState<'sales' | 'orders'>('sales');
  // A tap on a square reads its figures out below the chart (a touch screen has no hover).
  const [picked, setPicked] = useState<number | null>(null);
  if (heatmap.hours.length === 0) return null;
  const busiest = heatmap.cells.reduce<(typeof heatmap.cells)[number] | null>(
    (m, c) => (!m || c.avgNetSalesCents > m.avgNetSalesCents ? c : m),
    null,
  );
  const pickedCell = picked === null ? undefined : heatmap.cells.find((c) => c.weekday * 24 + c.hour === picked);
  return (
    <Panel
      title="An average day, by weekday and hour"
      className="xl:col-span-2"
      note={
        <>
          {busiest && busiest.avgNetSalesCents > 0
            ? `Busiest: ${WEEKDAY_FULL[busiest.weekday]} ${hourLabel(busiest.hour)}, about ${formatCents(busiest.avgNetSalesCents)} on an average ${WEEKDAY_FULL[busiest.weekday]}. `
            : ''}
          {heatmap.closedDays > 0
            ? `${heatmap.closedDays} ${heatmap.closedDays === 1 ? 'day' : 'days'} marked closed ${heatmap.closedDays === 1 ? 'is' : 'are'} left out. `
            : ''}
          Today is left out until it is over; so are days still to come, and days before this till&apos;s first order.
        </>
      }
    >
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex gap-2" role="group" aria-label="Show">
          {(['sales', 'orders'] as const).map((m) => (
            <button
              key={m}
              type="button"
              aria-pressed={mode === m}
              onClick={() => setMode(m)}
              className={cn(
                'h-9 rounded-lg px-3 text-sm font-semibold',
                mode === m ? 'bg-amber-100 text-amber-900 dark:bg-amber-900/50 dark:text-amber-100' : 'bg-stone-100 text-stone-600 dark:bg-stone-800 dark:text-stone-300',
              )}
            >
              {m === 'sales' ? 'Sales' : 'Orders'}
            </button>
          ))}
        </div>
        <HeatLegend />
      </div>
      <Heatmap
        ariaLabel={mode === 'sales' ? 'Average sales by weekday and hour' : 'Average orders by weekday and hour'}
        hours={heatmap.hours}
        weekdays={WEEKDAYS}
        hourLabel={hourLabel}
        picked={picked}
        onPick={(key) => setPicked((p) => (p === key ? null : key))}
        cells={heatmap.cells.map((c) => ({
          weekday: c.weekday,
          hour: c.hour,
          value: mode === 'sales' ? c.avgNetSalesCents : c.avgOrdersTenths,
          title: heatCellText(heatmap, c),
        }))}
      />
      <p className="mt-2 min-h-5 text-sm text-stone-600 dark:text-stone-300" aria-live="polite">
        {pickedCell ? heatCellText(heatmap, pickedCell) : 'Tap a square to see its figures.'}
      </p>
    </Panel>
  );
}

/** Lighter is quieter, darker is busier. */
function HeatLegend() {
  return (
    <div className="flex items-center gap-2 text-xs text-stone-500" aria-hidden>
      Quiet
      <span className="h-3 w-24 rounded-sm" style={{ background: 'linear-gradient(to right, rgba(245,158,11,0.12), rgba(245,158,11,1))' }} />
      Busy
    </div>
  );
}

/** A period long enough on paper, but not yet a week of whole days (today is counted once it is over). */
export function HeatmapTooShort() {
  return (
    <Panel title="An average day, by weekday and hour" className="xl:col-span-2">
      <p className="py-2 text-sm text-stone-500">
        This needs a week of whole days. Today is left out until it is over, so pick a longer period (This month or Last month) to see it.
      </p>
    </Panel>
  );
}

export function DaypartsPanel({ dayparts }: { dayparts: ReportDayparts }) {
  const lines = dayparts.other ? [...dayparts.lines, dayparts.other] : dayparts.lines;
  const total = lines.reduce((s, l) => s + l.netSalesCents, 0);
  return (
    <Panel
      title="Parts of the day"
      note={dayparts.isDefault ? 'The till’s usual parts of the day. The owner can change them on Costing → Targets.' : 'Your parts of the day, set on Costing → Targets.'}
    >
      <DataTable
        columns={[{ label: 'Part' }, { label: 'Orders', right: true }, { label: 'Sales', right: true }, { label: 'Average order', right: true }, { label: 'Share', right: true }]}
        rows={lines.map((l) => [
          <span key="n">
            <span className="font-medium">{l.name}</span>{' '}
            <span className="text-xs text-stone-500">{daypartHoursText(l.fromHour, l.toHour)}</span>
          </span>,
          l.orderCount,
          formatCents(l.netSalesCents),
          l.orderCount > 0 ? formatCents(l.avgOrderCents) : '—',
          percentOf(l.netSalesCents, total),
        ])}
        empty="No sales in this period yet."
      />
    </Panel>
  );
}

/** Adding and taking off notes: given by the page (it calls the till); absent, the list is read-only. */
export interface DayNoteEditor {
  /** True once the till has it (the form then clears); false when refused (the form keeps what was typed). */
  add: (input: DayNoteInput) => Promise<boolean>;
  remove: (id: string) => Promise<boolean>;
  busy: boolean;
  /** The day the form starts on (YYYY-MM-DD): the period's last day, or today. */
  defaultDay: string;
  /** The latest day a note may be for (a year ahead). */
  maxDay: string;
}

export function DayNotesPanel({
  notes,
  editor,
  period,
}: {
  notes: ReportDayNote[];
  editor?: DayNoteEditor;
  /** The dates picked above: a note added for a day outside them is kept, and says so. */
  period?: { firstDay: string; lastDay: string };
}) {
  return (
    <Panel title="Notes on days" note="Mark Eid, rain, load-shedding or a closed day, so a quiet day has its reason beside it. Closed days are left out of the averages above.">
      {notes.length === 0 ? (
        <p className="py-2 text-sm text-stone-500">No notes for these days.</p>
      ) : (
        <ul className="space-y-1.5">
          {notes.map((n) => (
            <DayNoteRow key={n.id} n={n} editor={editor} />
          ))}
        </ul>
      )}
      {editor && <DayNoteForm editor={editor} period={period} />}
    </Panel>
  );
}

/**
 * One note. Taking it off asks first, on the screen itself (a slip of the
 * finger on a touch screen must not take a note off): the bin opens "Take
 * this note off?" with a button to do it and one to keep it.
 */
function DayNoteRow({ n, editor }: { n: ReportDayNote; editor?: DayNoteEditor }) {
  const [asking, setAsking] = useState(false);
  return (
    <li className="flex flex-wrap items-center gap-2 text-sm">
      <StickyNote className="h-4 w-4 shrink-0 text-amber-600" />
      <div className="min-w-0 flex-1">
        <span className="font-medium">{fmtDay(n.day)}</span> — {dayNoteText(n)}
        <span className="text-xs text-stone-500">
          {n.addedBy ? ` · ${n.addedBy}` : ''}
          {n.excludeFromForecast ? ' · left out of forecasts' : ''}
        </span>
      </div>
      {editor &&
        (asking ? (
          <span className="flex items-center gap-2">
            <span className="text-sm font-medium">Take this note off?</span>
            <Button
              variant="danger"
              size="sm"
              disabled={editor.busy}
              onClick={() => {
                void editor.remove(n.id).then((done) => {
                  if (!done) setAsking(false);
                });
              }}
            >
              Take it off
            </Button>
            <Button variant="secondary" size="sm" onClick={() => setAsking(false)}>
              Keep it
            </Button>
          </span>
        ) : (
          <button
            type="button"
            disabled={editor.busy}
            onClick={() => setAsking(true)}
            className="flex h-10 w-10 items-center justify-center rounded-lg text-stone-400 hover:bg-stone-100 hover:text-red-600 dark:hover:bg-stone-800"
            aria-label={`Take off the note for ${fmtDay(n.day)}`}
          >
            <Trash2 className="h-5 w-5" />
          </button>
        ))}
    </li>
  );
}

function DayNoteForm({ editor, period }: { editor: DayNoteEditor; period?: { firstDay: string; lastDay: string } }) {
  const [day, setDay] = useState(editor.defaultDay);
  const outside = period ? dayOutsidePeriod(day, period) : false;
  const [tag, setTag] = useState<DayNoteTag | null>(null);
  const [note, setNote] = useState('');
  const [exclude, setExclude] = useState<boolean | null>(null);
  const leaveOut = exclude ?? (tag ? excludedFromForecastByDefault(tag) : false);
  const submit = async () => {
    if (!tag || editor.busy) return;
    if (!(await editor.add({ day, tag, note: note.trim() || null, excludeFromForecast: leaveOut }))) return;
    setTag(null);
    setNote('');
    setExclude(null);
  };
  return (
    <form
      className="mt-4 space-y-3 border-t border-stone-200 pt-3 dark:border-stone-800"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-sm font-medium">
          Day
          <input
            type="date"
            value={day}
            max={editor.maxDay}
            onChange={(e) => e.target.value && setDay(e.target.value)}
            className="h-10 rounded-lg border border-stone-300 bg-white px-2 font-mono text-sm dark:border-stone-700 dark:bg-stone-800"
          />
        </label>
        <span className="text-xs text-stone-500">A day runs 5 am to 5 am.</span>
      </div>
      {outside && (
        <p className="text-xs text-amber-700 dark:text-amber-400">
          {fmtDay(day)} is not in the dates picked above. The note is kept, and shows here when you pick dates that include it.
        </p>
      )}
      <div className="flex flex-wrap gap-2" role="group" aria-label="What was the day">
        {DAY_NOTE_TAGS.map((t) => (
          <button
            key={t}
            type="button"
            aria-pressed={tag === t}
            onClick={() => {
              setTag(t);
              setExclude(null);
            }}
            className={cn(
              'h-9 rounded-lg px-3 text-sm font-semibold',
              tag === t ? 'bg-amber-400 text-stone-900' : 'bg-stone-100 text-stone-700 hover:bg-stone-200 dark:bg-stone-800 dark:text-stone-300',
            )}
          >
            {DAY_NOTE_TAG_LABEL[t]}
          </button>
        ))}
      </div>
      <input
        type="text"
        value={note}
        maxLength={200}
        onChange={(e) => setNote(e.target.value)}
        placeholder="A few words (optional): “closed after 9, no gas”"
        className="h-10 w-full rounded-lg border border-stone-300 bg-white px-3 text-sm dark:border-stone-700 dark:bg-stone-800"
      />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={leaveOut} onChange={(e) => setExclude(e.target.checked)} />
          Leave this day out of forecasts
        </label>
        <Button type="submit" variant="primary" disabled={!tag || editor.busy}>
          Add note
        </Button>
      </div>
    </form>
  );
}
