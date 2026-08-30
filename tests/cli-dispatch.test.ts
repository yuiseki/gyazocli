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
