#!/usr/bin/env node
import { Command } from 'commander';
import fs from 'fs';
import path from 'path';
import { listImages, getImageDetail, searchImages, getCurrentUser, uploadImage } from './api';
import {
  saveImageCache,
  loadImageCache,
  getCacheDir,
  saveHourlyCache,
  loadHourlyCache,
  saveSearchImageCache,
  loadSearchImageCache,
  saveHourlyMetadataCache,
  loadHourlyMetadataCache,
  type HourlyMetadataKind,
} from './storage';
import { ensureAccessToken, getStoredConfig, setStoredConfig } from './credentials';

const program = new Command();
const UPLOAD_DESC_TAG = '#gyazocli_uploads';
const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

program
  .name('gyazo')
  .description('Gyazo Memory CLI for AI Secretary')
  .version('0.0.2');

// Config Command
const configCmd = program.command('config').description('Manage configuration');

configCmd
  .command('set <key> <value>')
  .description('Set a configuration value')
  .action((key, value) => {
    setStoredConfig(key, value);
  });

configCmd
  .command('get <key>')
  .description('Get a configuration value')
  .option('-j, --json', 'output as JSON')
  .action(async (key, options) => {
    if (key === 'me') {
      await ensureAccessToken();
      try {
        const me = await getCurrentUser();
        if (options.json) {
          console.log(JSON.stringify(me, null, 2));
          return;
        }

        const user = me?.user || {};
        if (user.uid) console.log(`UID: ${user.uid}`);
        if (user.name) console.log(`Name: ${user.name}`);
        if (user.email) console.log(`Email: ${user.email}`);
        if (typeof user.is_pro === 'boolean') console.log(`Plan: ${user.is_pro ? 'Pro' : 'Free'}`);
        if (typeof user.is_team === 'boolean') console.log(`Team: ${user.is_team ? 'Yes' : 'No'}`);
        if (user.profile_image) console.log(`Profile image: ${user.profile_image}`);
      } catch (error: any) {
        console.error('Error getting current user:', error.message);
        process.exit(1);
      }
      return;
    }

    const value = getStoredConfig(key);
    if (value) {
      if (key === 'token') {
        const masked = value.length > 8 
          ? `${value.substring(0, 4)}...${value.substring(value.length - 4)}`
          : '********';
        console.log(masked);
      } else {
        console.log(value);
      }
    } else {
      console.error(`Config key '${key}' not found.`);
      process.exit(1);
    }
  });

function isToday(date: Date): boolean {
  const today = new Date();
  return date.getDate() === today.getDate() &&
    date.getMonth() === today.getMonth() &&
    date.getFullYear() === today.getFullYear();
}

function normalizeText(value?: string): string | undefined {
  if (!value) return undefined;
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length > 0 ? normalized : undefined;
}

