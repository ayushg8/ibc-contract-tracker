/**
 * Identity. Deliberately isomorphic -- this file imports nothing from node:, so
 * a client component can validate a route param without dragging a server-only
 * module into the browser bundle.
 *
 * File hashing lives with the ingest pipeline, not here: it needs node:crypto
 * over a stream and this file must stay bundle-safe.
 */

/** UUID v4 via Web Crypto. Present in Node 19+ and every browser we ship to. */
export function newId(): string {
  return globalThis.crypto.randomUUID();
}

/*
 * Named wrappers. Same generator, but a call site reading `newContractId()` is
 * one less thing to check when an id ends up in the wrong column.
 */
export const newDocumentId = newId;
export const newContractId = newId;
export const newPartyId = newId;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Guard for a route param before it reaches a query. A malformed id should be a
 * 404, not a lookup that returns nothing for an unexplained reason.
 */
export function isUuid(s: string | null | undefined): boolean {
  return typeof s === 'string' && UUID_RE.test(s);
}
