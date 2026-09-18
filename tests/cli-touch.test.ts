import { test, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createTempCacheDir, runCli, startStubServer, type StubHandler } from './helpers';

const ID_A = `ba${'0'.repeat(30)}`;
const ID_B = `bb${'0'.repeat(30)}`;

/**
 * The web app's own route: a page carrying a CSRF token, and a PATCH that wants
 * it back. Records the access_policy values it is told, in order.
 */
function touchStub(): { handler: StubHandler; patches: Array<{ id: string; policy: string }> } {
  const patches: Array<{ id: string; policy: string }> = [];
  const handler: StubHandler = (req, res, body) => {
    const url = new URL(req.url || '', 'http://127.0.0.1');
    if (req.method === 'PATCH' && url.pathname.startsWith('/api/internal/images/')) {
      if (req.headers['x-csrf-token'] !== 'tok') {
        res.writeHead(422, { 'Content-Type': 'text/html' });
        res.end('');
        return;
      }
      const id = url.pathname.split('/').pop() || '';
      patches.push({ id, policy: JSON.parse(body.toString()).access_policy });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ image_id: id, access_policy: JSON.parse(body.toString()).access_policy }));
      return;
    }
    // The detail endpoint: everything here is public unless a test says otherwise.
    if (url.pathname.startsWith('/api/images/')) {
      const id = url.pathname.split('/').pop() || '';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ image_id: id, access_policy: 'anyone' }));
      return;
    }
    // Any capture page carries the token.
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<html><head><meta name="csrf-token" content="tok"></head></html>');
  };
  return { handler, patches };
}

function cookieFile(dir: string): string {
  const file = path.join(dir, 'cookie.json');
  fs.writeFileSync(file, JSON.stringify([{ name: 'Gyazo_session', value: 's', domain: '.gyazo.com' }]));
  return file;
}

test('touch cycles a capture only_me then back to anyone', async () => {
  const cacheDir = createTempCacheDir();
  const { handler, patches } = touchStub();
  const stub = await startStubServer(handler);
  try {
    const result = await runCli(cacheDir, ['touch', `https://gyazo.com/${ID_A}`], {
      apiOrigin: stub.origin,
      webOrigin: stub.origin,
      cookieFile: cookieFile(cacheDir),
    });
    expect(result.status).toBe(0);
    expect(patches).toEqual([
      { id: ID_A, policy: 'only_me' },
      { id: ID_A, policy: 'anyone' },
    ]);
    expect(result.stdout).toMatch(new RegExp(ID_A));
  } finally {
    await stub.close();
  }
});

test('touch takes several urls, and reads them from stdin', async () => {
  const cacheDir = createTempCacheDir();
  const { handler, patches } = touchStub();
  const stub = await startStubServer(handler);
  try {
    const result = await runCli(cacheDir, ['touch'], {
      apiOrigin: stub.origin,
      webOrigin: stub.origin,
      cookieFile: cookieFile(cacheDir),
      input: `https://gyazo.com/${ID_A}\nhttps://gyazo.com/${ID_B}\n`,
    });
    expect(result.status).toBe(0);
    // Two captures, each cycled, in the order given.
    expect(patches.map((p) => p.id)).toEqual([ID_A, ID_A, ID_B, ID_B]);
    expect(patches.filter((p) => p.id === ID_B).map((p) => p.policy)).toEqual(['only_me', 'anyone']);
  } finally {
    await stub.close();
  }
});

