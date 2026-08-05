import { afterEach, describe, expect, it, vi } from 'vitest';

import { describeAudit } from '../src/components/repository/AuditTimeline';
import { toSettingsTab } from '../src/lib/client/settingsTab';
import { listRemoved } from '../src/lib/client/useRecordActions';

/**
 * The three screen-level defects that did not fit in a copy test: audit slugs
 * reaching the History list raw, the Settings deep link that no code read, and a
 * Removed view that must never show a record which is still in the repository.
 */

describe('describeAudit', () => {
  it('has plain English for every action a route writes', () => {
    // insertAudit is called with each of these somewhere in the app. A slug
    // missing from the map is printed raw, which is what "reextracted" did.
    const actions = [
      'extracted',
      'reextracted',
      'edited',
      'approved',
      'rejected',
      'reopened',
      'unapproved',
      'archived',
      'unarchived',
      'restored',
      'exported',
    ];
    for (const action of actions) {
      expect(describeAudit({ action, fieldKey: null })).not.toBe(action);
    }
  });

  it('reads the two that carry a documentId, and so always appear', () => {
    expect(describeAudit({ action: 'reextracted', fieldKey: null })).toBe('Read again by Claude');
    expect(describeAudit({ action: 'reopened', fieldKey: null })).toBe(
      'Reopened for another read',
    );
  });

  it('still names the field on a field-level entry', () => {
    expect(describeAudit({ action: 'edited', fieldKey: 'governing_law' })).toBe(
      'Edited Governing Law',
    );
  });

  it('falls back to the slug rather than dropping an unknown action', () => {
    expect(describeAudit({ action: 'teleported', fieldKey: null })).toBe('teleported');
  });
});

describe('toSettingsTab', () => {
  it('accepts every tab the remedies link to', () => {
    // HaltBanner sends the folder remedies to /settings?tab=folders. Before this
    // existed the query string did nothing and they opened the model picker.
    expect(toSettingsTab('folders')).toBe('folders');
    expect(toSettingsTab('engine')).toBe('engine');
    expect(toSettingsTab('export')).toBe('export');
    expect(toSettingsTab('data')).toBe('data');
    expect(toSettingsTab('appearance')).toBe('appearance');
    expect(toSettingsTab('diagnostics')).toBe('diagnostics');
  });

  it('refuses anything else, so a stale link falls back to the default pane', () => {
    expect(toSettingsTab(null)).toBe(null);
    expect(toSettingsTab('')).toBe(null);
    expect(toSettingsTab('Folders')).toBe(null);
    expect(toSettingsTab('__proto__')).toBe(null);
    expect(toSettingsTab('constructor')).toBe(null);
  });
});

/* ------------------------------ Removed view ------------------------------ */

function respond(body: unknown, ok = true): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok, json: async () => body }) as unknown as Response),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('listRemoved', () => {
  it('returns the rows when the route confirms it answered the archived list', async () => {
    respond({ archived: true, total: 1, contracts: [{ id: 'c1', archivedAt: '2026-07-01' }] });
    const result = await listRemoved('');
    expect(result.error).toBe(null);
    expect(result.rows).toHaveLength(1);
  });

  it('refuses an answer that does not say it is the archived list', async () => {
    // A build whose list route ignores ?archived=1 answers with the LIVE records.
    // Showing those under "Removed", each with a Restore button, would be worse
    // than showing nothing.
    respond({ archived: false, total: 2, contracts: [{ id: 'c1' }, { id: 'c2' }] });
    const result = await listRemoved('');
    expect(result.rows).toEqual([]);
    expect(result.error).not.toBe(null);
  });

  it('refuses a body with no flag at all', async () => {
    respond({ total: 1, contracts: [{ id: 'c1' }] });
    expect((await listRemoved('')).rows).toEqual([]);
  });

  it('reports a route failure in its own words', async () => {
    respond({ error: { message: 'The database is locked.' } }, false);
    expect((await listRemoved('')).error).toBe('The database is locked.');
  });

  it('survives the server being unreachable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
    );
    const result = await listRemoved('');
    expect(result.rows).toEqual([]);
    expect(result.error).not.toBe(null);
  });

  it('sends the search term, encoded', async () => {
    const seen: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string) => {
        seen.push(input);
        return { ok: true, json: async () => ({ archived: true, contracts: [] }) } as unknown as Response;
      }),
    );
    await listRemoved('  Octilion & Co  ');
    expect(seen[0]).toBe('/api/contracts?archived=1&q=Octilion%20%26%20Co');
  });
});
