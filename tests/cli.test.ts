import { test, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';

const REPO_ROOT = process.cwd();
const CLI_PATH = path.join(REPO_ROOT, 'dist', 'index.js');

function ymdPartsFromDate(date: Date): { year: string; month: string; day: string } {
  return {
    year: String(date.getFullYear()),
    month: String(date.getMonth() + 1).padStart(2, '0'),
    day: String(date.getDate()).padStart(2, '0'),
  };
}

function ymdFromDate(date: Date): string {
  const parts = ymdPartsFromDate(date);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function getDefaultWeeklyRangeLabels(): {
  start: Date;
  end: Date;
  startLabel: string;
  endLabel: string;
} {
  const today = new Date();
  const end = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1, 23, 59, 59, 999);
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 8, 0, 0, 0, 0);
  return {
    start,
    end,
    startLabel: ymdFromDate(start),
    endLabel: ymdFromDate(end),
  };
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function createTempCacheDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gyazocli-test-'));
}

function writeHourlyIndex(
  cacheDir: string,
  year: string,
  month: string,
  day: string,
  hour: string,
  imageIds: string[],
): void {
  const dir = path.join(cacheDir, 'hourly', year, month, day);
  ensureDir(dir);
  fs.writeFileSync(path.join(dir, `${hour}.json`), JSON.stringify(imageIds, null, 2), 'utf8');
}

function writeHourlyMeta(
  cacheDir: string,
  kind: 'apps' | 'domains' | 'tags' | 'locations',
  year: string,
  month: string,
  day: string,
  hour: string,
  valuesByImageId: Record<string, string[]>,
): void {
  const dir = path.join(cacheDir, 'hourly', year, month, day);
  ensureDir(dir);
  fs.writeFileSync(path.join(dir, `${hour}-${kind}.json`), JSON.stringify(valuesByImageId, null, 2), 'utf8');
}

function writeImageCache(cacheDir: string, imageId: string, image: unknown): void {
  const p1 = imageId[0] || '_';
  const p2 = imageId[1] || '_';
  const dir = path.join(cacheDir, 'images', p1, p2);
  ensureDir(dir);
  fs.writeFileSync(path.join(dir, `${imageId}.json`), JSON.stringify(image, null, 2), 'utf8');
}

function writeSearchImageCache(cacheDir: string, imageId: string, image: unknown): void {
  const p1 = imageId[0] || '_';
  const p2 = imageId[1] || '_';
  const dir = path.join(cacheDir, 'search_images', p1, p2);
  ensureDir(dir);
  fs.writeFileSync(path.join(dir, `${imageId}.json`), JSON.stringify(image, null, 2), 'utf8');
}

function readImageCache(cacheDir: string, imageId: string): any {
  const p1 = imageId[0] || '_';
  const p2 = imageId[1] || '_';
  const filePath = path.join(cacheDir, 'images', p1, p2, `${imageId}.json`);
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function runCli(
  cacheDir: string,
  args: string[],
  options: { input?: string | Buffer } = {},
): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [CLI_PATH, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      GYAZO_ACCESS_TOKEN: 'test-token',
      GYAZO_CACHE_DIR: cacheDir,
    },
    input: options.input,
  });
}

test('apps default range is from 8 days ago to yesterday', () => {
  const cacheDir = createTempCacheDir();
  const range = getDefaultWeeklyRangeLabels();
  const parts = ymdPartsFromDate(range.end);

  writeHourlyIndex(cacheDir, parts.year, parts.month, parts.day, '10', ['ab000000000000000000000000000001']);
  writeHourlyMeta(
    cacheDir,
    'apps',
    parts.year,
    parts.month,
    parts.day,
    '10',
    { ab000000000000000000000000000001: ['Chrome'] },
  );

  const result = runCli(cacheDir, ['apps', '--limit', '3']);
  expect(result.status).toBe(0);
  expect(result.stdout).toMatch(new RegExp(`Apps on ${range.startLabel}\\.\\.${range.endLabel}`));
  expect(result.stdout).toMatch(/1\. Chrome: 1/);
});

