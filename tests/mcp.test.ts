import { test, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import {
  CLI_PATH,
  REPO_ROOT,
  createTempCacheDir,
  startStubServer,
  writeImageCache,
  type StubHandler,
} from './helpers';

interface McpSession {
  request: (method: string, params?: unknown) => Promise<any>;
  notify: (method: string, params?: unknown) => void;
  stdoutLines: () => string[];
  stderr: () => string;
  close: () => Promise<void>;
}

/**
 * A minimal MCP client: newline-delimited JSON-RPC over the child's stdio.
 * Deliberately hand-rolled rather than using the SDK client, so that a change
 * in how the CLI frames its messages shows up here as a failure.
 */
function startMcpServer(
  cacheDir: string,
  options: {
    apiOrigin?: string;
    webOrigin?: string;
    imageOrigin?: string;
    noToken?: boolean;
    args?: string[];
  } = {},
): McpSession {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GYAZO_ACCESS_TOKEN: 'test-token',
    GYAZO_CACHE_DIR: cacheDir,
    HOME: cacheDir,
  };
  if (options.noToken) delete env.GYAZO_ACCESS_TOKEN;
  if (options.apiOrigin) env.GYAZO_API_ORIGIN = options.apiOrigin;
  if (options.webOrigin) env.GYAZO_WEB_ORIGIN = options.webOrigin;
  if (options.imageOrigin) env.GYAZO_IMAGE_ORIGIN = options.imageOrigin;

  const child: ChildProcessWithoutNullStreams = spawn(
    process.execPath,
    [CLI_PATH, ...(options.args || ['--mcp-server'])],
    { cwd: REPO_ROOT, env, stdio: ['pipe', 'pipe', 'pipe'] },
  ) as ChildProcessWithoutNullStreams;

  const lines: string[] = [];
  const pending = new Map<number, (message: any) => void>();
  let stdoutBuffer = '';
  let stderr = '';
  let nextId = 1;

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdoutBuffer += chunk;
    let index = stdoutBuffer.indexOf('\n');
    while (index !== -1) {
      const line = stdoutBuffer.slice(0, index).trim();
      stdoutBuffer = stdoutBuffer.slice(index + 1);
      if (line) {
        lines.push(line);
        const message = JSON.parse(line);
        const resolve = pending.get(message.id);
        if (resolve) {
          pending.delete(message.id);
          resolve(message);
        }
      }
      index = stdoutBuffer.indexOf('\n');
    }
  });
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });

  const send = (payload: unknown): void => {
    child.stdin.write(`${JSON.stringify(payload)}\n`);
  };

  return {
    request(method, params) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`timed out waiting for ${method}; stderr: ${stderr}`)),
          4000,
        );
        pending.set(id, (message) => {
          clearTimeout(timer);
          resolve(message);
        });
        send({ jsonrpc: '2.0', id, method, params: params ?? {} });
      });
    },
    notify(method, params) {
      send({ jsonrpc: '2.0', method, params: params ?? {} });
    },
    stdoutLines: () => [...lines],
    stderr: () => stderr,
    close() {
      child.stdin.end();
      return new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          resolve();
        }, 3000);
        child.on('close', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    },
  };
}

async function initialize(session: McpSession): Promise<any> {
  const response = await session.request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'gyazocli-test', version: '0' },
  });
  session.notify('notifications/initialized');
  return response;
}

function searchStub(images: unknown[]): StubHandler {
  return (req, res) => {
    const url = new URL(req.url || '', 'http://127.0.0.1');
    if (url.pathname !== '/api/search') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ message: 'not found' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(images));
  };
}

const IMAGES = [
  {
    image_id: 'aa000000000000000000000000000001',
    permalink_url: 'https://gyazo.com/aa000000000000000000000000000001',
    url: 'https://i.gyazo.com/aa000000000000000000000000000001.png',
    thumb_url: 'https://thumb.gyazo.com/thumb/aa000000000000000000000000000001',
    type: 'png',
    created_at: '2026-02-20T02:34:56+0900',
    alt_text: 'a cat on a keyboard',
    ocr: { locale: 'en', description: 'hello' },
    metadata: { app: 'Google Chrome', title: 'cat', url: 'https://example.com/cat' },
  },
  {
    image_id: 'aa000000000000000000000000000002',
    permalink_url: 'https://gyazo.com/aa000000000000000000000000000002',
    url: 'https://i.gyazo.com/aa000000000000000000000000000002.png',
    type: 'png',
    created_at: '2026-02-21T02:34:56+0900',
    metadata: { title: 'another cat' },
  },
];

test('--mcp-server answers initialize with its name and version', async () => {
  const session = startMcpServer(createTempCacheDir());
  try {
    const response = await initialize(session);
    const pkg = require('../package.json');
    expect(response.error).toBeUndefined();
    expect(response.result.serverInfo.name).toBe('gyazocli');
    expect(response.result.serverInfo.version).toBe(pkg.version);
    expect(typeof response.result.protocolVersion).toBe('string');
    expect(response.result.capabilities.tools).toBeDefined();
  } finally {
    await session.close();
  }
});

test('tools/list offers gyazo_search', async () => {
  const session = startMcpServer(createTempCacheDir());
  try {
    await initialize(session);
    const response = await session.request('tools/list');
    const tools = response.result.tools;
    const search = tools.find((tool: any) => tool.name === 'gyazo_search');
    expect(search).toBeDefined();
    expect(search.description).toMatch(/search/i);
    expect(search.inputSchema.required).toContain('query');
    expect(Object.keys(search.inputSchema.properties).sort()).toEqual([
      'include_location',
      'page',
      'per',
      'query',
    ]);
  } finally {
    await session.close();
  }
});

test('gyazo_search returns the images the API found', async () => {
  const cacheDir = createTempCacheDir();
  const stub = await startStubServer(searchStub(IMAGES));
  const session = startMcpServer(cacheDir, { apiOrigin: stub.origin });
  try {
    await initialize(session);
    const response = await session.request('tools/call', {
      name: 'gyazo_search',
      arguments: { query: 'cat' },
    });
    expect(response.result.isError).toBeFalsy();
    expect(response.result.content[0].type).toBe('text');

    const found = JSON.parse(response.result.content[0].text);
    expect(found).toHaveLength(2);
    expect(found[0].image_id).toBe(IMAGES[0].image_id);
    expect(found[0].permalink_url).toBe(IMAGES[0].permalink_url);
    expect(found[0].thumb_url).toBe(IMAGES[0].thumb_url);
    expect(found[0].ocr).toEqual(IMAGES[0].ocr);
    expect(found[0].metadata.title).toBe('cat');
    // absent on the second image, and not invented
    expect(found[1].ocr).toBeUndefined();

    const search = stub.requests.find((request) => request.url.startsWith('/api/search'));
    expect(search).toBeDefined();
    expect(search!.authorization).toBe('Bearer test-token');
    const params = new URL(search!.url, 'http://127.0.0.1').searchParams;
    expect(params.get('query')).toBe('cat');
    expect(params.get('page')).toBe('1');
    expect(params.get('per')).toBe('20');
  } finally {
    await session.close();
    await stub.close();
  }
});

