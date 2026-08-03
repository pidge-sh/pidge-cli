'use strict';
// Unit tests for the `pidge terminal` module (src/terminal/*).
//
// SAFETY: this file touches the filesystem through modules that resolve
// ~/.claude and ~/.config/pidge at CALL time (os.homedir() / XDG_CONFIG_HOME).
// Both are redirected to fresh tmp dirs BEFORE anything is required, and the
// redirection is asserted below — if os.homedir() ever stopped honoring HOME,
// this file refuses to load rather than write into the developer's real home.
// Nothing here invokes launchctl, tmux, or the network.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync, spawn } = require('node:child_process');

function tmp(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }

// --- hard isolation, before the modules under test are loaded ---------------
const REAL_HOME = os.homedir();
process.env.HOME = tmp('pidge-term-home-');
process.env.XDG_CONFIG_HOME = tmp('pidge-term-xdg-');
if (os.homedir() !== process.env.HOME || os.homedir() === REAL_HOME) {
  throw new Error('refusing to run: os.homedir() does not honor HOME on this platform, the hook installer tests would write into the real home');
}

const core = require('../src/terminal/core');
const adapter = require('../src/terminal/adapter-claude');
const commands = require('../src/terminal/commands');
const { Daemon } = require('../src/terminal/daemon');

// A fresh config slot per test that writes one — terminalDir() reads the env
// at call time, so reassigning is enough.
function freshXdg() {
  process.env.XDG_CONFIG_HOME = tmp('pidge-term-xdg-');
  return process.env.XDG_CONFIG_HOME;
}
function freshHome() {
  process.env.HOME = tmp('pidge-term-home-');
  assert.equal(os.homedir(), process.env.HOME);
  return process.env.HOME;
}

const KEY32 = () => crypto.randomBytes(32);
const SECRET43 = () => crypto.randomBytes(32).toString('base64url');

// ===========================================================================
// 1. adapter-claude normalize()
// ===========================================================================

test('normalize: an assistant record with thinking+text+tool_use emits one item per block', () => {
  const items = adapter.normalize({
    type: 'assistant',
    uuid: 'u-1',
    parentUuid: 'p-0',
    timestamp: '2026-08-02T18:33:12Z',
    version: '2.1.220',
    message: {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'let me look', signature: 'sig' },
        { type: 'text', text: 'here you go' },
        { type: 'tool_use', name: 'Bash', input: { command: 'ls' } },
      ],
    },
  });

  assert.equal(items.length, 3);
  assert.deepEqual(items.map((i) => i.uuid), ['u-1', 'u-1:1', 'u-1:2']);
  assert.deepEqual(items.map((i) => i.kind), ['thinking', 'text', 'tool_use']);
  assert.equal(items[2].tool, 'Bash');
  assert.equal(items[2].preview, JSON.stringify({ command: 'ls' }));
  for (const item of items) {
    assert.equal(item.v, 1);
    assert.equal(item.harness, 'claude');
    assert.equal(item.hv, '2.1.220');
    assert.equal(item.parent, 'p-0');
    assert.equal(item.role, 'assistant');
    assert.equal(item.ts, '2026-08-02T18:33:12Z');
    assert.equal(item.truncated, false);
  }
});

test('normalize: a user record with string content is one text item', () => {
  const items = adapter.normalize({
    type: 'user', uuid: 'u-2', parentUuid: null, message: { role: 'user', content: 'oi' },
  });
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, 'text');
  assert.equal(items[0].role, 'user');
  assert.equal(items[0].preview, 'oi');
  assert.equal(items[0].uuid, 'u-2');
  assert.equal(items[0].parent, null);
});

test('normalize: tool_result blocks become kind tool_result under the user role', () => {
  const items = adapter.normalize({
    type: 'user',
    uuid: 'u-3',
    message: {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 't1', content: 'file listing' },
        { type: 'tool_result', tool_use_id: 't2', content: [{ type: 'text', text: 'second' }] },
      ],
    },
  });
  assert.equal(items.length, 2);
  assert.deepEqual(items.map((i) => i.kind), ['tool_result', 'tool_result']);
  assert.deepEqual(items.map((i) => i.role), ['user', 'user']);
  assert.equal(items[0].preview, 'file listing');
  assert.equal(items[1].preview, 'second');
  assert.deepEqual(items.map((i) => i.uuid), ['u-3', 'u-3:1']);
});

test('normalize: sidechain records are dropped whole (main thread only)', () => {
  assert.deepEqual(adapter.normalize({
    type: 'assistant', uuid: 'u-4', isSidechain: true, message: { role: 'assistant', content: 'hidden' },
  }), []);
});

test('normalize: a record without a uuid is untailable and dropped', () => {
  assert.deepEqual(adapter.normalize({
    type: 'assistant', message: { role: 'assistant', content: 'no dedup key' },
  }), []);
});

test('normalize: an unknown record type surfaces as a notice, known noise stays silent', () => {
  const items = adapter.normalize({ type: 'wibble', uuid: 'u-5' });
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, 'notice');
  assert.equal(items[0].role, 'system');
  assert.match(items[0].preview, /wibble/);
  assert.match(items[0].preview, /update/);

  for (const t of ['attachment', 'queue-operation', 'summary']) {
    assert.deepEqual(adapter.normalize({ type: t, uuid: `u-${t}` }), [], `${t} should stay silent`);
  }
});

test('normalize: an unknown message BLOCK becomes a notice too — drift is never a hole', () => {
  // A record type nobody knows surfaces already; a BLOCK type nobody knows used
  // to vanish inside a record that otherwise rendered fine — the worst kind of
  // gap, because the conversation still LOOKS complete.
  const items = adapter.normalize({
    type: 'assistant',
    uuid: 'u-blk',
    version: '2.1.220',
    message: {
      role: 'assistant',
      content: [
        { type: 'text', text: 'searching' },
        { type: 'server_tool_use', name: 'web_search', input: { q: 'pidge' } },
      ],
    },
  });

  assert.equal(items.length, 2, 'the unknown block must produce an item, not silence');
  assert.equal(items[1].kind, 'notice');
  assert.equal(items[1].uuid, 'u-blk:1', 'it keeps its own dedup key like any other block');
  assert.match(items[1].preview, /unknown block: server_tool_use/);
  assert.match(items[1].preview, /update/);

  // A block with no type at all is still surfaced (named, not guessed).
  const [notice] = adapter.normalize({
    type: 'assistant', uuid: 'u-blk2', message: { role: 'assistant', content: [{ foo: 1 }] },
  });
  assert.equal(notice.kind, 'notice');
  assert.match(notice.preview, /untyped/);
});

test('normalize: snapshot system records are dropped, plain ones become notices', () => {
  assert.deepEqual(adapter.normalize({
    type: 'system', uuid: 'u-6', isSnapshotUpdate: true, content: 'snapshot noise',
  }), []);

  const items = adapter.normalize({ type: 'system', uuid: 'u-7', content: 'compacted' });
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, 'notice');
  assert.equal(items[0].role, 'system');
  assert.equal(items[0].preview, 'compacted');
});

test('normalize: the thinking SIGNATURE never reaches the item', () => {
  const items = adapter.normalize({
    type: 'assistant',
    uuid: 'u-8',
    message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'x', signature: 'HUGE' }] },
  });
  assert.equal(items.length, 1);
  assert.equal(items[0].preview, 'x');
  assert.ok(!JSON.stringify(items[0]).includes('HUGE'), 'the opaque signature must be dropped whole');
});

test('normalize: preview is capped with honest truncated/total_bytes', () => {
  const text = 'a'.repeat(5000);
  const [item] = adapter.normalize({
    type: 'assistant', uuid: 'u-9', message: { role: 'assistant', content: text },
  });
  assert.ok(Buffer.byteLength(item.preview, 'utf8') <= adapter.PREVIEW_BYTES,
    `preview was ${Buffer.byteLength(item.preview, 'utf8')} bytes`);
  assert.equal(item.truncated, true);
  assert.equal(item.total_bytes, 5000);
});

test('normalize: a preview cut never splits a multibyte code point', () => {
  // 'a' shifts the emoji stream off the 4-byte boundary, so the 2 KB cut lands
  // mid-code-point — the worst case for a naive byte slice.
  const text = 'a' + '🐦'.repeat(2000);
  const [item] = adapter.normalize({
    type: 'assistant', uuid: 'u-10', message: { role: 'assistant', content: text },
  });
  const preview = item.preview;
  assert.ok(Buffer.byteLength(preview, 'utf8') <= adapter.PREVIEW_BYTES);
  assert.ok(!preview.includes('�'), 'no replacement character may survive the cut');
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(preview), 'no lone high surrogate');
  assert.ok(!/(^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(preview), 'no lone low surrogate');
  assert.equal(preview, Buffer.from(preview, 'utf8').toString('utf8'), 'the preview must round-trip through UTF-8');
  assert.equal(item.truncated, true);
  assert.equal(item.total_bytes, Buffer.byteLength(text, 'utf8'));
});

// ===========================================================================
// 2. core: E2E primitives + the config slot
// ===========================================================================

test('e2e blob: roundtrip, framing byte, and exact length', () => {
  const key = KEY32();
  const aad = core.e2eAad(1, 'ases_abc', 'agent_transcript');
  const plain = Buffer.from('the quick brown pidge', 'utf8');

  const blob = core.e2eEncryptBlob(key, aad, plain);
  assert.equal(blob[0], 0x01, 'the framing byte announces blob version 1');
  assert.equal(blob.length, 1 + 12 + plain.length + 16);
  assert.deepEqual(core.e2eDecryptBlob(key, aad, blob), plain);
});

test('e2e blob: a wrong AAD or a wrong key fails to authenticate', () => {
  const key = KEY32();
  const aad = core.e2eAad(1, 'ases_abc', 'agent_transcript');
  const blob = core.e2eEncryptBlob(key, aad, Buffer.from('secret'));

  assert.throws(() => core.e2eDecryptBlob(key, core.e2eAad(1, 'ases_abc', 'agent_input'), blob), /authenticate/);
  assert.throws(() => core.e2eDecryptBlob(key, core.e2eAad(2, 'ases_abc', 'agent_transcript'), blob), /authenticate/);
  assert.throws(() => core.e2eDecryptBlob(KEY32(), aad, blob), /authenticate/);
});

test('e2e blob: an unknown framing byte is refused, not silently opened', () => {
  const key = KEY32();
  const aad = core.e2eAad(1, 'ases_abc', 'agent_transcript');
  const blob = core.e2eEncryptBlob(key, aad, Buffer.from('secret'));
  blob[0] = 0x02;
  assert.throws(() => core.e2eDecryptBlob(key, aad, blob), /unknown e2e blob version 0x02/);
  assert.throws(() => core.e2eDecryptBlob(key, aad, Buffer.alloc(4)), /too short/);
});

test('e2eParseSecret: exactly 32 bytes of base64url, or a loud error', () => {
  const raw = SECRET43();
  assert.equal(raw.length, 43);
  const key = core.e2eParseSecret(raw);
  assert.ok(Buffer.isBuffer(key));
  assert.equal(key.length, 32);
  assert.deepEqual(key, Buffer.from(raw, 'base64url'));

  assert.throws(() => core.e2eParseSecret(crypto.randomBytes(16).toString('base64url')), /exactly 32/);
  assert.throws(() => core.e2eParseSecret(crypto.randomBytes(48).toString('base64url')), /exactly 32/);
  assert.throws(() => core.e2eParseSecret('not base64url!!'), /not base64url/);
  assert.equal(core.e2eParseSecret(''), null);
});

test('e2eAad: the ch<id>:<anchor>:<field> shape, and refusals on missing parts', () => {
  assert.equal(core.e2eAad(1, 'ases_abc', 'agent_transcript'), 'ch1:ases_abc:agent_transcript');
  assert.equal(core.e2eAad(42, 'cid-9', 'title'), 'ch42:cid-9:title');
  assert.throws(() => core.e2eAad(null, 'a', 'f'), /channel_id/);
  assert.throws(() => core.e2eAad(1, '', 'f'), /anchor/);
  assert.throws(() => core.e2eAad(1, 'a', ''), /field_name/);
});

test('the terminal identity slot roundtrips and stays 0600', () => {
  freshXdg();
  const secret = SECRET43();
  core.saveTerminalEnv({ base: 'https://api.example.test', token: 'hld_x', secret, channelId: 7 });

  const file = core.ENV_FILE();
  assert.equal(path.dirname(file), core.terminalDir());
  assert.equal((fs.statSync(file).mode & 0o777), 0o600, 'the tunnel identity must not be world-readable');

  assert.deepEqual(core.loadTerminalEnv(), {
    base: 'https://api.example.test', token: 'hld_x', secret, channelId: 7,
  });

  const parsed = core.readEnvFile(file);
  assert.equal(parsed.PIDGE_URL, 'https://api.example.test');
  assert.equal(parsed.PIDGE_CHANNEL_ID, '7');
  assert.equal(core.readEnvFile(path.join(core.terminalDir(), 'nope')).PIDGE_URL, undefined);
});

test('readEnvFile tolerates export prefixes, quotes, comments and junk lines', () => {
  freshXdg();
  const file = path.join(core.terminalDir(), 'env');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, [
    '# a comment',
    'export PIDGE_URL="https://quoted.example"',
    "PIDGE_TOKEN='hld_q'",
    'PIDGE_EMPTY=',
    '=novalue',
    'garbage',
    'PIDGE_CHANNEL_ID=3',
  ].join('\n'));

  const env = core.readEnvFile(file);
  assert.equal(env.PIDGE_URL, 'https://quoted.example');
  assert.equal(env.PIDGE_TOKEN, 'hld_q');
  assert.equal(env.PIDGE_EMPTY, undefined);
  assert.equal(env.PIDGE_CHANNEL_ID, '3');
  assert.equal(core.loadTerminalEnv().channelId, 3);
});

