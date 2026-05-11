"""Generate simple PNG icons for the Price Checker PWA."""
import struct, zlib

def create_png(width, height, r, g, b):
    raw = b''
    for y in range(height):
        raw += b'\x00'
        for x in range(width):
            cx, cy = width / 2, height / 2
            rx, ry = width / 2, height / 2
            edge = 0.85
            dx = abs(x - cx) / rx
            dy = abs(y - cy) / ry
            if dx > edge or dy > edge:
                corner_dx = max(0, abs(x - cx) - rx * edge)
                corner_dy = max(0, abs(y - cy) - ry * edge)
                if (corner_dx / rx) ** 2 + (corner_dy / ry) ** 2 > 0.1:
                    raw += bytes([10, 10, 12, 255])
                else:
                    raw += bytes([r, g, b, 255])
            else:
                raw += bytes([r, g, b, 255])

    def chunk(chunk_type, data):
        c = chunk_type + data
        crc = struct.pack('>I', zlib.crc32(c) & 0xffffffff)
        return struct.pack('>I', len(data)) + c + crc

    sig = b'\x89PNG\r\n\x1a\n'
    ihdr = chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 6, 0, 0, 0))
    compressor = zlib.compressobj()
    compressed = compressor.compress(raw) + compressor.flush()
    idat = chunk(b'IDAT', compressed)
    iend = chunk(b'IEND', b'')
    return sig + ihdr + idat + iend

png192 = create_png(192, 192, 94, 106, 210)
png512 = create_png(512, 512, 94, 106, 210)

with open('/mnt/d/hermes/price-checker/icon-192.png', 'wb') as f:
    f.write(png192)
with open('/mnt/d/hermes/price-checker/icon-512.png', 'wb') as f:
    f.write(png512)
print(f'icon-192.png: {len(png192)} bytes')
print(f'icon-512.png: {len(png512)} bytes')
