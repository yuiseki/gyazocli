import { test, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  createTempCacheDir,
  runCli,
  startStubServer,
  writeImageCache,
  type StubHandler,
} from './helpers';

function sampleImage(imageId: string, title = 'Sample Title') {
  return {
    image_id: imageId,
    permalink_url: `https://gyazo.com/${imageId}`,
    created_at: '2026-02-20T02:34:56+09:00',
    metadata: { title },
  };
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

// --- exit codes on API failure ----------------------------------------------------

test('get exits non-zero when the API returns an error', async () => {
  const cacheDir = createTempCacheDir();
  const stub = await startStubServer((_req, res) => {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{}');
  });
  try {
    const result = await runCli(cacheDir, ['get', 'ffffffffffffffffffffffffffffffff'], {
      apiOrigin: stub.origin,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/Error getting image/);
  } finally {
    await stub.close();
  }
});

test('list exits non-zero when the API returns an error', async () => {
  const cacheDir = createTempCacheDir();
  const stub = await startStubServer((_req, res) => {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end('{}');
  });
  try {
    const result = await runCli(cacheDir, ['list'], { apiOrigin: stub.origin });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/Error listing images/);
  } finally {
    await stub.close();
  }
});

// --- sync over a query ------------------------------------------------------

test('sync --query walks the search endpoint and caches what it finds', async () => {
  const cacheDir = createTempCacheDir();
  const pageOf = (prefix: string) =>
    Array.from({ length: 2 }, (_, index) => ({
      image_id: `${prefix}${String(index).padStart(30, '0')}`,
      permalink_url: `https://gyazo.com/${prefix}${String(index).padStart(30, '0')}`,
      url: `https://i.gyazo.com/${prefix}${String(index).padStart(30, '0')}.jpg`,
      type: 'jpg',
      created_at: '2026-08-30T02:34:56+0900',
      metadata: { app: 'Gyazo Android' },
    }));

  const stub = await startStubServer((req, res) => {
    const url = new URL(req.url || '', 'http://127.0.0.1');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (url.pathname === '/api/search') {
      const page = Number(url.searchParams.get('page') || '1');
      res.end(JSON.stringify(page === 1 ? pageOf('aa') : page === 2 ? pageOf('bb') : []));
      return;
    }
    if (url.pathname.startsWith('/api/images/')) {
      const id = url.pathname.split('/').pop();
      res.end(JSON.stringify({ image_id: id, created_at: '2026-08-30T02:34:56+0900', ocr: { description: 'x' } }));
      return;
    }
    res.end(JSON.stringify([]));
  });

  try {
    const result = await runCli(
      cacheDir,
      ['sync', '--query', 'has:exif OR has:location', '--max-pages', '2'],
      { apiOrigin: stub.origin },
    );
    expect(result.status).toBe(0);

    const searches = stub.requests.filter((request) => request.url.startsWith('/api/search'));
    expect(searches).toHaveLength(2);
    const first = new URL(searches[0].url, 'http://127.0.0.1').searchParams;
    expect(first.get('query')).toBe('has:exif OR has:location');
    expect(first.get('per')).toBe('100');
    expect(first.get('page')).toBe('1');
    // The listing endpoint is not touched at all on this path.
    expect(stub.requests.some((request) => request.url.startsWith('/api/images?'))).toBe(false);

    // Every capture it found is in the cache, under its own id.
    for (const prefix of ['aa', 'bb']) {
      const id = `${prefix}${'0'.repeat(30)}`;
      const cached = path.join(cacheDir, 'images', id[0], id[1], `${id}.json`);
      expect(fs.existsSync(cached), `${id} should be cached`).toBe(true);
    }
    // And in the hourly index for the hour it was captured in.
    const hourly = path.join(cacheDir, 'hourly', '2026', '08', '30', '02.json');
    expect(fs.existsSync(hourly)).toBe(true);
    expect(JSON.parse(fs.readFileSync(hourly, 'utf8'))).toHaveLength(4);
  } finally {
    await stub.close();
  }
});

test('sync --query refuses a date range, and names what to use instead', async () => {
  const cacheDir = createTempCacheDir();
  for (const args of [
    ['sync', '--query', 'has:exif', '--days', '7'],
    ['sync', '--query', 'has:exif', '--date', '2026-08'],
  ]) {
    const result = await runCli(cacheDir, args);
    expect(result.status, args.join(' ')).toBe(1);
    expect(result.stderr).toMatch(/--query cannot be used with --date or --days/);
    expect(result.stderr).toMatch(/date:|since:/);
  }
});

test('search asks for the page and the page size it was given', async () => {
  const cacheDir = createTempCacheDir();
  const stub = await startStubServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify([]));
  });
  try {
    const first = await runCli(cacheDir, ['search', 'cat', '--json'], { apiOrigin: stub.origin });
    expect(first.status).toBe(0);
    const third = await runCli(cacheDir, ['search', 'cat', '--page', '3', '--json'], {
      apiOrigin: stub.origin,
    });
    expect(third.status).toBe(0);

    const sized = await runCli(cacheDir, ['search', 'cat', '--limit', '50', '--json'], {
      apiOrigin: stub.origin,
    });
    expect(sized.status).toBe(0);

    const asked = stub.requests
      .filter((request) => request.url.startsWith('/api/search'))
      .map((request) => {
        const params = new URL(request.url, 'http://127.0.0.1').searchParams;
        return `${params.get('page')}/${params.get('per')}`;
      });
    // The API calls the page size `per`, and the default matches `ls`.
    expect(asked).toEqual(['1/20', '3/20', '1/50']);
  } finally {
    await stub.close();
  }
});

