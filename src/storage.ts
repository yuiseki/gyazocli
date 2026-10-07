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

// These pull two top-level scalars out of a cached record without building the
// whole object. On ~100k records a full JSON.parse of each (with all their
// metadata/exif/thumb URLs) costs ~20s; extracting just these two fields from
// the text is about half that. The keys are top-level and unique in a record
// (no nested created_at; exif has captured_at/updated_at, not created_at), so a
// regex anchored to the quoted key is safe here. file_size is a bare number or
// null; a null simply does not match.
const CREATED_AT_RE = /"created_at"\s*:\s*"(\d{4})-(\d{2})/;
const FILE_SIZE_RE = /"file_size"\s*:\s*(\d+)/;

/**
 * How many cached images fall in each year and month, by their created_at, so
 * cache coverage can be compared against the account's true monthly counts.
 * Shape mirrors images_summary: { [year]: { [month]: n } }. Reads every record.
 */
export function countCacheByMonth(): {
  byMonth: Record<string, Record<string, number>>;
  sizedByMonth: Record<string, Record<string, number>>;
  total: number;
  sizedTotal: number;
} {
  const byMonth: Record<string, Record<string, number>> = {};
  const sizedByMonth: Record<string, Record<string, number>> = {};
  let total = 0;
  let sizedTotal = 0;
  for (const file of iterCachedImagePaths()) {
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf-8');
    } catch {
      continue;
    }
    const m = CREATED_AT_RE.exec(text);
    if (!m) continue;
    const year = m[1];
    const month = String(Number(m[2])); // '04' -> '4', to match images_summary
    (byMonth[year] ||= {})[month] = (byMonth[year][month] || 0) + 1;
    total += 1;
    const sizeMatch = FILE_SIZE_RE.exec(text);
    if (sizeMatch && Number(sizeMatch[1]) > 0) {
      (sizedByMonth[year] ||= {})[month] = (sizedByMonth[year][month] || 0) + 1;
      sizedTotal += 1;
    }
  }
  return { byMonth, sizedByMonth, total, sizedTotal };
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

/** Total the file_size of cached images that have one. Reads each record; fetches nothing. */
export function sumCachedFileSizes(): FileSizeSummary {
  let images = 0;
  let withSize = 0;
  let totalBytes = 0;
  for (const file of iterCachedImagePaths()) {
    images += 1;
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf-8');
    } catch {
      continue; // A half-written or unreadable record does not count.
    }
    const sizeMatch = FILE_SIZE_RE.exec(text);
    if (sizeMatch) {
      withSize += 1;
      totalBytes += Number(sizeMatch[1]);
    }
  }
  return { images, withSize, totalBytes };
}

export interface DownloadItem {
  id: string;
  /** Directory holding the record, so the body lands right next to its json. */
  dir: string;
  type: string | null;
  /** The record's own body URL, when it has one. */
  url: string | null;
  fileSize: number | null;
  createdAt: string;
}

/**
 * Which cached records still lack their image body.
 *
 * The body sits beside the record as `<id>.<ext>`. Anything else beside it is not
 * a body: the json itself, the `.m.`/`.s.` markers, and a `.part` left by an
 * interrupted download. Directory listings alone answer "already have it", so a
 * record is only read when its body is missing (or when a year/month filter has
 * to know its created_at). `prefix` keeps records whose created_at starts with
 * it, e.g. "2020" or "2020-07".
 */
