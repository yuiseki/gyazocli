/**
 * The memory this CLI keeps: the local cache of captures, and the walks over
 * the Gyazo API that fill it. A command asks for a day or a range, and this
 * layer answers from the cache when it can, fetching and writing through when
 * it cannot.
 *
 * Two shapes are cached. Whole images, keyed by ID, and hourly buckets holding
 * the IDs captured in that hour plus the metadata the rankings count, so a
 * ranking does not have to open every image to answer.
 */
import { listImages, getImageDetail, searchImages } from '../api';
import {
  saveImageCache,
  loadImageCache,
  saveHourlyCache,
  loadHourlyCache,
  saveSearchImageCache,
  loadSearchImageCache,
  saveHourlyMetadataCache,
  loadHourlyMetadataCache,
  type HourlyMetadataKind,
} from '../storage';
import {
  type ParsedDateOption,
  buildHourlyBucketKey,
  splitHourlyBucketKey,
  getDatePartsInRange,
  getDateHourStrings,
  toDateParts,
} from '../dates';
import {
  normalizeText,
  mergeImageForDisplay,
  normalizeRankingValues,
  extractImageApps,
  extractImageDomains,
  extractImageLocations,
  extractImageTags,
} from '../format';

export type MetadataValueExtractor = (image: any) => string[];

export type HourlyMetadataCacheEntries = Record<string, string[]>;

export function loadImageIdsFromDateRangeCache(targetDate: ParsedDateOption): string[] {
  const imageIds = new Set<string>();
  const dates = getDatePartsInRange(targetDate.start, targetDate.end);
  const hours = getDateHourStrings();

  for (const date of dates) {
    for (const hour of hours) {
      const ids = loadHourlyCache(date.year, date.month, date.day, hour) || [];
      for (const id of ids) imageIds.add(id);
    }
  }

  return Array.from(imageIds);
}

export function normalizeHourlyMetadataEntries(
  valuesByImageId: Record<string, unknown> | null | undefined,
): HourlyMetadataCacheEntries {
  if (!valuesByImageId || typeof valuesByImageId !== 'object') return {};

  const normalized: HourlyMetadataCacheEntries = {};
  for (const [imageId, rawValues] of Object.entries(valuesByImageId)) {
    const values = Array.isArray(rawValues)
      ? rawValues.map(value => String(value))
      : [];
    normalized[imageId] = normalizeRankingValues(values);
  }
  return normalized;
}

export async function warmDateCacheForApps(
  targetDate: ParsedDateOption,
  maxPages: number,
  useCache: boolean,
): Promise<string[]> {
  return warmDateCacheForRanking(
    targetDate,
    maxPages,
    useCache,
    'apps',
    extractImageApps,
  );
}

export async function warmDateCacheForDomains(
  targetDate: ParsedDateOption,
  maxPages: number,
  useCache: boolean,
): Promise<string[]> {
  return warmDateCacheForRanking(
    targetDate,
    maxPages,
    useCache,
    'domains',
    extractImageDomains,
  );
}

export async function warmDateCacheForTags(
  targetDate: ParsedDateOption,
  maxPages: number,
  useCache: boolean,
): Promise<string[]> {
  return warmDateCacheForRanking(
    targetDate,
    maxPages,
    useCache,
    'tags',
    extractImageTags,
  );
}

export async function warmDateCacheForLocations(
  targetDate: ParsedDateOption,
  maxPages: number,
  useCache: boolean,
): Promise<string[]> {
  return warmDateCacheForRanking(
    targetDate,
    maxPages,
    useCache,
    'locations',
    extractImageLocations,
  );
}