test('apps rejects --today with --date', () => {
  const cacheDir = createTempCacheDir();
  const result = runCli(cacheDir, ['apps', '--today', '--date', '2026-02-20']);
  expect(result.status).toBe(1);
  expect(result.stderr).toMatch(/--today and --date cannot be used together/);
});

test('domains ranking is built from hourly metadata cache', () => {
  const cacheDir = createTempCacheDir();

  writeHourlyIndex(cacheDir, '2026', '01', '15', '08', [
    'cd000000000000000000000000000001',
    'cd000000000000000000000000000002',
  ]);
  writeHourlyMeta(cacheDir, 'domains', '2026', '01', '15', '08', {
    cd000000000000000000000000000001: ['x.com'],
    cd000000000000000000000000000002: ['example.com'],
  });

  writeHourlyIndex(cacheDir, '2026', '01', '16', '09', ['cd000000000000000000000000000003']);
  writeHourlyMeta(cacheDir, 'domains', '2026', '01', '16', '09', {
    cd000000000000000000000000000003: ['x.com'],
  });

  const result = runCli(cacheDir, ['domains', '--date', '2026-01', '--limit', '2']);
  expect(result.status).toBe(0);
  expect(result.stdout).toMatch(/Domains on 2026-01/);
  expect(result.stdout).toMatch(/1\. x\.com: 2/);
  expect(result.stdout).toMatch(/2\. example\.com: 1/);
});

test('locations ranking is built from hourly metadata cache', () => {
  const cacheDir = createTempCacheDir();

  writeHourlyIndex(cacheDir, '2026', '01', '15', '08', [
    'lc000000000000000000000000000001',
    'lc000000000000000000000000000002',
  ]);
  writeHourlyMeta(cacheDir, 'locations', '2026', '01', '15', '08', {
    lc000000000000000000000000000001: ['東京都台東区竜泉'],
    lc000000000000000000000000000002: ['東京都台東区竜泉'],
  });

  writeHourlyIndex(cacheDir, '2026', '01', '16', '09', ['lc000000000000000000000000000003']);
  writeHourlyMeta(cacheDir, 'locations', '2026', '01', '16', '09', {
    lc000000000000000000000000000003: ['東京都千代田区丸の内'],
  });

  const result = runCli(cacheDir, ['locations', '--date', '2026-01', '--limit', '2']);
  expect(result.status).toBe(0);
  expect(result.stdout).toMatch(/Locations on 2026-01/);
  expect(result.stdout).toMatch(/1\. 東京都台東区竜泉: 2/);
  expect(result.stdout).toMatch(/2\. 東京都千代田区丸の内: 1/);
});

