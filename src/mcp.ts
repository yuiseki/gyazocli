/**
 * A Model Context Protocol server over stdio, started with `gyazo --mcp-server`.
 *
 * The tool names and their argument shapes follow nota/gyazo-mcp-server, so a
 * client already configured against that server keeps working. What differs is
 * where it runs: this one is the CLI itself, so it reads the same token and the
 * same cache as every other `gyazo` command.
 *
 * stdout belongs to the protocol. Everything this file has to say to a human
 * goes to stderr.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { searchImages, getImageDetail, listImages, type GyazoImage } from './api';
import { resolveAccessToken } from './credentials';
import { normalizeImageId, normalizeCollectionId } from './ids';
import {
  DATE_OPTION_PROBLEMS,
  buildRecentWeekRangeUntilYesterday,
  parseHourOption,
  tryParseDateOption,
  type ParsedDateOption,
} from './dates';
import {
  getAddressComponent,
  getAddressComponentCode,
  getAddressEntry,
  normalizeText,
} from './format';
import { listCaptures, listCapturesSince, type CaptureAlias } from './services/memory';
import { buildSummary, toSummaryJson } from './services/analytics';
import {
  COLLECTION_SORTS,
  findCollections,
  readCollection,
  type CollectionSort,
} from './services/collections';

const SEARCH_QUERY_DESCRIPTION = [
  'Search keyword (max length: 200 characters).',
  'Examples: cat | title:cat | app:"Google Chrome" | url:google.com |',
  'cat since:2024-01-01 until:2024-12-31.',
  'If nothing suitable comes back, rephrase the query to match what the user',
  'meant and search again rather than giving up on the first attempt.',
].join(' ');

function serverVersion(): string {
  // The published tarball always contains package.json, and dist/ sits one
  // level below it, so this holds both in the repository and once installed.
  return require('../package.json').version as string;
}

/**
 * The fields worth handing to a model: enough to cite a capture and to open it,
 * without the parts of the API response it cannot act on. Absent fields stay
 * absent rather than becoming null.
 *
 * Metadata only, on purpose. Handing image bytes to a model as base64 was the
 * ambitious part of the upstream design and it did not hold up in use, so a
 * capture is described here and its URLs are given for anything that wants the
 * pixels.
 */
type ExifNormalized = {
  latitude?: number;
  longitude?: number;
  time?: string;
  timezone?: string;
};

type ImageWithLocation = GyazoImage & {
  thumb_url?: string;
  exif_normalized?: ExifNormalized;
  metadata?: GyazoImage['metadata'] & {
    exif_normalized?: ExifNormalized;
    ocr?: { locale?: string; description?: string };
  };
};

/** null and undefined both mean the capture does not carry the field. */
function present<T>(value: T | null | undefined): value is T {
  return value !== null && value !== undefined;
}

/**
 * Both languages, always. A Japanese address reads poorly for a place abroad,
 * and an English one reads poorly at home, and which of those applies is not
 * something this server can decide for the model.
 */
const ADDRESS_LOCALES = ['ja', 'en'] as const;

function readNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function readAddresses(exifAddress: unknown) {
  const addresses: Record<string, { text: string; locality?: string; admin1?: string }> = {};
  for (const locale of ADDRESS_LOCALES) {
    const entry = getAddressEntry(exifAddress, locale);
    const text = normalizeText(entry?.address);
    if (!text) continue;
    const locality = getAddressComponent(entry, 'locality');
    const admin1 = getAddressComponent(entry, 'administrative_area_level_1');
    addresses[locale] = {
      text,
      ...(locality ? { locality } : {}),
      ...(admin1 ? { admin1 } : {}),
    };
  }
  return Object.keys(addresses).length > 0 ? addresses : undefined;
}

/**
 * Where a capture was taken, in the fields a model can reason about.
 *
 * The coordinates live under `metadata`; the top-level `exif_normalized` is
 * null in every response this CLI reads, though it is still honoured in case
 * an endpoint starts filling it. Altitude and heading only exist in the raw
 * EXIF, which `/api/images/<id>` does not return, so they appear for captures
 * read through a collection and are absent otherwise rather than guessed.
 */