export async function warmDateCacheForList(
  targetDate: ParsedDateOption,
  maxPages: number,
  useCache: boolean,
): Promise<string[]> {
  const hourlyIndices: Map<string, Set<string>> = new Map();
  const imageIds: Set<string> = new Set();

  for (let page = 1; page <= maxPages; page++) {
    const images = await listImages(page, 100);
    if (images.length === 0) break;

    let reachedLimit = false;
    for (const img of images) {
      const createdAt = new Date(img.created_at);
      if (Number.isNaN(createdAt.getTime())) continue;

      if (createdAt > targetDate.end) continue;
      if (createdAt < targetDate.start) {
        reachedLimit = true;
        break;
      }

      const dateParts = toDateParts(createdAt);
      const bucketKey = buildHourlyBucketKey(
        dateParts.year,
        dateParts.month,
        dateParts.day,
        dateParts.hour,
      );
      if (!hourlyIndices.has(bucketKey)) {
        hourlyIndices.set(bucketKey, new Set());
      }

      hourlyIndices.get(bucketKey)?.add(img.image_id);
      imageIds.add(img.image_id);

      let merged = img;
      const cached = useCache ? loadImageCache(img.image_id) : null;
      if (cached) {
        merged = mergeImageForDisplay(img, cached);
      }
      saveImageCache(img.image_id, merged);
    }

    if (reachedLimit) break;
  }

  for (const [bucketKey, current] of hourlyIndices.entries()) {
    const { year, month, day, hour } = splitHourlyBucketKey(bucketKey);
    if (useCache) {
      const existing = loadHourlyCache(year, month, day, hour) || [];
      for (const id of existing) current.add(id);
    }
    saveHourlyCache(year, month, day, hour, Array.from(current));
    for (const id of current) imageIds.add(id);
  }

  if (useCache) {
    for (const id of loadImageIdsFromDateRangeCache(targetDate)) {
      imageIds.add(id);
    }
  }

  return Array.from(imageIds);
}

export async function warmDateCacheForRanking(
  targetDate: ParsedDateOption,
  maxPages: number,
  useCache: boolean,
  metadataKind: HourlyMetadataKind,
  extractValues: MetadataValueExtractor,
): Promise<string[]> {
  const hourlyIndices: Map<string, Set<string>> = new Map();
  const hourlyMetadataEntries: Map<string, Map<string, string[]>> = new Map();
  const existingHourlyMetadataEntries: Map<string, HourlyMetadataCacheEntries> = new Map();
  const imageIds: Set<string> = new Set();

  for (let page = 1; page <= maxPages; page++) {
    const images = await listImages(page, 100);
    if (images.length === 0) break;

    let reachedLimit = false;
    for (const img of images) {
      const createdAt = new Date(img.created_at);
      if (Number.isNaN(createdAt.getTime())) continue;

      if (createdAt > targetDate.end) continue;
      if (createdAt < targetDate.start) {
        reachedLimit = true;
        break;
      }

      const dateParts = toDateParts(createdAt);
      const bucketKey = buildHourlyBucketKey(
        dateParts.year,
        dateParts.month,
        dateParts.day,
        dateParts.hour,
      );
      if (!hourlyIndices.has(bucketKey)) {
        hourlyIndices.set(bucketKey, new Set());
      }
      if (!hourlyMetadataEntries.has(bucketKey)) {
        hourlyMetadataEntries.set(bucketKey, new Map());
      }

      hourlyIndices.get(bucketKey)?.add(img.image_id);
      imageIds.add(img.image_id);

      let merged = img;
      const cached = useCache ? loadImageCache(img.image_id) : null;
      if (cached) {
        merged = mergeImageForDisplay(img, cached);
      }

      let values: string[] | undefined;
      let hasExistingMetadataEntry = false;
      if (useCache) {
        let existingForBucket = existingHourlyMetadataEntries.get(bucketKey);
        if (!existingForBucket) {
          existingForBucket = normalizeHourlyMetadataEntries(
            loadHourlyMetadataCache(metadataKind, dateParts.year, dateParts.month, dateParts.day, dateParts.hour),
          );
          existingHourlyMetadataEntries.set(bucketKey, existingForBucket);
        }
        if (Object.prototype.hasOwnProperty.call(existingForBucket, img.image_id)) {
          values = existingForBucket[img.image_id];
          hasExistingMetadataEntry = true;
        }
      }

      if (!values) {
        values = normalizeRankingValues(extractValues(merged));
      }
      if (values.length === 0 && !hasExistingMetadataEntry) {
        try {
          const detail = await getImageDetail(img.image_id);
          merged = mergeImageForDisplay(merged, detail);
          values = normalizeRankingValues(extractValues(merged));
        } catch (_error) {
          // Keep best effort result when detail fetch fails.
        }
      }

      saveImageCache(img.image_id, merged);
      hourlyMetadataEntries.get(bucketKey)?.set(img.image_id, values);
    }

    if (reachedLimit) break;
  }

  for (const [bucketKey, current] of hourlyIndices.entries()) {
    const { year, month, day, hour } = splitHourlyBucketKey(bucketKey);
    if (useCache) {
      const existing = loadHourlyCache(year, month, day, hour) || [];
      for (const id of existing) current.add(id);
    }
    saveHourlyCache(year, month, day, hour, Array.from(current));
    for (const id of current) imageIds.add(id);

    const mergedMetadataEntries = useCache
      ? normalizeHourlyMetadataEntries(loadHourlyMetadataCache(metadataKind, year, month, day, hour))
      : {};
    const currentMetadataEntries = hourlyMetadataEntries.get(bucketKey) || new Map();
    for (const [imageId, values] of currentMetadataEntries.entries()) {
      mergedMetadataEntries[imageId] = values;
    }
    saveHourlyMetadataCache(metadataKind, year, month, day, hour, mergedMetadataEntries);
  }

  if (useCache) {
    const dates = getDatePartsInRange(targetDate.start, targetDate.end);
    const hours = getDateHourStrings();
    for (const date of dates) {
      for (const hour of hours) {
        const existing = loadHourlyCache(date.year, date.month, date.day, hour) || [];
        for (const id of existing) imageIds.add(id);
      }
    }
  }

  return Array.from(imageIds);
}