test('gyazo_search passes page and per through', async () => {
  const cacheDir = createTempCacheDir();
  const stub = await startStubServer(searchStub([]));
  const session = startMcpServer(cacheDir, { apiOrigin: stub.origin });
  try {
    await initialize(session);
    const response = await session.request('tools/call', {
      name: 'gyazo_search',
      arguments: { query: 'cat', page: 3, per: 5 },
    });
    expect(response.result.content[0].text).toMatch(/no images found/i);

    const search = stub.requests.find((request) => request.url.startsWith('/api/search'));
    const params = new URL(search!.url, 'http://127.0.0.1').searchParams;
    expect(params.get('page')).toBe('3');
    expect(params.get('per')).toBe('5');
  } finally {
    await session.close();
    await stub.close();
  }
});

test('gyazo_search rejects a missing query without calling the API', async () => {
  const cacheDir = createTempCacheDir();
  const stub = await startStubServer(searchStub(IMAGES));
  const session = startMcpServer(cacheDir, { apiOrigin: stub.origin });
  try {
    await initialize(session);
    const response = await session.request('tools/call', {
      name: 'gyazo_search',
      arguments: {},
    });
    const failed = Boolean(response.error) || response.result?.isError === true;
    expect(failed).toBe(true);
    expect(stub.requests).toHaveLength(0);
  } finally {
    await session.close();
    await stub.close();
  }
});

test('gyazo_search reports an API failure as a tool error', async () => {
  const cacheDir = createTempCacheDir();
  const stub = await startStubServer((_req, res) => {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ message: 'boom' }));
  });
  const session = startMcpServer(cacheDir, { apiOrigin: stub.origin });
  try {
    await initialize(session);
    const response = await session.request('tools/call', {
      name: 'gyazo_search',
      arguments: { query: 'cat' },
    });
    const failed = Boolean(response.error) || response.result?.isError === true;
    expect(failed).toBe(true);
  } finally {
    await session.close();
    await stub.close();
  }
});

test('stdout carries nothing but JSON-RPC', async () => {
  const cacheDir = createTempCacheDir();
  const stub = await startStubServer(searchStub(IMAGES));
  const session = startMcpServer(cacheDir, { apiOrigin: stub.origin });
  try {
    await initialize(session);
    await session.request('tools/list');
    await session.request('tools/call', { name: 'gyazo_search', arguments: { query: 'cat' } });
    const lines = session.stdoutLines();
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
      expect(JSON.parse(line).jsonrpc).toBe('2.0');
    }
  } finally {
    await session.close();
    await stub.close();
  }
});

test('the server exits with a hint when no token is configured', async () => {
  const cacheDir = createTempCacheDir();
  const session = startMcpServer(cacheDir, { noToken: true });
  await new Promise((resolve) => setTimeout(resolve, 1500));
  await session.close();
  expect(session.stderr()).toMatch(/access token/i);
  expect(session.stdoutLines()).toHaveLength(0);
});

const DETAIL = {
  image_id: 'bb000000000000000000000000000001',
  permalink_url: 'https://gyazo.com/bb000000000000000000000000000001',
  url: 'https://i.gyazo.com/bb000000000000000000000000000001.png',
  thumb_url: 'https://thumb.gyazo.com/thumb/bb000000000000000000000000000001',
  type: 'png',
  created_at: '2026-02-22T02:34:56+0900',
  alt_text: 'a station sign',
  ocr: { locale: 'ja', description: '京都' },
  // Where Gyazo actually puts the coordinates: under metadata. The top-level
  // exif_normalized is null in every response the CLI reads.
  metadata: {
    app: 'Safari',
    title: 'Kyoto',
    url: 'https://example.com/kyoto',
    exif_normalized: {
      timezone: 'utc',
      latitude: 34.9858,
      longitude: 135.7588,
      time: '2026-02-22T02:34:56.000Z',
    },
  },
};

/** Serves image detail and the image list, so both tools can be exercised. */
function imageStub(detail: unknown, list: unknown[]): StubHandler {
  return (req, res) => {
    const url = new URL(req.url || '', 'http://127.0.0.1');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (url.pathname === '/api/images') {
      res.end(JSON.stringify(list));
      return;
    }
    if (url.pathname.startsWith('/api/images/')) {
      res.end(JSON.stringify(detail));
      return;
    }
    res.writeHead(404);
    res.end(JSON.stringify({ message: 'not found' }));
  };
}

test('tools/list offers the read-only tools and nothing that writes', async () => {
  const session = startMcpServer(createTempCacheDir());
  try {
    await initialize(session);
    const response = await session.request('tools/list');
    const names = response.result.tools.map((tool: any) => tool.name).sort();
    expect(names).toEqual([
      'gyazo_collection',
      'gyazo_collections',
      'gyazo_image',
      'gyazo_image_content',
      'gyazo_latest_image',
      'gyazo_list',
      'gyazo_recent',
      'gyazo_search',
      'gyazo_summary',
    ]);
    for (const tool of response.result.tools) {
      expect(tool.annotations?.readOnlyHint).toBe(true);
    }
  } finally {
    await session.close();
  }
});

test('gyazo_image returns metadata, and no image bytes', async () => {
  const cacheDir = createTempCacheDir();
  const stub = await startStubServer(imageStub(DETAIL, []));
  const session = startMcpServer(cacheDir, { apiOrigin: stub.origin });
  try {
    await initialize(session);
    const response = await session.request('tools/call', {
      name: 'gyazo_image',
      arguments: { id_or_url: DETAIL.image_id },
    });
    expect(response.result.isError).toBeFalsy();
    expect(response.result.content).toHaveLength(1);
    expect(response.result.content[0].type).toBe('text');

    const text = response.result.content[0].text;
    // Deliberately metadata only: base64 image content did not survive real use.
    expect(text).not.toContain('data:image');
    expect(text).not.toContain('base64');

    const image = JSON.parse(text);
    expect(image.image_id).toBe(DETAIL.image_id);
    expect(image.permalink_url).toBe(DETAIL.permalink_url);
    expect(image.thumb_url).toBe(DETAIL.thumb_url);
    expect(image.mimeType).toBe('image/png');
    expect(image.ocr).toEqual(DETAIL.ocr);
    expect(image.metadata.title).toBe('Kyoto');
    expect(image.location).toEqual({ latitude: 34.9858, longitude: 135.7588 });
    expect(image.data).toBeUndefined();

    const detailRequest = stub.requests.find((request) => request.url.startsWith('/api/images/'));
    expect(detailRequest).toBeDefined();
    expect(detailRequest!.url).toContain(DETAIL.image_id);
    expect(detailRequest!.authorization).toBe('Bearer test-token');
  } finally {
    await session.close();
    await stub.close();
  }
});

test('gyazo_image accepts a permalink and a direct image URL', async () => {
  const cacheDir = createTempCacheDir();
  const stub = await startStubServer(imageStub(DETAIL, []));
  const session = startMcpServer(cacheDir, { apiOrigin: stub.origin });
  try {
    await initialize(session);
    for (const input of [
      `https://gyazo.com/${DETAIL.image_id}`,
      `https://i.gyazo.com/${DETAIL.image_id}.png`,
      DETAIL.image_id.toUpperCase(),
    ]) {
      const response = await session.request('tools/call', {
        name: 'gyazo_image',
        arguments: { id_or_url: input },
      });
      expect(response.result.isError, `input ${input}`).toBeFalsy();
      expect(JSON.parse(response.result.content[0].text).image_id).toBe(DETAIL.image_id);
    }
    const detailRequests = stub.requests.filter((request) =>
      request.url.startsWith(`/api/images/${DETAIL.image_id}`),
    );
    expect(detailRequests).toHaveLength(3);
  } finally {
    await session.close();
    await stub.close();
  }
});

