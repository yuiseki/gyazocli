import { test, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  createTempCacheDir,
  runCli,
  writeImageCache,
  startStubServer,
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

// --- making a capture private -----------------------------------------------

/**
 * The web app's own endpoint, which is the only thing that can change an
 * access policy after upload: a page carrying a CSRF token, and a PATCH that
 * wants it back.
 */
function internalApiStub(capture: any, options: { token?: string } = {}) {
  const token = options.token ?? 'csrf-token-value';
  const seen: Array<{ method: string; url: string; body: string; headers: any }> = [];
  const handler: StubHandler = (req, res, body) => {
    seen.push({
      method: req.method || '',
      url: req.url || '',
      body: body.toString(),
      headers: req.headers,
    });
    const url = new URL(req.url || '', 'http://127.0.0.1');
    if (url.pathname === '/' || url.pathname === `/${capture.image_id}`) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<html><head><meta name="csrf-token" content="${token}"></head></html>`);
      return;
    }
    if (req.method === 'PATCH' && url.pathname.startsWith('/api/internal/images/')) {
      if (req.headers['x-csrf-token'] !== token) {
        res.writeHead(422, { 'Content-Type': 'text/html' });
        res.end('');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ image_id: capture.image_id, access_policy: 'only_me' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(url.pathname === '/api/search' ? [capture] : capture));
  };
  return { handler, seen };
}

const COOKIE_FILE_CONTENT = JSON.stringify([
  { name: 'Gyazo_session', value: 'session-value', domain: '.gyazo.com' },
  { name: '_ga', value: 'analytics', domain: '.gyazo.com' },
  { name: 'elsewhere', value: 'no', domain: '.example.com' },
]);

function writeCookieFile(dir: string): string {
  const file = path.join(dir, 'cookie.json');
  fs.writeFileSync(file, COOKIE_FILE_CONTENT, 'utf8');
  return file;
}

test('answering n makes the capture only_me through the web endpoint', async () => {
  const cacheDir = createTempCacheDir();
  const capture = {
    image_id: `ac${'0'.repeat(30)}`,
    permalink_url: `https://gyazo.com/ac${'0'.repeat(30)}`,
    url: `https://i.gyazo.com/ac${'0'.repeat(30)}.png`,
    type: 'png',
    access_policy: 'anyone',
    created_at: '2026-09-01T12:00:00+0000',
    metadata: { app: 'Chrome' },
  };
  const { handler, seen } = internalApiStub(capture);
  const stub = await startStubServer(handler);
  const cookieFile = writeCookieFile(cacheDir);

  try {
    const result = await runCli(cacheDir, ['triage', '--id', capture.image_id, '-i'], {
      apiOrigin: stub.origin,
      webOrigin: stub.origin,
      cookieFile,
      input: 'n\n',
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/only_me/);

    const patch = seen.find((request) => request.method === 'PATCH');
    expect(patch, 'it patches the internal endpoint').toBeDefined();
    expect(patch!.url).toBe(`/api/internal/images/${capture.image_id}`);
    expect(JSON.parse(patch!.body)).toEqual({ access_policy: 'only_me' });
    // Session cookies for gyazo.com, and nothing from another domain.
    expect(patch!.headers.cookie).toContain('Gyazo_session=session-value');
    expect(patch!.headers.cookie).not.toContain('elsewhere');
    // The token comes from a page fetched with the same cookies.
    expect(patch!.headers['x-csrf-token']).toBe('csrf-token-value');
  } finally {
    await stub.close();
  }
});

test('with no cookies it says what it cannot do, and still links the capture', async () => {
  const cacheDir = createTempCacheDir();
  const capture = {
    image_id: `ad${'0'.repeat(30)}`,
    permalink_url: `https://gyazo.com/ad${'0'.repeat(30)}`,
    url: `https://i.gyazo.com/ad${'0'.repeat(30)}.png`,
    type: 'png',
    created_at: '2026-09-01T12:00:00+0000',
    metadata: { app: 'Chrome' },
  };
  const { handler, seen } = internalApiStub(capture);
  const stub = await startStubServer(handler);

  try {
    const result = await runCli(cacheDir, ['triage', '--id', capture.image_id, '-i'], {
      apiOrigin: stub.origin,
      webOrigin: stub.origin,
      cookieFile: path.join(cacheDir, 'absent.json'),
      input: 'n\n',
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(capture.permalink_url);
    expect(result.stdout).toMatch(/cookie/i);
    expect(seen.some((request) => request.method === 'PATCH')).toBe(false);
  } finally {
    await stub.close();
  }
});

test('--no-apply answers without touching the account', async () => {
  const cacheDir = createTempCacheDir();
  const capture = {
    image_id: `ae${'0'.repeat(30)}`,
    permalink_url: `https://gyazo.com/ae${'0'.repeat(30)}`,
    url: `https://i.gyazo.com/ae${'0'.repeat(30)}.png`,
    type: 'png',
    created_at: '2026-09-01T12:00:00+0000',
    metadata: { app: 'Chrome' },
  };
  const { handler, seen } = internalApiStub(capture);
  const stub = await startStubServer(handler);
  const cookieFile = writeCookieFile(cacheDir);

  try {
    const result = await runCli(
      cacheDir,
      ['triage', '--id', capture.image_id, '-i', '--no-apply'],
      { apiOrigin: stub.origin, webOrigin: stub.origin, cookieFile, input: 'n\n' },
    );
    expect(result.status).toBe(0);
    expect(seen.some((request) => request.method === 'PATCH')).toBe(false);
    expect(result.stdout).toContain(capture.permalink_url);
  } finally {
    await stub.close();
  }
});

// --- triage -----------------------------------------------------------------

test('triage renders each capture as markdown, one heading per field it has', async () => {
  const cacheDir = createTempCacheDir();
  const id = `77${'0'.repeat(30)}`;
  const lean = {
    image_id: id,
    permalink_url: `https://gyazo.com/${id}`,
    url: `https://i.gyazo.com/${id}.png`,
    type: 'png',
    created_at: '2026-09-01T12:00:00+0000',
    metadata: { app: 'Google Chrome' },
  };
  const detail = {
    ...lean,
    metadata: {
      app: 'Google Chrome',
      title: 'Login',
      url: 'https://example.com/login',
      desc: '',
      ocr: { locale: 'en', description: 'password: hunter2' },
      exif_normalized: { latitude: 35.68, longitude: 139.76 },
    },
  };

  const stub = await startStubServer((req, res) => {
    const url = new URL(req.url || '', 'http://127.0.0.1');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(url.pathname === '/api/search' ? [lean] : detail));
  });

  try {
    const result = await runCli(cacheDir, ['triage', '-q', 'password'], { apiOrigin: stub.origin });
    expect(result.status).toBe(0);

    const out = result.stdout;
    // The capture's id is the heading it lives under.
    expect(out).toMatch(new RegExp(`^# ${id}$`, 'm'));
    // Keys as headings, values as content.
    expect(out).toMatch(/^## ocr$/m);
    expect(out).toContain('password: hunter2');
    expect(out).toMatch(/^## app$/m);
    // The time is the one on the reader's own clock, in Japanese.
    const at = new Date('2026-09-01T12:00:00+0000');
    const weekday = ['日', '月', '火', '水', '木', '金', '土'][at.getDay()];
    const expected =
      `${at.getFullYear()}年${at.getMonth() + 1}月${at.getDate()}日(${weekday}) ` +
      `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
    expect(out).toContain(expected);
    expect(out).not.toMatch(/^## captured_at$/m);
    expect(out).toContain('Google Chrome');
    expect(out).toMatch(/^## title$/m);
    // A field the capture does not carry gets no heading.
    expect(out).not.toMatch(/^## desc$/m);
    expect(out).not.toMatch(/^## alt_text$/m);
    // Dropped on purpose: noise for reading through captures one at a time.
    for (const field of ['type', 'permalink_url', 'url', 'ocr_locale', 'latitude', 'longitude']) {
      expect(out, field).not.toMatch(new RegExp(`^## ${field}$`, 'm'));
    }
    // Piped output carries no escape sequences.
    expect(out).not.toContain('\u001b[');
  } finally {
    await stub.close();
  }
});

test('triage separates captures with a rule, and colours the id on request', async () => {
  const cacheDir = createTempCacheDir();
  const captures = ['88', '99'].map((prefix) => ({
    image_id: `${prefix}${'0'.repeat(30)}`,
    permalink_url: `https://gyazo.com/${prefix}${'0'.repeat(30)}`,
    url: `https://i.gyazo.com/${prefix}${'0'.repeat(30)}.png`,
    type: 'png',
    created_at: '2026-09-01T12:00:00+0000',
    metadata: { app: 'Google Chrome' },
  }));

  const stub = await startStubServer((req, res) => {
    const url = new URL(req.url || '', 'http://127.0.0.1');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (url.pathname === '/api/search') {
      res.end(JSON.stringify(captures));
      return;
    }
    const id = url.pathname.split('/').pop();
    res.end(JSON.stringify(captures.find((capture) => capture.image_id === id)));
  });

  try {
    const plain = await runCli(cacheDir, ['triage', '-q', 'anything'], { apiOrigin: stub.origin });
    expect(plain.status).toBe(0);
    // Between the two captures, and not before the first or after the last.
    expect(plain.stdout.match(/^---$/gm) ?? []).toHaveLength(1);

    const coloured = await runCli(cacheDir, ['triage', '-q', 'anything', '--color', 'always'], {
      apiOrigin: stub.origin,
    });
    expect(coloured.stdout).toContain(`\u001b[36m# ${captures[0].image_id}\u001b[0m`);
  } finally {
    await stub.close();
  }
});

test('triage asks about each capture and records the answers', async () => {
  const cacheDir = createTempCacheDir();
  const captures = ['a1', 'a2', 'a3'].map((prefix) => ({
    image_id: `${prefix}${'0'.repeat(30)}`,
    permalink_url: `https://gyazo.com/${prefix}${'0'.repeat(30)}`,
    url: `https://i.gyazo.com/${prefix}${'0'.repeat(30)}.png`,
    type: 'png',
    created_at: '2026-09-01T12:00:00+0000',
    metadata: { app: 'Google Chrome', ocr: { description: 'secret' } },
  }));
  const stub = await startStubServer((req, res) => {
    const url = new URL(req.url || '', 'http://127.0.0.1');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (url.pathname === '/api/search') {
      res.end(JSON.stringify(captures));
      return;
    }
    const id = url.pathname.split('/').pop();
    res.end(JSON.stringify(captures.find((capture) => capture.image_id === id)));
  });

  try {
    // Enter takes the default, then a no, then a quit.
    const result = await runCli(cacheDir, ['triage', '-q', 'secret', '--interactive'], {
      apiOrigin: stub.origin,
      input: '\nn\nq\n',
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/Is it safe\? \[Y\/n\]/);

    const ledger = path.join(cacheDir, '.local', 'state', 'gyazocli', 'triage.jsonl');
    expect(fs.existsSync(ledger), 'the answers are written down').toBe(true);
    const entries = fs
      .readFileSync(ledger, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ image_id: captures[0].image_id, verdict: 'safe' });
    expect(entries[1]).toMatchObject({ image_id: captures[1].image_id, verdict: 'unsafe' });
    // Quitting stops before the third, and says where the answers went.
    expect(result.stdout).toContain('triage.jsonl');
  } finally {
    await stub.close();
  }
});

test('triage does not ask twice about the same capture', async () => {
  const cacheDir = createTempCacheDir();
  const capture = {
    image_id: `b1${'0'.repeat(30)}`,
    permalink_url: `https://gyazo.com/b1${'0'.repeat(30)}`,
    url: `https://i.gyazo.com/b1${'0'.repeat(30)}.png`,
    type: 'png',
    created_at: '2026-09-01T12:00:00+0000',
    metadata: { app: 'Google Chrome' },
  };
  const stub = await startStubServer((req, res) => {
    const url = new URL(req.url || '', 'http://127.0.0.1');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(url.pathname === '/api/search' ? [capture] : capture));
  });

  try {
    await runCli(cacheDir, ['triage', '-q', 'x', '--interactive'], {
      apiOrigin: stub.origin,
      input: 'y\n',
    });
    const second = await runCli(cacheDir, ['triage', '-q', 'x', '--interactive'], {
      apiOrigin: stub.origin,
      input: '',
    });
    expect(second.stdout).toMatch(/already|判定済み|nothing left/i);
    expect(second.stdout).not.toMatch(/Is it safe/);

    const asked = await runCli(cacheDir, ['triage', '-q', 'x', '--interactive', '--again'], {
      apiOrigin: stub.origin,
      input: 'y\n',
    });
    expect(asked.stdout).toMatch(/Is it safe/);
  } finally {
    await stub.close();
  }
});

test('triage walks past captures already answered to find the next ones', async () => {
  const cacheDir = createTempCacheDir();
  // Two pages of 100. Everything on the first page is already answered.
  const page1 = Array.from({ length: 100 }, (_, index) => ({
    image_id: `c${String(index).padStart(31, '0')}`,
    permalink_url: 'https://gyazo.com/x',
    url: 'https://i.gyazo.com/x.png',
    type: 'png',
    created_at: '2026-09-01T12:00:00+0000',
    metadata: { app: 'Chrome' },
  }));
  const page2 = ['d1', 'd2'].map((prefix) => ({
    image_id: `${prefix}${'0'.repeat(30)}`,
    permalink_url: `https://gyazo.com/${prefix}`,
    url: `https://i.gyazo.com/${prefix}.png`,
    type: 'png',
    created_at: '2026-09-01T12:00:00+0000',
    metadata: { app: 'Chrome' },
  }));

  const stub = await startStubServer((req, res) => {
    const url = new URL(req.url || '', 'http://127.0.0.1');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (url.pathname === '/api/search') {
      const page = Number(url.searchParams.get('page') || '1');
      res.end(JSON.stringify(page === 1 ? page1 : page === 2 ? page2 : []));
      return;
    }
    const id = url.pathname.split('/').pop();
    res.end(JSON.stringify([...page1, ...page2].find((c) => c.image_id === id)));
  });

  try {
    // Answer everything on the first page, in one run with a big budget.
    const first = await runCli(cacheDir, ['triage', '-q', 'x', '-i', '--limit', '100'], {
      apiOrigin: stub.origin,
      input: 'y\n'.repeat(100),
    });
    expect(first.status).toBe(0);
    expect(first.stdout).toContain('100 answered');

    // The next run must reach page 2 rather than reporting nothing left.
    const second = await runCli(cacheDir, ['triage', '-q', 'x', '-i'], {
      apiOrigin: stub.origin,
      input: 'y\ny\n',
    });
    expect(second.stdout).toContain(page2[0].image_id);
    expect(second.stdout).toContain('2 answered');

    const pages = stub.requests
      .filter((request) => request.url.startsWith('/api/search'))
      .map((request) => new URL(request.url, 'http://127.0.0.1').searchParams.get('page'));
    expect(pages).toContain('2');
  } finally {
    await stub.close();
  }
});

test('triage handles as many as --limit says, and no more', async () => {
  const cacheDir = createTempCacheDir();
  const captures = ['e1', 'e2', 'e3'].map((prefix) => ({
    image_id: `${prefix}${'0'.repeat(30)}`,
    permalink_url: `https://gyazo.com/${prefix}`,
    url: `https://i.gyazo.com/${prefix}.png`,
    type: 'png',
    created_at: '2026-09-01T12:00:00+0000',
    metadata: { app: 'Chrome' },
  }));
  const stub = await startStubServer((req, res) => {
    const url = new URL(req.url || '', 'http://127.0.0.1');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (url.pathname === '/api/search') {
      const page = Number(url.searchParams.get('page') || '1');
      res.end(JSON.stringify(page === 1 ? captures : []));
      return;
    }
    const id = url.pathname.split('/').pop();
    res.end(JSON.stringify(captures.find((c) => c.image_id === id)));
  });

  try {
    const result = await runCli(cacheDir, ['triage', '-q', 'x', '-i', '--limit', '2'], {
      apiOrigin: stub.origin,
      input: 'y\ny\ny\n',
    });
    expect(result.stdout).toContain('2 answered');
    expect(result.stdout).not.toContain(captures[2].image_id);
  } finally {
    await stub.close();
  }
});

test('triage shows the access policy when the capture has one', async () => {
  const cacheDir = createTempCacheDir();
  const captures = [
    { suffix: 'f1', access_policy: 'only_me' },
    { suffix: 'f2', access_policy: 'anyone' },
    { suffix: 'f3', access_policy: null },
  ].map(({ suffix, access_policy }) => ({
    image_id: `${suffix}${'0'.repeat(30)}`,
    permalink_url: `https://gyazo.com/${suffix}`,
    url: `https://i.gyazo.com/${suffix}.png`,
    type: 'png',
    access_policy,
    created_at: '2026-09-01T12:00:00+0000',
    metadata: { app: 'Chrome' },
  }));

  const stub = await startStubServer((req, res) => {
    const url = new URL(req.url || '', 'http://127.0.0.1');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (url.pathname === '/api/search') {
      const page = Number(url.searchParams.get('page') || '1');
      res.end(JSON.stringify(page === 1 ? captures : []));
      return;
    }
    const id = url.pathname.split('/').pop();
    res.end(JSON.stringify(captures.find((capture) => capture.image_id === id)));
  });

  try {
    const result = await runCli(cacheDir, ['triage', '-q', 'x'], { apiOrigin: stub.origin });
    expect(result.status).toBe(0);
    const sections = result.stdout.split(/^---$/m);
    expect(sections).toHaveLength(3);
    // First field of the section, so it is read before a wall of OCR text.
    expect(sections[0]).toMatch(/^## access_policy$\n\nonly_me$/m);
    expect(sections[1]).toMatch(/^## access_policy$\n\nanyone$/m);
    // Unset means the default, which is anyone, and saying so beats silence
    // when the reader is looking for the ones that are not.
    expect(sections[2]).toMatch(/^## access_policy$\n\nanyone$/m);
    expect(sections[2]).not.toContain('null');
  } finally {
    await stub.close();
  }
});

test('triage highlights what the query matched', async () => {
  const cacheDir = createTempCacheDir();
  const capture = {
    image_id: `g1${'0'.repeat(30)}`,
    permalink_url: 'https://gyazo.com/g1',
    url: 'https://i.gyazo.com/g1.png',
    type: 'png',
    access_policy: 'anyone',
    created_at: '2026-09-01T12:00:00+0000',
    metadata: {
      app: 'Chrome',
      ocr: { description: 'the Password field, and a password again' },
      exif_address: { ja: { address: '日本、広島県広島市中区' } },
      exif_normalized: { latitude: 34.3, longitude: 132.4 },
    },
  };
  const stub = await startStubServer((req, res) => {
    const url = new URL(req.url || '', 'http://127.0.0.1');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(url.pathname === '/api/search' ? [capture] : capture));
  });

  const ORANGE = '\u001b[38;5;208m';
  const PLAIN = '\u001b[39m';

  try {
    const plain = await runCli(cacheDir, ['triage', '-q', 'password'], { apiOrigin: stub.origin });
    expect(plain.stdout).not.toContain(ORANGE);
    expect(plain.stdout).toContain('the Password field, and a password again');

    const lit = await runCli(cacheDir, ['triage', '-q', 'password', '--color', 'always'], {
      apiOrigin: stub.origin,
    });
    // Both occurrences, and the case of the text is kept.
    expect(lit.stdout).toContain(`the ${ORANGE}Password${PLAIN} field`);
    expect(lit.stdout).toContain(`a ${ORANGE}password${PLAIN} again`);

    // The value of an operator counts, and its key does not: `has:exif` must
    // not paint every "exif" in sight.
    const operators = await runCli(
      cacheDir,
      ['triage', '-q', 'address:広島 has:exif', '--color', 'always', '--again'],
      { apiOrigin: stub.origin },
    );
    expect(operators.stdout).toContain(`${ORANGE}広島${PLAIN}`);
    expect(operators.stdout).not.toContain(`${ORANGE}exif${PLAIN}`);
  } finally {
    await stub.close();
  }
});

test('answering n prints the capture URL, and the run ends with the list of them', async () => {
  const cacheDir = createTempCacheDir();
  const captures = ['h1', 'h2'].map((prefix) => ({
    image_id: `${prefix}${'0'.repeat(30)}`,
    permalink_url: `https://gyazo.com/${prefix}${'0'.repeat(30)}`,
    url: `https://i.gyazo.com/${prefix}${'0'.repeat(30)}.png`,
    type: 'png',
    created_at: '2026-09-01T12:00:00+0000',
    metadata: { app: 'Chrome' },
  }));
  const stub = await startStubServer((req, res) => {
    const url = new URL(req.url || '', 'http://127.0.0.1');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (url.pathname === '/api/search') {
      const page = Number(url.searchParams.get('page') || '1');
      res.end(JSON.stringify(page === 1 ? captures : []));
      return;
    }
    const id = url.pathname.split('/').pop();
    res.end(JSON.stringify(captures.find((capture) => capture.image_id === id)));
  });

  try {
    const result = await runCli(cacheDir, ['triage', '-q', 'x', '-i'], {
      apiOrigin: stub.origin,
      input: 'n\ny\n',
    });
    expect(result.status).toBe(0);
    // The one answered n is linked where it was answered, and again at the end,
    // because making it private is something only the web UI can do.
    expect(result.stdout).toContain(captures[0].permalink_url);
    expect(result.stdout).not.toContain(captures[1].permalink_url);
    expect(result.stdout).toMatch(/1 to make private|only_me/i);
  } finally {
    await stub.close();
  }
});

test('triage --id asks about exactly those captures, answered or not', async () => {
  const cacheDir = createTempCacheDir();
  const capture = {
    // 32 hex characters: --id runs the same check the rest of the CLI does.
    image_id: `ab${'0'.repeat(30)}`,
    permalink_url: `https://gyazo.com/ab${'0'.repeat(30)}`,
    url: `https://i.gyazo.com/ab${'0'.repeat(30)}.png`,
    type: 'png',
    created_at: '2026-09-01T12:00:00+0000',
    metadata: { app: 'Chrome' },
  };
  const stub = await startStubServer((req, res) => {
    const url = new URL(req.url || '', 'http://127.0.0.1');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(capture));
  });

  try {
    const first = await runCli(cacheDir, ['triage', '--id', capture.image_id, '-i'], {
      apiOrigin: stub.origin,
      input: 'y\n',
    });
    expect(first.status).toBe(0);
    expect(first.stdout).toContain(capture.image_id);
    // No search at all: the ids say what to look at.
    expect(stub.requests.some((request) => request.url.startsWith('/api/search'))).toBe(false);

    // Answering again is the point of naming an id: it is how a mistake is
    // corrected.
    const second = await runCli(cacheDir, ['triage', '--id', capture.image_id, '-i'], {
      apiOrigin: stub.origin,
      input: 'n\n',
    });
    expect(second.stdout).toMatch(/Is it safe/);

    const ledger = path.join(cacheDir, '.local', 'state', 'gyazocli', 'triage.jsonl');
    const verdicts = fs
      .readFileSync(ledger, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line).verdict);
    expect(verdicts).toEqual(['safe', 'unsafe']);
  } finally {
    await stub.close();
  }
});

test('triage says so when nothing matches', async () => {
  const cacheDir = createTempCacheDir();
  const stub = await startStubServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify([]));
  });
  try {
    const result = await runCli(cacheDir, ['triage', '-q', 'nothing-matches-this'], {
      apiOrigin: stub.origin,
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/no captures|見つかりません|0 captures/i);
  } finally {
    await stub.close();
  }
});

