import { test, expect } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import {
  CLI_PATH,
  REPO_ROOT,
  createTempCacheDir,
  startStubServer,
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
  options: { apiOrigin?: string; noToken?: boolean; args?: string[] } = {},
): McpSession {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GYAZO_ACCESS_TOKEN: 'test-token',
    GYAZO_CACHE_DIR: cacheDir,
    HOME: cacheDir,
  };
  if (options.noToken) delete env.GYAZO_ACCESS_TOKEN;
  if (options.apiOrigin) env.GYAZO_API_ORIGIN = options.apiOrigin;

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
          10000,
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

test.each(['--mcp', 'mcp', 'mcp-server'])('%s starts the server too', async (arg) => {
  const session = startMcpServer(createTempCacheDir(), { args: [arg] });
  try {
    const response = await initialize(session);
    expect(response.result.serverInfo.name).toBe('gyazocli');
  } finally {
    await session.close();
  }
});
