"""Draw a simple geometric contact-link icon using only the Python standard library."""
import struct
import zlib
from build import ROOT, LOGOS


def chunk(kind, data):
    return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data) & 0xffffffff)


for name, (width, height) in LOGOS.items():
    rows = []
    size = min(width, height)
    for y in range(height):
        row = bytearray()
        for x in range(width):
            u, v = (x - width / 2) / size, (y - height / 2) / size
            heads = any((u - cx) ** 2 + (v + .18) ** 2 < .075 ** 2 for cx in [-.19, .19])
            bodies = any(abs(u - cx) < .10 and -.045 < v < .15 for cx in [-.19, .19])
            link = abs(u) < .12 and .025 < v < .06
            row.extend((245, 249, 255) if heads or bodies or link else (33, 98, 150))
        rows.append(b'\0' + row)
    data = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 2, 0, 0, 0))
    data += chunk(b'IDAT', zlib.compress(b''.join(rows))) + chunk(b'IEND', b'')
    (ROOT / 'images' / name).write_bytes(data)
