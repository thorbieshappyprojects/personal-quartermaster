import { build } from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';

await rm('dist', { recursive: true, force: true });
await build({
  entryPoints: { main: 'src/main.ts', cli: 'src/cli.ts', healthcheck: 'src/healthcheck.ts' },
  outdir: 'dist',
  outExtension: { '.js': '.mjs' },
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  splitting: true,
  sourcemap: true,
  legalComments: 'external',
  external: ['pg-native', 'sharp'],
  banner: { js: "import { createRequire as __pqCreateRequire } from 'node:module'; const require = __pqCreateRequire(import.meta.url);" },
  logLevel: 'warning',
});
await mkdir('dist/migrations', { recursive: true });
await cp('../../packages/db/migrations', 'dist/migrations', { recursive: true });