test('gyazo_image rejects something that is not a Gyazo image without calling the API', async () => {
  const cacheDir = createTempCacheDir();
  const stub = await startStubServer(imageStub(DETAIL, []));
  const session = startMcpServer(cacheDir, { apiOrigin: stub.origin });
  try {
    await initialize(session);
    const response = await session.request('tools/call', {
      name: 'gyazo_image',
      arguments: { id_or_url: 'https://example.com/not-gyazo' },
    });
    const failed = Boolean(response.error) || response.result?.isError === true;
    expect(failed).toBe(true);
    expect(stub.requests).toHaveLength(0);
  } finally {
    await session.close();
    await stub.close();
  }
});

test('gyazo_latest_image returns the newest capture', async () => {
  const cacheDir = createTempCacheDir();
  const stub = await startStubServer(imageStub(DETAIL, [IMAGES[1], IMAGES[0]]));
  const session = startMcpServer(cacheDir, { apiOrigin: stub.origin });
  try {
    await initialize(session);
    const response = await session.request('tools/call', {
      name: 'gyazo_latest_image',
      arguments: {},
    });
    expect(response.result.isError).toBeFalsy();
    const image = JSON.parse(response.result.content[0].text);
    expect(image.image_id).toBe(IMAGES[1].image_id);

    const listRequest = stub.requests.find((request) => request.url.startsWith('/api/images?'));
    expect(listRequest).toBeDefined();
    const params = new URL(listRequest!.url, 'http://127.0.0.1').searchParams;
    expect(params.get('page')).toBe('1');
    expect(params.get('per_page')).toBe('1');
  } finally {
    await session.close();
    await stub.close();
  }
});

test('gyazo_latest_image tolerates the argument the upstream server declared', async () => {
  const cacheDir = createTempCacheDir();
  const stub = await startStubServer(imageStub(DETAIL, [IMAGES[0]]));
  const session = startMcpServer(cacheDir, { apiOrigin: stub.origin });
  try {
    await initialize(session);
    const response = await session.request('tools/call', {
      name: 'gyazo_latest_image',
      arguments: { name: 'gyazo_latest_image' },
    });
    expect(response.result.isError).toBeFalsy();
    expect(JSON.parse(response.result.content[0].text).image_id).toBe(IMAGES[0].image_id);
  } finally {
    await session.close();
    await stub.close();
  }
});

test('gyazo_latest_image says so when there is nothing there', async () => {
  const cacheDir = createTempCacheDir();
  const stub = await startStubServer(imageStub(DETAIL, []));
  const session = startMcpServer(cacheDir, { apiOrigin: stub.origin });
  try {
    await initialize(session);
    const response = await session.request('tools/call', {
      name: 'gyazo_latest_image',
      arguments: {},
    });
    expect(response.result.content[0].text).toMatch(/no images found/i);
  } finally {
    await session.close();
    await stub.close();
  }
});