test('triage takes the query as a bare argument too', async () => {
  const cacheDir = createTempCacheDir();
  const stub = await startStubServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify([]));
  });
  try {
    const result = await runCli(cacheDir, ['triage', 'password'], { apiOrigin: stub.origin });
    expect(result.status).toBe(0);
    const asked = stub.requests.find((request) => request.url.startsWith('/api/search'));
    expect(new URL(asked!.url, 'http://127.0.0.1').searchParams.get('query')).toBe('password');
  } finally {
    await stub.close();
  }
});

// --- an access token that is no longer accepted ----------------------------

/** Every authenticated endpoint answering the way a revoked token gets answered. */
function unauthorizedStub(): StubHandler {
  return (_req, res) => {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ message: 'You are not authorized.' }));
  };
}

test('a rejected token is reported as a rejected token', async () => {
  const cacheDir = createTempCacheDir();
  const stub = await startStubServer(unauthorizedStub());
  try {
    for (const args of [['config', 'get', 'me'], ['ls'], ['search', 'cat']]) {
      const result = await runCli(cacheDir, args, { apiOrigin: stub.origin });
      expect(result.status, args.join(' ')).toBe(1);
      // Not just the status code: what it means and what to do about it.
      expect(result.stderr, args.join(' ')).toMatch(/access token/i);
      expect(result.stderr, args.join(' ')).toMatch(/gyazo config set token/);
    }
  } finally {
    await stub.close();
  }
});

