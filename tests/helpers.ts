import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';

export const REPO_ROOT = process.cwd();
export const CLI_PATH = path.join(REPO_ROOT, 'dist', 'index.js');

export type StubHandler = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  body: Buffer,
) => void;

export interface StubServer {
  origin: string;
  requests: { method: string; url: string; authorization?: string }[];
  close: () => Promise<void>;
}

export interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export interface CliOptions {
  input?: string | Buffer;
  apiOrigin?: string;
  uploadOrigin?: string;
  webOrigin?: string;
  /** Omit the access token entirely, as an agent with no credentials would. */
  noToken?: boolean;
}

export function createTempCacheDir(prefix = 'gyazocli-test-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function writeImageCache(cacheDir: string, imageId: string, image: unknown): void {
  const p1 = imageId[0] || '_';
  const p2 = imageId[1] || '_';
  const dir = path.join(cacheDir, 'images', p1, p2);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${imageId}.json`), JSON.stringify(image, null, 2), 'utf8');
}

export async function startStubServer(handler: StubHandler): Promise<StubServer> {
  const requests: StubServer['requests'] = [];
  const server = http.createServer((req, res) => {
    requests.push({
      method: req.method || '',
      url: req.url || '',
      authorization: req.headers.authorization,
    });
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
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/**
 * Spawned asynchronously on purpose: a stub server shares this event loop, so a
 * blocking spawnSync would deadlock against its own HTTP responses.
 */
export function runCli(
  cacheDir: string,
  args: string[],
  options: CliOptions = {},
): Promise<CliResult> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GYAZO_ACCESS_TOKEN: 'test-token',
    GYAZO_CACHE_DIR: cacheDir,
    // Keep a stray credentials.json on the developer's machine out of the test.
    HOME: cacheDir,
  };
  if (options.noToken) delete env.GYAZO_ACCESS_TOKEN;
  if (options.apiOrigin) env.GYAZO_API_ORIGIN = options.apiOrigin;
  if (options.uploadOrigin) env.GYAZO_UPLOAD_ORIGIN = options.uploadOrigin;
  if (options.webOrigin) env.GYAZO_WEB_ORIGIN = options.webOrigin;

  const child = spawn(process.execPath, [CLI_PATH, ...args], {
    cwd: REPO_ROOT,
    env,
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
