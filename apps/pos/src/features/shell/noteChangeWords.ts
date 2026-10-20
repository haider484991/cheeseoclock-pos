import type { CashMovementType } from '@cheeseoclock/shared-types';
import { shopIsInPakistan } from '@cheeseoclock/shared-types';

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

/**
 * Roman Urdu on a Pakistani till — the cashiers' own words, as the owner asked —
 * and English anywhere else: a shop abroad gets the same warnings in words its
 * staff read. The box's lang attribute follows (noteWordsLang).
 */
const inUrdu = (): boolean => shopIsInPakistan();

/** The language the notes are in, for the box's lang attribute. */
export function noteWordsLang(): string {
  return inUrdu() ? 'ur-Latn' : 'en';
}

export function noteChangeTitle(): string {
  return inUrdu() ? 'Note khulwana Cash in ya Cash out nahi hai' : 'Breaking a note is not Cash in or Cash out';
}

export function noteChangeText(): string {
  return inUrdu()
    ? 'Bara note de kar khula (chhote note) lena naya paisa nahi hai, aur kharcha bhi nahi: drawer mein paisa utna hi rehta hai. ' +
        'Is ki koi entry na karein. Cash in sirf tab karein jab bahar se naya paisa drawer mein daala jaye (jaise owner ne float ke liye paise diye). ' +
        'Cash out sirf tab karein jab paisa drawer se nikal kar kharch ho.'
    : 'Swapping a big note for smaller ones is not new money and not spending: the drawer holds the same amount. ' +
        'Record nothing for it. Use Cash in only when new money comes into the drawer from outside (like a float from the owner). ' +
        'Use Cash out only when money leaves the drawer to be spent.';
}

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
 * money from outside? Cash out: was it spent? "Wapas jayein" ("Go back" in
 * English) is where Enter lands (a warning to read, not a routine yes).
 * Nothing for a rider tip.
 */
export function noteChangeQuestion(type: CashMovementType, reason: string): NoteChangeQuestion | null {
  if (!looksLikeNoteChange(reason)) return null;
  const urdu = inUrdu();
  if (type === 'payin') {
    if (!urdu) {
      return {
        message:
          'Is this new money put into the drawer from outside?\n' +
          'If a big note was only broken into smaller ones, it is not Cash in: the drawer holds the same amount. ' +
          'In that case press "Go back" and record nothing.',
        yesLabel: 'Yes, it is new money',
        noLabel: 'Go back',
      };
    }
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
    if (!urdu) {
      return {
        message:
          'Was this money taken out of the drawer and spent?\n' +
          'If a note was only taken out to be broken and the change went back into the drawer, it is not Cash out. ' +
          'In that case press "Go back" and record nothing.',
        yesLabel: 'Yes, it was spent',
        noLabel: 'Go back',
      };
    }
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
export function openDrawerNoteTitle(): string {
  return inUrdu() ? 'Open drawer se paisa record nahi hota' : 'Open drawer records no money';
}

export function openDrawerNoteText(): string {
  return inUrdu()
    ? 'Open drawer sirf galla kholne ke liye hai, jaise note khulwana ya khula dena: is mein galle ka paisa utna hi rehta hai. ' +
        'Agar galle se paisa nikal kar kharch karna hai (pani, doodh, sabzi…) to yahan se nahi, "Cash out" karein. ' +
        'Naya paisa daalna hai to "Cash in" karein.'
    : 'Open drawer only opens the drawer, like breaking a note or giving change: the drawer holds the same amount. ' +
        'To take money out and spend it (water, milk, vegetables…), don’t do it here — use "Cash out". ' +
        'To put new money in, use "Cash in".';
}

export function openDrawerCashButton(): string {
  return inUrdu() ? 'Cash out / Cash in karein' : 'Cash out / Cash in';
}

