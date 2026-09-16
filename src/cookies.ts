/**
 * Browser cookies for gyazo.com, for the one thing the API cannot do.
 *
 * `access_policy` is an upload parameter and there is no endpoint that updates
 * it afterwards, so making an existing capture private means asking the web
 * app the way the web app asks itself: a session cookie and a CSRF token.
 *
 * The file holds a live session. It is read when needed, never logged, and
 * never written to.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

const GYAZO_DOMAIN = /(^|\.)gyazo\.com$/i;

/**
 * Where to look, nearest intention first. A file named outright is the only
 * candidate: falling back from a path someone gave would use credentials they
 * did not point at, which is the last thing this should do.
 */
function candidatePaths(): string[] {
  if (process.env.GYAZO_COOKIE_FILE) return [process.env.GYAZO_COOKIE_FILE];
  const paths: string[] = [];
  const home = os.homedir();
  paths.push(path.join(home, '.config', 'gyazo', 'cookie.json'));
  paths.push(path.join(home, '.config', 'gyazo', 'cookies.json'));
  // Handy while working in a checkout, though it only applies from there.
  paths.push(path.join(process.cwd(), '.cookies', 'gyazo.com.json'));
  return paths;
}

export function findCookieFile(explicit?: string): string | undefined {
  const paths = explicit ? [explicit] : candidatePaths();
  return paths.find((candidate) => fs.existsSync(candidate));
}

/**
 * A `Cookie` header from whatever shape the file is in: a browser export
 * (an array of `{name, value, domain}`), a plain `{name: value}` object, or a
 * header string already. Entries belonging to another domain are left out.
 */
export function buildCookieHeader(contents: string): string | undefined {
  const trimmed = contents.trim();
  if (trimmed === '') return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    // Already a header, or a cookie file this does not understand.
    return trimmed.includes('=') ? trimmed : undefined;
  }

  const pairs: string[] = [];
  if (Array.isArray(parsed)) {
    for (const entry of parsed as any[]) {
      if (!entry || typeof entry.name !== 'string') continue;
      if (typeof entry.domain === 'string' && !GYAZO_DOMAIN.test(entry.domain.replace(/^\./, ''))) {
        continue;
      }
      pairs.push(`${entry.name}=${entry.value ?? ''}`);
    }
  } else if (parsed && typeof parsed === 'object') {
    for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'string') pairs.push(`${name}=${value}`);
    }
  }

  return pairs.length > 0 ? pairs.join('; ') : undefined;
}

export function loadCookieHeader(explicit?: string): string | undefined {
  const file = findCookieFile(explicit);
  if (!file) return undefined;
  try {
    return buildCookieHeader(fs.readFileSync(file, 'utf-8'));
  } catch {
    return undefined;
  }
}
