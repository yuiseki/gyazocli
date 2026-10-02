import { test, expect } from 'vitest';
import {
  createTempCacheDir,
  runCli,
  startStubServer,
  type StubServer,
} from './helpers';

const COLLECTION_ID = '21ca16a1023c667a7a437be561a65018';

function image(id: string, createdAt: string, capturedAt: string, desc: string) {
  return {
    image_id: id,
    permalink_url: `https://gyazo.com/${id}`,
    url: `https://i.gyazo.com/${id}.jpg`,
    type: 'jpg',
    created_at: createdAt,
    exif_captured_at: capturedAt,
    desc,
    alt_text: '',
    access_policy: 'anyone',
    metadata_is_public: true,
    metadata: {
      app: 'Gyazo Android',
      exif_address: { ja: { address: '広島県広島市中区' } },
    },
  };
}

// Deliberately not in created_at order: a collection is ordered by when images
// were added to it, which is what the API returns.
const IMAGES = [
  image('aa000000000000000000000000000001', '2026-08-30T05:00:00.000Z', '2026-08-30T04:00:00.000Z', 'added first'),
  image('aa000000000000000000000000000002', '2026-08-30T07:00:00.000Z', '2026-08-30T01:00:00.000Z', 'added second'),
  image('aa000000000000000000000000000003', '2026-08-30T06:00:00.000Z', '2026-08-30T09:00:00.000Z', 'added third'),
];

function collectionPayload(overrides: Record<string, unknown> = {}) {
  return {
    id: COLLECTION_ID,
    name: 'Hiroshima 2026',
    description: null,
    url: `https://gyazo.com/collections/${COLLECTION_ID}`,
    path: `/collections/${COLLECTION_ID}`,
    feed_url: `https://gyazo.com/collections/${COLLECTION_ID}.atom`,
    total_image_count: 3,
    list_updated_at: '2026-08-30T06:23:41.764Z',
    user: { id: '5342', name: 'yuiseki', pro: true },
    images: IMAGES,
    ...overrides,
  };
}

async function startCollectionStub(
  payload: unknown = collectionPayload(),
  status = 200,
): Promise<StubServer> {
  return startStubServer((_req, res) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(payload));
  });
}

async function withStub(
  fn: (stub: StubServer) => Promise<void>,
  payload?: unknown,
  status?: number,
): Promise<void> {
  const stub = await startCollectionStub(payload, status);
  try {
    await fn(stub);
  } finally {
    await stub.close();
  }
}

function idsInOrder(stdout: string): string[] {
  return [...stdout.matchAll(/\(id: ([0-9a-f]{4})\.\.\.\)/g)].map((m) => m[1]);
}

// --- fetching and output ----------------------------------------------------

test('collection fetches the web JSON endpoint and prints markdown', async () => {
  const cacheDir = createTempCacheDir();
  await withStub(async (stub) => {
    const result = await runCli(cacheDir, ['collection', COLLECTION_ID], { webOrigin: stub.origin });
    expect(result.status).toBe(0);
    expect(stub.requests[0].url).toBe(`/collections/${COLLECTION_ID}.json`);
    expect(result.stdout).toContain('## Gyazo Collection');
    expect(result.stdout).toContain('- Name: Hiroshima 2026');
    expect(result.stdout).toContain(`- URL: <https://gyazo.com/collections/${COLLECTION_ID}>`);
    expect(result.stdout).toContain('- Owner: yuiseki');
    expect(result.stdout).toContain('- Images: 3');
    expect(result.stdout).toContain('### Images');
    expect(result.stdout).toContain('(id: aa00...)');
  });
});

test('collection reports how many of the total images are shown', async () => {
  const cacheDir = createTempCacheDir();
  await withStub(
    async (stub) => {
      const result = await runCli(cacheDir, ['collection', COLLECTION_ID], { webOrigin: stub.origin });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('- Images: 3 of 145');
      expect(result.stdout).toMatch(/only the first 100/i);
    },
    collectionPayload({ total_image_count: 145 }),
  );
});

test('collection --json prints the raw response', async () => {
  const cacheDir = createTempCacheDir();
  await withStub(async (stub) => {
    const result = await runCli(cacheDir, ['collection', '--json', COLLECTION_ID], {
      webOrigin: stub.origin,
    });
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.id).toBe(COLLECTION_ID);
    expect(parsed.images).toHaveLength(3);
  });
});

