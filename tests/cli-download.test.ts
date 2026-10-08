import { test, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createTempCacheDir, runCli, startStubServer, writeImageCache } from './helpers';

const FAST_RETRY = { GYAZO_RETRY_BASE_MS: '1', GYAZO_RETRY_MAX_MS: '5' };

function cookieFile(dir: string): string {
  const file = path.join(dir, 'cookie.json');
  fs.writeFileSync(file, JSON.stringify([{ name: 'Gyazo_session', value: 's', domain: '.gyazo.com' }]));
  return file;
}

const idOf = (n: number) => n.toString(16).padStart(32, '0');
const bodyOf = (id: string, size = 100) => Buffer.alloc(size, id.slice(-2));
const imagePath = (dir: string, id: string, ext: string) => path.join(dir, 'images', id[0], id[1], `${id}.${ext}`);

interface Route {
  /** Serve this body on `/<id>.<ext>` (public) and/or `/s/<id>.<ext>` (private). */
  public?: boolean;
  private?: boolean;
  status?: number;
  body?: Buffer;
  ext: string;
  /** Send no Content-Length (chunked), so the size cannot vouch for the body. */
  chunked?: boolean;
  /** Answer 200 with this content type instead of an image one. */
  contentType?: string;
  /** Serve this video on `/<id>.mp4`. */
  mp4?: Buffer;
  /** The capture still exists: its metadata (`/<id>.json`) answers 200, not 404. */
  meta?: boolean;
}

/**
 * A stand-in for i.gyazo.com and gyazo.com/<id>/raw. Like the real one it wants
 * the session cookie (503 without), serves public images at /<id>.<ext> and
 * private ones under /s/, and redirects /<id>/raw to wherever the body lives.
 */
function imageStub(routes: Record<string, Route>, options: { delayMs?: number } = {}) {
  const hits: string[] = [];
  const attempts: Record<string, number> = {};
  const stub = startStubServer((req, res) => {
    const url = new URL(req.url || '', 'http://127.0.0.1');
    hits.push(url.pathname);
    const hasCookie = String(req.headers.cookie || '').includes('Gyazo_session');
    if (!hasCookie) { res.writeHead(503, { 'content-type': 'text/plain' }); res.end('no cookie'); return; }

    let m = /^\/(s\/)?([0-9a-f]{32})\.(\w+)$/.exec(url.pathname);
    if (m) {
      const [, priv, id, ext] = m;
      const r = routes[id];
      if (ext === 'json') {
        if (!r || !r.meta) { res.writeHead(404); res.end('{}'); return; }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
        return;
      }
      if (ext === 'mp4') {
        if (!r || !r.mp4) { res.writeHead(404); res.end('nope'); return; }
        res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': String(r.mp4.length) });
        res.end(r.mp4);
        return;
      }
      if (!r || r.ext !== ext || (priv ? !r.private : !r.public)) { res.writeHead(404); res.end('nope'); return; }
      attempts[id] = (attempts[id] || 0) + 1;
      if (r.status && r.status !== 200 && attempts[id] <= (r.status === 503 ? 2 : 99)) { res.writeHead(r.status); res.end('x'); return; }
      const body = r.body ?? bodyOf(id);
      const headers: Record<string, string> = { 'content-type': r.contentType || `image/${ext}` };
      if (!r.chunked) headers['content-length'] = String(body.length);
      const send = () => { res.writeHead(200, headers); res.end(body); };
      if (options.delayMs) setTimeout(send, options.delayMs); else send();
      return;
    }
    m = /^\/([0-9a-f]{32})\/raw$/.exec(url.pathname);
    if (m) {
      const r = routes[m[1]];
      if (!r) { res.writeHead(404); res.end('nope'); return; }
      const target = r.private ? `/s/${m[1]}.${r.ext}` : `/${m[1]}.${r.ext}`;
      res.writeHead(301, { location: target });
      res.end();
      return;
    }
    res.writeHead(404); res.end('{}');
  });
  return { stub, hits };
}

