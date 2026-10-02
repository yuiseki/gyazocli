import { test, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createTempCacheDir, runCli, writeImageCache } from './helpers';

function markerDir(cacheDir: string, id: string): string {
  return path.join(cacheDir, 'images', id[0], id[1]);
}

test('sync --gen-marker builds month and size markers, idempotently', async () => {
  const cacheDir = createTempCacheDir();
  const a = 'aa'.padEnd(32, '0');
  const b = 'bb'.padEnd(32, '0');
  writeImageCache(cacheDir, a, { image_id: a, created_at: '2020-07-01T00:00:00.000Z', file_size: 1000 });
  writeImageCache(cacheDir, b, { image_id: b, created_at: '2024-01-02T00:00:00.000Z' }); // no size

  const first = await runCli(cacheDir, ['sync', '--gen-marker']);
  expect(first.status).toBe(0);
  expect(first.stdout).toMatch(/2 month markers and 1 size markers written/);

  // The markers are on disk, named with the date and the bytes.
  expect(fs.existsSync(path.join(markerDir(cacheDir, a), `${a}.m.2020-07`))).toBe(true);
  expect(fs.existsSync(path.join(markerDir(cacheDir, a), `${a}.s.1000`))).toBe(true);
  expect(fs.existsSync(path.join(markerDir(cacheDir, b), `${b}.m.2024-01`))).toBe(true);
  expect(fs.existsSync(path.join(markerDir(cacheDir, b), `${b}.s.0`))).toBe(false); // no size marker

  // Idempotent: a second run writes nothing.
  const second = await runCli(cacheDir, ['sync', '--gen-marker']);
  expect(second.stdout).toMatch(/0 month markers and 0 size markers written/);
});

test('stats size uses the markers (no slow-path note) and totals correctly', async () => {
  const cacheDir = createTempCacheDir();
  writeImageCache(cacheDir, 'aa'.padEnd(32, '0'), { image_id: 'aa'.padEnd(32, '0'), created_at: '2020-07-01T00:00:00.000Z', file_size: 1000 });
  writeImageCache(cacheDir, 'bb'.padEnd(32, '0'), { image_id: 'bb'.padEnd(32, '0'), created_at: '2020-07-01T00:00:00.000Z', file_size: 2048 });
  writeImageCache(cacheDir, 'cc'.padEnd(32, '0'), { image_id: 'cc'.padEnd(32, '0'), created_at: '2020-07-01T00:00:00.000Z' });

  await runCli(cacheDir, ['sync', '--gen-marker']);
  const result = await runCli(cacheDir, ['stats', 'size']);
  expect(result.status).toBe(0);
  expect(result.stderr).not.toMatch(/markers missing/);
  expect(result.stdout).toMatch(/\(3,048 bytes\)/);
  expect(result.stdout).toMatch(/Known for 2 of 3 cached images/);
});

test('stats size falls back to reading records when markers are missing', async () => {
  const cacheDir = createTempCacheDir();
  writeImageCache(cacheDir, 'aa'.padEnd(32, '0'), { image_id: 'aa'.padEnd(32, '0'), created_at: '2020-07-01T00:00:00.000Z', file_size: 1000 });
  // No gen-marker run: markers absent.
  const result = await runCli(cacheDir, ['stats', 'size']);
  expect(result.status).toBe(0);
  expect(result.stderr).toMatch(/markers missing/);
  expect(result.stdout).toMatch(/\(1,000 bytes\)/);
});
