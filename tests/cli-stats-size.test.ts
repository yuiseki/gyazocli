import { test, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createTempCacheDir, runCli, startStubServer, writeImageCache } from './helpers';

test('stats size sums the file_size already stored in the cache', async () => {
  const cacheDir = createTempCacheDir();
  writeImageCache(cacheDir, 'aa'.padEnd(32, '0'), { image_id: 'aa'.padEnd(32, '0'), file_size: 1000 });
  writeImageCache(cacheDir, 'bb'.padEnd(32, '0'), { image_id: 'bb'.padEnd(32, '0'), file_size: 2048 });
  writeImageCache(cacheDir, 'cc'.padEnd(32, '0'), { image_id: 'cc'.padEnd(32, '0') }); // no size

  const result = await runCli(cacheDir, ['stats', 'size', '--json']);
  expect(result.status).toBe(0);
  const parsed = JSON.parse(result.stdout);
  expect(parsed.images).toBe(3);
  expect(parsed.withSize).toBe(2);
  expect(parsed.totalBytes).toBe(3048);
});

test('stats size does NOT estimate from the biased stored sizes', async () => {
  // The cache is full of sizes but none came from a random draw, so plain
  // stats size must refuse to estimate (the stored pile is a biased sample).
  const cacheDir = createTempCacheDir();
  for (let i = 0; i < 4; i++) {
    const id = i.toString(16).padStart(32, '0');
    writeImageCache(cacheDir, id, { image_id: id, file_size: 1000 });
  }
  const bare = 'f'.padStart(32, '0');
  writeImageCache(cacheDir, bare, { image_id: bare });

  const text = await runCli(cacheDir, ['stats', 'size']);
  expect(text.status).toBe(0);
  expect(text.stdout).not.toMatch(/Estimated total:/);
  expect(text.stdout).toMatch(/--random/); // points the user at the unbiased path

  const json = await runCli(cacheDir, ['stats', 'size', '--json']);
  expect(JSON.parse(json.stdout).estimate).toBeUndefined();
});

test('once a random sample exists, plain stats size estimates from it', async () => {
  const cacheDir = createTempCacheDir();
  // A biased pile of large sizes, plus more unsized images than the draw size,
  // so the cache stays incomplete and an estimate is due.
  for (let i = 0; i < 6; i++) {
    const id = `ba${i}`.padEnd(32, '0');
    writeImageCache(cacheDir, id, { image_id: id, file_size: 9_000_000 }); // huge, biased
  }
  for (let i = 0; i < 14; i++) {
    const id = i.toString(16).padStart(32, '0'); // unique, unsized
    writeImageCache(cacheDir, id, { image_id: id });
  }
  // Build a random-sample ledger via --random against a stub that returns a
  // small, representative size.
  const stub = await startStubServer((req, res) => {
    const url = new URL(req.url || '', 'http://127.0.0.1');
    const m = url.pathname.match(/^\/([0-9a-f]{32})\.json$/);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(m ? { image_id: m[1], file_size: 1000 } : {}));
  });
  try {
    // Sample every image at random; stored ones reuse their size, unsized fetch 1000.
    await runCli(cacheDir, ['stats', 'size', '--fetch', '--random', '--max', '10'], { webOrigin: stub.origin });
    const json = await runCli(cacheDir, ['stats', 'size', '--json']);
    const parsed = JSON.parse(json.stdout);
    // The estimate is from the random ledger (10 ids), NOT the biased sum.
    expect(parsed.estimate).toBeDefined();
    expect(parsed.estimate.sampleN).toBe(10);
    expect(parsed.estimate.populationN).toBe(20);
  } finally {
    await stub.close();
  }
});

test('stats size gives no estimate once every image has a known size', async () => {
  const cacheDir = createTempCacheDir();
  for (let i = 0; i < 3; i++) {
    const id = i.toString(16).padStart(32, '0');
    writeImageCache(cacheDir, id, { image_id: id, file_size: 500 });
  }
  const json = await runCli(cacheDir, ['stats', 'size', '--json']);
  const parsed = JSON.parse(json.stdout);
  expect(parsed.estimate).toBeUndefined(); // the sum is the answer, not an estimate
  const text = await runCli(cacheDir, ['stats', 'size']);
  expect(text.stdout).not.toMatch(/Estimated total:/);
});

test('stats size --fetch backfills missing sizes from the web per-image JSON', async () => {
  const cacheDir = createTempCacheDir();
  const sizes: Record<string, number> = {
    ['a1'.padEnd(32, '0')]: 100,
    ['b2'.padEnd(32, '0')]: 250,
  };
  for (const id of Object.keys(sizes)) writeImageCache(cacheDir, id, { image_id: id });
  // One already has its size; it must not be re-fetched.
  const already = 'c3'.padEnd(32, '0');
  writeImageCache(cacheDir, already, { image_id: already, file_size: 50 });

  const hits: string[] = [];
  const stub = await startStubServer((req, res) => {
    const url = new URL(req.url || '', 'http://127.0.0.1');
    const m = url.pathname.match(/^\/([0-9a-f]{32})\.json$/);
    if (m) {
      hits.push(m[1]);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ image_id: m[1], file_size: sizes[m[1]] }));
      return;
    }
    res.writeHead(404); res.end('{}');
  });
  try {
    const result = await runCli(cacheDir, ['stats', 'size', '--fetch', '--json'], {
      webOrigin: stub.origin,
    });
    expect(result.status).toBe(0);
    // Only the two missing ones were fetched, not the one already sized.
    expect(hits.sort()).toEqual(Object.keys(sizes).sort());
    const parsed = JSON.parse(result.stdout);
    expect(parsed.withSize).toBe(3);
    expect(parsed.totalBytes).toBe(400); // 100 + 250 + 50

    // The sizes were persisted into the cache, so a second run needs no fetch.
    const stored = JSON.parse(
      fs.readFileSync(path.join(cacheDir, 'images', 'a', '1', `${'a1'.padEnd(32, '0')}.json`), 'utf8'),
    );
    expect(stored.file_size).toBe(100);
  } finally {
    await stub.close();
  }
});

