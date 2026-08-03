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
// Everything here is injectable so the tests never touch the network or run a
// package manager: runUpdate({run, fetchLatest, …}).

const { execFileSync } = require('child_process');
const path = require('path');

const PKG = 'pidge-cli';
const REGISTRY_URL = `https://registry.npmjs.org/${PKG}/latest`;

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

function installArgv(manager) {
  switch (manager) {
    case 'pnpm': return ['pnpm', ['add', '-g', `${PKG}@latest`]];
    case 'yarn': return ['yarn', ['global', 'add', `${PKG}@latest`]];
    case 'bun': return ['bun', ['add', '-g', `${PKG}@latest`]];
    default: return ['npm', ['i', '-g', `${PKG}@latest`]];
  }
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

async function runUpdate({
  run = (cmd, args) => execFileSync(cmd, args, { stdio: 'inherit' }),
  fetchLatest = latestVersion,
  current = currentVersion(),
  manager = detectManager(),
  say = (m) => console.log(m),
  warn = (m) => console.error(m),
} = {}) {
  const latest = await fetchLatest();
  if (latest && current && !isOlder(current, latest)) {
    say(`pidge update: already on the latest (${current}).`);
    return { ok: true, ran: false, current, latest };
  }
  if (!latest) warn('pidge update: could not reach the npm registry — installing @latest anyway.');
  const [cmd, args] = installArgv(manager);
  try {
    run(cmd, args);
  } catch (e) {
    warn(`pidge update: ${cmd} ${args.join(' ')} failed (${e.message}).\n  Install it yourself:  npm i -g ${PKG}@latest   (or run the pinned one: npx -y ${PKG}@latest)`);
    return { ok: false, ran: true, current, latest };
  }
  say(latest
    ? `pidge update: installed ${PKG}@${latest} (was ${current || 'unknown'}) via ${cmd}.`
    : `pidge update: installed ${PKG}@latest (was ${current || 'unknown'}) via ${cmd}.`);
  return { ok: true, ran: true, current, latest };
}

module.exports = { runUpdate, latestVersion, currentVersion, detectManager, installArgv, isOlder, PKG, REGISTRY_URL };