function record(id: string, extra: Record<string, unknown> = {}) {
  return { image_id: id, type: 'jpg', created_at: '2026-08-30T00:00:00.000Z', file_size: 100, ...extra };
}

async function run(cacheDir: string, stub: { origin: string }, args: string[] = []) {
  return runCli(cacheDir, ['download', ...args], {
    webOrigin: stub.origin,
    cookieFile: cookieFile(cacheDir),
    env: { GYAZO_IMAGE_ORIGIN: stub.origin, ...FAST_RETRY },
  });
}

test('download puts the image body next to the json, named by its type', async () => {
  const cacheDir = createTempCacheDir();
  const a = idOf(0xaa1);
  const b = idOf(0xbb2);
  writeImageCache(cacheDir, a, record(a, { type: 'jpg' }));
  writeImageCache(cacheDir, b, record(b, { type: 'png' }));
  const { stub: pending, hits } = imageStub({ [a]: { public: true, ext: 'jpg' }, [b]: { public: true, ext: 'png' } });
  const stub = await pending;
  try {
    const result = await run(cacheDir, stub);
    expect(result.status).toBe(0);
    expect(fs.readFileSync(imagePath(cacheDir, a, 'jpg'))).toEqual(bodyOf(a));
    expect(fs.readFileSync(imagePath(cacheDir, b, 'png'))).toEqual(bodyOf(b));
    expect(fs.existsSync(path.join(path.dirname(imagePath(cacheDir, a, 'jpg')), `${a}.json`))).toBe(true);
    expect(result.stdout).toMatch(/Downloaded 2/);
    expect(hits.length).toBe(2);
  } finally {
    await stub.close();
  }
});

test('download is idempotent: a second run fetches nothing', async () => {
  const cacheDir = createTempCacheDir();
  const a = idOf(0xaa1);
  writeImageCache(cacheDir, a, record(a));
  const { stub: pending, hits } = imageStub({ [a]: { public: true, ext: 'jpg' } });
  const stub = await pending;
  try {
    await run(cacheDir, stub);
    hits.length = 0;
    const second = await run(cacheDir, stub);
    expect(second.status).toBe(0);
    expect(hits).toHaveLength(0);
    expect(second.stdout).toMatch(/Downloaded 0/);
    expect(second.stdout).toMatch(/1 already present/);
  } finally {
    await stub.close();
  }
});

test('a private image is found through the url in its json', async () => {
  const cacheDir = createTempCacheDir();
  const a = idOf(0xaa1);
  const { stub: pending } = imageStub({ [a]: { private: true, ext: 'jpg' } });
  const stub = await pending;
  try {
    writeImageCache(cacheDir, a, record(a, { access_policy: 'only_me', url: `${stub.origin}/s/${a}.jpg` }));
    const result = await run(cacheDir, stub);
    expect(result.status).toBe(0);
    expect(fs.readFileSync(imagePath(cacheDir, a, 'jpg'))).toEqual(bodyOf(a));
  } finally {
    await stub.close();
  }
});

test('with no usable url it falls back to the /raw redirect', async () => {
  const cacheDir = createTempCacheDir();
  const a = idOf(0xaa1);
  // Private, and the json carries no url: the public path 404s, /raw redirects to /s/.
  writeImageCache(cacheDir, a, record(a, { access_policy: 'only_me' }));
  const { stub: pending, hits } = imageStub({ [a]: { private: true, ext: 'jpg' } });
  const stub = await pending;
  try {
    const result = await run(cacheDir, stub);
    expect(result.status).toBe(0);
    expect(fs.readFileSync(imagePath(cacheDir, a, 'jpg'))).toEqual(bodyOf(a));
    expect(hits).toContain(`/${a}/raw`);
    expect(hits).toContain(`/s/${a}.jpg`);
  } finally {
    await stub.close();
  }
});

