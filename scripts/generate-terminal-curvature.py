"""Generate CRT geometry in R/G and an edge blur mask in B."""

import math
from pathlib import Path
import struct
import zlib

size = 256
pixels = bytearray()
for y in range(size):
    pixels.append(0)  # PNG row filter: none
    ny = 2 * y / (size - 1) - 1
    for x in range(size):
        nx = 2 * x / (size - 1) - 1
        edge = min(1, max(0, (math.hypot(nx, ny) - 0.4) / 1.015)) ** 1.6
        pixels.extend((round(127.5 + 127.5 * nx * edge),
                       round(127.5 + 127.5 * ny * edge), round(255 * edge)))


def chunk(kind, data):
    return (struct.pack(">I", len(data)) + kind + data
            + struct.pack(">I", zlib.crc32(kind + data)))


png = b"\x89PNG\r\n\x1a\n"
png += chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0))
png += chunk(b"IDAT", zlib.compress(pixels, 9))
png += chunk(b"IEND", b"")
output = Path(__file__).resolve().parents[1] / "web" / "terminal-curvature.png"
output.write_bytes(png)
print(f"Generated {output.name}: {len(png)} bytes")