test('stats size --fetch does not store a null file_size (withheld without cookies)', async () => {
  const cacheDir = createTempCacheDir();
  const id = 'e4'.padEnd(32, '0');
  writeImageCache(cacheDir, id, { image_id: id });
  const stub = await startStubServer((req, res) => {
    // A withheld image fetched without cookies comes back with file_size null.
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ image_id: id, file_size: null }));
  });
  try {
    const result = await runCli(cacheDir, ['stats', 'size', '--fetch', '--json'], {
      webOrigin: stub.origin,
    });
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.withSize).toBe(0);
    expect(parsed.totalBytes).toBe(0);
    // It warns that no cookies were found, since withheld images need them.
    expect(result.stderr).toMatch(/cookie/i);
  } finally {
    await stub.close();
  }
});

test('stats size --fetch --random samples and estimates the population total', async () => {
  const cacheDir = createTempCacheDir();
  const population = 40;
  for (let i = 0; i < population; i++) {
    const id = i.toString(16).padStart(32, '0'); // unique, zero-padded 32-hex
    writeImageCache(cacheDir, id, { image_id: id });
  }
  const hits: string[] = [];
  const stub = await startStubServer((req, res) => {
    const url = new URL(req.url || '', 'http://127.0.0.1');
    const m = url.pathname.match(/^\/([0-9a-f]{32})\.json$/);
    if (m) {
      hits.push(m[1]);
      res.writeHead(200, { 'content-type': 'application/json' });
      // Constant size: mean=1000, stdev=0, so the estimate is exact.
      res.end(JSON.stringify({ image_id: m[1], file_size: 1000 }));
      return;
    }
    res.writeHead(404); res.end('{}');
  });
  try {
    const result = await runCli(cacheDir, ['stats', 'size', '--fetch', '--random', '--max', '10', '--json'], {
      webOrigin: stub.origin,
    });
    expect(result.status).toBe(0);
    expect(hits.length).toBe(10); // sampled exactly max
    const est = JSON.parse(result.stdout);
    expect(est.sampleN).toBe(10);
    expect(est.populationN).toBe(population);
    expect(est.meanBytes).toBe(1000);
    expect(est.estimateBytes).toBe(population * 1000); // 40000
    // With zero variance the interval collapses to the point estimate.
    expect(est.relativeMarginPct).toBe(0);
    expect(est.ci95).toEqual([population * 1000, population * 1000]);
  } finally {
    await stub.close();
  }
});

test('stats size --random works without --fetch and grows the ledger', async () => {
  const cacheDir = createTempCacheDir();
  for (let i = 0; i < 30; i++) {
    const id = i.toString(16).padStart(32, '0');
    writeImageCache(cacheDir, id, { image_id: id });
  }
  const hits: string[] = [];
  const stub = await startStubServer((req, res) => {
    const url = new URL(req.url || '', 'http://127.0.0.1');
    const m = url.pathname.match(/^\/([0-9a-f]{32})\.json$/);
    res.writeHead(200, { 'content-type': 'application/json' });
    if (m) { hits.push(m[1]); res.end(JSON.stringify({ image_id: m[1], file_size: 1000 })); return; }
    res.end('{}');
  });
  try {
    // First draw of 5 (no --fetch flag).
    const first = await runCli(cacheDir, ['stats', 'size', '--random', '--max', '5', '--json'], { webOrigin: stub.origin });
    expect(first.status).toBe(0);
    expect(hits.length).toBe(5);
    expect(JSON.parse(first.stdout).sampleN).toBe(5);

    // A second draw of 10 grows the ledger (not resets it).
    const second = await runCli(cacheDir, ['stats', 'size', '--random', '--max', '10', '--json'], { webOrigin: stub.origin });
    expect(JSON.parse(second.stdout).sampleN).toBeGreaterThanOrEqual(10);
  } finally {
    await stub.close();
  }
});

test('stats size --fetch --max caps how many it fetches', async () => {
  const cacheDir = createTempCacheDir();
  for (let i = 0; i < 5; i++) {
    const id = `d${i}`.padEnd(32, '0');
    writeImageCache(cacheDir, id, { image_id: id });
  }
  const hits: string[] = [];
  const stub = await startStubServer((req, res) => {
    const url = new URL(req.url || '', 'http://127.0.0.1');
    const m = url.pathname.match(/^\/([0-9a-f]{32})\.json$/);
    if (m) {
      hits.push(m[1]);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ image_id: m[1], file_size: 10 }));
      return;
    }
    res.writeHead(404); res.end('{}');
  });
  try {
    const result = await runCli(cacheDir, ['stats', 'size', '--fetch', '--max', '2'], {
      webOrigin: stub.origin,
    });
    expect(result.status).toBe(0);
    expect(hits.length).toBe(2);
  } finally {
    await stub.close();
  }
});
