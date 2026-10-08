/**
 * Breaking a note is not money in or out (noteChangeWords.ts; the owner,
 * 8 Oct 2026). The reasons below are the kinds the till's cashiers type;
 * every amount is made up.
 */
import { describe, expect, it } from 'vitest';
import {
  CASH_IN_EXAMPLE,
  CASH_IN_HINT,
  NOTE_CHANGE_TEXT,
  NOTE_CHANGE_TITLE,
  OPEN_DRAWER_CASH_BUTTON,
  OPEN_DRAWER_NOTE_TEXT,
  OPEN_DRAWER_NOTE_TITLE,
  looksLikeNoteChange,
  noteChangeQuestion,
  showsNoteChangeNote,
} from './noteChangeWords';

describe('a reason that talks about change', () => {
  it.each([
    'for change',
    'For Change',
    'Change from the bank',
    '5000 change',
    'for-change',
    'chnage',
    'changed the 5000 note',
    'khula karwaya',
    '5000 ka khulla',
    'note khulwaya',
    'chutta',
    'chhutta liya',
    'chuttay paise',
    '5000 ka note tora',
    'note tod diya',
    'break 5000',
  ])('"%s" is change', (reason) => {
    expect(looksLikeNoteChange(reason)).toBe(true);
  });

  it.each([
    'water suzuki',
    'for water',
    'stationry plus food',
    'for cup tea',
    'Float from the owner',
    'owner float 5000',
    'today float',
    'tori',
    'staff breakfast',
    'chhutti advance',
    'Gas cylinder',
    'exchange rate',
    'Tip for Ali',
    '',
  ])('"%s" is not', (reason) => {
    expect(looksLikeNoteChange(reason)).toBe(false);
  });
});

describe('the note under the form', () => {
  it('shows for every Cash in, and for a Cash out only when its reason talks about change', () => {
    expect(showsNoteChangeNote('payin', '')).toBe(true);
    expect(showsNoteChangeNote('payin', 'Float from the owner')).toBe(true);
    expect(showsNoteChangeNote('payout', 'for water')).toBe(false);
    expect(showsNoteChangeNote('payout', 'for change')).toBe(true);
    expect(showsNoteChangeNote('tip_out', 'for change')).toBe(false);
  });

  it('says it in Roman Urdu: breaking a note changes nothing, so no entry; Cash in is new money, Cash out is money spent', () => {
    expect(NOTE_CHANGE_TITLE).toBe('Note khulwana Cash in ya Cash out nahi hai');
    expect(NOTE_CHANGE_TEXT).toContain('drawer mein paisa utna hi rehta hai');
    expect(NOTE_CHANGE_TEXT).toContain('Is ki koi entry na karein');
    expect(NOTE_CHANGE_TEXT).toContain('Cash in sirf tab karein jab bahar se naya paisa drawer mein daala jaye');
    expect(NOTE_CHANGE_TEXT).toContain('Cash out sirf tab karein jab paisa drawer se nikal kar kharch ho');
  });

  it('the Cash in button and its example no longer suggest change', () => {
    for (const words of [CASH_IN_HINT, CASH_IN_EXAMPLE]) expect(looksLikeNoteChange(words)).toBe(false);
  });
});

describe('the question before Record', () => {
  it('Cash in "for change": is it new money from outside? Enter goes back', () => {
    const q = noteChangeQuestion('payin', 'for change');
    expect(q).not.toBeNull();
    expect(q!.message.split('\n')[0]).toBe('Kya yeh naya paisa bahar se drawer mein aaya hai?');
    expect(q!.message).toContain('Agar sirf note khulwaya hai');
    expect(q!.yesLabel).toBe('Haan, naya paisa hai');
    expect(q!.noLabel).toBe('Wapas jayein');
  });

  it('Cash out "note khulwaya": was it spent?', () => {
    const q = noteChangeQuestion('payout', 'note khulwaya');
    expect(q!.message.split('\n')[0]).toBe('Kya yeh paisa drawer se nikal kar kharch hua hai?');
    expect(q!.yesLabel).toBe('Haan, kharch hua hai');
    expect(q!.noLabel).toBe('Wapas jayein');
  });

  it('nothing to ask for an everyday reason, or for a rider tip', () => {
    expect(noteChangeQuestion('payin', 'Float from the owner')).toBeNull();
    expect(noteChangeQuestion('payout', 'water suzuki')).toBeNull();
    expect(noteChangeQuestion('tip_out', 'for change')).toBeNull();
  });
});

describe('Open drawer (the owner, 8 Oct 2026: "there is 2 ways to cash out ... confusing for cashier")', () => {
  it('says in Roman Urdu that it records no money, and sends money in or out to Cash out / Cash in', () => {
    expect(OPEN_DRAWER_NOTE_TITLE).toBe('Open drawer se paisa record nahi hota');
    expect(OPEN_DRAWER_NOTE_TEXT).toContain('galle ka paisa utna hi rehta hai');
    expect(OPEN_DRAWER_NOTE_TEXT).toContain('to yahan se nahi, "Cash out" karein');
    expect(OPEN_DRAWER_NOTE_TEXT).toContain('Naya paisa daalna hai to "Cash in" karein');
    expect(OPEN_DRAWER_CASH_BUTTON).toBe('Cash out / Cash in karein');
  });
});