function readLocation(image: ImageWithLocation) {
  const source = image?.metadata?.exif_normalized ?? image?.exif_normalized;
  const latitude = source?.latitude;
  const longitude = source?.longitude;
  if (typeof latitude !== 'number' || typeof longitude !== 'number') {
    return undefined;
  }

  const exif = (image?.metadata as any)?.exif;
  const altitude = readNumber(exif?.['Altitude']);
  const heading = readNumber(exif?.['GPS Image Direction']);
  const headingReferenceCode = normalizeText(exif?.['GPS Image Direction Reference']);
  const headingReference =
    headingReferenceCode === 'M' ? 'magnetic' : headingReferenceCode === 'T' ? 'true' : undefined;

  const exifAddress = (image?.metadata as any)?.exif_address;
  const addresses = readAddresses(exifAddress);
  const countryCode = ADDRESS_LOCALES.map((locale) =>
    getAddressComponentCode(getAddressEntry(exifAddress, locale), 'country'),
  ).find(present);

  return {
    latitude,
    longitude,
    ...(altitude !== undefined ? { altitude_m: altitude } : {}),
    ...(heading !== undefined ? { heading_deg: heading } : {}),
    ...(heading !== undefined && headingReference ? { heading_reference: headingReference } : {}),
    ...(countryCode ? { country_code: countryCode } : {}),
    ...(addresses ? { address: addresses } : {}),
  };
}

/** When the shutter was pressed, as opposed to when the capture was uploaded. */
function readCapturedAt(image: ImageWithLocation): string | undefined {
  const capturedAt =
    (image as any)?.exif_captured_at ?? image?.metadata?.exif_normalized?.time ?? undefined;
  return present(capturedAt) && typeof capturedAt === 'string' ? capturedAt : undefined;
}

/**
 * The OCR text, from wherever this response carries it. Same mistake as the
 * coordinates: the responses that have OCR keep it under `metadata`, and the
 * top-level field comes back null.
 */
function readOcr(image: ImageWithLocation) {
  const ocr = present(image?.ocr) ? image.ocr : image?.metadata?.ocr;
  return present(ocr) && present(ocr.description) ? ocr : undefined;
}

function toMetadata(image: ImageWithLocation) {
  const location = readLocation(image);
  const capturedAt = readCapturedAt(image);
  const ocr = readOcr(image);
  return {
    image_id: image.image_id,
    permalink_url: image.permalink_url,
    url: image.url,
    ...(present(image.thumb_url) ? { thumb_url: image.thumb_url } : {}),
    ...(present(image.type) ? { mimeType: `image/${image.type}` } : {}),
    created_at: image.created_at,
    ...(capturedAt !== undefined ? { captured_at: capturedAt } : {}),
    ...(present(image.alt_text) && image.alt_text !== '' ? { alt_text: image.alt_text } : {}),
    ...(ocr !== undefined ? { ocr } : {}),
    ...(location !== undefined ? { location } : {}),
    ...(present(image.metadata) ? { metadata: image.metadata } : {}),
  };
}

const NO_IMAGES = { content: [{ type: 'text' as const, text: 'No images found' }] };

/**
 * Every call, with how long it took, on stderr. stdout belongs to the
 * protocol, and the host that starts this server is where its stderr ends up,
 * which is the only place an operator can see that one tool is slow.
 */
function logged<Args, Result>(
  name: string,
  handler: (args: Args) => Promise<Result>,
): (args: Args) => Promise<Result> {
  return async (args: Args) => {
    const startedAt = Date.now();
    const given = Object.entries((args || {}) as Record<string, unknown>)
      .filter(([, value]) => value !== undefined && value !== false)
      .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
      .join(' ');
    try {
      const result = await handler(args);
      console.error(`[gyazo-mcp] ${name} ok ${Date.now() - startedAt}ms ${given}`.trimEnd());
      return result;
    } catch (error: any) {
      console.error(
        `[gyazo-mcp] ${name} failed ${Date.now() - startedAt}ms ${given}`.trimEnd(),
        `- ${error?.message || error}`,
      );
      throw error;
    }
  };
}

function asJsonResult(payload: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }] };
}

function asMetadataListResult(images: any[]) {
  if (!images || images.length === 0) {
    return NO_IMAGES;
  }
  return asJsonResult(images.map(toMetadata));
}

/**
 * A date argument, refused by throwing. The CLI reports and exits here, which
 * a server must not do: it would take the whole session down over one bad
 * argument.
 */
function requireDate(value: string | undefined, today: boolean): ParsedDateOption | undefined {
  if (!value && !today) return undefined;
  if (value && today) {
    throw new Error('today and date cannot be used together.');
  }
  const parsed = tryParseDateOption(today ? undefined : value);
  if (!parsed.ok) {
    throw new Error(DATE_OPTION_PROBLEMS[parsed.problem].replace('--date', 'date'));
  }
  return parsed.value;
}

