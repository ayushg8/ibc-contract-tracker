'use client';

/**
 * The only place a screen talks to the server.
 *
 * Nothing here throws. Every call resolves to `{ data }` or `{ error }`, so no
 * screen needs a try/catch and no failure can reach Bonnie as an unhandled
 * rejection. A transport failure is normalised into the same
 * SerialisedEngineError the route handlers emit, which means one renderer for
 * every error in the product.
 *
 * Server-only modules are absent by construction: this file imports the error
 * taxonomy and the pure type modules, never `@/lib/db` or `@/lib/providers`.
 */

import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';

import type {
  AppSettings,
  AuditEntry,
  ContractDetail,
  ContractSummary,
  DocType,
  DocumentDetail,
  DocumentSummary,
  ErrorRow,
  FieldKey,
  FieldRecord,
  ProviderId,
} from '@/lib/db/types';
import {
  EngineError,
  type EngineErrorCode,
  type SerialisedEngineError,
} from '@/lib/providers/errors';
import type { HealthCheck, HealthState, ProviderHealth } from '@/lib/providers/types';

/* ─────────────────────────────── Result ─────────────────────────────── */

/**
 * `extra` carries the top-level keys a route puts beside `error` -- today only
 * `unresolvedFields` on a 409 from approve.
 */
export type ApiResult<T> =
  | { data: T; error?: undefined; extra?: undefined }
  | { data?: undefined; error: SerialisedEngineError; extra: Record<string, unknown> };

function localError(code: EngineErrorCode, detail: string): ApiResult<never> {
  return { error: new EngineError(code, { detail }).toJSON(), extra: {} };
}

function isSerialisedError(v: unknown): v is SerialisedEngineError {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o['code'] === 'string' &&
    typeof o['message'] === 'string' &&
    typeof o['remedy'] === 'object' &&
    o['remedy'] !== null
  );
}

function offline(): boolean {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}

async function request<T>(path: string, init?: RequestInit): Promise<ApiResult<T>> {
  let res: Response;
  try {
    res = await fetch(path, { cache: 'no-store', ...init });
  } catch (e) {
    const detail = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    return localError(offline() ? 'NETWORK_UNAVAILABLE' : 'UNKNOWN', detail);
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = undefined;
  }

  if (!res.ok) {
    if (typeof body === 'object' && body !== null) {
      const record = body as Record<string, unknown>;
      const raw = record['error'];
      if (isSerialisedError(raw)) {
        const extra: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(record)) if (k !== 'error') extra[k] = v;
        return { error: raw, extra };
      }
    }
    return localError('UNKNOWN', `HTTP ${res.status} ${res.statusText} from ${path}`);
  }

  if (typeof body !== 'object' || body === null) {
    return localError('UNKNOWN', `Non-object success body from ${path}`);
  }
  return { data: body as T };
}

function json(method: string, payload: unknown): RequestInit {
  return {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  };
}

/* ──────────────────────── Response shapes ───────────────────────────── */

export interface StatsResponse {
  inbox: number;
  pending: number;
  contracts: number;
  expiring: number;
  usage: { month: string; documents: number; costUsd: number; points: number[] };
}

export interface DocumentsResponse {
  documents: DocumentSummary[];
}

export interface UploadResponse {
  accepted: DocumentSummary[];
  duplicates: { filename: string; documentId: string }[];
}

export interface DocumentResponse {
  document: DocumentDetail;
  fields: FieldRecord[];
  contract: ContractSummary | null;
}

export interface FieldsResponse {
  fields: FieldRecord[];
}

export interface DocumentSummaryResponse {
  document: DocumentSummary;
}

export interface ApproveResponse {
  contract: ContractSummary;
}

export interface ContractsResponse {
  contracts: ContractSummary[];
  total: number;
}

export interface ContractResponse {
  contract: ContractDetail;
  fields: FieldRecord[];
  audit: AuditEntry[];
}

export interface ContractPatchResponse {
  contract: ContractDetail;
  fields: FieldRecord[];
}

export interface ExportPreviewResponse {
  sheets: { id: DocType; label: string; rows: number }[];
  lastExportedAt: string | null;
}

export interface SettingsResponse {
  settings: AppSettings;
}

export interface ApiKeyResponse {
  valid: boolean;
  detail: string;
}

export interface OkResponse {
  ok: true;
}

export interface HealthResponse {
  overall: HealthState;
  checks: HealthCheck[];
  engine: ProviderHealth;
  recentErrors: ErrorRow[];
}

