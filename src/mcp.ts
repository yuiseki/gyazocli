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
import { normalizeImageId } from './ids';

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