test('a 503 from image delivery says the image is unavailable, not that the id is wrong', async () => {
  const cacheDir = createTempCacheDir();
  const stub = await startStubServer((_req, res) => {
    res.writeHead(503, { 'Content-Type': 'text/plain' });
    res.end('this content is temporarily unavailable');
  });
  try {
    const result = await runCli(cacheDir, ['get', 'a'.repeat(32)], { apiOrigin: stub.origin });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/temporarily unavailable|503/i);
  } finally {
    await stub.close();
  }
});

// --- sync over a query ------------------------------------------------------

test('sync --query walks the search endpoint and caches what it finds', async () => {
  const cacheDir = createTempCacheDir();
  // The hourly index is keyed by local time, so the fixture carries this
  // machine's own offset and the expected path is derived from the same
  // instant. A fixed +09:00 would put the capture in a different hour, and a
  // different day, anywhere else.
  const capturedAt = new Date(2026, 7, 30, 2, 34, 56);
  const pad = (value: number) => String(value).padStart(2, '0');
  const offsetMinutes = -capturedAt.getTimezoneOffset();
  const offset = `${offsetMinutes < 0 ? '-' : '+'}${pad(Math.floor(Math.abs(offsetMinutes) / 60))}${pad(Math.abs(offsetMinutes) % 60)}`;
  const createdAt =
    `${capturedAt.getFullYear()}-${pad(capturedAt.getMonth() + 1)}-${pad(capturedAt.getDate())}` +
    `T${pad(capturedAt.getHours())}:${pad(capturedAt.getMinutes())}:${pad(capturedAt.getSeconds())}${offset}`;

  const pageOf = (prefix: string) =>
    Array.from({ length: 2 }, (_, index) => ({
      image_id: `${prefix}${String(index).padStart(30, '0')}`,
      permalink_url: `https://gyazo.com/${prefix}${String(index).padStart(30, '0')}`,
      url: `https://i.gyazo.com/${prefix}${String(index).padStart(30, '0')}.jpg`,
      type: 'jpg',
      created_at: createdAt,
      metadata: { app: 'Gyazo Android' },
    }));

  const stub = await startStubServer((req, res) => {
    const url = new URL(req.url || '', 'http://127.0.0.1');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (url.pathname === '/api/search') {
      const page = Number(url.searchParams.get('page') || '1');
      res.end(JSON.stringify(page === 1 ? pageOf('aa') : page === 2 ? pageOf('bb') : []));
      return;
    }
    if (url.pathname.startsWith('/api/images/')) {
      const id = url.pathname.split('/').pop();
      res.end(JSON.stringify({ image_id: id, created_at: createdAt, ocr: { description: 'x' } }));
      return;
    }
    res.end(JSON.stringify([]));
  });

  try {
    const result = await runCli(
      cacheDir,
      ['sync', '--query', 'has:exif OR has:location', '--max-pages', '2'],
      { apiOrigin: stub.origin },
    );
    expect(result.status).toBe(0);

    const searches = stub.requests.filter((request) => request.url.startsWith('/api/search'));
    expect(searches).toHaveLength(2);
    const first = new URL(searches[0].url, 'http://127.0.0.1').searchParams;
    expect(first.get('query')).toBe('has:exif OR has:location');
    expect(first.get('per')).toBe('100');
    expect(first.get('page')).toBe('1');
    // The listing endpoint is not touched at all on this path.
    expect(stub.requests.some((request) => request.url.startsWith('/api/images?'))).toBe(false);

    // Every capture it found is in the cache, under its own id.
    for (const prefix of ['aa', 'bb']) {
      const id = `${prefix}${'0'.repeat(30)}`;
      const cached = path.join(cacheDir, 'images', id[0], id[1], `${id}.json`);
      expect(fs.existsSync(cached), `${id} should be cached`).toBe(true);
    }
    // And in the hourly index for the hour it was captured in.
    const hourly = path.join(
      cacheDir,
      'hourly',
      String(capturedAt.getFullYear()),
      pad(capturedAt.getMonth() + 1),
      pad(capturedAt.getDate()),
      `${pad(capturedAt.getHours())}.json`,
    );
    expect(fs.existsSync(hourly)).toBe(true);
    expect(JSON.parse(fs.readFileSync(hourly, 'utf8'))).toHaveLength(4);
  } finally {
    await stub.close();
  }
});

