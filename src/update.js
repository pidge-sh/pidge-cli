'use strict';
// `pidge update` — the CLI keeps ITSELF current.
//
// Why this exists: the installed base is the failure mode. `npx pidge-cli`
// prefers a copy the machine already has, so a user who onboarded months ago
// silently runs an ancient CLI (0.28.0 was measured on a real Mac while 0.40.0
// was published) — and every new subcommand looks like "unknown option" to
// them. A one-word update, plus a self-check at `terminal connect` (the one
// moment we know this computer is about to be used), closes that.
//
// The SECOND failure mode, which cost a whole arc: on a computer running Agent
// Sessions, `npm i -g` is not the copy that matters. The daemon runs a
// VENDORED copy under the config slot (a path this feature owns, immune to npx
// cache prunes and PATH surprises), so a global install alone left every
// published daemon fix invisible while `update` reported success. Whenever a
// daemon is installed here, the global install is followed by a re-vendorize
// through the sanctioned path — the freshly installed entry point running
// `terminal connect`, the one command that owns copying and service recycling
// — and the success line names BOTH versions, because they can differ.
//
// Everything here is injectable so the tests never touch the network or run a
// package manager: runUpdate({run, fetchLatest, …}).

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
// "Is Terminals installed here?" has exactly ONE implementation (src/terminals-installed).
// This file needs the FACT — it decides whether to re-vendorize, which copies
// files and restarts a service, so it must never read the text-only override.
const { terminalPaths, daemonSlotPresent } = require('./terminals-installed');

const PKG = 'pidge-cli';
const REGISTRY_URL = `https://registry.npmjs.org/${PKG}/latest`;
const ROOT = path.join(__dirname, '..');

// --- installed under an alias? ---------------------------------------------
//
// `npm i -g @pidge/cli` installs a thin alias package whose only dependency
// is this one, so THIS copy then lives at
// <global root>/@pidge/cli/node_modules/pidge-cli — nested, with the `pidge` bin
// owned by the alias. Two things follow. The global install `update` normally
// runs (`npm i -g pidge-cli@latest`) cannot work there: it tries to link a
// second `pidge` bin over the alias's and npm refuses (EEXIST). And
// `npm update -g pidge-cli` is worse: in that tree npm prunes the alias, bin
// included. The copy that has to move is the NESTED one, in place — a local
// install run in the alias's own folder, which touches neither the global
// root nor the bin. The alias itself never needs to move: it carries no code.
//
// The scoped name is the only alias: the registry refuses a bare `pidge` as too
// close to names that already exist, and that refusal applies to anyone.
const ALIAS_NAMES = ['@pidge/cli'];
function aliasInstall(root = ROOT) {
  let real = root;
  try { real = fs.realpathSync(root); } catch { /* not on disk: judge the path as given */ }
  const parts = real.split(/[\\/]+/);
  const n = parts.length;
  if (n < 4 || parts[n - 1] !== PKG || parts[n - 2] !== 'node_modules') return null;
  let name;
  if (parts[n - 4] === 'node_modules') name = parts[n - 3];
  else if (n >= 5 && parts[n - 5] === 'node_modules' && parts[n - 4].startsWith('@')) name = `${parts[n - 4]}/${parts[n - 3]}`;
  else return null;
  if (!ALIAS_NAMES.includes(name)) return null;
  return { name, dir: parts.slice(0, n - 2).join(path.sep) };
}

function currentVersion() {
  try { return require(path.join(__dirname, '..', 'package.json')).version || null; } catch { return null; }
}

// Which manager owns THIS copy — inferred from where it is installed, because a
// globally installed CLI has no npm_config_* env to read. npm is the default;
// a wrong guess costs one clear error line, never a broken install.
function detectManager(entry) {
  const p = String(entry || (require.main && require.main.filename) || '');
  if (/[\\/]\.?pnpm[\\/]/.test(p)) return 'pnpm';
  if (/[\\/]\.?yarn[\\/]/.test(p)) return 'yarn';
  if (/[\\/]\.?bun[\\/]/.test(p)) return 'bun';
  return 'npm';
}

function installArgv(manager, alias = null) {
  // npm under an alias: refresh the nested copy where it is. `--no-save` and
  // `--no-package-lock` keep the alias's own manifest exactly as published.
  if (alias && manager === 'npm') {
    return ['npm', ['--prefix', alias.dir, 'i', '--no-save', '--no-package-lock', `${PKG}@latest`]];
  }
  // Other managers lay a global package out their own way; the one move that
  // is safe everywhere is re-adding the alias, and runUpdate reads the version
  // back afterwards rather than assuming the nested copy followed.
  const spec = `${alias ? alias.name : PKG}@latest`;
  switch (manager) {
    case 'pnpm': return ['pnpm', ['add', '-g', spec]];
    case 'yarn': return ['yarn', ['global', 'add', spec]];
    case 'bun': return ['bun', ['add', '-g', spec]];
    default: return ['npm', ['i', '-g', spec]];
  }
}

