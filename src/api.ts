import axios from 'axios';
import fs from 'node:fs';
import { pipeline } from 'node:stream/promises';
import FormData from 'form-data';
import { config } from './config';

// Every request gets a deadline. Without one, a single stalled connection
// hangs the whole process indefinitely: a `sync` was found wedged on one
// month for over two hours, the socket open and nothing arriving. Overridable
// for a slow link or a deliberately long-running probe.
const REQUEST_TIMEOUT_MS = Number(process.env.GYAZO_HTTP_TIMEOUT_MS) || 30_000;

// Rate-limit backoff. On 429 the wait grows exponentially rather than sitting
// at a fixed few seconds: a short fixed retry can keep hitting the limit and
// never let the window clear. Retry-After, when the server sends it, is a
// floor. Bounded, so a persistent 429 gives up instead of looping forever.
const RETRY_BASE_MS = Number(process.env.GYAZO_RETRY_BASE_MS) || 2_000;
const RETRY_MAX_MS = Number(process.env.GYAZO_RETRY_MAX_MS) || 60_000;
const MAX_RETRIES = Number(process.env.GYAZO_MAX_RETRIES) || 6;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const DEFAULT_API_ORIGIN = 'https://api.gyazo.com';
const DEFAULT_UPLOAD_ORIGIN = 'https://upload.gyazo.com';
const DEFAULT_WEB_ORIGIN = 'https://gyazo.com';
const DEFAULT_IMAGE_ORIGIN = 'https://i.gyazo.com';

function stripTrailingSlash(origin: string): string {
  return origin.replace(/\/+$/, '');
}

function apiOrigin(): string {
  return stripTrailingSlash(config.GYAZO_API_ORIGIN || DEFAULT_API_ORIGIN);
}

function uploadOrigin(): string {
  return stripTrailingSlash(config.GYAZO_UPLOAD_ORIGIN || DEFAULT_UPLOAD_ORIGIN);
}

function webOrigin(): string {
  return stripTrailingSlash(config.GYAZO_WEB_ORIGIN || DEFAULT_WEB_ORIGIN);
}

function imageOrigin(): string {
  return stripTrailingSlash(config.GYAZO_IMAGE_ORIGIN || DEFAULT_IMAGE_ORIGIN);
}

const apiBaseUrl = () => `${apiOrigin()}/api/images`;
const apiSearchUrl = () => `${apiOrigin()}/api/search`;
const apiUsersMeUrl = () => `${apiOrigin()}/api/users/me`;
const apiUploadUrl = () => `${uploadOrigin()}/api/upload`;
const webCollectionUrl = (id: string) => `${webOrigin()}/collections/${id}.json`;
const webBoardImagesUrl = (id: string) => `${webOrigin()}/api/internal/boards/${id}/images`;
const webImageJsonUrl = (id: string) => `${webOrigin()}/${id}.json`;
const webImagesSummaryUrl = () => `${webOrigin()}/api/internal/images_summary`;
const apiCollectionsUrl = () => `${apiOrigin()}/api/v2/collections`;
const apiCollectionUrl = (id: string) => `${apiCollectionsUrl()}/${id}`;
const apiCollectionImagesUrl = (id: string) => `${apiCollectionUrl(id)}/images`;

export interface GyazoImage {
  image_id: string;
  access_policy?: string;
  permalink_url: string;
  url: string;
  type: string;
  created_at: string;
  alt_text?: string;
  ocr?: {
    locale: string;
    description: string;
  };
  metadata?: {
    app?: string;
    title?: string;
    url?: string;
    desc?: string;
  };
}

export interface GyazoUser {
  uid?: string;
  name?: string;
  email?: string;
  is_pro?: boolean;
  is_team?: boolean;
  profile_image?: string;
}

export interface GyazoMeResponse {
  user?: GyazoUser;
}

export interface GyazoUploadOptions {
  imageData: Buffer;
  filename?: string;
  title?: string;
  app?: string;
  refererUrl?: string;
  desc?: string;
  timestamp?: number;
}

