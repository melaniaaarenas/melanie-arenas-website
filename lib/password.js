'use strict';
// Password hashing with scrypt (built into Node, a memory-hard hash in the same class as bcrypt).
// Stored format: scrypt:N:r:p:<salt base64>:<hash base64>  (colons, so it is safe to paste into .env files)
const crypto = require('node:crypto');

const N = 32768;
const R = 8;
const P = 1;
const KEYLEN = 64;
const MAXMEM = 128 * 1024 * 1024;

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(password.normalize('NFKC'), salt, KEYLEN, { N, r: R, p: P, maxmem: MAXMEM });
  return ['scrypt', N, R, P, salt.toString('base64'), key.toString('base64')].join(':');
}

function verifyPassword(password, stored) {
  return new Promise((resolve) => {
    const parts = String(stored || '').trim().split(':');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return resolve(false);
    const [, n, r, p, salt, hash] = parts;
    const expected = Buffer.from(hash, 'base64');
    if (!expected.length) return resolve(false);
    crypto.scrypt(
      password.normalize('NFKC'),
      Buffer.from(salt, 'base64'),
      expected.length,
      { N: Number(n), r: Number(r), p: Number(p), maxmem: MAXMEM },
      (err, key) => {
        if (err) return resolve(false);
        resolve(crypto.timingSafeEqual(key, expected));
      }
    );
  });
}

module.exports = { hashPassword, verifyPassword };
