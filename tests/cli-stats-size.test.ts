import { test, expect } from 'vitest';
import { createTempCacheDir, runCli, writeImageCache } from './helpers';

test('stats size sums the file_size stored in the cache and reports coverage', async () => {
  const cacheDir = createTempCacheDir();
  writeImageCache(cacheDir, 'aa'.padEnd(32, '0'), { image_id: 'aa'.padEnd(32, '0'), file_size: 1000 });
  writeImageCache(cacheDir, 'bb'.padEnd(32, '0'), { image_id: 'bb'.padEnd(32, '0'), file_size: 2048 });
  writeImageCache(cacheDir, 'cc'.padEnd(32, '0'), { image_id: 'cc'.padEnd(32, '0') }); // no size

  const result = await runCli(cacheDir, ['stats', 'size']);
  expect(result.status).toBe(0);
  // 3048 bytes = 2.98 KB.
  expect(result.stdout).toMatch(/Total size: .*\(3,048 bytes\)/);
  expect(result.stdout).toMatch(/Known for 2 of 3 cached images \(67%\)/);
  expect(result.stdout).toMatch(/gyazo sync --web/);
});

test('stats size on an empty cache reports zero', async () => {
  const cacheDir = createTempCacheDir();
  const result = await runCli(cacheDir, ['stats', 'size']);
  expect(result.status).toBe(0);
  expect(result.stdout).toMatch(/Total size: 0 B \(0 bytes\)/);
  expect(result.stdout).toMatch(/Known for 0 of 0 cached images/);
});

test('stats size says nothing more once every image has a size', async () => {
  const cacheDir = createTempCacheDir();
  writeImageCache(cacheDir, 'aa'.padEnd(32, '0'), { image_id: 'aa'.padEnd(32, '0'), file_size: 500 });
  const result = await runCli(cacheDir, ['stats', 'size']);
  expect(result.status).toBe(0);
  expect(result.stdout).toMatch(/Known for 1 of 1 cached images \(100%\)/);
  expect(result.stdout).not.toMatch(/gyazo sync --web/);
});
