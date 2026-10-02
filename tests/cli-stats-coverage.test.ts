import { test, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createTempCacheDir, runCli, startStubServer, writeImageCache } from './helpers';

function cookieFile(dir: string): string {
  const file = path.join(dir, 'cookie.json');
  fs.writeFileSync(file, JSON.stringify([{ name: 'Gyazo_session', value: 's', domain: '.gyazo.com' }]));
  return file;
}

test('stats coverage compares the true counts to the cache by year', async () => {
  const cacheDir = createTempCacheDir();
  // Cache: 2 images in 2020, 1 in 2024.
  writeImageCache(cacheDir, 'a'.padEnd(32, '0'), { image_id: 'a'.padEnd(32, '0'), created_at: '2020-07-01T00:00:00.000Z' });
  writeImageCache(cacheDir, 'b'.padEnd(32, '0'), { image_id: 'b'.padEnd(32, '0'), created_at: '2020-08-01T00:00:00.000Z' });
  writeImageCache(cacheDir, 'c'.padEnd(32, '0'), { image_id: 'c'.padEnd(32, '0'), created_at: '2024-01-01T00:00:00.000Z' });

  const stub = await startStubServer((req, res) => {
    const url = new URL(req.url || '', 'http://127.0.0.1');
    if (url.pathname === '/api/internal/images_summary') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ monthly_counts: { '2020': { '7': 10, '8': 5 }, '2024': { '1': 1 } }, daily_counts: {} }));
      return;
    }
    res.writeHead(404); res.end('{}');
  });
  try {
    const result = await runCli(cacheDir, ['stats', 'coverage', '--json'], {
      webOrigin: stub.origin,
      cookieFile: cookieFile(cacheDir),
    });
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.trueTotal).toBe(16); // 10 + 5 + 1
    expect(parsed.cachedTotal).toBe(3);
    expect(parsed.missing).toBe(13);
    const y2020 = parsed.years.find((r: any) => r.year === '2020');
    expect(y2020).toEqual({ year: '2020', true: 15, cached: 2, missing: 13 });
    const y2024 = parsed.years.find((r: any) => r.year === '2024');
    expect(y2024).toEqual({ year: '2024', true: 1, cached: 1, missing: 0 });
  } finally {
    await stub.close();
  }
});

test('stats coverage without cookies refuses', async () => {
  const cacheDir = createTempCacheDir();
  const result = await runCli(cacheDir, ['stats', 'coverage'], {
    cookieFile: path.join(cacheDir, 'absent.json'),
  });
  expect(result.status).toBe(1);
  expect(result.stderr).toMatch(/cookie/i);
});
