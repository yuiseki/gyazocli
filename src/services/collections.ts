/**
 * Collections. A collection ID is indistinguishable from an image ID, so the
 * only unambiguous way in is the URL form, which is why the check here is
 * stricter than the one for images. Read-only: this CLI neither creates nor
 * edits collections.
 */
import {
  getCollection,
  getCollectionDetail,
  listCollectionImages,
  listCollections,
  type GyazoCollectionSummary,
} from '../api';
import { resolveAccessToken } from '../credentials';
import { normalizeCollectionId, imageIdFromRecord } from '../ids';
import { formatCreatedAt, normalizeText } from '../format';
import { printListImages } from './images';

export const COLLECTION_SORTS = ['added', 'created', 'captured'] as const;

export type CollectionSort = (typeof COLLECTION_SORTS)[number];

export function requireCollectionId(input: string): string {
  const collectionId = normalizeCollectionId(input);
  if (!collectionId) {
    console.error(`Error: '${input}' is not a Gyazo collection ID or URL.`);
    console.error('Hint: pass a 32-character collection ID or a https://gyazo.com/collections/<id> URL.');
    process.exit(1);
  }
  return collectionId;
}

export function parseCollectionSort(value: unknown): CollectionSort {
  if (value === undefined || value === null) return 'added';
  if ((COLLECTION_SORTS as readonly string[]).includes(String(value))) {
    return String(value) as CollectionSort;
  }
  console.error(`Error: --sort must be one of ${COLLECTION_SORTS.join(', ')}.`);
  process.exit(1);
}

export function collectionSortKey(image: any, sort: CollectionSort): string {
  if (sort === 'captured') {
    return image?.exif_captured_at || image?.metadata?.exif_normalized?.time || image?.created_at || '';
  }
  return image?.created_at || '';
}

export function sortCollectionImages(images: any[], sort: CollectionSort): any[] {
  if (sort === 'added') return images;
  // Newest first, matching how `list` presents images.
  return [...images].sort((a, b) =>
    collectionSortKey(b, sort).localeCompare(collectionSortKey(a, sort)),
  );
}

export function printCollectionMarkdown(collection: any, images: any[]): void {
  const lines: string[] = [];
  lines.push('## Gyazo Collection');
  lines.push('');

  const name = normalizeText(collection?.name);
  if (name) lines.push(`- Name: ${name}`);

  const collectionId = collection?.id;
  const url = collection?.url || (collectionId ? `https://gyazo.com/collections/${collectionId}` : undefined);
  if (url) lines.push(`- URL: <${url}>`);

  const description = normalizeText(collection?.description);
  if (description) lines.push(`- Description: ${description}`);

  const owner = normalizeText(collection?.user?.name);
  if (owner) lines.push(`- Owner: ${owner}`);

  const total = collection?.total_image_count;
  const shown = images.length;
  const truncated = typeof total === 'number' && total > shown;
  lines.push(`- Images: ${truncated ? `${shown} of ${total}` : shown}`);

  const updatedAt = normalizeText(collection?.list_updated_at);
  if (updatedAt) lines.push(`- Updated at: ${formatCreatedAt(updatedAt)}`);

  console.log(lines.join('\n'));

  if (truncated) {
    console.log('');
    console.log('Note: this endpoint returns only the first 100 images of a collection.');
  }

  if (shown > 0) {
    console.log('');
    console.log('### Images');
    console.log('');
    printListImages(images);
  }
}

/**
 * A collection and its images in the requested order.
 *
 * Two ways in. The public web endpoint needs no token but returns the first
 * 100 images and ignores every paging parameter, so a larger collection is
 * simply cut off. The API endpoint needs a token and really pages. Which one
 * was used, and whether anything was left behind, comes back with the result,
 * because a collection that stops at 100 without saying so is the kind of
 * silence that reads as an answer.
 */
export interface ReadCollectionOptions {
  anonymous?: boolean;
  sort?: CollectionSort;
  /**
   * Ask for a page through the API endpoint. Left off, the public web endpoint
   * is used, which is what `gyazo collection` has always done and what an
   * anonymous read has to do.
   */
  paginated?: boolean;
  page?: number;
  per?: number;
}

