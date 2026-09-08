/**
 * Reading and presenting the fields of a Gyazo image: the domain a capture
 * came from, the address recorded in its EXIF, its OCR text, the objects
 * detected in it. Nothing here talks to the API or the cache, so both the CLI
 * and the aggregations can share it.
 */

export function normalizeText(value?: string): string | undefined {
  if (!value) return undefined;
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length > 0 ? normalized : undefined;
}

export function extractDomain(value?: string): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.hostname.replace(/^www\./, '');
  } catch (e) {
    try {
      const url = new URL(`https://${value}`);
      return url.hostname.replace(/^www\./, '');
    } catch (_e) {
      return undefined;
    }
  }
}

export function isXDomain(domain?: string): boolean {
  if (!domain) return false;
  return domain === 'x.com' ||
    domain.endsWith('.x.com') ||
    domain === 'twitter.com' ||
    domain.endsWith('.twitter.com');
}

export function cleanTextForDomain(value: string, domain?: string): string {
  if (!isXDomain(domain)) return value;
  return value
    .replace(/^Xユーザーの/, '')
    .replace(/\s*\/\s*X$/, '')
    .trim();
}

export function stripInlineUrls(value: string): string {
  return value
    .replace(/https?:\/\/\S+/g, '')
    .replace(/\bwww\.\S+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function sanitizeSummaryText(value?: string, domain?: string): string | undefined {
  if (!value) return undefined;
  return normalizeText(stripInlineUrls(cleanTextForDomain(value, domain)));
}

export function getAddressEntry(exifAddress: any, locale: string): any | undefined {
  if (!exifAddress || typeof exifAddress !== 'object') return undefined;
  if (typeof exifAddress.address === 'string') return exifAddress;
  const entry = exifAddress[locale];
  if (!entry || typeof entry !== 'object') return undefined;
  return entry;
}

export function getAddressComponent(addressEntry: any, type: string): string | undefined {
  if (!addressEntry || typeof addressEntry !== 'object') return undefined;
  const components = Array.isArray(addressEntry.address_components)
    ? addressEntry.address_components
    : [];

  for (const component of components) {
    if (!component || typeof component !== 'object') continue;
    const types = Array.isArray(component.types) ? component.types : [];
    if (!types.includes(type)) continue;
    const value = normalizeText(component.long_name || component.short_name);
    if (value) return value;
  }

  return undefined;
}

export function buildJaLocationLabel(exifAddress: any): string | undefined {
  const ja = getAddressEntry(exifAddress, 'ja');
  if (!ja) return undefined;

  const pref = getAddressComponent(ja, 'administrative_area_level_1');
  const locality = getAddressComponent(ja, 'locality') || getAddressComponent(ja, 'administrative_area_level_2');
  const sublocality =
    getAddressComponent(ja, 'sublocality_level_2') ||
    getAddressComponent(ja, 'sublocality_level_1') ||
    getAddressComponent(ja, 'sublocality_level_3');

  const fromComponents = normalizeText([pref, locality, sublocality].filter(Boolean).join(''));
  if (fromComponents) return fromComponents;

  const raw = normalizeText(ja.address);
  if (!raw) return undefined;

  const compact = raw
    .replace(/^日本、?/, '')
    .replace(/〒\d{3}-\d{4}\s*/g, '')
    .replace(/[0-9０-９].*$/, '')
    .trim();
  return normalizeText(compact);
}

export function buildEnLocationLabel(exifAddress: any): string | undefined {
  const en = getAddressEntry(exifAddress, 'en');
  if (!en) return undefined;

  const pref = getAddressComponent(en, 'administrative_area_level_1');
  const locality = getAddressComponent(en, 'locality') || getAddressComponent(en, 'administrative_area_level_2');
  const sublocality =
    getAddressComponent(en, 'sublocality_level_2') ||
    getAddressComponent(en, 'sublocality_level_1') ||
    getAddressComponent(en, 'sublocality_level_3');

  const fromComponents = normalizeText([sublocality, locality, pref].filter(Boolean).join(', '));
  if (fromComponents) return fromComponents;

  return normalizeText(en.address);
}

export function extractImageAddressText(img: any): string | undefined {
  const exifAddress = img.metadata?.exif_address ?? img.exif_address;
  if (!exifAddress) return undefined;
  if (typeof exifAddress === 'string') return normalizeText(exifAddress);
  if (typeof exifAddress !== 'object') return undefined;

  const ja = getAddressEntry(exifAddress, 'ja');
  const jaAddress = normalizeText(ja?.address);
  if (jaAddress) return jaAddress;

  const en = getAddressEntry(exifAddress, 'en');
  const enAddress = normalizeText(en?.address);
  if (enAddress) return enAddress;

  for (const value of Object.values(exifAddress)) {
    if (!value || typeof value !== 'object') continue;
    const raw = normalizeText((value as any).address);
    if (raw) return raw;
  }

  return undefined;
}

export function extractImageLocationLabel(img: any): string | undefined {
  const exifAddress = img.metadata?.exif_address ?? img.exif_address;
  if (!exifAddress) return undefined;
  if (typeof exifAddress === 'string') return normalizeText(exifAddress);
  if (typeof exifAddress !== 'object') return undefined;

  const jaLabel = buildJaLocationLabel(exifAddress);
  if (jaLabel) return jaLabel;

  const enLabel = buildEnLocationLabel(exifAddress);
  if (enLabel) return enLabel;

  for (const value of Object.values(exifAddress)) {
    if (!value || typeof value !== 'object') continue;
    const raw = normalizeText((value as any).address);
    if (raw) return raw;
  }

  return undefined;
}

export function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  if (maxLength <= 3) return value.slice(0, maxLength);
  return `${value.slice(0, maxLength - 3)}...`;
}

export function formatCreatedAt(value: string): string {
  const match = value.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})/);
  if (match) {
    return `${match[1]} ${match[2]}:${match[3]}`;
  }
  return value;
}