function asMetadataResult(image: Parameters<typeof toMetadata>[0]) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(toMetadata(image), null, 2) }],
  };
}

export function createMcpServer(): McpServer {
  const server = new McpServer({ name: 'gyazocli', version: serverVersion() });

  server.registerTool(
    'gyazo_search',
    {
      title: 'Search Gyazo captures',
      description: 'Full-text search for captures uploaded by the user on Gyazo',
      inputSchema: {
        query: z.string().min(1).max(200).describe(SEARCH_QUERY_DESCRIPTION),
        page: z.number().int().min(1).default(1).describe('Page number for pagination'),
        per: z
          .number()
          .int()
          .min(1)
          .max(100)
          .default(20)
          .describe('Number of results per page (max: 100)'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    logged('gyazo_search', async ({ query, page, per }) => {
      const images = await searchImages(query, page, per);
      if (!images || images.length === 0) {
        return NO_IMAGES;
      }
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(images.map(toMetadata), null, 2),
          },
        ],
      };
    }),
  );

  server.registerTool(
    'gyazo_image',
    {
      title: 'Describe one Gyazo capture',
      description:
        'Fetch the metadata of one capture on Gyazo: its URLs, timestamp, OCR text, ' +
        'title, source application and page, and location when the capture carries one. ' +
        'Returns no image bytes; use the URLs in the result to show the capture itself.',
      inputSchema: {
        id_or_url: z
          .string()
          .min(1)
          .describe(
            'ID or URL of the capture on Gyazo. A bare 32-character ID, a ' +
              'https://gyazo.com/<id> permalink, or a direct image URL all work.',
          ),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    logged('gyazo_image', async ({ id_or_url }) => {
      const imageId = normalizeImageId(id_or_url);
      if (!imageId) {
        throw new Error(
          `'${id_or_url}' is not a Gyazo image ID or URL. Pass a 32-character ID or a ` +
            'https://gyazo.com/<id> URL. A https://gyazo.com/collections/<id> URL is a ' +
            'collection, which this server does not read.',
        );
      }
      const image = await getImageDetail(imageId);
      if (!image || !image.image_id) {
        return NO_IMAGES;
      }
      return asMetadataResult(image);
    }),
  );

  server.registerTool(
    'gyazo_latest_image',
    {
      title: 'Describe the most recent Gyazo capture',
      description:
        'Fetch the metadata of the capture the user uploaded most recently. Useful when ' +
        'they refer to what they just captured. Returns no image bytes.',
      // No arguments. The upstream server declared a `name` property here, so
      // a client configured against it may still send one; unknown properties
      // are dropped rather than refused.
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    logged('gyazo_latest_image', async () => {
      const images = await listImages(1, 1);
      const latest = images && images[0];
      if (!latest) {
        return NO_IMAGES;
      }
      return asMetadataResult(latest);
    }),
  );

  server.registerTool(
    'gyazo_list',
    {
      title: 'List Gyazo captures',
      description:
        'List the captures the user uploaded, newest first, taking the same options as ' +
        '`gyazo list`. With no arguments it returns the most recent page. Returns metadata, ' +
        'not image bytes.',
      inputSchema: {
        page: z.number().int().min(1).default(1).describe('Page number for pagination'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .default(20)
          .describe('Number of captures per page (max: 100)'),
        date: z
          .string()
          .optional()
          .describe(
            'Restrict to a date or range: yyyy, yyyy-mm or yyyy-mm-dd, read as local time',
          ),
        today: z.boolean().default(false).describe('Restrict to today. Not with date'),
        hour: z
          .string()
          .optional()
          .describe(
            'Read one hour out of the local cache, as yyyy-mm-dd-hh. Not with date, today, ' +
              'photos or uploaded',
          ),
        photos: z
          .boolean()
          .default(false)
          .describe('Only captures that carry a location. Not with uploaded'),
        uploaded: z
          .boolean()
          .default(false)
          .describe('Only captures uploaded by this CLI. Not with photos'),
        max_pages: z
          .number()
          .int()
          .min(1)
          .default(100)
          .describe('How many API pages to scan when a date range is given'),
        use_cache: z
          .boolean()
          .default(true)
          .describe('Answer from the local cache where possible. Set false to force a fetch'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    logged('gyazo_list', async (args) => {
      const { page, limit, today, photos, uploaded, max_pages: maxPages, use_cache: useCache } = args;

      if (photos && uploaded) {
        throw new Error('photos and uploaded cannot be used together.');
      }
      if (args.hour && (photos || uploaded)) {
        throw new Error('hour cannot be used with photos or uploaded.');
      }
      if (args.hour && (args.date || today)) {
        throw new Error('hour cannot be used with date or today.');
      }

      const date = requireDate(args.date, today);
      const hour = args.hour ? parseHourOption(args.hour) : null;
      if (args.hour && !hour) {
        throw new Error('hour format must be yyyy-mm-dd-hh.');
      }

      const alias: CaptureAlias | undefined = photos ? 'photos' : uploaded ? 'uploaded' : undefined;
      const { images } = await listCaptures({
        page,
        limit,
        maxPages,
        useCache,
        date,
        hour: hour || undefined,
        alias,
      });
      return asMetadataListResult(images);
    }),
  );

  server.registerTool(
    'gyazo_summary',
    {
      title: 'Summarise a stretch of Gyazo captures',
      description:
        'What a day or a range adds up to: how many captures each day, and which ' +
        'applications, sites, tags and places recur, taking the same options as ' +
        '`gyazo summary`. With no arguments it covers the week up to yesterday.',
      inputSchema: {
        date: z
          .string()
          .optional()
          .describe('A date or range: yyyy, yyyy-mm or yyyy-mm-dd, read as local time'),
        today: z.boolean().default(false).describe('Cover today only. Not with date'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(10)
          .default(10)
          .describe('How many ranking rows per day (max: 10)'),
        max_pages: z
          .number()
          .int()
          .min(1)
          .default(10)
          .describe('How many API pages to scan when the cache has nothing to say'),
        use_cache: z
          .boolean()
          .default(true)
          .describe('Answer from the local cache where possible. Set false to force a fetch'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    logged('gyazo_summary', async (args) => {
      const { today, limit, max_pages: maxPages, use_cache: useCache } = args;
      const targetDate = requireDate(args.date, today) || buildRecentWeekRangeUntilYesterday();
      const dailySummaries = await buildSummary({ targetDate, maxPages, useCache });
      return asJsonResult(toSummaryJson(targetDate.dateKey, dailySummaries, limit));
    }),
  );

  server.registerTool(
    'gyazo_collection',
    {
      title: 'Read a Gyazo collection',
      description:
        'The metadata of a collection and of the captures in it. A collection ID looks ' +
        'exactly like a capture ID, so a bare ID is read as a collection here; pass a ' +
        'https://gyazo.com/collections/<id> URL when in doubt.',
      inputSchema: {
        id_or_url: z
          .string()
          .min(1)
          .describe('Collection ID, or a https://gyazo.com/collections/<id> URL'),
        sort: z
          .enum(COLLECTION_SORTS)
          .default('added')
          .describe(
            'Image order: added (as the collection holds them), created (upload time) or ' +
              'captured (when the photo was taken)',
          ),
        page: z.number().int().min(1).default(1).describe('Page of images to read'),
        per: z
          .number()
          .int()
          .min(1)
          .max(100)
          .default(100)
          .describe('Images per page (max: 100)'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    logged('gyazo_collection', async ({ id_or_url, sort, page, per }) => {
      const collectionId = normalizeCollectionId(id_or_url);
      if (!collectionId) {
        throw new Error(
          `'${id_or_url}' is not a Gyazo collection ID or URL. Pass a 32-character ID or a ` +
            'https://gyazo.com/collections/<id> URL. A https://gyazo.com/<id> URL is a single ' +
            'capture, which gyazo_image reads.',
        );
      }

      const result = await readCollection(collectionId, {
        sort: sort as CollectionSort,
        paginated: true,
        page,
        per,
      });
      const { collection, images } = result;
      return asJsonResult({
        id: collection?.id ?? collectionId,
        ...(present(collection?.name) ? { name: collection.name } : {}),
        ...(collection?.description ? { description: collection.description } : {}),
        ...(present(collection?.url) ? { url: collection.url } : {}),
        ...(result.totalImageCount !== undefined
          ? { total_image_count: result.totalImageCount }
          : {}),
        returned_image_count: result.returnedImageCount,
        page: result.page,
        per: result.per,
        // Said out loud, because a collection that stops without saying so
        // reads as a complete answer. Ask for the next page to see the rest.
        truncated: result.truncated,
        ...(present(collection?.user) ? { user: collection.user } : {}),
        images: images.map(toMetadata),
      });
    }),
  );

  server.registerTool(
    'gyazo_recent',
    {
      title: 'What the user captured recently',
      description:
        'The captures that arrived since a moment, or since a capture you have already ' +
        'seen. Use this when the user says they just captured something, and pass ' +
        'after_image_id with the newest capture you have already looked at so that you ' +
        'get only what is new. With no arguments it covers the last 30 minutes.',
      inputSchema: {
        minutes: z
          .number()
          .int()
          .min(1)
          .max(1440)
          .optional()
          .describe('How far back to look, in minutes. Defaults to 30 when nothing else is given'),
        since: z
          .string()
          .optional()
          .describe('An ISO 8601 timestamp to look back to, instead of minutes'),
        after_image_id: z
          .string()
          .optional()
          .describe(
            'The newest capture you have already seen, as an ID or a Gyazo URL. Returns ' +
              'only what came after it, and reports if it cannot be found',
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .default(20)
          .describe('Most captures to return (max: 100)'),
        max_pages: z
          .number()
          .int()
          .min(1)
          .max(20)
          .default(5)
          .describe('How many pages of 100 to walk before giving up on the boundary'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    logged('gyazo_recent', async (args) => {
      const { limit, max_pages: maxPages } = args;

      let afterImageId: string | undefined;
      if (args.after_image_id) {
        const normalized = normalizeImageId(args.after_image_id);
        if (!normalized) {
          throw new Error(
            `'${args.after_image_id}' is not a Gyazo image ID or URL. Pass the ID of the ` +
              'newest capture you have already seen.',
          );
        }
        afterImageId = normalized;
      }

      let since: Date | undefined;
      if (args.since) {
        if (args.minutes !== undefined) {
          throw new Error('since and minutes cannot be used together.');
        }
        const parsed = new Date(args.since);
        if (Number.isNaN(parsed.getTime())) {
          throw new Error(
            `'${args.since}' is not a timestamp this can read. Pass an ISO 8601 value such ` +
              'as 2026-09-08T11:42:00+09:00.',
          );
        }
        since = parsed;
      } else if (args.minutes !== undefined) {
        since = new Date(Date.now() - args.minutes * 60_000);
      } else if (!afterImageId) {
        since = new Date(Date.now() - 30 * 60_000);
      }

      const result = await listCapturesSince({ since, afterImageId, limit, maxPages });
      if (result.watermarkMissing) {
        throw new Error(
          `after_image_id ${afterImageId} was not found in the ${result.pagesWalked} most ` +
            'recent pages of captures. It may be older than that, or belong to another ' +
            'account. Ask for a window in minutes instead, or raise max_pages.',
        );
      }
      return asMetadataListResult(result.images);
    }),
  );

  server.registerTool(
    'gyazo_collections',
    {
      title: 'Find a Gyazo collection by name',
      description:
        'The collections the user has, with their IDs and how many captures each holds. ' +
        'Use this to turn a collection the user names out loud into the ID that ' +
        'gyazo_collection needs.',
      inputSchema: {
        query: z
          .string()
          .optional()
          .describe('Part of a collection name to match, case-insensitively. Omit for all of them'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    logged('gyazo_collections', async ({ query }) => {
      const collections = await findCollections(query);
      if (collections.length === 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: query
                ? `No collections match ${JSON.stringify(query)}.`
                : 'No collections found.',
            },
          ],
        };
      }
      return asJsonResult(
        collections.map((collection) => ({
          id: collection.id,
          ...(present(collection.name) ? { name: collection.name } : {}),
          ...(collection.description ? { description: collection.description } : {}),
          ...(present(collection.total_image_count)
            ? { total_image_count: collection.total_image_count }
            : {}),
          ...(present(collection.url) ? { url: collection.url } : {}),
          ...(present(collection.list_updated_at)
            ? { list_updated_at: collection.list_updated_at }
            : {}),
        })),
      );
    }),
  );

  return server;
}

export async function runMcpServer(): Promise<void> {
  if (!resolveAccessToken()) {
    console.error('Error: Gyazo Access Token is not set.');
    console.error('The MCP server needs one before it can start. Set it with:');
    console.error('  gyazo config set token <your_access_token>');
    console.error('or pass GYAZO_ACCESS_TOKEN in the environment of the MCP client.');
    process.exit(1);
  }

  const server = createMcpServer();
  await server.connect(new StdioServerTransport());
  console.error('gyazo MCP server ready on stdio.');
}
