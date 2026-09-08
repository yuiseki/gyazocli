/**
 * Turning what a human or an agent typed into a Gyazo ID. Kept apart from the
 * CLI itself so that other entry points, such as the MCP server, can reuse it
 * without loading commander and its commands.
 */

const IMAGE_ID_PATTERN = /^[0-9a-f]{32}$/i;
const GYAZO_HOST_PATTERN = /(^|\.)gyazo\.com$/i;

/**
 * Accept either a bare Gyazo image id (32 hex characters) or any Gyazo URL that
 * carries one, and return the canonical lowercase id. Returns null otherwise.
 */
export function normalizeImageId(input: string): string | null {
  const trimmed = (input || '').trim();
  if (!trimmed) return null;

  if (IMAGE_ID_PATTERN.test(trimmed)) {
    return trimmed.toLowerCase();
  }

  if (!/^https?:\/\//i.test(trimmed)) {
    return null;
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (!GYAZO_HOST_PATTERN.test(url.hostname)) {
    return null;
  }

  const segments = url.pathname.split('/').filter(Boolean);
  const lastSegment = segments[segments.length - 1];
  if (!lastSegment) return null;
  // /collections/<id> is a collection, not an image.
  if (segments[segments.length - 2] === 'collections') return null;
  const withoutExtension = lastSegment.replace(/\.[a-z0-9]+$/i, '');
  return IMAGE_ID_PATTERN.test(withoutExtension) ? withoutExtension.toLowerCase() : null;
}

/**
 * A collection ID looks exactly like an image ID (32 hex characters), so only
 * the URL form tells the two apart. `/collections/<id>` is a collection;
 * `/<id>` is an image.
 */
export function normalizeCollectionId(input: string): string | null {
  const trimmed = (input || '').trim();
  if (!trimmed) return null;

  if (IMAGE_ID_PATTERN.test(trimmed)) {
    return trimmed.toLowerCase();
  }

  if (!/^https?:\/\//i.test(trimmed)) {
    return null;
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (!GYAZO_HOST_PATTERN.test(url.hostname)) {
    return null;
  }

  const segments = url.pathname.split('/').filter(Boolean);
  if (segments.length < 2 || segments[segments.length - 2] !== 'collections') {
    return null;
  }
  const withoutExtension = segments[segments.length - 1].replace(/\.[a-z0-9]+$/i, '');
  return IMAGE_ID_PATTERN.test(withoutExtension) ? withoutExtension.toLowerCase() : null;
}