export function buildHourlyMetadataEntriesFromImageCache(
  year: string,
  month: string,
  day: string,
  hour: string,
  extractValues: MetadataValueExtractor,
): HourlyMetadataCacheEntries {
  const imageIds = loadHourlyCache(year, month, day, hour) || [];
  const valuesByImageId: HourlyMetadataCacheEntries = {};

  for (const imageId of imageIds) {
    const image = loadImageCache(imageId);
    if (!image) continue;
    valuesByImageId[imageId] = normalizeRankingValues(extractValues(image));
  }

  return valuesByImageId;
}

export function loadOrBuildHourlyMetadataEntries(
  metadataKind: HourlyMetadataKind,
  year: string,
  month: string,
  day: string,
  hour: string,
  extractValues: MetadataValueExtractor,
): HourlyMetadataCacheEntries {
  const rawCached = loadHourlyMetadataCache(metadataKind, year, month, day, hour);
  if (rawCached !== null) {
    return normalizeHourlyMetadataEntries(rawCached);
  }

  const built = buildHourlyMetadataEntriesFromImageCache(year, month, day, hour, extractValues);
  const hasHourlyIndex = Boolean(loadHourlyCache(year, month, day, hour));
  if (hasHourlyIndex || Object.keys(built).length > 0) {
    saveHourlyMetadataCache(metadataKind, year, month, day, hour, built);
  }
  return built;
}

export function cacheSearchResultImages(images: any[]): void {
  for (const img of images) {
    if (!img?.image_id) continue;
    saveSearchImageCache(img.image_id, img);
  }
}

export function supplementAltTextFromSearchCache(image: any, useCache: boolean = true): { image: any; supplemented: boolean } {
  const hasAltText = Boolean(normalizeText(image.alt_text));
  if (hasAltText) return { image, supplemented: false };
  if (!useCache) return { image, supplemented: false };

  const cached = loadSearchImageCache(image.image_id);
  const cachedAltText = normalizeText(cached?.alt_text);
  const cachedHasAltText = Boolean(cachedAltText);
  if (!cachedHasAltText) return { image, supplemented: false };

  return {
    image: {
      ...image,
      alt_text: cachedAltText,
    },
    supplemented: true,
  };
}