function writeHourlyIndex(
  cacheDir: string,
  year: string,
  month: string,
  day: string,
  hour: string,
  imageIds: string[],
): void {
  const dir = path.join(cacheDir, 'hourly', year, month, day);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${hour}.json`), JSON.stringify(imageIds, null, 2), 'utf8');
}

/** Serves the plain listing, so gyazo_list can be exercised. */
function listStub(images: unknown[]): StubHandler {
  return (req, res) => {
    const url = new URL(req.url || '', 'http://127.0.0.1');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (url.pathname === '/api/images' || url.pathname === '/api/search') {
      res.end(JSON.stringify(images));
      return;
    }
    res.end(JSON.stringify({ message: 'not found' }));
  };
}

test('gyazo_list returns the most recent captures', async () => {
  const cacheDir = createTempCacheDir();
  const stub = await startStubServer(listStub(IMAGES));
  const session = startMcpServer(cacheDir, { apiOrigin: stub.origin });
  try {
    await initialize(session);
    const response = await session.request('tools/call', {
      name: 'gyazo_list',
      arguments: {},
    });
    expect(response.result.isError).toBeFalsy();
    const found = JSON.parse(response.result.content[0].text);
    expect(found).toHaveLength(2);
    expect(found[0].image_id).toBe(IMAGES[0].image_id);

    const listed = stub.requests.find((request) => request.url.startsWith('/api/images'));
    const params = new URL(listed!.url, 'http://127.0.0.1').searchParams;
    expect(params.get('page')).toBe('1');
    expect(params.get('per_page')).toBe('20');
  } finally {
    await session.close();
    await stub.close();
  }
});

test('gyazo_list takes the same options as the CLI', async () => {
  const cacheDir = createTempCacheDir();
  const stub = await startStubServer(listStub(IMAGES));
  const session = startMcpServer(cacheDir, { apiOrigin: stub.origin });
  try {
    await initialize(session);
    await session.request('tools/call', {
      name: 'gyazo_list',
      arguments: { page: 2, limit: 5 },
    });
    const listed = stub.requests.find((request) => request.url.startsWith('/api/images'));
    const params = new URL(listed!.url, 'http://127.0.0.1').searchParams;
    expect(params.get('page')).toBe('2');
    expect(params.get('per_page')).toBe('5');
  } finally {
    await session.close();
    await stub.close();
  }
});

test('gyazo_list photos goes through the saved search', async () => {
  const cacheDir = createTempCacheDir();
  const stub = await startStubServer(listStub(IMAGES));
  const session = startMcpServer(cacheDir, { apiOrigin: stub.origin });
  try {
    await initialize(session);
    const response = await session.request('tools/call', {
      name: 'gyazo_list',
      arguments: { photos: true },
    });
    expect(response.result.isError).toBeFalsy();
    const searched = stub.requests.find((request) => request.url.startsWith('/api/search'));
    expect(searched).toBeDefined();
    const params = new URL(searched!.url, 'http://127.0.0.1').searchParams;
    expect(params.get('query')).toBe('has:location');
  } finally {
    await session.close();
    await stub.close();
  }
});

test('gyazo_list refuses options that contradict each other', async () => {
  const cacheDir = createTempCacheDir();
  const stub = await startStubServer(listStub(IMAGES));
  const session = startMcpServer(cacheDir, { apiOrigin: stub.origin });
  try {
    await initialize(session);
    for (const args of [
      { photos: true, uploaded: true },
      { today: true, date: '2026-02-20' },
      { photos: true, hour: '2026-02-20-02' },
      { hour: '2026-02-20-02', today: true },
      { hour: '2026-02-20' },
    ]) {
      const response = await session.request('tools/call', {
        name: 'gyazo_list',
        arguments: args,
      });
      const failed = Boolean(response.error) || response.result?.isError === true;
      expect(failed, JSON.stringify(args)).toBe(true);
    }
    expect(stub.requests).toHaveLength(0);
  } finally {
    await session.close();
    await stub.close();
  }
});

test('gyazo_list reads one hour out of the cache', async () => {
  const cacheDir = createTempCacheDir();
  writeHourlyIndex(cacheDir, '2026', '02', '20', '02', [IMAGES[0].image_id]);
  writeImageCache(cacheDir, IMAGES[0].image_id, IMAGES[0]);
  const stub = await startStubServer(listStub([]));
  const session = startMcpServer(cacheDir, { apiOrigin: stub.origin });
  try {
    await initialize(session);
    const response = await session.request('tools/call', {
      name: 'gyazo_list',
      arguments: { hour: '2026-02-20-02' },
    });
    const found = JSON.parse(response.result.content[0].text);
    expect(found).toHaveLength(1);
    expect(found[0].image_id).toBe(IMAGES[0].image_id);
    // Answered from the cache, without asking the API.
    expect(stub.requests).toHaveLength(0);
  } finally {
    await session.close();
    await stub.close();
  }
});

test('gyazo_list says so when an hour holds nothing', async () => {
  const cacheDir = createTempCacheDir();
  const stub = await startStubServer(listStub([]));
  const session = startMcpServer(cacheDir, { apiOrigin: stub.origin });
  try {
    await initialize(session);
    const response = await session.request('tools/call', {
      name: 'gyazo_list',
      arguments: { hour: '2026-02-20-02' },
    });
    expect(response.result.content[0].text).toMatch(/no images found/i);
  } finally {
    await session.close();
    await stub.close();
  }
});

test('gyazo_summary summarises a day from the cache', async () => {
  const cacheDir = createTempCacheDir();
  const id = IMAGES[0].image_id;
  writeHourlyIndex(cacheDir, '2026', '02', '20', '02', [id]);
  writeImageCache(cacheDir, id, {
    ...IMAGES[0],
    created_at: '2026-02-20T02:34:56+0900',
    metadata: { app: 'Google Chrome', title: 'cat', url: 'https://example.com/cat' },
  });
  const stub = await startStubServer(listStub([]));
  const session = startMcpServer(cacheDir, { apiOrigin: stub.origin });
  try {
    await initialize(session);
    const response = await session.request('tools/call', {
      name: 'gyazo_summary',
      arguments: { date: '2026-02-20' },
    });
    expect(response.result.isError).toBeFalsy();
    const summary = JSON.parse(response.result.content[0].text);
    expect(summary.date).toBe('2026-02-20');
    expect(summary.days).toHaveLength(1);
    expect(summary.days[0].date).toBe('2026-02-20');
    expect(summary.days[0].image_count).toBe(1);
    expect(summary.days[0].apps.map((app: any) => app.app)).toContain('Google Chrome');
  } finally {
    await session.close();
    await stub.close();
  }
});

test('gyazo_summary limits the ranking rows like the CLI', async () => {
  const cacheDir = createTempCacheDir();
  const stub = await startStubServer(listStub([]));
  const session = startMcpServer(cacheDir, { apiOrigin: stub.origin });
  try {
    await initialize(session);
    const response = await session.request('tools/call', {
      name: 'gyazo_summary',
      arguments: { date: '2026-02-20', limit: 1 },
    });
    expect(response.result.isError).toBeFalsy();
    const summary = JSON.parse(response.result.content[0].text);
    for (const day of summary.days) {
      expect(day.apps.length).toBeLessThanOrEqual(1);
      expect(day.tags.length).toBeLessThanOrEqual(1);
    }
  } finally {
    await session.close();
    await stub.close();
  }
});

const COLLECTION_ID = '21ca16a1023c667a7a437be561a65018';

/**
 * Serves a collection on both routes: the API pair that a read with a token
 * uses, and the public web endpoint that an anonymous read falls back to.
 */
function collectionStub(): StubHandler {
  const images = [
    { ...IMAGES[0], created_at: '2026-08-30T05:00:00.000Z' },
    { ...IMAGES[1], created_at: '2026-08-30T07:00:00.000Z' },
  ];
  const meta = {
    id: COLLECTION_ID,
    name: 'Hiroshima 2026',
    url: `https://gyazo.com/collections/${COLLECTION_ID}`,
    total_image_count: 2,
    user: { id: '5342', name: 'yuiseki' },
  };
  return (req, res) => {
    const url = new URL(req.url || '', 'http://127.0.0.1');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (url.pathname.endsWith('/images')) {
      res.end(JSON.stringify(images));
      return;
    }
    if (url.pathname.startsWith('/api/')) {
      res.end(JSON.stringify(meta));
      return;
    }
    res.end(JSON.stringify({ ...meta, images }));
  };
}

test('gyazo_collection reads a collection and its images', async () => {
  const cacheDir = createTempCacheDir();
  const stub = await startStubServer(collectionStub());
  const session = startMcpServer(cacheDir, { apiOrigin: stub.origin, webOrigin: stub.origin });
  try {
    await initialize(session);
    const response = await session.request('tools/call', {
      name: 'gyazo_collection',
      arguments: { id_or_url: `https://gyazo.com/collections/${COLLECTION_ID}` },
    });
    expect(response.result.isError).toBeFalsy();
    const collection = JSON.parse(response.result.content[0].text);
    expect(collection.name).toBe('Hiroshima 2026');
    expect(collection.total_image_count).toBe(2);
    expect(collection.images).toHaveLength(2);
    expect(collection.images[0].image_id).toBe(IMAGES[0].image_id);

    const requested = stub.requests.find((request) => request.url.includes(COLLECTION_ID));
    expect(requested).toBeDefined();
    // With a token it goes through the API, which is the route that can page.
    expect(requested!.url).toContain(`/api/v2/collections/${COLLECTION_ID}`);
  } finally {
    await session.close();
    await stub.close();
  }
});

test('gyazo_collection sorts by capture time when asked', async () => {
  const cacheDir = createTempCacheDir();
  const stub = await startStubServer(collectionStub());
  const session = startMcpServer(cacheDir, { apiOrigin: stub.origin, webOrigin: stub.origin });
  try {
    await initialize(session);
    const response = await session.request('tools/call', {
      name: 'gyazo_collection',
      arguments: { id_or_url: COLLECTION_ID, sort: 'created' },
    });
    const collection = JSON.parse(response.result.content[0].text);
    // Newest first, which is the reverse of how they were added.
    expect(collection.images[0].image_id).toBe(IMAGES[1].image_id);
  } finally {
    await session.close();
    await stub.close();
  }
});

test('gyazo_collection refuses an image URL', async () => {
  const cacheDir = createTempCacheDir();
  const stub = await startStubServer(collectionStub());
  const session = startMcpServer(cacheDir, { apiOrigin: stub.origin, webOrigin: stub.origin });
  try {
    await initialize(session);
    const response = await session.request('tools/call', {
      name: 'gyazo_collection',
      arguments: { id_or_url: `https://gyazo.com/${IMAGES[0].image_id}` },
    });
    const failed = Boolean(response.error) || response.result?.isError === true;
    expect(failed).toBe(true);
    expect(stub.requests).toHaveLength(0);
  } finally {
    await session.close();
    await stub.close();
  }
});

