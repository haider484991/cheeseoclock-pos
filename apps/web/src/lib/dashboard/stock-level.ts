/** Where an ingredient stands against its low mark: out (nothing left), low (at or under the mark) or fine. */
export function levelOf(i: { onHand: number; lowAt: number | null }): 'out' | 'low' | 'ok' {
  if (i.onHand <= 0) return 'out';
  if (i.lowAt !== null && i.onHand <= i.lowAt) return 'low';
  return 'ok';
}
