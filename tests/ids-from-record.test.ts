import { test, expect } from 'vitest';
import { imageIdFromRecord } from '../src/ids';

function aliasFor(hash: string): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ img: `_${hash}` })).toString('base64url');
  return `${header}.${payload}.signature`;
}

test('a plain image_id is used as-is', () => {
  expect(imageIdFromRecord({ image_id: 'aa'.padEnd(32, '0') })).toBe('aa'.padEnd(32, '0'));
});

test('a blanked image_id is recovered from the alias_id JWT', () => {
  const hash = '6b2133144b33ef01d3941f82b33f22de';
  expect(
    imageIdFromRecord({ image_id: '', permalink_url: null, url: null, alias_id: aliasFor(hash) }),
  ).toBe(hash);
});

test('a record with nothing usable returns null', () => {
  expect(imageIdFromRecord({ image_id: '', alias_id: 'not-a-jwt' })).toBeNull();
  expect(imageIdFromRecord({})).toBeNull();
});
