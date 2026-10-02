import { test, expect } from 'vitest';
import { imageIdFromRecord } from '../src/ids';

test('a plain image_id is used as-is', () => {
  expect(imageIdFromRecord({ image_id: 'aa'.padEnd(32, '0') })).toBe('aa'.padEnd(32, '0'));
});

test('image_id is recovered from the permalink or url when the field is empty', () => {
  const hash = '6b2133144b33ef01d3941f82b33f22de';
  expect(imageIdFromRecord({ image_id: '', permalink_url: `https://gyazo.com/${hash}` })).toBe(hash);
  expect(imageIdFromRecord({ image_id: '', url: `https://i.gyazo.com/${hash}.png` })).toBe(hash);
});

test('a record Gyazo is withholding (all fields blank) returns null', () => {
  expect(imageIdFromRecord({ image_id: '', permalink_url: null, url: null })).toBeNull();
  expect(imageIdFromRecord({})).toBeNull();
});
