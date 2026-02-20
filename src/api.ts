import axios from 'axios';
import { config } from './config';

const API_BASE_URL = 'https://api.gyazo.com/api/images';
const API_SEARCH_URL = 'https://api.gyazo.com/api/search';

export interface GyazoImage {
  image_id: string;
  permalink_url: string;
  url: string;
  type: string;
  created_at: string;
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

async function requestWithRetry(url: string, params: any = {}) {
  const headers = { Authorization: `Bearer ${config.GYAZO_ACCESS_TOKEN}` };
  
  try {
    const response = await axios.get(url, { headers, params });
    return response.data;
  } catch (error: any) {
    if (error.response && error.status === 429) {
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
