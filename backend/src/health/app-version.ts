import * as fs from 'fs';
import * as path from 'path';

/**
 * Resolve the current application version, preferring the explicit
 * `APP_VERSION` env var injected by Electron at fork time (see
 * electron/main.ts). Falls back to walking up from this file's location
 * to find the root `package.json` — handy in dev mode where the backend
 * runs without an Electron parent.
 */
export function resolveAppVersion(): {
  version: string;
  source: 'env' | 'package' | 'unknown';
} {
  const fromEnv = process.env.APP_VERSION;
  if (fromEnv && fromEnv.trim().length > 0) {
    return { version: fromEnv.trim(), source: 'env' };
  }
  for (let dir = __dirname, hops = 0; hops < 8; hops++) {
    const candidate = path.join(dir, 'package.json');
    if (fs.existsSync(candidate)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(candidate, 'utf8')) as { name?: string; version?: string };
        // The backend's own package.json reads "name": "backend" — skip it and
        // keep climbing until we hit the root package ("name": "parentsync").
        if (pkg.name === 'parentsync' && pkg.version) {
          return { version: pkg.version, source: 'package' };
        }
      } catch {
        // malformed JSON — keep walking
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return { version: '0.0.0', source: 'unknown' };
}
