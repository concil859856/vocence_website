#!/usr/bin/env node
/**
 * Lists raster images in public/abstract/ and writes public/abstract/manifest.json
 * so the app can pick random card art without bundling each file (e.g. My voices cards via MyVoiceCardArt).
 *
 * Run after adding images: npm run abstract:manifest
 * Runs automatically before dev/build via package.json hooks.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const abstractDir = path.join(__dirname, '..', 'public', 'abstract');
const outPath = path.join(abstractDir, 'manifest.json');

const EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);

let files = [];
try {
  files = fs.readdirSync(abstractDir);
} catch {
  fs.mkdirSync(abstractDir, { recursive: true });
  files = [];
}

const images = files
  .filter((f) => f !== 'manifest.json' && EXTS.has(path.extname(f).toLowerCase()))
  .sort((a, b) => a.localeCompare(b))
  .map((f) => `/abstract/${encodeURIComponent(f)}`);

fs.writeFileSync(outPath, `${JSON.stringify({ images }, null, 2)}\n`, 'utf8');
console.log(`abstract manifest: ${images.length} image(s) -> ${path.relative(process.cwd(), outPath)}`);
