import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

// Check every backend module, including modules added after this script.
for (const file of readdirSync('server').filter((file) => file.endsWith('.mjs'))) {
  const result = spawnSync(process.execPath, ['--check', `server/${file}`], { stdio: 'inherit' });
  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
