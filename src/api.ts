import axios from 'axios';
import FormData from 'form-data';
import { config } from './config';

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

  try {
    const response = await axios.get(url, { headers: requestHeaders, params });
    return response.data;
  } catch (error: any) {
    if (error.response && error.response.status === 429) {
      const retryAfter = parseInt(error.response.headers['retry-after'] || '5', 10);
      console.warn(`Rate limited. Retrying after ${retryAfter} seconds...`);
      await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
      return requestWithRetry(url, params, headers);
    }
    throw error;
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
  const url = `${imageOrigin()}/thumb/${width}_w/${imageId}.${extension}`;
  const response = await axios.get(url, { responseType: 'arraybuffer' });
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
    headers: form.getHeaders(),
  });
  return response.data;
}
