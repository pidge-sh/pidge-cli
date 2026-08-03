'use strict';
// Claude Code JSONL adapter (agent-sessions-spec §7) — normalizes one raw
// transcript record into zero or more items. Probe-proven against Claude Code
// 2.1.220 (research kit 2026-07-30); hardened per the spec:
//   • main thread only (isSidechain:false) — subagent lanes are v2
//   • drop thinking SIGNATURES (opaque ~7 KB), snapshots, queue-ops
//   • unknown record types AND unknown message-content block types map to
//     kind:"notice", NEVER silently dropped — format drift surfaces in the UI
//     as an odd item, not as a hole
//   • preview capped at 2 KB with truncated/total_bytes honesty
// The item `uuid` is the harness record uuid; a record whose message carries
// SEVERAL blocks emits one item per block, suffixed ":<n>" for n>0 so viewer
// dedup never collapses two blocks of one record.

const PREVIEW_BYTES = 2048;

function textOf(block) {
  if (typeof block === 'string') return block;
  if (block == null) return '';
  if (block.type === 'text') return block.text || '';
  if (block.type === 'thinking') return block.thinking || '';
  if (block.type === 'tool_use') return JSON.stringify(block.input || {});
  if (block.type === 'tool_result') {
    const c = block.content;
    if (typeof c === 'string') return c;
    if (Array.isArray(c)) return c.map((x) => (x && x.type === 'text' ? x.text : JSON.stringify(x))).join('\n');
    return JSON.stringify(c || '');
  }
  return '';
}

function byteLen(s) { return Buffer.byteLength(s, 'utf8'); }

// Cut a string to at most `bytes` UTF-8 bytes without splitting a code point.
function byteSlice(s, bytes) {
  if (byteLen(s) <= bytes) return s;
  const buf = Buffer.from(s, 'utf8').subarray(0, bytes);
  return buf.toString('utf8').replace(/�+$/, '');
}

function mk(base, role, kind, text, previewBytes = PREVIEW_BYTES) {
  const total = byteLen(text);
  return {
    v: 1,
    uuid: base.uuid,
    parent: base.parent,
    ts: base.ts,
    role,
    kind,
    preview: byteSlice(text, previewBytes),
    truncated: total > previewBytes,
    total_bytes: total,
    harness: 'claude',
    hv: base.hv,
  };
}

// normalize(rawJsonlObject) → array of §7 items (possibly empty).
function normalize(obj) {
  if (!obj || typeof obj !== 'object') return [];
  if (obj.isSidechain) return [];
  const t = obj.type;
  const base = {
    uuid: obj.uuid || null,
    parent: obj.parentUuid ?? null,
    ts: obj.timestamp || null,
    hv: obj.version || null,
  };
  if (!base.uuid) return []; // uuid is the dedup key — a record without one is untailable
  if (t === 'system') {
    if (obj.isSnapshotUpdate) return [];
    const txt = String(obj.content || obj.stopReason || obj.subtype || '');
    if (!txt) return [];
    return [mk(base, 'system', 'notice', txt)];
  }
  if (t !== 'user' && t !== 'assistant') {
    // Known noise types stay silent; anything NEW becomes a visible notice.
    if (['attachment', 'last-prompt', 'queue-operation', 'mode', 'ai-title', 'summary'].includes(t)) return [];
    return [mk(base, 'system', 'notice', `[${t}] unrecognized transcript record — pidge-cli may need an update`)];
  }
  const msg = obj.message || {};
  const role = msg.role === 'assistant' ? 'assistant' : msg.role === 'user' ? 'user' : t;
  const content = msg.content;
  const out = [];
  const push = (item) => {
    if (out.length > 0) item.uuid = `${base.uuid}:${out.length}`;
    out.push(item);
  };
  if (typeof content === 'string') {
    if (content) push(mk(base, role, 'text', content));
    return out;
  }
  if (!Array.isArray(content)) return out;
  for (const b of content) {
    if (!b || typeof b !== 'object') continue;
    if (b.type === 'thinking') {
      const txt = textOf(b); // NEVER b.signature — dropped whole
      if (txt) push(mk(base, role, 'thinking', txt));
    } else if (b.type === 'text') {
      const txt = textOf(b);
      if (txt) push(mk(base, role, 'text', txt));
    } else if (b.type === 'tool_use') {
      const item = mk(base, role, 'tool_use', textOf(b));
      item.tool = b.name || null;
      push(item);
    } else if (b.type === 'tool_result') {
      push(mk(base, 'user', 'tool_result', textOf(b))); // pairing rides the parent chain mk() already set
    } else if (b.type === 'image') {
      push(mk(base, role, 'notice', '[image attachment]'));
    } else {
      // Drift surfaces, it never leaves a hole: an unrecognized BLOCK type gets
      // the same treatment as an unrecognized RECORD type — a visible notice.
      // (Silently skipping them meant a new content block just… vanished from
      // the conversation, with nothing in the log to point at.)
      push(mk(base, role, 'notice', `[unknown block: ${String(b.type || 'untyped')}] — pidge-cli may need an update`));
    }
  }
  return out;
}

module.exports = { normalize, PREVIEW_BYTES, byteSlice, byteLen };
