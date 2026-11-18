import nacl from 'tweetnacl';

export function verifySignature(publicKeyHex, signatureHex, timestamp, rawBody) {
  try {
    if (!signatureHex || !timestamp || !publicKeyHex) return false;
    return nacl.sign.detached.verify(
      Buffer.from(timestamp + rawBody),
      Buffer.from(signatureHex, 'hex'),
      Buffer.from(publicKeyHex, 'hex'),
    );
  } catch {
    return false;
  }
}

export function isFreshTimestamp(timestamp, maxAgeSeconds = 300) {
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  return Math.abs(Date.now() / 1000 - ts) <= maxAgeSeconds;
}