async function requestWithRetry(url: string, params: any = {}, headers?: Record<string, string>) {
  const requestHeaders =
    headers ?? { Authorization: `Bearer ${config.GYAZO_ACCESS_TOKEN}` };

  for (let attempt = 0; ; attempt++) {
    try {
      const response = await axios.get(url, {
        headers: requestHeaders,
        params,
        timeout: REQUEST_TIMEOUT_MS,
      });
      return response.data;
    } catch (error: any) {
      if (error.code === 'ECONNABORTED' || /timeout/i.test(error.message || '')) {
        throw new Error(
          `Gyazo did not respond within ${REQUEST_TIMEOUT_MS}ms. ` +
            'Retry, or raise GYAZO_HTTP_TIMEOUT_MS for a slow link.',
        );
      }
      if (error.response && error.response.status === 401) {
        // The status alone reads as a bug in the caller. It is not: the token
        // is present and Gyazo will not take it. That happens when it is
        // mistyped, when it has been revoked, and when Gyazo revokes tokens in
        // bulk, as it did after the 2026-09-11 incident.
        throw new Error(
          'Gyazo rejected the access token (401). Issue a new one at ' +
            'https://gyazo.com/oauth/applications and save it with ' +
            '`gyazo config set token <token>`.',
        );
      }
      if (error.response && error.response.status === 429) {
        if (attempt >= MAX_RETRIES) {
          throw new Error(
            `Gyazo kept rate limiting after ${MAX_RETRIES} retries. ` +
              'Wait a while before trying again; the limit is not documented and ' +
              'hammering it keeps the window from clearing.',
          );
        }
        // Exponential: base, 2x, 4x, ... capped. Retry-After is a floor.
        // Full jitter so parallel callers do not line up on the same instant.
        const backoff = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** attempt);
        const retryAfterMs = (parseInt(error.response.headers['retry-after'] || '0', 10) || 0) * 1000;
        const wait = Math.max(retryAfterMs, Math.round(Math.random() * backoff));
        console.warn(
          `Rate limited. Waiting ${(wait / 1000).toFixed(1)}s ` +
            `(retry ${attempt + 1}/${MAX_RETRIES})...`,
        );
        await sleep(wait);
        continue;
      }
      throw error;
    }
  }
}

export async function listImages(page: number = 1, perPage: number = 20): Promise<GyazoImage[]> {
  return requestWithRetry(apiBaseUrl(), { page, per_page: perPage });
}

export async function getImageDetail(imageId: string): Promise<GyazoImage> {
  return requestWithRetry(`${apiBaseUrl()}/${imageId}`);
}

export async function searchImages(query: string, page: number = 1, perPage: number = 20): Promise<GyazoImage[]> {
  return requestWithRetry(apiSearchUrl(), { query, page, per: perPage });
}

export async function getCurrentUser(): Promise<GyazoMeResponse> {
  return requestWithRetry(apiUsersMeUrl());
}

/**
 * Collections are read through the public web endpoint. It returns the
 * collection metadata plus the first 100 images with their full detail in a
 * single request, and it works without a token for public collections, which
 * is what lets an agent run read-only with no credentials at all.
 */
export async function getCollection(
  collectionId: string,
  options: { anonymous?: boolean } = {},
): Promise<any> {
  const headers: Record<string, string> = {};
  if (!options.anonymous && config.GYAZO_ACCESS_TOKEN) {
    headers.Authorization = `Bearer ${config.GYAZO_ACCESS_TOKEN}`;
  }
  return requestWithRetry(webCollectionUrl(collectionId), {}, headers);
}

export interface GyazoCollectionSummary {
  id: string;
  name?: string;
  description?: string | null;
  url?: string;
  total_image_count?: number;
  list_updated_at?: string;
}

/**
 * The collections the token can see, newest activity first as the API orders
 * them. Needed to turn a collection people call by name into an ID.
 */
export async function listCollections(): Promise<GyazoCollectionSummary[]> {
  const data = await requestWithRetry(apiCollectionsUrl());
  if (Array.isArray(data)) return data;
  return Array.isArray(data?.collections) ? data.collections : [];
}

/** A collection's own fields, without its images. */
export async function getCollectionDetail(collectionId: string): Promise<any> {
  return requestWithRetry(apiCollectionUrl(collectionId));
}

/**
 * A page of a collection's images. Unlike the public web endpoint, which
 * returns the first 100 and ignores every paging parameter, this one really
 * pages, and its images carry the raw EXIF.
 */
export async function listCollectionImages(
  collectionId: string,
  page: number = 1,
  per: number = 100,
): Promise<GyazoImage[]> {
  const data = await requestWithRetry(apiCollectionImagesUrl(collectionId), { page, per });
  if (Array.isArray(data)) return data;
  return Array.isArray(data?.images) ? data.images : [];
}

