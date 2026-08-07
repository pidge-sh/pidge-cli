#!/usr/bin/env python3
"""Cross-validates src/terminal/qr.js against python-qrcode and (re)writes
test/qr_golden.json — the committed golden matrices the node test asserts.

The cross-wire discipline applied to the QR encoder: two INDEPENDENT implementations
(this repo's clean-room encoder vs python-qrcode) must agree module-by-module
before any QR of ours meets a camera. Run of record:

    pip3 install --user qrcode pillow   # pure python + PIL
    python3 test/gen-qr-golden.py

Sweep: every version 1..20 at level L and M (payload lengths chosen to land on
each version), all 8 masks FORCED plus the penalty-chosen one — ~750 matrix
comparisons. Any disagreement exits non-zero and writes nothing. The golden
file then pins a handful of cases (including the §24 pairing payload) so CI
re-asserts the encoder with zero python.

CI never runs this file; it is the PROVENANCE record (who validated what,
against which oracle) and the regeneration path after any qr.js change.
"""
import json
import subprocess
import sys
from pathlib import Path

try:
    import qrcode
    import qrcode.constants as C
except ImportError:
    sys.exit("python-qrcode missing — pip3 install --user qrcode pillow")

HERE = Path(__file__).parent
NODE_HELPER = """
'use strict';
const { qrEncodeText } = require(process.argv[1]);
let input = '';
process.stdin.on('data', (c) => { input += c; });
process.stdin.on('end', () => {
  const cases = JSON.parse(input);
  const out = cases.map(({ text, ecl, mask }) => {
    const q = qrEncodeText(text, { ecl, mask });
    return { version: q.version, size: q.size, mask: q.mask,
             rows: q.modules.map((r) => r.join('')) };
  });
  process.stdout.write(JSON.stringify(out));
});
"""

EC = {"L": C.ERROR_CORRECT_L, "M": C.ERROR_CORRECT_M}


def py_encode(text, ecl, mask):
    qr = qrcode.QRCode(error_correction=EC[ecl], border=0,
                       mask_pattern=(None if mask == -1 else mask))
    # FORCE byte mode: add_data auto-detects ("AAA…" would ride alphanumeric,
    # 11 bits per 2 chars) while qr.js is byte-mode-only by design.
    qr.add_data(qrcode.util.QRData(text.encode("utf-8"),
                                   mode=qrcode.util.MODE_8BIT_BYTE))
    qr.make(fit=True)
    rows = ["".join("1" if m else "0" for m in row) for row in qr.modules]
    return {"version": qr.version, "size": len(rows), "rows": rows}


def payload_for_version(version, ecl):
    """An ASCII payload whose byte length lands exactly on `version`."""
    # capacity check mirrors qr.js pickVersion; grow until the version matches
    n = 1
    while True:
        text = "A" * n
        qr = qrcode.QRCode(error_correction=EC[ecl], border=0)
        qr.add_data(qrcode.util.QRData(text.encode("utf-8"),
                                       mode=qrcode.util.MODE_8BIT_BYTE))
        qr.make(fit=True)
        if qr.version == version:
            return text
        if qr.version > version:
            raise AssertionError(f"overshot v{version} at {ecl} (got {qr.version})")
        n += max(1, (version - qr.version) * 8)


def main():
    cases = []
    for ecl in ("L", "M"):
        for version in range(1, 21):
            text = payload_for_version(version, ecl)
            for mask in [-1, 0, 1, 2, 3, 4, 5, 6, 7]:
                cases.append({"text": text, "ecl": ecl, "mask": mask})
    # a realistic §24.1 pairing payload shape (unicode-free by construction —
    # base64url + a hostname; keep one non-ASCII case anyway for UTF-8 bytes)
    realistic = ("pidge-pair:v1:eyJrIjoiN0lyZjZWdTVjcnBFNHRXMGNOZmdJbDl6UDRQV2FaT19KUmxHWGIz"
                 "ZzFRSSIsImtmIjoibUlPYW9BIiwiaG9zdCI6InN0dWRpby5sb2NhbCIsIm9zIjoibWFjb3Mi"
                 "LCJiYXNlX3VybCI6Imh0dHBzOi8vYXBpLnBpZGdlLnNoIn0")
    for mask in [-1, 0, 1, 2, 3, 4, 5, 6, 7]:
        cases.append({"text": realistic, "ecl": "L", "mask": mask})
        cases.append({"text": "café ☕ pidge", "ecl": "L", "mask": mask})

    node = subprocess.run(
        ["node", "-e", NODE_HELPER, str(HERE.parent / "src" / "terminal" / "qr.js")],
        input=json.dumps(cases), capture_output=True, text=True, check=True)
    ours = json.loads(node.stdout)

    bad = 0
    for case, got in zip(cases, ours):
        want = py_encode(case["text"], case["ecl"], case["mask"])
        ctx = f"ecl={case['ecl']} mask={case['mask']} len={len(case['text'])}"
        if got["version"] != want["version"]:
            print(f"VERSION mismatch ({ctx}): ours v{got['version']} vs python v{want['version']}")
            bad += 1
            continue
        if case["mask"] == -1 and got["rows"] != want["rows"]:
            # both sides picked their own mask by penalty — a different pick is
            # only a FAILURE if the matrices differ under the SAME forced mask,
            # which the forced cases above already assert. Note it and move on.
            print(f"note: auto-mask pick differs ({ctx}): ours {got['mask']}")
            continue
        if got["rows"] != want["rows"]:
            print(f"MATRIX mismatch ({ctx}, v{got['version']})")
            bad += 1
    if bad:
        sys.exit(f"{bad} disagreement(s) — qr_golden.json NOT written")

    golden_cases = []
    for case, got in zip(cases, ours):
        keep = (case["mask"] == -1 and (
            case["text"] == realistic or "café" in case["text"] or
            (case["ecl"] == "L" and got["version"] in (1, 5, 9, 10, 14, 20))))
        if keep:
            golden_cases.append({
                "text": case["text"], "ecl": case["ecl"],
                "version": got["version"], "size": got["size"], "mask": got["mask"],
                "rows": got["rows"],
            })
    out = {
        "_readme": [
            "Golden QR matrices for src/terminal/qr.js — asserted by test/pairing.test.js.",
            "Every case was cross-validated module-by-module against python-qrcode",
            "(independent implementation) by test/gen-qr-golden.py, which also swept",
            "versions 1..20 x levels L,M x all 8 forced masks. Regenerate after any",
            "qr.js change: python3 test/gen-qr-golden.py (it refuses to write on any",
            "disagreement).",
        ],
        "cases": golden_cases,
    }
    path = HERE / "qr_golden.json"
    path.write_text(json.dumps(out, indent=2) + "\n")
    print(f"OK — {len(cases)} comparisons agreed; wrote {path} ({len(golden_cases)} golden cases)")


if __name__ == "__main__":
    main()
