import { test, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createTempCacheDir, runCli, startStubServer } from './helpers';

const ID = 'ab'.padEnd(32, '0');

function cookieFile(dir: string): string {
  const file = path.join(dir, 'cookie.json');
  fs.writeFileSync(file, JSON.stringify([{ name: 'Gyazo_session', value: 's', domain: '.gyazo.com' }]));
  return file;
}

function readCached(dir: string, id: string): any {
  const file = path.join(dir, 'images', id[0], id[1], `${id}.json`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/**
 * Serves the three detail sources sync can use, and records which it was asked
 * for: the search listing, the OAuth API detail, and the web per-image JSON.
 */
function sourceStub() {
  const calls = { search: 0, api: 0, web: 0 };
  const handler = (req: any, res: any) => {
    const url = new URL(req.url || '', 'http://127.0.0.1');
    res.writeHead(200, { 'content-type': 'application/json' });
    if (url.pathname === '/api/search') {
      calls.search += 1;
      const page = Number(url.searchParams.get('page') || '1');
      res.end(JSON.stringify(page === 1 ? [{ image_id: ID, created_at: '2026-08-30T00:00:00.000Z' }] : []));
      return;
    }
    if (url.pathname === `/api/images/${ID}`) {
      calls.api += 1;
      res.end(JSON.stringify({
        image_id: ID,
        created_at: '2026-08-30T00:00:00.000Z',
        jwt_token: 'jwt',
        metadata: {
          app: 'photo-gyazo',
          url: 'https://example.com/post',
          // desc/links/user are what the API puts under metadata and the web JSON
          // never does (it carries them at top level) -- the api-completeness signal.
          desc: '',
          links: [],
          user: { name: 'yuiseki' },
          original_url: 'https://example.com/post',
          exif_address: { ja: { address: '東京都' } },
        },
      }));
      return;
    }
    if (url.pathname === `/${ID}.json`) {
      calls.web += 1;
      res.end(JSON.stringify({
        image_id: ID,
        created_at: '2026-08-30T00:00:00.000Z',
        file_size: 12345,
        metadata: { app: 'photo-gyazo', hashtags: ['x'] },
      }));
      return;
    }
    res.writeHead(404); res.end('{}');
  };
  return { handler, calls };
}

test('sync --web stores file_size and does not call the OAuth API', async () => {
  const cacheDir = createTempCacheDir();
  const { handler, calls } = sourceStub();
  const stub = await startStubServer(handler);
  try {
    const result = await runCli(cacheDir, ['sync', '--query', 'has:exif', '--web'], {
      apiOrigin: stub.origin,
      webOrigin: stub.origin,
      cookieFile: cookieFile(cacheDir),
    });
    expect(result.status).toBe(0);
    expect(calls.web).toBe(1);
    expect(calls.api).toBe(0);
    const rec = readCached(cacheDir, ID);
    expect(rec.file_size).toBe(12345);
    // No API fields yet: the web JSON never puts desc/links/user under metadata,
    // which is how api-completeness is judged.
    expect('user' in (rec.metadata || {})).toBe(false);
    expect('desc' in (rec.metadata || {})).toBe(false);
  } finally {
    await stub.close();
  }
});

test('sync --api stores the API detail and marks api_synced_at, no web call', async () => {
  const cacheDir = createTempCacheDir();
  const { handler, calls } = sourceStub();
  const stub = await startStubServer(handler);
  try {
    const result = await runCli(cacheDir, ['sync', '--query', 'has:exif', '--api'], {
      apiOrigin: stub.origin,
      webOrigin: stub.origin,
    });
    expect(result.status).toBe(0);
    expect(calls.api).toBe(1);
    expect(calls.web).toBe(0);
    const rec = readCached(cacheDir, ID);
    expect(rec.metadata.exif_address.ja.address).toBe('東京都');
    expect(rec.metadata.user).toEqual({ name: 'yuiseki' }); // api-only-at-path signal
    expect(rec.file_size).toBeUndefined();
  } finally {
    await stub.close();
  }
});

test('web first then api fills in, merging without clobbering (the staged workflow)', async () => {
  const cacheDir = createTempCacheDir();
  const { handler, calls } = sourceStub();
  const stub = await startStubServer(handler);
  try {
    const web = await runCli(cacheDir, ['sync', '--query', 'has:exif', '--web'], {
      apiOrigin: stub.origin, webOrigin: stub.origin, cookieFile: cookieFile(cacheDir),
    });
    expect(web.status).toBe(0);

    // The api pass must NOT skip an image already web-cached.
    const api = await runCli(cacheDir, ['sync', '--query', 'has:exif', '--api'], {
      apiOrigin: stub.origin, webOrigin: stub.origin,
    });
    expect(api.status).toBe(0);
    expect(calls.api).toBe(1);

    const rec = readCached(cacheDir, ID);
    expect(rec.file_size).toBe(12345); // kept from the web pass
    expect(rec.metadata.exif_address.ja.address).toBe('東京都'); // added by the api pass
    expect(rec.metadata.hashtags).toEqual(['x']); // web-only metadata survived
    expect(rec.metadata.url).toBe('https://example.com/post'); // api metadata present
    expect(rec.metadata.user).toEqual({ name: 'yuiseki' }); // api completeness signal
  } finally {
    await stub.close();
  }
});

test('a second api pass skips an already api-synced image', async () => {
  const cacheDir = createTempCacheDir();
  const { handler, calls } = sourceStub();
  const stub = await startStubServer(handler);
  try {
    await runCli(cacheDir, ['sync', '--query', 'has:exif', '--api'], { apiOrigin: stub.origin, webOrigin: stub.origin });
    const second = await runCli(cacheDir, ['sync', '--query', 'has:exif', '--api'], { apiOrigin: stub.origin, webOrigin: stub.origin });
    expect(second.status).toBe(0);
    expect(calls.api).toBe(1); // not re-fetched
    expect(second.stdout).toContain('s');
  } finally {
    await stub.close();
  }
});

test('a record cached by an earlier api-only sync is not re-fetched by --api', async () => {
  // Pre-existing API record: has the api-only metadata (desc/links/user), no file_size.
  const cacheDir = createTempCacheDir();
  const dir = path.join(cacheDir, 'images', ID[0], ID[1]);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${ID}.json`),
    JSON.stringify({ image_id: ID, created_at: '2026-08-30T00:00:00.000Z', metadata: { app: 'a', desc: '', links: [], user: { name: 'a' } } }),
  );
  const { handler, calls } = sourceStub();
  const stub = await startStubServer(handler);
  try {
    // --api sees it as already API-complete and skips it.
    const api = await runCli(cacheDir, ['sync', '--query', 'has:exif', '--api'], { apiOrigin: stub.origin, webOrigin: stub.origin });
    expect(api.status).toBe(0);
    expect(calls.api).toBe(0);

    // --web still fills in file_size.
    const web = await runCli(cacheDir, ['sync', '--query', 'has:exif', '--web'], {
      apiOrigin: stub.origin, webOrigin: stub.origin, cookieFile: cookieFile(cacheDir),
    });
    expect(web.status).toBe(0);
    expect(calls.web).toBe(1);
    expect(readCached(cacheDir, ID).file_size).toBe(12345);
  } finally {
    await stub.close();
  }
});

test('sync rejects more than one source flag', async () => {
  const cacheDir = createTempCacheDir();
  const { handler } = sourceStub();
  const stub = await startStubServer(handler);
  try {
    const result = await runCli(cacheDir, ['sync', '--query', 'x', '--web', '--api'], { apiOrigin: stub.origin });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/only one of --web, --api, --web-and-api/);
  } finally {
    await stub.close();
  }
});