/**
 * A page of a collection's images through the web app's own ("boards") endpoint,
 * using the session cookie.
 *
 * This is the one path that tells the truth during the incident recovery: the
 * public /collections/<id>.json blanks image_id (and permalink/url) for any
 * withheld image, and the API /api/v2 endpoint answers 403, but this returns the
 * real image_id and the incident_protected flag, and it really pages. A
 * collection id works directly as the board id. `order` matches what the site
 * sends (image_desc).
 */
export async function listBoardImages(
  collectionId: string,
  page: number = 1,
  per: number = 100,
  cookieHeader: string = '',
  order: string = 'image_desc',
): Promise<any[]> {
  const data = await requestWithRetry(
    webBoardImagesUrl(collectionId),
    { page, per, order },
    { Cookie: cookieHeader, 'X-Requested-With': 'XMLHttpRequest' },
  );
  if (Array.isArray(data)) return data;
  return Array.isArray(data?.images) ? data.images : [];
}

/**
 * A capture's record through the web app's per-image JSON (`gyazo.com/<id>.json`).
 *
 * Unlike the public API detail (`/api/images/<id>`), this carries `file_size` in
 * bytes, which is the only way to total how much space captures take. It answers
 * even without a cookie for a public capture; a cookie lets a withheld one
 * through too.
 */
export async function fetchImageWebJson(imageId: string, cookieHeader?: string): Promise<any> {
  const headers: Record<string, string> = { 'X-Requested-With': 'XMLHttpRequest' };
  if (cookieHeader) headers.Cookie = cookieHeader;
  return requestWithRetry(webImageJsonUrl(imageId), {}, headers);
}

/**
 * The account's true image counts by month and day, from the web app's own
 * endpoint (`api/internal/images_summary`). This is the only source for the real
 * population size and its distribution over time: the public listing and search
 * cannot enumerate the whole account, so counting what is cached undercounts.
 * Shape: { monthly_counts: { [year]: { [month]: n } }, daily_counts: {...} }.
 */
export async function fetchImagesSummary(
  cookieHeader: string,
  timezone: string = 'Asia/Tokyo',
): Promise<any> {
  return requestWithRetry(
    webImagesSummaryUrl(),
    { timezone },
    { Cookie: cookieHeader, 'X-Requested-With': 'XMLHttpRequest' },
  );
}

/**
 * Where a capture's body can be fetched, best guess first.
 *
 * The record's own `url` is authoritative: a private (only_me) capture lives
 * under i.gyazo.com/s/<id>.<ext> while a public one is at i.gyazo.com/<id>.<ext>,
 * and only the record says which. Without it, the public path built from the
 * type is the usual one, and gyazo.com/<id>/raw redirects to wherever the body
 * really is, so it catches the rest.
 */
export function imageBodyCandidates(imageId: string, type?: string | null, url?: string | null): string[] {
  const candidates: string[] = [];
  if (url && /^https?:\/\//i.test(url)) candidates.push(url);
  if (type) candidates.push(`${imageOrigin()}/${imageId}.${type}`);
  candidates.push(`${webOrigin()}/${imageId}/raw`);
  return Array.from(new Set(candidates));
}

/** Where a capture's mp4 can be fetched: the record's own url, else the usual path. */
export function imageMp4Candidates(imageId: string, mp4Url?: string | null): string[] {
  const candidates: string[] = [];
  if (mp4Url && /^https?:\/\//i.test(mp4Url)) candidates.push(mp4Url);
  candidates.push(`${imageOrigin()}/${imageId}.mp4`);
  return Array.from(new Set(candidates));
}

const CONTENT_TYPE_EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'image/heif': 'heif',
  'image/svg+xml': 'svg',
  'video/mp4': 'mp4',
};

export type ImageBodyResult =
  | { kind: 'ok'; path: string; bytes: number; sizeDiffers?: { expected: number } }
  | { kind: 'gone' }
  | { kind: 'mismatch'; got: number; expected: number };

/** What one attempt at one URL came to: a result, a miss, or a redirect to follow. */
type AttemptOutcome = ImageBodyResult | 'notfound' | { redirect: string };

class RetryableError extends Error {
  constructor(message: string, readonly retryAfterMs = 0) {
    super(message);
  }
}

function isNetworkError(error: any): boolean {
  return (
    ['ECONNRESET', 'ETIMEDOUT', 'ECONNABORTED', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'EPIPE'].includes(error?.code) ||
    /timeout|socket hang up|aborted|stalled/i.test(error?.message || '')
  );
}

/** Retry `fn` with the same bounded, jittered exponential backoff the API calls use. */
async function withBackoff<T>(label: string, fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (error: any) {
      const retryable = error instanceof RetryableError || isNetworkError(error);
      if (!retryable) throw error;
      if (attempt >= MAX_RETRIES) {
        throw new Error(`${label}: gave up after ${MAX_RETRIES} retries (${error.message})`);
      }
      const backoff = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** attempt);
      await sleep(Math.max(error.retryAfterMs || 0, Math.round(Math.random() * backoff)));
    }
  }
}

