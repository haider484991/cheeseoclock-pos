/**
 * DHA Karachi gazetteer for address entry.
 *
 * Delivery addresses in DHA are "house number + lane/street + area", and the
 * area part comes from a small fixed vocabulary: the phase, or a commercial
 * area / Khayaban inside it. Cashiers should pick that part, not type it —
 * every spelling of "Bukhari" that reaches a rider costs a phone call.
 *
 * Pure data + a typeahead helper. Editing the list is the whole job of adding
 * a place; nothing else needs to change.
 */

export type DhaPlaceKind = 'phase' | 'commercial' | 'khayaban' | 'landmark';

export interface DhaPlace {
  /** What the cashier sees and what goes on the ticket, e.g. "Rahat Commercial". */
  label: string;
  /** "Phase 6" — or null when a road runs through several phases. */
  phase: string | null;
  kind: DhaPlaceKind;
  /** Extra spellings people type: "bukhari", "kh e shahbaz", "ph 6". */
  aliases?: string[];
}

export const DHA_CITY = 'Karachi';

const phase = (n: number, aliases: string[] = []): DhaPlace => ({
  label: `DHA Phase ${n}`,
  phase: `Phase ${n}`,
  kind: 'phase',
  aliases: [`phase ${n}`, `ph ${n}`, `ph${n}`, `p${n}`, `${n}`, ...aliases],
});
const commercial = (label: string, phase: string | null, aliases: string[] = []): DhaPlace => ({
  label,
  phase,
  kind: 'commercial',
  aliases,
});
const khayaban = (name: string, phase: string | null, aliases: string[] = []): DhaPlace => ({
  label: `Khayaban-e-${name}`,
  phase,
  kind: 'khayaban',
  aliases: [name, `kh ${name}`, `kh e ${name}`, `khayaban ${name}`, ...aliases],
});
const landmark = (label: string, phase: string | null, aliases: string[] = []): DhaPlace => ({
  label,
  phase,
  kind: 'landmark',
  aliases,
});