export function shortenImageId(imageId: string): string {
  if (!imageId) return '';
  if (imageId.length <= 4) return imageId;
  return `${imageId.slice(0, 4)}...`;
}

export function formatTerminalLink(label: string, url?: string): string {
  if (!url || !process.stdout.isTTY) return label;
  return `\u001B]8;;${url}\u0007${label}\u001B]8;;\u0007`;
}

export function normalizeOcrText(value?: string): string | undefined {
  if (!value) return undefined;
  const normalized = value
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .map(line => line.trimEnd())
    .join('\n')
    .trim();
  return normalized.length > 0 ? normalized : undefined;
}

export function extractOcrDescription(image: any): string | undefined {
  const direct = normalizeOcrText(image?.ocr?.description);
  if (direct) return direct;
  return normalizeOcrText(image?.metadata?.ocr?.description);
}

export function buildOcrPreview(ocrText: string, maxLines: number): { text: string; truncated: boolean } {
  const lines = ocrText.split('\n');
  if (lines.length <= maxLines) {
    return { text: ocrText, truncated: false };
  }
  return {
    text: lines.slice(0, maxLines).join('\n'),
    truncated: true,
  };
}

export type DisplayObjectAnnotation = {
  name: string;
  score?: number;
};

export function extractObjectAnnotations(image: any): DisplayObjectAnnotation[] {
  const rawAnnotations =
    image?.localizedObjectAnnotations ||
    image?.localized_object_annotations ||
    image?.metadata?.localizedObjectAnnotations ||
    image?.metadata?.localized_object_annotations ||
    [];

  if (!Array.isArray(rawAnnotations)) return [];

  const bestByName = new Map<string, DisplayObjectAnnotation>();
  for (const annotation of rawAnnotations) {
    if (!annotation || typeof annotation !== 'object') continue;
    const name = normalizeText(annotation.name_ja || annotation.nameJa || annotation.name);
    if (!name) continue;

    const score = typeof annotation.score === 'number' ? annotation.score : undefined;
    const existing = bestByName.get(name);
    if (!existing) {
      bestByName.set(name, { name, score });
      continue;
    }

    const existingScore = existing.score ?? -1;
    const nextScore = score ?? -1;
    if (nextScore > existingScore) {
      bestByName.set(name, { name, score });
    }
  }

  return Array.from(bestByName.values()).sort((a, b) => {
    const sa = a.score ?? -1;
    const sb = b.score ?? -1;
    return sb - sa;
  });
}

export function formatObjectAnnotationLine(annotation: DisplayObjectAnnotation): string {
  if (typeof annotation.score === 'number') {
    return `${annotation.name} (${(annotation.score * 100).toFixed(1)}%)`;
  }
  return annotation.name;
}

export function extractImageApps(image: any): string[] {
  const app = normalizeText(image?.metadata?.app);
  return app ? [app] : [];
}

export function extractImageDomains(image: any): string[] {
  const domain = extractDomain(normalizeText(image?.metadata?.url));
  return domain ? [domain] : [];
}

export function extractImageLocations(image: any): string[] {
  const location = normalizeText(extractImageLocationLabel(image));
  return location ? [location] : [];
}

export function normalizeTagText(value?: string): string | undefined {
  if (!value) return undefined;
  const normalized = normalizeText(value);
  if (!normalized) return undefined;
  const stripped = normalized.replace(/^[#＃]+/, '').trim();
  return stripped.length > 0 ? stripped : undefined;
}

export function extractTagFromLinkValue(value: any): string | undefined {
  if (typeof value === 'string') {
    return normalizeTagText(value);
  }
  if (!value || typeof value !== 'object') return undefined;

  const candidates = [
    value.tag,
    value.name,
    value.title,
    value.text,
    value.keyword,
  ];
  for (const candidate of candidates) {
    const tag = normalizeTagText(candidate);
    if (tag) return tag;
  }

  return undefined;
}

export function extractImageTags(image: any): string[] {
  const rawLinks = image?.metadata?.links ?? image?.links;
  if (!Array.isArray(rawLinks)) return [];

  const tags: string[] = [];
  for (const rawLink of rawLinks) {
    const tag = extractTagFromLinkValue(rawLink);
    if (tag) tags.push(tag);
  }

  return normalizeRankingValues(tags);
}

export function normalizeRankingValues(values: string[]): string[] {
  const uniqueByLower = new Map<string, string>();
  for (const raw of values) {
    const value = normalizeText(raw);
    if (!value) continue;
    const key = value.toLocaleLowerCase();
    if (!uniqueByLower.has(key)) {
      uniqueByLower.set(key, value);
    }
  }
  return Array.from(uniqueByLower.values());
}