test('search rejects a page or a limit that is not a positive integer', async () => {
  const cacheDir = createTempCacheDir();
  const stub = await startStubServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify([]));
  });
  try {
    for (const page of ['0', '-1', 'two']) {
      const result = await runCli(cacheDir, ['search', 'cat', '--page', page], {
        apiOrigin: stub.origin,
      });
      expect(result.status, `--page ${page}`).toBe(1);
      expect(result.stderr).toMatch(/--page must be a positive integer/);
    }
    for (const limit of ['0', '-1', 'many']) {
      const result = await runCli(cacheDir, ['search', 'cat', '--limit', limit], {
        apiOrigin: stub.origin,
      });
      expect(result.status, `--limit ${limit}`).toBe(1);
      expect(result.stderr).toMatch(/--limit must be a positive integer/);
    }
    expect(stub.requests).toHaveLength(0);
  } finally {
    await stub.close();
  }
});

test('search exits non-zero when the API returns an error', async () => {
  const cacheDir = createTempCacheDir();
  const stub = await startStubServer((_req, res) => {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end('{}');
  });
  try {
    const result = await runCli(cacheDir, ['search', 'anything'], { apiOrigin: stub.origin });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/Error searching images/);
  } finally {
    await stub.close();
  }
});

// --- upload output ---------------------------------------------------------------

const UPLOADED_ID = 'ab12cd34ef56ab12cd34ef56ab12cd34';

function uploadStubHandler(): StubHandler {
  return (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        image_id: UPLOADED_ID,
        permalink_url: `https://gyazo.com/${UPLOADED_ID}`,
        url: `https://i.gyazo.com/${UPLOADED_ID}.png`,
        type: 'png',
        created_at: '2026-02-20T02:34:56+09:00',
      }),
    );
  };
}

function writeTempImage(cacheDir: string): string {
  const filePath = path.join(cacheDir, 'sample.png');
  fs.writeFileSync(filePath, Buffer.from('89504e470d0a1a0a', 'hex'));
  return filePath;
}