test('a complete body that disagrees with file_size is kept and noted', async () => {
  // Gyazo's recorded file_size and the file it serves really do differ for some
  // PNGs (both valid, same pixels). The transfer was whole, so the file is kept.
  const cacheDir = createTempCacheDir();
  const a = idOf(0xaa1);
  writeImageCache(cacheDir, a, record(a, { file_size: 100 }));
  const { stub: pending } = imageStub({ [a]: { public: true, ext: 'jpg', body: bodyOf(a, 60) } });
  const stub = await pending;
  try {
    const result = await run(cacheDir, stub);
    expect(result.status).toBe(0);
    expect(fs.readFileSync(imagePath(cacheDir, a, 'jpg'))).toEqual(bodyOf(a, 60));
    expect(result.stdout).toMatch(/1 differ from the recorded file_size/);
    expect(fs.readFileSync(path.join(cacheDir, 'download-report.tsv'), 'utf8')).toMatch(new RegExp(`${a}\\tsize differs`));
  } finally {
    await stub.close();
  }
});

test('with no Content-Length, a size that disagrees with file_size is discarded as a failure', async () => {
  // Chunked: nothing but file_size can say the body is whole, so a mismatch is
  // treated as a damaged transfer.
  const cacheDir = createTempCacheDir();
  const a = idOf(0xaa1);
  writeImageCache(cacheDir, a, record(a, { file_size: 100 }));
  const { stub: pending } = imageStub({ [a]: { public: true, ext: 'jpg', body: bodyOf(a, 60), chunked: true } });
  const stub = await pending;
  try {
    const result = await run(cacheDir, stub);
    expect(result.status).toBe(1);
    expect(fs.existsSync(imagePath(cacheDir, a, 'jpg'))).toBe(false);
    expect(fs.existsSync(`${imagePath(cacheDir, a, 'jpg')}.part`)).toBe(false);
    expect(result.stdout).toMatch(/1 failed/);
    expect(fs.readFileSync(path.join(cacheDir, 'download-report.tsv'), 'utf8')).toContain(a);
  } finally {
    await stub.close();
  }
});

test('a 200 that is not an image (an error page) is a failure and saves nothing', async () => {
  const cacheDir = createTempCacheDir();
  const a = idOf(0xaa1);
  writeImageCache(cacheDir, a, record(a));
  const { stub: pending } = imageStub({ [a]: { public: true, ext: 'jpg', contentType: 'text/html', body: Buffer.from('<html>oops</html>') } });
  const stub = await pending;
  try {
    const result = await run(cacheDir, stub);
    expect(result.status).toBe(1);
    expect(fs.existsSync(imagePath(cacheDir, a, 'jpg'))).toBe(false);
    expect(fs.readFileSync(path.join(cacheDir, 'download-report.tsv'), 'utf8')).toMatch(/content-type/i);
  } finally {
    await stub.close();
  }
});

test('a capture with no gif but an mp4 falls back to the mp4 and is not gone', async () => {
  // Gyazo keeps some recordings only as mp4: the record says type gif, file_size 0,
  // has_mp4. There is no gif to find, so asking for one would call it gone.
  const cacheDir = createTempCacheDir();
  const a = idOf(0xaa1);
  writeImageCache(cacheDir, a, record(a, { type: 'gif', file_size: 0, has_mp4: true }));
  const video = Buffer.alloc(300, 7);
  const { stub: pending, hits } = imageStub({ [a]: { ext: 'gif', mp4: video } });
  const stub = await pending;
  try {
    const result = await run(cacheDir, stub);
    expect(result.status).toBe(0);
    expect(fs.readFileSync(imagePath(cacheDir, a, 'mp4'))).toEqual(video);
    expect(fs.existsSync(imagePath(cacheDir, a, 'gif'))).toBe(false);
    // The gif is asked for first (a recorded file_size of 0 does not mean there is
    // none), and the mp4 is the fallback once every gif URL has 404ed.
    expect(hits).toContain(`/${a}.gif`);
    expect(result.stdout).toMatch(/Downloaded 1/);
    expect(result.stdout).toMatch(/0 gone/);
  } finally {
    await stub.close();
  }
});