// The line a human can paste when the automatic path did not get there.
function manualLine(manager, alias = null) {
  if (!alias) return `npm i -g ${PKG}@latest   (or run the pinned one: npx -y ${PKG}@latest)`;
  const rm = { pnpm: 'pnpm remove -g', yarn: 'yarn global remove', bun: 'bun remove -g' }[manager] || 'npm uninstall -g';
  const add = { pnpm: 'pnpm add -g', yarn: 'yarn global add', bun: 'bun add -g' }[manager] || 'npm i -g';
  return `${rm} ${alias.name} && ${add} ${alias.name}`;
}

// The version of the copy whose entry point this is — read from disk after an
// install, never inferred from what the registry said a moment ago.
function installedVersion(entry) {
  try { return JSON.parse(fs.readFileSync(path.join(path.dirname(entry), '..', 'package.json'), 'utf8')).version || null; } catch { return null; }
}

// Numeric-part comparison, prerelease-insensitive on purpose: this only ever
// answers "should I nudge?", never "which build is authoritative".
function isOlder(a, b) {
  const parts = (v) => String(v || '').split('-')[0].split('.').map((n) => parseInt(n, 10) || 0);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) < (y[i] || 0);
  }
  return false;
}

// The published version, or null on ANY failure (offline, registry down, a
// proxy that eats it). null always means "don't nudge, don't block".
async function latestVersion(timeoutMs = 5000) {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetch(REGISTRY_URL, { signal: ctl.signal, headers: { accept: 'application/json' } });
      if (!res.ok) return null;
      const data = await res.json();
      return (data && data.version) || null;
    } finally { clearTimeout(t); }
  } catch { return null; }
}

// --- the daemon's own copy (the slot the service actually runs) -------------

// The version the SERVICE runs, which is the one that matters for a daemon fix.
function slotVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(terminalPaths().dir, 'package.json'), 'utf8')).version || null;
  } catch { return null; }
}

// The entry point of the copy that was JUST installed globally — resolved by
// ASKING the package manager, never assembled from a guessed prefix (npm's
// global root is `lib/node_modules` on unix and `node_modules` on Windows, and
// nvm/volta/homebrew each move the prefix somewhere else). Returns null when
// the manager cannot be asked or the file is not there, and the caller then
// says so instead of running something that does not exist.
function globalRootArgv(manager) {
  switch (manager) {
    case 'pnpm': return ['pnpm', ['root', '-g']];
    case 'yarn': return ['yarn', ['global', 'dir']];
    case 'bun': return null; // bun has no stable "print the global root" verb
    default: return ['npm', ['root', '-g']];
  }
}
function globalEntryPath(manager, capture, alias = null) {
  // Under an alias the fresh copy is the nested one, at a path already known.
  if (alias) {
    const entry = path.join(alias.dir, 'node_modules', PKG, 'bin', 'pidge.js');
    return fs.existsSync(entry) ? entry : null;
  }
  const argv = globalRootArgv(manager);
  if (!argv) return null;
  let root;
  try {
    root = String(capture(argv[0], argv[1]) || '').trim().split('\n').pop().trim();
  } catch { return null; }
  if (!root) return null;
  // `yarn global dir` prints the folder ABOVE node_modules.
  const roots = manager === 'yarn' ? [path.join(root, 'node_modules'), root] : [root];
  for (const r of roots) {
    const entry = path.join(r, PKG, 'bin', 'pidge.js');
    if (fs.existsSync(entry)) return entry;
  }
  return null;
}