test('a capture with no coordinates gets no location field', async () => {
  const cacheDir = createTempCacheDir();
  const noLocation = { ...DETAIL, metadata: { app: 'Safari', title: 'Kyoto' } };
  const stub = await startStubServer(imageStub(noLocation, []));
  const session = startMcpServer(cacheDir, { apiOrigin: stub.origin });
  try {
    await initialize(session);
    const response = await session.request('tools/call', {
      name: 'gyazo_image',
      arguments: { id_or_url: DETAIL.image_id },
    });
    const image = JSON.parse(response.result.content[0].text);
    expect(image.location).toBeUndefined();
    expect('location' in image).toBe(false);
  } finally {
    await session.close();
    await stub.close();
  }
});

test('the older top-level shape is still read', async () => {
  const cacheDir = createTempCacheDir();
  const topLevel = {
    ...DETAIL,
    metadata: { app: 'Safari' },
    exif_normalized: { latitude: 35.0116, longitude: 135.7681 },
  };
  const stub = await startStubServer(imageStub(topLevel, []));
  const session = startMcpServer(cacheDir, { apiOrigin: stub.origin });
  try {
    await initialize(session);
    const response = await session.request('tools/call', {
      name: 'gyazo_image',
      arguments: { id_or_url: DETAIL.image_id },
    });
    const image = JSON.parse(response.result.content[0].text);
    expect(image.location).toEqual({ latitude: 35.0116, longitude: 135.7681 });
  } finally {
    await session.close();
    await stub.close();
  }
});

test('gyazo_list carries the location through too', async () => {
  const cacheDir = createTempCacheDir();
  const withLocation = {
    ...IMAGES[0],
    metadata: {
      ...IMAGES[0].metadata,
      exif_normalized: { timezone: 'utc', latitude: 34.3861, longitude: 132.4596 },
    },
  };
  const stub = await startStubServer(listStub([withLocation]));
  const session = startMcpServer(cacheDir, { apiOrigin: stub.origin });
  try {
    await initialize(session);
    const response = await session.request('tools/call', { name: 'gyazo_list', arguments: {} });
    const found = JSON.parse(response.result.content[0].text);
    expect(found[0].location).toEqual({ latitude: 34.3861, longitude: 132.4596 });
  } finally {
    await session.close();
    await stub.close();
  }
});

test('the OCR text comes through from wherever the response carries it', async () => {
  const cacheDir = createTempCacheDir();
  const underMetadata = {
    ...DETAIL,
    ocr: null,
    alt_text: '',
    metadata: {
      app: 'Gyazo Android',
      ocr: { locale: 'und', description: 'お好み焼\nもり' },
    },
  };
  const stub = await startStubServer(imageStub(underMetadata, []));
  const session = startMcpServer(cacheDir, { apiOrigin: stub.origin });
  try {
    await initialize(session);
    const response = await session.request('tools/call', {
      name: 'gyazo_image',
      arguments: { id_or_url: DETAIL.image_id },
    });
    const image = JSON.parse(response.result.content[0].text);
    expect(image.ocr.description).toBe('お好み焼\nもり');
    // An empty alt_text and a null ocr are absences, not values.
    expect('alt_text' in image).toBe(false);
    for (const [key, value] of Object.entries(image)) {
      expect(value, `${key} should be omitted rather than null`).not.toBeNull();
    }
  } finally {
    await session.close();
    await stub.close();
  }
});

// --- location enrichment ----------------------------------------------------

/**
 * The listing and the search endpoints return lean images: no coordinates, no
 * address, whatever the capture actually carries. Only the detail endpoint has
 * them, so a stub has to distinguish the two.
 */
function leanThenDetailedStub(): StubHandler {
  const lean = {
    image_id: PHONE_PHOTO.image_id,
    permalink_url: PHONE_PHOTO.permalink_url,
    url: PHONE_PHOTO.url,
    type: 'jpg',
    created_at: PHONE_PHOTO.created_at,
    metadata: { app: 'Gyazo Android', title: null, url: null, desc: '' },
  };
  return (req, res) => {
    const url = new URL(req.url || '', 'http://127.0.0.1');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (url.pathname.startsWith('/api/images/')) {
      res.end(JSON.stringify(PHONE_PHOTO));
      return;
    }
    if (url.pathname === '/api/images' || url.pathname === '/api/search') {
      res.end(JSON.stringify([lean]));
      return;
    }
    res.end(JSON.stringify([]));
  };
}

function detailRequests(stub: { requests: { url: string }[] }): string[] {
  return stub.requests.filter((request) => request.url.startsWith('/api/images/')).map((r) => r.url);
}

test('gyazo_search fills in the location the search endpoint leaves out', async () => {
  const cacheDir = createTempCacheDir();
  const stub = await startStubServer(leanThenDetailedStub());
  const session = startMcpServer(cacheDir, { apiOrigin: stub.origin });
  try {
    await initialize(session);
    const response = await session.request('tools/call', {
      name: 'gyazo_search',
      arguments: { query: 'お好み焼' },
    });
    const found = JSON.parse(response.result.content[0].text);
    expect(found[0].location.latitude).toBeCloseTo(34.386172, 5);
    expect(found[0].location.address.ja.locality).toBe('広島市');
    expect(detailRequests(stub)).toHaveLength(1);
  } finally {
    await session.close();
    await stub.close();
  }
});

test('the second look comes from the cache', async () => {
  const cacheDir = createTempCacheDir();
  const stub = await startStubServer(leanThenDetailedStub());
  const session = startMcpServer(cacheDir, { apiOrigin: stub.origin });
  try {
    await initialize(session);
    await session.request('tools/call', { name: 'gyazo_search', arguments: { query: 'a' } });
    await session.request('tools/call', { name: 'gyazo_search', arguments: { query: 'b' } });
    expect(detailRequests(stub)).toHaveLength(1);
  } finally {
    await session.close();
    await stub.close();
  }
});

test('include_location false leaves the API alone', async () => {
  const cacheDir = createTempCacheDir();
  const stub = await startStubServer(leanThenDetailedStub());
  const session = startMcpServer(cacheDir, { apiOrigin: stub.origin });
  try {
    await initialize(session);
    const response = await session.request('tools/call', {
      name: 'gyazo_search',
      arguments: { query: 'お好み焼', include_location: false },
    });
    const found = JSON.parse(response.result.content[0].text);
    expect(found[0].location).toBeUndefined();
    expect(detailRequests(stub)).toHaveLength(0);
  } finally {
    await session.close();
    await stub.close();
  }
});

test('gyazo_recent and gyazo_list fill it in too', async () => {
  const cacheDir = createTempCacheDir();
  const stub = await startStubServer(leanThenDetailedStub());
  const session = startMcpServer(cacheDir, { apiOrigin: stub.origin });
  try {
    await initialize(session);
    const list = await session.request('tools/call', { name: 'gyazo_list', arguments: {} });
    expect(JSON.parse(list.result.content[0].text)[0].location.country_code).toBe('JP');

    const recent = await session.request('tools/call', {
      name: 'gyazo_recent',
      arguments: { since: '2026-08-01T00:00:00Z' },
    });
    expect(JSON.parse(recent.result.content[0].text)[0].location.country_code).toBe('JP');
  } finally {
    await session.close();
    await stub.close();
  }
});

