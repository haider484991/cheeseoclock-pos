/**
 * electron-builder `afterPack` hook — runs once the app is packed into
 * release/win-unpacked, before the installer is built and before anything is
 * published. Throwing here fails the build, which is the point: an installer
 * that would crash on a fresh PC must never reach GitHub Releases.
 *
 * Why it exists: @node-rs/argon2's prebuilt Windows binding links dynamically
 * against VCRUNTIME140.dll (the Visual C++ 2015-2022 runtime). Dev machines
 * and most used PCs have it from some other install; a brand-new laptop does
 * not, and the app dies at launch with "Failed to load native binding".
 * Electron itself and better-sqlite3 are statically linked and don't care.
 *
 * The fix: ship vcruntime140.dll next to the .node. Node loads native modules
 * with LoadLibraryExW(…, LOAD_WITH_ALTERED_SEARCH_PATH), so the binding's own
 * folder is searched first for its dependencies. Microsoft allows app-local
 * deployment of the runtime DLLs; we take the copy from the Visual Studio /
 * Build Tools redist folder (or System32 as a fallback — same file).
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// Where electron-builder unpacks the binding — see asarUnpack in electron-builder.yml.
const NATIVE_DIR = [
  'resources',
  'app.asar.unpacked',
  'node_modules',
  '@node-rs',
  'argon2-win32-x64-msvc',
];
const NATIVE_BINDING = 'argon2.win32-x64-msvc.node';
const RUNTIME_DLL = 'vcruntime140.dll';
const PE_MACHINE_X64 = 0x8664;

export default async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return;

  const dest = path.join(context.appOutDir, ...NATIVE_DIR);
  if (!fs.existsSync(path.join(dest, NATIVE_BINDING))) {
    throw new Error(
      `afterPack: ${NATIVE_BINDING} not found under ${dest}. ` +
        'The packaging layout changed — update scripts/after-pack.mjs before releasing.',
    );
  }

  const source = findRuntimeDll();
  assertX64Image(source);
  const target = path.join(dest, RUNTIME_DLL);
  fs.copyFileSync(source, target);
  if (fs.statSync(target).size === 0) throw new Error(`afterPack: ${target} is empty`);
  console.log(`  • afterPack: bundled ${RUNTIME_DLL} from ${source}`);
}

function findRuntimeDll() {
  const candidates = [];
  if (process.env.VCRUNTIME_DLL) candidates.push(process.env.VCRUNTIME_DLL);
  for (const vsRoot of visualStudioRoots()) {
    const redist = path.join(vsRoot, 'VC', 'Redist', 'MSVC');
    if (!fs.existsSync(redist)) continue;
    for (const version of fs.readdirSync(redist).sort(compareVersionsDesc)) {
      const archDir = path.join(redist, version, 'x64');
      if (!fs.existsSync(archDir)) continue;
      for (const crt of fs.readdirSync(archDir)) {
        if (/^Microsoft\.VC\d+\.CRT$/i.test(crt)) {
          candidates.push(path.join(archDir, crt, RUNTIME_DLL));
        }
      }
    }
  }
  if (process.env.SystemRoot) {
    candidates.push(path.join(process.env.SystemRoot, 'System32', RUNTIME_DLL));
  }
  const found = candidates.find((p) => fs.existsSync(p));
  if (!found) {
    throw new Error(
      `afterPack: could not find ${RUNTIME_DLL}. Looked in: ${candidates.join(', ') || '(nowhere)'}. ` +
        'Install the Visual C++ 2015-2022 redistributable (or Build Tools), or point VCRUNTIME_DLL at the file.',
    );
  }
  return found;
}

/** Every Visual Studio / Build Tools install, via vswhere; none if it isn't there. */
function visualStudioRoots() {
  const vswhere = path.join(
    process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)',
    'Microsoft Visual Studio',
    'Installer',
    'vswhere.exe',
  );
  if (!fs.existsSync(vswhere)) return [];
  try {
    return execFileSync(vswhere, ['-products', '*', '-property', 'installationPath', '-utf8'], {
      encoding: 'utf8',
    })
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function compareVersionsDesc(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const d = (pb[i] || 0) - (pa[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** Refuse anything that isn't a 64-bit PE image — a stray x86 copy would fail just as hard as no DLL. */
function assertX64Image(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const dosHeader = Buffer.alloc(0x40);
    fs.readSync(fd, dosHeader, 0, dosHeader.length, 0);
    const peOffset = dosHeader.readUInt32LE(0x3c);
    const peHeader = Buffer.alloc(6);
    fs.readSync(fd, peHeader, 0, peHeader.length, peOffset);
    if (peHeader.toString('latin1', 0, 4) !== 'PE\0\0') {
      throw new Error(`afterPack: ${file} is not a Windows PE image`);
    }
    const machine = peHeader.readUInt16LE(4);
    if (machine !== PE_MACHINE_X64) {
      throw new Error(`afterPack: ${file} is not x64 (machine 0x${machine.toString(16)})`);
    }
  } finally {
    fs.closeSync(fd);
  }
}