/** The session cookie goes only to Gyazo's own hosts, never to wherever a redirect points. */
function mayReceiveCookie(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const known = [imageOrigin(), webOrigin(), apiOrigin()].map((origin) => new URL(origin).host);
  return known.includes(parsed.host) || /(^|\.)gyazo\.com$/i.test(parsed.hostname);
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * Fetch one capture's body to `<destBase>.<ext>`, trying each candidate URL until
 * one has it. A 404 moves on to the next candidate; every candidate 404ing means
 * the capture is gone. Bytes land in a `.part` file and are renamed into place
 * only once they are complete and agree with `expectedBytes`, so a crash or a
 * parallel run never leaves a half file under the real name.
 */
export async function downloadImageBody(options: {
  candidates: string[];
  destBase: string;
  ext?: string | null;
  expectedBytes?: number | null;
  cookieHeader: string;
}): Promise<ImageBodyResult> {
  const { candidates, destBase, cookieHeader } = options;

  const tryCandidate = async (start: string): Promise<ImageBodyResult | 'notfound'> => {
    let current = start;
    for (let hop = 0; hop <= 5; hop++) {
      if (!mayReceiveCookie(current)) return 'notfound';
      const outcome = await withBackoff<AttemptOutcome>(current, async () => {
        const response = await axios.get(current, {
          headers: { Cookie: cookieHeader },
          responseType: 'stream',
          maxRedirects: 0,
          timeout: REQUEST_TIMEOUT_MS,
          validateStatus: () => true,
        });
        const status = response.status;
        if (status === 404) { response.data.destroy(); return 'notfound'; }
        if (REDIRECT_STATUSES.has(status)) {
          response.data.destroy();
          return { redirect: new URL(String(response.headers.location), current).toString() };
        }
        if (status === 429 || status >= 500) {
          response.data.destroy();
          const retryAfter = (parseInt(String(response.headers['retry-after'] || '0'), 10) || 0) * 1000;
          throw new RetryableError(`HTTP ${status}`, retryAfter);
        }
        if (status !== 200) {
          response.data.destroy();
          throw new Error(`HTTP ${status} for ${current}`);
        }

        const contentType = String(response.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
        // A 200 can still be an error page. Only image/video bodies (or an
        // unlabelled binary) are taken for one.
        if (contentType && !/^(image|video)\//.test(contentType) && contentType !== 'application/octet-stream') {
          response.data.destroy();
          throw new Error(`unexpected content-type ${contentType} for ${current}`);
        }
        const ext = options.ext || CONTENT_TYPE_EXTENSIONS[contentType] || 'bin';
        const finalPath = `${destBase}.${ext}`;
        // Unique to this attempt: another process (the slow batch and a targeted run
        // can overlap) may be fetching the same image, and two of them sharing one
        // temp name would truncate each other and fail the rename. Each writes its
        // own and renames it over the final path, so whichever lands last wins with
        // identical bytes.
        const partPath = `${finalPath}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.part`;

        // A stalled body would otherwise hang a worker forever: the request
        // timeout only covers the headers.
        let last = Date.now();
        let received = 0;
        const stream = response.data;
        stream.on('data', (chunk: Buffer) => { last = Date.now(); received += chunk.length; });
        const watchdog = setInterval(() => {
          if (Date.now() - last > REQUEST_TIMEOUT_MS) stream.destroy(new Error('stalled'));
        }, Math.max(10, Math.floor(REQUEST_TIMEOUT_MS / 4)));
        try {
          await pipeline(stream, fs.createWriteStream(partPath));
        } catch (error) {
          fs.rmSync(partPath, { force: true });
          throw error;
        } finally {
          clearInterval(watchdog);
        }

        const declared = Number(response.headers['content-length']);
        if (declared && received !== declared) {
          fs.rmSync(partPath, { force: true });
          throw new RetryableError(`truncated body (${received} of ${declared} bytes)`);
        }
        // The body arrived whole whenever the server's own Content-Length agrees
        // with what came in (checked above). Gyazo's recorded file_size can still
        // differ from the file it serves -- for some PNGs both are valid with the
        // same pixels, the recorded size being of a recompressed copy -- and
        // throwing the file away for that would lose the capture. So a whole body
        // is kept and the difference is reported. Only with no Content-Length is
        // file_size the one thing that can vouch for the body, and then a
        // disagreement means a damaged transfer.
        const expected = options.expectedBytes;
        const differs = typeof expected === 'number' && expected > 0 && received !== expected;
        if (differs && !declared) {
          fs.rmSync(partPath, { force: true });
          return { kind: 'mismatch', got: received, expected: expected as number };
        }
        fs.renameSync(partPath, finalPath);
        return {
          kind: 'ok',
          path: finalPath,
          bytes: received,
          sizeDiffers: differs ? { expected: expected as number } : undefined,
        };
      });

      if (outcome === 'notfound') return 'notfound';
      if ('redirect' in outcome) { current = outcome.redirect; continue; }
      return outcome;
    }
    throw new Error(`too many redirects from ${start}`);
  };

  for (const candidate of candidates) {
    const result = await tryCandidate(candidate);
    if (result !== 'notfound') return result;
  }
  return { kind: 'gone' };
}

/**
 * Whether a capture's metadata is gone (gyazo.com/<id>.json answers 404).
 *
 * Gyazo answers 503, not 404, for the body of a capture that has been deleted, so
 * a body that will not come after its retries is either a real outage or a
 * deleted capture, and the metadata tells them apart: a deleted capture's 404s
 * too, an outage leaves it answering. Anything but a clear 404 (a 5xx, a network
 * error) counts as "not known to be deleted", so an outage is never filed away as
 * a deletion.
 */
export async function captureMetadataMissing(imageId: string, cookieHeader: string): Promise<boolean> {
  try {
    const response = await axios.get(webImageJsonUrl(imageId), {
      headers: { Cookie: cookieHeader, 'X-Requested-With': 'XMLHttpRequest' },
      timeout: REQUEST_TIMEOUT_MS,
      validateStatus: () => true,
      maxRedirects: 0,
    });
    return response.status === 404;
  } catch {
    return false;
  }
}

export type RenditionFormat = 'webp' | 'jpeg';

export interface ImageRendition {
  data: Buffer;
  mimeType: string;
  bytes: number;
  url: string;
  width: number;
  format: RenditionFormat;
}

/**
 * A width-limited rendition of a capture.
 *
 * The original can be several megabytes, which is no use to a model, and
 * resizing locally would mean a native image library. Gyazo will do it: the
 * rendition route takes a width and needs no credentials, so a capture can be
 * handed over at a size that fits. 1024 wide lands around 130 KB as webp.
 */
export async function fetchImageRendition(
  imageId: string,
  width: number,
  format: RenditionFormat = 'webp',
): Promise<ImageRendition> {
  const extension = format === 'jpeg' ? 'jpg' : 'webp';
  // The `-jpg` before the extension is a source-type marker, and it has to be
  // there: without it the route answers 404 for any capture whose derivative
  // is not already stored, which is most of them. Its value is ignored, and
  // the extension alone decides what comes back, so a constant will do.
  const url = `${imageOrigin()}/thumb/${width}_w/${imageId}-jpg.${extension}`;
  const response = await axios.get(url, { responseType: 'arraybuffer', timeout: REQUEST_TIMEOUT_MS });
  const data = Buffer.from(response.data);
  const contentType = String(response.headers['content-type'] || '').split(';')[0].trim();
  return {
    data,
    mimeType: contentType || `image/${format}`,
    bytes: data.length,
    url,
    width,
    format,
  };
}

/**
 * The web app's own endpoint for an existing capture.
 *
 * The public API takes `access_policy` when uploading and offers nothing that
 * changes it afterwards, so this speaks to the same route the site does. It
 * needs the session cookie and the CSRF token that goes with it: without the
 * token the request comes back 422 with an empty body.
 */
/**
 * The CSRF token from a capture's own page, which the internal endpoint wants
 * back. A redirect to login means the cookies are stale, so it is not followed
 * into a page that has no token.
 */
async function fetchCsrfToken(pathSegment: string, cookieHeader: string): Promise<string> {
  const page = await axios.get(`${webOrigin()}/${pathSegment}`, {
    headers: { Cookie: cookieHeader },
    responseType: 'text',
    timeout: REQUEST_TIMEOUT_MS,
    maxRedirects: 0,
    validateStatus: (status: number) => status >= 200 && status < 400,
  } as any);
  const token = String(page.data).match(/<meta name="csrf-token" content="([^"]+)"/)?.[1];
  if (!token) {
    throw new Error(
      'could not read a CSRF token from gyazo.com; the cookies are probably expired',
    );
  }
  return token;
}

async function patchAccessPolicy(
  imageId: string,
  accessPolicy: 'anyone' | 'only_me',
  cookieHeader: string,
  token: string,
): Promise<any> {
  const response = await axios.patch(
    `${webOrigin()}/api/internal/images/${imageId}`,
    { access_policy: accessPolicy },
    {
      timeout: REQUEST_TIMEOUT_MS,
      headers: {
        Cookie: cookieHeader,
        'Content-Type': 'application/json',
        'X-CSRF-Token': token,
        'X-Requested-With': 'XMLHttpRequest',
      },
    },
  );
  return response.data;
}

export async function setAccessPolicy(
  imageId: string,
  accessPolicy: 'anyone' | 'only_me',
  cookieHeader: string,
): Promise<any> {
  const token = await fetchCsrfToken(imageId, cookieHeader);
  return patchAccessPolicy(imageId, accessPolicy, cookieHeader, token);
}

/**
 * Poke a capture's access policy so Gyazo re-materialises it: only_me, then
 * back to anyone. After the 2026-09-11 incident some public images stopped
 * being delivered, and this cycle brings one back while leaving it public.
 * One CSRF token serves both steps.
 */
export async function touchAccessPolicy(imageId: string, cookieHeader: string): Promise<void> {
  const token = await fetchCsrfToken(imageId, cookieHeader);
  await patchAccessPolicy(imageId, 'only_me', cookieHeader, token);
  await patchAccessPolicy(imageId, 'anyone', cookieHeader, token);
}

/**
 * Lift the incident protection that Gyazo put on pre-breach images after the
 * 2026-09-11 incident, which is what "配信を再開する" (resume distribution)
 * does. This is a flag of its own, separate from access_policy, so clearing it
 * restores a capture to whatever visibility it already had and never makes a
 * deliberately private (only_me) capture public.
 *
 * The endpoint takes a batch of image_ids in one PATCH, so a whole list is a
 * few calls rather than one per capture. One CSRF token serves the run; it is
 * read from the first capture's page.
 *
 * The direction here -- PATCH clears the protection -- is the shape given for
 * the "resume distribution" action; confirm it on a single capture before a
 * bulk run, since it cannot be checked without hitting the live site.
 */
export async function resumeDistribution(
  imageIds: string[],
  cookieHeader: string,
  token: string,
): Promise<any> {
  const response = await axios.patch(
    `${webOrigin()}/api/internal/images_incident_protection`,
    { image_ids: imageIds },
    {
      timeout: REQUEST_TIMEOUT_MS,
      headers: {
        Cookie: cookieHeader,
        'Content-Type': 'application/json',
        'X-CSRF-Token': token,
        'X-Requested-With': 'XMLHttpRequest',
      },
    },
  );
  return response.data;
}

/**
 * A CSRF token for a run of batched calls. It must NOT come from a target
 * capture's page: incident-protected captures 404 on their own permalink, so
 * reading the token from one is exactly the case restore is for. The token is
 * per-session anyway, so it is read from a page that always renders for a
 * logged-in user. /captures is the dashboard; /settings is the fallback.
 */
export async function csrfTokenForRun(cookieHeader: string): Promise<string> {
  const pages = ['captures', 'settings'];
  let lastError: unknown;
  for (const page of pages) {
    try {
      return await fetchCsrfToken(page, cookieHeader);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error('could not read a CSRF token from gyazo.com');
}

export async function uploadImage(options: GyazoUploadOptions): Promise<GyazoImage> {
  const form = new FormData();
  form.append('access_token', config.GYAZO_ACCESS_TOKEN || '');
  form.append('imagedata', options.imageData, {
    filename: options.filename || 'upload.bin',
  });

  if (options.title) form.append('title', options.title);
  if (options.app) form.append('app', options.app);
  if (options.refererUrl) form.append('referer_url', options.refererUrl);
  if (options.desc) form.append('desc', options.desc);
  if (typeof options.timestamp === 'number') {
    form.append('created_at', String(options.timestamp));
  }

  const response = await axios.post(apiUploadUrl(), form, {
    timeout: REQUEST_TIMEOUT_MS,
    headers: form.getHeaders(),
  });
  return response.data;
}