test('caps default to the shipped limits and merge the cached manifest values', () => {
  freshXdg();
  assert.deepEqual(core.loadCaps(), core.DEFAULT_CAPS);
  core.saveCaps({ ...core.DEFAULT_CAPS, items_per_call: 5 });
  assert.equal(core.loadCaps().items_per_call, 5);
  assert.equal(core.loadCaps().item_sealed_max_bytes, core.DEFAULT_CAPS.item_sealed_max_bytes);
});

// ===========================================================================
// 3. commands: the hook installer against a tmp HOME
// ===========================================================================

const settingsPath = () => path.join(process.env.HOME, '.claude', 'settings.json');
const readSettings = () => JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
const pidgeEntries = (entries) => (entries || []).filter(
  (e) => (e.hooks || []).some((h) => String(h.command || '').includes(commands.PIDGE_HOOK_MARKER)));

test('installHooks writes a tagged hook for every announced event', () => {
  freshHome();
  freshXdg();
  commands.installHooks();

  const settings = readSettings();
  assert.deepEqual(Object.keys(settings.hooks).sort(), ['Notification', 'PreToolUse', 'SessionStart', 'Stop']);
  for (const event of ['SessionStart', 'PreToolUse', 'Notification', 'Stop']) {
    const mine = pidgeEntries(settings.hooks[event]);
    assert.equal(mine.length, 1, `${event} should carry exactly one pidge entry`);
    const hook = mine[0].hooks[0];
    assert.equal(hook.type, 'command');
    assert.ok(hook.command.includes(commands.PIDGE_HOOK_MARKER), 'the marker is the uninstaller handle');
    assert.ok(hook.command.includes(core.HOOK_SHIM()), 'the command must point at the generated shim');
    assert.ok(hook.command.includes(process.execPath), 'the shim runs under this node');
  }
  // Only the approval gate needs a matcher and a long hold.
  assert.equal(pidgeEntries(settings.hooks.PreToolUse)[0].matcher, '*');
  assert.equal(pidgeEntries(settings.hooks.PreToolUse)[0].hooks[0].timeout, 90);
  for (const event of ['SessionStart', 'Notification', 'Stop']) {
    assert.equal(pidgeEntries(settings.hooks[event])[0].matcher, undefined);
    assert.equal(pidgeEntries(settings.hooks[event])[0].hooks[0].timeout, 10);
  }
});

test('installHooks is idempotent — a second run leaves one entry per event', () => {
  freshHome();
  freshXdg();
  commands.installHooks();
  commands.installHooks();
  commands.installHooks();

  const settings = readSettings();
  for (const event of ['SessionStart', 'PreToolUse', 'Notification', 'Stop']) {
    assert.equal(settings.hooks[event].length, 1, `${event} accumulated duplicates`);
    assert.equal(pidgeEntries(settings.hooks[event]).length, 1);
  }
});

test("a user's own hooks and settings survive install AND uninstall untouched", () => {
  freshHome();
  freshXdg();
  const foreignPost = { matcher: 'Edit', hooks: [{ type: 'command', command: 'my-formatter --fix', timeout: 5 }] };
  const foreignStart = { hooks: [{ type: 'command', command: 'echo hello from the user' }] };
  const original = {
    model: 'opus',
    permissions: { allow: ['Bash(git status)'] },
    hooks: { PostToolUse: [foreignPost], SessionStart: [foreignStart] },
  };
  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
  fs.writeFileSync(settingsPath(), JSON.stringify(original, null, 2) + '\n');

  commands.installHooks();
  const installed = readSettings();
  assert.deepEqual(installed.hooks.PostToolUse, [foreignPost], 'an unrelated event must not be rewritten');
  assert.deepEqual(installed.hooks.SessionStart[0], foreignStart, "the user's own entry keeps its place");
  assert.equal(installed.hooks.SessionStart.length, 2);
  assert.equal(installed.model, 'opus');
  assert.deepEqual(installed.permissions, { allow: ['Bash(git status)'] });

  commands.uninstallHooks();
  const after = readSettings();
  assert.deepEqual(after, original, 'uninstall must restore the settings exactly as the user had them');
});

test('uninstallHooks removes every tagged entry and drops the emptied events', () => {
  freshHome();
  freshXdg();
  commands.installHooks();
  assert.ok(JSON.stringify(readSettings()).includes(commands.PIDGE_HOOK_MARKER));

  commands.uninstallHooks();
  const settings = readSettings();
  assert.ok(!JSON.stringify(settings).includes(commands.PIDGE_HOOK_MARKER));
  assert.deepEqual(settings.hooks, {}, 'emptied event arrays are deleted, not left as []');

  commands.uninstallHooks(); // a second pass on already-clean settings is a no-op
  assert.deepEqual(readSettings().hooks, {});
});

test('uninstallHooks on a machine that never installed is a no-op', () => {
  freshHome();
  freshXdg();
  commands.uninstallHooks();
  assert.ok(!fs.existsSync(settingsPath()), 'no settings file must be conjured out of nothing');
});

test('installHooks ABORTS on a malformed settings.json instead of overwriting it', () => {
  freshHome();
  freshXdg();
  // A real Claude Code config with one stray trailing comma. The tolerant
  // `readJson(file, {})` this replaces would have parsed it as {} and written
  // back a settings.json containing ONLY the pidge hooks.
  const broken = '{\n  "model": "opus",\n  "permissions": { "allow": ["Bash(git status)"], },\n}\n';
  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
  fs.writeFileSync(settingsPath(), broken);

  assert.throws(() => commands.installHooks(), /not valid JSON/);
  assert.equal(fs.readFileSync(settingsPath(), 'utf8'), broken,
    "the user's settings.json must survive byte-for-byte");

  // Uninstall is equally hands-off (it must not abort `disconnect`, so it warns).
  const errs = [];
  const realError = console.error;
  console.error = (...a) => errs.push(a.join(' '));
  try { commands.uninstallHooks(); } finally { console.error = realError; }
  assert.equal(fs.readFileSync(settingsPath(), 'utf8'), broken);
  assert.ok(errs.some((l) => /not valid JSON/.test(l)), `expected a loud warning, got ${JSON.stringify(errs)}`);
});

test('installHooks preserves a restrictive settings.json mode and creates new ones private', () => {
  freshHome();
  freshXdg();
  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
  fs.writeFileSync(settingsPath(), JSON.stringify({ model: 'opus' }, null, 2) + '\n', { mode: 0o600 });
  fs.chmodSync(settingsPath(), 0o600);

  commands.installHooks();
  assert.equal(fs.statSync(settingsPath()).mode & 0o777, 0o600, 'a 0600 config must not come back world-readable');
  commands.uninstallHooks();
  assert.equal(fs.statSync(settingsPath()).mode & 0o777, 0o600);

  freshHome();
  commands.installHooks(); // no pre-existing file
  assert.equal(fs.statSync(settingsPath()).mode & 0o777, 0o600);
});

test('installHooks refuses a settings.json that parses to a non-object', () => {
  freshHome();
  freshXdg();
  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
  fs.writeFileSync(settingsPath(), '["not", "an", "object"]\n');
  assert.throws(() => commands.installHooks(), /not valid JSON/);
  assert.equal(fs.readFileSync(settingsPath(), 'utf8'), '["not", "an", "object"]\n');
});