test('tags can build hourly tags cache from image cache when missing', () => {
  const cacheDir = createTempCacheDir();
  const imageId1 = 'ef000000000000000000000000000001';
  const imageId2 = 'ef000000000000000000000000000002';

  writeHourlyIndex(cacheDir, '2026', '02', '18', '09', [imageId1, imageId2]);

  writeImageCache(cacheDir, imageId1, {
    image_id: imageId1,
    created_at: '2026-02-18T09:10:00+09:00',
    metadata: { links: ['#alpha', 'Alpha', 'beta'] },
  });
  writeImageCache(cacheDir, imageId2, {
    image_id: imageId2,
    created_at: '2026-02-18T09:20:00+09:00',
    metadata: { links: ['beta'] },
  });

  const result = runCli(cacheDir, ['tags', '--date', '2026-02-18', '--limit', '5']);
  expect(result.status).toBe(0);
  expect(result.stdout).toMatch(/Tags on 2026-02-18/);
  expect(result.stdout).toMatch(/#beta: 2/);
  expect(result.stdout).toMatch(/#alpha: 1/);

  const builtPath = path.join(cacheDir, 'hourly', '2026', '02', '18', '09-tags.json');
  expect(fs.existsSync(builtPath)).toBe(true);
});

test('locations can build hourly locations cache from image cache when missing', () => {
  const cacheDir = createTempCacheDir();
  const imageId1 = 'lo000000000000000000000000000001';
  const imageId2 = 'lo000000000000000000000000000002';

  writeHourlyIndex(cacheDir, '2026', '02', '18', '09', [imageId1, imageId2]);

  writeImageCache(cacheDir, imageId1, {
    image_id: imageId1,
    created_at: '2026-02-18T09:10:00+09:00',
    metadata: {
      exif_address: {
        ja: {
          address_components: [
            { long_name: '東京都', types: ['administrative_area_level_1'] },
            { long_name: '台東区', types: ['locality'] },
            { long_name: '竜泉', types: ['sublocality_level_1'] },
          ],
        },
      },
    },
  });
  writeImageCache(cacheDir, imageId2, {
    image_id: imageId2,
    created_at: '2026-02-18T09:20:00+09:00',
    metadata: {
      exif_address: '東京都台東区竜泉',
    },
  });

  const result = runCli(cacheDir, ['locations', '--date', '2026-02-18', '--limit', '5']);
  expect(result.status).toBe(0);
  expect(result.stdout).toMatch(/Locations on 2026-02-18/);
  expect(result.stdout).toMatch(/東京都台東区竜泉: 2/);

  const builtPath = path.join(cacheDir, 'hourly', '2026', '02', '18', '09-locations.json');
  expect(fs.existsSync(builtPath)).toBe(true);
});

test('stats outputs markdown sections for weekly summary', () => {
  const cacheDir = createTempCacheDir();

  writeHourlyIndex(cacheDir, '2026', '02', '19', '09', ['gh000000000000000000000000000001']);
  writeHourlyMeta(cacheDir, 'apps', '2026', '02', '19', '09', {
    gh000000000000000000000000000001: ['Chrome'],
  });
  writeHourlyMeta(cacheDir, 'domains', '2026', '02', '19', '09', {
    gh000000000000000000000000000001: ['x.com'],
  });
  writeHourlyMeta(cacheDir, 'tags', '2026', '02', '19', '09', {
    gh000000000000000000000000000001: ['tag1'],
  });

  writeHourlyIndex(cacheDir, '2026', '02', '20', '21', ['gh000000000000000000000000000002']);
  writeHourlyMeta(cacheDir, 'apps', '2026', '02', '20', '21', {
    gh000000000000000000000000000002: ['Brave Browser'],
  });
  writeHourlyMeta(cacheDir, 'domains', '2026', '02', '20', '21', {
    gh000000000000000000000000000002: ['example.com'],
  });
  writeHourlyMeta(cacheDir, 'tags', '2026', '02', '20', '21', {
    gh000000000000000000000000000002: ['tag2'],
  });

  const result = runCli(cacheDir, ['stats', '--date', '2026-02-20', '--days', '7', '--top', '2']);
  expect(result.status).toBe(0);
  expect(result.stdout).toMatch(/## Gyazo Stats/);
  expect(result.stdout).toMatch(/Window: 2026-02-14 to 2026-02-20 \(7 days\)/);
  expect(result.stdout).toMatch(/### Upload Time \(Hour\)/);
  expect(result.stdout).toMatch(/### Apps/);
  expect(result.stdout).toMatch(/- Chrome: 1/);
  expect(result.stdout).toMatch(/### Domains/);
  expect(result.stdout).toMatch(/- x\.com: 1/);
  expect(result.stdout).toMatch(/### Tags/);
  expect(result.stdout).toMatch(/- #tag1: 1/);
});

test('stats default window is from 8 days ago to yesterday', () => {
  const cacheDir = createTempCacheDir();
  const range = getDefaultWeeklyRangeLabels();
  const yesterday = ymdPartsFromDate(range.end);
  const today = ymdPartsFromDate(new Date());

  writeHourlyIndex(cacheDir, yesterday.year, yesterday.month, yesterday.day, '10', [
    'wk000000000000000000000000000001',
  ]);
  writeHourlyMeta(cacheDir, 'apps', yesterday.year, yesterday.month, yesterday.day, '10', {
    wk000000000000000000000000000001: ['WeeklyApp'],
  });
  writeHourlyMeta(cacheDir, 'domains', yesterday.year, yesterday.month, yesterday.day, '10', {
    wk000000000000000000000000000001: ['weekly.example'],
  });
  writeHourlyMeta(cacheDir, 'tags', yesterday.year, yesterday.month, yesterday.day, '10', {
    wk000000000000000000000000000001: ['weekly'],
  });

  writeHourlyIndex(cacheDir, today.year, today.month, today.day, '10', [
    'td000000000000000000000000000001',
  ]);
  writeHourlyMeta(cacheDir, 'apps', today.year, today.month, today.day, '10', {
    td000000000000000000000000000001: ['TodayApp'],
  });
  writeHourlyMeta(cacheDir, 'domains', today.year, today.month, today.day, '10', {
    td000000000000000000000000000001: ['today.example'],
  });
  writeHourlyMeta(cacheDir, 'tags', today.year, today.month, today.day, '10', {
    td000000000000000000000000000001: ['todaytag'],
  });

  const result = runCli(cacheDir, ['stats', '--top', '5']);
  expect(result.status).toBe(0);
  expect(result.stdout).toMatch(
    new RegExp(`Window: ${range.startLabel} to ${range.endLabel} \\(7 days\\)`),
  );
  expect(result.stdout).toMatch(/- WeeklyApp: 1/);
  expect(result.stdout).not.toContain('TodayApp');
});

test('apps rejects invalid --date month', () => {
  const cacheDir = createTempCacheDir();
  const result = runCli(cacheDir, ['apps', '--date', '2026-13']);
  expect(result.status).toBe(1);
  expect(result.stderr).toMatch(/--date month is invalid/);
});

test('domains de-duplicates same image id across hourly buckets', () => {
  const cacheDir = createTempCacheDir();
  const shared = 'zz000000000000000000000000000001';
  const another = 'zz000000000000000000000000000002';

  writeHourlyMeta(cacheDir, 'domains', '2026', '01', '15', '08', {
    [shared]: ['x.com'],
  });
  writeHourlyMeta(cacheDir, 'domains', '2026', '01', '16', '09', {
    [shared]: ['x.com'],
    [another]: ['example.com'],
  });

  const result = runCli(cacheDir, ['domains', '--date', '2026-01']);
  expect(result.status).toBe(0);
  expect(result.stdout).toMatch(/Domains on 2026-01/);
  expect(result.stdout).toMatch(/example\.com: 1/);
  expect(result.stdout).toMatch(/x\.com: 1/);
  expect(result.stdout).toMatch(/Total images with domain metadata: 2/);
});

test('stats keeps labels with pipes in bullet output', () => {
  const cacheDir = createTempCacheDir();
  const imageId = 'st000000000000000000000000000001';

  writeHourlyIndex(cacheDir, '2026', '02', '20', '10', [imageId]);
  writeHourlyMeta(cacheDir, 'apps', '2026', '02', '20', '10', {
    [imageId]: ['Foo|Bar'],
  });
  writeHourlyMeta(cacheDir, 'domains', '2026', '02', '20', '10', {
    [imageId]: ['example.com'],
  });
  writeHourlyMeta(cacheDir, 'tags', '2026', '02', '20', '10', {
    [imageId]: ['tag1'],
  });

  const result = runCli(cacheDir, ['stats', '--date', '2026-02-20', '--days', '1', '--top', '3']);
  expect(result.status).toBe(0);
  expect(result.stdout).toMatch(/- Foo\|Bar: 1/);
});

test('get prints markdown fields, objects and truncated OCR preview', () => {
  const cacheDir = createTempCacheDir();
  const imageId = 'aa000000000000000000000000000001';

  writeImageCache(cacheDir, imageId, {
    image_id: imageId,
    permalink_url: `https://gyazo.com/${imageId}`,
    created_at: '2026-02-20T02:34:56+09:00',
    alt_text: '  ALT text sample  ',
    metadata: {
      title: '  Sample Title  ',
      exif_address: {
        ja: {
          address: '東京都台東区竜泉',
        },
      },
    },
    localizedObjectAnnotations: [
      { name_ja: '猫', score: 0.2 },
      { name_ja: '猫', score: 0.9 },
      { name_ja: '犬', score: 0.7 },
    ],
    ocr: {
      description: 'line1\nline2\nline3\nline4\nline5\nline6',
    },
  });

  const result = runCli(cacheDir, ['get', imageId]);
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('## Gyazo Image');
  expect(result.stdout).toContain(`- URL: <https://gyazo.com/${imageId}>`);
  expect(result.stdout).toContain('- Created at: 2026-02-20 02:34');
  expect(result.stdout).toContain('- Title: Sample Title');
  expect(result.stdout).toContain('- Address: 東京都台東区竜泉');
  expect(result.stdout).toContain('- Alt text: ALT text sample');
  expect(result.stdout).toContain('### Objects');
  expect(result.stdout).toContain('- 猫 (90.0%)');
  expect(result.stdout).toContain('- 犬 (70.0%)');
  expect(result.stdout).toContain('### OCR');
  expect(result.stdout).toContain('line5');
  expect(result.stdout).not.toContain('line6');
  expect(result.stdout).toContain(`gyazo get --ocr ${imageId}`);
});

test('get --ocr prints full OCR text without truncation', () => {
  const cacheDir = createTempCacheDir();
  const imageId = 'bb000000000000000000000000000001';
  const fullText = 'l1\nl2\nl3\nl4\nl5\nl6';

  writeImageCache(cacheDir, imageId, {
    image_id: imageId,
    permalink_url: `https://gyazo.com/${imageId}`,
    created_at: '2026-02-20T00:00:00+09:00',
    ocr: { description: fullText },
  });

  const result = runCli(cacheDir, ['get', '--ocr', imageId]);
  expect(result.status).toBe(0);
  expect(result.stdout.trim()).toBe(fullText);
});

test('get --objects prints sorted object annotations', () => {
  const cacheDir = createTempCacheDir();
  const imageId = 'cc000000000000000000000000000001';

  writeImageCache(cacheDir, imageId, {
    image_id: imageId,
    permalink_url: `https://gyazo.com/${imageId}`,
    created_at: '2026-02-20T00:00:00+09:00',
    localized_object_annotations: [
      { name: 'cat', score: 0.6 },
      { name: 'cat', score: 0.8 },
      { name: 'dog', score: 0.7 },
    ],
  });

  const result = runCli(cacheDir, ['get', '--objects', imageId]);
  expect(result.status).toBe(0);
  const lines = result.stdout.trim().split('\n');
  expect(lines).toEqual(['cat (80.0%)', 'dog (70.0%)']);
});

test('get supplements alt text from search cache and persists it', () => {
  const cacheDir = createTempCacheDir();
  const imageId = 'dd000000000000000000000000000001';

  writeImageCache(cacheDir, imageId, {
    image_id: imageId,
    permalink_url: `https://gyazo.com/${imageId}`,
    created_at: '2026-02-20T00:00:00+09:00',
    metadata: { title: 'No Alt Yet' },
  });
  writeSearchImageCache(cacheDir, imageId, {
    image_id: imageId,
    alt_text: 'Recovered alt text',
  });

  const result = runCli(cacheDir, ['get', imageId]);
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('- Alt text: Recovered alt text');

  const updatedCache = readImageCache(cacheDir, imageId);
  expect(updatedCache.alt_text).toBe('Recovered alt text');
});

test('get rejects incompatible output flags', () => {
  const cacheDir = createTempCacheDir();
  const imageId = 'ee000000000000000000000000000001';

  const jsonOcrConflict = runCli(cacheDir, ['get', '--json', '--ocr', imageId]);
  expect(jsonOcrConflict.status).toBe(1);
  expect(jsonOcrConflict.stderr).toMatch(/--json cannot be used with --ocr or --objects/);

  const ocrObjectsConflict = runCli(cacheDir, ['get', '--ocr', '--objects', imageId]);
  expect(ocrObjectsConflict.status).toBe(1);
  expect(ocrObjectsConflict.stderr).toMatch(/--ocr and --objects cannot be used together/);
});

test('list --hour formats summary with domain, location and short id', () => {
  const cacheDir = createTempCacheDir();
  const imageId = 'e8dc3874af069907bce5bd77fa33efd8';

  writeHourlyIndex(cacheDir, '2026', '02', '20', '02', [imageId]);
  writeImageCache(cacheDir, imageId, {
    image_id: imageId,
    permalink_url: `https://gyazo.com/${imageId}`,
    created_at: '2026-02-20T02:34:56+09:00',
    alt_text: '',
    metadata: {
      url: 'https://x.com/example/status/1',
      title: 'XユーザーのMagia Charmさん / X',
      desc: '「重ね着風で一見ワンピースにも見えるロンT🎀」 https://t.co/Y9bxsrGaH7',
      exif_address: '東京都台東区竜泉',
    },
  });

  const result = runCli(cacheDir, ['ls', '--hour', '2026-02-20-02']);
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('[2026-02-20 02:34]');
  expect(result.stdout).toContain('[x.com] [東京都台東区竜泉]');
  expect(result.stdout).toContain('Magia Charmさん');
  expect(result.stdout).toContain('(id: e8dc...)');
  expect(result.stdout).not.toContain('Xユーザーの');
  expect(result.stdout).not.toContain('https://t.co/');
});

test('list rejects incompatible alias options', () => {
  const cacheDir = createTempCacheDir();
  const result = runCli(cacheDir, ['ls', '--photos', '--uploaded']);
  expect(result.status).toBe(1);
  expect(result.stderr).toMatch(/--photos and --uploaded cannot be used together/);
});

test('search without query prints hint', () => {
  const cacheDir = createTempCacheDir();
  const result = runCli(cacheDir, ['search']);
  expect(result.status).toBe(1);
  expect(result.stderr).toMatch(/Query is required/);
  expect(result.stderr).toMatch(/Run `gyazo search -h` for usage/);
});

test('sync rejects --date and --days together', () => {
  const cacheDir = createTempCacheDir();
  const result = runCli(cacheDir, ['sync', '--date', '2026-02', '--days', '3']);
  expect(result.status).toBe(1);
  expect(result.stderr).toMatch(/--date and --days cannot be used together/);
});

test('upload rejects non-numeric timestamp before API call', () => {
  const cacheDir = createTempCacheDir();
  const result = runCli(cacheDir, ['upload', '--timestamp', 'abc'], { input: Buffer.from('fakeimage') });
  expect(result.status).toBe(1);
  expect(result.stderr).toMatch(/--timestamp must be a unix timestamp in seconds/);
});

test('upload rejects future timestamp before API call', () => {
  const cacheDir = createTempCacheDir();
  const future = String(Math.floor(Date.now() / 1000) + 60);
  const result = runCli(cacheDir, ['upload', '--timestamp', future], { input: Buffer.from('fakeimage') });
  expect(result.status).toBe(1);
  expect(result.stderr).toMatch(/--timestamp must be current time or in the past/);
});
