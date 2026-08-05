/**
 * Fetching and validating the manifest.
 *
 * The manifest is the only thing the update mechanism trusts, and it is trusted
 * for exactly one fact: the SHA256 of the payload. Everything else it says is
 * either checked (the version is compared against what is installed) or shown to
 * a human (the notes). The payload itself is never trusted -- it is verified
 * against the fingerprint before a single byte of it is unpacked, and the
 * unpacked tree is checked for the files it must contain before anything is
 * switched over.
 *
 * The download is done by curl in update.sh rather than here, because the process
 * running this code gets killed half way through the operation. What this file
 * produces is a resolved plan: a URL curl can fetch, a fingerprint to check it
 * against, and (for a private repository) a header to send.
 */

import { z } from 'zod';

import { log } from '@/lib/logger';

import { UpdateError } from './failures';
import { isAllowedUrl, readToken } from './source';
import type { UpdateManifest, UpdateSource } from './types';
import { isVersion } from './version';

/** A manifest is a few hundred bytes. Anything larger is not one. */
const MAX_MANIFEST_BYTES = 256 * 1024;
const FETCH_TIMEOUT_MS = 20_000;
const GITHUB_API = 'https://api.github.com';
const MANIFEST_ASSET_NAME = 'manifest.json';
const ASSET_SCHEME = 'asset:';

const version = z.string().refine(isVersion, 'not a version number');

const ManifestSchema = z.object({
  schemaVersion: z.literal(1),
  version,
  url: z.string().min(1),
  sha256: z.string().regex(/^[0-9a-fA-F]{64}$/, 'not a sha256'),
  sizeBytes: z.number().int().positive().max(8 * 1024 ** 3).optional(),
  publishedAt: z.string().max(64).optional(),
  minimumSupportedVersion: version.optional(),
  notes: z.string().max(2000).optional(),
  critical: z.boolean().optional(),
});

export type RawManifest = z.output<typeof ManifestSchema>;

/**
 * What the shell script needs, with the GitHub indirection already resolved.
 * `authHeader` is present only for a private repository and is written to a
 * 0600 curl config file -- never to the plan, never to a log, never to a route.
 */
export interface ResolvedManifest {
  readonly manifest: UpdateManifest;
  readonly downloadUrl: string;
  readonly authHeader: string | null;
}

function normalise(raw: RawManifest): UpdateManifest {
  return {
    schemaVersion: 1,
    version: raw.version,
    url: raw.url,
    sha256: raw.sha256.toLowerCase(),
    sizeBytes: raw.sizeBytes ?? null,
    publishedAt: raw.publishedAt ?? null,
    minimumSupportedVersion: raw.minimumSupportedVersion ?? null,
    notes: raw.notes ?? null,
    critical: raw.critical ?? false,
  };
}

async function fetchText(url: string, headers: Record<string, string>): Promise<string> {
  const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, { headers, signal, redirect: 'follow', cache: 'no-store' });
  } catch (e) {
    throw new UpdateError('MANIFEST_UNREACHABLE', {
      detail: e instanceof Error ? `${e.name}: ${e.message}` : String(e),
      cause: e,
    });
  }
  if (!res.ok) {
    throw new UpdateError('MANIFEST_UNREACHABLE', { detail: `HTTP ${res.status}` });
  }
  const text = await res.text();
  if (text.length > MAX_MANIFEST_BYTES) {
    throw new UpdateError('MANIFEST_INVALID', { detail: `manifest is ${text.length} bytes` });
  }
  return text;
}

function parseManifest(text: string): UpdateManifest {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new UpdateError('MANIFEST_INVALID', { detail: 'not JSON', cause: e });
  }
  const parsed = ManifestSchema.safeParse(json);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `${i.path.join('.') || 'manifest'}: ${i.message}`)
      .join('; ');
    throw new UpdateError('MANIFEST_INVALID', { detail });
  }
  return normalise(parsed.data);
}

/* ─────────────────────────────── GitHub ───────────────────────────────── */

