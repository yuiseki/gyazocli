import axios from 'axios';
import FormData from 'form-data';
import { config } from './config';

const DEFAULT_API_ORIGIN = 'https://api.gyazo.com';
const DEFAULT_UPLOAD_ORIGIN = 'https://upload.gyazo.com';
const DEFAULT_WEB_ORIGIN = 'https://gyazo.com';

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

const apiBaseUrl = () => `${apiOrigin()}/api/images`;
const apiSearchUrl = () => `${apiOrigin()}/api/search`;
const apiUsersMeUrl = () => `${apiOrigin()}/api/users/me`;
const apiUploadUrl = () => `${uploadOrigin()}/api/upload`;
const webCollectionUrl = (id: string) => `${webOrigin()}/collections/${id}.json`;

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
