/**
 * The engine that does not read.
 *
 * `extract()` returns nothing, always, and that is the entire implementation. The
 * deterministic pass in extraction/rules.ts has already run by the time a provider
 * is consulted, so choosing this engine does not mean "no extraction" -- it means
 * the extraction stops at what software can prove, and everything past that point
 * is left empty for a human to type.
 *
 * WHY IT EXISTS
 *
 * Two reasons, and only the second one is about the AI question.
 *
 * 1. The tracker should never be dead. `claude` not installed, not signed in, a
 *    subscription window that has run out, no network on the day she needs to file
 *    something -- in every one of those states this engine still ingests the PDF,
 *    reads its text (or OCRs it, which is local and needs no engine), fills the
 *    fields rules can prove, computes both clocks, and hands her a record to
 *    finish. A queue of documents stuck at "extraction failed" is worse than a
 *    queue of documents half filled in.
 *
 * 2. It answers "do we even need the AI for this" with a number instead of an
 *    opinion, because it is the same code path measured. Across the 13 eval
 *    fixtures, 180 fields should carry a value:
 *
 *      rules alone   82 right (45.6%), 0 wrong
 *      rules blank   98        (54.4%)
 *
 *    plus 12 date fields computed in code. So: perfect precision, half the recall.
 *    Rules get the contract name, the effective date and the governing law right
 *    every time (13/13 each). They get every signer, every address, the notice
 *    address and the IBC form wrong zero times and right zero times -- they never
 *    fire at all, because those live in signature blocks and letterheads that no
 *    two law firms lay out the same way, and a rule that guessed at them would be
 *    the one thing this product must not do: confidently wrong.
 *
 * WHAT IT IS NOT
 *
 * It is not a fallback. Nothing in the codebase may select it automatically when
 * another engine fails -- see the note at the top of providers/types.ts. An engine
 * that silently became this one would look exactly like a successful extraction
 * that had quietly stopped extracting, and the amber "model" dots that would have
 * warned her simply would not appear.
 */

import type { FieldKey } from '../fields';
import type {
  ExtractOptions,
  ExtractionRequest,
  ExtractionResponse,
  HealthCheck,
  Provider,
  ProviderHealth,
} from './types';
import { runRules } from '../extraction/rules';
import { SELF_TEST_FIELDS, SELF_TEST_TEXT } from './parse';

/** Where the promptVersion slot would go. There is no prompt; say so rather than fake one. */
const NO_PROMPT = 'rules-only';

export class NoneProvider implements Provider {
  readonly id = 'none' as const;

  /**
   * Nothing is spawned and nothing is awaited, so the only bound worth having is
   * the one that keeps the UI's progress from flickering through a batch. The
   * queue's own ordering still applies.
   */
  readonly maxConcurrency = 4;

  /** No images are read. A scan still becomes text via OCR, which is not an engine. */
  readonly supportsVision = false;

  extract(req: ExtractionRequest, _opts?: ExtractOptions): Promise<ExtractionResponse> {
    // Deliberately not `throw`. A provider that throws would put the document into
    // the failed state and start the retry machinery; this engine succeeding at
    // finding nothing is the correct outcome, and the pipeline turns an unanswered
    // field into 'missing' on its own.
    return Promise.resolve({
      fields: {},
      docType: null,
      usage: { inputTokens: null, outputTokens: null, costUsd: 0 },
      raw: {
        provider: this.id,
        model: NO_PROMPT,
        promptVersion: NO_PROMPT,
        prompt: '',
        response: '',
        repairAttempts: 0,
      },
      durationMs: 0,
    });
  }

  /**
   * Always ready, and it has to be: the point of this engine is to be the one that
   * cannot be unavailable. The checks still say something true rather than a bare
   * "ok", because Diagnostics is where she will look to understand why a record
   * came back half empty.
   */
  health(): Promise<ProviderHealth> {
    const checks: HealthCheck[] = [
      {
        id: 'reads',
        label: 'Reads documents',
        state: 'ok',
        detail: 'Text and scans are read on this Mac. OCR does not need an engine.',
      },
      {
        id: 'fills',
        // Warn, not ok. The row is the one thing someone choosing this engine has
        // to know, and it belongs in the app's own vocabulary for that -- the
        // label under a warn dot reads "Needs a look", which is exactly right for
        // a record that is half typed by hand.
        //
        // The detail is kept SHORT because this row truncates at one line: the
        // first version ran to two sentences and the screen cut it at "Signers,
        // addresses, the ...", losing the only part that named what stays blank.
        label: 'Fills fields',
        state: 'warn',
        detail: 'About half. Signers, addresses and the IBC form are always left for you.',
      },
      {
        id: 'sends',
        label: 'Sends nothing',
        state: 'ok',
        detail: 'No network call, no subscription, no cost.',
      },
    ];
    return Promise.resolve({
      provider: this.id,
      state: 'ok',
      summary: 'Rules only. No engine, no cost, about half the fields filled.',
      checks,
    });
  }

  /**
   * A real measurement, not a stub. It runs the deterministic pass over the same
   * synthetic agreement the other two engines are tested against and reports how
   * many of those fields it filled, so the number on the wizard's test step is
   * this engine's actual behaviour on a document rather than a claim about it.
   */
  selfTest(_opts?: ExtractOptions): Promise<{
    ok: boolean;
    durationMs: number;
    fieldsFound: number;
    fieldsTotal: number;
    costUsd: number | null;
    error?: never;
  }> {
    const started = Date.now();
    const hits = runRules(SELF_TEST_TEXT.split('\n[page 2]\n'));
    const found = SELF_TEST_FIELDS.filter((k: FieldKey) => hits[k] !== undefined).length;
    return Promise.resolve({
      // `ok` is not "found everything". This engine working correctly includes
      // finding nothing, so the only failure it can have is throwing.
      ok: true,
      durationMs: Date.now() - started,
      fieldsFound: found,
      fieldsTotal: SELF_TEST_FIELDS.length,
      costUsd: 0,
    });
  }
}
