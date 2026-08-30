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
