import { test, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createTempCacheDir, runCli, writeImageCache } from './helpers';

test('stats cached counts the image cache', async () => {
  const cacheDir = createTempCacheDir();
  // Spread across prefix dirs the way the real cache is laid out.
  const ids = ['aa', 'ab', 'b0', 'c9'].map((p) => p.padEnd(32, '0'));
  for (const id of ids) writeImageCache(cacheDir, id, { image_id: id });

  const result = await runCli(cacheDir, ['stats', 'cached']);
  expect(result.status).toBe(0);
  expect(result.stdout).toMatch(/Cached images:\s+4\b/);
});

test('stats cached reports zero on an empty cache and as JSON', async () => {
  const cacheDir = createTempCacheDir();
  const result = await runCli(cacheDir, ['stats', 'cached', '--json']);
  expect(result.status).toBe(0);
  const parsed = JSON.parse(result.stdout);
  expect(parsed.images).toBe(0);
  expect(parsed.searchImages).toBe(0);
  expect(parsed.cacheDir).toBe(cacheDir);
});

test('stats cached counts search-only and hourly caches separately', async () => {
  const cacheDir = createTempCacheDir();
  const img = 'aa'.padEnd(32, '0');
  writeImageCache(cacheDir, img, { image_id: img });

  const sdir = path.join(cacheDir, 'search_images', 'd', 'e');
  fs.mkdirSync(sdir, { recursive: true });
  fs.writeFileSync(path.join(sdir, `${'de'.padEnd(32, '0')}.json`), '{}');

  const hdir = path.join(cacheDir, 'hourly', '2019', '06', '21');
  fs.mkdirSync(hdir, { recursive: true });
  fs.writeFileSync(path.join(hdir, '10.json'), '[]');

  const result = await runCli(cacheDir, ['stats', 'cached', '--json']);
  const parsed = JSON.parse(result.stdout);
  expect(parsed.images).toBe(1);
  expect(parsed.searchImages).toBe(1);
  expect(parsed.hourlyFiles).toBe(1);
});
