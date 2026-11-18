import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveSeed, slugify } from '../src/ap/manager.js';

test('resolveSeed passes through an explicit seed', () => {
  assert.equal(resolveSeed(12345), 12345);
  assert.equal(resolveSeed('777'), 777);
});

test('resolveSeed generates a random seed when none is given', () => {
  for (const seed of [undefined, null, '']) {
    const value = resolveSeed(seed);
    assert.ok(Number.isInteger(value));
    assert.ok(value >= 1 && value < 2 ** 48);
  }
  const a = resolveSeed();
  const b = resolveSeed();
  assert.notEqual(a, b);
});

test('slugify', () => {
  assert.equal(slugify('My Game!'), 'my-game');
  assert.equal(slugify('---'), 'game');
});
