import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import { NativeImage, app, nativeImage } from 'electron';

// ── Minimal PNG encoder ───────────────────────────────────────────────────────

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
  return c >>> 0;
});

function crc32(buf: Buffer): number {
  let c = 0xFFFFFFFF;
  for (const b of buf) c = (CRC_TABLE[(c ^ b) & 0xFF] ^ (c >>> 8)) >>> 0;
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const t = Buffer.from(type, 'ascii');
  const len = Buffer.allocUnsafe(4);
  len.writeUInt32BE(data.length);
  const crcBuf = Buffer.allocUnsafe(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crcBuf]);
}

function makePNG(
  w: number,
  h: number,
  pixel: (x: number, y: number) => [number, number, number],
): Buffer {
  // Each row: 1 filter byte (0 = None) + w × 3 RGB bytes
  const raw = Buffer.allocUnsafe(h * (1 + w * 3));
  for (let y = 0; y < h; y++) {
    const row = y * (1 + w * 3);
    raw[row] = 0;
    for (let x = 0; x < w; x++) {
      const [r, g, b] = pixel(x, y);
      const i = row + 1 + x * 3;
      raw[i] = r; raw[i + 1] = g; raw[i + 2] = b;
    }
  }
  const ihdr = Buffer.allocUnsafe(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), // PNG signature
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── 16×16 "W" pixel mask ─────────────────────────────────────────────────────

// Each array is the list of lit x-values for that row index.
const W_ROWS: number[][] = [
  /*y=0*/  [],
  /*y=1*/  [1, 2, 7, 8, 9, 10, 14, 15],
  /*y=2*/  [1, 2, 7, 8, 9, 10, 13, 14],
  /*y=3*/  [2, 3, 7, 8, 9, 10, 13, 14],
  /*y=4*/  [2, 3, 7, 8, 9, 10, 13, 14],
  /*y=5*/  [3, 4, 6, 7, 10, 11, 12, 13],
  /*y=6*/  [3, 4, 6, 7, 10, 11, 12, 13],
  /*y=7*/  [3, 4, 6, 7, 10, 11, 12, 13],
  /*y=8*/  [4, 5, 6, 7, 10, 11, 12],
  /*y=9*/  [4, 5, 6, 11, 12],
  /*y=10*/ [5, 6, 11, 12],
  /*y=11*/ [5, 6, 11, 12],
  /*y=12*/ [5, 6, 11, 12],
  /*y=13*/ [],
  /*y=14*/ [],
  /*y=15*/ [],
];

const W_SET = new Set<number>(
  W_ROWS.flatMap((xs, y) => xs.map((x) => y * 16 + x)),
);

const BG: [number, number, number] = [0x2f, 0x3a, 0x48];
const FG: [number, number, number] = [0xf0, 0xf4, 0xf8];

// ── Exported icon factory ─────────────────────────────────────────────────────

export function createWeaverIcon(): NativeImage {
  try {
    const pngBuf = makePNG(16, 16, (x, y) => W_SET.has(y * 16 + x) ? FG : BG);

    // Write to a temp file — most reliable path on Windows
    const tmpPath = path.join(app.getPath('temp'), 'weaver-tray-icon.png');
    fs.writeFileSync(tmpPath, pngBuf);
    const fromFile = nativeImage.createFromPath(tmpPath);
    if (!fromFile.isEmpty()) {
      return fromFile;
    }

    // Fallback: load directly from buffer
    const fromBuf = nativeImage.createFromBuffer(pngBuf);
    if (!fromBuf.isEmpty()) {
      return fromBuf;
    }

    throw new Error('nativeImage was empty after both load methods');
  } catch (err) {
    console.error('[Weaver] Could not create tray icon:', err);
    return nativeImage.createEmpty();
  }
}
