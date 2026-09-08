/**
 * Collections. A collection ID is indistinguishable from an image ID, so the
 * only unambiguous way in is the URL form, which is why the check here is
 * stricter than the one for images. Read-only: this CLI neither creates nor
 * edits collections.
 */
import { getCollection } from '../api';
import { normalizeCollectionId } from '../ids';
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
 * A collection and its images in the requested order. The API returns the
 * images in the order they were added, which is the default here too.
 */
export async function readCollection(
  collectionId: string,
  options: { anonymous?: boolean; sort?: CollectionSort } = {},
): Promise<{ collection: any; images: any[] }> {
  const collection = await getCollection(collectionId, {
    anonymous: Boolean(options.anonymous),
  });
  const images = sortCollectionImages(
    Array.isArray(collection?.images) ? collection.images : [],
    options.sort || 'added',
  );
  return { collection, images };
}
