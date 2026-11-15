import { readdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

// Resolve paths from this file so cleaning never depends on the caller's cwd.
const root = fileURLToPath(new URL('../', import.meta.url));
const generated = [
  'node_modules', 'dist', '.angular', 'out-tsc', 'exports',
  '.cache', '.npm', 'coverage', '.nyc_output', 'data/ocr-cache',
];
for (const name of await readdir(root)) {
  if (/\.traineddata(?:\.gz)?$/.test(name)
    || /\.tsbuildinfo$/.test(name)
    || /^npm-debug\.log(?:\..*)?$/.test(name)) {
    generated.push(name);
  }
}
for (const path of generated) {
  await rm(join(root, path), { recursive: true, force: true });
}
console.log('Removed dependencies, build output, exports, and local caches. Run npm ci to reinstall.');
