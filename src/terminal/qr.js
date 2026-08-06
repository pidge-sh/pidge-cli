'use strict';
// Minimal QR encoder (ISO/IEC 18004) — byte mode, EC levels L/M — plus the
// half-block terminal renderer. Written in-tree for `pidge terminal connect
// --qr` (agent-sessions-spec §24.5): the QR carries the freshly minted
// computer key K, so the renderer sits on the most sensitive string this CLI
// ever prints — and pidge-cli ships with ZERO runtime dependencies, a
// supply-chain property this feature must not be the one to break. These
// ~300 lines are reviewed in the diff like any other code; an npm package
// (even exact-pinned) would be trusted, not reviewed.
//
// Correctness story (#67 — cross-implementation identity, like the E2E
// vectors): every matrix this encoder can produce for the pairing payload
// class is asserted module-by-module against an INDEPENDENT implementation
// (python-qrcode) by test/gen-qr-golden.py — versions 1..20, all 8 masks
// forced plus the penalty-chosen one. CI re-asserts the committed golden
// matrices in test/qr_golden.json without needing python. The final oracle
// is the morning QA: a real iPhone camera scanning a real terminal.
//
// EC_TABLE/ALIGN_POS are the ISO 18004 block tables (dumped from
// python-qrcode by test/gen-qr-golden.py --dump-tables, itself conformant);
// a wrong entry cannot hide — it would shift every byte of the matrix and
// fail the golden assertion for that version.

// [ecCodewordsPerBlock, [[numBlocks, dataCodewordsPerBlock], …]] — versions 1..40.
const EC_TABLE = {
  L: [[7,[[1,19]]],[10,[[1,34]]],[15,[[1,55]]],[20,[[1,80]]],[26,[[1,108]]],[18,[[2,68]]],[20,[[2,78]]],[24,[[2,97]]],[30,[[2,116]]],[18,[[2,68],[2,69]]],[20,[[4,81]]],[24,[[2,92],[2,93]]],[26,[[4,107]]],[30,[[3,115],[1,116]]],[22,[[5,87],[1,88]]],[24,[[5,98],[1,99]]],[28,[[1,107],[5,108]]],[30,[[5,120],[1,121]]],[28,[[3,113],[4,114]]],[28,[[3,107],[5,108]]],[28,[[4,116],[4,117]]],[28,[[2,111],[7,112]]],[30,[[4,121],[5,122]]],[30,[[6,117],[4,118]]],[26,[[8,106],[4,107]]],[28,[[10,114],[2,115]]],[30,[[8,122],[4,123]]],[30,[[3,117],[10,118]]],[30,[[7,116],[7,117]]],[30,[[5,115],[10,116]]],[30,[[13,115],[3,116]]],[30,[[17,115]]],[30,[[17,115],[1,116]]],[30,[[13,115],[6,116]]],[30,[[12,121],[7,122]]],[30,[[6,121],[14,122]]],[30,[[17,122],[4,123]]],[30,[[4,122],[18,123]]],[30,[[20,117],[4,118]]],[30,[[19,118],[6,119]]]],
  M: [[10,[[1,16]]],[16,[[1,28]]],[26,[[1,44]]],[18,[[2,32]]],[24,[[2,43]]],[16,[[4,27]]],[18,[[4,31]]],[22,[[2,38],[2,39]]],[22,[[3,36],[2,37]]],[26,[[4,43],[1,44]]],[30,[[1,50],[4,51]]],[22,[[6,36],[2,37]]],[22,[[8,37],[1,38]]],[24,[[4,40],[5,41]]],[24,[[5,41],[5,42]]],[28,[[7,45],[3,46]]],[28,[[10,46],[1,47]]],[26,[[9,43],[4,44]]],[26,[[3,44],[11,45]]],[26,[[3,41],[13,42]]],[26,[[17,42]]],[28,[[17,46]]],[28,[[4,47],[14,48]]],[28,[[6,45],[14,46]]],[28,[[8,47],[13,48]]],[28,[[19,46],[4,47]]],[28,[[22,45],[3,46]]],[28,[[3,45],[23,46]]],[28,[[21,45],[7,46]]],[28,[[19,47],[10,48]]],[28,[[2,46],[29,47]]],[28,[[10,46],[23,47]]],[28,[[14,46],[21,47]]],[28,[[14,46],[23,47]]],[28,[[12,47],[26,48]]],[28,[[6,47],[34,48]]],[28,[[29,46],[14,47]]],[28,[[13,46],[32,47]]],[28,[[40,47],[7,48]]],[28,[[18,47],[31,48]]]],
};
// Alignment-pattern centre coordinates per version (empty for v1).
const ALIGN_POS = [[],[6,18],[6,22],[6,26],[6,30],[6,34],[6,22,38],[6,24,42],[6,26,46],[6,28,50],[6,30,54],[6,32,58],[6,34,62],[6,26,46,66],[6,26,48,70],[6,26,50,74],[6,30,54,78],[6,30,56,82],[6,30,58,86],[6,34,62,90],[6,28,50,72,94],[6,26,50,74,98],[6,30,54,78,102],[6,28,54,80,106],[6,32,58,84,110],[6,30,58,86,114],[6,34,62,90,118],[6,26,50,74,98,122],[6,30,54,78,102,126],[6,26,52,78,104,130],[6,30,56,82,108,134],[6,34,60,86,112,138],[6,30,58,86,114,142],[6,34,62,90,118,146],[6,30,54,78,102,126,150],[6,24,50,76,102,128,154],[6,28,54,80,106,132,158],[6,32,58,84,110,136,162],[6,26,54,82,110,138,166],[6,30,58,86,114,142,170]];