export function supplementAltTextForDisplay(images: any[], useCache: boolean = true): any[] {
  return images.map(img => supplementAltTextFromSearchCache(img, useCache).image);
}

export type CaptureAlias = 'photos' | 'uploaded';

export interface ListCapturesOptions {
  page: number;
  limit: number;
  maxPages: number;
  useCache: boolean;
  /** A parsed --date/--today range, when the request is for a range. */
  date?: ParsedDateOption;
  /** A parsed --hour, when the request is for one hour of the cache. */
  hour?: { year: string; month: string; day: string; hour: string };
  alias?: CaptureAlias;
}

export interface ListCapturesResult {
  images: any[];
  /** Which lookup came back empty, for a caller that wants to say so. */
  empty?: 'date' | 'hour';
}

const ALIAS_QUERIES: Record<CaptureAlias, string> = {
  photos: 'has:location',
  uploaded: 'gyazocli_uploads',
};

function byNewestFirst(a: any, b: any): number {
  return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
}

function page(images: any[], pageNumber: number, limit: number): any[] {
  const start = (pageNumber - 1) * limit;
  return images.slice(start, start + limit);
}

/**
 * The captures a `list` request asks for. Four ways in, in the order the
 * options decide between them: a saved search alias, a date range, one hour of
 * the cache, or simply the most recent page.
 *
 * Validation is the caller's: this takes options that already agree with each
 * other, because how to refuse differs between the CLI and the MCP server.
 */
export async function listCaptures(options: ListCapturesOptions): Promise<ListCapturesResult> {
  const { page: pageNumber, limit, maxPages, useCache } = options;

  if (options.alias) {
    const query = ALIAS_QUERIES[options.alias];
    if (!options.date) {
      return { images: await searchImages(query, pageNumber, limit) };
    }

    const collected: any[] = [];
    for (let searchPage = 1; searchPage <= maxPages; searchPage++) {
      const pageImages = await searchImages(query, searchPage, 100);
      if (pageImages.length === 0) break;

      let reachedLimit = false;
      for (const img of pageImages) {
        const createdAt = new Date(img.created_at);
        if (Number.isNaN(createdAt.getTime())) continue;
        if (createdAt > options.date.end) continue;
        if (createdAt < options.date.start) {
          reachedLimit = true;
          break;
        }
        collected.push(img);
      }
      if (reachedLimit) break;
    }

    collected.sort(byNewestFirst);
    return { images: page(collected, pageNumber, limit) };
  }

  if (options.date) {
    const targetDate = options.date;
    let imageIds: string[] = [];
    if (useCache) {
      imageIds = loadImageIdsFromDateRangeCache(targetDate);
      if (imageIds.length === 0) {
        await warmDateCacheForList(targetDate, maxPages, true);
        imageIds = loadImageIdsFromDateRangeCache(targetDate);
      }
    } else {
      imageIds = await warmDateCacheForList(targetDate, maxPages, false);
    }

    if (imageIds.length === 0) {
      return { images: [], empty: 'date' };
    }

    const images = imageIds
      .map((id) => loadImageCache(id))
      .filter((img): img is any => img !== null)
      .filter((img) => {
        const createdAt = new Date(img.created_at);
        if (Number.isNaN(createdAt.getTime())) return false;
        return createdAt >= targetDate.start && createdAt <= targetDate.end;
      });

    images.sort(byNewestFirst);
    return { images: page(images, pageNumber, limit) };
  }

  if (options.hour) {
    const { year, month, day, hour } = options.hour;
    const imageIds = loadHourlyCache(year, month, day, hour);
    if (!imageIds) {
      return { images: [], empty: 'hour' };
    }

    if (useCache) {
      return { images: imageIds.map((id) => loadImageCache(id)).filter((img) => img !== null) };
    }

    const images: any[] = [];
    for (const imageId of imageIds) {
      try {
        const detail = await getImageDetail(imageId);
        saveImageCache(imageId, detail);
        images.push(detail);
      } catch (_error) {
        // Skip failed items and continue with the rest.
      }
    }
    return { images };
  }

  return { images: await listImages(pageNumber, limit) };
}