test('has_mp4 with file_size 0 does not mean there is no gif: the gif is fetched when it exists', async () => {
  // 36 of 40 such records had a real gif on Gyazo. Assuming none lost them.
  const cacheDir = createTempCacheDir();
  const a = idOf(0xaa1);
  writeImageCache(cacheDir, a, record(a, { type: 'gif', file_size: 0, has_mp4: true }));
  const video = Buffer.alloc(300, 7);
  const { stub: pending, hits } = imageStub({ [a]: { public: true, ext: 'gif', mp4: video } });
  const stub = await pending;
  try {
    const result = await run(cacheDir, stub);
    expect(result.status).toBe(0);
    expect(fs.readFileSync(imagePath(cacheDir, a, 'gif'))).toEqual(bodyOf(a));
    expect(fs.existsSync(imagePath(cacheDir, a, 'mp4'))).toBe(false); // not needed: the gif is the body
    expect(hits).not.toContain(`/${a}.mp4`);
  } finally {
    await stub.close();
  }
});

test('a record that has only its mp4 on disk gets its gif on a re-run when the gif exists', async () => {
  // The repair path for captures an earlier run saved as mp4 only.
  const cacheDir = createTempCacheDir();
  const a = idOf(0xaa1);
  writeImageCache(cacheDir, a, record(a, { type: 'gif', file_size: 0, has_mp4: true }));
  fs.writeFileSync(imagePath(cacheDir, a, 'mp4'), Buffer.alloc(300, 7));
  const { stub: pending, hits } = imageStub({ [a]: { public: true, ext: 'gif', mp4: Buffer.alloc(300, 7) } });
  const stub = await pending;
  try {
    const result = await run(cacheDir, stub);
    expect(result.status).toBe(0);
    expect(fs.readFileSync(imagePath(cacheDir, a, 'gif'))).toEqual(bodyOf(a));
    expect(hits).not.toContain(`/${a}.mp4`); // already had it
  } finally {
    await stub.close();
  }
});

test('a record with an mp4 on disk and no gif anywhere is settled by the mp4, not gone', async () => {
  const cacheDir = createTempCacheDir();
  const a = idOf(0xaa1);
  writeImageCache(cacheDir, a, record(a, { type: 'gif', file_size: 0, has_mp4: true }));
  fs.writeFileSync(imagePath(cacheDir, a, 'mp4'), Buffer.alloc(300, 7));
  const { stub: pending } = imageStub({}); // no gif on the server
  const stub = await pending;
  try {
    const result = await run(cacheDir, stub);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/0 gone/);
    expect(result.stdout).toMatch(/1 already present/);
  } finally {
    await stub.close();
  }
});

test('a video-only capture whose mp4 is missing is gone', async () => {
  const cacheDir = createTempCacheDir();
  const a = idOf(0xaa1);
  writeImageCache(cacheDir, a, record(a, { type: 'gif', file_size: 0, has_mp4: true }));
  const { stub: pending } = imageStub({});
  const stub = await pending;
  try {
    const result = await run(cacheDir, stub);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/1 gone/);
  } finally {
    await stub.close();
  }
});