async function runUpdate({
  run = (cmd, args) => execFileSync(cmd, args, { stdio: 'inherit' }),
  capture = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }),
  fetchLatest = latestVersion,
  current = currentVersion(),
  manager = detectManager(),
  hasDaemon = daemonSlotPresent,
  readSlotVersion = slotVersion,
  resolveGlobalEntry = globalEntryPath,
  alias = aliasInstall(),
  readInstalledVersion = installedVersion,
  say = (m) => console.log(m),
  warn = (m) => console.error(m),
} = {}) {
  const latest = await fetchLatest();
  if (latest && current && !isOlder(current, latest)) {
    say(`pidge update: already on the latest (${current}).`);
    // Not a no-op on a computer with a daemon: the global can be current while
    // the slot the service runs is months behind (that is precisely how a
    // published daemon fix stays invisible). Say what each one is, and name
    // the command that lines them up — nothing is installed behind the
    // human's back on a path they asked nothing of.
    const daemon = hasDaemon();
    const slot = daemon ? readSlotVersion() : null;
    if (daemon) sayVersions({ say, warn, globalVersion: current, slot, reVendored: false });
    return { ok: true, ran: false, current, latest, slot };
  }
  if (!latest) warn('pidge update: could not reach the npm registry — installing @latest anyway.');
  const [cmd, args] = installArgv(manager, alias);
  try {
    run(cmd, args);
  } catch (e) {
    warn(`pidge update: ${cmd} ${args.join(' ')} failed (${e.message}).\n  Install it yourself:  ${manualLine(manager, alias)}`);
    return { ok: false, ran: true, current, latest, slot: null };
  }
  // Under an alias, read the nested copy back: on npm the in-place install is
  // exact, but a re-added alias on another manager may keep the nested copy it
  // already had, and "installed" must never be said over a version that did
  // not move.
  if (alias) {
    const entry = resolveGlobalEntry(manager, capture, alias);
    const got = entry ? readInstalledVersion(entry) : null;
    if (!got || (latest && isOlder(got, latest))) {
      warn(`pidge update: the copy under the ${alias.name} alias is still ${got || 'unknown'} after the refresh.\n  Reinstall the alias:  ${manualLine(manager, alias)}`);
      return { ok: false, ran: true, current, latest, slot: null };
    }
  }
  const installed = latest || 'latest';
  const where = alias ? ` (under the ${alias.name} alias)` : '';
  say(latest
    ? `pidge update: installed ${PKG}@${latest} (was ${current || 'unknown'}) via ${cmd}${where}.`
    : `pidge update: installed ${PKG}@latest (was ${current || 'unknown'}) via ${cmd}${where}.`);

  // No daemon here ⇒ the update has nothing to say about one. The global copy
  // IS the whole install on this computer, and the line naming a feature this
  // machine never installed was the CLI announcing Terminals to someone who
  // never asked for it.
  if (!hasDaemon()) return { ok: true, ran: true, current, latest, slot: null, reVendored: false };

  // The sanctioned re-vendorize: run the FRESHLY INSTALLED entry point's
  // `terminal connect`. That command owns the copy into the config slot and
  // the service recycle — doing either by hand here would be a second
  // implementation of the install, free to drift from the real one.
  const entry = resolveGlobalEntry(manager, capture, alias);
  if (!entry) {
    warn(`pidge update: the new global copy could not be located, so the daemon still runs its old vendored copy (${readSlotVersion() || 'unknown version'}).\n  Finish it by hand:  pidge terminal connect --yes`);
    return { ok: false, ran: true, current, latest, slot: readSlotVersion(), reVendored: false };
  }
  try {
    run(process.execPath, [entry, 'terminal', 'connect', '--yes']);
  } catch (e) {
    warn(`pidge update: the daemon re-install failed (${e.message}) — the global CLI is ${installed}, but the service still runs ${readSlotVersion() || 'an unknown version'}.\n  Finish it by hand:  pidge terminal connect --yes`);
    return { ok: false, ran: true, current, latest, slot: readSlotVersion(), reVendored: false };
  }
  const slot = readSlotVersion();
  sayVersions({ say, warn, globalVersion: latest || slot || current, slot, reVendored: true });
  return { ok: true, ran: true, current, latest, slot, reVendored: true };
}

// The two numbers, always together: they are different installs and a single
// number has already hidden a months-old daemon behind a current CLI once.
function sayVersions({ say, warn, globalVersion, slot, reVendored }) {
  say(`pidge update: npm global ${globalVersion || 'unknown'} · daemon slot ${slot || 'unknown'}${reVendored ? ' (re-installed and restarted)' : ''}`);
  if (slot && globalVersion && slot !== globalVersion) {
    warn(`pidge update: the daemon still runs ${slot} while the CLI is ${globalVersion} — the service serves its own copy.\n  Line them up with:  pidge terminal connect --yes`);
  }
}

module.exports = {
  runUpdate, latestVersion, currentVersion, detectManager, installArgv, isOlder,
  daemonSlotPresent, slotVersion, globalEntryPath, aliasInstall, manualLine, installedVersion,
  PKG, REGISTRY_URL, ALIAS_NAMES,
};
