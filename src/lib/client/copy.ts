/**
 * The sentences the app asserts about what just happened.
 *
 * They live here, away from the screens, because each one is a factual claim
 * about a batch that partly failed or a re-read that partly kept -- and a toast
 * that says "the rest are back" when nothing came back is the same class of
 * defect as an unverified quote rendered as proven. Out here a test can hold
 * every branch against the counts it is describing.
 *
 * Pure. No React, no fetch, no db.
 */

/** Structurally the ToastTone of the UI kit, without importing React to get it. */
export type ToastTone = 'default' | 'ok' | 'warn' | 'bad';

export interface ToastCopy {
  tone: ToastTone;
  title: string;
  description: string;
}

/**
 * Undoing a batch approve. `stuck` is how many of the `total` refused to go
 * back, and the three outcomes are genuinely different: all back, some back,
 * none back. The old copy printed "the rest are back in the Inbox" without ever
 * comparing the two numbers, so a batch where every single unapprove failed
 * still claimed a remainder had returned.
 *
 * "Nothing was lost" is a claim, and it is made only on the branch where every
 * unapprove succeeded. It is true because an edit made on an approved record is
 * written back to the document's own fields, so re-approving rebuilds the record
 * from rows that already carry every correction.
 */
export function batchUnapproveToast(total: number, stuck: number): ToastCopy {
  const failed = Math.max(0, Math.min(stuck, total));
  const back = total - failed;

  if (failed === 0) {
    return {
      tone: 'default',
      title:
        total === 1
          ? 'That agreement is back in the Inbox'
          : `${total} agreements are back in the Inbox`,
      description: 'Nothing was lost. Their fields are exactly as you left them.',
    };
  }

  if (back === 0) {
    return {
      tone: 'bad',
      title: total === 1 ? 'That could not be undone' : 'None of those could be undone',
      description:
        total === 1
          ? 'It is still in the repository. Send it back from there instead.'
          : `All ${total} are still in the repository. Send them back from there instead.`,
    };
  }

  return {
    tone: 'warn',
    title:
      failed === 1 ? '1 of those could not be undone' : `${failed} of those could not be undone`,
    description: `${back} ${back === 1 ? 'is' : 'are'} back in the Inbox. The ${
      failed === 1 ? 'other is' : 'others are'
    } still in the repository.`,
  };
}

/**
 * Re-reading a document. The read replaces what the model found last time and
 * carries across every row a human filled in by hand or marked as not
 * applicable, so the toast names that count when it has one.
 *
 * Present tense on purpose: the re-read is queued, not finished, when this is
 * shown. "were kept" would be a past-tense claim about something that has not
 * happened yet, which is the tense the rest of this product is careful about.
 *
 * `kept` is null when neither the route nor the caller could count them. The
 * sentence then says nothing about what was kept rather than guessing a number.
 */
export function rereadToast(label: string, kept: number | null): ToastCopy {
  if (kept !== null && kept > 0) {
    return {
      tone: 'default',
      title: 'Reading the document again',
      description:
        kept === 1
          ? 'The one field you filled in by hand is kept.'
          : `The ${kept} fields you filled in by hand are kept.`,
    };
  }
  return {
    tone: 'default',
    title: 'Reading the document again',
    // Kept short on purpose: the toast clamps its description, and the action
    // button below already says where the record went.
    description: `${label} is back in the Inbox for review.`,
  };
}
