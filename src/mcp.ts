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
import { searchImages, type GyazoImage } from './api';
import { resolveAccessToken } from './credentials';

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
 * The fields worth handing to a model: enough to cite and fetch a capture,
 * without the parts of the API response it cannot act on. Absent fields stay
 * absent rather than becoming null.
 */
function toSearchResult(image: GyazoImage & { thumb_url?: string }) {
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
        return { content: [{ type: 'text' as const, text: 'No images found' }] };
      }
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(images.map(toSearchResult), null, 2),
          },
        ],
      };
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