// --- accepted forms ---------------------------------------------------------

const ACCEPTED = [
  ['bare id', COLLECTION_ID],
  ['permalink', `https://gyazo.com/collections/${COLLECTION_ID}`],
  ['trailing slash', `https://gyazo.com/collections/${COLLECTION_ID}/`],
  ['json url', `https://gyazo.com/collections/${COLLECTION_ID}.json`],
  ['geojson url', `https://gyazo.com/collections/${COLLECTION_ID}.geojson`],
  ['atom url', `https://gyazo.com/collections/${COLLECTION_ID}.atom`],
  ['query and fragment', `https://gyazo.com/collections/${COLLECTION_ID}?a=b#c`],
  ['uppercase id', COLLECTION_ID.toUpperCase()],
];

for (const [label, arg] of ACCEPTED) {
  test(`collection accepts a ${label}`, async () => {
    const cacheDir = createTempCacheDir();
    await withStub(async (stub) => {
      const result = await runCli(cacheDir, ['collection', arg], { webOrigin: stub.origin });
      expect(result.status).toBe(0);
      expect(stub.requests[0].url).toBe(`/collections/${COLLECTION_ID}.json`);
    });
  });
}

for (const alias of ['col', 'cols', 'collections']) {
  test(`\`${alias}\` is an alias of collection`, async () => {
    const cacheDir = createTempCacheDir();
    await withStub(async (stub) => {
      const result = await runCli(cacheDir, [alias, COLLECTION_ID], { webOrigin: stub.origin });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('## Gyazo Collection');
    });
  });
}