// --- image content ---------------------------------------------------------

/** Serves the sized rendition route, and the image detail beside it. */
function renditionStub(bytes: Buffer, contentType = 'image/webp'): StubHandler {
  return (req, res) => {
    const url = new URL(req.url || '', 'http://127.0.0.1');
    if (url.pathname.startsWith('/thumb/')) {
      res.writeHead(200, { 'Content-Type': contentType, 'Content-Length': String(bytes.length) });
      res.end(bytes);
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(PHONE_PHOTO));
  };
}

test('gyazo_image_content returns the pixels as image content', async () => {
  const cacheDir = createTempCacheDir();
  const bytes = Buffer.from('pretend this is a webp'.repeat(10));
  const stub = await startStubServer(renditionStub(bytes));
  const session = startMcpServer(cacheDir, { imageOrigin: stub.origin });
  try {
    await initialize(session);
    const response = await session.request('tools/call', {
      name: 'gyazo_image_content',
      arguments: { id_or_url: PHONE_PHOTO.image_id },
    });
    expect(response.result.isError).toBeFalsy();

    const image = response.result.content.find((part: any) => part.type === 'image');
    expect(image).toBeDefined();
    expect(image.mimeType).toBe('image/webp');
    expect(Buffer.from(image.data, 'base64').toString()).toBe(bytes.toString());

    // And a line of text saying what was actually sent.
    const note = response.result.content.find((part: any) => part.type === 'text');
    expect(note.text).toMatch(/1024/);
    expect(note.text).toMatch(new RegExp(PHONE_PHOTO.image_id));

    const asked = stub.requests.find((request) => request.url.startsWith('/thumb/'));
    expect(asked!.url).toBe(`/thumb/1024_w/${PHONE_PHOTO.image_id}.webp`);
  } finally {
    await session.close();
    await stub.close();
  }
});

test('gyazo_image_content takes a width and a format', async () => {
  const cacheDir = createTempCacheDir();
  const stub = await startStubServer(renditionStub(Buffer.from('jpeg bytes'), 'image/jpeg'));
  const session = startMcpServer(cacheDir, { imageOrigin: stub.origin });
  try {
    await initialize(session);
    const response = await session.request('tools/call', {
      name: 'gyazo_image_content',
      arguments: { id_or_url: PHONE_PHOTO.image_id, width: 512, format: 'jpeg' },
    });
    const image = response.result.content.find((part: any) => part.type === 'image');
    expect(image.mimeType).toBe('image/jpeg');
    const asked = stub.requests.find((request) => request.url.startsWith('/thumb/'));
    expect(asked!.url).toBe(`/thumb/512_w/${PHONE_PHOTO.image_id}.jpg`);
  } finally {
    await session.close();
    await stub.close();
  }
});

test('gyazo_image_content refuses rather than sending something too large', async () => {
  const cacheDir = createTempCacheDir();
  const big = Buffer.alloc(300_000, 1);
  const stub = await startStubServer(renditionStub(big));
  const session = startMcpServer(cacheDir, { imageOrigin: stub.origin });
  try {
    await initialize(session);
    const response = await session.request('tools/call', {
      name: 'gyazo_image_content',
      arguments: { id_or_url: PHONE_PHOTO.image_id, max_bytes: 100_000 },
    });
    const failed = Boolean(response.error) || response.result?.isError === true;
    expect(failed).toBe(true);
    const text = JSON.stringify(response.result ?? response.error);
    // Says how big it was, and how to get something smaller.
    expect(text).toMatch(/300000|300,000/);
    expect(text).toMatch(/width/i);
  } finally {
    await session.close();
    await stub.close();
  }
});

test('gyazo_image_content rejects something that is not a Gyazo image', async () => {
  const cacheDir = createTempCacheDir();
  const stub = await startStubServer(renditionStub(Buffer.from('x')));
  const session = startMcpServer(cacheDir, { imageOrigin: stub.origin });
  try {
    await initialize(session);
    const response = await session.request('tools/call', {
      name: 'gyazo_image_content',
      arguments: { id_or_url: 'https://example.com/cat.png' },
    });
    const failed = Boolean(response.error) || response.result?.isError === true;
    expect(failed).toBe(true);
    expect(stub.requests).toHaveLength(0);
  } finally {
    await session.close();
    await stub.close();
  }
});

// --- collections through the API ------------------------------------------

/** The API endpoints: the collection itself, its images a page at a time. */
function collectionApiStub(total: number, pageSize = 2): StubHandler {
  const images = Array.from({ length: total }, (_, index) => ({
    image_id: `dd${String(index).padStart(30, '0')}`,
    permalink_url: `https://gyazo.com/dd${String(index).padStart(30, '0')}`,
    url: `https://i.gyazo.com/dd${String(index).padStart(30, '0')}.jpg`,
    type: 'jpg',
    created_at: new Date(Date.UTC(2026, 7, 30, 0, index)).toISOString(),
    metadata: { app: 'Gyazo Android' },
  }));
  return (req, res) => {
    const url = new URL(req.url || '', 'http://127.0.0.1');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (url.pathname.endsWith('/images')) {
      const page = Number(url.searchParams.get('page') || '1');
      const per = Number(url.searchParams.get('per') || String(pageSize));
      res.end(JSON.stringify(images.slice((page - 1) * per, page * per)));
      return;
    }
    res.end(
      JSON.stringify({
        id: COLLECTION_ID,
        name: '広島実績解除2026',
        url: `https://gyazo.com/collections/${COLLECTION_ID}`,
        total_image_count: total,
        user: { name: 'yuiseki' },
      }),
    );
  };
}

test('gyazo_collection pages through a collection and says what is left', async () => {
  const cacheDir = createTempCacheDir();
  const stub = await startStubServer(collectionApiStub(5));
  const session = startMcpServer(cacheDir, { apiOrigin: stub.origin });
  try {
    await initialize(session);
    const first = await session.request('tools/call', {
      name: 'gyazo_collection',
      arguments: { id_or_url: COLLECTION_ID, per: 2 },
    });
    const page1 = JSON.parse(first.result.content[0].text);
    expect(page1.total_image_count).toBe(5);
    expect(page1.returned_image_count).toBe(2);
    expect(page1.page).toBe(1);
    expect(page1.truncated).toBe(true);
    expect(page1.images).toHaveLength(2);

    const third = await session.request('tools/call', {
      name: 'gyazo_collection',
      arguments: { id_or_url: COLLECTION_ID, per: 2, page: 3 },
    });
    const page3 = JSON.parse(third.result.content[0].text);
    expect(page3.page).toBe(3);
    expect(page3.returned_image_count).toBe(1);
    expect(page3.truncated).toBe(false);
    expect(page3.images[0].image_id).toBe('dd000000000000000000000000000004');

    const requested = stub.requests
      .filter((request) => request.url.includes('/images'))
      .map((request) => new URL(request.url, 'http://127.0.0.1').searchParams.get('page'));
    expect(requested).toEqual(['1', '3']);
  } finally {
    await session.close();
    await stub.close();
  }
});