test('sync --continue resumes where the last walk stopped', async () => {
  const cacheDir = createTempCacheDir();
  const day = (offset: number) => {
    const at = new Date();
    at.setDate(at.getDate() - offset);
    return at;
  };
  const capture = (prefix: string, at: Date) => ({
    image_id: `${prefix}${'0'.repeat(30)}`,
    permalink_url: `https://gyazo.com/${prefix}${'0'.repeat(30)}`,
    url: `https://i.gyazo.com/${prefix}${'0'.repeat(30)}.jpg`,
    type: 'jpg',
    created_at: at.toISOString(),
    metadata: { app: 'Gyazo Android' },
  });
  const oldest = day(10);

  const stub = await startStubServer((req, res) => {
    const url = new URL(req.url || '', 'http://127.0.0.1');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (url.pathname === '/api/search') {
      const page = Number(url.searchParams.get('page') || '1');
      res.end(JSON.stringify(page === 1 ? [capture('ee', day(1)), capture('ff', oldest)] : []));
      return;
    }
    const id = url.pathname.split('/').pop();
    res.end(JSON.stringify({ image_id: id, created_at: oldest.toISOString() }));
  });

  try {
    const first = await runCli(cacheDir, ['sync', '--query', 'has:exif', '--max-pages', '1'], {
      apiOrigin: stub.origin,
    });
    expect(first.status).toBe(0);

    const resumed = await runCli(
      cacheDir,
      ['sync', '--query', 'has:exif', '--max-pages', '1', '--continue'],
      { apiOrigin: stub.origin },
    );
    expect(resumed.status).toBe(0);
    // It says where it picked up, and asks the API for that window.
    expect(resumed.stdout).toMatch(/until:/);

    const queries = stub.requests
      .filter((request) => request.url.startsWith('/api/search'))
      .map((request) => new URL(request.url, 'http://127.0.0.1').searchParams.get('query'));
    const pad = (value: number) => String(value).padStart(2, '0');
    const oldestDay = `${oldest.getFullYear()}-${pad(oldest.getMonth() + 1)}-${pad(oldest.getDate())}`;
    expect(queries[0]).toBe('has:exif');
    expect(queries[queries.length - 1]).toBe(`has:exif until:${oldestDay}`);
  } finally {
    await stub.close();
  }
});

