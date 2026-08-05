import type { NextConfig } from 'next';

const config: NextConfig = {
  reactStrictMode: true,

  // Both do dynamic requires that a bundler cannot follow. pdfjs in particular
  // fails on its own internals once bundled -- it threw PDF_UNREADABLE on files it
  // had already read fine. The client gets the worker from public/ instead, so
  // nothing needs bundler resolution.
  serverExternalPackages: ['exceljs', 'pdfjs-dist'],

  experimental: {
    serverActions: { bodySizeLimit: '64mb' },
    // We are on TypeScript 7, whose compiler API Next cannot drive directly.
    // `npm run typecheck` runs the same tsc and is clean, so this only changes
    // how the build shells out to it.
    useTypeScriptCli: true,
  },

  // The dev indicator parks itself bottom-left, exactly where our sidebar keeps
  // Settings and the engine pill. Dev-only, but it makes design review harder.
  devIndicators: false,

  // Local-only tool. No image optimisation service, no telemetry.
  images: { unoptimized: true },
};

export default config;
