/**
 * Showing captures to a person: one line each for a list, a markdown block for
 * a single capture, and the enrichment that has to happen first. A search
 * result carries less than an image detail does, so a location worth printing
 * sometimes means fetching the detail before printing anything.
 */
import { getImageDetail } from '../api';
import { loadImageCache, saveImageCache } from '../storage';
import { normalizeImageId, normalizeCollectionId } from '../ids';
import {
  type DisplayObjectAnnotation,
  buildOcrPreview,
  extractObjectAnnotations,
  extractOcrDescription,
  extractImageAddressText,
  extractImageLocationLabel,
  formatCreatedAt,
  formatObjectAnnotationLine,
  formatTerminalLink,
  extractDomain,
  cleanTextForDomain,
  isXDomain,
  mergeImageForDisplay,
  normalizeText,
  sanitizeSummaryText,
  shortenImageId,
  shouldEnrichForLocationDisplay,
  truncateText,
} from '../format';
import { supplementAltTextForDisplay, cacheSearchResultImages } from './memory';

export function requireImageId(input: string): string {
  const imageId = normalizeImageId(input);
  if (!imageId) {
    console.error(`Error: '${input}' is not a Gyazo image ID or URL.`);
    if (normalizeCollectionId(input)) {
      console.error(`Hint: that looks like a collection. Try \`gyazo collection ${input}\`.`);
    } else {
      console.error('Hint: pass a 32-character image ID or a https://gyazo.com/<id> URL.');
    }
    process.exit(1);
  }
  return imageId;
}

export function printGetMarkdown(image: any, ocrDescription?: string, objects: DisplayObjectAnnotation[] = []): void {
  const lines: string[] = [];
  lines.push('## Gyazo Image');
  lines.push('');
  lines.push(`- URL: <${image.permalink_url}>`);
  lines.push(`- Created at: ${formatCreatedAt(image.created_at)}`);

  const title = normalizeText(image.metadata?.title);
  if (title) lines.push(`- Title: ${title}`);

  const address = extractImageAddressText(image);
  if (address) lines.push(`- Address: ${address}`);

  const altText = normalizeText(image.alt_text);
  if (altText) lines.push(`- Alt text: ${altText}`);

  if (objects.length > 0) {
    lines.push('');
    lines.push('### Objects');
    for (const object of objects) {
      lines.push(`- ${formatObjectAnnotationLine(object)}`);
    }
  }

  if (ocrDescription) {
    const preview = buildOcrPreview(ocrDescription, 5);
    lines.push('');
    lines.push('### OCR');
    lines.push('```text');
    lines.push(preview.text);
    lines.push('```');
    if (preview.truncated) {
      lines.push('');
      lines.push(`> Truncated to first 5 lines. Use \`gyazo get --ocr ${image.image_id}\` for full text.`);
    }
  }

  console.log(lines.join('\n'));
}

export function summarizeImageForList(img: any): string {
  const domain = extractDomain(normalizeText(img.metadata?.url));
  const cleanedTitle = sanitizeSummaryText(img.metadata?.title, domain);
  const cleanedDesc = sanitizeSummaryText(img.metadata?.desc ?? img.desc, domain);
  const locationLabel = sanitizeSummaryText(extractImageLocationLabel(img));
  const cleanedAltText = sanitizeSummaryText(img.alt_text);

  let main = '(no title/description)';

  if (cleanedTitle && cleanedDesc) {
    main = `${cleanedTitle} | ${cleanedDesc}`;
  } else if (cleanedTitle) {
    main = cleanedTitle;
  } else if (cleanedDesc) {
    main = cleanedDesc;
  }

  if (cleanedAltText) {
    if (main === '(no title/description)') {
      main = cleanedAltText;
    } else if (cleanedAltText !== main) {
      main = `${main} | alt: ${cleanedAltText}`;
    }
  }

  const prefixes: string[] = [];
  if (domain) prefixes.push(`[${domain}]`);
  if (locationLabel) prefixes.push(`[${locationLabel}]`);

  if (main === '(no title/description)') {
    if (prefixes.length > 0) return prefixes.join(' ');
    return main;
  }

  if (prefixes.length > 0) {
    return `${prefixes.join(' ')} ${main}`;
  }

  return main;
}

export type DisplayPreparationOptions = {
  cacheSearchResults?: boolean;
  enrichLocation?: boolean;
  useCache?: boolean;
};

export async function prepareImagesForDisplay(images: any[], options: DisplayPreparationOptions = {}): Promise<any[]> {
  const useCache = options.useCache !== false;

  if (options.cacheSearchResults) {
    cacheSearchResultImages(images);
  }

  let prepared = images;
  if (options.enrichLocation) {
    prepared = await enrichImagesForLocationDisplay(prepared, useCache);
  }

  prepared = supplementAltTextForDisplay(prepared, useCache);
  return prepared;
}

export async function enrichImagesForLocationDisplay(images: any[], useCache: boolean = true): Promise<any[]> {
  const enriched: any[] = [];

  for (const img of images) {
    let current = img;

    if (!shouldEnrichForLocationDisplay(current)) {
      enriched.push(current);
      continue;
    }

    if (useCache) {
      const cached = loadImageCache(img.image_id);
      if (cached) {
        current = mergeImageForDisplay(current, cached);
      }
    }

    if (!shouldEnrichForLocationDisplay(current)) {
      enriched.push(current);
      continue;
    }

    try {
      const detail = await getImageDetail(img.image_id);
      saveImageCache(img.image_id, detail);
      current = mergeImageForDisplay(current, detail);
    } catch (_error) {
      // Keep current data when detail fetch fails.
    }

    enriched.push(current);
  }

  return enriched;
}

export function printListImages(images: any[]): void {
  images.forEach(img => {
    const summary = truncateText(summarizeImageForList(img), 120);
    const created = formatCreatedAt(img.created_at);
    const shortId = shortenImageId(img.image_id);
    const imageUrl = img.permalink_url || `https://gyazo.com/${img.image_id}`;
    const linkedId = formatTerminalLink(shortId, imageUrl);
    console.log(`- [${created}] ${summary} (id: ${linkedId})`);
  });
}