test('sync --continue refuses a query that already bounds its own dates', async () => {
  const cacheDir = createTempCacheDir();
  const result = await runCli(cacheDir, [
    'sync',
    '--query',
    'has:exif until:2026-08-01',
    '--continue',
  ]);
  expect(result.status).toBe(1);
  expect(result.stderr).toMatch(/--continue/);
  expect(result.stderr).toMatch(/date:|since:|until:/);
});

test('sync does not fetch a capture it already has', async () => {
  const cacheDir = createTempCacheDir();
  const id = `cc${'0'.repeat(30)}`;
  const lean = {
    image_id: id,
    permalink_url: `https://gyazo.com/${id}`,
    url: `https://i.gyazo.com/${id}.jpg`,
    type: 'jpg',
    created_at: new Date().toISOString(),
    metadata: { app: 'Gyazo Android' },
  };
  // A cached detail as the API really returns it: the OCR text is under
  // metadata, and the top-level ocr field is null.
  writeImageCache(cacheDir, id, {
    ...lean,
    ocr: null,
    metadata: { app: 'Gyazo Android', ocr: { locale: 'und', description: 'すでに取得済み' } },
  });

  const stub = await startStubServer((req, res) => {
    const url = new URL(req.url || '', 'http://127.0.0.1');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(url.pathname === '/api/search' ? [lean] : lean));
  });

  try {
    const result = await runCli(cacheDir, ['sync', '--query', 'has:exif', '--max-pages', '1'], {
      apiOrigin: stub.origin,
    });
    expect(result.status).toBe(0);
    // The search page is fetched; the detail behind it is not.
    expect(stub.requests.some((request) => request.url.startsWith('/api/search'))).toBe(true);
    expect(stub.requests.filter((request) => request.url.startsWith('/api/images/'))).toHaveLength(0);
  } finally {
    await stub.close();
  }
});

