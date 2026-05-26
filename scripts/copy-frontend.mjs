/* Assemble the Tauri frontend bundle.
 *
 * Tauri's `frontendDist` points at ./dist. This copies only the runtime web
 * assets there (HTML/CSS/JS/image/fonts) and deliberately leaves out the
 * repo's source-only files (the .af Affinity source, the manual PDF, the
 * keypad CSV, README, etc.) so they don't bloat the packaged app.
 *
 * Run automatically via tauri.conf.json `beforeDevCommand` / `beforeBuildCommand`,
 * or manually with `npm run frontend`.
 */
import { cp, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');

// Files/dirs that make up the running app.
const ASSETS = [
  'index.html',
  'styles.css',
  'app.js',
  'nevco_mpcw7_hockey.png',
  'fonts',
];

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

for (const name of ASSETS) {
  const src = join(root, name);
  if (!existsSync(src)) {
    console.error(`copy-frontend: missing asset "${name}"`);
    process.exit(1);
  }
  await cp(src, join(dist, name), { recursive: true });
}

console.log(`copy-frontend: staged ${ASSETS.length} assets into dist/`);
