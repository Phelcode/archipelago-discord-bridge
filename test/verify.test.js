import { test } from 'node:test';
import assert from 'node:assert/strict';
import nacl from 'tweetnacl';
import { verifySignature, isFreshTimestamp } from '../src/discord/verify.js';

function signedRequest(keypair, body) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = Buffer.from(
    nacl.sign.detached(Buffer.from(timestamp + body), keypair.secretKey),
  ).toString('hex');
  const publicKey = Buffer.from(keypair.publicKey).toString('hex');
  return { publicKey, signature, timestamp, body };
}

test('verifySignature accepts a valid Discord signature', () => {
  const keypair = nacl.sign.keyPair();
  const body = JSON.stringify({ type: 1 });
  const { publicKey, signature, timestamp } = signedRequest(keypair, body);
  assert.equal(verifySignature(publicKey, signature, timestamp, body), true);
});

test('verifySignature rejects a tampered body', () => {
  const keypair = nacl.sign.keyPair();
  const body = JSON.stringify({ type: 1 });
  const { publicKey, signature, timestamp } = signedRequest(keypair, body);
  assert.equal(verifySignature(publicKey, signature, timestamp, body + ' '), false);
});

test('verifySignature rejects a wrong key', () => {
  const keypair = nacl.sign.keyPair();
  const other = nacl.sign.keyPair();
  const body = JSON.stringify({ type: 1 });
  const { signature, timestamp } = signedRequest(keypair, body);
  const otherPublic = Buffer.from(other.publicKey).toString('hex');
  assert.equal(verifySignature(otherPublic, signature, timestamp, body), false);
});

test('verifySignature rejects garbage input', () => {
  assert.equal(verifySignature('zz', 'zz', 'zz', 'body'), false);
  assert.equal(verifySignature('', '', '', ''), false);
});

test('isFreshTimestamp', () => {
  assert.equal(isFreshTimestamp(String(Math.floor(Date.now() / 1000))), true);
  assert.equal(isFreshTimestamp(String(Math.floor(Date.now() / 1000) - 1000)), false);
  assert.equal(isFreshTimestamp('not-a-number'), false);
});