test('sync --refresh fetches it anyway', async () => {
  const cacheDir = createTempCacheDir();
  const id = `dd${'0'.repeat(30)}`;
  const lean = {
    image_id: id,
    permalink_url: `https://gyazo.com/${id}`,
    url: `https://i.gyazo.com/${id}.jpg`,
    type: 'jpg',
    created_at: new Date().toISOString(),
    metadata: { app: 'Gyazo Android' },
  };
  writeImageCache(cacheDir, id, { ...lean, metadata: { ocr: { description: 'old' } } });

  const stub = await startStubServer((req, res) => {
    const url = new URL(req.url || '', 'http://127.0.0.1');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(url.pathname === '/api/search' ? [lean] : lean));
  });

  try {
    await runCli(cacheDir, ['sync', '--query', 'has:exif', '--max-pages', '1', '--refresh'], {
      apiOrigin: stub.origin,
    });
    expect(stub.requests.filter((request) => request.url.startsWith('/api/images/'))).toHaveLength(1);
  } finally {
    await stub.close();
  }
});

test('sync --query refuses a date range, and names what to use instead', async () => {
  const cacheDir = createTempCacheDir();
  for (const args of [
    ['sync', '--query', 'has:exif', '--days', '7'],
    ['sync', '--query', 'has:exif', '--date', '2026-08'],
  ]) {
    const result = await runCli(cacheDir, args);
    expect(result.status, args.join(' ')).toBe(1);
    expect(result.stderr).toMatch(/--query cannot be used with --date or --days/);
    expect(result.stderr).toMatch(/date:|since:/);
  }
});