export interface EngineTestResponse {
  provider: ProviderId;
  ok: boolean;
  durationMs: number;
  fieldsFound: number;
  fieldsTotal: number;
  costUsd: number | null;
  error: SerialisedEngineError | null;
}

export interface SupportBundleResponse {
  filename: string;
  contents: string;
}

export interface ContractQueryParams {
  q?: string;
  filter?: 'all' | 'active' | 'expiring' | 'expired' | 'unknown';
  docType?: DocType | 'all';
  sort?: string;
  dir?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
}

/* ───────────────────────────── Endpoints ────────────────────────────── */

function query(params: Record<string, string | number | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== '') sp.set(k, String(v));
  }
  const s = sp.toString();
  return s.length > 0 ? `?${s}` : '';
}

export const api = {
  stats: () => request<StatsResponse>('/api/stats'),

  documents: (status: 'pending' | 'all' = 'all') =>
    request<DocumentsResponse>(`/api/documents${query({ status })}`),

  upload: (files: File[]) => {
    const form = new FormData();
    for (const f of files) form.append('files', f);
    // No Content-Type: the browser has to set the multipart boundary itself.
    return request<UploadResponse>('/api/documents', { method: 'POST', body: form });
  },

  document: (id: string) => request<DocumentResponse>(`/api/documents/${id}`),

  rejectDocument: (id: string) =>
    request<OkResponse>(`/api/documents/${id}`, { method: 'DELETE' }),

  retryDocument: (id: string) =>
    request<DocumentSummaryResponse>(`/api/documents/${id}/retry`, { method: 'POST' }),

  editField: (id: string, key: FieldKey, value: string | null, method: 'manual' | 'na') =>
    request<FieldsResponse>(`/api/documents/${id}/fields`, json('PATCH', { key, value, method })),

  approve: (id: string) =>
    request<ApproveResponse>(`/api/documents/${id}/approve`, { method: 'POST' }),

  contracts: (params: ContractQueryParams = {}) =>
    request<ContractsResponse>(`/api/contracts${query({ ...params })}`),

  contract: (id: string) => request<ContractResponse>(`/api/contracts/${id}`),

  editContractField: (id: string, key: FieldKey, value: string | null) =>
    request<ContractPatchResponse>(`/api/contracts/${id}`, json('PATCH', { key, value })),

  exportPreview: () => request<ExportPreviewResponse>('/api/export/preview'),

  settings: () => request<SettingsResponse>('/api/settings'),

  saveSettings: (patch: Partial<AppSettings>) =>
    request<SettingsResponse>('/api/settings', json('PATCH', patch)),

  setApiKey: (key: string) =>
    request<ApiKeyResponse>('/api/settings/api-key', json('POST', { key })),

  clearApiKey: () => request<OkResponse>('/api/settings/api-key', { method: 'DELETE' }),

  health: () => request<HealthResponse>('/api/health'),

  testEngine: () => request<EngineTestResponse>('/api/engine/test', { method: 'POST' }),

  supportBundle: () => request<SupportBundleResponse>('/api/support-bundle'),
} as const;

/* ───────────────────────── Binary side doors ────────────────────────── */

const DEFAULT_SHEETS: DocType[] = ['nda', 'evaluation'];

function filenameFrom(disposition: string | null, fallback: string): string {
  const match = disposition?.match(/filename="?([^";]+)"?/);
  return match?.[1] ?? fallback;
}

/**
 * Downloading through fetch rather than navigating to the URL: a failed export
 * returns JSON, and navigation would render that JSON in the window. This keeps
 * the failure inside the normal error path.
 */
export async function downloadExport(
  sheets: DocType[] = DEFAULT_SHEETS,
): Promise<ApiResult<{ filename: string }>> {
  const url = `/api/export${query({ sheets: sheets.join(',') })}`;
  let res: Response;
  try {
    res = await fetch(url, { cache: 'no-store' });
  } catch (e) {
    const detail = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    return localError(offline() ? 'NETWORK_UNAVAILABLE' : 'UNKNOWN', detail);
  }

  if (!res.ok) {
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      body = undefined;
    }
    const raw = typeof body === 'object' && body !== null
      ? (body as Record<string, unknown>)['error']
      : undefined;
    if (isSerialisedError(raw)) return { error: raw, extra: {} };
    return localError('UNKNOWN', `HTTP ${res.status} from ${url}`);
  }

  const filename = filenameFrom(res.headers.get('Content-Disposition'), 'Tracker.xlsx');
  const blob = await res.blob();
  const href = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = href;
  anchor.download = filename;
  anchor.click();
  // Revoking synchronously cancels the download in Safari.
  window.setTimeout(() => URL.revokeObjectURL(href), 10_000);
  return { data: { filename } };
}

