import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
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

/** Count every `.json` file under a directory, walking subdirectories. */
function countJsonFiles(dir: string): number {
  if (!fs.existsSync(dir)) return 0;
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      total += countJsonFiles(full);
    } else if (entry.isFile() && entry.name.endsWith('.json')) {
      total += 1;
    }
  }
  return total;
}

export interface CacheCounts {
  /** Image detail records: the authoritative "how many images are cached". */
  images: number;
  /** Thinner records seen only through search, not yet fetched in full. */
  searchImages: number;
  /** Hourly index files (ids per hour), not image counts. */
  hourlyFiles: number;
  cacheDir: string;
}

/** Every cached image detail file path, walking the images/ tree. */
function* iterCachedImagePaths(): Generator<string> {
  const dir = path.join(getCacheDir(), 'images');
  if (!fs.existsSync(dir)) return;
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop() as string;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile() && entry.name.endsWith('.json')) yield full;
    }
  }
}

export interface FileSizeSummary {
  /** Cached image records in total. */
  images: number;
  /** Of those, how many carry a numeric file_size. */
  withSize: number;
  /** Sum of the known file_size values, in bytes. */
  totalBytes: number;
}

/** Total the file_size of cached images. Reads each record; fetches nothing. */
export function sumCachedFileSizes(): FileSizeSummary {
  let images = 0;
  let withSize = 0;
  let totalBytes = 0;
  for (const file of iterCachedImagePaths()) {
    images += 1;
    try {
      const record = JSON.parse(fs.readFileSync(file, 'utf-8'));
      if (typeof record?.file_size === 'number') {
        withSize += 1;
        totalBytes += record.file_size;
      }
    } catch {
      // A half-written or corrupt record just does not count toward the size.
    }
  }
  return { images, withSize, totalBytes };
}

/** Image ids whose cached record has no numeric file_size yet, up to `limit`. */
export function cachedImageIdsMissingFileSize(limit?: number): string[] {
  const ids: string[] = [];
  for (const file of iterCachedImagePaths()) {
    if (limit && ids.length >= limit) break;
    try {
      const record = JSON.parse(fs.readFileSync(file, 'utf-8'));
      if (typeof record?.file_size !== 'number') {
        const id = record?.image_id || path.basename(file, '.json');
        if (id) ids.push(id);
      }
    } catch {
      // Skip unreadable records; a re-fetch would overwrite them anyway.
    }
  }
  return ids;
}

/**
 * A uniform random sample of `n` cached image ids, by reservoir sampling over
 * the whole images/ tree in one pass. Used to estimate a population total (e.g.
 * cumulative file size) without fetching every record.
 */
export function sampleCachedImageIds(n: number): string[] {
  if (n <= 0) return [];
  const reservoir: string[] = [];
  let seen = 0;
  for (const file of iterCachedImagePaths()) {
    const id = path.basename(file, '.json');
    if (reservoir.length < n) {
      reservoir.push(id);
    } else {
      const j = Math.floor(Math.random() * (seen + 1));
      if (j < n) reservoir[j] = id;
    }
    seen += 1;
  }
  return reservoir;
}

/** Merge a fetched file_size into a cached record, without touching the rest. */
export function setCachedFileSize(imageId: string, fileSize: number): void {
  const record = loadImageCache(imageId) || { image_id: imageId };
  record.file_size = fileSize;
  saveImageCache(imageId, record);
}

/** How much is in the local cache, by kind. Counts files; reads none of them. */
export function countCache(): CacheCounts {
  const cacheDir = getCacheDir();
  return {
    images: countJsonFiles(path.join(cacheDir, 'images')),
    searchImages: countJsonFiles(path.join(cacheDir, 'search_images')),
    hourlyFiles: countJsonFiles(path.join(cacheDir, 'hourly')),
    cacheDir,
  };
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

export type HourlyMetadataKind = 'apps' | 'domains' | 'tags' | 'locations';

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

/**
 * Where a walk of a query got to, so the next one can pick up instead of
 * asking the API for pages it has already seen. Keyed by the query itself.
 */
export interface SyncState {
  query: string;
  oldestDay: string;
  updatedAt: string;
}

function getSyncStatePath(query: string): string {
  const dir = path.join(getCacheDir(), 'sync');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const key = crypto.createHash('sha1').update(query).digest('hex');
  return path.join(dir, `${key}.json`);
}

export function loadSyncState(query: string): SyncState | null {
  const file = getSyncStatePath(query);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return null;
  }
}

export function saveSyncState(state: SyncState): void {
  fs.writeFileSync(getSyncStatePath(state.query), JSON.stringify(state, null, 2));
}
