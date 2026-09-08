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
    expect(Object.keys(search.inputSchema.properties).sort()).toEqual(['page', 'per', 'query']);
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
  metadata: { app: 'Safari', title: 'Kyoto', url: 'https://example.com/kyoto' },
  exif_normalized: { latitude: 34.9858, longitude: 135.7588 },
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
      'gyazo_image',
      'gyazo_latest_image',
      'gyazo_list',
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
    expect(image.exif_normalized).toEqual(DETAIL.exif_normalized);
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

function collectionStub(): StubHandler {
  return (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        id: COLLECTION_ID,
        name: 'Hiroshima 2026',
        url: `https://gyazo.com/collections/${COLLECTION_ID}`,
        total_image_count: 2,
        user: { id: '5342', name: 'yuiseki' },
        images: [
          { ...IMAGES[0], created_at: '2026-08-30T05:00:00.000Z' },
          { ...IMAGES[1], created_at: '2026-08-30T07:00:00.000Z' },
        ],
      }),
    );
  };
}

test('gyazo_collection reads a collection and its images', async () => {
  const cacheDir = createTempCacheDir();
  const stub = await startStubServer(collectionStub());
  const session = startMcpServer(cacheDir, { webOrigin: stub.origin });
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
    expect(requested!.url).toContain(`/collections/${COLLECTION_ID}.json`);
  } finally {
    await session.close();
    await stub.close();
  }
});

test('gyazo_collection sorts by capture time when asked', async () => {
  const cacheDir = createTempCacheDir();
  const stub = await startStubServer(collectionStub());
  const session = startMcpServer(cacheDir, { webOrigin: stub.origin });
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
  const session = startMcpServer(cacheDir, { webOrigin: stub.origin });
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
