import { describe, expect, it } from 'vitest';

import { describeAccount, parseAuthStatus, planSupportsCli } from '@/lib/providers/cli';
import { redact } from '@/lib/providers/errors';

/*
 * `claude auth status --json` is the only cheap, authoritative answer to "is she
 * signed in, and to what". Everything here exists to keep it closed: a payload this
 * cannot positively account for must never come back as "signed in", because that
 * sends her to an engine that will fail on the first real contract with none of the
 * setup screens having said so.
 */
describe('parseAuthStatus', () => {
  it('reads a signed-in subscription account', () => {
    const out = JSON.stringify({
      loggedIn: true,
      authMethod: 'claude.ai',
      apiProvider: 'firstParty',
      email: 'bonnie@ibcbatt.com',
      orgName: 'IBC',
      subscriptionType: 'pro',
    });
    expect(parseAuthStatus(out)).toEqual({
      state: 'signed-in',
      email: 'bonnie@ibcbatt.com',
      orgName: 'IBC',
      plan: 'pro',
    });
  });

  it('reads a signed-out account', () => {
    expect(parseAuthStatus(JSON.stringify({ loggedIn: false }))).toEqual({ state: 'signed-out' });
  });

  it('tolerates a signed-in payload missing every optional field', () => {
    expect(parseAuthStatus(JSON.stringify({ loggedIn: true }))).toEqual({
      state: 'signed-in',
      email: null,
      orgName: null,
      plan: null,
    });
  });

  it.each(['', 'not json', '{}', 'null', '[]', '{"loggedIn":"yes"}', '{"loggedIn":1}'])(
    'refuses to guess from %j',
    (out) => {
      expect(parseAuthStatus(out)).toEqual({ state: 'unknown' });
    },
  );

  /*
   * Her dotfiles print their own banner. Reading that as the answer is the mistake
   * `parseShellLookup` already exists to avoid, so the scan takes the first balanced
   * object rather than trusting the whole of stdout.
   */
  it('ignores a banner printed before the JSON', () => {
    const out = `Welcome back!\n${JSON.stringify({ loggedIn: true, subscriptionType: 'max' })}`;
    expect(parseAuthStatus(out)).toEqual({
      state: 'signed-in',
      email: null,
      orgName: null,
      plan: 'max',
    });
  });

  it('ignores trailing noise after the JSON', () => {
    const out = `${JSON.stringify({ loggedIn: false })}\nupdate available\n`;
    expect(parseAuthStatus(out)).toEqual({ state: 'signed-out' });
  });

  it('is not fooled by a brace inside a string value', () => {
    const out = JSON.stringify({ loggedIn: true, orgName: 'IBC {batteries}', email: 'b@ibc.com' });
    expect(parseAuthStatus(out)).toEqual({
      state: 'signed-in',
      email: 'b@ibc.com',
      orgName: 'IBC {batteries}',
      plan: null,
    });
  });

  it('treats an empty string field as absent rather than as an answer', () => {
    const out = JSON.stringify({ loggedIn: true, email: '', subscriptionType: '' });
    expect(parseAuthStatus(out)).toEqual({
      state: 'signed-in',
      email: null,
      orgName: null,
      plan: null,
    });
  });
});

/*
 * Closed on both sides, and deliberately asymmetric in what it refuses. Telling
 * someone whose plan works that it never will is the expensive mistake, and
 * Anthropic can add a tier at any time, so an unrecognised plan falls through to
 * whatever a real run says rather than becoming a verdict here.
 */
describe('planSupportsCli', () => {
  it.each(['pro', 'Pro', 'max', 'MAX', ' team ', 'enterprise'])('accepts %j', (plan) => {
    expect(planSupportsCli(plan)).toBe('yes');
  });

  it.each(['free', 'Free', 'FREE'])('rejects %j', (plan) => {
    expect(planSupportsCli(plan)).toBe('no');
  });

  it.each([null, '', 'ultra', 'something-new'])('will not guess about %j', (plan) => {
    expect(planSupportsCli(plan)).toBe('unknown');
  });
});

/*
 * Naming the account is the point -- signing into a personal account rather than
 * the IBC one is otherwise invisible, and looks to her like a broken app. But a
 * support bundle gets forwarded, saved to a drive and pasted into threads, so the
 * address must survive on her screen and not survive the trip.
 *
 * These two assertions are the boundary. If either flips, the feature has either
 * stopped being useful or started leaking.
 */
describe('describeAccount', () => {
  const signedIn = {
    state: 'signed-in',
    email: 'bonnie@ibcbatt.com',
    orgName: 'IBC',
    plan: 'pro',
  } as const;

  it('names the plan and the address for the screen she is looking at', () => {
    expect(describeAccount(signedIn)).toBe('Claude Pro, bonnie@ibcbatt.com');
  });

  it('is masked by redact(), which is what anything forwarded goes through', () => {
    const masked = redact(describeAccount(signedIn)) ?? '';
    expect(masked).toContain('Claude Pro');
    expect(masked).not.toContain('bonnie@ibcbatt.com');
    expect(masked).toContain('***');
  });

  it('says the plan alone when no address was reported', () => {
    expect(describeAccount({ state: 'signed-in', email: null, orgName: null, plan: 'max' })).toBe(
      'Claude Max',
    );
  });

  it('claims nothing when it is not signed in', () => {
    expect(describeAccount({ state: 'signed-out' })).toBe('Not signed in.');
    expect(describeAccount({ state: 'unknown' })).toBe('Not signed in.');
  });
});