test('a collection URL is dispatched to collection without a subcommand', async () => {
  const cacheDir = createTempCacheDir();
  await withStub(async (stub) => {
    const result = await runCli(cacheDir, [`https://gyazo.com/collections/${COLLECTION_ID}`], {
      webOrigin: stub.origin,
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('## Gyazo Collection');
  });
});

test('collection rejects an argument that is not a collection ID or URL', async () => {
  const cacheDir = createTempCacheDir();
  const result = await runCli(cacheDir, ['collection', 'not-a-collection']);
  expect(result.status).toBe(1);
  expect(result.stderr).toMatch(/is not a Gyazo collection ID or URL/);
});

test('collection rejects an image permalink', async () => {
  const cacheDir = createTempCacheDir();
  const result = await runCli(cacheDir, ['collection', `https://gyazo.com/${COLLECTION_ID}`]);
  expect(result.status).toBe(1);
  expect(result.stderr).toMatch(/is not a Gyazo collection ID or URL/);
});

// --- ordering ---------------------------------------------------------------

test('collection keeps the API order by default', async () => {
  const cacheDir = createTempCacheDir();
  await withStub(async (stub) => {
    const result = await runCli(cacheDir, ['collection', COLLECTION_ID], { webOrigin: stub.origin });
    expect(result.stdout).toContain('added first');
    const order = [...result.stdout.matchAll(/added (first|second|third)/g)].map((m) => m[1]);
    expect(order).toEqual(['first', 'second', 'third']);
  });
});

test('collection --sort created orders by upload time, newest first', async () => {
  const cacheDir = createTempCacheDir();
  await withStub(async (stub) => {
    const result = await runCli(cacheDir, ['collection', '--sort', 'created', COLLECTION_ID], {
      webOrigin: stub.origin,
    });
    expect(result.status).toBe(0);
    const order = [...result.stdout.matchAll(/added (first|second|third)/g)].map((m) => m[1]);
    expect(order).toEqual(['second', 'third', 'first']);
  });
});

test('collection --sort captured orders by capture time, newest first', async () => {
  const cacheDir = createTempCacheDir();
  await withStub(async (stub) => {
    const result = await runCli(cacheDir, ['collection', '--sort', 'captured', COLLECTION_ID], {
      webOrigin: stub.origin,
    });
    expect(result.status).toBe(0);
    const order = [...result.stdout.matchAll(/added (first|second|third)/g)].map((m) => m[1]);
    expect(order).toEqual(['third', 'first', 'second']);
  });
});

test('collection rejects an unknown --sort value', async () => {
  const cacheDir = createTempCacheDir();
  const result = await runCli(cacheDir, ['collection', '--sort', 'nonsense', COLLECTION_ID]);
  expect(result.status).toBe(1);
  expect(result.stderr).toMatch(/--sort must be one of added, created, captured/);
});

// --- authentication ---------------------------------------------------------

test('collection sends the access token when one is configured', async () => {
  const cacheDir = createTempCacheDir();
  await withStub(async (stub) => {
    await runCli(cacheDir, ['collection', COLLECTION_ID], { webOrigin: stub.origin });
    expect(stub.requests[0].authorization).toBe('Bearer test-token');
  });
});

test('collection --anonymous omits the access token even when one is configured', async () => {
  const cacheDir = createTempCacheDir();
  await withStub(async (stub) => {
    const result = await runCli(cacheDir, ['collection', '--anonymous', COLLECTION_ID], {
      webOrigin: stub.origin,
    });
    expect(result.status).toBe(0);
    expect(stub.requests[0].authorization).toBeUndefined();
  });
});

test('-A is short for --anonymous', async () => {
  const cacheDir = createTempCacheDir();
  await withStub(async (stub) => {
    const result = await runCli(cacheDir, ['collection', '-A', COLLECTION_ID], {
      webOrigin: stub.origin,
    });
    expect(result.status).toBe(0);
    expect(stub.requests[0].authorization).toBeUndefined();
  });
});

test('collection works with no token at all, anonymously', async () => {
  const cacheDir = createTempCacheDir();
  await withStub(async (stub) => {
    const result = await runCli(cacheDir, ['collection', COLLECTION_ID], {
      webOrigin: stub.origin,
      noToken: true,
    });
    expect(result.status).toBe(0);
    expect(stub.requests[0].authorization).toBeUndefined();
    expect(result.stdout).toContain('## Gyazo Collection');
  });
});

test('a command that needs a token still explains itself when there is none', async () => {
  const cacheDir = createTempCacheDir();
  const result = await runCli(cacheDir, ['list'], { noToken: true });
  expect(result.status).toBe(1);
  expect(result.stderr).toMatch(/Gyazo Access Token is not set/);
});

// --- failures ---------------------------------------------------------------

test('collection explains that a 404 may mean the collection is private', async () => {
  const cacheDir = createTempCacheDir();
  await withStub(
    async (stub) => {
      const result = await runCli(cacheDir, ['collection', COLLECTION_ID], {
        webOrigin: stub.origin,
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/not found or not public/i);
    },
    { errors: ['Page Not Found'] },
    404,
  );
});

test('collection --ids prints every image id, one per line, across pages', async () => {
  const cacheDir = createTempCacheDir();
  const total = 150;
  const all = Array.from({ length: total }, (_, i) => ({
    image_id: `aa${String(i).padStart(30, '0')}`,
    created_at: '2026-08-30T00:00:00.000Z',
    exif_captured_at: '2026-08-30T00:00:00.000Z',
  }));
  const stub = await startStubServer((req, res) => {
    const url = new URL(req.url || '', 'http://127.0.0.1');
    res.writeHead(200, { 'content-type': 'application/json' });
    if (url.pathname.endsWith('/images')) {
      const page = Number(url.searchParams.get('page') || '1');
      const per = Number(url.searchParams.get('per') || '100');
      res.end(JSON.stringify(all.slice((page - 1) * per, page * per)));
      return;
    }
    if (url.pathname.startsWith('/api/v2/collections/')) {
      res.end(JSON.stringify({ id: COLLECTION_ID, name: 'c', total_image_count: total }));
      return;
    }
    res.end(JSON.stringify({ id: COLLECTION_ID, images: [] }));
  });
  try {
    const result = await runCli(cacheDir, ['col', COLLECTION_ID, '--ids'], { apiOrigin: stub.origin });
    expect(result.status).toBe(0);
    const lines = result.stdout.split('\n').filter(Boolean);
    expect(lines).toHaveLength(total);
    expect(lines[0]).toBe(all[0].image_id);
    expect(lines[total - 1]).toBe(all[total - 1].image_id);
    // Nothing but ids: no markdown headings.
    expect(result.stdout).not.toMatch(/^#/m);
    // It walked two pages.
    const pages = stub.requests
      .filter((r) => r.url.includes('/images'))
      .map((r) => new URL(r.url, 'http://127.0.0.1').searchParams.get('page'));
    expect(pages).toEqual(['1', '2']);
  } finally {
    await stub.close();
  }
});

test('collection --ids feeds restore (bare ids are accepted)', async () => {
  const cacheDir = createTempCacheDir();
  const all = [{ image_id: 'aa'.padEnd(32, '0'), created_at: '2026-08-30T00:00:00.000Z' }];
  const stub = await startStubServer((req, res) => {
    const url = new URL(req.url || '', 'http://127.0.0.1');
    res.writeHead(200, { 'content-type': 'application/json' });
    if (url.pathname.endsWith('/images')) {
      const page = Number(url.searchParams.get('page') || '1');
      res.end(JSON.stringify(page === 1 ? all : []));
      return;
    }
    res.end(JSON.stringify({ id: COLLECTION_ID, total_image_count: 1 }));
  });
  try {
    const result = await runCli(cacheDir, ['col', COLLECTION_ID, '--ids'], { apiOrigin: stub.origin });
    const id = result.stdout.trim();
    // A bare id on its own line is what restore/touch accept via normalizeImageId.
    expect(id).toMatch(/^[0-9a-f]{32}$/);
  } finally {
    await stub.close();
  }
});

test('collection --ids falls back to the web endpoint when the API 403s', async () => {
  const cacheDir = createTempCacheDir();
  const webImages = Array.from({ length: 3 }, (_, i) => ({
    image_id: `bb${String(i).padStart(30, '0')}`,
    created_at: '2026-08-30T00:00:00.000Z',
  }));
  const stub = await startStubServer((req, res) => {
    const url = new URL(req.url || '', 'http://127.0.0.1');
    // The API path is forbidden right now.
    if (url.pathname.startsWith('/api/v2/collections/')) {
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end('{"message":"forbidden"}');
      return;
    }
    // The public web endpoint still answers.
    if (url.pathname === `/collections/${COLLECTION_ID}.json`) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: COLLECTION_ID, total_image_count: 3, images: webImages }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{}');
  });
  try {
    const result = await runCli(cacheDir, ['col', COLLECTION_ID, '--ids'], {
      apiOrigin: stub.origin,
      webOrigin: stub.origin,
    });
    expect(result.status).toBe(0);
    const lines = result.stdout.split('\n').filter(Boolean);
    expect(lines).toEqual(webImages.map((i) => i.image_id));
    // It did not loop the web endpoint, which cannot page.
    const webHits = stub.requests.filter((r) => r.url.includes(`/collections/${COLLECTION_ID}.json`));
    expect(webHits.length).toBe(1);
  } finally {
    await stub.close();
  }
});

test('collection --ids recovers ids blanked by Gyazo from alias_id', async () => {
  const cacheDir = createTempCacheDir();
  const hashes = ['6b2133144b33ef01d3941f82b33f22de', 'a3d5cf69033fe108c74c059ad7a83f2f'];
  const alias = (h: string) => {
    const header = Buffer.from(JSON.stringify({ alg: 'HS256' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ img: `_${h}` })).toString('base64url');
    return `${header}.${payload}.sig`;
  };
  const webImages = hashes.map((h) => ({
    image_id: '',
    permalink_url: null,
    url: null,
    alias_id: alias(h),
    created_at: '2026-08-30T00:00:00.000Z',
  }));
  const stub = await startStubServer((req, res) => {
    const url = new URL(req.url || '', 'http://127.0.0.1');
    if (url.pathname.startsWith('/api/v2/collections/')) {
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end('{"message":"forbidden"}');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: COLLECTION_ID, total_image_count: 2, images: webImages }));
  });
  try {
    const result = await runCli(cacheDir, ['col', COLLECTION_ID, '--ids'], {
      apiOrigin: stub.origin,
      webOrigin: stub.origin,
    });
    expect(result.status).toBe(0);
    const lines = result.stdout.split('\n').filter(Boolean);
    expect(lines).toEqual(hashes);
  } finally {
    await stub.close();
  }
});