test('gyazo_collections lists collections and filters them by name', async () => {
  const cacheDir = createTempCacheDir();
  const stub = await startStubServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (!req.url?.includes('/api/v2/collections')) {
      res.end(JSON.stringify([]));
      return;
    }
    res.end(
      JSON.stringify([
        { id: 'c1'.padEnd(32, '0'), name: '広島実績解除2026', total_image_count: 198 },
        { id: 'c2'.padEnd(32, '0'), name: 'クアラルンプール実績解除', total_image_count: 42 },
        { id: 'c3'.padEnd(32, '0'), name: 'yuisekiのラーメンマップ', total_image_count: 7 },
      ]),
    );
  });
  const session = startMcpServer(cacheDir, { apiOrigin: stub.origin });
  try {
    await initialize(session);
    const all = await session.request('tools/call', { name: 'gyazo_collections', arguments: {} });
    expect(JSON.parse(all.result.content[0].text)).toHaveLength(3);

    const hit = await session.request('tools/call', {
      name: 'gyazo_collections',
      arguments: { query: 'クアラルンプール' },
    });
    const found = JSON.parse(hit.result.content[0].text);
    expect(found).toHaveLength(1);
    expect(found[0].name).toBe('クアラルンプール実績解除');
    expect(found[0].id).toBe('c2'.padEnd(32, '0'));
    expect(found[0].total_image_count).toBe(42);

    const miss = await session.request('tools/call', {
      name: 'gyazo_collections',
      arguments: { query: 'にわとり' },
    });
    expect(miss.result.content[0].text).toMatch(/no collections/i);
  } finally {
    await session.close();
    await stub.close();
  }
});

// --- normalized location ----------------------------------------------------

/** Shaped like a real phone photo, addresses and raw EXIF included. */
const PHONE_PHOTO = {
  image_id: 'cc000000000000000000000000000001',
  permalink_url: 'https://gyazo.com/cc000000000000000000000000000001',
  url: 'https://i.gyazo.com/cc000000000000000000000000000001.jpg',
  thumb_url: 'https://thumb.gyazo.com/thumb/200/token.jpg',
  type: 'jpg',
  created_at: '2026-08-30T10:06:11.000Z',
  exif_captured_at: '2026-08-30T10:06:11.000Z',
  metadata: {
    app: 'Gyazo Android',
    ocr: { locale: 'und', description: 'お好み焼\nもり' },
    exif_normalized: {
      timezone: 'utc',
      latitude: 34.38617222222222,
      longitude: 132.45966944444444,
      time: '2026-08-30T10:06:11.000Z',
    },
    exif: {
      Altitude: '36.29',
      'Altitude Reference': 'Sea level',
      'GPS Image Direction': '18',
      'GPS Image Direction Reference': 'M',
      'Offset Time For DateTimeOriginal': '+09:00',
    },
    exif_address: {
      ja: {
        address: '日本、〒730-0043 広島県広島市中区富士見町１４−１１',
        address_components: [
          { long_name: '広島市', short_name: '広島市', types: ['locality', 'political'] },
          {
            long_name: '広島県',
            short_name: '広島県',
            types: ['administrative_area_level_1', 'political'],
          },
          { long_name: '日本', short_name: 'JP', types: ['country', 'political'] },
        ],
      },
      en: {
        address: '14-11 Fujimichō, Naka Ward, Hiroshima, 730-0043, Japan',
        address_components: [
          { long_name: 'Hiroshima', short_name: 'Hiroshima', types: ['locality', 'political'] },
          {
            long_name: 'Hiroshima',
            short_name: 'Hiroshima',
            types: ['administrative_area_level_1', 'political'],
          },
          { long_name: 'Japan', short_name: 'JP', types: ['country', 'political'] },
        ],
      },
      de: { address: 'irrelevant', address_components: [] },
    },
  },
};

test('a photo carries a normalized location, in both languages', async () => {
  const cacheDir = createTempCacheDir();
  const stub = await startStubServer(imageStub(PHONE_PHOTO, []));
  const session = startMcpServer(cacheDir, { apiOrigin: stub.origin });
  try {
    await initialize(session);
    const response = await session.request('tools/call', {
      name: 'gyazo_image',
      arguments: { id_or_url: PHONE_PHOTO.image_id },
    });
    const image = JSON.parse(response.result.content[0].text);

    expect(image.location.latitude).toBeCloseTo(34.386172, 5);
    expect(image.location.longitude).toBeCloseTo(132.459669, 5);
    expect(image.location.country_code).toBe('JP');
    // Both languages, because a Japanese address reads poorly abroad and an
    // English one reads poorly at home.
    expect(image.location.address.ja.text).toContain('広島県広島市');
    expect(image.location.address.ja.locality).toBe('広島市');
    expect(image.location.address.ja.admin1).toBe('広島県');
    expect(image.location.address.en.text).toContain('Hiroshima');
    expect(image.location.address.en.locality).toBe('Hiroshima');
    // Only the two languages a model here can use.
    expect(Object.keys(image.location.address).sort()).toEqual(['en', 'ja']);

    expect(image.location.altitude_m).toBe(36.29);
    expect(image.location.heading_deg).toBe(18);
    expect(image.location.heading_reference).toBe('magnetic');

    expect(image.captured_at).toBe('2026-08-30T10:06:11.000Z');
  } finally {
    await session.close();
    await stub.close();
  }
});

test('altitude and heading are absent when the response has no raw EXIF', async () => {
  const cacheDir = createTempCacheDir();
  // What /api/images/<id> actually returns: no metadata.exif at all.
  const noRawExif = {
    ...PHONE_PHOTO,
    metadata: { ...PHONE_PHOTO.metadata, exif: undefined },
  };
  const stub = await startStubServer(imageStub(noRawExif, []));
  const session = startMcpServer(cacheDir, { apiOrigin: stub.origin });
  try {
    await initialize(session);
    const response = await session.request('tools/call', {
      name: 'gyazo_image',
      arguments: { id_or_url: PHONE_PHOTO.image_id },
    });
    const image = JSON.parse(response.result.content[0].text);
    expect(image.location.latitude).toBeCloseTo(34.386172, 5);
    expect('altitude_m' in image.location).toBe(false);
    expect('heading_deg' in image.location).toBe(false);
  } finally {
    await session.close();
    await stub.close();
  }
});

test('a capture with no address gets coordinates and nothing invented', async () => {
  const cacheDir = createTempCacheDir();
  const noAddress = {
    ...PHONE_PHOTO,
    exif_captured_at: undefined,
    metadata: {
      app: 'Gyazo Android',
      exif_normalized: { timezone: 'utc', latitude: 1.5, longitude: 2.5 },
    },
  };
  const stub = await startStubServer(imageStub(noAddress, []));
  const session = startMcpServer(cacheDir, { apiOrigin: stub.origin });
  try {
    await initialize(session);
    const response = await session.request('tools/call', {
      name: 'gyazo_image',
      arguments: { id_or_url: PHONE_PHOTO.image_id },
    });
    const image = JSON.parse(response.result.content[0].text);
    expect(image.location).toEqual({ latitude: 1.5, longitude: 2.5 });
    expect('captured_at' in image).toBe(false);
  } finally {
    await session.close();
    await stub.close();
  }
});

// --- differential retrieval -------------------------------------------------