test('touch without cookies explains, and touches nothing', async () => {
  const cacheDir = createTempCacheDir();
  const { handler, patches } = touchStub();
  const stub = await startStubServer(handler);
  try {
    const result = await runCli(cacheDir, ['touch', `https://gyazo.com/${ID_A}`], {
      apiOrigin: stub.origin,
      webOrigin: stub.origin,
      cookieFile: path.join(cacheDir, 'absent.json'),
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/cookie/i);
    expect(patches).toHaveLength(0);
  } finally {
    await stub.close();
  }
});

test('a non-Gyazo argument is ignored, not an error', async () => {
  const cacheDir = createTempCacheDir();
  const { handler, patches } = touchStub();
  const stub = await startStubServer(handler);
  try {
    const result = await runCli(cacheDir, ['touch', 'https://example.com/x'], {
      apiOrigin: stub.origin,
      webOrigin: stub.origin,
      cookieFile: cookieFile(cacheDir),
    });
    // Noise, not a failure: nothing patched, and it exits clean.
    expect(result.status).toBe(0);
    expect(patches).toHaveLength(0);
    expect(result.stdout).toMatch(/ignored/i);
  } finally {
    await stub.close();
  }
});

test('touch keeps going when one capture fails, and exits non-zero', async () => {
  const cacheDir = createTempCacheDir();
  const patches: Array<{ id: string; policy: string }> = [];
  const stub = await startStubServer((req, res, body) => {
    const url = new URL(req.url || '', 'http://127.0.0.1');
    if (req.method === 'PATCH' && url.pathname.startsWith('/api/internal/images/')) {
      const id = url.pathname.split('/').pop() || '';
      // The first capture's PATCH fails; the second succeeds.
      if (id === ID_A) {
        res.writeHead(500, { 'Content-Type': 'text/html' });
        res.end('');
        return;
      }
      patches.push({ id, policy: JSON.parse(body.toString()).access_policy });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<html><head><meta name="csrf-token" content="tok"></head></html>');
  });
  try {
    const result = await runCli(cacheDir, ['touch', `https://gyazo.com/${ID_A}`, `https://gyazo.com/${ID_B}`], {
      apiOrigin: stub.origin,
      webOrigin: stub.origin,
      cookieFile: cookieFile(cacheDir),
    });
    // The second still gets done.
    expect(patches.map((p) => p.id)).toEqual([ID_B, ID_B]);
    // But the run reports the failure.
    expect(result.status).toBe(1);
    expect(result.stderr + result.stdout).toMatch(new RegExp(ID_A));
  } finally {
    await stub.close();
  }
});

test('touch refuses a capture that is only_me', async () => {
  const cacheDir = createTempCacheDir();
  const patches: Array<{ id: string; policy: string }> = [];
  const stub = await startStubServer((req, res, body) => {
    const url = new URL(req.url || '', 'http://127.0.0.1');
    if (url.pathname.startsWith('/api/images/')) {
      const id = url.pathname.split('/').pop() || '';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ image_id: id, access_policy: 'only_me' }));
      return;
    }
    if (req.method === 'PATCH') {
      patches.push({ id: '', policy: JSON.parse(body.toString()).access_policy });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<html><head><meta name="csrf-token" content="tok"></head></html>');
  });
  try {
    const result = await runCli(cacheDir, ['touch', `https://gyazo.com/${ID_A}`], {
      apiOrigin: stub.origin,
      webOrigin: stub.origin,
      cookieFile: cookieFile(cacheDir),
    });
    // Refused, so nothing was patched, and it says why.
    expect(patches).toHaveLength(0);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/only_me/);
  } finally {
    await stub.close();
  }
});

test('touch drops non-image URLs as noise and dedupes, without failing', async () => {
  const cacheDir = createTempCacheDir();
  const { handler, patches } = touchStub();
  const stub = await startStubServer(handler);
  const input = [
    `https://gyazo.com/${ID_A}`,
    `https://i.gyazo.com/${ID_A}.png`,       // same capture, other host
    'https://gyazo.com/search/twitter.com',   // noise
    'https://gyazo.com/search/%s',            // noise
    'https://gyazo.com/signup',               // noise
    `https://i.gyazo.com/${ID_B}.png`,        // a real one
  ].join('\n') + '\n';
  try {
    const result = await runCli(cacheDir, ['touch'], {
      apiOrigin: stub.origin,
      webOrigin: stub.origin,
      cookieFile: cookieFile(cacheDir),
      input,
    });
    // Noise does not make it fail.
    expect(result.status).toBe(0);
    // Each real capture touched once, deduped, and no noise reached the API.
    expect(patches.map((p) => p.id)).toEqual([ID_A, ID_A, ID_B, ID_B]);
    // It says how many it ignored.
    expect(result.stdout).toMatch(/2 touched/);
    expect(result.stdout).toMatch(/3 ignored|ignored 3/i);
  } finally {
    await stub.close();
  }
});
