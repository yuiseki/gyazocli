import axios from 'axios';
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
async function fetchCsrfToken(imageId: string, cookieHeader: string): Promise<string> {
  const page = await axios.get(`${webOrigin()}/${imageId}`, {
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
