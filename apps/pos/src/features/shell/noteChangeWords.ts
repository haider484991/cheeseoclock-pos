import type { CashMovementType } from '@cheeseoclock/shared-types';

/**
 * Drawer cash in / out: breaking a note is not money in or out (the owner,
 * 8 Oct 2026: "add it ... make this note in roman urdu"). On 6 Oct the
 * drawer opened with one Rs 5,000 note; it was broken into smaller notes and
 * typed in as "Cash in Rs 5,000 — for change", so the till expected Rs 5,000
 * that never came in, and the close read Rs 3,940 short (Rs 1,060 over in
 * truth). The cashiers read Roman Urdu: the note under the form and the
 * question before Record say it in their words. Pure, so it is tested.
 */

/**
 * The reason talks about change: breaking a note into smaller ones. English
 * and the Roman Urdu the till's cashiers type ("khula karwaya", "chutta",
 * "note tora"), with the usual slips ("chnage"). Whole words only, and not
 * the shop's everyday words that look alike: "today" is not "toda", "tori"
 * is a vegetable, "breakfast" and "chhutti" (a day off) are not change.
 */
const CHANGE_WORDS =
  /(^|[^a-z])(change\w*|chang|chnage|chenge|chnge|khul\w*|chh?ut+[aey]\w*|break(?!fast)\w*|tor[ae]?|tod[ae]?|torna|todna|turwa\w*|tudwa\w*)(?=[^a-z]|$)/i;

export function looksLikeNoteChange(reason: string): boolean {
  return CHANGE_WORDS.test(reason.toLowerCase());
}

/** Under the form: always for Cash in (it is rare), and for a Cash out whose reason talks about change. */
export function showsNoteChangeNote(type: CashMovementType, reason: string): boolean {
  return type === 'payin' || (type === 'payout' && looksLikeNoteChange(reason));
}

export const NOTE_CHANGE_TITLE = 'Note khulwana Cash in ya Cash out nahi hai';

export const NOTE_CHANGE_TEXT =
  'Bara note de kar khula (chhote note) lena naya paisa nahi hai, aur kharcha bhi nahi: drawer mein paisa utna hi rehta hai. ' +
  'Is ki koi entry na karein. Cash in sirf tab karein jab bahar se naya paisa drawer mein daala jaye (jaise owner ne float ke liye paise diye). ' +
  'Cash out sirf tab karein jab paisa drawer se nikal kar kharch ho.';

/** The till's own words (the hint under "Cash in" and the box's example), no longer "Change from the bank". */
export const CASH_IN_HINT = 'New money put in';
export const CASH_IN_EXAMPLE = 'Float from the owner';

export interface NoteChangeQuestion {
  /** First line: the question (the dialog's title); the rest under it. */
  message: string;
  yesLabel: string;
  noLabel: string;
}

/**
 * Asked before Record when the reason talks about change. Cash in: is it new
 * money from outside? Cash out: was it spent? "Wapas jayein" is where Enter
 * lands (a warning to read, not a routine yes). Nothing for a rider tip.
 */
export function noteChangeQuestion(type: CashMovementType, reason: string): NoteChangeQuestion | null {
  if (!looksLikeNoteChange(reason)) return null;
  if (type === 'payin') {
    return {
      message:
        'Kya yeh naya paisa bahar se drawer mein aaya hai?\n' +
        'Agar sirf note khulwaya hai (bara note de kar chhote note liye) to yeh Cash in nahi hai: drawer ka paisa utna hi hai. ' +
        'Is soorat mein "Wapas jayein" dabayein aur koi entry na karein.',
      yesLabel: 'Haan, naya paisa hai',
      noLabel: 'Wapas jayein',
    };
  }
  if (type === 'payout') {
    return {
      message:
        'Kya yeh paisa drawer se nikal kar kharch hua hai?\n' +
        'Agar note sirf khulwane ke liye nikala tha aur khula wapas drawer mein aa gaya, to yeh Cash out nahi hai. ' +
        'Is soorat mein "Wapas jayein" dabayein aur koi entry na karein.',
      yesLabel: 'Haan, kharch hua hai',
      noLabel: 'Wapas jayein',
    };
  }
  return null;
}

/**
 * Open drawer (the top bar): it records no money, but the cashiers took cash
 * out through it as well as through Drawer cash in / out (the owner, 8 Oct
 * 2026: "there is 2 ways to cash out ... that's confusing for cashier"). The
 * box says what it is for, in their words, and leads to Cash out / Cash in.
 */
export const OPEN_DRAWER_NOTE_TITLE = 'Open drawer se paisa record nahi hota';

export const OPEN_DRAWER_NOTE_TEXT =
  'Open drawer sirf galla kholne ke liye hai, jaise note khulwana ya khula dena: is mein galle ka paisa utna hi rehta hai. ' +
  'Agar galle se paisa nikal kar kharch karna hai (pani, doodh, sabzi…) to yahan se nahi, "Cash out" karein. ' +
  'Naya paisa daalna hai to "Cash in" karein.';

export const OPEN_DRAWER_CASH_BUTTON = 'Cash out / Cash in karein';

