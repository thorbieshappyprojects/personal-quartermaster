#!/usr/bin/env node
// Fails when scanned files contain personal data patterns (SPEC §3, §7.6):
//   e-mail addresses (except reserved test domains and reviewed third-party authors),
//   IBANs (mod-97 valid), and the owner's domain(s) from LEAK_DOMAINS (comma-separated, from a CI secret).
//
//   node scripts/leak-check.mjs [--emails] <file or dir>...
// Without --emails only IBANs and owner domains are checked (used for the whole repository,
// whose code legitimately mentions synthetic addresses). Fixtures and the image use --emails.
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';

const args = process.argv.slice(2);
const checkEmails = args.includes('--emails');
const roots = args.filter((a) => !a.startsWith('--'));
if (roots.length === 0) {
  console.error('usage: leak-check.mjs [--emails] <path>...');
  process.exit(2);
}

const RESERVED = /(^|\.)(example\.(com|net|org)|example|test|invalid|localhost)$/i;
const allowlist = new Set(
  (await readFile(new URL('./leak-allowlist.txt', import.meta.url), 'utf8'))
    .split('\n')
    .map((l) => l.trim().toLowerCase())
    .filter((l) => l && !l.startsWith('#')),
);
const domains = (process.env.LEAK_DOMAINS ?? '')
  .split(',')
  .map((d) => d.trim().toLowerCase())
  .filter(Boolean);
if (domains.length === 0) console.warn('leak-check: LEAK_DOMAINS not set; owner-domain check skipped');

const EMAIL = /[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})/g;
const IBAN = /\b([A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,4})?)\b/g;
const SKIP_DIRS = new Set(['node_modules', '.git', '.pnpm-store']);
const MAX_BYTES = 20 * 1024 * 1024;

function ibanValid(raw) {
  const s = raw.replace(/ /g, '');
  if (s.length < 15 || s.length > 34) return false;
  const moved = (s.slice(4) + s.slice(0, 4)).replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55));
  let r = 0;
  for (const d of moved) r = (r * 10 + Number(d)) % 97;
  return r === 1;
}

async function* files(path) {
  const s = await stat(path);
  if (s.isFile()) {
    yield path;
    return;
  }
  for (const e of await readdir(path, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name)) continue;
    const p = join(path, e.name);
    if (e.isDirectory()) yield* files(p);
    else if (e.isFile()) yield p;
  }
}

const findings = [];
for (const root of roots) {
  for await (const file of files(root)) {
    if ((await stat(file)).size > MAX_BYTES) continue;
    const text = (await readFile(file)).toString('latin1');
    const where = relative(process.cwd(), file);
    if (checkEmails) {
      for (const m of text.matchAll(EMAIL)) {
        const addr = m[0].toLowerCase();
        if (RESERVED.test(m[1]) || allowlist.has(addr)) continue;
        findings.push(`${where}: e-mail address (${addr.replace(/^(.).*@/, '$1…@')})`);
      }
    }
    for (const m of text.matchAll(IBAN)) {
      if (ibanValid(m[1])) findings.push(`${where}: IBAN-like value (${m[1].slice(0, 4)}…)`);
    }
    const lower = text.toLowerCase();
    for (const d of domains) {
      if (lower.includes(d)) findings.push(`${where}: owner domain`);
    }
  }
}

if (findings.length) {
  // Findings are masked so the CI log does not repeat what it is guarding against.
  console.error(`leak-check: ${findings.length} finding(s)`);
  for (const f of [...new Set(findings)]) console.error(`  ${f}`);
  process.exit(1);
}
console.log(`leak-check: clean (${roots.join(', ')})`);
