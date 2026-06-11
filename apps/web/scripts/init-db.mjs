// One-time DB setup: applies db/schema.sql to the Neon database in
// DATABASE_URL. Idempotent (CREATE IF NOT EXISTS throughout).
//
//   DATABASE_URL="postgresql://..." pnpm --filter @cheeseoclock/web db:init
import { neon } from '@neondatabase/serverless';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set. Copy .env.example and fill it in.');
  process.exit(1);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const schema = readFileSync(path.join(here, '..', 'db', 'schema.sql'), 'utf8');

const sql = neon(url);

/** Run a raw SQL string through the tagged-template client. */
function run(text) {
  const tpl = Object.assign([text], { raw: [text] });
  return sql(tpl);
}

// Split on semicolons at line ends, then strip comment-only lines from each
// chunk (dropping whole chunks that start with a comment would silently skip
// the statement that follows the comment block).
const statements = schema
  .split(/;\s*\n/)
  .map((s) =>
    s
      .split('\n')
      .filter((line) => !line.trim().startsWith('--'))
      .join('\n')
      .trim(),
  )
  .filter((s) => s.length > 0);

for (const stmt of statements) {
  await run(stmt);
}
console.log(`Applied ${statements.length} statements. Database ready.`);
