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
const { execFileSync } = require('node:child_process');

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
// enableSession would leave it.
function liveSession(d, { queue = [], nextSeq = 1 } = {}) {
  const s = {
    sid: 'sess-flush', publicId: 'ases_t', paneId: '%1', tty: null, cwd: '/tmp/proj',
    file: '/tmp/nonexistent.jsonl', title: 'proj', hv: null,
    offset: 0, partial: '', seenUuids: new Set(), seenRing: [],
    queue: [...queue], nextSeq, status: 'idle', waitingArmed: true, approvals: [],
    flushing: false, backfilled: 0, backoff: 0, nextFlushAt: 0, gen: 0,
  };
  d.sessions.set(s.sid, s);
  return s;
}

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
  assert.deepEqual(s.queue, ['a', 'b'], 'nothing is lost — the JSONL is durable');

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
  assert.deepEqual(s.queue, ['i1', 'i2'], 'the old code dropped a whole batch "to break the loop"');
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
