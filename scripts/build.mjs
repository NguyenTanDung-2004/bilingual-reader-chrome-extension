// Build script: bundles each entry point with esbuild and copies static
// assets (manifest, icons, html, css) into dist/. Run with --watch for
// incremental rebuilds during development.
import esbuild from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dist = path.join(root, 'dist');
const watch = process.argv.includes('--watch');

// The service worker is declared "type": "module" in manifest.json, so it
// alone is bundled as ESM. Everything else (content script injected via
// chrome.scripting.executeScript, and the plain <script> tags in the html
// pages) must be a self-contained classic script - bundled as IIFE.
const esmEntries = {
  'service-worker': 'src/background/service-worker.ts',
};
const iifeEntries = {
  content: 'src/content/index.ts',
  reader: 'src/reader/reader.ts',
  popup: 'src/popup/popup.ts',
  vocab: 'src/vocab/vocab.ts',
  options: 'src/options/options.ts',
};

const staticCopies = [
  ['public/manifest.json', 'manifest.json'],
  ['public/icons', 'icons'],
  ['src/reader/reader.html', 'reader.html'],
  ['src/reader/reader.css', 'reader.css'],
  ['src/popup/popup.html', 'popup.html'],
  ['src/popup/popup.css', 'popup.css'],
  ['src/vocab/vocab.html', 'vocab.html'],
  ['src/vocab/vocab.css', 'vocab.css'],
  ['src/options/options.html', 'options.html'],
];

async function copyStatic() {
  await mkdir(dist, { recursive: true });
  for (const [from, to] of staticCopies) {
    const src = path.join(root, from);
    if (!existsSync(src)) {
      console.warn(`[build] skip missing static asset: ${from}`);
      continue;
    }
    await cp(src, path.join(dist, to), { recursive: true });
  }
}

async function main() {
  await rm(dist, { recursive: true, force: true });
  await mkdir(dist, { recursive: true });

  const common = {
    outdir: dist,
    bundle: true,
    target: 'chrome120',
    sourcemap: true,
    logLevel: 'info',
  };

  const esmOptions = {
    ...common,
    entryPoints: Object.fromEntries(
      Object.entries(esmEntries).map(([name, file]) => [name, path.join(root, file)])
    ),
    format: 'esm',
  };
  const iifeOptions = {
    ...common,
    entryPoints: Object.fromEntries(
      Object.entries(iifeEntries).map(([name, file]) => [name, path.join(root, file)])
    ),
    format: 'iife',
  };

  if (watch) {
    const ctxs = await Promise.all([esbuild.context(esmOptions), esbuild.context(iifeOptions)]);
    await Promise.all(ctxs.map((ctx) => ctx.watch()));
    await copyStatic();
    console.log('[build] watching for changes... (static assets copied once; re-run build for static edits)');
  } else {
    await Promise.all([esbuild.build(esmOptions), esbuild.build(iifeOptions)]);
    await copyStatic();
    console.log('[build] done ->', dist);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