test('a gif that also has an mp4 gets the mp4 only with --mp4', async () => {
  const cacheDir = createTempCacheDir();
  const a = idOf(0xaa1);
  writeImageCache(cacheDir, a, record(a, { type: 'gif', file_size: 100, has_mp4: true }));
  const video = Buffer.alloc(300, 9);
  const { stub: pending, hits } = imageStub({ [a]: { public: true, ext: 'gif', mp4: video } });
  const stub = await pending;
  try {
    const plain = await run(cacheDir, stub);
    expect(plain.status).toBe(0);
    expect(fs.existsSync(imagePath(cacheDir, a, 'gif'))).toBe(true);
    expect(fs.existsSync(imagePath(cacheDir, a, 'mp4'))).toBe(false); // a derivative: not asked for
    expect(hits).not.toContain(`/${a}.mp4`);

    hits.length = 0;
    const withMp4 = await run(cacheDir, stub, ['--mp4']);
    expect(withMp4.status).toBe(0);
    expect(fs.readFileSync(imagePath(cacheDir, a, 'mp4'))).toEqual(video);
    expect(hits).not.toContain(`/${a}.gif`); // the gif was already there
  } finally {
    await stub.close();
  }
});

test('a body that 5xxs for a deleted capture (its metadata 404s) is gone, not a failure', async () => {
  // Gyazo answers 503, not 404, for the body of a capture that has been deleted.
  const cacheDir = createTempCacheDir();
  const a = idOf(0xaa1);
  writeImageCache(cacheDir, a, record(a));
  const { stub: pending } = imageStub({ [a]: { public: true, ext: 'jpg', status: 500 } }); // no meta: deleted
  const stub = await pending;
  try {
    const result = await run(cacheDir, stub);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/1 gone/);
    expect(result.stdout).toMatch(/0 failed/);
    expect(fs.readFileSync(path.join(cacheDir, 'download-report.tsv'), 'utf8')).toMatch(new RegExp(`${a}\\tgone \\(deleted`));
  } finally {
    await stub.close();
  }
});

test('a body that 5xxs for a capture that still exists stays a failure', async () => {
  const cacheDir = createTempCacheDir();
  const a = idOf(0xaa1);
  writeImageCache(cacheDir, a, record(a));
  const { stub: pending } = imageStub({ [a]: { public: true, ext: 'jpg', status: 500, meta: true } });
  const stub = await pending;
  try {
    const result = await run(cacheDir, stub);
    expect(result.status).toBe(1);
    expect(result.stdout).toMatch(/1 failed/);
    expect(result.stdout).toMatch(/0 gone/);
  } finally {
    await stub.close();
  }
});

test('two downloads of the same cache at once both succeed and leave only whole files', async () => {
  // The slow batch and a targeted run can overlap on the same images. They must
  // not trip over one another's temporary file.
  const cacheDir = createTempCacheDir();
  const ids = Array.from({ length: 40 }, (_, i) => idOf(0x2000 + i));
  const routes: Record<string, Route> = {};
  for (const id of ids) {
    writeImageCache(cacheDir, id, record(id, { file_size: 400 }));
    routes[id] = { public: true, ext: 'jpg', body: bodyOf(id, 400) };
  }
  const { stub: pending } = imageStub(routes, { delayMs: 25 });
  const stub = await pending;
  try {
    const opts = {
      webOrigin: stub.origin,
      cookieFile: cookieFile(cacheDir),
      env: { GYAZO_IMAGE_ORIGIN: stub.origin, ...FAST_RETRY },
    };
    const [a, b] = await Promise.all([
      runCli(cacheDir, ['download', '--jobs', '8'], opts),
      runCli(cacheDir, ['download', '--jobs', '8'], opts),
    ]);
    expect(a.status).toBe(0);
    expect(b.status).toBe(0);
    for (const id of ids) expect(fs.readFileSync(imagePath(cacheDir, id, 'jpg'))).toEqual(bodyOf(id, 400));
    const leftovers = fs.readdirSync(path.join(cacheDir, 'images', '0', '0')).filter((n) => n.endsWith('.part'));
    expect(leftovers).toEqual([]);
  } finally {
    await stub.close();
  }
});

