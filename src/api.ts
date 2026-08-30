import axios from 'axios';
import FormData from 'form-data';
import { config } from './config';

const DEFAULT_API_ORIGIN = 'https://api.gyazo.com';
const DEFAULT_UPLOAD_ORIGIN = 'https://upload.gyazo.com';

function stripTrailingSlash(origin: string): string {
  return origin.replace(/\/+$/, '');
}

function apiOrigin(): string {
  return stripTrailingSlash(config.GYAZO_API_ORIGIN || DEFAULT_API_ORIGIN);
}

function uploadOrigin(): string {
  return stripTrailingSlash(config.GYAZO_UPLOAD_ORIGIN || DEFAULT_UPLOAD_ORIGIN);
}

const apiBaseUrl = () => `${apiOrigin()}/api/images`;
const apiSearchUrl = () => `${apiOrigin()}/api/search`;
const apiUsersMeUrl = () => `${apiOrigin()}/api/users/me`;
const apiUploadUrl = () => `${uploadOrigin()}/api/upload`;

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

async function requestWithRetry(url: string, params: any = {}) {
  const headers = { Authorization: `Bearer ${config.GYAZO_ACCESS_TOKEN}` };
  
  try {
    const response = await axios.get(url, { headers, params });
    return response.data;
  } catch (error: any) {
    if (error.response && error.response.status === 429) {
      const retryAfter = parseInt(error.response.headers['retry-after'] || '5', 10);
      console.warn(`Rate limited. Retrying after ${retryAfter} seconds...`);
      await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
      return requestWithRetry(url, params);
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
