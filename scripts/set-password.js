#!/usr/bin/env node
'use strict';
// Sets the admin password. Usage:  npm run set-password
// Saves only a scrypt hash to config/admin.json (never served to the web).
const fs = require('node:fs');
const path = require('node:path');
const { hashPassword } = require('../lib/password');

const CONFIG_DIR = path.join(__dirname, '..', 'config');
const CONFIG_FILE = path.join(CONFIG_DIR, 'admin.json');
const MIN_LENGTH = 10;

function askHidden(question) {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    process.stdout.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let value = '';
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.removeListener('data', onData);
          process.stdout.write('\n');
          return resolve(value);
        }
        if (ch === '\u0003') { process.stdout.write('\n'); process.exit(1); }
        if (ch === '\u007f' || ch === '\b') { value = value.slice(0, -1); continue; }
        value += ch;
      }
    };
    stdin.on('data', onData);
  });
}

async function readPiped() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8').split(/\r?\n/)[0];
}

(async () => {
  let password;
  if (process.stdin.isTTY) {
    password = await askHidden('New admin password: ');
    const again = await askHidden('Type it again:      ');
    if (password !== again) { console.error('Passwords did not match. Nothing was changed.'); process.exit(1); }
  } else {
    password = await readPiped();
  }

  if (!password || password.length < MIN_LENGTH) {
    console.error(`Please use at least ${MIN_LENGTH} characters. Nothing was changed.`);
    process.exit(1);
  }

  const hash = hashPassword(password);
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify({ passwordHash: hash, updatedAt: new Date().toISOString() }, null, 2) + '\n', { mode: 0o600 });

  console.log('\nAdmin password saved (hashed) to config/admin.json.');
  console.log('It takes effect immediately; no restart needed.');
  console.log('\nIf your host uses environment variables instead, set this one:');
  console.log(`ADMIN_PASSWORD_HASH=${hash}\n`);
})();
