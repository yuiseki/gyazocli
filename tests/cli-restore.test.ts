import { test, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createTempCacheDir, runCli, startStubServer } from './helpers';

const ID_A = `da${'0'.repeat(30)}`;
const ID_B = `db${'0'.repeat(30)}`;
const ID_C = `dc${'0'.repeat(30)}`;

/**
 * The incident-protection endpoint: a page carrying a CSRF token, and a PATCH
 * that wants it back and a batch of image_ids. Records the batches it is sent.
 */
function restoreStub() {
  const batches: string[][] = [];
  const handler = (req: any, res: any, body: Buffer) => {
    const url = new URL(req.url || '', 'http://127.0.0.1');
    if (req.method === 'PATCH' && url.pathname === '/api/internal/images_incident_protection') {
      if (req.headers['x-csrf-token'] !== 'tok') {
        res.writeHead(422, { 'Content-Type': 'text/html' }); res.end(''); return;
      }
      batches.push(JSON.parse(body.toString()).image_ids);
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true}'); return;
    }
    // Any capture page carries the token.
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<html><head><meta name="csrf-token" content="tok"></head></html>');
  };
  return { handler, batches };
}

function cookieFile(dir: string): string {
  const file = path.join(dir, 'cookie.json');
  fs.writeFileSync(file, JSON.stringify([{ name: 'Gyazo_session', value: 's', domain: '.gyazo.com' }]));
  return file;
}

test('restore sends the image ids to the incident-protection endpoint', async () => {
  const cacheDir = createTempCacheDir();
  const { handler, batches } = restoreStub();
  const stub = await startStubServer(handler);
  try {
    const result = await runCli(cacheDir, ['restore', `https://gyazo.com/${ID_A}`, `https://gyazo.com/${ID_B}`], {
      webOrigin: stub.origin,
      cookieFile: cookieFile(cacheDir),
    });
    expect(result.status).toBe(0);
    expect(batches.flat().sort()).toEqual([ID_A, ID_B].sort());
    expect(result.stdout).toMatch(/2 restored/);
  } finally {
    await stub.close();
  }
});

test('restore reads urls from stdin, drops noise, dedupes, and batches', async () => {
  const cacheDir = createTempCacheDir();
  const { handler, batches } = restoreStub();
  const stub = await startStubServer(handler);
  const input = [
    `https://gyazo.com/${ID_A}`,
    `https://i.gyazo.com/${ID_A}.png`,     // same, other host
    'https://gyazo.com/search/x',           // noise
    'https://gyazo.com/signup',             // noise
    `https://gyazo.com/${ID_B}`,
    `https://gyazo.com/${ID_C}`,
  ].join('\n') + '\n';
  try {
    const result = await runCli(cacheDir, ['restore', '--batch-size', '2'], {
      webOrigin: stub.origin,
      cookieFile: cookieFile(cacheDir),
      input,
    });
    expect(result.status).toBe(0);
    // Three unique captures, in batches of two.
    expect(batches.map((b) => b.length)).toEqual([2, 1]);
    expect(batches.flat().sort()).toEqual([ID_A, ID_B, ID_C].sort());
    expect(result.stdout).toMatch(/2 ignored/);
  } finally {
    await stub.close();
  }
});

test('restore records what it restored and skips it next time', async () => {
  const cacheDir = createTempCacheDir();
  const { handler, batches } = restoreStub();
  const stub = await startStubServer(handler);
  const out = path.join(cacheDir, 'restored.txt');
  try {
    await runCli(cacheDir, ['restore', `https://gyazo.com/${ID_A}`, '--out', out], {
      webOrigin: stub.origin, cookieFile: cookieFile(cacheDir),
    });
    expect(fs.readFileSync(out, 'utf8')).toContain(ID_A);

    batches.length = 0;
    const second = await runCli(cacheDir, ['restore', `https://gyazo.com/${ID_A}`, `https://gyazo.com/${ID_B}`, '--out', out], {
      webOrigin: stub.origin, cookieFile: cookieFile(cacheDir),
    });
    expect(batches.flat()).toEqual([ID_B]);
    expect(second.stdout).toMatch(/1 already done/);
  } finally {
    await stub.close();
  }
});

test('restore gets the CSRF token from a session page when the captures 404', async () => {
  // Incident-protected captures 404 on their own permalink page, so the run
  // token must come from a page that always renders (gyazo.com/captures).
  const cacheDir = createTempCacheDir();
  const batches: string[][] = [];
  const stub = await startStubServer((req, res, body) => {
    const url = new URL(req.url || '', 'http://127.0.0.1');
    if (req.method === 'PATCH' && url.pathname === '/api/internal/images_incident_protection') {
      if (req.headers['x-csrf-token'] !== 'tok') {
        res.writeHead(422, { 'Content-Type': 'text/html' }); res.end(''); return;
      }
      batches.push(JSON.parse(body.toString()).image_ids);
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true}'); return;
    }
    if (url.pathname === '/captures') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html><head><meta name="csrf-token" content="tok"></head></html>'); return;
    }
    // Every capture permalink is withheld.
    res.writeHead(404, { 'Content-Type': 'text/html' }); res.end('not found');
  });
  try {
    const result = await runCli(cacheDir, ['restore', `https://gyazo.com/${ID_A}`, `https://gyazo.com/${ID_B}`], {
      webOrigin: stub.origin,
      cookieFile: cookieFile(cacheDir),
    });
    expect(result.status).toBe(0);
    expect(batches.flat().sort()).toEqual([ID_A, ID_B].sort());
  } finally {
    await stub.close();
  }
});

test('restore without cookies refuses and sends nothing', async () => {
  const cacheDir = createTempCacheDir();
  const { handler, batches } = restoreStub();
  const stub = await startStubServer(handler);
  try {
    const result = await runCli(cacheDir, ['restore', `https://gyazo.com/${ID_A}`], {
      webOrigin: stub.origin,
      cookieFile: path.join(cacheDir, 'absent.json'),
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/cookie/i);
    expect(batches).toHaveLength(0);
  } finally {
    await stub.close();
  }
});

test('a failed batch is reported and recorded, and the run exits non-zero', async () => {
  const cacheDir = createTempCacheDir();
  const failed = path.join(cacheDir, 'failed.txt');
  const stub = await startStubServer((req, res, body) => {
    const url = new URL(req.url || '', 'http://127.0.0.1');
    if (req.method === 'PATCH' && url.pathname === '/api/internal/images_incident_protection') {
      res.writeHead(500, { 'Content-Type': 'text/html' }); res.end(''); return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<html><head><meta name="csrf-token" content="tok"></head></html>');
  });
  try {
    const result = await runCli(cacheDir, ['restore', `https://gyazo.com/${ID_A}`, '--failed', failed], {
      webOrigin: stub.origin, cookieFile: cookieFile(cacheDir),
    });
    expect(result.status).toBe(1);
    expect(fs.readFileSync(failed, 'utf8')).toContain(ID_A);
  } finally {
    await stub.close();
  }
});
