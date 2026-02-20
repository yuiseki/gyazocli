import axios from 'axios';
import FormData from 'form-data';
import { config } from './config';

const API_BASE_URL = 'https://api.gyazo.com/api/images';
const API_SEARCH_URL = 'https://api.gyazo.com/api/search';
const API_USERS_ME_URL = 'https://api.gyazo.com/api/users/me';
const API_UPLOAD_URL = 'https://upload.gyazo.com/api/upload';

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
  return requestWithRetry(API_BASE_URL, { page, per_page: perPage });
}

export async function getImageDetail(imageId: string): Promise<GyazoImage> {
  return requestWithRetry(`${API_BASE_URL}/${imageId}`);
}

export async function searchImages(query: string, page: number = 1, perPage: number = 20): Promise<GyazoImage[]> {
  return requestWithRetry(API_SEARCH_URL, { query, page, per: perPage });
}

export async function getCurrentUser(): Promise<GyazoMeResponse> {
  return requestWithRetry(API_USERS_ME_URL);
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

  const response = await axios.post(API_UPLOAD_URL, form, {
    headers: form.getHeaders(),
  });
  return response.data;
}
