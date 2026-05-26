/**
 * Unit tests for the transport's Retry-After header parser.
 *
 * The HTTP transport must honour a real server `Retry-After` for 429/503
 * responses (delta-seconds or HTTP-date), clamp it to 300s, and fall back to
 * computed backoff (0) when the header is absent or invalid. No real timers or
 * sleeping — `now` is passed explicitly.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { __parseRetryAfterForTest: parseRetryAfter } = await import('../dist/index.mjs');

const NOW = Date.UTC(2026, 0, 1, 0, 0, 0); // fixed reference

test('parses delta-seconds: "2" -> 2000ms', () => {
  assert.equal(parseRetryAfter('2', NOW), 2000);
});

test('parses a future HTTP-date into the correct ms delta', () => {
  const future = new Date(NOW + 45_000).toUTCString(); // 45s ahead
  assert.equal(parseRetryAfter(future, NOW), 45_000);
});

test('returns 0 for an HTTP-date already in the past', () => {
  const past = new Date(NOW - 10_000).toUTCString();
  assert.equal(parseRetryAfter(past, NOW), 0);
});

test('returns 0 for null', () => {
  assert.equal(parseRetryAfter(null, NOW), 0);
});

test('returns 0 for empty string', () => {
  assert.equal(parseRetryAfter('', NOW), 0);
  assert.equal(parseRetryAfter('   ', NOW), 0);
});

test('returns 0 for garbage', () => {
  assert.equal(parseRetryAfter('not-a-number', NOW), 0);
  assert.equal(parseRetryAfter('12abc', NOW), 0);
});

test('clamps a value greater than 300s to 300000ms', () => {
  assert.equal(parseRetryAfter('301', NOW), 300_000);
  assert.equal(parseRetryAfter('100000', NOW), 300_000);
});

test('clamps a far-future HTTP-date to 300000ms', () => {
  const farFuture = new Date(NOW + 10 * 60 * 1000).toUTCString(); // 600s
  assert.equal(parseRetryAfter(farFuture, NOW), 300_000);
});

test('honours exactly 300s without clamping below', () => {
  assert.equal(parseRetryAfter('300', NOW), 300_000);
});
