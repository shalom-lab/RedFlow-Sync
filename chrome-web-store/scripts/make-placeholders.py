#!/usr/bin/env python3
"""Write solid gray placeholder PNGs at Chrome Web Store sizes (stdlib only)."""
from __future__ import annotations

import struct
import zlib
from pathlib import Path

# (filename, width, height)
ASSETS = (
    ("icon128.png", 128, 128),
    ("promo-small-440x280.png", 440, 280),
    ("promo-marquee-1400x560.png", 1400, 560),
    ("screenshot-01-1280x800.png", 1280, 800),
    ("screenshot-02-1280x800.png", 1280, 800),
    ("screenshot-03-1280x800.png", 1280, 800),
    ("screenshot-04-1280x800.png", 1280, 800),
)

# Light gray placeholder fill
R, G, B = 226, 232, 240  # #e2e8f0


def _chunk(tag: bytes, data: bytes) -> bytes:
    return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)


def write_png(path: Path, width: int, height: int) -> None:
    raw = b"".join(b"\x00" + bytes([R, G, B]) * width for _ in range(height))
    ihdr = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)  # 8-bit RGB
    png = b"\x89PNG\r\n\x1a\n" + _chunk(b"IHDR", ihdr) + _chunk(b"IDAT", zlib.compress(raw, 9)) + _chunk(b"IEND", b"")
    path.write_bytes(png)


def main() -> None:
    root = Path(__file__).resolve().parents[1]
    for name, w, h in ASSETS:
        out = root / name
        write_png(out, w, h)
        print(f"Wrote {out.name} ({w}×{h})")


if __name__ == "__main__":
    main()