export interface RecentCapturesOptions {
  /** Only captures uploaded at or after this instant. */
  since?: Date;
  /** Only captures newer than this one, which is itself excluded. */
  afterImageId?: string;
  limit: number;
  maxPages: number;
}

export interface RecentCapturesResult {
  images: any[];
  pagesWalked: number;
  /** A watermark was asked for and never seen inside the pages walked. */
  watermarkMissing?: boolean;
}

/**
 * What arrived since a moment, or since a capture. The listing comes back
 * newest first, so the walk stops at the first capture that is older than the
 * boundary rather than reading to the end.
 *
 * A watermark that never turns up is reported, not papered over: returning
 * everything walked would read as "all of this is new", which is the wrong
 * answer told confidently.
 */
export async function listCapturesSince(
  options: RecentCapturesOptions,
): Promise<RecentCapturesResult> {
  const { since, afterImageId, limit, maxPages } = options;
  const collected: any[] = [];
  let pagesWalked = 0;
  let reachedBoundary = false;

  for (let page = 1; page <= maxPages && !reachedBoundary; page++) {
    const images = await listImages(page, 100);
    pagesWalked = page;
    if (images.length === 0) break;

    for (const image of images) {
      if (afterImageId && image.image_id === afterImageId) {
        reachedBoundary = true;
        break;
      }
      if (since) {
        const createdAt = new Date(image.created_at);
        if (Number.isNaN(createdAt.getTime())) continue;
        if (createdAt < since) {
          reachedBoundary = true;
          break;
        }
      }
      collected.push(image);
    }

    if (images.length < 100) break;
  }

  if (afterImageId && !reachedBoundary) {
    return { images: [], pagesWalked, watermarkMissing: true };
  }

  return { images: collected.slice(0, limit), pagesWalked };
}

/**
 * Fill in what the lean endpoints leave out.
 *
 * The listing and the search endpoints return an image without its
 * coordinates or its address, whatever the capture actually carries; only the
 * detail endpoint has them. So a caller that needs a location has to ask again
 * per image, which is what this does: the cache first, the API for the rest,
 * a few at a time, writing what it fetches back to the cache so the next look
 * is free.
 */
export async function enrichImageLocations(
  images: any[],
  options: { useCache?: boolean; limit?: number; concurrency?: number } = {},
): Promise<any[]> {
  const useCache = options.useCache !== false;
  const limit = options.limit ?? 40;
  const concurrency = Math.max(1, options.concurrency ?? 5);

  const enriched = [...images];
  const pending: number[] = [];

  for (let index = 0; index < enriched.length && pending.length < limit; index++) {
    const image = enriched[index];
    if (image?.metadata?.exif_normalized || image?.metadata?.exif_address) continue;

    if (useCache) {
      const cached = loadImageCache(image?.image_id);
      if (cached) {
        enriched[index] = mergeImageForDisplay(image, cached);
        continue;
      }
    }
    pending.push(index);
  }

  for (let start = 0; start < pending.length; start += concurrency) {
    const batch = pending.slice(start, start + concurrency);
    await Promise.all(
      batch.map(async (index) => {
        const image = enriched[index];
        try {
          const detail = await getImageDetail(image.image_id);
          saveImageCache(image.image_id, detail);
          enriched[index] = mergeImageForDisplay(image, detail);
        } catch (_error) {
          // A capture that cannot be fetched keeps what the listing said.
        }
      }),
    );
  }

  return enriched;
}