test('upload prints only the permalink URL on stdout by default', async () => {
  const cacheDir = createTempCacheDir();
  const imagePath = writeTempImage(cacheDir);
  const stub = await startStubServer(uploadStubHandler());
  try {
    const result = await runCli(cacheDir, ['upload', imagePath], { uploadOrigin: stub.origin });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`https://gyazo.com/${UPLOADED_ID}\n`);
  } finally {
    await stub.close();
  }
});

test('upload --json prints the full upload response', async () => {
  const cacheDir = createTempCacheDir();
  const imagePath = writeTempImage(cacheDir);
  const stub = await startStubServer(uploadStubHandler());
  try {
    const result = await runCli(cacheDir, ['upload', '--json', imagePath], { uploadOrigin: stub.origin });
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.image_id).toBe(UPLOADED_ID);
    expect(parsed.permalink_url).toBe(`https://gyazo.com/${UPLOADED_ID}`);
  } finally {
    await stub.close();
  }
});

// --- implicit dispatch of the first argument --------------------------------------

test('a bare image id is dispatched to get', async () => {
  const cacheDir = createTempCacheDir();
  const imageId = '49a008e2f254f513063b6ec4d3082944';
  writeImageCache(cacheDir, imageId, sampleImage(imageId));

  const implicit = await runCli(cacheDir, [imageId]);
  const explicit = await runCli(cacheDir, ['get', imageId]);
  expect(implicit.status).toBe(0);
  expect(implicit.stdout).toBe(explicit.stdout);
});

test('a bare permalink URL is dispatched to get', async () => {
  const cacheDir = createTempCacheDir();
  const imageId = '49a008e2f254f513063b6ec4d3082945';
  writeImageCache(cacheDir, imageId, sampleImage(imageId));

  const result = await runCli(cacheDir, [`https://gyazo.com/${imageId}`]);
  expect(result.status).toBe(0);
  expect(result.stdout).toContain(`- URL: <https://gyazo.com/${imageId}>`);
});

test('implicit get still honours option flags', async () => {
  const cacheDir = createTempCacheDir();
  const imageId = '49a008e2f254f513063b6ec4d3082946';
  writeImageCache(cacheDir, imageId, sampleImage(imageId));

  const result = await runCli(cacheDir, [imageId, '--json']);
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout).image_id).toBe(imageId);
});

test('an existing file path is dispatched to upload', async () => {
  const cacheDir = createTempCacheDir();
  const imagePath = writeTempImage(cacheDir);
  const stub = await startStubServer(uploadStubHandler());
  try {
    const result = await runCli(cacheDir, [imagePath], { uploadOrigin: stub.origin });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`https://gyazo.com/${UPLOADED_ID}\n`);
  } finally {
    await stub.close();
  }
});

test('implicit upload still honours option flags', async () => {
  const cacheDir = createTempCacheDir();
  const imagePath = writeTempImage(cacheDir);
  const stub = await startStubServer(uploadStubHandler());
  try {
    const result = await runCli(cacheDir, [imagePath, '--json'], { uploadOrigin: stub.origin });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).image_id).toBe(UPLOADED_ID);
  } finally {
    await stub.close();
  }
});

test('a known subcommand name is never treated as a path or id', async () => {
  const cacheDir = createTempCacheDir();
  const result = await runCli(cacheDir, ['search']);
  expect(result.status).toBe(1);
  expect(result.stderr).toMatch(/Query is required/);
});

test('an unrecognisable first argument still reports unknown command', async () => {
  const cacheDir = createTempCacheDir();
  const result = await runCli(cacheDir, ['definitely-not-a-command']);
  expect(result.status).toBe(1);
  expect(result.stderr).toMatch(/unknown command/);
});

test('help is unaffected by implicit dispatch', async () => {
  const cacheDir = createTempCacheDir();
  const result = await runCli(cacheDir, ['--help']);
  expect(result.status).toBe(0);
  expect(result.stdout).toMatch(/Usage: gyazo/);
});
