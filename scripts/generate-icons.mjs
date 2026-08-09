import { deflateSync } from "node:zlib";
import { writeFile } from "node:fs/promises";

const colors = {
  ink: [23, 33, 31, 255],
  paper: [242, 245, 242, 255],
  vermilion: [200, 73, 53, 255],
};

const distanceToSegment = (px, py, ax, ay, bx, by) => {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;
  const projection = lengthSquared === 0
    ? 0
    : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSquared));
  const x = ax + projection * dx;
  const y = ay + projection * dy;
  return Math.hypot(px - x, py - y);
};

const coversStroke = (distance, radius, width) => Math.abs(distance - radius) <= width / 2;

const pixelColor = (x, y) => {
  let color = colors.ink;

  if (x >= 14 && x <= 166 && y >= 14 && y <= 166) color = colors.paper;

  const borderDistance = Math.min(Math.abs(x - 14), Math.abs(x - 166), Math.abs(y - 14), Math.abs(y - 166));
  if (x >= 14 && x <= 166 && y >= 14 && y <= 166 && borderDistance <= 2) color = colors.vermilion;

  if (coversStroke(Math.hypot(x - 90, y - 90), 44, 8)) color = colors.ink;
  if (coversStroke(Math.hypot(x - 90, y - 90), 15, 8)) color = colors.vermilion;

  const cardinalSegments = [
    [90, 26, 90, 44],
    [136, 90, 154, 90],
    [90, 136, 90, 154],
    [26, 90, 44, 90],
  ];
  if (cardinalSegments.some(([ax, ay, bx, by]) => distanceToSegment(x, y, ax, ay, bx, by) <= 4)) {
    color = colors.ink;
  }

  if (Math.hypot(x - 90, y - 90) <= 4) color = colors.vermilion;
  return color;
};

const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = (value & 1) ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

const crc32 = (data) => {
  let value = 0xffffffff;
  for (const byte of data) value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
};

const chunk = (type, data) => {
  const typeBytes = Buffer.from(type);
  const payload = Buffer.concat([typeBytes, data]);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(payload), 0);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  return Buffer.concat([length, payload, checksum]);
};

const createPng = (size) => {
  const samples = 4;
  const raw = Buffer.alloc((size * 4 + 1) * size);

  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x += 1) {
      const color = [0, 0, 0, 0];
      for (let sampleY = 0; sampleY < samples; sampleY += 1) {
        for (let sampleX = 0; sampleX < samples; sampleX += 1) {
          const next = pixelColor((x + (sampleX + 0.5) / samples) * 180 / size, (y + (sampleY + 0.5) / samples) * 180 / size);
          for (let channel = 0; channel < 4; channel += 1) color[channel] += next[channel] / (samples * samples);
        }
      }
      const offset = y * (size * 4 + 1) + 1 + x * 4;
      for (let channel = 0; channel < 4; channel += 1) raw[offset + channel] = Math.round(color[channel]);
    }
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
};

await writeFile("public/apple-touch-icon.png", createPng(180));
await writeFile("public/icon-512.png", createPng(512));