export interface ReadCollectionResult {
  collection: any;
  images: any[];
  page: number;
  per: number;
  returnedImageCount: number;
  totalImageCount?: number;
  truncated: boolean;
  source: 'api' | 'web';
}

export async function readCollection(
  collectionId: string,
  options: ReadCollectionOptions = {},
): Promise<ReadCollectionResult> {
  const sort = options.sort || 'added';
  const page = options.page && options.page > 0 ? options.page : 1;
  const per = options.per && options.per > 0 ? Math.min(options.per, 100) : 100;
  const useApi = Boolean(options.paginated) && !options.anonymous && Boolean(resolveAccessToken());

  // The public /collections/<id>.json endpoint: no paging (first 100), but it
  // keeps working when the API endpoint does not, as during the incident
  // recovery where that one returns 403.
  const readWeb = async (): Promise<ReadCollectionResult> => {
    const collection = await getCollection(collectionId, {
      anonymous: Boolean(options.anonymous),
    });
    const images = sortCollectionImages(
      Array.isArray(collection?.images) ? collection.images : [],
      sort,
    );
    const total = collection?.total_image_count;
    return {
      collection,
      images,
      page: 1,
      per: images.length,
      returnedImageCount: images.length,
      totalImageCount: typeof total === 'number' ? total : undefined,
      truncated: typeof total === 'number' ? images.length < total : false,
      source: 'web',
    };
  };

  if (useApi) {
    try {
      const [collection, images] = await Promise.all([
        getCollectionDetail(collectionId),
        listCollectionImages(collectionId, page, per),
      ]);
      const total = collection?.total_image_count;
      const sorted = sortCollectionImages(images, sort);
      return {
        collection,
        images: sorted,
        page,
        per,
        returnedImageCount: sorted.length,
        totalImageCount: typeof total === 'number' ? total : undefined,
        truncated: typeof total === 'number' ? page * per < total : false,
        source: 'api',
      };
    } catch (error: any) {
      // A 404 means the collection is not there or not readable; let that
      // surface. Anything else (403 during the incident, a 5xx) falls back to
      // the web endpoint, which may still answer.
      if (error?.response?.status === 404) throw error;
      return readWeb();
    }
  }

  return readWeb();
}

/**
 * Every image ID in a collection, paged through the API endpoint. The web
 * endpoint caps at 100 and cannot page, so this needs a token; a collection
 * curated to hold exactly what is safe to publish can then be handed to
 * `gyazo restore` in full.
 */
export async function collectAllImageIds(
  collectionId: string,
  options: { sort?: CollectionSort; maxPages?: number } = {},
): Promise<{ ids: string[]; totalImageCount?: number }> {
  const maxPages = options.maxPages && options.maxPages > 0 ? options.maxPages : 1000;
  const ids: string[] = [];
  const seen = new Set<string>();
  let totalImageCount: number | undefined;

  for (let page = 1; page <= maxPages; page++) {
    const result = await readCollection(collectionId, {
      sort: options.sort,
      paginated: true,
      page,
      per: 100,
    });
    totalImageCount = result.totalImageCount;
    if (result.images.length === 0) break;

    for (const image of result.images) {
      const id = imageIdFromRecord(image);
      if (id && !seen.has(id)) {
        seen.add(id);
        ids.push(id);
      }
    }

    // The web fallback cannot page, so one read of it is all there is.
    if (result.source === 'web') break;
    // Stop when the whole collection is in hand, or a short page ends it.
    if (typeof totalImageCount === 'number' && ids.length >= totalImageCount) break;
    if (result.images.length < 100) break;
  }

  return { ids, totalImageCount };
}

/**
 * Collections whose name contains the query, or all of them when there is no
 * query. Matching is case-insensitive and ignores surrounding whitespace,
 * because a name people say out loud rarely matches one stored with emoji and
 * padding.
 */
export async function findCollections(query?: string): Promise<GyazoCollectionSummary[]> {
  const collections = await listCollections();
  const needle = normalizeText(query)?.toLowerCase();
  if (!needle) return collections;
  return collections.filter((collection) =>
    (collection.name || '').toLowerCase().includes(needle),
  );
}
