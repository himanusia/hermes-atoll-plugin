#!/usr/bin/env python3
"""build-wing-icon - regenerate assets/hermes-monitor-icon.png for the Atoll wing.

Geometry: PNG 52x52 drawn 1:1 in Atoll's {26,26}pt music-sized wing slot.
Do not reserve the old transparent 36px tail: it widened Hermes' closed notch.

Artwork policy (2026-09-26, final): the drawing is the ORIGINAL artwork
(assets/hermes-monitor-icon-original.png) pasted 1:1. NO threshold, NO levels,
NO unsharp - those destroyed the anti-aliasing and made the icon read muddy
(user: "icon belum lu revert").
"""
from PIL import Image
from pathlib import Path
import sys

REPO = Path(__file__).resolve().parents[1]
ASSETS = REPO / "assets"
SRC = ASSETS / "hermes-monitor-icon-original.png"
OUT = ASSETS / "hermes-monitor-icon.png"

def main():
    if not SRC.exists():
        sys.exit(f"missing {SRC}")
    src = Image.open(SRC).convert("RGBA")
    a = src.split()[3]
    bb = a.point(lambda v: 255 if v > 10 else 0).getbbox()
    if not bb:
        sys.exit("no artwork found in source")
    tile = src.crop(bb)
    w, h = tile.size
    if w > 52 or h > 52:
        s = 52.0 / max(w, h)
        tile = tile.resize((max(1, round(w * s)), max(1, round(h * s))), Image.LANCZOS)
        w, h = tile.size
    canvas = Image.new("RGBA", (52, 52), (0, 0, 0, 0))
    canvas.paste(tile, (0, (52 - h) // 2), tile)
    canvas.save(OUT)
    print(f"wrote {OUT} ({OUT.stat().st_size} bytes)")

main()