test('search asks for the page and the page size it was given', async () => {
  const cacheDir = createTempCacheDir();
  const stub = await startStubServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify([]));
  });
  try {
    const first = await runCli(cacheDir, ['search', 'cat', '--json'], { apiOrigin: stub.origin });
    expect(first.status).toBe(0);
    const third = await runCli(cacheDir, ['search', 'cat', '--page', '3', '--json'], {
      apiOrigin: stub.origin,
    });
    expect(third.status).toBe(0);

    const sized = await runCli(cacheDir, ['search', 'cat', '--limit', '50', '--json'], {
      apiOrigin: stub.origin,
    });
    expect(sized.status).toBe(0);

    const asked = stub.requests
      .filter((request) => request.url.startsWith('/api/search'))
      .map((request) => {
        const params = new URL(request.url, 'http://127.0.0.1').searchParams;
        return `${params.get('page')}/${params.get('per')}`;
      });
    // The API calls the page size `per`, and the default matches `ls`.
    expect(asked).toEqual(['1/20', '3/20', '1/50']);
  } finally {
    await stub.close();
  }
});

test('search rejects a page or a limit that is not a positive integer', async () => {
  const cacheDir = createTempCacheDir();
  const stub = await startStubServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify([]));
  });
  try {
    for (const page of ['0', '-1', 'two']) {
      const result = await runCli(cacheDir, ['search', 'cat', '--page', page], {
        apiOrigin: stub.origin,
      });
      expect(result.status, `--page ${page}`).toBe(1);
      expect(result.stderr).toMatch(/--page must be a positive integer/);
    }
    for (const limit of ['0', '-1', 'many']) {
      const result = await runCli(cacheDir, ['search', 'cat', '--limit', limit], {
        apiOrigin: stub.origin,
      });
      expect(result.status, `--limit ${limit}`).toBe(1);
      expect(result.stderr).toMatch(/--limit must be a positive integer/);
    }
    expect(stub.requests).toHaveLength(0);
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