export const DHA_KARACHI_PLACES: DhaPlace[] = [
  phase(1), phase(2), phase(3), phase(4), phase(5), phase(6), phase(7), phase(8),
  landmark('Phase 2 Extension', 'Phase 2', ['ph 2 ext', 'phase 2 ext', '2 ext']),
  landmark('Phase 5 Extension', 'Phase 5', ['ph 5 ext', 'phase 5 ext', '5 ext']),
  landmark('Phase 7 Extension', 'Phase 7', ['ph 7 ext', 'phase 7 ext', '7 ext']),
  landmark('Phase 8 Zone A', 'Phase 8', ['zone a']),
  landmark('Phase 8 Zone B', 'Phase 8', ['zone b']),
  landmark('Phase 8 Zone C', 'Phase 8', ['zone c']),
  landmark('Phase 8 Zone D', 'Phase 8', ['zone d']),
  landmark('Phase 8 Zone E', 'Phase 8', ['zone e']),

  // Phase 1 & 2
  commercial('Phase 1 Commercial', 'Phase 1'),
  commercial('Phase 2 Commercial Area A', 'Phase 2', ['area a']),
  commercial('Phase 2 Commercial Area B', 'Phase 2', ['area b']),
  landmark('Amir Khusro Road', 'Phase 2', ['amir khusro']),
  landmark('Sunset Boulevard', null, ['sunset']),

  // Phase 4
  commercial('9th Commercial Street', 'Phase 4', ['9th commercial', 'ninth commercial']),
  khayaban('Badar', null),

  // Phase 5
  commercial('Zamzama Commercial', 'Phase 5', ['zamzama']),
  commercial('Tauheed Commercial', 'Phase 5', ['tauheed', 'touheed']),
  commercial('Badar Commercial', 'Phase 5', ['badar']),
  commercial('Saba Commercial', 'Phase 5', ['saba']),
  landmark('Khadda Market', 'Phase 5', ['khadda', 'khada']),
  landmark('26th Street', 'Phase 5', ['26 street', '26th']),
  landmark('Saba Avenue', 'Phase 5'),
  khayaban('Tanzeem', 'Phase 5'),
  khayaban('Bahria', 'Phase 5'),
  khayaban('Shamsheer', 'Phase 5'),
  khayaban('Roomi', 'Phase 5'),
  khayaban('Momin', 'Phase 5'),
  khayaban('Tariq', 'Phase 5'),
  khayaban('Ghazi', 'Phase 5'),
  khayaban('Mujahid', 'Phase 5'),
  khayaban('Hafiz', null),

  // Phase 6 — home turf
  commercial('Bukhari Commercial', 'Phase 6', ['bukhari', 'bokhari', 'big bukhari', 'small bukhari']),
  commercial('Nishat Commercial', 'Phase 6', ['nishat']),
  commercial('Rahat Commercial', 'Phase 6', ['rahat']),
  commercial('Muslim Commercial', 'Phase 6', ['muslim']),
  commercial('Ittehad Commercial', 'Phase 6', ['ittehad', 'itehad']),
  commercial('Shahbaz Commercial', 'Phase 6', ['shahbaz', 'shabaz']),
  khayaban('Shahbaz', 'Phase 6', ['shabaz']),
  khayaban('Bukhari', 'Phase 6', ['bokhari']),
  khayaban('Rahat', 'Phase 6'),
  khayaban('Nishat', 'Phase 6'),
  khayaban('Muslim', 'Phase 6'),
  khayaban('Ittehad', null, ['itehad']),

  // Phase 7
  commercial('Sehar Commercial', 'Phase 7', ['sehar', 'seher']),
  commercial('Jami Commercial', 'Phase 7', ['jami']),
  khayaban('Sehar', null, ['seher']),
  khayaban('Jami', 'Phase 7'),
  khayaban('Saadi', 'Phase 7', ['sadi']),

  // Phase 8
  commercial('Zulfiqar Commercial', 'Phase 8', ['zulfiqar', 'zulfikar']),
  commercial('Al-Murtaza Commercial', 'Phase 8', ['murtaza', 'al murtaza']),
  landmark('Do Darya', 'Phase 8', ['dodarya', 'do darya']),
  landmark('Creek Vista', 'Phase 8', ['creek vista', 'creek']),
  khayaban('Shaheen', 'Phase 8'),
  khayaban('Qasim', 'Phase 8'),
];

/** "Rahat Commercial, DHA Phase 6" — the text that goes on the ticket. */
export function formatDhaArea(place: DhaPlace): string {
  if (place.kind === 'phase') return place.label;
  return place.phase ? `${place.label}, DHA ${place.phase}` : `${place.label}, DHA`;
}

function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/[-_.,/]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Typeahead over the gazetteer. Every typed word must appear at the start of
 * some word in the label, an alias, or the phase — so "kh sha" finds
 * Khayaban-e-Shahbaz, "6" lists Phase 6 and everything in it, "buk" finds
 * both Bukhari entries. Exact/prefix hits on the label sort first.
 */
export function suggestDhaAreas(query: string, limit = 8): DhaPlace[] {
  const q = norm(query);
  if (!q) return DHA_KARACHI_PLACES.filter((p) => p.kind === 'phase').slice(0, limit);
  const words = q.split(' ');
  const scored: Array<{ place: DhaPlace; score: number }> = [];
  for (const place of DHA_KARACHI_PLACES) {
    const label = norm(place.label);
    const haystacks = [label, ...(place.aliases ?? []).map(norm), norm(place.phase ?? '')];
    const haystackWords = haystacks.flatMap((h) => h.split(' ')).filter(Boolean);
    const allMatch = words.every((w) => haystackWords.some((hw) => hw.startsWith(w)));
    if (!allMatch) continue;
    let score = 0;
    if (label === q) score += 100;
    else if (label.startsWith(q)) score += 60;
    else if ((place.aliases ?? []).some((a) => norm(a) === q)) score += 50;
    else if (label.includes(q)) score += 30;
    if (place.kind === 'phase') score += 5;
    if (place.kind === 'commercial') score += 3;
    scored.push({ place, score });
  }
  return scored
    .sort((a, b) => b.score - a.score || a.place.label.localeCompare(b.place.label))
    .slice(0, limit)
    .map((s) => s.place);
}
