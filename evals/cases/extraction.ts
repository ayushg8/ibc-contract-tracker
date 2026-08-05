/**
 * The whole thing against a real engine. Opt-in, because it costs money.
 *
 *   npm run eval -- --live
 *
 * Every field of every fixture is scored, and the citation guard is applied exactly as the
 * pipeline applies it, so a field only counts as correct if the model also quoted a clause
 * that is really in the document. Cost is reported per fixture and in total: an eval that
 * spends the CFO's money silently is not a trustworthy eval.
 *
 * This case never fails the build. A model regression is a judgement call for a human, not
 * a red exit code, and the offline cases are the ones that gate a commit.
 */

import { FIELD_KEYS, MODEL_FIELD_KEYS, type FieldKey } from '../../src/lib/fields';
import type { ExtractionRequest } from '../../src/lib/providers/types';
import { ALL_FIXTURES, fieldMatches, type Fixture } from '../fixtures/index';
import { CaseRun, show, type CaseContext, type CaseResult } from '../report';
import { useEvalDataDir } from './_harness';
import { load } from './_modules';

/** Fields no model is asked for. termination_date is arithmetic, done in code. */
const SCORED: FieldKey[] = FIELD_KEYS.filter((k) => k !== 'termination_date');

export async function runCase(ctx: CaseContext): Promise<CaseResult> {
  const run = new CaseRun('extraction', 'Full extraction against a live engine', true);
  if (!ctx.live) {
    run.skipCase('needs --live (this case calls a real engine and spends real money)');
    return run.finish();
  }
  useEvalDataDir();

  const { mod: providers, reason: providersReason } = await load('providers');
  const { mod: verify, reason: verifyReason } = await load('verify');
  const { mod: rules } = await load('rules');
  const { mod: prompt } = await load('prompt');
  const { mod: pdf } = await load('pdf');
  const { mod: dates } = await load('dates');
  const { mod: parties } = await load('parties');
  if (!providers || !verify) {
    run.skipCase(providersReason ?? verifyReason ?? 'engine modules unavailable');
    return run.finish();
  }

  const health = await providers.healthAll();
  const active = health.active === 'cli' ? health.cli : health.api;
  if (active.state === 'fail') {
    run.skipCase(`no engine available: ${active.summary}`);
    return run.finish();
  }

  const provider = await providers.getProvider(health.active);
  const tier = providers.getActiveTier();
  const promptVersion = prompt?.PROMPT_VERSION ?? 'unknown';
  const marker = pdf?.pageMarker ?? ((n: number) => `\n\n===== PAGE ${n} =====\n\n`);

  run.costUsd = 0;
  const corpus = ctx.fixtures === null ? ALL_FIXTURES : ALL_FIXTURES.filter((f) => ctx.fixtures?.includes(f.id));
  if (corpus.length === 0) {
    run.skipCase(`--fixture matched nothing. Known ids: ${ALL_FIXTURES.map((f) => f.id).join(', ')}`);
    return run.finish();
  }

  for (const f of corpus) {
    const text = f.pages.map((body, i) => `${marker(i + 1)}${body}`).join('');
    // Rules run first in production, so the model is asked only what is left. Scoring the
    // union of both is the only number that describes what a reviewer actually sees.
    const ruleHits = rules ? safeRules(rules.runRules, f.pages) : {};
    const fieldsToFill = MODEL_FIELD_KEYS.filter((k) => ruleHits[k] === undefined);

    const req: ExtractionRequest = {
      text,
      images: null,
      pageCount: f.pages.length,
      fieldsToFill,
      promptVersion,
      tier,
    };

    let answers: Partial<Record<FieldKey, { value: string | null; quote: string | null; page: number | null }>>;
    let docType: string | null = null;
    try {
      const response = await provider.extract(req, { timeoutMs: 180_000 });
      answers = response.fields;
      docType = response.docType;
      run.costUsd = (run.costUsd ?? 0) + (response.usage.costUsd ?? 0);
    } catch (e) {
      run.ok(
        `${f.id}.engine`,
        false,
        () => `the engine failed on ${f.id}: ${e instanceof Error ? e.message : String(e)}`,
      );
      continue;
    }

    const verified = verify.applyVerification(answers, f.pages);

    const values: Partial<Record<FieldKey, string | null>> = {};
    for (const key of FIELD_KEYS) {
      const rule = ruleHits[key];
      values[key] = rule ? rule.value : (verified.fields[key]?.value ?? null);
    }
    // The same invariant the pipeline enforces. Without this the suite scores raw model
    // output and a party swap reads as model variance rather than a defect.
    if (parties) parties.enforcePartyRolesOnValues(values);

    if (dates) {
      // The SAME resolver the pipeline uses. The suite previously did its own
      // arithmetic here, which meant it could pass while the app computed something
      // else entirely.
      const termRaw = values.term ?? null;
      values.term = dates.tidyTerm(termRaw);
      values.termination_date = dates.resolveEndDate({
        effective: values.effective_date ?? null,
        term: values.term,
        effectiveQuote: verified.fields.effective_date?.quote ?? null,
      }).iso;
    }

    for (const key of SCORED) {
      run.ok(
        `${f.id}.${key}`,
        fieldMatches(f, key, values[key] ?? null, { allowAcceptable: true }),
        () => `${f.id}.${key}: expected ${show(f.expected[key])}, got ${show(values[key] ?? null)}`,
        { field: true },
      );
    }
    run.ok(
      `${f.id}.termination_date`,
      (values.termination_date ?? null) === f.computed.terminationDate,
      () =>
        `${f.id}: termination should be ${show(f.computed.terminationDate)}, computed ${show(values.termination_date ?? null)}`,
      { field: true },
    );
    run.ok(
      `${f.id}.doc-type`,
      docType === f.docType || docType === null,
      () => `${f.id}: model called this a ${show(docType)}, it is a ${f.docType}`,
    );
    run.ok(
      `${f.id}.no-unverified-values`,
      Object.values(verified.fields).every((v) => v?.value === null || v?.quote !== null),
      () => `${f.id}: a value survived verification without a quote`,
    );
  }

  return run.finish();
}

type RuleHits = Partial<Record<FieldKey, { value: string; quote: string; page: number }>>;

function safeRules(fn: (pages: string[]) => RuleHits, pages: string[]): RuleHits {
  try {
    return fn(pages);
  } catch {
    return {};
  }
}
