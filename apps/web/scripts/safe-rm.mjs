// Deletes build folders WITHOUT following links. On Windows, Next's standalone output and the
// OpenNext build put junctions in them that point at the real packages in node_modules/.pnpm;
// a delete that follows a junction empties the real package (20 Oct 2026: next, react, … emptied).
//
//   node scripts/safe-rm.mjs .open-next .next
import { existsSync, lstatSync, readdirSync, rmdirSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Removes `path` (file, folder or link) without ever following a link; returns how many links it removed. */
export function safeRemove(path) {
  let links = 0;
  const remove = (p) => {
    const st = lstatSync(p);
    if (st.isSymbolicLink()) {
      // A junction or symlink: remove the link itself, never what it points at.
      try {
        unlinkSync(p);
      } catch {
        rmdirSync(p);
      }
      links += 1;
      return;
    }
    if (st.isDirectory()) {
      for (const name of readdirSync(p)) remove(join(p, name));
      rmdirSync(p);
      return;
    }
    unlinkSync(p);
  };
  try {
    lstatSync(path);
  } catch {
    return 0;
  }
  remove(path);
  return links;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  for (const arg of process.argv.slice(2)) {
    const p = resolve(arg);
    if (!existsSync(p)) continue;
    console.log(`removed ${p} (${safeRemove(p)} link(s), none followed)`);
  }
}