const AssetSchema = z.object({ name: z.string(), url: z.string() });
const ReleaseSchema = z.object({
  tag_name: z.string().optional(),
  draft: z.boolean().optional(),
  prerelease: z.boolean().optional(),
  assets: z.array(AssetSchema),
});

function githubHeaders(token: string | null, accept: string): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: accept,
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'ibc-contract-tracker',
  };
  if (token !== null) headers['Authorization'] = `Bearer ${token}`;
  return headers;
}

async function resolveFromGithub(repo: string, token: string | null): Promise<ResolvedManifest> {
  const releaseText = await fetchText(
    `${GITHUB_API}/repos/${repo}/releases/latest`,
    githubHeaders(token, 'application/vnd.github+json'),
  );

  let release: z.output<typeof ReleaseSchema>;
  try {
    const parsed = ReleaseSchema.safeParse(JSON.parse(releaseText));
    if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? 'unexpected shape');
    release = parsed.data;
  } catch (e) {
    throw new UpdateError('MANIFEST_INVALID', {
      detail: 'the GitHub release listing was not in the expected shape',
      cause: e,
    });
  }

  if (release.draft === true) {
    throw new UpdateError('MANIFEST_INVALID', { detail: 'latest release is a draft' });
  }

  const manifestAsset = release.assets.find((a) => a.name === MANIFEST_ASSET_NAME);
  if (manifestAsset === undefined) {
    throw new UpdateError('MANIFEST_INVALID', {
      detail: `the release has no ${MANIFEST_ASSET_NAME} asset`,
    });
  }

  const manifest = parseManifest(
    await fetchText(manifestAsset.url, githubHeaders(token, 'application/octet-stream')),
  );

  // `asset:<name>` keeps the published manifest free of anything installation
  // specific: the same file works for a public repo and a private one, and the
  // API URL that a private download needs is looked up here rather than baked in.
  if (manifest.url.startsWith(ASSET_SCHEME)) {
    const wanted = manifest.url.slice(ASSET_SCHEME.length);
    const asset = release.assets.find((a) => a.name === wanted);
    if (asset === undefined) {
      throw new UpdateError('MANIFEST_INVALID', {
        detail: `the release has no asset named ${wanted}`,
      });
    }
    return {
      manifest,
      downloadUrl: asset.url,
      authHeader: token === null ? null : `Authorization: Bearer ${token}`,
    };
  }

  if (!isAllowedUrl(manifest.url)) {
    throw new UpdateError('MANIFEST_INVALID', { detail: 'the payload URL is not an allowed one' });
  }
  return { manifest, downloadUrl: manifest.url, authHeader: null };
}

/* ──────────────────────────────── Entry ───────────────────────────────── */

export async function resolveManifest(source: UpdateSource): Promise<ResolvedManifest> {
  if (source.kind === 'none') {
    throw new UpdateError('NO_SOURCE', { detail: 'no manifestUrl and no githubRepo configured' });
  }

  const token = readToken(source);
  log.info('update.manifest.fetch', { source: source.label, authenticated: token !== null });

  if (source.kind === 'github') {
    const repo = source.githubRepo;
    if (repo === null) throw new UpdateError('NO_SOURCE', { detail: 'github source has no repo' });
    return resolveFromGithub(repo, token);
  }

  const url = source.manifestUrl;
  if (url === null) throw new UpdateError('NO_SOURCE', { detail: 'url source has no manifestUrl' });

  const headers: Record<string, string> = { Accept: 'application/json' };
  if (token !== null) headers['Authorization'] = `Bearer ${token}`;

  const manifest = parseManifest(await fetchText(url, headers));

  if (manifest.url.startsWith(ASSET_SCHEME)) {
    throw new UpdateError('MANIFEST_INVALID', {
      detail: 'asset: URLs only work with a githubRepo source',
    });
  }
  if (!isAllowedUrl(manifest.url)) {
    throw new UpdateError('MANIFEST_INVALID', { detail: 'the payload URL is not an allowed one' });
  }

  return {
    manifest,
    downloadUrl: manifest.url,
    authHeader: token === null ? null : `Authorization: Bearer ${token}`,
  };
}

/** Exported for the tests: the parser is the boundary the whole design rests on. */
export const __testing = { parseManifest };