test('the generated hook shim is valid JavaScript (node --check)', () => {
  const dir = tmp('pidge-term-shim-');
  const file = path.join(dir, 'pidge-hook.js');
  const src = commands.hookShimSource();
  fs.writeFileSync(file, src);
  execFileSync(process.execPath, ['--check', file]);

  assert.match(src, /^#!\/usr\/bin\/env node\n/, 'the shim is directly executable');
  assert.ok(src.includes('127.0.0.1'), 'the shim talks to loopback only');
  assert.ok(!src.includes('PIDGE_SECRET'), 'the shim never handles the tunnel key');
});

// --- the CLI surface of the one-door lock-down ------------------------------
//
// These shell out to bin/pidge.js. Both paths die before any config, network
// or daemon call — and HOME/XDG_CONFIG_HOME are the tmp dirs inherited from
// this process, so nothing real is read or written either way.

function runPidge(args) {
  const bin = path.join(__dirname, '..', 'bin', 'pidge.js');
  try {
    return { code: 0, stdout: execFileSync(process.execPath, [bin, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }), stderr: '' };
  } catch (e) {
    return { code: e.status, stdout: e.stdout || '', stderr: e.stderr || '' };
  }
}

test('`pidge terminal ls` is GONE — the picker is not a door, not even a deprecated one', () => {
  const out = runPidge(['terminal', 'ls']);
  assert.equal(out.code, 1);
  assert.match(out.stderr, /unknown subcommand "ls"/);
  assert.doesNotMatch(out.stderr, /\bls\b,/, 'ls must not survive in the subcommand list either');
});

test('terminal --help documents ONE enable door — the HOOK, not a command to find', () => {
  const out = runPidge(['terminal', '--help']);
  assert.equal(out.code, 0, out.stderr);
  assert.doesNotMatch(out.stdout, /terminal ls/, 'the picker is off the help');
  assert.doesNotMatch(out.stdout, /enable \[--session/, 'enable takes no session id');
  assert.doesNotMatch(out.stdout, /walks its process tree|claude ancestor/i,
    'the ancestor walk must not be described as the mechanism — it is gone');
  assert.match(out.stdout, /PreToolUse HOOK/, 'the help names the actual mechanism');
  assert.match(out.stdout, /Run exactly this one bash command and nothing else/,
    'the help quotes the text to paste, so the one door is discoverable');
});

test('`pidge update` is a real command with focused help', () => {
  const out = runPidge(['update', '--help']);
  assert.equal(out.code, 0, out.stderr);
  assert.match(out.stdout, /pidge update \[--manager npm\|pnpm\|yarn\|bun\]/);
  assert.match(out.stdout, /pidge-cli@latest/);
});

// --- connect: the claim contract (kind tolerance + claim order) -------------
//
// These run the REAL `pidge terminal connect` against the mock server, with
// --no-daemon (no launchctl/systemctl ever runs) and HOME/XDG in tmp dirs.

const { createMock } = require('./mock-server');

// ASYNC on purpose: the mock server runs in THIS process's event loop, and a
// blocking execFileSync would deadlock against the child's own claim request.
function runConnect(port, { code = 'claim-ok', secret = SECRET43(), extra = [] } = {}) {
  const bin = path.join(__dirname, '..', 'bin', 'pidge.js');
  const child = spawn(process.execPath,
    [bin, 'terminal', 'connect', '--code', code, '--url', `http://127.0.0.1:${port}`, '--yes', '--no-daemon', ...extra],
    {
      env: {
        ...process.env,
        PIDGE_SECRET: secret,
        PIDGE_NO_UPDATE_CHECK: '1',  // never reach the npm registry from a test
        PIDGE_QUIET_NAG: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  const out = { code: null, stdout: '', stderr: '' };
  child.stdout.on('data', (c) => { out.stdout += c; });
  child.stderr.on('data', (c) => { out.stderr += c; });
  return new Promise((resolve) => child.on('exit', (c) => { out.code = c; resolve(out); }));
}

test('connect: a server that reports kind "tunnel" completes the whole install', async () => {
  freshHome();
  freshXdg();
  const mock = createMock();
  const port = await mock.start();
  mock.state.claimKind = 'tunnel';
  try {
    const out = await runConnect(port);
    assert.equal(out.code, 0, `connect died: ${out.stderr}`);
    assert.match(out.stdout, /✓ tunnel identity stored/);
    assert.match(out.stdout, /✓ hooks installed/);
    assert.equal(core.loadTerminalEnv().token, 'hld_minted_by_claim');
    // The paste-the-command door is what connect leaves the human with.
    assert.match(out.stdout, /Run exactly this one bash command and nothing else/);
    assert.doesNotMatch(out.stdout, /enable yourself on Pidge/, 'a magic phrase is not the mechanism');
  } finally { await mock.stop(); }
});

test('connect: a server that reports NO kind is tolerated (an old server is not evidence)', async () => {
  freshHome();
  freshXdg();
  const mock = createMock();
  const port = await mock.start();
  mock.state.claimKind = null; // every deploy before manifest v100
  try {
    const out = await runConnect(port);
    assert.equal(out.code, 0, `the missing field killed 100% of connects — it must not: ${out.stderr}`);
    assert.equal(core.loadTerminalEnv().token, 'hld_minted_by_claim');
  } finally { await mock.stop(); }
});

test('connect: a STANDARD channel still refuses — and KEEPS the key the claim rotated', async () => {
  freshHome();
  freshXdg();
  const mock = createMock();
  const port = await mock.start();
  mock.state.claimKind = 'standard';
  try {
    const out = await runConnect(port);
    assert.equal(out.code, 1, 'the guard must keep working when the server DOES report the kind');
    assert.match(out.stderr, /belongs to a standard channel, not a tunnel/);
    assert.match(out.stderr, /Settings → Computers/);
    // The claim already rotated the key server-side. Dying before persisting it
    // threw it away (QA finding #5): identity first, validation after.
    assert.equal(core.loadTerminalEnv().token, 'hld_minted_by_claim',
      'a post-claim refusal must not discard the rotated key');
    assert.equal(fs.statSync(core.ENV_FILE()).mode & 0o777, 0o600);
    // …and it stopped there: no hooks, no daemon, no skill.
    assert.ok(!fs.existsSync(path.join(process.env.HOME, '.claude', 'settings.json')),
      'a refused connect must not install anything');
  } finally { await mock.stop(); }
});

test('connect: it refreshes the Pidge skill — the agent-side half of the door', async () => {
  freshHome();
  freshXdg();
  const mock = createMock();
  const port = await mock.start();
  mock.state.claimKind = 'tunnel';
  try {
    const out = await runConnect(port);
    assert.equal(out.code, 0, out.stderr);
    const skill = path.join(process.env.HOME, '.claude', 'skills', 'pidge', 'SKILL.md');
    assert.ok(fs.existsSync(skill), `connect must leave a HOME skill (stdout: ${out.stdout})`);
    const text = fs.readFileSync(skill, 'utf8');
    assert.match(text, /pidge terminal enable/, 'the installed skill knows the sentinel command');
    assert.match(text, /is SUCCESS/, 'and that the DENIAL is the success signal');
    assert.ok(!text.includes('hld_minted_by_claim'), 'the generated skill never bakes a token');
    assert.match(out.stdout, /✓ Pidge skill refreshed/);
  } finally { await mock.stop(); }
});

// ===========================================================================
// 3b. commands: the daemon service install, one branch per platform
// ===========================================================================
//
// SAFETY: every branch here writes through launchdPlistPath() (os.homedir())
// or systemdUnitPath() (XDG_CONFIG_HOME) — both redirected to fresh tmp dirs
// by freshHome()/freshXdg() before each test, and asserted at load time above.
// The real ~/Library/LaunchAgents and ~/.config/systemd are never touched, and
// no OS command runs: `run`/`spawn` are injected recorders.

// Capture what the installer printed (say() → console.log).
function captureSay(fn) {
  const lines = [];
  const real = console.log;
  console.log = (...a) => lines.push(a.join(' '));
  try { return { value: fn(), lines }; } finally { console.log = real; }
}

// A recorder for the OS commands the installer would run.
function recorder() {
  const calls = [];
  return { calls, run: (cmd, args) => { calls.push([cmd, ...args].join(' ')); } };
}

function withPlatform(platform, fn) {
  const prev = process.env.PIDGE_TERMINAL_PLATFORM;
  process.env.PIDGE_TERMINAL_PLATFORM = platform;
  try { return fn(); } finally {
    if (prev === undefined) delete process.env.PIDGE_TERMINAL_PLATFORM;
    else process.env.PIDGE_TERMINAL_PLATFORM = prev;
  }
}

test('darwin: installDaemonService writes the launchd plist and loads it (never systemctl)', () => {
  freshHome();
  freshXdg();
  const rec = recorder();
  const svc = withPlatform('darwin', () => commands.installDaemonService({ run: rec.run }));

  assert.equal(svc.kind, 'launchd');
  assert.equal(svc.file, commands.launchdPlistPath());
  assert.ok(svc.file.startsWith(process.env.HOME), 'the plist must land in the tmp HOME');
  const plist = fs.readFileSync(svc.file, 'utf8');
  assert.match(plist, /<key>Label<\/key><string>sh\.pidge\.terminal<\/string>/);
  assert.match(plist, /<string>terminal<\/string>\s*<string>daemon<\/string>/, 'the service runs `terminal daemon`');
  assert.ok(!/PIDGE_SECRET|hld_/.test(plist), 'the tunnel key is NEVER embedded in the template');

  assert.ok(rec.calls.some((c) => c.startsWith('launchctl load -w')), `expected a launchctl load, got ${JSON.stringify(rec.calls)}`);
  assert.ok(!rec.calls.some((c) => c.startsWith('systemctl')), 'darwin must never shell out to systemctl');
  assert.ok(!fs.existsSync(commands.systemdUnitPath()), 'no systemd unit on darwin');
});

test('linux + systemd: a --user unit is written and enabled (launchctl is never called)', () => {
  freshHome();
  freshXdg();
  const rec = recorder();
  const svc = withPlatform('linux', () => commands.installDaemonService({ systemd: true, run: rec.run }));

  assert.equal(svc.kind, 'systemd');
  assert.equal(svc.label, 'pidge-terminal.service');
  assert.equal(svc.file, path.join(process.env.XDG_CONFIG_HOME, 'systemd', 'user', 'pidge-terminal.service'));
  const unit = fs.readFileSync(svc.file, 'utf8');
  assert.match(unit, /^\[Unit\]$/m);
  assert.match(unit, /^\[Install\]\nWantedBy=default\.target$/m);
  assert.match(unit, /^Restart=on-failure$/m);
  assert.match(unit, /^ExecStart=".+" ".+" terminal daemon$/m, 'the service runs `<node> <cli> terminal daemon`');
  assert.match(unit, /^Environment="PATH=/m, 'the shell PATH rides along — the daemon shells out to tmux');
  assert.ok(!/PIDGE_SECRET|hld_/.test(unit), 'the tunnel key is NEVER embedded in the template');

  assert.deepEqual(rec.calls, [
    'systemctl --user daemon-reload',
    'systemctl --user enable --now pidge-terminal.service',
  ]);
  assert.ok(!fs.existsSync(commands.launchdPlistPath()), 'no launchd plist on linux');
});

test('WSL without systemd: no unit, the daemon starts DETACHED and the fallback is spelled out', () => {
  freshHome();
  freshXdg();
  const rec = recorder();
  const spawned = [];
  const fakeSpawn = (cmd, args, opts) => {
    spawned.push({ cmd, args, opts });
    return { pid: 4242, unref() { this.unrefed = true; } };
  };

  const { value: svc, lines } = captureSay(() => withPlatform('linux', () =>
    commands.installDaemonService({ systemd: false, wsl: true, run: rec.run, spawn: fakeSpawn })));

  assert.equal(svc.kind, 'detached');
  assert.equal(svc.pid, 4242);
  assert.deepEqual(rec.calls, [], 'no service manager exists — nothing may be shelled out');
  assert.ok(!fs.existsSync(commands.systemdUnitPath()), 'a unit nothing would load must not be written');
  assert.ok(!fs.existsSync(commands.launchdPlistPath()));

  assert.equal(spawned.length, 1, 'the daemon is started anyway — connect never leaves a tunnel daemon-less');
  assert.deepEqual(spawned[0].args.slice(-2), ['terminal', 'daemon']);
  assert.equal(spawned[0].opts.detached, true, 'detached: it must outlive this shell');
  assert.equal(spawned[0].opts.stdio, 'ignore');

  const out = lines.join('\n');
  assert.match(out, /no systemd/, 'the reason is named');
  assert.match(out, /pid 4242/);
  assert.match(out, /\/etc\/wsl\.conf/, 'WSL gets the systemd=true recipe');
  assert.match(out, /systemd=true/);
  assert.match(out, /wsl --shutdown/);
  assert.match(out, /\.bashrc/, 'and the shell-profile fallback');
});

test('linux without systemd (not WSL): same detached fallback, without the wsl.conf recipe', () => {
  freshHome();
  freshXdg();
  const fakeSpawn = () => ({ pid: 77, unref() {} });
  const { value: svc, lines } = captureSay(() => withPlatform('linux', () =>
    commands.installDaemonService({ systemd: false, wsl: false, spawn: fakeSpawn })));

  assert.equal(svc.kind, 'detached');
  const out = lines.join('\n');
  assert.ok(!/wsl\.conf/.test(out), 'a plain Linux box must not be told to edit /etc/wsl.conf');
  assert.match(out, /\.bashrc/);
});

test('uninstallDaemonService removes the right thing per platform', () => {
  freshHome();
  freshXdg();
  const install = recorder();
  withPlatform('linux', () => commands.installDaemonService({ systemd: true, run: install.run }));
  const unit = commands.systemdUnitPath();
  assert.ok(fs.existsSync(unit));

  const rec = recorder();
  const out = withPlatform('linux', () => commands.uninstallDaemonService({ run: rec.run }));
  assert.deepEqual(out, { kind: 'systemd', removed: true });
  assert.ok(!fs.existsSync(unit), 'the unit file is gone');
  assert.deepEqual(rec.calls, [
    'systemctl --user disable --now pidge-terminal.service',
    'systemctl --user daemon-reload',
  ]);
  assert.ok(!rec.calls.some((c) => c.startsWith('launchctl')), 'linux teardown never calls launchctl');

  // darwin side: the plist goes, and a second pass is honest about finding nothing.
  freshHome();
  const mac = recorder();
  withPlatform('darwin', () => commands.installDaemonService({ run: mac.run }));
  const plist = commands.launchdPlistPath();
  assert.ok(fs.existsSync(plist));
  const rec2 = recorder();
  assert.deepEqual(withPlatform('darwin', () => commands.uninstallDaemonService({ run: rec2.run })),
    { kind: 'launchd', removed: true });
  assert.ok(!fs.existsSync(plist));
  assert.deepEqual(withPlatform('darwin', () => commands.uninstallDaemonService({ run: rec2.run })),
    { kind: 'launchd', removed: false }, 'a second teardown reports nothing removed instead of throwing');
});

test('normalizeTty turns a short tty name into the path tmux reports — on BOTH ps flavors', () => {
  // tmux's #{pane_tty} is always absolute; a hook payload / `ps -o tty=` is
  // short, and the "no controlling tty" marker differs by OS ('??' macOS, '?'
  // Linux). A null here is what routes the enable to the cwd fallback.
  assert.equal(core.normalizeTty('ttys003'), '/dev/ttys003');
  assert.equal(core.normalizeTty('pts/3'), '/dev/pts/3', 'Linux panes must resolve to /dev/pts/N');
  assert.equal(core.normalizeTty('/dev/pts/3'), '/dev/pts/3', 'an already-absolute name is not doubled');
  assert.equal(core.normalizeTty('??'), null, 'macOS: no controlling tty');
  assert.equal(core.normalizeTty('?'), null, 'Linux: no controlling tty — never /dev/?');
  assert.equal(core.normalizeTty(''), null);
  assert.equal(core.normalizeTty(null), null);
});

// --- the tmux pane parser vs the service locale (QA finding #10) ------------
//
// The daemon under launchd has NO LANG; without a UTF-8 locale tmux sanitizes
// control characters in -F output, so the old TAB separator came back as `_`
// and `split('\t')` silently yielded 0 panes — enable then told the human they
// weren't in tmux, with the pane right there. Three defenses, each tested:
// a printable separator, LANG/LC_ALL in the exec env + service templates, and
// a parser that treats an impossible line as a LOUD failure.

test('the tmux list-panes format has NO control characters — tmux may sanitize them', () => {
  assert.ok(!/[\x00-\x1f\x7f]/.test(core.TMUX_PANE_FORMAT),
    'a control-char separator (the old TAB) is sanitized to `_` under a non-UTF-8 locale');
  assert.ok(core.TMUX_PANE_FORMAT.includes(core.TMUX_FIELD_SEP));
  assert.equal(core.TMUX_FIELD_SEP, ':::');
});

test('parseTmuxPanes: the REAL sanitized (no-locale) output is unparsable, never 0 silent panes', () => {
  // The literal line QA #10 captured: launchd env, tmux swapped the TAB
  // separator for `_`, every field ran together.
  const sanitized = '%0_/dev/ttys006_/private/tmp/pidge-qa-proj_probe:0.0';
  const { panes, unparsable } = core.parseTmuxPanes(sanitized);
  assert.deepEqual(panes, [], 'a mangled line must never half-parse into a bogus pane');
  assert.deepEqual(unparsable, [sanitized], 'and it must be REPORTED, not swallowed');

  // The good output with the new separator parses into exact fields.
  const good = [
    ['%0', '/dev/ttys006', '/private/tmp/pidge-qa-proj', 'probe:0.0'].join(core.TMUX_FIELD_SEP),
    ['%12', '/dev/pts/3', '/home/u/proj', 'main:1.2'].join(core.TMUX_FIELD_SEP),
  ].join('\n');
  const ok = core.parseTmuxPanes(good);
  assert.deepEqual(ok.unparsable, []);
  assert.deepEqual(ok.panes, [
    { paneId: '%0', tty: '/dev/ttys006', path: '/private/tmp/pidge-qa-proj', loc: 'probe:0.0' },
    { paneId: '%12', tty: '/dev/pts/3', path: '/home/u/proj', loc: 'main:1.2' },
  ]);
});

test('tmuxPanes: ALL lines mangled ⇒ a loud throw; a stray bad line warns but keeps the good ones', () => {
  const sanitized = '%0_/dev/ttys006_/private/tmp/pidge-qa-proj_probe:0.0\n';
  const warns = [];
  assert.throws(
    () => core.tmuxPanes({ exec: () => sanitized, onWarn: (m) => warns.push(m) }),
    /none parsed/,
    'reading a mangled list as "0 panes ⇒ not in tmux" is the finding-#10 lie');
  assert.equal(warns.length, 1);
  assert.match(warns[0], /UNPARSABLE/);
  assert.match(warns[0], /not a user error/);

  // Mixed output: the parsable pane survives, the bad line is warned about.
  const mixed = ['%1', '/dev/ttys001', '/tmp/a', 's:0.0'].join(core.TMUX_FIELD_SEP) + '\ngarbage-line\n';
  const warns2 = [];
  const panes = core.tmuxPanes({ exec: () => mixed, onWarn: (m) => warns2.push(m) });
  assert.deepEqual(panes, [{ paneId: '%1', tty: '/dev/ttys001', path: '/tmp/a', loc: 's:0.0' }]);
  assert.equal(warns2.length, 1);

  // tmux itself absent/failing is still a quiet [] — genuinely no panes.
  assert.deepEqual(core.tmuxPanes({ exec: () => { throw new Error('no server'); } }), []);
});

test('utf8Locale: prefers the locale the shell proved, falls back per platform', () => {
  assert.equal(core.utf8Locale({ LC_ALL: 'pt_BR.UTF-8' }, 'darwin'), 'pt_BR.UTF-8');
  assert.equal(core.utf8Locale({ LANG: 'en_US.utf8' }, 'linux'), 'en_US.utf8');
  assert.equal(core.utf8Locale({ LANG: 'C' }, 'darwin'), 'en_US.UTF-8', 'a non-UTF-8 LANG is exactly the failure');
  assert.equal(core.utf8Locale({}, 'darwin'), 'en_US.UTF-8', 'macOS ships en_US.UTF-8');
  assert.equal(core.utf8Locale({}, 'linux'), 'C.UTF-8', 'modern glibc ships C.UTF-8 without locale-gen');
});

test('a daemon whose pane list cannot be parsed refuses WITHOUT blaming the user', async () => {
  const d = readyDaemon();
  d.hookToken = 'local-test-token';
  const out = await withPanes({
    byTty: () => { throw new Error('tmux listed 1 pane(s) but none parsed — mangled'); },
  }, () => hookPost(d, 'pre-tool-use', preToolUse('sess-mangled', 'pidge terminal enable')));

  assert.equal(out.decision.permissionDecision, 'deny');
  assert.equal(out.decision.permissionDecisionReason, core.ENABLE_PANE_LOOKUP_FAILED_REASON);
  assert.doesNotMatch(out.decision.permissionDecisionReason, /Start claude inside/i,
    'a daemon-side parse failure must not tell the human to fix their tmux');
  assert.equal(d.sessions.size, 0);
  assert.ok(d.logLines.some((l) => /REFUSED: tmux listed/.test(l)), `expected the loud cause, got ${JSON.stringify(d.logLines)}`);
});

test('both service templates carry a UTF-8 locale (launchd and systemd hand the daemon none)', () => {
  freshHome();
  freshXdg();
  const rec = recorder();
  const mac = withPlatform('darwin', () => commands.installDaemonService({ run: rec.run }));
  const plist = fs.readFileSync(mac.file, 'utf8');
  assert.match(plist, /<key>LANG<\/key><string>[^<]*(UTF-8|utf8)<\/string>/i);
  assert.match(plist, /<key>LC_ALL<\/key><string>[^<]*(UTF-8|utf8)<\/string>/i);

  freshHome();
  freshXdg();
  const lin = withPlatform('linux', () => commands.installDaemonService({ systemd: true, run: recorder().run }));
  const unit = fs.readFileSync(lin.file, 'utf8');
  assert.match(unit, /^Environment="LANG=[^"]*(UTF-8|utf8)"$/im);
  assert.match(unit, /^Environment="LC_ALL=[^"]*(UTF-8|utf8)"$/im);
});

// --- the enable SENTINEL matcher (the door's whole contract) ----------------

test('parseEnableSentinel: only a Bash command carrying the literal opens the door', () => {
  const ok = (cmd, tool = 'Bash') => core.parseEnableSentinel(tool, cmd);

  assert.deepEqual(ok('pidge terminal enable'), { approvals: [] });
  // The app's descriptive prompt EMBEDS the command — claude often echoes it back.
  assert.deepEqual(ok('Run exactly this one bash command and nothing else: pidge terminal enable'), { approvals: [] });
  // …and the improvisation a real claude fell into when `pidge` was not on PATH.
  assert.deepEqual(ok('npx -y pidge-cli@latest terminal enable'), { approvals: [] });
  assert.deepEqual(ok('npx pidge-cli terminal enable'), { approvals: [] });

  // The approval gate rides the pasted command now — the CLI is not the door.
  assert.deepEqual(ok('pidge terminal enable --approvals Bash,Write'), { approvals: ['Bash', 'Write'] });
  assert.deepEqual(ok('pidge terminal enable --approvals=*'), { approvals: ['*'] });

  // Not the sentinel.
  assert.equal(ok('pidge terminal status'), null);
  assert.equal(ok('pidge listen --all'), null);
  assert.equal(ok('echo terminal enable'), null, 'nothing names pidge — not our command');
  assert.equal(ok('pidge terminal enable', 'Read'), null, 'only the Bash tool carries commands');
  assert.equal(core.parseEnableSentinel('Bash', undefined), null);
  assert.equal(core.parseEnableSentinel(undefined, 'pidge terminal enable'), null);
});

test('the two deny reasons are the exact strings claude will read', () => {
  assert.equal(core.ENABLE_OK_REASON,
    "✓ Pidge is now mirroring this Claude session to the human's phone. This is expected — do NOT run any other command, do NOT go online, do NOT read or ack any queue.");
  assert.equal(core.ENABLE_NO_PANE_REASON,
    "Couldn't mirror this session: it isn't in a uniquely-identifiable tmux pane. Start claude inside its own tmux pane and paste the command again. Do not run other commands.");
  // The pasted prompt is self-sufficient: it constrains the agent to ONE
  // command and pre-empts both improvisations QA caught (go online / ack).
  assert.match(core.ENABLE_PROMPT, /Run exactly this one bash command and nothing else: `pidge terminal enable`/);
  assert.match(core.ENABLE_PROMPT, /do not read or ack any queue/);
});

// --- the stable CLI copy (the service must not point into the npx cache) ----

test('installing the service COPIES the CLI to a stable path and points ExecStart THERE', () => {
  freshHome();
  freshXdg();
  const rec = recorder();
  const svc = withPlatform('linux', () => commands.installDaemonService({ systemd: true, run: rec.run }));
  const unit = fs.readFileSync(svc.file, 'utf8');
  const exec = unit.split('\n').find((l) => l.startsWith('ExecStart='));

  assert.ok(fs.existsSync(commands.stableCliEntry()), 'the copy must exist before the unit names it');
  assert.ok(fs.existsSync(path.join(commands.stableCliDir(), 'src', 'terminal', 'daemon.js')),
    'src/ rides along — bin/pidge.js requires it at runtime');
  assert.ok(exec.includes(commands.stableCliEntry()), `ExecStart must point at the stable copy, got ${exec}`);
  assert.ok(!/_npx/.test(exec), 'a service pointing into the npx cache dies when npm prunes it');
  assert.ok(commands.stableCliEntry().startsWith(process.env.XDG_CONFIG_HOME), 'and it lives in this feature own slot');

  // The copy is a real, runnable CLI — not a shell of files.
  const out = execFileSync(process.execPath, [commands.stableCliEntry(), '--version'], { encoding: 'utf8' }).trim();
  assert.match(out, /^\d+\.\d+\.\d+/, `the stable copy must run standalone, got ${JSON.stringify(out)}`);

  // darwin says the same thing through the plist.
  freshHome();
  freshXdg();
  const mac = recorder();
  const macSvc = withPlatform('darwin', () => commands.installDaemonService({ run: mac.run }));
  const plist = fs.readFileSync(macSvc.file, 'utf8');
  assert.ok(plist.includes(commands.stableCliEntry()));
  assert.ok(!/_npx/.test(plist));
});

test('a second connect REPLACES the stable copy instead of merging into a half-old tree', () => {
  freshHome();
  freshXdg();
  const first = commands.copyCliToStablePath();
  fs.writeFileSync(path.join(commands.stableCliDir(), 'stale-marker'), 'x');

  const second = commands.copyCliToStablePath();
  assert.equal(second, first);
  assert.ok(!fs.existsSync(path.join(commands.stableCliDir(), 'stale-marker')),
    'an upgrade must not leave a previous version file behind');
  assert.deepEqual(fs.readdirSync(core.terminalDir()).filter((f) => /^cli\.new\./.test(f)), [],
    'no staging dir may survive a successful swap');
});

// ===========================================================================
// 3c. `pidge update` — the CLI keeps itself current
// ===========================================================================

const update = require('../src/update');

test('update: it INVOKES the package manager and reports the version it moved to', async () => {
  const runs = [];
  const said = [];
  const r = await update.runUpdate({
    run: (cmd, args) => runs.push([cmd, ...args].join(' ')),
    fetchLatest: async () => '9.9.9',
    current: '0.41.0',
    manager: 'npm',
    say: (m) => said.push(m),
    warn: (m) => said.push(m),
  });

  assert.deepEqual(runs, ['npm i -g pidge-cli@latest'], 'the whole point is that it actually installs');
  assert.equal(r.ok, true);
  assert.equal(r.ran, true);
  assert.match(said.join('\n'), /installed pidge-cli@9\.9\.9 \(was 0\.41\.0\)/);
});

test('update: already current ⇒ no manager runs; a failed install is non-ok + the manual line', async () => {
  const runs = [];
  const current = await update.runUpdate({
    run: (cmd, args) => runs.push(cmd + args.join(' ')), fetchLatest: async () => '0.41.0',
    current: '0.41.0', manager: 'npm', say: () => {}, warn: () => {},
  });
  assert.deepEqual(runs, [], 'no reinstall when there is nothing to gain');
  assert.equal(current.ran, false);
  assert.equal(current.ok, true);

  const warns = [];
  const failed = await update.runUpdate({
    run: () => { throw new Error('EACCES'); }, fetchLatest: async () => '9.9.9',
    current: '0.41.0', manager: 'npm', say: () => {}, warn: (m) => warns.push(m),
  });
  assert.equal(failed.ok, false);
  assert.match(warns.join('\n'), /npm i -g pidge-cli@latest failed \(EACCES\)/);
  assert.match(warns.join('\n'), /Install it yourself/, 'a failure always hands back the manual line');
});

test('update: an unreachable registry warns and installs anyway (never blocks)', async () => {
  const runs = [];
  const warns = [];
  const r = await update.runUpdate({
    run: (cmd, args) => runs.push([cmd, ...args].join(' ')), fetchLatest: async () => null,
    current: '0.41.0', manager: 'pnpm', say: () => {}, warn: (m) => warns.push(m),
  });
  assert.deepEqual(runs, ['pnpm add -g pidge-cli@latest'], 'each manager gets its own verb');
  assert.equal(r.ok, true);
  assert.match(warns.join('\n'), /could not reach the npm registry/);
});

test('update: the manager is inferred from where THIS copy lives; semver compares numerically', () => {
  assert.equal(update.detectManager('/Users/x/.npm/_npx/abc/node_modules/.bin/pidge'), 'npm');
  assert.equal(update.detectManager('/Users/x/Library/pnpm/global/5/node_modules/pidge-cli/bin/pidge.js'), 'pnpm');
  assert.equal(update.detectManager('/Users/x/.yarn/bin/pidge'), 'yarn');
  assert.equal(update.detectManager('/Users/x/.bun/install/global/node_modules/pidge-cli/bin/pidge.js'), 'bun');

  assert.equal(update.isOlder('0.28.0', '0.41.0'), true, 'the exact gap the installed base sat in');
  assert.equal(update.isOlder('0.9.0', '0.10.0'), true, 'numeric, not lexicographic');
  assert.equal(update.isOlder('0.41.0', '0.41.0'), false);
  assert.equal(update.isOlder('1.0.0', '0.41.0'), false);
  assert.equal(update.currentVersion(), require('../package.json').version);
});

// ===========================================================================
// 4. daemon: sealing and the input-lane replay ledger
// ===========================================================================

const SECRET = SECRET43();

// Build a daemon against a fresh, fully isolated config slot. No listener, no
// launchd, no network: only the constructor runs.
function makeDaemon() {
  freshXdg();
  core.saveTerminalEnv({ base: 'http://127.0.0.1:9', token: 'hld_x', secret: SECRET, channelId: 1 });
  core.writeJson(core.DAEMON_FILE(), { port: 41717, token: 'local-test-token' });
  const d = new Daemon();
  d.logLines = [];
  d.log = (...args) => { d.logLines.push(args.join(' ')); };
  return d;
}

// A daemon whose state.json already carries ONE enabled session, as a previous
// process would have left it — the input to every re-arm test below.
function daemonWithPersisted({ sid = 'sess-k', ...overrides } = {}) {
  makeDaemon(); // fresh slot + the epoch a first process would have written
  const st = core.readJson(core.STATE_FILE(), { epoch: 1, sessions: {} });
  st.sessions[sid] = {
    publicId: `ases_${sid}`, paneId: '%1', tty: null, cwd: '/tmp/proj',
    channelId: 1, // the tunnel this slot is connected to (finding #13 scoping)
    file: path.join(tmp('pidge-term-jsonl-'), 'absent.jsonl'),
    offset: 0, nextSeq: 1, approvals: [], seen: [], outbox: [], ...overrides,
  };
  core.writeJson(core.STATE_FILE(), st);
  const d = new Daemon();
  d.logLines = [];
  d.log = (...a) => { d.logLines.push(a.join(' ')); };
  d.subscribeInput = () => {};
  return d;
}

test('the daemon refuses to construct without a stored identity', () => {
  freshXdg();
  assert.throws(() => new Daemon(), /not connected/);
});

test('the daemon constructs from the stored identity and bumps the epoch per process', () => {
  const d = makeDaemon();
  assert.equal(d.env.channelId, 1);
  assert.deepEqual(d.key, Buffer.from(SECRET, 'base64url'));
  assert.ok(d.state.epoch >= 1);
  assert.equal(d.caps.item_sealed_max_bytes, 16384);

  const persisted = core.readJson(core.STATE_FILE(), null);
  assert.equal(persisted.epoch, d.state.epoch, 'the new epoch is written before anything can echo it');

  const d2 = new Daemon(); // same slot, next process
  assert.equal(d2.state.epoch, d.state.epoch + 1);
});

test('sealItem: a normal item roundtrips and never carries daemon-internal fields', () => {
  const d = makeDaemon();
  const [item] = adapter.normalize({
    type: 'assistant', uuid: 'u-seal', parentUuid: 'p', version: '2.1.220',
    message: { role: 'assistant', content: 'hello from the pane' },
  });
  item._publicId = 'ases_t';

  const b64 = d.sealItem(item);
  const sealed = Buffer.from(b64, 'base64url');
  assert.ok(sealed.length <= d.caps.item_sealed_max_bytes);

  const plain = core.e2eDecryptBlob(d.key, core.e2eAad(1, 'ases_t', 'agent_transcript'), sealed);
  const back = JSON.parse(plain.toString('utf8'));
  assert.equal(back.uuid, 'u-seal');
  assert.equal(back.preview, 'hello from the pane');
  assert.equal(back.harness, 'claude');
  assert.equal(back.hv, '2.1.220');
  assert.ok(!('_publicId' in back), 'the routing anchor is AAD, never plaintext');
});

test('sealItem: an oversized preview degrades INSIDE the cap instead of bouncing', () => {
  const d = makeDaemon();
  const item = {
    v: 1, uuid: 'u-big', parent: null, ts: null, role: 'assistant', kind: 'text',
    preview: 'z'.repeat(100 * 1024), truncated: false, total_bytes: 100 * 1024,
    harness: 'claude', hv: null, _publicId: 'ases_t',
  };

  const b64 = d.sealItem(item);
  assert.ok(b64 !== null, 'a text item must always fit after degradation');
  const sealed = Buffer.from(b64, 'base64url');
  assert.ok(sealed.length <= d.caps.item_sealed_max_bytes,
    `sealed ${sealed.length}B exceeds the ${d.caps.item_sealed_max_bytes}B cap`);

  const back = JSON.parse(core.e2eDecryptBlob(d.key, core.e2eAad(1, 'ases_t', 'agent_transcript'), sealed).toString('utf8'));
  assert.ok(Buffer.byteLength(back.preview, 'utf8') <= adapter.PREVIEW_BYTES);
  assert.equal(back.truncated, true, 'degrading must be reported honestly');
  assert.equal(back.total_bytes, 100 * 1024);
});

test('sealItem: a shrunken cap forces the ladder down and says so', () => {
  const d = makeDaemon();
  d.caps = { ...d.caps, item_sealed_max_bytes: 600 };
  const item = {
    v: 1, uuid: 'u-tight', parent: null, ts: null, role: 'assistant', kind: 'text',
    preview: 'z'.repeat(4096), truncated: false, total_bytes: 4096,
    harness: 'claude', hv: null, _publicId: 'ases_t',
  };

  const b64 = d.sealItem(item);
  const sealed = Buffer.from(b64, 'base64url');
  assert.ok(sealed.length <= 600, `sealed ${sealed.length}B exceeds the shrunken cap`);
  const back = JSON.parse(core.e2eDecryptBlob(d.key, core.e2eAad(1, 'ases_t', 'agent_transcript'), sealed).toString('utf8'));
  assert.ok(Buffer.byteLength(back.preview, 'utf8') <= 256);
  assert.ok(d.logLines.some((l) => /degraded/.test(l)), `expected a loud degrade line, got ${JSON.stringify(d.logLines)}`);
});

// --- input lane -------------------------------------------------------------

function inputSession() {
  return { sid: 'sess-test', publicId: 'ases_t', paneId: null, tty: null, status: 'idle', waitingArmed: true, approvals: [] };
}
function sealFrame(d, msg, { aad } = {}) {
  return core.e2eEncryptBlob(d.key, aad || core.e2eAad(1, 'ases_t', 'agent_input'),
    Buffer.from(JSON.stringify(msg), 'utf8')).toString('base64url');
}

test('input lane: a valid frame passes the ledger, and the replay of it does not', () => {
  const d = makeDaemon();
  const s = inputSession();
  const frame = sealFrame(d, { t: 'i', vgen: 'v1', seq: 1, he: d.state.epoch, keys: [{ lit: 'hi' }] });

  d.handleInputFrame(s, frame);
  assert.equal(d.logLines.length, 1);
  assert.match(d.logLines[0], /no bound pane/, 'the ledger accepted it; only the missing pane stopped it');
  assert.equal(d.replay.get('ases_t|v1'), 1);

  d.logLines = [];
  d.handleInputFrame(s, frame); // byte-identical replay
  assert.equal(d.logLines.length, 1);
  assert.match(d.logLines[0], /replay/);
  assert.equal(d.replay.get('ases_t|v1'), 1);
});

test('input lane: seq must advance within a vgen, and a fresh vgen starts its own ledger', () => {
  const d = makeDaemon();
  const s = inputSession();
  d.handleInputFrame(s, sealFrame(d, { t: 'i', vgen: 'v1', seq: 5, he: d.state.epoch, keys: [] }));
  assert.equal(d.replay.get('ases_t|v1'), 5);

  d.logLines = [];
  d.handleInputFrame(s, sealFrame(d, { t: 'i', vgen: 'v1', seq: 4, he: d.state.epoch, keys: [] }));
  assert.match(d.logLines[0], /replay/);

  d.logLines = [];
  d.handleInputFrame(s, sealFrame(d, { t: 'i', vgen: 'v2', seq: 1, he: d.state.epoch, keys: [] }));
  assert.match(d.logLines[0], /no bound pane/, 'a new viewer generation is not a replay');
  assert.equal(d.replay.get('ases_t|v2'), 1);
});

test('input lane: ciphertext minted before this daemon boot is dropped on the epoch echo', () => {
  const d = makeDaemon();
  const s = inputSession();
  d.handleInputFrame(s, sealFrame(d, { t: 'i', vgen: 'v1', seq: 1, he: d.state.epoch - 1, keys: [{ lit: 'stale' }] }));
  assert.equal(d.logLines.length, 1);
  assert.match(d.logLines[0], /epoch/);
  assert.equal(d.replay.has('ases_t|v1'), false, 'a rejected frame must not seed the ledger');
});

test('input lane: garbage and malformed frames are rejected before the ledger', () => {
  const d = makeDaemon();
  const s = inputSession();

  d.handleInputFrame(s, '!!!!not base64!!!!');
  assert.match(d.logLines.at(-1), /rejected/);

  d.logLines = [];
  d.handleInputFrame(s, core.e2eEncryptBlob(d.key, core.e2eAad(1, 'ases_t', 'agent_transcript'),
    Buffer.from('{}')).toString('base64url')); // right key, wrong AAD field
  assert.match(d.logLines.at(-1), /rejected/);

  for (const bad of [
    { vgen: 'v1', seq: 1, he: 0 },                      // no t
    { t: 'i', seq: 1, he: 0 },                          // no vgen
    { t: 'i', vgen: 'v1', he: 0 },                      // no seq
    { t: 'i', vgen: 'v1', seq: 1 },                     // no epoch echo
    { t: 'i', vgen: 'v1', seq: 1.5, he: 0 },            // non-integer seq
  ]) {
    d.logLines = [];
    d.handleInputFrame(s, sealFrame(d, { ...bad, he: bad.he === undefined ? undefined : d.state.epoch }));
    assert.match(d.logLines.at(-1), /missing t\/vgen\/seq\/he/, `should have dropped ${JSON.stringify(bad)}`);
    assert.equal(d.replay.size, 0);
  }
});

test('input lane: a frame for a retired viewer generation is dropped silently', () => {
  const d = makeDaemon();
  const s = inputSession();
  d.retiredVgens.add('ases_t|vold');
  d.handleInputFrame(s, sealFrame(d, { t: 'i', vgen: 'vold', seq: 1, he: d.state.epoch, keys: [{ lit: 'x' }] }));
  assert.deepEqual(d.logLines, [], 'a retired generation is expected traffic, not an incident');
  assert.equal(d.replay.has('ases_t|vold'), false);
});

test('sealMeta: the session meta seals under its own AAD field and carries the epoch', () => {
  const d = makeDaemon();
  const session = { publicId: 'ases_t', title: 'pidge-cli', cwd: '/tmp/pidge-cli', hv: '2.1.220', paneId: '%3' };
  const sealed = Buffer.from(d.sealMeta(session), 'base64url');

  assert.throws(() => core.e2eDecryptBlob(d.key, core.e2eAad(1, 'ases_t', 'agent_transcript'), sealed), /authenticate/);
  const meta = JSON.parse(core.e2eDecryptBlob(d.key, core.e2eAad(1, 'ases_t', 'agent_meta'), sealed).toString('utf8'));
  assert.equal(meta.title, 'pidge-cli');
  assert.equal(meta.harness, 'claude');
  assert.equal(meta.harness_version, '2.1.220');
  assert.deepEqual(meta.tmux, { pane_id: '%3' });
  assert.equal(meta.epoch, d.state.epoch);
});

test('the tool gate matches case-insensitively and honors the wildcard', () => {
  const d = makeDaemon();
  assert.equal(d.toolGated({ approvals: ['Bash'] }, 'bash'), true);
  assert.equal(d.toolGated({ approvals: ['bash'] }, 'Bash'), true);
  assert.equal(d.toolGated({ approvals: ['Bash'] }, 'Edit'), false);
  assert.equal(d.toolGated({ approvals: ['*'] }, 'Anything'), true);
  assert.equal(d.toolGated({ approvals: [] }, 'Bash'), false);
  assert.equal(d.toolGated({ approvals: ['*'] }, undefined), false);
});

// --- the publish lane (flush): backoff, teardown, seq re-sync ---------------

// A minimal live session record, registered in the daemon's map exactly as
// enableSession would leave it. `queue` accepts bare strings for readability —
// the outbox entry is {uuid, sealed} (the uuid is what a restart re-dedups on).
function liveSession(d, { queue = [], nextSeq = 1, file = '/tmp/nonexistent.jsonl', sid = 'sess-flush' } = {}) {
  const entries = queue.map((q, i) => (typeof q === 'string' ? { uuid: `u-q${i}`, sealed: q } : q));
  const s = {
    sid, publicId: 'ases_t', paneId: '%1', tty: null, cwd: '/tmp/proj',
    file, title: 'proj', hv: null,
    offset: 0, seenUuids: new Set(), seenRing: [],
    queue: entries, outboxBytes: entries.reduce((n, e) => n + e.sealed.length, 0),
    nextSeq, status: 'idle', waitingArmed: true, approvals: [],
    flushing: false, backfilled: 0, registered: true, registering: false,
    backoff: 0, nextFlushAt: 0, gen: 0,
  };
  d.sessions.set(s.sid, s);
  return s;
}
const sealedOf = (queue) => queue.map((e) => e.sealed);

test('flush: a failing POST settles into exponential backoff instead of storming', async () => {
  const d = makeDaemon();
  const s = liveSession(d, { queue: ['a', 'b'] });
  let posts = 0;
  d.api = async () => { posts += 1; return { res: { status: 402 }, data: { code: 'terminal_requires_pro' } }; };

  await d.flush(s);
  assert.equal(posts, 1);
  assert.equal(s.backoff, 2);
  assert.ok(s.nextFlushAt > Date.now(), 'the backoff window must be armed');
  assert.equal(s.flushing, false);

  // The 500 ms tick used to re-enter immediately (flushing was already false),
  // turning every failure into a 2 req/s storm. It must now skip the session.
  for (let i = 0; i < 10; i++) await d.flushTick();
  assert.equal(posts, 1, 'flushTick must honor the backoff window');

  // Once the window elapses, exactly ONE retry goes out and the window doubles.
  s.nextFlushAt = Date.now() - 1;
  await d.flushTick();
  assert.equal(posts, 2);
  assert.equal(s.backoff, 4);
  assert.deepEqual(sealedOf(s.queue), ['a', 'b'], 'nothing is lost — the JSONL is durable');

  // A success clears the window.
  d.api = async () => ({ res: { status: 201 }, data: { accepted: 2, last_seq: 2 } });
  s.nextFlushAt = Date.now() - 1;
  await d.flushTick();
  assert.deepEqual(s.queue, []);
  assert.equal(s.backoff, 0);
  assert.equal(s.nextFlushAt, 0);
  assert.equal(s.nextSeq, 3);
});

test('flush: a session disabled mid-POST is NOT revived by the late 201', async () => {
  const d = makeDaemon();
  const s = liveSession(d, { queue: ['a'] });
  d.persistSession(s); // as enable would have
  assert.ok(core.readJson(core.STATE_FILE(), {}).sessions['sess-flush'], 'precondition: persisted');

  d.api = async (method, p) => {
    if (method === 'POST' && /\/items$/.test(p)) {
      // The human hits `pidge terminal disable` while the request is in flight.
      await d.disableSession('sess-flush', 'requested');
      return { res: { status: 201 }, data: { accepted: 1, last_seq: 1 } };
    }
    return { res: { status: 200 }, data: {} };
  };

  await d.flush(s);
  assert.equal(d.sessions.has('sess-flush'), false);
  assert.equal(core.readJson(core.STATE_FILE(), {}).sessions['sess-flush'], undefined,
    'a disabled session must not be written back into state.json — it would revive on the next boot');
  assert.ok(d.logLines.some((l) => /disabled mid-flush/.test(l)));
});

test('flush: a lost 201 drops exactly the already-stored items, never re-sends or blind-drops', async () => {
  const d = makeDaemon();
  // 5 items queued as seq 1..5; the server already stored 1..3 (the ack for
  // that batch was lost), so only 4 and 5 may go out.
  const s = liveSession(d, { queue: ['i1', 'i2', 'i3', 'i4', 'i5'], nextSeq: 1 });
  const sent = [];
  let serverLastSeq = 3;
  d.api = async (method, p, body) => {
    if (method === 'POST' && /\/items$/.test(p)) {
      const first = body.items[0].seq;
      if (first <= serverLastSeq) return { res: { status: 422 }, data: { code: 'seq_regression' } };
      for (const it of body.items) sent.push(it.seq);
      serverLastSeq = body.items.at(-1).seq;
      return { res: { status: 201 }, data: { accepted: body.items.length, last_seq: serverLastSeq } };
    }
    if (method === 'POST' && p === '/agent_sessions') {
      return { res: { status: 201 }, data: { session: { public_id: 'ases_t', last_seq: serverLastSeq } } };
    }
    return { res: { status: 200 }, data: {} };
  };

  await d.flush(s);
  assert.deepEqual(sent, [4, 5], 'stored seqs are never re-sent, unstored ones are never dropped');
  assert.deepEqual(s.queue, []);
  assert.equal(s.nextSeq, 6);
  assert.ok(d.logLines.some((l) => /already stored/.test(l)));
});

test('flush: an unexplained seq_regression backs off instead of spinning or dropping a batch', async () => {
  const d = makeDaemon();
  const s = liveSession(d, { queue: ['i1', 'i2'], nextSeq: 10 });
  let posts = 0;
  d.api = async (method, p) => {
    if (method === 'POST' && /\/items$/.test(p)) { posts += 1; return { res: { status: 422 }, data: { code: 'seq_regression' } }; }
    if (method === 'POST' && p === '/agent_sessions') return { res: { status: 201 }, data: { session: { last_seq: 9 } } };
    return { res: { status: 200 }, data: {} };
  };

  await d.flush(s);
  assert.equal(posts, 1, 'no spin');
  assert.deepEqual(sealedOf(s.queue), ['i1', 'i2'], 'the old code dropped a whole batch "to break the loop"');
  assert.equal(s.nextSeq, 10);
  assert.ok(s.nextFlushAt > Date.now());
});

test('flush: a seq gap the daemon cannot fill resumes loudly above the server high-water', async () => {
  const d = makeDaemon();
  const s = liveSession(d, { queue: ['i1'], nextSeq: 50 });
  const sent = [];
  let serverLastSeq = 7;
  d.api = async (method, p, body) => {
    if (method === 'POST' && /\/items$/.test(p)) {
      if (body.items[0].seq > serverLastSeq + 40) return { res: { status: 422 }, data: { code: 'seq_regression' } };
      for (const it of body.items) sent.push(it.seq);
      return { res: { status: 201 }, data: { accepted: 1, last_seq: body.items.at(-1).seq } };
    }
    if (method === 'POST' && p === '/agent_sessions') return { res: { status: 201 }, data: { session: { last_seq: serverLastSeq } } };
    return { res: { status: 200 }, data: {} };
  };

  await d.flush(s);
  assert.deepEqual(sent, [8], 'the item is published, renumbered onto the server high-water');
  assert.deepEqual(s.queue, []);
  assert.ok(d.logLines.some((l) => /seq GAP/.test(l)));
});

test('enable: a failure after the register leaves neither a live record nor a persisted one', async () => {
  const d = makeDaemon();
  d.registerSession = async () => ({ last_seq: 0 });
  d.backfill = async () => { throw new Error('network went away mid-backfill'); };
  d.subscribeInput = () => {};

  await assert.rejects(() => d.enableSession({
    sid: 'sess-fail', paneId: '%1', tty: null, cwd: '/tmp/proj', file: '/tmp/x.jsonl', approvals: [],
  }), /mid-backfill/);

  assert.equal(d.sessions.has('sess-fail'), false, 'a live-but-lockless session would publish without the B3 guarantee');
  assert.equal(core.readJson(core.STATE_FILE(), {}).sessions['sess-fail'], undefined);
  assert.equal(fs.existsSync(d.lockPath('sess-fail')), false, 'the writer lock is released');
});

// --- the enable door: the PreToolUse sentinel -------------------------------
//
// These drive the daemon's REAL http handler with a synthetic Claude Code
// PreToolUse body, exactly as the hook shim would POST it. No tmux runs: the
// pane lookups are injected (core.tmuxPaneForTty / core.tmuxPanesForCwd are
// called by property, so a swap is enough) — the point under test is the
// correlation and the response, not tmux itself.

function readyDaemon() {
  const d = makeDaemon();
  d.registerSession = async () => ({ last_seq: 0 });
  d.backfill = async () => {};
  d.subscribeInput = () => {};
  return d;
}

// POST a hook event through handleHttp and return the parsed response.
async function hookPost(d, slug, body) {
  const req = {
    method: 'POST', url: `/hook/${slug}`,
    headers: { authorization: `Bearer ${d.hookToken}` },
    on(event, cb) {
      if (event === 'data') cb(JSON.stringify(body));
      if (event === 'end') cb();
    },
    destroy() {},
  };
  let out = null;
  const res = { writeHead() {}, end(payload) { out = JSON.parse(payload || '{}'); } };
  await d.handleHttp(req, res);
  return out;
}

// The pane resolvers, swapped for the duration of one call.
async function withPanes({ byTty = () => null, byCwd = () => [] }, fn) {
  const realTty = core.tmuxPaneForTty;
  const realCwd = core.tmuxPanesForCwd;
  core.tmuxPaneForTty = byTty;
  core.tmuxPanesForCwd = byCwd;
  try { return await fn(); } finally {
    core.tmuxPaneForTty = realTty;
    core.tmuxPanesForCwd = realCwd;
  }
}

const preToolUse = (sid, command, extra = {}) => ({
  session_id: sid, tool_name: 'Bash', tool_input: { command },
  cwd: '/tmp/proj', transcript_path: '/tmp/none.jsonl', tty: '/dev/ttys004', ...extra,
});

test('sentinel: the PreToolUse hook enables the announced session and DENIES the tool', async () => {
  const d = readyDaemon();
  d.hookToken = 'local-test-token';
  // The SessionStart announce this session made when it started.
  await hookPost(d, 'session-start', {
    session_id: 'sess-hook', cwd: '/tmp/proj', transcript_path: '/tmp/none.jsonl', tty: '/dev/ttys004',
  });
  assert.equal(d.announces.get('sess-hook').tty, '/dev/ttys004');

  const out = await withPanes({ byTty: (tty) => (tty === '/dev/ttys004' ? { paneId: '%3', loc: 'probe:0.0' } : null) },
    () => hookPost(d, 'pre-tool-use', preToolUse('sess-hook', 'pidge terminal enable')));

  // The session is REGISTERED, bound to the announced pane…
  const s = d.sessions.get('sess-hook');
  assert.ok(s, 'the hook must enable the exact session id the harness handed it');
  assert.equal(s.paneId, '%3');
  assert.equal(s.publicId, 'ases_sess-hook');
  assert.ok(core.readJson(core.STATE_FILE(), {}).sessions['sess-hook'], 'and persisted, like any share');

  // …and the tool is DENIED, carrying the outcome as its reason: the bash never
  // runs, so `pidge` need not exist on this machine (QA finding #8).
  assert.deepEqual(out, {
    decision: { permissionDecision: 'deny', permissionDecisionReason: core.ENABLE_OK_REASON },
  });

  // Idempotent: pasting twice says the same ✓, never a second share.
  const again = await withPanes({ byTty: () => { throw new Error('an already-shared session must not re-resolve a pane'); } },
    () => hookPost(d, 'pre-tool-use', preToolUse('sess-hook', 'pidge terminal enable')));
  assert.equal(again.decision.permissionDecisionReason, core.ENABLE_OK_REASON);
  assert.equal(d.sessions.size, 1);
});

test('sentinel: with no announce at all, the hook payload itself is the binding source', async () => {
  const d = readyDaemon();
  d.hookToken = 'local-test-token';
  // claude started BEFORE the daemon: no SessionStart ever reached us.
  const out = await withPanes({ byTty: () => ({ paneId: '%9', loc: 'probe:1.0' }) },
    () => hookPost(d, 'pre-tool-use', preToolUse('sess-cold', 'pidge terminal enable')));

  assert.equal(out.decision.permissionDecisionReason, core.ENABLE_OK_REASON);
  const s = d.sessions.get('sess-cold');
  assert.equal(s.paneId, '%9');
  assert.equal(s.file, '/tmp/none.jsonl', 'the payload carries the transcript path too');
});

test('sentinel: no tty ⇒ the cwd fallback binds, but ONLY when exactly one pane matches', async () => {
  // Claude Code can run a hook without a controlling tty ('??' / '?'), which
  // normalizes to null — the case the tty match cannot serve.
  const one = readyDaemon();
  one.hookToken = 'local-test-token';
  const ok = await withPanes({ byCwd: (cwd) => (cwd === '/tmp/proj' ? [{ paneId: '%5', loc: 'probe:0.1' }] : []) },
    () => hookPost(one, 'pre-tool-use', preToolUse('sess-cwd', 'pidge terminal enable', { tty: '??' })));
  assert.equal(ok.decision.permissionDecisionReason, core.ENABLE_OK_REASON);
  assert.equal(one.sessions.get('sess-cwd').paneId, '%5');
  assert.ok(one.logLines.some((l) => /bound by cwd/.test(l)));

  // TWO panes in that directory: refuse. Guessing here types the human's words
  // into a stranger's shell.
  const many = readyDaemon();
  many.hookToken = 'local-test-token';
  const no = await withPanes({ byCwd: () => [{ paneId: '%5' }, { paneId: '%6' }] },
    () => hookPost(many, 'pre-tool-use', preToolUse('sess-amb', 'pidge terminal enable', { tty: '??' })));
  assert.equal(no.decision.permissionDecisionReason, core.ENABLE_NO_PANE_REASON);
  assert.equal(many.sessions.size, 0, 'an ambiguous bind must create NOTHING');
  assert.ok(many.logLines.some((l) => /REFUSED/.test(l)));
});

test('sentinel: a claude outside tmux is refused loudly — no share, no read-only tier', async () => {
  const d = readyDaemon();
  d.hookToken = 'local-test-token';
  const out = await withPanes({
    byTty: () => null,                                   // a REAL tty no pane owns
    byCwd: () => { throw new Error('a usable tty must not fall through to the cwd guess'); },
  }, () => hookPost(d, 'pre-tool-use', preToolUse('sess-bare', 'pidge terminal enable')));

  assert.deepEqual(out, {
    decision: { permissionDecision: 'deny', permissionDecisionReason: core.ENABLE_NO_PANE_REASON },
  });
  assert.equal(d.sessions.size, 0, 'NO session may exist after a refusal');
  assert.equal(core.readJson(core.STATE_FILE(), {}).sessions['sess-bare'], undefined);
  assert.ok(d.logLines.some((l) => /REFUSED/.test(l)), `expected a loud refusal, got ${JSON.stringify(d.logLines)}`);
});

test('sentinel: an ordinary Bash command is NOT a door — it only moves the status', async () => {
  const d = readyDaemon();
  d.hookToken = 'local-test-token';
  const out = await withPanes({ byTty: () => ({ paneId: '%3' }) },
    () => hookPost(d, 'pre-tool-use', preToolUse('sess-plain', 'npm test')));
  assert.deepEqual(out, {}, 'a normal tool call gets no decision at all');
  assert.equal(d.sessions.size, 0, 'and certainly no share');
});

test('sentinel: --approvals rides the pasted command (the CLI is not the door any more)', async () => {
  const d = readyDaemon();
  d.hookToken = 'local-test-token';
  await withPanes({ byTty: () => ({ paneId: '%3' }) },
    () => hookPost(d, 'pre-tool-use', preToolUse('sess-appr', 'pidge terminal enable --approvals Bash,Write')));
  assert.deepEqual(d.sessions.get('sess-appr').approvals, ['Bash', 'Write']);
});

test('the daemon has NO /enable endpoint any more — the hook is the only door', async () => {
  const d = readyDaemon();
  d.hookToken = 'local-test-token';
  const req = {
    method: 'POST', url: '/enable', headers: { authorization: 'Bearer local-test-token' },
    on(event, cb) { if (event === 'data') cb('{"tty":"/dev/ttys004","pane_id":"%1"}'); if (event === 'end') cb(); },
    destroy() {},
  };
  let code = null;
  await d.handleHttp(req, { writeHead(c) { code = c; }, end() {} });
  assert.equal(code, 404, 'a local caller must not be able to name a session into a share');
  assert.equal(d.sessions.size, 0);
});

// --- /clear kills the mirror LOUDLY (QA finding #14) ------------------------
//
// `/clear` in Claude Code mints a NEW sid + a NEW transcript file; the daemon
// kept tailing the frozen old file and the phone showed a screen that looked
// alive. Detection only — auto-adoption of the new sid is an OPEN product
// decision (Thiago's): the old session must end NOW, with a legible notice,
// and the new sid must NOT be silently enabled.

// endReplacedSession is deliberately fire-and-forget off the hook: give its
// promise chain a beat to settle before asserting.
const settle = () => new Promise((r) => setTimeout(r, 25));

test('/clear: a NEW sid announcing in the shared session cwd ends it — notice + DELETE, no auto-adopt', async () => {
  const d = readyDaemon();
  d.hookToken = 'local-test-token';
  const apiLog = [];
  d.api = async (method, p, body) => {
    apiLog.push({ method, p, body });
    if (method === 'POST' && /\/items$/.test(p)) {
      return { res: { status: 201 }, data: { accepted: body.items.length, last_seq: body.items.at(-1).seq } };
    }
    return { res: { status: 200 }, data: {} };
  };
  await withPanes({ byTty: () => ({ paneId: '%3', loc: 'p:0.0' }) },
    () => hookPost(d, 'pre-tool-use', preToolUse('sess-old', 'pidge terminal enable')));
  assert.ok(d.sessions.get('sess-old'), 'precondition: the session is shared');

  // The /clear: Claude Code announces a NEW sid, same cwd, ttyless hook, and
  // exactly ONE pane sits in that cwd (the bound one).
  await withPanes({ byCwd: () => [{ paneId: '%3', loc: 'p:0.0' }] },
    () => hookPost(d, 'session-start', {
      session_id: 'sess-new', cwd: '/tmp/proj', transcript_path: '/tmp/new.jsonl', tty: '??',
    }));
  await settle();

  assert.equal(d.sessions.has('sess-old'), false, 'the replaced session must end IMMEDIATELY');
  assert.equal(core.readJson(core.STATE_FILE(), {}).sessions['sess-old'], undefined);
  assert.equal(d.sessions.has('sess-new'), false,
    'NO auto-adoption — consent is per sid; the new session needs its own paste-to-enable');

  // The phone got one final LEGIBLE item…
  const itemPosts = apiLog.filter((c) => c.method === 'POST' && /\/items$/.test(c.p));
  assert.equal(itemPosts.length, 1, 'exactly one final notice batch');
  const notice = openItem(d, itemPosts[0].body.items[0].payload_sealed, 'ases_sess-old');
  assert.equal(notice.kind, 'notice');
  assert.equal(notice.role, 'system');
  assert.match(notice.preview, /session ended/i);
  assert.match(notice.preview, /\/clear/);
  assert.match(notice.preview, /[Ss]hare/, 'the notice tells the human the way back');

  // …and the server row was ENDED (the DELETE marks ended).
  assert.ok(apiLog.some((c) => c.method === 'DELETE' && c.p === '/agent_sessions/ases_sess-old'));
  assert.ok(d.logLines.some((l) => /new sid sess-new/.test(l) && /ending the shared session/.test(l)),
    `the end must be loud in the log, got ${JSON.stringify(d.logLines)}`);
});

test('/clear detection does NOT fire across cwds, nor when a second pane shares the cwd', async () => {
  // A new sid in a DIFFERENT directory is just another claude — untouched.
  const d = readyDaemon();
  d.hookToken = 'local-test-token';
  d.api = async () => ({ res: { status: 200 }, data: {} });
  await withPanes({ byTty: () => ({ paneId: '%3' }) },
    () => hookPost(d, 'pre-tool-use', preToolUse('sess-a', 'pidge terminal enable')));
  await withPanes({ byCwd: () => [] },
    () => hookPost(d, 'session-start', { session_id: 'sess-elsewhere', cwd: '/tmp/other', tty: '??' }));
  await settle();
  assert.ok(d.sessions.has('sess-a'), 'a new sid in another cwd must not end the share');

  // TWO panes in the shared cwd: could be a second claude, not a /clear —
  // the share stays, and the ambiguity is logged.
  await withPanes({ byCwd: () => [{ paneId: '%3' }, { paneId: '%9' }] },
    () => hookPost(d, 'session-start', { session_id: 'sess-maybe', cwd: '/tmp/proj', tty: '??' }));
  await settle();
  assert.ok(d.sessions.has('sess-a'), 'ambiguity must not kill a live mirror');
  assert.ok(d.logLines.some((l) => /cannot tell a \/clear from a second claude/.test(l)));

  // An announced tty that resolves to a DIFFERENT pane is positive disproof.
  await withPanes({ byTty: () => ({ paneId: '%9' }) },
    () => hookPost(d, 'session-start', { session_id: 'sess-otherpane', cwd: '/tmp/proj', tty: 'ttys009' }));
  await settle();
  assert.ok(d.sessions.has('sess-a'), 'a provably different pane must not end the share');
});

test('/clear: the end happens even when the final notice cannot be delivered', async () => {
  const d = readyDaemon();
  d.hookToken = 'local-test-token';
  d.api = async (method, p) => {
    if (method === 'POST' && /\/items$/.test(p)) return { res: { status: 502 }, data: {} };
    return { res: { status: 200 }, data: {} };
  };
  await withPanes({ byTty: () => ({ paneId: '%3' }) },
    () => hookPost(d, 'pre-tool-use', preToolUse('sess-b', 'pidge terminal enable')));
  await withPanes({ byCwd: () => [{ paneId: '%3' }] },
    () => hookPost(d, 'session-start', { session_id: 'sess-b2', cwd: '/tmp/proj', tty: '??' }));
  await settle();

  assert.equal(d.sessions.has('sess-b'), false, 'the end is unconditional — the notice is best-effort');
  assert.ok(d.logLines.some((l) => /ended notice did not reach the server/.test(l)),
    `an undelivered notice must be narrated, got ${JSON.stringify(d.logLines)}`);
});

// --- the tailer: backfill, restart dedup, rescan bounds ---------------------

function rec(i) {
  return {
    type: 'assistant', uuid: `u-${i}`, parentUuid: null, timestamp: '2026-08-02T18:33:12Z',
    version: '2.1.220', message: { role: 'assistant', content: `line ${i}` },
  };
}
function writeJsonl(file, records) {
  fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
}
// Open an outbox entry (or a bare sealed string).
function openItem(d, entry, publicId = 'ases_t') {
  const b64 = typeof entry === 'string' ? entry : entry.sealed;
  return JSON.parse(core.e2eDecryptBlob(d.key, core.e2eAad(1, publicId, 'agent_transcript'),
    Buffer.from(b64, 'base64url')).toString('utf8'));
}

test('a rescan AFTER a daemon restart re-publishes nothing', async () => {
  const dir = tmp('pidge-term-jsonl-');
  const file = path.join(dir, 's.jsonl');
  writeJsonl(file, [1, 2, 3].map(rec));

  const d1 = makeDaemon();
  d1.registerSession = async () => ({ last_seq: 0 });
  d1.subscribeInput = () => {};
  // A server that ACKS: the seed leaves the outbox for real (an un-acked one
  // would — correctly — be replayed after the restart; that is the durability
  // test below, not this one).
  const acked = [];
  d1.api = async (method, p, body) => {
    if (method === 'POST' && /\/items$/.test(p)) {
      for (const it of body.items) acked.push(it.seq);
      return { res: { status: 201 }, data: { accepted: body.items.length, last_seq: body.items.at(-1).seq } };
    }
    return { res: { status: 200 }, data: {} };
  };
  const s1 = await d1.enableSession({ sid: 'sess-r', paneId: '%1', tty: null, cwd: dir, file, approvals: [] });
  assert.equal(s1.backfilled, 3);
  assert.deepEqual(acked, [1, 2, 3]);
  assert.deepEqual(s1.queue, [], 'an acked item leaves the durable outbox');

  const persisted = core.readJson(core.STATE_FILE(), {}).sessions['sess-r'];
  assert.deepEqual(persisted.seen, ['u-1', 'u-2', 'u-3'],
    'the uuid ring must ride in state.json — an in-memory-only set is empty after a restart');

  // A NEW daemon process against the same config slot.
  const d2 = new Daemon();
  d2.logLines = [];
  d2.log = (...a) => { d2.logLines.push(a.join(' ')); };
  d2.registerSession = async () => ({ last_seq: 3 });
  d2.subscribeInput = () => {};
  await d2.rearmPersisted();
  const s2 = d2.sessions.get('sess-r');
  assert.ok(s2, 're-arm must keep the share the human opted into');
  assert.equal(s2.seenUuids.size, 3, 'the dedup set is rebuilt before any tick can emit');

  // The probe-proven RESCAN: the file is rewritten in place, smaller, keeping
  // the same records. Before this fix the empty dedup set re-emitted them all
  // under fresh seqs — the phone saw the conversation twice.
  writeJsonl(file, [1, 2].map(rec));
  d2.tailOne(s2);
  assert.deepEqual(s2.queue, [], 'a rescan must not re-emit records the phone already has');
  assert.ok(d2.logLines.some((l) => /full rescan/.test(l)));

  // A genuinely new record still flows.
  writeJsonl(file, [1, 2, 4].map(rec));
  d2.tailOne(s2);
  assert.equal(s2.queue.length, 1);
  assert.equal(openItem(d2, s2.queue[0], s2.publicId).uuid, 'u-4');
});

test('a rotation/rescan obeys the §6 backfill cap instead of flooding the lane', () => {
  const dir = tmp('pidge-term-jsonl-');
  const file = path.join(dir, 'rot.jsonl');
  writeJsonl(file, Array.from({ length: 300 }, (_, i) => rec(i)));

  const d = makeDaemon();
  const s = liveSession(d, { file });
  s.bulk = true; // exactly what the /clear rotation handler and the rescan branch set
  d.tailOne(s);

  assert.equal(s.queue.length, 100, 'a 300-item bulk re-read must be bounded to the backfill window');
  assert.equal(openItem(d, s.queue[0]).preview, 'line 200', 'the NEWEST 100 are kept, oldest-first');
  assert.equal(openItem(d, s.queue.at(-1)).preview, 'line 299');
  assert.ok(d.logLines.some((l) => /bounded window/.test(l)));
});

test('backfill stops at the last COMPLETE line so a record mid-write is not lost', async () => {
  const dir = tmp('pidge-term-jsonl-');
  const file = path.join(dir, 'p.jsonl');
  const firstLine = JSON.stringify(rec(1)) + '\n';
  fs.writeFileSync(file, firstLine + JSON.stringify(rec(2)).slice(0, 30)); // 2nd record still landing

  const d = makeDaemon();
  d.flush = async () => {};
  const s = liveSession(d, { file });
  await d.backfill(s);

  assert.equal(s.backfilled, 1);
  assert.equal(s.offset, Buffer.byteLength(firstLine, 'utf8'),
    'the offset must not jump past a half-written record — it would be dropped forever');

  writeJsonl(file, [1, 2].map(rec)); // the record completes
  d.tailOne(s);
  assert.equal(s.queue.length, 2);
  assert.equal(openItem(d, s.queue[1]).uuid, 'u-2');
});

// --- approval gate ----------------------------------------------------------

// The gate never touches the network in tests: d.api is swapped for a recorder.
function stubApi(d, handler) {
  const calls = [];
  d.api = async (method, p, body) => {
    calls.push({ method, p, body });
    return (await handler(method, p, body)) || { res: { status: 200 }, data: {} };
  };
  return calls;
}

test('approval gate: the ask carries the server approve/reject pair (never the nonexistent `deny`)', async () => {
  const d = makeDaemon();
  const calls = stubApi(d, async (method, p) => {
    if (method === 'POST' && p === '/notify') return { res: { status: 201 }, data: {} };
    if (method === 'GET') return { res: { status: 200 }, data: { responded: true, chosen_action: { action_id: 'approve' } } };
  });
  const s = { sid: 'sess-appr', publicId: 'ases_t', title: 'proj', approvals: ['Bash'] };

  const decision = await d.approvalGate(s, { tool_name: 'Bash', tool_input: { command: 'ls' } });
  assert.deepEqual(decision, { permissionDecision: 'allow', permissionDecisionReason: 'approved via Pidge' });

  const notify = calls.find((c) => c.p === '/notify');
  assert.deepEqual(notify.body.actions, ['approve', 'reject'],
    'the server built-in pair is approve/reject — `deny` is not an action id and would be dropped silently');
  assert.equal(notify.body.profile, 'urgent');
});

test('approval gate: reject maps to a deny decision, anything else falls open', async () => {
  for (const [actionId, expected] of [
    ['reject', { permissionDecision: 'deny', permissionDecisionReason: 'rejected via Pidge' }],
    ['done', null],
    ['snooze', null],
  ]) {
    const d = makeDaemon();
    stubApi(d, async (method, p) => {
      if (method === 'POST' && p === '/notify') return { res: { status: 201 }, data: {} };
      if (method === 'GET') return { res: { status: 200 }, data: { responded: true, chosen_action: { action_id: actionId } } };
    });
    const s = { sid: 'sess-appr', publicId: 'ases_t', title: 'proj', approvals: ['*'] };
    assert.deepEqual(await d.approvalGate(s, { tool_name: 'Bash', tool_input: {} }), expected,
      `action_id ${actionId} mapped wrong`);
  }
});

test('approval gate: a failed notify falls open to the local prompt instead of blocking', async () => {
  const d = makeDaemon();
  stubApi(d, async () => ({ res: { status: 402 }, data: { code: 'terminal_requires_pro' } }));
  const s = { sid: 'sess-appr', publicId: 'ases_t', title: 'proj', approvals: ['*'] };
  assert.equal(await d.approvalGate(s, { tool_name: 'Bash', tool_input: {} }), null);
  assert.ok(d.logLines.some((l) => /falling open/.test(l)));
});

test('the single-writer lock refuses a live holder and takes over a stale one', () => {
  const d = makeDaemon();
  d.acquireWriterLock('sess-a');
  assert.equal(fs.readFileSync(d.lockPath('sess-a'), 'utf8').trim(), String(process.pid));
  d.acquireWriterLock('sess-a'); // our own lock is re-entrant

  fs.writeFileSync(d.lockPath('sess-b'), '999999999\n'); // a pid that cannot be alive
  d.acquireWriterLock('sess-b');
  assert.equal(fs.readFileSync(d.lockPath('sess-b'), 'utf8').trim(), String(process.pid));

  // A DIFFERENT living process holds it: refuse loudly, never rebind.
  const otherPid = process.ppid;
  assert.ok(otherPid > 1 && otherPid !== process.pid, 'need a live foreign pid for this case');
  fs.writeFileSync(d.lockPath('sess-c'), `${otherPid}\n`);
  assert.throws(() => d.acquireWriterLock('sess-c'), /already has a live writer/);
  assert.equal(fs.readFileSync(d.lockPath('sess-c'), 'utf8').trim(), String(otherPid), 'the foreign lock is left intact');

  d.releaseWriterLock('sess-a');
  assert.equal(fs.existsSync(d.lockPath('sess-a')), false);
  d.releaseWriterLock('sess-a'); // releasing twice is not an error
});

// ===========================================================================
// 5. durability: nothing the tailer captured may be lost, and nothing loud
//    may go quiet (the failure ledger the spec promises)
// ===========================================================================

test('the outbox survives a restart: un-acked items are re-published EXACTLY once', async () => {
  const dir = tmp('pidge-term-jsonl-');
  const file = path.join(dir, 'd.jsonl');
  writeJsonl(file, [1, 2].map(rec));

  // --- process 1: the server is unreachable the whole time -----------------
  const d1 = makeDaemon();
  d1.registerSession = async () => ({ last_seq: 0 });
  d1.subscribeInput = () => {};
  d1.api = async (method, p) => {
    if (method === 'POST' && /\/items$/.test(p)) return { res: { status: 502 }, data: {} };
    return { res: { status: 200 }, data: {} };
  };
  const s1 = await d1.enableSession({ sid: 'sess-d', paneId: '%1', tty: null, cwd: dir, file, approvals: [] });
  assert.equal(s1.queue.length, 2, 'nothing was acked, so nothing may leave the outbox');

  writeJsonl(file, [1, 2, 3].map(rec)); // the session keeps working while the server is down
  d1.tailOne(s1);
  assert.equal(s1.queue.length, 3);

  const persisted = core.readJson(core.STATE_FILE(), {}).sessions['sess-d'];
  assert.deepEqual(persisted.outbox.map((e) => e.uuid), ['u-1', 'u-2', 'u-3'],
    'the pending items must ride in state.json — an in-memory queue is GONE after a restart');
  assert.equal(persisted.nextSeq, 1, 'seq numbering only advances on an ACK');
  assert.ok(persisted.offset > 0, 'the read offset did advance — which is exactly why the queue must be durable');

  // --- process 2: same state dir, the server is back -----------------------
  const d2 = new Daemon();
  d2.logLines = [];
  d2.log = (...a) => { d2.logLines.push(a.join(' ')); };
  d2.subscribeInput = () => {};
  const published = [];
  d2.api = async (method, p, body) => {
    if (method === 'POST' && p === '/agent_sessions') return { res: { status: 201 }, data: { session: { last_seq: 0 } } };
    if (method === 'POST' && /\/items$/.test(p)) {
      for (const it of body.items) published.push([it.seq, openItem(d2, it.payload_sealed, 'ases_sess-d').uuid]);
      return { res: { status: 201 }, data: { accepted: body.items.length, last_seq: body.items.at(-1).seq } };
    }
    return { res: { status: 200 }, data: {} };
  };
  await d2.rearmPersisted();
  const s2 = d2.sessions.get('sess-d');
  assert.ok(s2, 're-arm must keep the share');
  assert.equal(s2.queue.length, 3, 'the un-acked items are recovered before a single new byte is tailed');

  await d2.flush(s2);
  assert.deepEqual(published, [[1, 'u-1'], [2, 'u-2'], [3, 'u-3']],
    'every captured item reaches the server, once, in order, with monotonic seqs');
  assert.deepEqual(s2.queue, []);
  assert.deepEqual(core.readJson(core.STATE_FILE(), {}).sessions['sess-d'].outbox, []);

  // The replayed items must not come back a second time from the transcript.
  d2.tailOne(s2);
  await d2.flush(s2);
  assert.equal(published.length, 3, 'no duplicate: the dedup set knows the replayed uuids');
});

test('a full outbox PAUSES the tailer — the transcript keeps the tail, nothing is dropped', () => {
  const dir = tmp('pidge-term-jsonl-');
  const file = path.join(dir, 'full.jsonl');
  writeJsonl(file, [1, 2].map(rec));

  const d = makeDaemon();
  // 4 × ~1 MB of un-acked sealed payload: past the outbox byte cap.
  const s = liveSession(d, { file, queue: Array.from({ length: 4 }, () => 'x'.repeat(1024 * 1024 + 1)) });
  const before = s.offset;

  d.tailOne(s);
  assert.equal(s.offset, before, 'the read offset must NOT advance while the outbox is at its cap');
  assert.equal(s.queue.length, 4, 'and nothing new may be enqueued');
  assert.ok(d.logLines.some((l) => /outbox FULL/.test(l)), `expected a loud pause, got ${JSON.stringify(d.logLines)}`);

  // Once the backlog drains, the very same records flow — they were never lost.
  d.queueDrop(s, 4);
  d.tailOne(s);
  assert.deepEqual(s.queue.map((e) => e.uuid), ['u-1', 'u-2']);
});

test('re-arm KEEPS the share when the server is unavailable at boot, and retries on the flush clock', async () => {
  const d = daemonWithPersisted({ sid: 'sess-k' });
  let registers = 0;
  d.api = async (method, p) => {
    if (method === 'POST' && p === '/agent_sessions') {
      registers += 1;
      // A Mac that reboots during a deploy: the first POST hits a 503.
      return registers === 1
        ? { res: { status: 503 }, data: {} }
        : { res: { status: 201 }, data: { session: { last_seq: 7 } } };
    }
    return { res: { status: 200 }, data: {} };
  };

  await d.rearmPersisted();
  const s = d.sessions.get('sess-k');
  assert.ok(s, 'a transient failure must NOT cost the human the share they opted into');
  assert.equal(s.registered, false);
  assert.ok(core.readJson(core.STATE_FILE(), {}).sessions['sess-k'], 'it stays in state.json too');
  assert.ok(d.logLines.some((l) => /keeping the share/.test(l)));

  s.nextFlushAt = Date.now() - 1; // the backoff window elapses
  await d.flushTick();
  await new Promise((r) => setImmediate(r));
  assert.equal(registers, 2, 'the flush tick owns the re-register retry');
  assert.equal(s.registered, true);
  assert.equal(s.nextSeq, 8, 'numbering continues from the server high-water');
});

// --- state.json is TUNNEL-SCOPED (QA finding #13) ---------------------------
//
// Reconnecting this computer from one tunnel to another used to re-publish the
// old tunnel's sessions on the new one — re-sealing their title+cwd metadata
// under the NEW key. The crypto held for items (they rendered empty), but the
// metadata (project paths!) leaked across owners, and a ghost session sat
// `idle` forever in the app.

test('sessions from ANOTHER tunnel (or with no stamp) are dropped at load, never republished', () => {
  makeDaemon(); // channel 1 identity + a first epoch in a fresh slot
  const st = core.readJson(core.STATE_FILE(), { epoch: 1, sessions: {} });
  const row = (publicId, extra = {}) => ({
    publicId, paneId: '%1', tty: null, cwd: '/private/tmp/pidge-qa-proj',
    file: '/tmp/absent.jsonl', offset: 0, nextSeq: 1, approvals: [], seen: [], outbox: [], ...extra,
  });
  st.sessions['sess-mine'] = row('ases_mine', { channelId: 1, cwd: '/tmp/mine' });
  // The QA reproduction: a session enabled against the LOCAL test server
  // (channel 103) still in state when the computer reconnects to prod.
  st.sessions['sess-theirs'] = row('ases_theirs', { channelId: 103 });
  // A pre-scoping state file (0.41.0) has no stamp at all — ownership it
  // cannot prove, it does not get.
  st.sessions['sess-legacy'] = row('ases_legacy');
  core.writeJson(core.STATE_FILE(), st);

  const { value: d, lines } = captureSay(() => new Daemon());
  assert.deepEqual(Object.keys(d.state.sessions), ['sess-mine'],
    'only the CURRENT tunnel\'s sessions may survive the load');
  assert.deepEqual(Object.keys(core.readJson(core.STATE_FILE(), {}).sessions), ['sess-mine'],
    'the purge is persisted — a crash must not resurrect the foreign rows');
  const out = lines.join('\n');
  assert.match(out, /sess-the.*channel 103.*DROPPED/s, 'the foreign drop is loud and names the owner');
  assert.match(out, /sess-leg.*UNKNOWN channel.*DROPPED/s);
});

test('after a tunnel switch, re-arm registers NOTHING from the old tunnel', async () => {
  makeDaemon();
  const st = core.readJson(core.STATE_FILE(), { epoch: 1, sessions: {} });
  st.sessions['sess-old-tunnel'] = {
    publicId: 'ases_old', channelId: 103, paneId: '%1', tty: null,
    cwd: '/private/tmp/pidge-qa-proj', file: '/tmp/absent.jsonl',
    offset: 0, nextSeq: 1, approvals: [], seen: [], outbox: [],
  };
  core.writeJson(core.STATE_FILE(), st);

  const { value: d } = captureSay(() => new Daemon());
  d.logLines = [];
  d.log = (...a) => { d.logLines.push(a.join(' ')); };
  d.subscribeInput = () => {};
  const registered = [];
  d.api = async (method, p, body) => {
    if (method === 'POST' && p === '/agent_sessions') registered.push(body.public_id);
    return { res: { status: 201 }, data: { session: { last_seq: 0 } } };
  };
  await d.rearmPersisted();
  assert.deepEqual(registered, [], 'a connect that switches tunnels inherits NO sessions');
  assert.equal(d.sessions.size, 0);
});

test('persistSession stamps the owning channelId on every write', () => {
  const d = makeDaemon();
  const s = liveSession(d, { sid: 'sess-stamp' });
  d.persistSession(s);
  assert.equal(core.readJson(core.STATE_FILE(), {}).sessions['sess-stamp'].channelId, 1);
});

test('re-arm DROPS a session only when the server refuses it definitively', async () => {
  const d = daemonWithPersisted({ sid: 'sess-gone' });
  d.api = async (method, p) => {
    if (method === 'POST' && p === '/agent_sessions') return { res: { status: 404 }, data: {} };
    return { res: { status: 200 }, data: {} };
  };

  await d.rearmPersisted();
  assert.equal(d.sessions.has('sess-gone'), false);
  assert.equal(core.readJson(core.STATE_FILE(), {}).sessions['sess-gone'], undefined);
  assert.equal(fs.existsSync(d.lockPath('sess-gone')), false, 'the writer lock is released with it');
  assert.ok(d.logLines.some((l) => /for good/.test(l)), `expected a loud drop, got ${JSON.stringify(d.logLines)}`);
});

test('a waiting notification that does not land stays ARMED for the next signal', async () => {
  const d = makeDaemon();
  const s = { sid: 'sess-w', publicId: 'ases_t', title: 'proj', status: 'waiting', waitingArmed: true };
  let sends = 0;
  d.api = async () => { sends += 1; return { res: { status: sends === 1 ? 502 : 201 }, data: {} }; };

  await d.maybeNotifyWaiting(s, 'needs you');
  assert.equal(sends, 1);
  assert.equal(s.waitingArmed, true, 'a 502 must not eat the whole waiting episode');
  assert.ok(d.logLines.some((l) => /still armed/.test(l)));

  await d.maybeNotifyWaiting(s, 'needs you');
  assert.equal(sends, 2);
  assert.equal(s.waitingArmed, false, 'the send that LANDED closes the episode');

  await d.maybeNotifyWaiting(s, 'again'); // same episode: still one notification
  assert.equal(sends, 2);

  // A transport error is the same story.
  s.waitingArmed = true;
  d.api = async () => { throw new Error('socket hang up'); };
  await d.maybeNotifyWaiting(s, 'needs you');
  assert.equal(s.waitingArmed, true);
  assert.ok(d.logLines.some((l) => /socket hang up/.test(l)));
});

test('the heartbeat re-asserts the CURRENT status, so a dropped transition self-heals', async () => {
  const d = makeDaemon();
  const s = liveSession(d);
  const patches = [];
  d.api = async (method, p, body) => {
    if (method === 'PATCH') patches.push(body);
    return { res: { status: 200 }, data: {} };
  };

  d.setStatus(s, 'waiting');
  await d.heartbeatTick();
  assert.deepEqual(patches, [{ status: 'waiting' }, { status: 'waiting' }],
    'the beat carries the status, never an empty body that re-asserts nothing');

  patches.length = 0;
  s.registered = false; // not registered yet: the register retry owns it
  await d.heartbeatTick();
  assert.deepEqual(patches, []);
});

test('disable is honest when the server never got the DELETE', async () => {
  const d = makeDaemon();
  const s = liveSession(d, { sid: 'sess-off' });
  d.persistSession(s);
  d.api = async () => { throw new Error('connect ECONNREFUSED 127.0.0.1'); };

  const out = await d.disableSession('sess-off', 'requested');
  assert.equal(out.server_ok, false);
  assert.match(out.detail, /ECONNREFUSED/);
  assert.equal(d.sessions.has('sess-off'), false, 'the LOCAL stop always happens');
  assert.equal(core.readJson(core.STATE_FILE(), {}).sessions['sess-off'], undefined);
  assert.ok(d.logLines.some((l) => /was NOT told/.test(l)));

  // A 404 means the row is already gone — that IS a clean stop.
  liveSession(d, { sid: 'sess-404' });
  d.api = async () => ({ res: { status: 404 }, data: {} });
  assert.equal((await d.disableSession('sess-404', 'requested')).server_ok, true);
});

test('backfill reads a bounded TAIL instead of slurping a multi-megabyte transcript', async () => {
  const dir = tmp('pidge-term-jsonl-');
  const file = path.join(dir, 'big.jsonl');
  const filler = 'y'.repeat(12 * 1024);
  writeJsonl(file, Array.from({ length: 800 }, (_, i) => ({
    type: 'assistant', uuid: `u-${i}`, parentUuid: null, timestamp: '2026-08-02T18:33:12Z',
    version: '2.1.220', message: { role: 'assistant', content: `line ${i} ${filler}` },
  })));
  const size = fs.statSync(file).size;
  assert.ok(size > 8 * 1024 * 1024, `the fixture must exceed the read window (was ${size})`);

  const d = makeDaemon();
  d.flush = async () => {};
  const s = liveSession(d, { file, sid: 'sess-big' });
  await d.backfill(s);

  assert.equal(s.offset, size, 'the tail still resumes at EOF — the window bounds the READ, not the position');
  assert.equal(s.queue.length, 100, 'the seed is still the newest 100 items');
  assert.ok(s.seenUuids.size < 800, 'records outside the window were never parsed into memory');
  assert.ok(d.logLines.some((l) => /seeding from its last/.test(l)));
  assert.equal(openItem(d, s.queue.at(-1)).uuid, 'u-799', 'and the newest record is in it');
});