test('the report is appended to across runs, never wiped by a later one', async () => {
  const cacheDir = createTempCacheDir();
  const gone = idOf(0xaa1);
  const fine = idOf(0xbb2);
  writeImageCache(cacheDir, gone, record(gone, { created_at: '2020-07-01T00:00:00.000Z' }));
  writeImageCache(cacheDir, fine, record(fine, { created_at: '2024-01-01T00:00:00.000Z' }));
  const { stub: pending } = imageStub({ [fine]: { public: true, ext: 'jpg' } }); // `gone` is unknown to it
  const stub = await pending;
  try {
    const first = await run(cacheDir, stub, ['--year', '2020']);
    expect(first.stdout).toMatch(/1 gone/);
    const second = await run(cacheDir, stub, ['--year', '2024']);
    expect(second.status).toBe(0);
    expect(fs.readFileSync(path.join(cacheDir, 'download-report.tsv'), 'utf8')).toContain(gone);
  } finally {
    await stub.close();
  }
});

test('a stale .part from a killed run is cleaned up, a fresh one is left alone', async () => {
  const cacheDir = createTempCacheDir();
  const a = idOf(0xaa1);
  const stale = idOf(0xcc3);
  const live = idOf(0xdd4);
  writeImageCache(cacheDir, a, record(a));
  writeImageCache(cacheDir, stale, record(stale, { file_size: 100 }));
  writeImageCache(cacheDir, live, record(live, { file_size: 100 }));
  const dirOf = (id: string) => path.join(cacheDir, 'images', id[0], id[1]);
  const stalePart = path.join(dirOf(stale), `${stale}.jpg.999.old.part`);
  const livePart = path.join(dirOf(live), `${live}.jpg.998.new.part`);
  fs.writeFileSync(stalePart, 'x');
  fs.writeFileSync(livePart, 'x');
  const twoHoursAgo = new Date(Date.now() - 2 * 3600 * 1000);
  fs.utimesSync(stalePart, twoHoursAgo, twoHoursAgo);
  // (these two have no route, so they 404 and stay "gone": only the cleanup matters here)
  const { stub: pending } = imageStub({ [a]: { public: true, ext: 'jpg' } });
  const stub = await pending;
  try {
    const result = await run(cacheDir, stub);
    expect(result.status).toBe(0);
    expect(fs.existsSync(stalePart)).toBe(false);
    expect(fs.existsSync(livePart)).toBe(true); // might belong to a run that is still going
  } finally {
    await stub.close();
  }
});

test('a transient 503 is retried and then succeeds', async () => {
  const cacheDir = createTempCacheDir();
  const a = idOf(0xaa1);
  writeImageCache(cacheDir, a, record(a));
  const { stub: pending } = imageStub({ [a]: { public: true, ext: 'jpg', status: 503 } });
  const stub = await pending;
  try {
    const result = await run(cacheDir, stub);
    expect(result.status).toBe(0);
    expect(fs.readFileSync(imagePath(cacheDir, a, 'jpg'))).toEqual(bodyOf(a));
  } finally {
    await stub.close();
  }
});

test('an image that 404s everywhere is counted as gone, not as a failure', async () => {
  const cacheDir = createTempCacheDir();
  const a = idOf(0xaa1);
  writeImageCache(cacheDir, a, record(a));
  const { stub: pending } = imageStub({}); // knows nothing about it
  const stub = await pending;
  try {
    const result = await run(cacheDir, stub);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/1 gone/);
    expect(result.stdout).toMatch(/0 failed/);
    expect(fs.readFileSync(path.join(cacheDir, 'download-report.tsv'), 'utf8')).toMatch(new RegExp(`${a}\\tgone`));
  } finally {
    await stub.close();
  }
});