// Format-info EC-level field (ISO Table 25): L=01, M=00 (Q=11, H=10 unused here).
const ECL_BITS = { L: 1, M: 0 };

// --- GF(256), polynomial 0x11D (the QR field) --------------------------------

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
(function initGf() {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
})();
function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

// Reed-Solomon generator polynomial of the given degree, then the remainder of
// data(x)·x^degree mod generator — the EC codewords of one block.
function rsGenerator(degree) {
  // Coefficients HIGHEST power first, the leading x^degree term implicit —
  // start from the polynomial 1 and multiply by (x − α^i) for i = 0..degree−1.
  const result = new Array(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      result[j] = gfMul(result[j], root);
      if (j + 1 < degree) result[j] ^= result[j + 1];
    }
    root = gfMul(root, 2);
  }
  return result;
}
function rsRemainder(data, degree) {
  const gen = rsGenerator(degree);
  const rem = new Uint8Array(degree);
  for (const byte of data) {
    const factor = byte ^ rem[0];
    rem.copyWithin(0, 1);
    rem[degree - 1] = 0;
    for (let i = 0; i < degree; i++) rem[i] ^= gfMul(gen[i], factor);
  }
  return rem;
}

// --- capacity / bitstream -----------------------------------------------------

function totalDataCodewords(version, ecl) {
  const [, groups] = EC_TABLE[ecl][version - 1];
  return groups.reduce((sum, [n, d]) => sum + n * d, 0);
}
function charCountBits(version) { return version <= 9 ? 8 : 16; }

function pickVersion(byteLen, ecl) {
  for (let v = 1; v <= 40; v++) {
    const capacityBits = totalDataCodewords(v, ecl) * 8;
    if (4 + charCountBits(v) + byteLen * 8 <= capacityBits) return v;
  }
  throw new Error(`payload of ${byteLen} bytes exceeds QR capacity at level ${ecl}`);
}

function buildCodewords(bytes, version, ecl) {
  const capacity = totalDataCodewords(version, ecl);
  const bits = [];
  const push = (value, n) => { for (let i = n - 1; i >= 0; i--) bits.push((value >> i) & 1); };
  push(0b0100, 4); // byte mode
  push(bytes.length, charCountBits(version));
  for (const b of bytes) push(b, 8);
  // terminator (≤4 zero bits), pad to a byte boundary, then pad codewords
  push(0, Math.min(4, capacity * 8 - bits.length));
  if (bits.length % 8) push(0, 8 - (bits.length % 8));
  const data = new Uint8Array(capacity);
  for (let i = 0; i < bits.length; i++) if (bits[i]) data[i >> 3] |= 0x80 >> (i & 7);
  for (let i = bits.length / 8, pad = 0xec; i < capacity; i++, pad ^= 0xfd) data[i] = pad;

  // Split into blocks, compute EC, interleave (ISO §8.6).
  const [ecPerBlock, groups] = EC_TABLE[ecl][version - 1];
  const blocks = [];
  let offset = 0;
  for (const [n, dataLen] of groups) {
    for (let i = 0; i < n; i++) {
      const chunk = data.subarray(offset, offset + dataLen);
      blocks.push({ data: chunk, ec: rsRemainder(chunk, ecPerBlock) });
      offset += dataLen;
    }
  }
  const out = [];
  const maxData = Math.max(...blocks.map((b) => b.data.length));
  for (let i = 0; i < maxData; i++) for (const b of blocks) if (i < b.data.length) out.push(b.data[i]);
  for (let i = 0; i < ecPerBlock; i++) for (const b of blocks) out.push(b.ec[i]);
  return Uint8Array.from(out);
}