/** Puts the redacted diagnostics text on the clipboard. Used by every failure card. */
export async function copySupportBundle(): Promise<ApiResult<{ filename: string }>> {
  const result = await api.supportBundle();
  if (result.error !== undefined) return result;
  try {
    await navigator.clipboard.writeText(result.data.contents);
  } catch (e) {
    const detail = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    return localError('UNKNOWN', `clipboard refused: ${detail}`);
  }
  return { data: { filename: result.data.filename } };
}

/* ──────────────────────────── Polling ───────────────────────────────── */

function awake(): boolean {
  if (typeof document === 'undefined') return false;
  return document.visibilityState === 'visible' && document.hasFocus();
}

/**
 * Calls `fn` every `ms` while the tab is visible and focused, and once
 * immediately when it wakes up. A background tab polls nothing: this app sits
 * open all day and a hidden window has no reason to keep hitting the engine.
 */
export function usePoll(fn: () => void, ms: number): void {
  const latest = useRef(fn);
  latest.current = fn;

  useEffect(() => {
    if (ms <= 0) return;
    let timer: number | null = null;

    function stop() {
      if (timer !== null) window.clearInterval(timer);
      timer = null;
    }
    function start() {
      if (timer !== null) return;
      timer = window.setInterval(() => {
        if (awake()) latest.current();
      }, ms);
    }
    function onWake() {
      if (awake()) {
        latest.current();
        start();
      } else {
        stop();
      }
    }

    onWake();
    document.addEventListener('visibilitychange', onWake);
    window.addEventListener('focus', onWake);
    window.addEventListener('blur', onWake);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onWake);
      window.removeEventListener('focus', onWake);
      window.removeEventListener('blur', onWake);
    };
  }, [ms]);
}

/* ───────────────────────── Shared resources ─────────────────────────── */

export interface Resource<T> {
  data: T | null;
  error: SerialisedEngineError | null;
  loading: boolean;
}

export interface ResourceStore<T> {
  /** Subscribe from a component. Every subscriber shares one request. */
  use(): Resource<T> & { refresh: () => void };
  /** Fetch now, outside React -- after a mutation, for instance. */
  refresh(): Promise<void>;
  peek(): Resource<T>;
}

/**
 * One request per resource, however many components read it. The sidebar badge,
 * the palette and a screen header all want the same counts; three intervals
 * hitting the same route would be three times the work for identical data.
 */
export function createResourceStore<T>(
  fetcher: () => Promise<ApiResult<T>>,
  pollMs = 0,
): ResourceStore<T> {
  const initial: Resource<T> = { data: null, error: null, loading: true };
  let snapshot: Resource<T> = initial;
  const listeners = new Set<() => void>();
  let inflight = 0;
  let timer: number | null = null;

  function emit(next: Resource<T>): void {
    snapshot = next;
    for (const l of listeners) l();
  }

  async function refresh(): Promise<void> {
    const token = ++inflight;
    const result = await fetcher();
    // A slower earlier request must not overwrite a newer answer.
    if (token !== inflight) return;
    if (result.error !== undefined) {
      emit({ data: snapshot.data, error: result.error, loading: false });
    } else {
      emit({ data: result.data, error: null, loading: false });
    }
  }

  function tick(): void {
    if (awake()) void refresh();
  }

  function subscribe(listener: () => void): () => void {
    const first = listeners.size === 0;
    listeners.add(listener);
    if (first) {
      void refresh();
      if (pollMs > 0) {
        timer = window.setInterval(tick, pollMs);
        window.addEventListener('focus', tick);
        document.addEventListener('visibilitychange', tick);
      }
    }
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0 && timer !== null) {
        window.clearInterval(timer);
        timer = null;
        window.removeEventListener('focus', tick);
        document.removeEventListener('visibilitychange', tick);
      }
    };
  }

  function getSnapshot(): Resource<T> {
    return snapshot;
  }

  function getServerSnapshot(): Resource<T> {
    return initial;
  }

  return {
    use() {
      const value = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
      const reload = useCallback(() => {
        void refresh();
      }, []);
      return { ...value, refresh: reload };
    },
    refresh,
    peek: getSnapshot,
  };
}
