import fs from 'fs';
import path from 'path';
import os from 'os';

export function getCacheDir(): string {
  if (process.env.GYAZO_CACHE_DIR) {
    return process.env.GYAZO_CACHE_DIR;
  }
  const cacheBase = process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
  const dir = path.join(cacheBase, 'gyazocli');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

export function getImagePath(imageId: string): string {
  const prefix1 = imageId[0] || '_';
  const prefix2 = imageId[1] || '_';
  const dir = path.join(getCacheDir(), 'images', prefix1, prefix2);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return path.join(dir, `${imageId}.json`);
}

export function getSearchImagePath(imageId: string): string {
  const prefix1 = imageId[0] || '_';
  const prefix2 = imageId[1] || '_';
  const dir = path.join(getCacheDir(), 'search_images', prefix1, prefix2);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return path.join(dir, `${imageId}.json`);
}

export function getHourlyPath(year: string, month: string, day: string, hour: string): string {
  const dir = path.join(getCacheDir(), 'hourly', year, month, day);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return path.join(dir, `${hour}.json`);
}

export type HourlyMetadataKind = 'apps' | 'domains' | 'tags';

function getHourlyMetadataPath(
  kind: HourlyMetadataKind,
  year: string,
  month: string,
  day: string,
  hour: string,
): string {
  const dir = path.join(getCacheDir(), 'hourly', year, month, day);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return path.join(dir, `${hour}-${kind}.json`);
}

export function saveImageCache(imageId: string, data: any): void {
  const filePath = getImagePath(imageId);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

export function loadImageCache(imageId: string): any | null {
  const filePath = getImagePath(imageId);
  if (fs.existsSync(filePath)) {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  }
  return null;
}

export function saveSearchImageCache(imageId: string, data: any): void {
  const filePath = getSearchImagePath(imageId);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

export function loadSearchImageCache(imageId: string): any | null {
  const filePath = getSearchImagePath(imageId);
  if (fs.existsSync(filePath)) {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  }
  return null;
}

export function saveHourlyCache(year: string, month: string, day: string, hour: string, imageIds: string[]): void {
  const filePath = getHourlyPath(year, month, day, hour);
  fs.writeFileSync(filePath, JSON.stringify(imageIds, null, 2), 'utf-8');
}

export function loadHourlyCache(year: string, month: string, day: string, hour: string): string[] | null {
  const filePath = getHourlyPath(year, month, day, hour);
  if (fs.existsSync(filePath)) {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  }
  return null;
}

export function saveHourlyMetadataCache(
  kind: HourlyMetadataKind,
  year: string,
  month: string,
  day: string,
  hour: string,
  valuesByImageId: Record<string, string[]>,
): void {
  const filePath = getHourlyMetadataPath(kind, year, month, day, hour);
  fs.writeFileSync(filePath, JSON.stringify(valuesByImageId, null, 2), 'utf-8');
}

export function loadHourlyMetadataCache(
  kind: HourlyMetadataKind,
  year: string,
  month: string,
  day: string,
  hour: string,
): Record<string, string[]> | null {
  const filePath = getHourlyMetadataPath(kind, year, month, day, hour);
  if (fs.existsSync(filePath)) {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  }
  return null;
}