// --- matrix -------------------------------------------------------------------

// modules[y][x] = 0|1 · isFunction[y][x] marks reserved (never masked) cells.
function buildMatrix(version) {
  const size = 17 + 4 * version;
  const modules = Array.from({ length: size }, () => new Uint8Array(size));
  const isFunction = Array.from({ length: size }, () => new Uint8Array(size));
  const set = (x, y, dark) => { modules[y][x] = dark ? 1 : 0; isFunction[y][x] = 1; };

  // timing patterns
  for (let i = 0; i < size; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
  // finders + separators (clipped at the edges)
  const finder = (cx, cy) => {
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const x = cx + dx; const y = cy + dy;
      if (x < 0 || x >= size || y < 0 || y >= size) continue;
      const dist = Math.max(Math.abs(dx), Math.abs(dy));
      set(x, y, dist !== 2 && dist !== 4);
    }
  };
  finder(3, 3); finder(size - 4, 3); finder(3, size - 4);
  // alignment patterns (skip the three finder corners)
  const pos = ALIGN_POS[version - 1];
  for (let i = 0; i < pos.length; i++) for (let j = 0; j < pos.length; j++) {
    const onFinder = (i === 0 && j === 0) || (i === 0 && j === pos.length - 1) || (i === pos.length - 1 && j === 0);
    if (onFinder) continue;
    const cx = pos[i]; const cy = pos[j];
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      set(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
  }
  // reserve format areas (values drawn per-mask later) + the dark module
  for (let i = 0; i <= 8; i++) {
    if (i !== 6) { set(8, i, 0); set(i, 8, 0); }
    if (i < 8) set(size - 1 - i, 8, 0);
    if (i < 7) set(8, size - 1 - i, 0);
  }
  set(8, size - 8, 1); // the dark module
  // version info (v ≥ 7): 18 bits, BCH(18,6), generator 0x1F25
  if (version >= 7) {
    let rem = version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >> 11) * 0x1f25);
    const bits = (version << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const bit = (bits >> i) & 1;
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      set(a, b, bit); // top-right block
      set(b, a, bit); // bottom-left block
    }
  }
  return { size, modules, isFunction };
}

// zigzag data placement (ISO §8.7.3), skipping the vertical timing column
function placeData(m, codewords) {
  const { size, modules, isFunction } = m;
  let i = 0;
  const totalBits = codewords.length * 8;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (!isFunction[y][x] && i < totalBits) {
          modules[y][x] = (codewords[i >> 3] >> (7 - (i & 7))) & 1;
          i++;
        }
      }
    }
  }
  // remainder bits (if any) stay 0 — already the array default
}

const MASKS = [
  (x, y) => (x + y) % 2 === 0,
  (x, y) => y % 2 === 0,
  (x, y) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

function applyMask(m, mask) {
  const { size, modules, isFunction } = m;
  const fn = MASKS[mask];
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    if (!isFunction[y][x] && fn(x, y)) modules[y][x] ^= 1;
  }
}

// format info: 5 data bits (ecl ‖ mask) + BCH(15,5) remainder, XOR 0x5412,
// drawn in both copies (ISO §8.9)
function drawFormatBits(m, ecl, mask) {
  const { size, modules } = m;
  const data = (ECL_BITS[ecl] << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >> 9) * 0x537);
  const bits = ((data << 10) | rem) ^ 0x5412;
  const bit = (i) => (bits >> i) & 1;
  const put = (x, y, v) => { modules[y][x] = v; };
  for (let i = 0; i <= 5; i++) put(8, i, bit(i));
  put(8, 7, bit(6)); put(8, 8, bit(7)); put(7, 8, bit(8));
  for (let i = 9; i < 15; i++) put(14 - i, 8, bit(i));
  for (let i = 0; i < 8; i++) put(size - 1 - i, 8, bit(i));
  for (let i = 8; i < 15; i++) put(8, size - 15 + i, bit(i));
  put(8, size - 8, 1); // the dark module never carries format data
}

