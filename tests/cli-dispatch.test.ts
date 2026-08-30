import { test, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';

const REPO_ROOT = process.cwd();
const CLI_PATH = path.join(REPO_ROOT, 'dist', 'index.js');

type StubHandler = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  body: Buffer,
) => void;

function createTempCacheDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gyazocli-dispatch-'));
}

function writeImageCache(cacheDir: string, imageId: string, image: unknown): void {
  const p1 = imageId[0] || '_';
  const p2 = imageId[1] || '_';
  const dir = path.join(cacheDir, 'images', p1, p2);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${imageId}.json`), JSON.stringify(image, null, 2), 'utf8');
}

function sampleImage(imageId: string, title = 'Sample Title') {
  return {
    image_id: imageId,
    permalink_url: `https://gyazo.com/${imageId}`,
    created_at: '2026-02-20T02:34:56+09:00',
    metadata: { title },
  };
}

async function startStubServer(handler: StubHandler): Promise<{ origin: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk as Buffer));
    req.on('end', () => handler(req, res, Buffer.concat(chunks)));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('failed to start stub server');
  }
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Spawned asynchronously on purpose: the stub server below shares this event
 * loop, so a blocking spawnSync would deadlock against its own HTTP responses.
 */
function runCli(
  cacheDir: string,
  args: string[],
  options: { input?: string | Buffer; apiOrigin?: string; uploadOrigin?: string } = {},
): Promise<CliResult> {
  const child = spawn(process.execPath, [CLI_PATH, ...args], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      GYAZO_ACCESS_TOKEN: 'test-token',
      GYAZO_CACHE_DIR: cacheDir,
      ...(options.apiOrigin ? { GYAZO_API_ORIGIN: options.apiOrigin } : {}),
      ...(options.uploadOrigin ? { GYAZO_UPLOAD_ORIGIN: options.uploadOrigin } : {}),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });

  if (options.input !== undefined) {
    child.stdin.write(options.input);
  }
  child.stdin.end();

  return new Promise<CliResult>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

// --- image id / URL normalization -------------------------------------------------

test('get accepts a permalink URL in place of an image id', async () => {
  const cacheDir = createTempCacheDir();
  const imageId = '49a008e2f254f513063b6ec4d3082940';
  writeImageCache(cacheDir, imageId, sampleImage(imageId));

  const result = await runCli(cacheDir, ['get', `https://gyazo.com/${imageId}`]);
  expect(result.status).toBe(0);
  expect(result.stdout).toContain(`- URL: <https://gyazo.com/${imageId}>`);
  expect(result.stdout).toContain('- Title: Sample Title');
});

test('get accepts an i.gyazo.com URL with an extension', async () => {
  const cacheDir = createTempCacheDir();
  const imageId = '49a008e2f254f513063b6ec4d3082941';
  writeImageCache(cacheDir, imageId, sampleImage(imageId));

  const result = await runCli(cacheDir, ['get', `https://i.gyazo.com/${imageId}.png`]);
  expect(result.status).toBe(0);
  expect(result.stdout).toContain(`- URL: <https://gyazo.com/${imageId}>`);
});

test('get accepts a permalink URL with query and fragment', async () => {
  const cacheDir = createTempCacheDir();
  const imageId = '49a008e2f254f513063b6ec4d3082942';
  writeImageCache(cacheDir, imageId, sampleImage(imageId));

  const result = await runCli(cacheDir, ['get', `https://gyazo.com/${imageId}?foo=bar#frag`]);
  expect(result.status).toBe(0);
  expect(result.stdout).toContain(`- URL: <https://gyazo.com/${imageId}>`);
});

test('get normalizes an uppercase image id', async () => {
  const cacheDir = createTempCacheDir();
  const imageId = '49a008e2f254f513063b6ec4d3082943';
  writeImageCache(cacheDir, imageId, sampleImage(imageId));

  const result = await runCli(cacheDir, ['get', imageId.toUpperCase()]);
  expect(result.status).toBe(0);
  expect(result.stdout).toContain(`- URL: <https://gyazo.com/${imageId}>`);
});

test('get rejects an argument that is neither an image id nor a Gyazo URL', async () => {
  const cacheDir = createTempCacheDir();
  const result = await runCli(cacheDir, ['get', 'not-an-image-id']);
  expect(result.status).toBe(1);
  expect(result.stderr).toMatch(/is not a Gyazo image ID or URL/);
});

test('get rejects a non-Gyazo URL', async () => {
  const cacheDir = createTempCacheDir();
  const result = await runCli(cacheDir, ['get', 'https://example.com/49a008e2f254f513063b6ec4d3082940']);
  expect(result.status).toBe(1);
  expect(result.stderr).toMatch(/is not a Gyazo image ID or URL/);
});