export function planImageDownloads(prefix?: string): { present: number; items: DownloadItem[] } {
  const root = path.join(getCacheDir(), 'images');
  const items: DownloadItem[] = [];
  let present = 0;
  if (!fs.existsSync(root)) return { present, items };
  const createdRe = /"created_at"\s*:\s*"([^"]*)"/;

  const stack = [root];
  while (stack.length) {
    const dir = stack.pop() as string;
    const names = fs.readdirSync(dir, { withFileTypes: true });
    const jsonIds: string[] = [];
    const withBody = new Set<string>();
    for (const entry of names) {
      if (entry.isDirectory()) {
        stack.push(path.join(dir, entry.name));
        continue;
      }
      const m = /^([0-9a-f]{32})\.(.+)$/.exec(entry.name);
      if (!m) continue;
      const rest = m[2];
      if (rest === 'json') jsonIds.push(m[1]);
      else if (!rest.endsWith('.part') && !/^(m|s)\./.test(rest)) withBody.add(m[1]);
    }
    for (const id of jsonIds.sort()) {
      const have = withBody.has(id);
      if (have && !prefix) {
        present += 1;
        continue;
      }
      let text: string;
      try {
        text = fs.readFileSync(path.join(dir, `${id}.json`), 'utf-8');
      } catch {
        continue;
      }
      if (prefix && !(createdRe.exec(text)?.[1] || '').startsWith(prefix)) continue;
      if (have) {
        present += 1;
        continue;
      }
      let record: any;
      try {
        record = JSON.parse(text);
      } catch {
        continue;
      }
      items.push({
        id,
        dir,
        type: typeof record?.type === 'string' && record.type ? record.type : null,
        url: typeof record?.url === 'string' && record.url ? record.url : null,
        fileSize: typeof record?.file_size === 'number' && record.file_size > 0 ? record.file_size : null,
        createdAt: String(record?.created_at || ''),
      });
    }
  }
  return { present, items };
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
  // Keep the readdir-only markers in step with every cache write, so coverage
  // and `stats size` never have to open the record again.
  writeCacheMarkers(imageId, data?.created_at, data?.file_size);
}

// Sidecar markers next to each `<id>.json`, so coverage and stats size can work
// from readdir alone -- no opening ~100k records to read two scalars. The month
// marker carries the created_at month, the size marker carries file_size in its
// own name, so a sum is pure map-reduce over filenames. Both are empty, immutable
// (a capture's date and size do not change), and written independently, which is
// why they are safe under the several syncs that run in parallel: each only ever
// creates its own files, never a shared one.
const MONTH_MARKER_RE = /^([0-9a-f]{32})\.m\.(?:(\d{4})-(\d{2})|unknown)$/;
const SIZE_MARKER_RE = /^([0-9a-f]{32})\.s\.(\d+)$/;

/** Create the markers for one record if missing. Idempotent: existing ones are left. */
export function writeCacheMarkers(imageId: string, createdAt?: string, fileSize?: unknown): void {
  const dir = path.dirname(getImagePath(imageId));
  const m = /^(\d{4})-(\d{2})/.exec(createdAt || '');
  const monthKey = m ? `${m[1]}-${m[2]}` : 'unknown';
  const monthMarker = path.join(dir, `${imageId}.m.${monthKey}`);
  try {
    if (!fs.existsSync(monthMarker)) fs.writeFileSync(monthMarker, '');
    if (typeof fileSize === 'number' && fileSize > 0) {
      const sizeMarker = path.join(dir, `${imageId}.s.${fileSize}`);
      if (!fs.existsSync(sizeMarker)) fs.writeFileSync(sizeMarker, '');
    }
  } catch {
    // A marker is an optimisation; failing to write one just means the slow
    // path is used until the next `sync --gen-marker`.
  }
}

interface MarkerScan {
  jsonCount: number;
  /** id -> [year, month] where month is '1'..'12' (or 'unknown' as year='unknown'). */
  monthById: Map<string, [string, string]>;
  /** id -> file_size in bytes. */
  bytesById: Map<string, number>;
}