/** Newest first, as the API returns them, one minute apart. */
function timeline(count: number, startMinutesAgo: number, prefix = 'ee') {
  const now = Date.now();
  return Array.from({ length: count }, (_, index) => {
    const at = new Date(now - (startMinutesAgo + index) * 60_000);
    const id = `${prefix}${String(index).padStart(32 - prefix.length, '0')}`;
    return {
      image_id: id,
      permalink_url: `https://gyazo.com/${id}`,
      url: `https://i.gyazo.com/${id}.jpg`,
      type: 'jpg',
      created_at: at.toISOString(),
      metadata: { app: 'Gyazo Android', title: `capture ${index}` },
    };
  });
}

/** Serves /api/images a page at a time, so the walk can be observed. */
function pagedListStub(images: any[]): StubHandler {
  return (req, res) => {
    const url = new URL(req.url || '', 'http://127.0.0.1');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (url.pathname !== '/api/images') {
      res.end(JSON.stringify([]));
      return;
    }
    const page = Number(url.searchParams.get('page') || '1');
    const per = Number(url.searchParams.get('per_page') || '100');
    res.end(JSON.stringify(images.slice((page - 1) * per, page * per)));
  };
}

test('gyazo_recent returns only what arrived inside the window', async () => {
  const cacheDir = createTempCacheDir();
  // Three from the last few minutes, then a gap, so the boundary never lands
  // on a capture and the test does not depend on how long it takes to run.
  const inside = timeline(3, 1, 'aa');
  const outside = timeline(4, 60, 'bb');
  const stub = await startStubServer(pagedListStub([...inside, ...outside]));
  const session = startMcpServer(cacheDir, { apiOrigin: stub.origin });
  try {
    await initialize(session);
    const response = await session.request('tools/call', {
      name: 'gyazo_recent',
      arguments: { minutes: 10 },
    });
    expect(response.result.isError).toBeFalsy();
    const found = JSON.parse(response.result.content[0].text);
    expect(found.map((image: any) => image.image_id)).toEqual(
      inside.map((image) => image.image_id),
    );
  } finally {
    await session.close();
    await stub.close();
  }
});

test('gyazo_recent stops walking once it is past the window', async () => {
  const cacheDir = createTempCacheDir();
  const images = timeline(250, 1);
  const stub = await startStubServer(pagedListStub(images));
  const session = startMcpServer(cacheDir, { apiOrigin: stub.origin });
  try {
    await initialize(session);
    await session.request('tools/call', { name: 'gyazo_recent', arguments: { minutes: 3 } });
    // Listing pages only: the location lookups hit /api/images/<id>.
    const pages = stub.requests.filter((request) => request.url.startsWith('/api/images?'));
    // Everything it needs is on the first page, so it must not ask for a second.
    expect(pages).toHaveLength(1);
  } finally {
    await session.close();
    await stub.close();
  }
});

test('gyazo_recent takes a watermark image and returns what came after it', async () => {
  const cacheDir = createTempCacheDir();
  const images = timeline(10, 1);
  const stub = await startStubServer(pagedListStub(images));
  const session = startMcpServer(cacheDir, { apiOrigin: stub.origin });
  try {
    await initialize(session);
    const response = await session.request('tools/call', {
      name: 'gyazo_recent',
      arguments: { after_image_id: images[3].image_id },
    });
    const found = JSON.parse(response.result.content[0].text);
    expect(found.map((image: any) => image.image_id)).toEqual(
      images.slice(0, 3).map((image) => image.image_id),
    );
  } finally {
    await session.close();
    await stub.close();
  }
});

test('gyazo_recent says so when the watermark is out of reach', async () => {
  const cacheDir = createTempCacheDir();
  const images = timeline(10, 1);
  const stub = await startStubServer(pagedListStub(images));
  const session = startMcpServer(cacheDir, { apiOrigin: stub.origin });
  try {
    await initialize(session);
    const response = await session.request('tools/call', {
      name: 'gyazo_recent',
      arguments: { after_image_id: 'ff000000000000000000000000000099' },
    });
    // Returning everything walked would read as "all of this is new", which is
    // worse than saying the watermark was not found.
    const failed = Boolean(response.error) || response.result?.isError === true;
    expect(failed).toBe(true);
    const text = JSON.stringify(response.result ?? response.error);
    expect(text).toMatch(/not found/i);
  } finally {
    await session.close();
    await stub.close();
  }
});

test('gyazo_recent accepts an explicit since timestamp', async () => {
  const cacheDir = createTempCacheDir();
  const images = timeline(10, 1);
  const stub = await startStubServer(pagedListStub(images));
  const session = startMcpServer(cacheDir, { apiOrigin: stub.origin });
  try {
    await initialize(session);
    const since = images[2].created_at;
    const response = await session.request('tools/call', {
      name: 'gyazo_recent',
      arguments: { since },
    });
    const found = JSON.parse(response.result.content[0].text);
    expect(found.map((image: any) => image.image_id)).toEqual(
      images.slice(0, 3).map((image) => image.image_id),
    );

    const bad = await session.request('tools/call', {
      name: 'gyazo_recent',
      arguments: { since: 'yesterday' },
    });
    const failed = Boolean(bad.error) || bad.result?.isError === true;
    expect(failed).toBe(true);
  } finally {
    await session.close();
    await stub.close();
  }
});

test('gyazo_recent says when nothing arrived', async () => {
  const cacheDir = createTempCacheDir();
  const stub = await startStubServer(pagedListStub(timeline(5, 120)));
  const session = startMcpServer(cacheDir, { apiOrigin: stub.origin });
  try {
    await initialize(session);
    const response = await session.request('tools/call', {
      name: 'gyazo_recent',
      arguments: { minutes: 10 },
    });
    expect(response.result.content[0].text).toMatch(/no images found/i);
  } finally {
    await session.close();
    await stub.close();
  }
});

test('every call is logged on stderr with how long it took', async () => {
  const cacheDir = createTempCacheDir();
  const stub = await startStubServer(searchStub(IMAGES));
  const session = startMcpServer(cacheDir, { apiOrigin: stub.origin });
  try {
    await initialize(session);
    await session.request('tools/call', {
      name: 'gyazo_search',
      arguments: { query: 'cat' },
    });
    await session.request('tools/call', {
      name: 'gyazo_image',
      arguments: { id_or_url: 'not-an-id' },
    });
    // The child writes as it goes, so give the pipe a moment to drain.
    await new Promise((resolve) => setTimeout(resolve, 300));

    const stderr = session.stderr();
    expect(stderr).toMatch(/\[gyazo-mcp\] gyazo_search ok \d+ms query="cat"/);
    expect(stderr).toMatch(/\[gyazo-mcp\] gyazo_image failed \d+ms/);
    // Never on stdout, which belongs to the protocol.
    for (const line of session.stdoutLines()) {
      expect(line).not.toContain('[gyazo-mcp]');
    }
  } finally {
    await session.close();
    await stub.close();
  }
});

test.each(['--mcp', 'mcp', 'mcp-server'])('%s starts the server too', async (arg) => {
  const session = startMcpServer(createTempCacheDir(), { args: [arg] });
  try {
    const response = await initialize(session);
    expect(response.result.serverInfo.name).toBe('gyazocli');
  } finally {
    await session.close();
  }
});
