import { describe, expect, it } from 'vitest';

import { batchUnapproveToast, rereadToast } from '../src/lib/client/copy';

/**
 * A toast is a factual claim about what just happened. These pin the branches
 * that were wrong: the batch undo that announced a remainder had come back when
 * nothing had, and the re-read that said nothing about what it kept.
 */

describe('batchUnapproveToast', () => {
  it('reports every one back when nothing stuck', () => {
    expect(batchUnapproveToast(4, 0)).toEqual({
      tone: 'default',
      title: '4 agreements are back in the Inbox',
      description: 'Nothing was lost. Their fields are exactly as you left them.',
    });
  });

  it('is singular for one', () => {
    expect(batchUnapproveToast(1, 0).title).toBe('That agreement is back in the Inbox');
  });

  it('never claims a remainder came back when every one failed', () => {
    // The regression. The old copy printed "The rest are back in the Inbox."
    // whenever stuck > 0, without ever comparing stuck to the batch size.
    const copy = batchUnapproveToast(3, 3);
    expect(copy.tone).toBe('bad');
    expect(copy.title).toBe('None of those could be undone');
    expect(copy.description).toBe(
      'All 3 are still in the repository. Send them back from there instead.',
    );
    expect(copy.description).not.toContain('back in the Inbox');
  });

  it('names both halves of a partial failure', () => {
    expect(batchUnapproveToast(5, 2)).toEqual({
      tone: 'warn',
      title: '2 of those could not be undone',
      description: '3 are back in the Inbox. The others are still in the repository.',
    });
  });

  it('is singular on both sides of a partial failure', () => {
    expect(batchUnapproveToast(2, 1)).toEqual({
      tone: 'warn',
      title: '1 of those could not be undone',
      description: '1 is back in the Inbox. The other is still in the repository.',
    });
  });

  it('treats a single failed record as a total failure, not a partial one', () => {
    const copy = batchUnapproveToast(1, 1);
    expect(copy.title).toBe('That could not be undone');
    expect(copy.description).toBe(
      'It is still in the repository. Send it back from there instead.',
    );
  });

  it('cannot report more failures than the batch held', () => {
    expect(batchUnapproveToast(2, 9).title).toBe('None of those could be undone');
  });
});

describe('rereadToast', () => {
  it('names what survives the read', () => {
    expect(rereadToast('Octilion', 4).description).toBe(
      'The 4 fields you filled in by hand are kept.',
    );
    expect(rereadToast('Octilion', 1).description).toBe(
      'The one field you filled in by hand is kept.',
    );
  });

  it('claims no count when nobody sent one', () => {
    expect(rereadToast('Octilion', null).description).toBe(
      'Octilion is back in the Inbox for review.',
    );
    expect(rereadToast('Octilion', 0).description).toBe(
      'Octilion is back in the Inbox for review.',
    );
  });

  it('stays in the present tense, because the read has only been queued', () => {
    expect(rereadToast('Octilion', 4).description).not.toContain('were kept');
  });
});
