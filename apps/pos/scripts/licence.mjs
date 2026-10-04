#!/usr/bin/env node
/**
 * Vendor-side licence tool for the till. Runs on the vendor's PC, never ships.
 *
 *   node scripts/licence.mjs keygen  <dir>
 *       Writes <dir>/signing-key.pem (PRIVATE, keep out of git and backups
 *       that leave the PC) and <dir>/public-key.txt (goes into
 *       electron/services/licence/public-key.ts). Refuses to overwrite.
 *
 *   node scripts/licence.mjs issue --key <dir>/signing-key.pem --shop "Name"
 *       --device <deviceId> --plan starter|pro|business --months 12
 *       [--grace 14] [--from 2026-10-05] [--id lic_...]
 *       Prints one token. The shop pastes it in Settings → About → Licence.
 *       `--device` is the till's Device ID from that same card (one token per
 *       till). `--months` counts from --from (default today, UTC midnight).
 *
 *   node scripts/licence.mjs check <token> [--public <dir>/public-key.txt]
 *       Verifies the signature and prints the payload and its dates.
 *
 * Token format: COC1.<base64url payload JSON>.<base64url Ed25519 signature>.
 * The signature covers the exact payload bytes. The till holds only the public
 * key, so a token cannot be forged or edited without this private key.
 */
import { generateKeyPairSync, sign, verify, createPrivateKey, createPublicKey, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const PREFIX = 'COC1';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  if (v === undefined || v.startsWith('--')) return true;
  return v;
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

function die(msg) {
  console.error(msg);
  process.exit(1);
}

function keygen(dir) {
  if (!dir) die('usage: keygen <dir>');
  mkdirSync(dir, { recursive: true });
  const priv = join(dir, 'signing-key.pem');
  const pub = join(dir, 'public-key.txt');
  if (existsSync(priv) || existsSync(pub)) die(`refusing to overwrite ${priv} / ${pub}`);
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  writeFileSync(priv, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  // Raw 32-byte public key (SPKI DER minus the fixed 12-byte header), base64url.
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  const raw = spki.subarray(spki.length - 32);
  writeFileSync(pub, b64url(raw) + '\n');
  console.log(`private key: ${priv}\npublic key : ${pub}\npublic key value (paste into public-key.ts): ${b64url(raw)}`);
}

function issue() {
  const keyPath = arg('key');
  const shop = arg('shop');
  const device = arg('device');
  const plan = arg('plan', 'pro');
  const months = Number(arg('months', '12'));
  const grace = Number(arg('grace', '14'));
  const from = arg('from');
  const id = arg('id', `lic_${b64url(randomBytes(9))}`);
  if (typeof keyPath !== 'string' || typeof shop !== 'string' || typeof device !== 'string') {
    die('usage: issue --key <pem> --shop "Name" --device <deviceId> [--plan pro] [--months 12] [--grace 14] [--from YYYY-MM-DD]');
  }
  if (!['starter', 'pro', 'business'].includes(plan)) die('plan must be starter | pro | business');
  if (!Number.isInteger(months) || months < 1 || months > 120) die('months must be 1..120');
  if (!Number.isInteger(grace) || grace < 0 || grace > 90) die('grace must be 0..90');
  const start = typeof from === 'string' ? new Date(`${from}T00:00:00.000Z`) : new Date();
  if (Number.isNaN(start.getTime())) die('bad --from date');
  const expires = new Date(start);
  expires.setUTCMonth(expires.getUTCMonth() + months);
  const payload = {
    v: 1,
    id,
    shop,
    device,
    plan,
    issued: new Date().toISOString(),
    expires: expires.toISOString(),
    graceDays: grace,
  };
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  const privateKey = createPrivateKey(readFileSync(keyPath, 'utf8'));
  const sig = sign(null, body, privateKey);
  const token = `${PREFIX}.${b64url(body)}.${b64url(sig)}`;
  console.log(token);
  console.error(`\nissued to "${shop}" device ${device}: plan ${plan}, paid until ${payload.expires.slice(0, 10)}, grace ${grace} days`);
}

function check(token) {
  if (!token) die('usage: check <token> [--public <public-key.txt>]');
  const parts = token.trim().split('.');
  if (parts.length !== 3 || parts[0] !== PREFIX) die('not a COC1 token');
  const body = Buffer.from(parts[1], 'base64url');
  const sig = Buffer.from(parts[2], 'base64url');
  const pubPath = arg('public');
  let ok = null;
  if (typeof pubPath === 'string') {
    const raw = Buffer.from(readFileSync(pubPath, 'utf8').trim(), 'base64url');
    const spki = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw]);
    ok = verify(null, body, createPublicKey({ key: spki, format: 'der', type: 'spki' }), sig);
  }
  const payload = JSON.parse(body.toString('utf8'));
  console.log(JSON.stringify(payload, null, 2));
  if (ok !== null) console.log(ok ? 'signature: valid' : 'signature: INVALID');
  const exp = new Date(payload.expires);
  const days = Math.floor((exp.getTime() - Date.now()) / 86_400_000);
  console.log(days >= 0 ? `paid until ${payload.expires.slice(0, 10)} (${days} days left)` : `expired ${-days} days ago (grace ${payload.graceDays} days)`);
}

const [cmd, a1] = process.argv.slice(2);
if (cmd === 'keygen') keygen(a1);
else if (cmd === 'issue') issue();
else if (cmd === 'check') check(a1);
else die('commands: keygen <dir> | issue ... | check <token>');
