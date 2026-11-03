import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/**
 * Minimal .env loader. Node's own --env-file is not available on every
 * supported version, and we would rather not add a dependency for this.
 *
 * Searches the current directory and its parents, so running from a workspace
 * package still picks up the repository-level .env. Existing environment
 * variables always win.
 */
export function loadDotEnv(file = '.env', maxDepth = 5): string | null {
  let dir = process.cwd();
  for (let i = 0; i <= maxDepth; i++) {
    const path = resolve(dir, file);
    if (existsSync(path)) {
      apply(readFileSync(path, 'utf8'));
      return path;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function apply(text: string): void {
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