test('--max, --year and --month narrow what is fetched', async () => {
  const cacheDir = createTempCacheDir();
  const ids = [idOf(0x11), idOf(0x22), idOf(0x33)];
  writeImageCache(cacheDir, ids[0], record(ids[0], { created_at: '2020-07-01T00:00:00.000Z' }));
  writeImageCache(cacheDir, ids[1], record(ids[1], { created_at: '2020-08-01T00:00:00.000Z' }));
  writeImageCache(cacheDir, ids[2], record(ids[2], { created_at: '2024-01-01T00:00:00.000Z' }));
  const routes: Record<string, Route> = {};
  for (const id of ids) routes[id] = { public: true, ext: 'jpg' };
  const { stub: pending } = imageStub(routes);
  const stub = await pending;
  try {
    const month = await run(cacheDir, stub, ['--month', '2020-08']);
    expect(month.status).toBe(0);
    expect(fs.existsSync(imagePath(cacheDir, ids[1], 'jpg'))).toBe(true);
    expect(fs.existsSync(imagePath(cacheDir, ids[0], 'jpg'))).toBe(false);

    const year = await run(cacheDir, stub, ['--year', '2020']);
    expect(year.status).toBe(0);
    expect(fs.existsSync(imagePath(cacheDir, ids[0], 'jpg'))).toBe(true);
    expect(fs.existsSync(imagePath(cacheDir, ids[2], 'jpg'))).toBe(false); // 2024 untouched

    const capped = await run(cacheDir, stub, ['--max', '1']);
    expect(capped.status).toBe(0);
    const have = ids.filter((id) => fs.existsSync(imagePath(cacheDir, id, 'jpg'))).length;
    expect(have).toBe(3); // the one left over was fetched, capped at 1 this run
  } finally {
    await stub.close();
  }
});

test('--dry-run reports what would be fetched and fetches nothing', async () => {
  const cacheDir = createTempCacheDir();
  const a = idOf(0xaa1);
  const b = idOf(0xbb2);
  writeImageCache(cacheDir, a, record(a, { file_size: 1000 }));
  writeImageCache(cacheDir, b, record(b, { file_size: 2000 }));
  const { stub: pending, hits } = imageStub({ [a]: { public: true, ext: 'jpg' }, [b]: { public: true, ext: 'jpg' } });
  const stub = await pending;
  try {
    const result = await run(cacheDir, stub, ['--dry-run']);
    expect(result.status).toBe(0);
    expect(hits).toHaveLength(0);
    expect(result.stdout).toMatch(/2 to download/);
    expect(result.stdout).toMatch(/3,000 bytes/);
  } finally {
    await stub.close();
  }
});

test('download without cookies refuses and sends nothing', async () => {
  const cacheDir = createTempCacheDir();
  const a = idOf(0xaa1);
  writeImageCache(cacheDir, a, record(a));
  const { stub: pending, hits } = imageStub({ [a]: { public: true, ext: 'jpg' } });
  const stub = await pending;
  try {
    const result = await runCli(cacheDir, ['download'], {
      webOrigin: stub.origin,
      cookieFile: path.join(cacheDir, 'absent.json'),
      env: { GYAZO_IMAGE_ORIGIN: stub.origin, ...FAST_RETRY },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/cookie/i);
    expect(hits).toHaveLength(0);
  } finally {
    await stub.close();
  }
});

test('a run of consecutive failures stops early instead of hammering', async () => {
  const cacheDir = createTempCacheDir();
  const ids = Array.from({ length: 40 }, (_, i) => idOf(0x1000 + i));
  const routes: Record<string, Route> = {};
  for (const id of ids) {
    writeImageCache(cacheDir, id, record(id));
    routes[id] = { public: true, ext: 'jpg', status: 500, meta: true }; // always 500, but the capture exists: an outage
  }
  const { stub: pending, hits } = imageStub(routes);
  const stub = await pending;
  try {
    const result = await run(cacheDir, stub, ['--jobs', '1']);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/consecutive/i);
    // Stopped well before trying all 40 images.
    const tried = new Set(hits.filter((h) => h.endsWith('.jpg'))).size;
    expect(tried).toBeLessThan(40);
  } finally {
    await stub.close();
  }
});