function extractDomain(value?: string): string | undefined {
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

function isXDomain(domain?: string): boolean {
  if (!domain) return false;
  return domain === 'x.com' ||
    domain.endsWith('.x.com') ||
    domain === 'twitter.com' ||
    domain.endsWith('.twitter.com');
}

function cleanTextForDomain(value: string, domain?: string): string {
  if (!isXDomain(domain)) return value;
  return value
    .replace(/^Xユーザーの/, '')
    .replace(/\s*\/\s*X$/, '')
    .trim();
}

function stripInlineUrls(value: string): string {
  return value
    .replace(/https?:\/\/\S+/g, '')
    .replace(/\bwww\.\S+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function sanitizeSummaryText(value?: string, domain?: string): string | undefined {
  if (!value) return undefined;
  return normalizeText(stripInlineUrls(cleanTextForDomain(value, domain)));
}

function getAddressEntry(exifAddress: any, locale: string): any | undefined {
  if (!exifAddress || typeof exifAddress !== 'object') return undefined;
  if (typeof exifAddress.address === 'string') return exifAddress;
  const entry = exifAddress[locale];
  if (!entry || typeof entry !== 'object') return undefined;
  return entry;
}

function getAddressComponent(addressEntry: any, type: string): string | undefined {
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

function buildJaLocationLabel(exifAddress: any): string | undefined {
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

function buildEnLocationLabel(exifAddress: any): string | undefined {
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

function extractImageAddressText(img: any): string | undefined {
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

function extractImageLocationLabel(img: any): string | undefined {
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

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  if (maxLength <= 3) return value.slice(0, maxLength);
  return `${value.slice(0, maxLength - 3)}...`;
}

function formatCreatedAt(value: string): string {
  const match = value.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})/);
  if (match) {
    return `${match[1]} ${match[2]}:${match[3]}`;
  }
  return value;
}

function shortenImageId(imageId: string): string {
  if (!imageId) return '';
  if (imageId.length <= 4) return imageId;
  return `${imageId.slice(0, 4)}...`;
}

function formatTerminalLink(label: string, url?: string): string {
  if (!url || !process.stdout.isTTY) return label;
  return `\u001B]8;;${url}\u0007${label}\u001B]8;;\u0007`;
}

function normalizeOcrText(value?: string): string | undefined {
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

function extractOcrDescription(image: any): string | undefined {
  const direct = normalizeOcrText(image?.ocr?.description);
  if (direct) return direct;
  return normalizeOcrText(image?.metadata?.ocr?.description);
}

function buildOcrPreview(ocrText: string, maxLines: number): { text: string; truncated: boolean } {
  const lines = ocrText.split('\n');
  if (lines.length <= maxLines) {
    return { text: ocrText, truncated: false };
  }
  return {
    text: lines.slice(0, maxLines).join('\n'),
    truncated: true,
  };
}

type DisplayObjectAnnotation = {
  name: string;
  score?: number;
};

function extractObjectAnnotations(image: any): DisplayObjectAnnotation[] {
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

function formatObjectAnnotationLine(annotation: DisplayObjectAnnotation): string {
  if (typeof annotation.score === 'number') {
    return `${annotation.name} (${(annotation.score * 100).toFixed(1)}%)`;
  }
  return annotation.name;
}

function ensureUploadDescTag(desc?: string): string {
  const normalized = normalizeText(desc);
  if (!normalized) return UPLOAD_DESC_TAG;

  const words = normalized
    .split(' ')
    .filter(word => word.toLowerCase() !== UPLOAD_DESC_TAG.toLowerCase());
  words.push(UPLOAD_DESC_TAG);
  return words.join(' ').trim();
}

function parseUploadTimestamp(value?: string): number | undefined {
  if (!value) return undefined;
  if (!/^\d+$/.test(value)) {
    console.error('Error: --timestamp must be a unix timestamp in seconds.');
    process.exit(1);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    console.error('Error: --timestamp is out of range.');
    process.exit(1);
  }
  const now = Math.floor(Date.now() / 1000);
  if (parsed > now) {
    console.error('Error: --timestamp must be current time or in the past.');
    process.exit(1);
  }
  return parsed;
}

type ParsedDateOption = {
  granularity: 'day' | 'month' | 'year';
  dateKey: string;
  start: Date;
  end: Date;
};

type AppRank = {
  app: string;
  count: number;
};

type DomainRank = {
  domain: string;
  count: number;
};

type LocationRank = {
  location: string;
  count: number;
};

type TagRank = {
  tag: string;
  count: number;
};

type TagRankingSummary = {
  ranking: TagRank[];
  imageCountWithTags: number;
  totalTagAssignments: number;
};

type UploadTimeSummary = {
  totalImages: number;
  byHour: Array<{ hour: number; count: number }>;
  byWeekday: Array<{ weekday: number; count: number }>;
};

type DailyUploadCount = {
  date: string;
  count: number;
};

type DailySummary = {
  date: string;
  imageCount: number;
  apps: AppRank[];
  domains: DomainRank[];
  tags: TagRank[];
  locations: LocationRank[];
};

type RankingFromHourlySummary = {
  ranking: Array<{ key: string; count: number }>;
  totalImages: number;
  imageCountWithValues: number;
  totalAssignments: number;
};

type MetadataValueExtractor = (image: any) => string[];
type HourlyMetadataCacheEntries = Record<string, string[]>;

function parsePositiveIntegerOption(value: string, optionName: string): number {
  if (!/^\d+$/.test(value)) {
    console.error(`Error: ${optionName} must be a positive integer.`);
    process.exit(1);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    console.error(`Error: ${optionName} must be a positive integer.`);
    process.exit(1);
  }
  return parsed;
}

function parseDateOption(value?: string): ParsedDateOption {
  if (!value) {
    const today = new Date();
    const year = String(today.getFullYear());
    const month = String(today.getMonth() + 1).padStart(2, '0');
    const day = String(today.getDate()).padStart(2, '0');
    return {
      granularity: 'day',
      dateKey: `${year}-${month}-${day}`,
      start: new Date(today.getFullYear(), today.getMonth(), today.getDate(), 0, 0, 0, 0),
      end: new Date(today.getFullYear(), today.getMonth(), today.getDate(), 23, 59, 59, 999),
    };
  }

  if (/^\d{4}$/.test(value)) {
    const year = Number(value);
    return {
      granularity: 'year',
      dateKey: value,
      start: new Date(year, 0, 1, 0, 0, 0, 0),
      end: new Date(year, 11, 31, 23, 59, 59, 999),
    };
  }

  if (/^\d{4}-\d{2}$/.test(value)) {
    const [yearText, monthText] = value.split('-');
    const year = Number(yearText);
    const month = Number(monthText);
    const probe = new Date(year, month - 1, 1);
    if (probe.getFullYear() !== year || probe.getMonth() !== month - 1) {
      console.error('Error: --date month is invalid.');
      process.exit(1);
    }
    return {
      granularity: 'month',
      dateKey: value,
      start: new Date(year, month - 1, 1, 0, 0, 0, 0),
      end: new Date(year, month, 0, 23, 59, 59, 999),
    };
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [yearText, monthText, dayText] = value.split('-');
    const year = Number(yearText);
    const month = Number(monthText);
    const day = Number(dayText);
    const probe = new Date(year, month - 1, day);
    if (
      probe.getFullYear() !== year ||
      probe.getMonth() !== month - 1 ||
      probe.getDate() !== day
    ) {
      console.error('Error: --date day is invalid.');
      process.exit(1);
    }
    return {
      granularity: 'day',
      dateKey: value,
      start: new Date(year, month - 1, day, 0, 0, 0, 0),
      end: new Date(year, month - 1, day, 23, 59, 59, 999),
    };
  }

  console.error('Error: --date format must be yyyy or yyyy-mm or yyyy-mm-dd.');
  process.exit(1);
}

function formatDateYmd(date: Date): string {
  const year = String(date.getFullYear());
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function buildRecentWeekRangeUntilYesterday(): ParsedDateOption {
  const today = new Date();

  const end = new Date(
    today.getFullYear(),
    today.getMonth(),
    today.getDate() - 1,
    23,
    59,
    59,
    999,
  );
  const start = new Date(
    today.getFullYear(),
    today.getMonth(),
    today.getDate() - 8,
    0,
    0,
    0,
    0,
  );

  return {
    granularity: 'day',
    dateKey: `${formatDateYmd(start)}..${formatDateYmd(end)}`,
    start,
    end,
  };
}

function resolveRankingRangeOption(options: { date?: string; today?: boolean }): ParsedDateOption {
  if (options.today && options.date) {
    console.error('Error: --today and --date cannot be used together.');
    process.exit(1);
  }
  if (options.today) {
    return parseDateOption();
  }
  if (options.date) {
    return parseDateOption(options.date);
  }
  return buildRecentWeekRangeUntilYesterday();
}

function buildStatsDateRange(dateOption: string | undefined, daysOption: string): {
  range: ParsedDateOption;
  days: number;
  startLabel: string;
  endLabel: string;
} {
  if (!dateOption && daysOption === '7') {
    const weekly = buildRecentWeekRangeUntilYesterday();
    return {
      range: weekly,
      days: 7,
      startLabel: formatDateYmd(weekly.start),
      endLabel: formatDateYmd(weekly.end),
    };
  }

  const days = parsePositiveIntegerOption(daysOption, '--days');
  let endDate: Date;

  if (dateOption) {
    const parsed = parseDateOption(dateOption);
    endDate = new Date(parsed.end);
  } else {
    const now = new Date();
    endDate = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate() - 1,
      23,
      59,
      59,
      999,
    );
  }

  const startDate = new Date(
    endDate.getFullYear(),
    endDate.getMonth(),
    endDate.getDate(),
    0,
    0,
    0,
    0,
  );
  startDate.setDate(startDate.getDate() - (days - 1));

  const startLabel = formatDateYmd(startDate);
  const endLabel = formatDateYmd(endDate);

  return {
    range: {
      granularity: 'day',
      dateKey: `${startLabel}..${endLabel}`,
      start: startDate,
      end: endDate,
    },
    days,
    startLabel,
    endLabel,
  };
}

function getDateHourStrings(): string[] {
  const hours: string[] = [];
  for (let hour = 0; hour < 24; hour++) {
    hours.push(String(hour).padStart(2, '0'));
  }
  return hours;
}

function buildHourlyBucketKey(year: string, month: string, day: string, hour: string): string {
  return `${year}-${month}-${day}-${hour}`;
}

function splitHourlyBucketKey(key: string): { year: string; month: string; day: string; hour: string } {
  const [year, month, day, hour] = key.split('-');
  return { year, month, day, hour };
}

function toDateParts(date: Date): { year: string; month: string; day: string; hour: string } {
  return {
    year: String(date.getFullYear()),
    month: String(date.getMonth() + 1).padStart(2, '0'),
    day: String(date.getDate()).padStart(2, '0'),
    hour: String(date.getHours()).padStart(2, '0'),
  };
}

function getDatePartsInRange(start: Date, end: Date): Array<{ year: string; month: string; day: string }> {
  const dates: Array<{ year: string; month: string; day: string }> = [];
  const cursor = new Date(start.getFullYear(), start.getMonth(), start.getDate(), 0, 0, 0, 0);
  const last = new Date(end.getFullYear(), end.getMonth(), end.getDate(), 0, 0, 0, 0);

  while (cursor.getTime() <= last.getTime()) {
    dates.push({
      year: String(cursor.getFullYear()),
      month: String(cursor.getMonth() + 1).padStart(2, '0'),
      day: String(cursor.getDate()).padStart(2, '0'),
    });
    cursor.setDate(cursor.getDate() + 1);
  }

  return dates;
}

function loadImageIdsFromDateRangeCache(targetDate: ParsedDateOption): string[] {
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

function normalizeRankingValues(values: string[]): string[] {
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

function normalizeHourlyMetadataEntries(
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

function extractImageApps(image: any): string[] {
  const app = normalizeText(image?.metadata?.app);
  return app ? [app] : [];
}

function extractImageDomains(image: any): string[] {
  const domain = extractDomain(normalizeText(image?.metadata?.url));
  return domain ? [domain] : [];
}

function extractImageLocations(image: any): string[] {
  const location = normalizeText(extractImageLocationLabel(image));
  return location ? [location] : [];
}

function normalizeTagText(value?: string): string | undefined {
  if (!value) return undefined;
  const normalized = normalizeText(value);
  if (!normalized) return undefined;
  const stripped = normalized.replace(/^[#＃]+/, '').trim();
  return stripped.length > 0 ? stripped : undefined;
}

function extractTagFromLinkValue(value: any): string | undefined {
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

function extractImageTags(image: any): string[] {
  const rawLinks = image?.metadata?.links ?? image?.links;
  if (!Array.isArray(rawLinks)) return [];

  const tags: string[] = [];
  for (const rawLink of rawLinks) {
    const tag = extractTagFromLinkValue(rawLink);
    if (tag) tags.push(tag);
  }

  return normalizeRankingValues(tags);
}

async function warmDateCacheForApps(
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

async function warmDateCacheForDomains(
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

async function warmDateCacheForTags(
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

async function warmDateCacheForLocations(
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

async function warmDateCacheForList(
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

async function warmDateCacheForRanking(
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

function buildHourlyMetadataEntriesFromImageCache(
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

function loadOrBuildHourlyMetadataEntries(
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

function aggregateRankingFromHourlyMetadataCache(
  targetDate: ParsedDateOption,
  metadataKind: HourlyMetadataKind,
  extractValues: MetadataValueExtractor,
): RankingFromHourlySummary {
  const counts = new Map<string, number>();
  const seenImageIds = new Set<string>();
  let totalImages = 0;
  let imageCountWithValues = 0;
  let totalAssignments = 0;

  const dates = getDatePartsInRange(targetDate.start, targetDate.end);
  const hours = getDateHourStrings();

  for (const date of dates) {
    for (const hour of hours) {
      const entries = loadOrBuildHourlyMetadataEntries(
        metadataKind,
        date.year,
        date.month,
        date.day,
        hour,
        extractValues,
      );

      for (const [imageId, values] of Object.entries(entries)) {
        if (seenImageIds.has(imageId)) continue;
        seenImageIds.add(imageId);
        totalImages++;

        if (values.length === 0) continue;
        imageCountWithValues++;
        totalAssignments += values.length;
        for (const value of values) {
          counts.set(value, (counts.get(value) || 0) + 1);
        }
      }
    }
  }

  const ranking = Array.from(counts.entries())
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      return a.key.localeCompare(b.key);
    });

  return {
    ranking,
    totalImages,
    imageCountWithValues,
    totalAssignments,
  };
}

function buildAppsRankingFromCache(imageIds: string[]): AppRank[] {
  const counts = new Map<string, number>();

  for (const imageId of imageIds) {
    const image = loadImageCache(imageId);
    const apps = extractImageApps(image);
    if (apps.length === 0) continue;

    const app = apps[0];
    counts.set(app, (counts.get(app) || 0) + 1);
  }

  return Array.from(counts.entries())
    .map(([app, count]) => ({ app, count }))
    .sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      return a.app.localeCompare(b.app);
    });
}

function buildAppsRankingFromHourlyCache(targetDate: ParsedDateOption): {
  ranking: AppRank[];
  totalImages: number;
  imageCountWithApps: number;
} {
  const summary = aggregateRankingFromHourlyMetadataCache(targetDate, 'apps', extractImageApps);
  return {
    ranking: summary.ranking.map(item => ({ app: item.key, count: item.count })),
    totalImages: summary.totalImages,
    imageCountWithApps: summary.imageCountWithValues,
  };
}

function buildDomainsRankingFromCache(imageIds: string[]): DomainRank[] {
  const counts = new Map<string, number>();

  for (const imageId of imageIds) {
    const image = loadImageCache(imageId);
    const domains = extractImageDomains(image);
    if (domains.length === 0) continue;

    const domain = domains[0];
    counts.set(domain, (counts.get(domain) || 0) + 1);
  }

  return Array.from(counts.entries())
    .map(([domain, count]) => ({ domain, count }))
    .sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      return a.domain.localeCompare(b.domain);
    });
}

function buildDomainsRankingFromHourlyCache(targetDate: ParsedDateOption): {
  ranking: DomainRank[];
  totalImages: number;
  imageCountWithDomains: number;
} {
  const summary = aggregateRankingFromHourlyMetadataCache(targetDate, 'domains', extractImageDomains);
  return {
    ranking: summary.ranking.map(item => ({ domain: item.key, count: item.count })),
    totalImages: summary.totalImages,
    imageCountWithDomains: summary.imageCountWithValues,
  };
}

function buildLocationsRankingFromCache(imageIds: string[]): LocationRank[] {
  const counts = new Map<string, number>();

  for (const imageId of imageIds) {
    const image = loadImageCache(imageId);
    const locations = extractImageLocations(image);
    if (locations.length === 0) continue;

    const location = locations[0];
    counts.set(location, (counts.get(location) || 0) + 1);
  }

  return Array.from(counts.entries())
    .map(([location, count]) => ({ location, count }))
    .sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      return a.location.localeCompare(b.location);
    });
}

function buildLocationsRankingFromHourlyCache(targetDate: ParsedDateOption): {
  ranking: LocationRank[];
  totalImages: number;
  imageCountWithLocations: number;
} {
  const summary = aggregateRankingFromHourlyMetadataCache(targetDate, 'locations', extractImageLocations);
  return {
    ranking: summary.ranking.map(item => ({ location: item.key, count: item.count })),
    totalImages: summary.totalImages,
    imageCountWithLocations: summary.imageCountWithValues,
  };
}

function buildTagsRankingFromCache(imageIds: string[]): TagRankingSummary {
  const counts = new Map<string, number>();
  let imageCountWithTags = 0;
  let totalTagAssignments = 0;

  for (const imageId of imageIds) {
    const image = loadImageCache(imageId);
    const tags = extractImageTags(image);
    if (tags.length === 0) continue;

    imageCountWithTags++;
    for (const tag of tags) {
      counts.set(tag, (counts.get(tag) || 0) + 1);
      totalTagAssignments++;
    }
  }

  const ranking = Array.from(counts.entries())
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      return a.tag.localeCompare(b.tag);
    });

  return {
    ranking,
    imageCountWithTags,
    totalTagAssignments,
  };
}

function buildTagsRankingFromHourlyCache(targetDate: ParsedDateOption): TagRankingSummary & { totalImages: number } {
  const summary = aggregateRankingFromHourlyMetadataCache(targetDate, 'tags', extractImageTags);
  return {
    ranking: summary.ranking.map(item => ({ tag: item.key, count: item.count })),
    totalImages: summary.totalImages,
    imageCountWithTags: summary.imageCountWithValues,
    totalTagAssignments: summary.totalAssignments,
  };
}

function buildUploadTimeSummaryFromHourlyCache(targetDate: ParsedDateOption): UploadTimeSummary {
  const seen = new Set<string>();
  const hourCounts = Array.from({ length: 24 }, (_, hour) => ({ hour, count: 0 }));
  const weekdayCounts = Array.from({ length: 7 }, (_, weekday) => ({ weekday, count: 0 }));
  const dates = getDatePartsInRange(targetDate.start, targetDate.end);
  const hours = getDateHourStrings();

  for (const date of dates) {
    for (const hourText of hours) {
      const hour = Number(hourText);
      const imageIds = loadHourlyCache(date.year, date.month, date.day, hourText) || [];
      const weekday = new Date(
        Number(date.year),
        Number(date.month) - 1,
        Number(date.day),
        hour,
        0,
        0,
        0,
      ).getDay();

      for (const imageId of imageIds) {
        if (seen.has(imageId)) continue;
        seen.add(imageId);
        hourCounts[hour].count++;
        weekdayCounts[weekday].count++;
      }
    }
  }

  return {
    totalImages: seen.size,
    byHour: hourCounts.sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      return a.hour - b.hour;
    }),
    byWeekday: weekdayCounts.sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      return a.weekday - b.weekday;
    }),
  };
}

function buildUploadTimeSummaryFromImageCache(
  imageIds: string[],
  targetDate: ParsedDateOption,
): UploadTimeSummary {
  const seen = new Set<string>();
  const hourCounts = Array.from({ length: 24 }, (_, hour) => ({ hour, count: 0 }));
  const weekdayCounts = Array.from({ length: 7 }, (_, weekday) => ({ weekday, count: 0 }));

  for (const imageId of imageIds) {
    if (seen.has(imageId)) continue;

    const image = loadImageCache(imageId);
    const createdAtText = normalizeText(image?.created_at);
    if (!createdAtText) continue;

    const createdAt = new Date(createdAtText);
    if (Number.isNaN(createdAt.getTime())) continue;
    if (createdAt < targetDate.start || createdAt > targetDate.end) continue;

    seen.add(imageId);
    hourCounts[createdAt.getHours()].count++;
    weekdayCounts[createdAt.getDay()].count++;
  }

  return {
    totalImages: seen.size,
    byHour: hourCounts.sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      return a.hour - b.hour;
    }),
    byWeekday: weekdayCounts.sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      return a.weekday - b.weekday;
    }),
  };
}

function buildDailyUploadCountsFromHourlyCache(targetDate: ParsedDateOption): DailyUploadCount[] {
  const dates = getDatePartsInRange(targetDate.start, targetDate.end);
  const hours = getDateHourStrings();
  const byDate = new Map<string, Set<string>>();

  for (const date of dates) {
    const dateLabel = `${date.year}-${date.month}-${date.day}`;
    if (!byDate.has(dateLabel)) {
      byDate.set(dateLabel, new Set());
    }

    const ids = byDate.get(dateLabel)!;
    for (const hour of hours) {
      const imageIds = loadHourlyCache(date.year, date.month, date.day, hour) || [];
      for (const imageId of imageIds) ids.add(imageId);
    }
  }

  return dates.map(date => {
    const dateLabel = `${date.year}-${date.month}-${date.day}`;
    return {
      date: dateLabel,
      count: byDate.get(dateLabel)?.size || 0,
    };
  });
}

function buildDailyUploadCountsFromImageCache(
  imageIds: string[],
  targetDate: ParsedDateOption,
): DailyUploadCount[] {
  const dates = getDatePartsInRange(targetDate.start, targetDate.end);
  const byDate = new Map<string, Set<string>>();

  for (const date of dates) {
    const dateLabel = `${date.year}-${date.month}-${date.day}`;
    byDate.set(dateLabel, new Set());
  }

  for (const imageId of imageIds) {
    const image = loadImageCache(imageId);
    const createdAtText = normalizeText(image?.created_at);
    if (!createdAtText) continue;

    const createdAt = new Date(createdAtText);
    if (Number.isNaN(createdAt.getTime())) continue;
    if (createdAt < targetDate.start || createdAt > targetDate.end) continue;

    const dateLabel = formatDateYmd(createdAt);
    const ids = byDate.get(dateLabel);
    if (!ids) continue;
    ids.add(imageId);
  }

  return dates.map(date => {
    const dateLabel = `${date.year}-${date.month}-${date.day}`;
    return {
      date: dateLabel,
      count: byDate.get(dateLabel)?.size || 0,
    };
  });
}

function buildDailySummariesFromImageCache(targetDate: ParsedDateOption): DailySummary[] {
  const dates = getDatePartsInRange(targetDate.start, targetDate.end);
  const hours = getDateHourStrings();
  const summaries: DailySummary[] = [];

  for (const date of dates) {
    const dateLabel = `${date.year}-${date.month}-${date.day}`;
    const imageIds = new Set<string>();

    for (const hour of hours) {
      const ids = loadHourlyCache(date.year, date.month, date.day, hour) || [];
      for (const id of ids) imageIds.add(id);
    }

    const appCounts = new Map<string, number>();
    const domainCounts = new Map<string, number>();
    const tagCounts = new Map<string, number>();
    const locationCounts = new Map<string, number>();

    for (const imageId of imageIds) {
      const image = loadImageCache(imageId);
      if (!image) continue;

      for (const app of extractImageApps(image)) {
        appCounts.set(app, (appCounts.get(app) || 0) + 1);
      }
      for (const domain of extractImageDomains(image)) {
        domainCounts.set(domain, (domainCounts.get(domain) || 0) + 1);
      }
      for (const tag of extractImageTags(image)) {
        tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
      }
      for (const location of extractImageLocations(image)) {
        locationCounts.set(location, (locationCounts.get(location) || 0) + 1);
      }
    }

    const sortEntries = (a: [string, number], b: [string, number]) => {
      if (b[1] !== a[1]) return b[1] - a[1];
      return a[0].localeCompare(b[0]);
    };

    const apps = Array.from(appCounts.entries())
      .sort(sortEntries)
      .map(([app, count]) => ({ app, count }));
    const domains = Array.from(domainCounts.entries())
      .sort(sortEntries)
      .map(([domain, count]) => ({ domain, count }));
    const tags = Array.from(tagCounts.entries())
      .sort(sortEntries)
      .map(([tag, count]) => ({ tag, count }));
    const locations = Array.from(locationCounts.entries())
      .sort(sortEntries)
      .map(([location, count]) => ({ location, count }));

    summaries.push({
      date: dateLabel,
      imageCount: imageIds.size,
      apps,
      domains,
      tags,
      locations,
    });
  }

  return summaries;
}

function appendStatsRankSection(
  lines: string[],
  title: string,
  rows: Array<{ label: string; count: number }>,
  top: number,
): void {
  lines.push(`### ${title}`);
  const filtered = rows.filter(row => row.count > 0).slice(0, top);
  if (filtered.length === 0) {
    lines.push('- No data');
    lines.push('');
    return;
  }

  for (const row of filtered) {
    lines.push(`- ${row.label}: ${row.count}`);
  }
  lines.push('');
}

function renderStatsMarkdown(params: {
  startLabel: string;
  endLabel: string;
  days: number;
  totalUploads: number;
  uploadTime: UploadTimeSummary;
  apps: AppRank[];
  domains: DomainRank[];
  tags: TagRank[];
  top: number;
}): string {
  const lines: string[] = [];
  lines.push('## Gyazo Stats');
  lines.push('');
  lines.push(`- Window: ${params.startLabel} to ${params.endLabel} (${params.days} days)`);
  lines.push(`- Total uploads: ${params.totalUploads}`);
  lines.push('');

  appendStatsRankSection(
    lines,
    'Upload Time (Hour)',
    params.uploadTime.byHour.map(item => ({
      label: `${String(item.hour).padStart(2, '0')}:00`,
      count: item.count,
    })),
    params.top,
  );

  appendStatsRankSection(
    lines,
    'Upload Weekday',
    params.uploadTime.byWeekday.map(item => ({
      label: WEEKDAY_LABELS[item.weekday] || String(item.weekday),
      count: item.count,
    })),
    Math.min(params.top, 7),
  );

  appendStatsRankSection(
    lines,
    'Apps',
    params.apps.map(item => ({ label: item.app, count: item.count })),
    params.top,
  );

  appendStatsRankSection(
    lines,
    'Domains',
    params.domains.map(item => ({ label: item.domain, count: item.count })),
    params.top,
  );

  appendStatsRankSection(
    lines,
    'Tags',
    params.tags.map(item => ({ label: `#${item.tag}`, count: item.count })),
    params.top,
  );

  return lines.join('\n').trimEnd();
}

function renderSummaryText(params: {
  dateKey: string;
  dailySummaries: DailySummary[];
  limit: number;
}): string {
  const appendRankSection = (
    lines: string[],
    title: string,
    rows: Array<{ label: string; count: number }>,
    limit: number,
  ) => {
    lines.push(`- ${title}:`);
    const items = rows.filter(row => row.count > 0).slice(0, limit);
    if (items.length === 0) {
      lines.push('  - (none)');
      return;
    }
    for (const row of items) {
      lines.push(`  - ${row.label}${row.count > 1 ? ` (${row.count})` : ''}`);
    }
  };

  const lines: string[] = [];
  lines.push('## Gyazo Summary');
  lines.push('');
  lines.push(`- Window: ${params.dateKey}`);
  lines.push('');

  for (const day of params.dailySummaries) {
    lines.push(`### ${day.date}`);
    lines.push(`- Image count: ${day.imageCount}`);
    appendRankSection(
      lines,
      'Apps',
      day.apps.map(item => ({ label: item.app, count: item.count })),
      params.limit,
    );
    appendRankSection(
      lines,
      'Domains',
      day.domains.map(item => ({ label: item.domain, count: item.count })),
      params.limit,
    );
    appendRankSection(
      lines,
      'Tags',
      day.tags.map(item => ({ label: `#${item.tag}`, count: item.count })),
      params.limit,
    );
    appendRankSection(
      lines,
      'Locations',
      day.locations.map(item => ({ label: item.location, count: item.count })),
      params.limit,
    );
    lines.push('');
  }

  return lines.join('\n').trimEnd();
}

async function readStdinBuffer(): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on('data', (chunk: Buffer | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    process.stdin.on('end', () => resolve(Buffer.concat(chunks)));
    process.stdin.on('error', reject);
  });
}

function printGetMarkdown(image: any, ocrDescription?: string, objects: DisplayObjectAnnotation[] = []): void {
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

function summarizeImageForList(img: any): string {
  const domain = extractDomain(normalizeText(img.metadata?.url));
  const cleanedTitle = sanitizeSummaryText(img.metadata?.title, domain);
  const cleanedDesc = sanitizeSummaryText(img.metadata?.desc, domain);
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

function shouldEnrichForLocationDisplay(img: any): boolean {
  const locationLabel = sanitizeSummaryText(extractImageLocationLabel(img));
  return !locationLabel;
}

function mergeImageForDisplay(base: any, detail: any): any {
  return {
    ...base,
    ...detail,
    metadata: {
      ...(base?.metadata || {}),
      ...(detail?.metadata || {}),
    },
    ocr: detail?.ocr ?? base?.ocr,
  };
}

function cacheSearchResultImages(images: any[]): void {
  for (const img of images) {
    if (!img?.image_id) continue;
    saveSearchImageCache(img.image_id, img);
  }
}

function supplementAltTextFromSearchCache(image: any, useCache: boolean = true): { image: any; supplemented: boolean } {
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

function supplementAltTextForDisplay(images: any[], useCache: boolean = true): any[] {
  return images.map(img => supplementAltTextFromSearchCache(img, useCache).image);
}

type DisplayPreparationOptions = {
  cacheSearchResults?: boolean;
  enrichLocation?: boolean;
  useCache?: boolean;
};

async function prepareImagesForDisplay(images: any[], options: DisplayPreparationOptions = {}): Promise<any[]> {
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

async function enrichImagesForLocationDisplay(images: any[], useCache: boolean = true): Promise<any[]> {
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

function printListImages(images: any[]): void {
  images.forEach(img => {
    const summary = truncateText(summarizeImageForList(img), 120);
    const created = formatCreatedAt(img.created_at);
    const shortId = shortenImageId(img.image_id);
    const imageUrl = img.permalink_url || `https://gyazo.com/${img.image_id}`;
    const linkedId = formatTerminalLink(shortId, imageUrl);
    console.log(`- [${created}] ${summary} (id: ${linkedId})`);
  });
}

program
  .command('list')
  .alias('ls')
  .description('List recent images')
  .option('-p, --page <number>', 'page number', '1')
  .option('-l, --limit <number>', 'items per page', '20')
  .option('-j, --json', 'output as JSON')
  .option('-H, --hour <yyyy-mm-dd-hh>', 'target hour')
  .option('--date <yyyy|yyyy-mm|yyyy-mm-dd>', 'target date/range')
  .option('--today', 'target today only')
  .option('--max-pages <number>', 'max pages to scan for --date/--today mode', '100')
  .option('--photos', 'alias of search "has:location"')
  .option('--uploaded', 'alias of search "gyazocli_uploads"')
  .option('--no-cache', 'force fetch from API')
  .action(async (options) => {
    await ensureAccessToken();
    try {
      const useCache = options.cache !== false;
      const page = parsePositiveIntegerOption(options.page, '--page');
      const limit = parsePositiveIntegerOption(options.limit, '--limit');
      const maxPages = parsePositiveIntegerOption(options.maxPages, '--max-pages');
      const hasDateRange = Boolean(options.date || options.today);
      const targetDate = hasDateRange
        ? (options.today ? parseDateOption() : parseDateOption(options.date))
        : undefined;

      if (options.photos && options.uploaded) {
        console.error('Error: --photos and --uploaded cannot be used together.');
        process.exit(1);
      }
      if (options.today && options.date) {
        console.error('Error: --today and --date cannot be used together.');
        process.exit(1);
      }
      if ((options.photos || options.uploaded) && options.hour) {
        console.error('Error: --photos/--uploaded and --hour cannot be used together.');
        process.exit(1);
      }
      if (options.hour && hasDateRange) {
        console.error('Error: --hour and --date/--today cannot be used together.');
        process.exit(1);
      }

      const aliasQuery = options.photos
        ? 'has:location'
        : options.uploaded
          ? 'gyazocli_uploads'
          : undefined;
      if (aliasQuery) {
        let images: any[] = [];
        if (targetDate) {
          const collected: any[] = [];
          for (let searchPage = 1; searchPage <= maxPages; searchPage++) {
            const pageImages = await searchImages(aliasQuery, searchPage, 100);
            if (pageImages.length === 0) break;

            let reachedLimit = false;
            for (const img of pageImages) {
              const createdAt = new Date(img.created_at);
              if (Number.isNaN(createdAt.getTime())) continue;
              if (createdAt > targetDate.end) continue;
              if (createdAt < targetDate.start) {
                reachedLimit = true;
                break;
              }
              collected.push(img);
            }
            if (reachedLimit) break;
          }

          collected.sort((a, b) => {
            const ta = new Date(a.created_at).getTime();
            const tb = new Date(b.created_at).getTime();
            return tb - ta;
          });

          const startIndex = (page - 1) * limit;
          images = collected.slice(startIndex, startIndex + limit);
        } else {
          images = await searchImages(
            aliasQuery,
            page,
            limit,
          );
        }

        if (options.json) {
          console.log(JSON.stringify(images, null, 2));
        } else {
          const imagesForDisplay = await prepareImagesForDisplay(images, {
            cacheSearchResults: true,
            enrichLocation: true,
            useCache,
          });
          printListImages(imagesForDisplay);
        }
        return;
      }

      if (targetDate) {
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
          console.log(`No images found for ${targetDate.dateKey}.`);
          return;
        }

        let images = imageIds
          .map(id => loadImageCache(id))
          .filter((img): img is any => img !== null);
        images = images.filter((img) => {
          const createdAt = new Date(img.created_at);
          if (Number.isNaN(createdAt.getTime())) return false;
          return createdAt >= targetDate.start && createdAt <= targetDate.end;
        });

        images.sort((a, b) => {
          const ta = new Date(a.created_at).getTime();
          const tb = new Date(b.created_at).getTime();
          return tb - ta;
        });

        const startIndex = (page - 1) * limit;
        const pageImages = images.slice(startIndex, startIndex + limit);
        if (options.json) {
          console.log(JSON.stringify(pageImages, null, 2));
        } else {
          const imagesForDisplay = await prepareImagesForDisplay(pageImages, {
            enrichLocation: true,
            useCache,
          });
          printListImages(imagesForDisplay);
        }
        return;
      }

      if (options.hour) {
        const parts = options.hour.split('-');
        if (parts.length !== 4) {
          console.error('Error: hour format must be yyyy-mm-dd-hh');
          process.exit(1);
        }
        const [year, month, day, hour] = parts;
        const imageIds = loadHourlyCache(year, month, day, hour);
        if (!imageIds) {
          console.log(`No images found for ${options.hour} in cache.`);
          return;
        }

        let images: any[] = [];
        if (useCache) {
          images = imageIds.map(id => loadImageCache(id)).filter(img => img !== null);
        } else {
          for (const imageId of imageIds) {
            try {
              const detail = await getImageDetail(imageId);
              saveImageCache(imageId, detail);
              images.push(detail);
            } catch (_error) {
              // Skip failed items and continue with the rest.
            }
          }
        }
        if (options.json) {
          console.log(JSON.stringify(images, null, 2));
        } else {
          const imagesForDisplay = await prepareImagesForDisplay(images, {
            enrichLocation: true,
            useCache,
          });
          printListImages(imagesForDisplay);
        }
        return;
      }

      const images = await listImages(page, limit);
      if (options.json) {
        console.log(JSON.stringify(images, null, 2));
      } else {
        const imagesForDisplay = await prepareImagesForDisplay(images, {
          enrichLocation: true,
          useCache,
        });
        printListImages(imagesForDisplay);
      }
    } catch (error: any) {
      console.error('Error listing images:', error.message);
    }
  });

program
  .command('get <image_id>')
  .description('Get detailed metadata for an image')
  .option('-j, --json', 'output as JSON')
  .option('--ocr', 'output OCR text only')
  .option('--objects', 'output object annotations only')
  .option('--no-cache', 'force fetch from API')
  .action(async (imageId, options) => {
    await ensureAccessToken();
    try {
      if (options.json && (options.ocr || options.objects)) {
        console.error('Error: --json cannot be used with --ocr or --objects.');
        process.exit(1);
      }
      if (options.ocr && options.objects) {
        console.error('Error: --ocr and --objects cannot be used together.');
        process.exit(1);
      }

      let image = options.cache !== false ? loadImageCache(imageId) : null;
      if (!image) {
        image = await getImageDetail(imageId);
        saveImageCache(imageId, image);
      }

      const supplemented = supplementAltTextFromSearchCache(image);
      image = supplemented.image;
      if (supplemented.supplemented) {
        saveImageCache(imageId, image);
      }

      const ocrDescription = extractOcrDescription(image);
      const objects = extractObjectAnnotations(image);

      if (options.ocr) {
        if (!ocrDescription) {
          console.error('OCR not found for this image.');
          process.exit(1);
        }
        console.log(ocrDescription);
        return;
      }

      if (options.objects) {
        if (objects.length === 0) {
          console.error('Object annotations not found for this image.');
          process.exit(1);
        }
        console.log(objects.map(formatObjectAnnotationLine).join('\n'));
        return;
      }

      if (options.json) {
        console.log(JSON.stringify(image, null, 2));
      } else {
        printGetMarkdown(image, ocrDescription, objects);
      }
    } catch (error: any) {
      console.error('Error getting image:', error.message);
    }
  });

program
  .command('search [query]')
  .description('Search images')
  .option('-j, --json', 'output as JSON')
  .option('--no-cache', 'force fetch from API')
  .action(async (query, options) => {
    await ensureAccessToken();
    try {
      if (!normalizeText(query)) {
        console.error('Error: Query is required.');
        console.error('Hint: Run `gyazo search -h` for usage.');
        process.exit(1);
      }

      const images = await searchImages(query);
      const useCache = options.cache !== false;
      if (options.json) {
        cacheSearchResultImages(images);
        console.log(JSON.stringify(images, null, 2));
      } else {
        const imagesForDisplay = await prepareImagesForDisplay(images, {
          cacheSearchResults: true,
          enrichLocation: true,
          useCache,
        });
        printListImages(imagesForDisplay);
      }
    } catch (error: any) {
      console.error('Error searching images:', error.message);
    }
  });

program
  .command('apps')
  .description('Rank metadata app names for a specific date')
  .option('--date <yyyy|yyyy-mm|yyyy-mm-dd>', 'target date/range')
  .option('--today', 'target today only (overrides default weekly range)')
  .option('-l, --limit <number>', 'maximum ranking rows (max: 10)', '10')
  .option('--max-pages <number>', 'max pages to scan before stopping', '10')
  .option('-j, --json', 'output as JSON')
  .option('--no-cache', 'force fetch from API')
  .action(async (options) => {
    await ensureAccessToken();
    try {
      const targetDate = resolveRankingRangeOption(options);
      const requestedLimit = parsePositiveIntegerOption(options.limit, '--limit');
      const limit = Math.min(requestedLimit, 10);
      const maxPages = parsePositiveIntegerOption(options.maxPages, '--max-pages');
      const useCache = options.cache !== false;

      let ranking: AppRank[] = [];
      let totalWithApp = 0;
      let totalImages = 0;

      if (useCache) {
        let cacheSummary = buildAppsRankingFromHourlyCache(targetDate);
        if (cacheSummary.totalImages === 0) {
          await warmDateCacheForApps(targetDate, maxPages, true);
          cacheSummary = buildAppsRankingFromHourlyCache(targetDate);
        }
        ranking = cacheSummary.ranking;
        totalWithApp = cacheSummary.imageCountWithApps;
        totalImages = cacheSummary.totalImages;
      } else {
        const imageIds = await warmDateCacheForApps(targetDate, maxPages, false);
        ranking = buildAppsRankingFromCache(imageIds);
        totalWithApp = ranking.reduce((sum, item) => sum + item.count, 0);
        totalImages = imageIds.length;
      }

      const displayedRanking = ranking.slice(0, limit);

      if (options.json) {
        console.log(JSON.stringify({
          date: targetDate.dateKey,
          image_count: totalImages,
          app_image_count: totalWithApp,
          total_apps: ranking.length,
          ranking: displayedRanking,
        }, null, 2));
        return;
      }

      if (ranking.length === 0) {
        console.log(`No app metadata found for ${targetDate.dateKey}.`);
        return;
      }

      console.log(`Apps on ${targetDate.dateKey}`);
      displayedRanking.forEach((item, index) => {
        console.log(`${index + 1}. ${item.app}: ${item.count}`);
      });
      console.log(`Total images with app metadata: ${totalWithApp}`);
    } catch (error: any) {
      console.error('Error ranking apps:', error.message);
      process.exit(1);
    }
  });

program
  .command('domains')
  .description('Rank metadata URL domains for a specific date')
  .option('--date <yyyy|yyyy-mm|yyyy-mm-dd>', 'target date/range')
  .option('--today', 'target today only (overrides default weekly range)')
  .option('-l, --limit <number>', 'maximum ranking rows (max: 10)', '10')
  .option('--max-pages <number>', 'max pages to scan before stopping', '10')
  .option('-j, --json', 'output as JSON')
  .option('--no-cache', 'force fetch from API')
  .action(async (options) => {
    await ensureAccessToken();
    try {
      const targetDate = resolveRankingRangeOption(options);
      const requestedLimit = parsePositiveIntegerOption(options.limit, '--limit');
      const limit = Math.min(requestedLimit, 10);
      const maxPages = parsePositiveIntegerOption(options.maxPages, '--max-pages');
      const useCache = options.cache !== false;

      let ranking: DomainRank[] = [];
      let totalWithDomain = 0;
      let totalImages = 0;

      if (useCache) {
        let cacheSummary = buildDomainsRankingFromHourlyCache(targetDate);
        if (cacheSummary.totalImages === 0) {
          await warmDateCacheForDomains(targetDate, maxPages, true);
          cacheSummary = buildDomainsRankingFromHourlyCache(targetDate);
        }
        ranking = cacheSummary.ranking;
        totalWithDomain = cacheSummary.imageCountWithDomains;
        totalImages = cacheSummary.totalImages;
      } else {
        const imageIds = await warmDateCacheForDomains(targetDate, maxPages, false);
        ranking = buildDomainsRankingFromCache(imageIds);
        totalWithDomain = ranking.reduce((sum, item) => sum + item.count, 0);
        totalImages = imageIds.length;
      }

      const displayedRanking = ranking.slice(0, limit);

      if (options.json) {
        console.log(JSON.stringify({
          date: targetDate.dateKey,
          image_count: totalImages,
          domain_image_count: totalWithDomain,
          total_domains: ranking.length,
          ranking: displayedRanking,
        }, null, 2));
        return;
      }

      if (ranking.length === 0) {
        console.log(`No domain metadata found for ${targetDate.dateKey}.`);
        return;
      }

      console.log(`Domains on ${targetDate.dateKey}`);
      displayedRanking.forEach((item, index) => {
        console.log(`${index + 1}. ${item.domain}: ${item.count}`);
      });
      console.log(`Total images with domain metadata: ${totalWithDomain}`);
    } catch (error: any) {
      console.error('Error ranking domains:', error.message);
      process.exit(1);
    }
  });

program
  .command('tags')
  .description('Rank metadata tags for a specific date')
  .option('--date <yyyy|yyyy-mm|yyyy-mm-dd>', 'target date/range')
  .option('--today', 'target today only (overrides default weekly range)')
  .option('-l, --limit <number>', 'maximum ranking rows (max: 10)', '10')
  .option('--max-pages <number>', 'max pages to scan before stopping', '10')
  .option('-j, --json', 'output as JSON')
  .option('--no-cache', 'force fetch from API')
  .action(async (options) => {
    await ensureAccessToken();
    try {
      const targetDate = resolveRankingRangeOption(options);
      const requestedLimit = parsePositiveIntegerOption(options.limit, '--limit');
      const limit = Math.min(requestedLimit, 10);
      const maxPages = parsePositiveIntegerOption(options.maxPages, '--max-pages');
      const useCache = options.cache !== false;

      let summary: TagRankingSummary;
      let totalImages = 0;

      if (useCache) {
        let cacheSummary = buildTagsRankingFromHourlyCache(targetDate);
        if (cacheSummary.totalImages === 0) {
          await warmDateCacheForTags(targetDate, maxPages, true);
          cacheSummary = buildTagsRankingFromHourlyCache(targetDate);
        }
        summary = cacheSummary;
        totalImages = cacheSummary.totalImages;
      } else {
        const imageIds = await warmDateCacheForTags(targetDate, maxPages, false);
        summary = buildTagsRankingFromCache(imageIds);
        totalImages = imageIds.length;
      }

      const displayedRanking = summary.ranking.slice(0, limit);

      if (options.json) {
        console.log(JSON.stringify({
          date: targetDate.dateKey,
          image_count: totalImages,
          image_count_with_tags: summary.imageCountWithTags,
          total_tag_assignments: summary.totalTagAssignments,
          total_tags: summary.ranking.length,
          ranking: displayedRanking,
        }, null, 2));
        return;
      }

      if (summary.ranking.length === 0) {
        console.log(`No tag metadata found for ${targetDate.dateKey}.`);
        return;
      }

      console.log(`Tags on ${targetDate.dateKey}`);
      displayedRanking.forEach((item, index) => {
        console.log(`${index + 1}. #${item.tag}: ${item.count}`);
      });
      console.log(`Total images with tag metadata: ${summary.imageCountWithTags}`);
    } catch (error: any) {
      console.error('Error ranking tags:', error.message);
      process.exit(1);
    }
  });

program
  .command('locations')
  .description('Rank metadata locations for a specific date')
  .option('--date <yyyy|yyyy-mm|yyyy-mm-dd>', 'target date/range')
  .option('--today', 'target today only (overrides default weekly range)')
  .option('-l, --limit <number>', 'maximum ranking rows (max: 10)', '10')
  .option('--max-pages <number>', 'max pages to scan before stopping', '10')
  .option('-j, --json', 'output as JSON')
  .option('--no-cache', 'force fetch from API')
  .action(async (options) => {
    await ensureAccessToken();
    try {
      const targetDate = resolveRankingRangeOption(options);
      const requestedLimit = parsePositiveIntegerOption(options.limit, '--limit');
      const limit = Math.min(requestedLimit, 10);
      const maxPages = parsePositiveIntegerOption(options.maxPages, '--max-pages');
      const useCache = options.cache !== false;

      let ranking: LocationRank[] = [];
      let totalWithLocation = 0;
      let totalImages = 0;

      if (useCache) {
        let cacheSummary = buildLocationsRankingFromHourlyCache(targetDate);
        if (cacheSummary.totalImages === 0) {
          await warmDateCacheForLocations(targetDate, maxPages, true);
          cacheSummary = buildLocationsRankingFromHourlyCache(targetDate);
        }
        ranking = cacheSummary.ranking;
        totalWithLocation = cacheSummary.imageCountWithLocations;
        totalImages = cacheSummary.totalImages;
      } else {
        const imageIds = await warmDateCacheForLocations(targetDate, maxPages, false);
        ranking = buildLocationsRankingFromCache(imageIds);
        totalWithLocation = ranking.reduce((sum, item) => sum + item.count, 0);
        totalImages = imageIds.length;
      }

      const displayedRanking = ranking.slice(0, limit);

      if (options.json) {
        console.log(JSON.stringify({
          date: targetDate.dateKey,
          image_count: totalImages,
          location_image_count: totalWithLocation,
          total_locations: ranking.length,
          ranking: displayedRanking,
        }, null, 2));
        return;
      }

      if (ranking.length === 0) {
        console.log(`No location metadata found for ${targetDate.dateKey}.`);
        return;
      }

      console.log(`Locations on ${targetDate.dateKey}`);
      displayedRanking.forEach((item, index) => {
        console.log(`${index + 1}. ${item.location}: ${item.count}`);
      });
      console.log(`Total images with location metadata: ${totalWithLocation}`);
    } catch (error: any) {
      console.error('Error ranking locations:', error.message);
      process.exit(1);
    }
  });

program
  .command('summary')
  .description('Show weekly summary with daily uploads and metadata rankings')
  .option('--date <yyyy|yyyy-mm|yyyy-mm-dd>', 'target date/range')
  .option('--today', 'target today only (overrides default weekly range)')
  .option('-l, --limit <number>', 'maximum ranking rows (max: 10)', '10')
  .option('--max-pages <number>', 'max pages to scan before stopping', '10')
  .option('-j, --json', 'output as JSON')
  .option('--no-cache', 'force fetch from API')
  .action(async (options) => {
    await ensureAccessToken();
    try {
      const targetDate = resolveRankingRangeOption(options);
      const requestedLimit = parsePositiveIntegerOption(options.limit, '--limit');
      const limit = Math.min(requestedLimit, 10);
      const maxPages = parsePositiveIntegerOption(options.maxPages, '--max-pages');
      const useCache = options.cache !== false;

      let dailySummaries: DailySummary[] = [];

      if (useCache) {
        dailySummaries = buildDailySummariesFromImageCache(targetDate);
        const totalUploads = dailySummaries.reduce((sum, day) => sum + day.imageCount, 0);
        if (totalUploads === 0) {
          await warmDateCacheForTags(targetDate, maxPages, true);
          await warmDateCacheForLocations(targetDate, maxPages, true);
          dailySummaries = buildDailySummariesFromImageCache(targetDate);
        } else {
          const hasMetadata = dailySummaries.some(day =>
            day.apps.length > 0 || day.domains.length > 0 || day.tags.length > 0 || day.locations.length > 0,
          );
          if (!hasMetadata) {
            await warmDateCacheForTags(targetDate, maxPages, true);
            await warmDateCacheForLocations(targetDate, maxPages, true);
            dailySummaries = buildDailySummariesFromImageCache(targetDate);
          }
        }
      } else {
        await warmDateCacheForTags(targetDate, maxPages, false);
        await warmDateCacheForLocations(targetDate, maxPages, false);
        dailySummaries = buildDailySummariesFromImageCache(targetDate);
      }

      if (options.json) {
        console.log(JSON.stringify({
          date: targetDate.dateKey,
          days: dailySummaries.map(day => ({
            date: day.date,
            image_count: day.imageCount,
            apps: day.apps.slice(0, limit),
            domains: day.domains.slice(0, limit),
            tags: day.tags.slice(0, limit),
            locations: day.locations.slice(0, limit),
          })),
        }, null, 2));
        return;
      }

      console.log(renderSummaryText({
        dateKey: targetDate.dateKey,
        dailySummaries,
        limit,
      }));
    } catch (error: any) {
      console.error('Error building summary:', error.message);
      process.exit(1);
    }
  });

program
  .command('stats')
  .description('Show weekly stats summary in Markdown')
  .option('--date <yyyy|yyyy-mm|yyyy-mm-dd>', 'window end date anchor (default: yesterday)')
  .option('--days <number>', 'window length in days', '7')
  .option('--top <number>', 'rows per section', '10')
  .option('--max-pages <number>', 'max pages to fetch when warming cache', '10')
  .option('--no-cache', 'force fetch from API')
  .action(async (options) => {
    await ensureAccessToken();
    try {
      const { range, days, startLabel, endLabel } = buildStatsDateRange(options.date, options.days || '7');
      const top = Math.min(parsePositiveIntegerOption(options.top, '--top'), 20);
      const maxPages = parsePositiveIntegerOption(options.maxPages, '--max-pages');
      const useCache = options.cache !== false;

      let uploadTime: UploadTimeSummary;
      let apps: AppRank[] = [];
      let domains: DomainRank[] = [];
      let tags: TagRank[] = [];
      let totalUploads = 0;

      if (useCache) {
        uploadTime = buildUploadTimeSummaryFromHourlyCache(range);
        if (uploadTime.totalImages === 0) {
          await warmDateCacheForApps(range, maxPages, true);
          uploadTime = buildUploadTimeSummaryFromHourlyCache(range);
        }

        let appsSummary = buildAppsRankingFromHourlyCache(range);
        if (uploadTime.totalImages > 0 && appsSummary.totalImages === 0) {
          await warmDateCacheForApps(range, maxPages, true);
          appsSummary = buildAppsRankingFromHourlyCache(range);
        }

        let domainsSummary = buildDomainsRankingFromHourlyCache(range);
        if (uploadTime.totalImages > 0 && domainsSummary.totalImages === 0) {
          await warmDateCacheForDomains(range, maxPages, true);
          domainsSummary = buildDomainsRankingFromHourlyCache(range);
        }

        let tagsSummary = buildTagsRankingFromHourlyCache(range);
        if (uploadTime.totalImages > 0 && tagsSummary.totalImages === 0) {
          await warmDateCacheForTags(range, maxPages, true);
          tagsSummary = buildTagsRankingFromHourlyCache(range);
        }

        apps = appsSummary.ranking;
        domains = domainsSummary.ranking;
        tags = tagsSummary.ranking;
        totalUploads = uploadTime.totalImages;
      } else {
        const imageIds = await warmDateCacheForTags(range, maxPages, false);
        uploadTime = buildUploadTimeSummaryFromImageCache(imageIds, range);
        apps = buildAppsRankingFromCache(imageIds);
        domains = buildDomainsRankingFromCache(imageIds);
        tags = buildTagsRankingFromCache(imageIds).ranking;
        totalUploads = uploadTime.totalImages;
      }

      console.log(renderStatsMarkdown({
        startLabel,
        endLabel,
        days,
        totalUploads,
        uploadTime,
        apps,
        domains,
        tags,
        top,
      }));
    } catch (error: any) {
      console.error('Error building stats:', error.message);
      process.exit(1);
    }
  });

program
  .command('upload [path]')
  .description('Upload an image file (or read image bytes from stdin)')
  .option('--title <title>', 'image title')
  .option('--app <app>', 'application name', 'gyazocli')
  .option('--url <url>', 'source URL (sent as referer_url)')
  .option('--timestamp <unix_timestamp>', 'created_at unix timestamp (current or past)')
  .option('--desc <desc>', 'image description')
  .action(async (inputPath, options) => {
    await ensureAccessToken();

    let imageData: Buffer;
    let filename = 'stdin-upload.bin';

    if (inputPath && inputPath !== '-') {
      const resolvedPath = path.resolve(inputPath);
      if (!fs.existsSync(resolvedPath)) {
        console.error(`Error: File not found: ${resolvedPath}`);
        process.exit(1);
      }
      imageData = fs.readFileSync(resolvedPath);
      filename = path.basename(resolvedPath);
    } else {
      if (process.stdin.isTTY) {
        console.error('Error: Provide an image path or pipe image data via stdin.');
        console.error('Hint: Run `gyazo upload -h` for usage.');
        process.exit(1);
      }
      imageData = await readStdinBuffer();
      if (imageData.length === 0) {
        console.error('Error: No image data received from stdin.');
        process.exit(1);
      }
    }

    const desc = ensureUploadDescTag(options.desc);
    const timestamp = parseUploadTimestamp(options.timestamp);

    try {
      const uploaded = await uploadImage({
        imageData,
        filename,
        title: options.title,
        app: options.app || 'gyazocli',
        refererUrl: options.url,
        desc,
        timestamp,
      });

      console.log(`URL: ${uploaded.permalink_url}`);
      console.log(`ID: ${uploaded.image_id}`);
      if (uploaded.created_at) {
        console.log(`Created at: ${formatCreatedAt(uploaded.created_at)}`);
      }
      console.log(`App: ${options.app || 'gyazocli'}`);
      console.log(`Desc: ${desc}`);
    } catch (error: any) {
      console.error('Error uploading image:', error.message);
      process.exit(1);
    }
  });

program
  .command('sync')
  .description('Sync images from yesterday back to N days')
  .option('--days <number>', 'number of days to sync (used when --date is omitted)')
  .option('--date <yyyy|yyyy-mm|yyyy-mm-dd>', 'sync only this date/month/year range')
  .option('--max-pages <number>', 'max pages to fetch', '10')
  .action(async (options) => {
    await ensureAccessToken();
    if (options.date && options.days) {
      console.error('Error: --date and --days cannot be used together.');
      process.exit(1);
    }

    const maxPages = parsePositiveIntegerOption(options.maxPages, '--max-pages');

    let startDate: Date;
    let endDate: Date;

    if (options.date) {
      const parsed = parseDateOption(options.date);
      startDate = parsed.start;
      endDate = parsed.end;
    } else {
      const days = options.days ? parsePositiveIntegerOption(options.days, '--days') : 1;
      const now = new Date();
      endDate = new Date(now);
      endDate.setDate(endDate.getDate() - 1);
      endDate.setHours(23, 59, 59, 999);

      startDate = new Date(now);
      startDate.setDate(startDate.getDate() - days - 1);
      startDate.setHours(0, 0, 0, 0);
    }

    console.log(`Syncing images between ${startDate.toISOString()} and ${endDate.toISOString()}...`);

    const hourlyIndices: Map<string, Set<string>> = new Map();

    for (let page = 1; page <= maxPages; page++) {
      const images = await listImages(page, 100);
      if (images.length === 0) break;

      let reachedLimit = false;
      for (const img of images) {
        const createdAt = new Date(img.created_at);
        
        if (createdAt > endDate) {
          // Skip images newer than target range.
          continue;
        }
        
        if (createdAt < startDate) {
          reachedLimit = true;
          break;
        }

        // Add to hourly index
        const y = createdAt.getFullYear().toString();
        const m = (createdAt.getMonth() + 1).toString().padStart(2, '0');
        const d = createdAt.getDate().toString().padStart(2, '0');
        const h = createdAt.getHours().toString().padStart(2, '0');
        const key = `${y}-${m}-${d}-${h}`;
        if (!hourlyIndices.has(key)) hourlyIndices.set(key, new Set());
        hourlyIndices.get(key)?.add(img.image_id);

        const cached = loadImageCache(img.image_id);
        if (cached && cached.ocr) {
          process.stdout.write(`s`);
          continue;
        }

        process.stdout.write(`.`);
        try {
          const detail = await getImageDetail(img.image_id);
          saveImageCache(img.image_id, detail);
          await new Promise(resolve => setTimeout(resolve, 200));
        } catch (e) {
          process.stdout.write(`x`);
        }
      }

      console.log(`\nPage ${page} processed.`);
      if (reachedLimit) break;
    }

    // Save hourly indices
    console.log(`Updating hourly indices...`);
    for (const [key, ids] of hourlyIndices.entries()) {
      const [y, m, d, h] = key.split('-');
      const existing = loadHourlyCache(y, m, d, h) || [];
      const merged = Array.from(new Set([...existing, ...ids]));
      saveHourlyCache(y, m, d, h, merged);
    }
    console.log(`Sync complete.`);
  });

program
  .command('import <type> <dir>')
  .description('Import legacy data (type: json|hourly)')
  .action(async (type, dir) => {
    const sourceDir = path.resolve(dir);
    if (!fs.existsSync(sourceDir)) {
      console.error(`Error: Source directory ${sourceDir} does not exist.`);
      process.exit(1);
    }

    if (type === 'json') {
      const targetDir = path.join(getCacheDir(), 'images');
      console.log(`Importing legacy Gyazo JSON from ${sourceDir}...`);
      let total = 0;
      const walk = (d: string) => {
        fs.readdirSync(d, { withFileTypes: true }).forEach(e => {
          const p = path.join(d, e.name);
          if (e.isDirectory()) walk(p);
          else if (e.name.endsWith('.json')) {
            const id = e.name.replace('.json', '');
            const p1 = id[0] || '_', p2 = id[1] || '_';
            const dest = path.join(targetDir, p1, p2);
            if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
            fs.copyFileSync(p, path.join(dest, e.name));
            total++;
            if (total % 100 === 0) process.stdout.write('.');
          }
        });
      };
      walk(sourceDir);
      console.log(`\nImport complete. Copied ${total} files.`);
    } else if (type === 'hourly') {
      console.log(`Importing legacy Gyazo hourly data from ${sourceDir}...`);
      let total = 0;
      const years = fs.readdirSync(sourceDir).filter(f => /^[0-9]{4}$/.test(f));
      for (const y of years) {
        const months = fs.readdirSync(path.join(sourceDir, y)).filter(f => /^[0-9]{2}$/.test(f));
        for (const m of months) {
          const days = fs.readdirSync(path.join(sourceDir, y, m)).filter(f => /^[0-9]{2}$/.test(f));
          for (const d of days) {
            const hours = fs.readdirSync(path.join(sourceDir, y, m, d)).filter(f => /^[0-9]{2}$/.test(f));
            for (const h of hours) {
              const txt = path.join(sourceDir, y, m, d, h, 'image_ids.txt');
              if (fs.existsSync(txt)) {
                const ids = fs.readFileSync(txt, 'utf-8').split('\n').map(id => id.trim()).filter(id => id.length > 0);
                saveHourlyCache(y, m, d, h, ids);
                total++;
              }
            }
          }
        }
        process.stdout.write('.');
      }
      console.log(`\nImport complete. Copied ${total} hourly index files.`);
    } else {
      console.error('Error: type must be "json" or "hourly"');
      process.exit(1);
    }
  });

program.parseAsync(process.argv);