/** One readdir pass over images/, classifying json files and markers by name. */
function scanMarkers(): MarkerScan {
  const root = path.join(getCacheDir(), 'images');
  const jsonRe = /^[0-9a-f]{32}\.json$/;
  const monthById = new Map<string, [string, string]>();
  const bytesById = new Map<string, number>();
  let jsonCount = 0;
  if (!fs.existsSync(root)) return { jsonCount, monthById, bytesById };
  const stack = [root];
  while (stack.length) {
    const current = stack.pop() as string;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        stack.push(path.join(current, entry.name));
        continue;
      }
      const name = entry.name;
      if (jsonRe.test(name)) {
        jsonCount += 1;
        continue;
      }
      const mm = MONTH_MARKER_RE.exec(name);
      if (mm) {
        monthById.set(mm[1], mm[2] ? [mm[2], String(Number(mm[3]))] : ['unknown', 'unknown']);
        continue;
      }
      const sm = SIZE_MARKER_RE.exec(name);
      if (sm) bytesById.set(sm[1], Number(sm[2]));
    }
  }
  return { jsonCount, monthById, bytesById };
}

/**
 * True when markers cover essentially the whole cache, so the fast path is
 * trustworthy. A small shortfall is tolerated: with several syncs running, a few
 * records are always mid-write (json on disk, marker a moment behind), and a
 * whole cache behind would mean markers were never built. 1% is well clear of
 * both.
 */
function markersComplete(scan: MarkerScan): boolean {
  return scan.jsonCount > 0 && scan.monthById.size >= scan.jsonCount * 0.99;
}

/** countCacheByMonth from markers alone (readdir, no record is opened); null if markers are incomplete. */
export function countCacheByMonthFast(): {
  byMonth: Record<string, Record<string, number>>;
  sizedByMonth: Record<string, Record<string, number>>;
  total: number;
  sizedTotal: number;
} | null {
  const scan = scanMarkers();
  if (!markersComplete(scan)) return null;
  const byMonth: Record<string, Record<string, number>> = {};
  const sizedByMonth: Record<string, Record<string, number>> = {};
  let sizedTotal = 0;
  for (const [id, [year, month]] of scan.monthById) {
    (byMonth[year] ||= {})[month] = (byMonth[year][month] || 0) + 1;
    if (scan.bytesById.has(id)) {
      (sizedByMonth[year] ||= {})[month] = (sizedByMonth[year][month] || 0) + 1;
      sizedTotal += 1;
    }
  }
  return { byMonth, sizedByMonth, total: scan.monthById.size, sizedTotal };
}

/** sumCachedFileSizes from markers alone; null if markers are incomplete. */
export function sumCachedFileSizesFast(): FileSizeSummary | null {
  const scan = scanMarkers();
  if (!markersComplete(scan)) return null;
  let totalBytes = 0;
  for (const bytes of scan.bytesById.values()) totalBytes += bytes;
  return { images: scan.jsonCount, withSize: scan.bytesById.size, totalBytes };
}

/**
 * Build the markers for every cached record (idempotent): `sync --gen-marker`.
 * Reads each record's text once to get created_at and file_size, then writes any
 * missing marker. Re-running only writes what is not already there.
 */
export function generateMarkersForCache(): { images: number; monthWritten: number; sizeWritten: number } {
  let images = 0;
  let monthWritten = 0;
  let sizeWritten = 0;
  for (const file of iterCachedImagePaths()) {
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf-8');
    } catch {
      continue;
    }
    images += 1;
    const id = path.basename(file, '.json');
    const dir = path.dirname(file);
    const m = CREATED_AT_RE.exec(text);
    const monthKey = m ? `${m[1]}-${m[2]}` : 'unknown';
    const monthMarker = path.join(dir, `${id}.m.${monthKey}`);
    try {
      if (!fs.existsSync(monthMarker)) {
        fs.writeFileSync(monthMarker, '');
        monthWritten += 1;
      }
      const sizeMatch = FILE_SIZE_RE.exec(text);
      if (sizeMatch && Number(sizeMatch[1]) > 0) {
        const sizeMarker = path.join(dir, `${id}.s.${Number(sizeMatch[1])}`);
        if (!fs.existsSync(sizeMarker)) {
          fs.writeFileSync(sizeMarker, '');
          sizeWritten += 1;
        }
      }
    } catch {
      // skip unwritable
    }
  }
  return { images, monthWritten, sizeWritten };
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
