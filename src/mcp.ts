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
import { listCaptures, type CaptureAlias } from './services/memory';
import { buildSummary, toSummaryJson } from './services/analytics';
import { COLLECTION_SORTS, readCollection, type CollectionSort } from './services/collections';

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
function toMetadata(
  image: GyazoImage & {
    thumb_url?: string;
    exif_normalized?: { latitude?: number; longitude?: number };
  },
) {
  return {
    image_id: image.image_id,
    permalink_url: image.permalink_url,
    url: image.url,
    ...(image.thumb_url !== undefined ? { thumb_url: image.thumb_url } : {}),
    ...(image.type !== undefined ? { mimeType: `image/${image.type}` } : {}),
    created_at: image.created_at,
    ...(image.alt_text !== undefined ? { alt_text: image.alt_text } : {}),
    ...(image.ocr !== undefined ? { ocr: image.ocr } : {}),
    ...(image.metadata !== undefined ? { metadata: image.metadata } : {}),
    ...(image.exif_normalized !== undefined ? { exif_normalized: image.exif_normalized } : {}),
  };
}

const NO_IMAGES = { content: [{ type: 'text' as const, text: 'No images found' }] };

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
    async ({ query, page, per }) => {
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
    },
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
    async ({ id_or_url }) => {
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
    },
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
    async () => {
      const images = await listImages(1, 1);
      const latest = images && images[0];
      if (!latest) {
        return NO_IMAGES;
      }
      return asMetadataResult(latest);
    },
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
    async (args) => {
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
    },
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
    async (args) => {
      const { today, limit, max_pages: maxPages, use_cache: useCache } = args;
      const targetDate = requireDate(args.date, today) || buildRecentWeekRangeUntilYesterday();
      const dailySummaries = await buildSummary({ targetDate, maxPages, useCache });
      return asJsonResult(toSummaryJson(targetDate.dateKey, dailySummaries, limit));
    },
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
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ id_or_url, sort }) => {
      const collectionId = normalizeCollectionId(id_or_url);
      if (!collectionId) {
        throw new Error(
          `'${id_or_url}' is not a Gyazo collection ID or URL. Pass a 32-character ID or a ` +
            'https://gyazo.com/collections/<id> URL. A https://gyazo.com/<id> URL is a single ' +
            'capture, which gyazo_image reads.',
        );
      }

      const { collection, images } = await readCollection(collectionId, {
        sort: sort as CollectionSort,
      });
      return asJsonResult({
        id: collection?.id ?? collectionId,
        ...(collection?.name !== undefined ? { name: collection.name } : {}),
        ...(collection?.description ? { description: collection.description } : {}),
        ...(collection?.url !== undefined ? { url: collection.url } : {}),
        ...(collection?.total_image_count !== undefined
          ? { total_image_count: collection.total_image_count }
          : {}),
        ...(collection?.user !== undefined ? { user: collection.user } : {}),
        images: images.map(toMetadata),
      });
    },
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
