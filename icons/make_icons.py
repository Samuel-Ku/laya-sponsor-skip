"""Generate the extension icons: rounded square + skip-forward glyph.

Standard library only (no Pillow): the pixels are drawn at 4x and box-filtered
down, which is enough antialiasing for 16-128 px icons.

  npm run icons
"""
import struct
import zlib
from pathlib import Path

HERE = Path(__file__).parent
ACCENT = (225, 29, 72)
SUPER = 4  # supersampling factor


def write_png(path, width, height, rgba):
    raw = b"".join(b"\x00" + bytes(rgba[y * width * 4:(y + 1) * width * 4]) for y in range(height))

    def chunk(tag, data):
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    ihdr = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    path.write_bytes(
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )


def rounded(x, y, size, radius):
    """Inside test for a rounded square of `size` px with corner radius."""
    cx = min(max(x, radius), size - radius)
    cy = min(max(y, radius), size - radius)
    return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2


def glyph(x, y, size):
    """Skip-forward: one triangle plus a bar, in a 1x1 box scaled to `size`."""
    u, v = x / size, y / size
    if 0.24 <= u <= 0.33 and 0.30 <= v <= 0.70:  # bar
        return True
    x0, x1, half = 0.38, 0.74, 0.19
    if x0 <= u <= x1 and abs(v - 0.5) <= half:  # triangle, apex to the right
        return abs(v - 0.5) / half <= (x1 - u) / (x1 - x0)
    return False


def render(size):
    """Supersampled RGBA pixels: colour averaged over covered samples only,
    alpha averaged over all samples — no dark fringe on the rounded corners."""
    big = size * SUPER
    radius = big / 5
    color = [[[0.0, 0.0, 0.0, 0] for _ in range(size)] for _ in range(size)]
    for by in range(big):
        for bx in range(big):
            if not rounded(bx + 0.5, by + 0.5, big, radius):
                continue
            px = (255, 255, 255) if glyph(bx + 0.5, by + 0.5, big) else ACCENT
            cell = color[by // SUPER][bx // SUPER]
            cell[0] += px[0]
            cell[1] += px[1]
            cell[2] += px[2]
            cell[3] += 1
    flat = bytearray()
    total = SUPER * SUPER
    for row in color:
        for r, g, b, covered in row:
            if covered:
                flat.extend((round(r / covered), round(g / covered), round(b / covered), round(255 * covered / total)))
            else:
                flat.extend((0, 0, 0, 0))
    return flat


for size in (16, 32, 48, 128):
    write_png(HERE / f"icon{size}.png", size, size, render(size))
    print("wrote", f"icon{size}.png")
