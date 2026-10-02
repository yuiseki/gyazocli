import { test, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createTempCacheDir, runCli, startStubServer, writeImageCache } from './helpers';

function cookieFile(dir: string): string {
  const file = path.join(dir, 'cookie.json');
  fs.writeFileSync(file, JSON.stringify([{ name: 'Gyazo_session', value: 's', domain: '.gyazo.com' }]));
  return file;
}

function summaryStub() {
  return startStubServer((req, res) => {
    const url = new URL(req.url || '', 'http://127.0.0.1');
    if (url.pathname === '/api/internal/images_summary') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ monthly_counts: { '2020': { '7': 10, '8': 5 }, '2024': { '1': 1 } }, daily_counts: {} }));
      return;
    }
    res.writeHead(404); res.end('{}');
  });
}

test('coverage compares the true counts to the cache by year', async () => {
  const cacheDir = createTempCacheDir();
  writeImageCache(cacheDir, 'a'.padEnd(32, '0'), { image_id: 'a'.padEnd(32, '0'), created_at: '2020-07-01T00:00:00.000Z', file_size: 1000 });
  writeImageCache(cacheDir, 'b'.padEnd(32, '0'), { image_id: 'b'.padEnd(32, '0'), created_at: '2020-08-01T00:00:00.000Z' });
  writeImageCache(cacheDir, 'c'.padEnd(32, '0'), { image_id: 'c'.padEnd(32, '0'), created_at: '2024-01-01T00:00:00.000Z', file_size: 2000 });

  const stub = await summaryStub();
  try {
    const result = await runCli(cacheDir, ['coverage', '--json'], { webOrigin: stub.origin, cookieFile: cookieFile(cacheDir) });
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.trueTotal).toBe(16);
    expect(parsed.cachedTotal).toBe(3);
    expect(parsed.sizedTotal).toBe(2);
    expect(parsed.missing).toBe(13);
    const y2020 = parsed.rows.find((r: any) => r.key === '2020');
    expect(y2020).toEqual({ key: '2020', true: 15, cached: 2, missing: 13, withSize: 1, sizeMissing: 14 });
  } finally {
    await stub.close();
  }
});

test('coverage --month breaks it down by month', async () => {
  const cacheDir = createTempCacheDir();
  writeImageCache(cacheDir, 'a'.padEnd(32, '0'), { image_id: 'a'.padEnd(32, '0'), created_at: '2020-07-01T00:00:00.000Z' });
  const stub = await summaryStub();
  try {
    const result = await runCli(cacheDir, ['coverage', '--month', '--json'], { webOrigin: stub.origin, cookieFile: cookieFile(cacheDir) });
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    const keys = parsed.rows.map((r: any) => r.key);
    expect(keys).toEqual(['2020-07', '2020-08', '2024-01']);
    const jul = parsed.rows.find((r: any) => r.key === '2020-07');
    expect(jul).toEqual({ key: '2020-07', true: 10, cached: 1, missing: 9, withSize: 0, sizeMissing: 10 });
    const aug = parsed.rows.find((r: any) => r.key === '2020-08');
    expect(aug.cached).toBe(0); // the un-fetched month stands out
    expect(aug.missing).toBe(5);
  } finally {
    await stub.close();
  }
});

test('coverage --year narrows to that year and breaks it down by month', async () => {
  const cacheDir = createTempCacheDir();
  writeImageCache(cacheDir, 'a'.padEnd(32, '0'), { image_id: 'a'.padEnd(32, '0'), created_at: '2020-07-01T00:00:00.000Z' });
  const stub = await summaryStub();
  try {
    const result = await runCli(cacheDir, ['coverage', '--year', '2020', '--json'], { webOrigin: stub.origin, cookieFile: cookieFile(cacheDir) });
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    const keys = parsed.rows.map((r: any) => r.key);
    expect(keys).toEqual(['2020-07', '2020-08']); // only 2020, by month; 2024 excluded
    expect(parsed.trueTotal).toBe(15); // only 2020 counts toward the totals
  } finally {
    await stub.close();
  }
});

test('coverage --month --incomplete hides fully-cached months', async () => {
  const cacheDir = createTempCacheDir();
  // 2024-01 fully cached (true 1, cached 1); 2020 months not.
  writeImageCache(cacheDir, 'c'.padEnd(32, '0'), { image_id: 'c'.padEnd(32, '0'), created_at: '2024-01-01T00:00:00.000Z' });
  const stub = await summaryStub();
  try {
    const result = await runCli(cacheDir, ['coverage', '--month', '--incomplete', '--json'], { webOrigin: stub.origin, cookieFile: cookieFile(cacheDir) });
    const parsed = JSON.parse(result.stdout);
    const keys = parsed.rows.map((r: any) => r.key);
    expect(keys).toEqual(['2020-07', '2020-08']); // 2024-01 is complete, dropped
  } finally {
    await stub.close();
  }
});

test('coverage without cookies refuses', async () => {
  const cacheDir = createTempCacheDir();
  const result = await runCli(cacheDir, ['coverage'], { cookieFile: path.join(cacheDir, 'absent.json') });
  expect(result.status).toBe(1);
  expect(result.stderr).toMatch(/cookie/i);
});