// mask-choice penalty (ISO §8.8.2 — N1 3, N2 3, N3 40, N4 10)
function penalty(m) {
  const { size, modules } = m;
  let score = 0;
  // N1: same-color runs of length ≥5, rows and columns
  const line = (get) => {
    for (let a = 0; a < size; a++) {
      let runColor = get(a, 0); let runLen = 1;
      for (let b = 1; b < size; b++) {
        const c = get(a, b);
        if (c === runColor) { runLen++; continue; }
        if (runLen >= 5) score += 3 + (runLen - 5);
        runColor = c; runLen = 1;
      }
      if (runLen >= 5) score += 3 + (runLen - 5);
    }
  };
  line((a, b) => modules[a][b]);         // rows
  line((a, b) => modules[b][a]);         // columns

  // N2: 2×2 same-color blocks
  for (let y = 0; y < size - 1; y++) for (let x = 0; x < size - 1; x++) {
    const c = modules[y][x];
    if (c === modules[y][x + 1] && c === modules[y + 1][x] && c === modules[y + 1][x + 1]) score += 3;
  }

  // N3: 1011101 with 0000 on either side, rows and columns, sliding window
  const PAT = [1, 0, 1, 1, 1, 0, 1];
  const n3line = (get) => {
    for (let a = 0; a < size; a++) {
      for (let b = 0; b + 7 <= size; b++) {
        let hit = true;
        for (let k = 0; k < 7; k++) if (get(a, b + k) !== PAT[k]) { hit = false; break; }
        if (!hit) continue;
        const lightRun = (from, dir) => {
          for (let k = 0; k < 4; k++) {
            const idx = from + dir * k;
            if (idx < 0 || idx >= size || get(a, idx) !== 0) return false;
          }
          return true;
        };
        if (lightRun(b - 1, -1) || lightRun(b + 7, +1)) score += 40;
      }
    }
  };
  n3line((a, b) => modules[a][b]);
  n3line((a, b) => modules[b][a]);

  // N4: dark-module proportion, 10 points per 5% step away from 50%
  let dark = 0;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) dark += modules[y][x];
  const total = size * size;
  score += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
  return score;
}

// --- public API ---------------------------------------------------------------

// Encode text (UTF-8, byte mode) → { version, size, mask, modules } where
// modules[y][x] is 0|1. `mask` −1 (default) selects by ISO penalty; 0..7 forces
// (the cross-validation harness uses forcing; production always auto-selects).
function qrEncodeText(text, { ecl = 'L', mask = -1 } = {}) {
  if (!EC_TABLE[ecl]) throw new Error(`unsupported QR EC level ${JSON.stringify(ecl)} — this encoder speaks L and M`);
  const bytes = Buffer.from(String(text), 'utf8');
  const version = pickVersion(bytes.length, ecl);
  const codewords = buildCodewords(bytes, version, ecl);
  const m = buildMatrix(version);
  placeData(m, codewords);
  let chosen = mask;
  if (chosen === -1) {
    let best = Infinity;
    for (let i = 0; i < 8; i++) {
      applyMask(m, i);
      drawFormatBits(m, ecl, i);
      const p = penalty(m);
      if (p < best) { best = p; chosen = i; }
      applyMask(m, i); // XOR twice = undo
    }
  }
  applyMask(m, chosen);
  drawFormatBits(m, ecl, chosen);
  return { version, size: m.size, mask: chosen, modules: m.modules.map((row) => Array.from(row)) };
}

// Render for a terminal: one char per module horizontally, two modules per
// char vertically (▀/▄/█), dark modules as the FOREGROUND color. On a dark
// terminal theme that displays as a light-on-dark ("inverted") QR — which
// iOS's scanner reads fine, and is what every terminal QR in the wild does.
// Quiet zone: 2 modules on every side (the ISO asks 4; 2 is what terminal
// renderers ship and scanners accept at screen distances).
function qrRenderTerminal(qr, { quiet = 2 } = {}) {
  const { size, modules } = qr;
  const dim = size + quiet * 2;
  const at = (x, y) => {
    const mx = x - quiet; const my = y - quiet;
    if (mx < 0 || mx >= size || my < 0 || my >= size) return 0;
    return modules[my][mx];
  };
  const lines = [];
  for (let y = 0; y < dim; y += 2) {
    let line = '';
    for (let x = 0; x < dim; x++) {
      const top = at(x, y);
      const bottom = y + 1 < dim ? at(x, y + 1) : 0;
      line += top ? (bottom ? '█' : '▀') : (bottom ? '▄' : ' ');
    }
    lines.push(line);
  }
  return lines.join('\n');
}

module.exports = { qrEncodeText, qrRenderTerminal };
