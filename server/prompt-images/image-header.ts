/** Width and height from a PNG, JPEG, WebP or GIF header. Other bytes return null. */
export function readImageHeader(bytes: Buffer): { width: number; height: number; mime: string } | null {
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
      bytes.readUInt32BE(8) === 13 && bytes.toString("latin1", 12, 16) === "IHDR") {
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), mime: "image/png" };
  }
  if (bytes.length >= 13 && ["GIF87a", "GIF89a"].includes(bytes.toString("latin1", 0, 6))) {
    // Frame rectangles can exceed the logical screen. Require the first frame
    // to fit the canvas so a contradictory header is refused.
    const width = bytes.readUInt16LE(6), height = bytes.readUInt16LE(8);
    let at = 13 + ((bytes[10]! & 0x80) ? 3 * (1 << ((bytes[10]! & 7) + 1)) : 0);
    while (at < bytes.length) {
      const marker = bytes[at++];
      if (marker === 0x2c) {
        if (at + 9 > bytes.length) return null;
        const frameWidth = bytes.readUInt16LE(at + 4), frameHeight = bytes.readUInt16LE(at + 6);
        if (!frameWidth || !frameHeight || frameWidth > width || frameHeight > height) return null;
        return { width, height, mime: "image/gif" };
      }
      if (marker !== 0x21 || at >= bytes.length) return null;
      at++; // Extension label, followed by length-prefixed sub-blocks.
      while (at < bytes.length) {
        const size = bytes[at++]!;
        if (!size) break;
        at += size;
      }
    }
    return null;
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let at = 2;
    while (at + 4 <= bytes.length) {
      if (bytes[at++] !== 0xff) return null;
      while (bytes[at] === 0xff) at++;
      const marker = bytes[at++];
      if (marker === undefined || marker === 0xda || marker === 0xd9) return null;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (at + 2 > bytes.length) return null;
      const length = bytes.readUInt16BE(at);
      if (length < 2 || at + length > bytes.length) return null;
      const isFrame = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
      if (isFrame) {
        if (length < 8) return null;
        return { width: bytes.readUInt16BE(at + 5), height: bytes.readUInt16BE(at + 3), mime: "image/jpeg" };
      }
      at += length;
    }
  }
  return readWebpHeader(bytes);
}

/**
 * Canvas size from a VP8X, VP8 or VP8L chunk. The bitstream itself is not read.
 * VP8X stores each dimension minus one in 24 bits; VP8L does the same in 14.
 */
function readWebpHeader(bytes: Buffer): { width: number; height: number; mime: string } | null {
  if (bytes.length < 12 || bytes.toString("latin1", 0, 4) !== "RIFF" || bytes.toString("latin1", 8, 12) !== "WEBP") return null;
  let at = 12;
  while (at + 8 <= bytes.length) {
    const tag = bytes.toString("latin1", at, at + 4);
    const size = bytes.readUInt32LE(at + 4);
    const payload = at + 8;
    if (size > bytes.length - payload) return null;
    if (tag === "VP8X" && size >= 10) {
      const width = 1 + bytes.readUIntLE(payload + 4, 3);
      const height = 1 + bytes.readUIntLE(payload + 7, 3);
      return width > 0 && height > 0 ? { width, height, mime: "image/webp" } : null;
    }
    if (tag === "VP8 " && size >= 10) {
      const frame = bytes[payload];
      if (frame === undefined || (frame & 1) !== 0) return null;
      if (bytes[payload + 3] !== 0x9d || bytes[payload + 4] !== 0x01 || bytes[payload + 5] !== 0x2a) return null;
      const width = bytes.readUInt16LE(payload + 6) & 0x3fff;
      const height = bytes.readUInt16LE(payload + 8) & 0x3fff;
      return width > 0 && height > 0 ? { width, height, mime: "image/webp" } : null;
    }
    if (tag === "VP8L" && size >= 5) {
      if (bytes[payload] !== 0x2f) return null;
      const bits = bytes.readUInt32LE(payload + 1);
      const width = (bits & 0x3fff) + 1;
      const height = ((bits >>> 14) & 0x3fff) + 1;
      return { width, height, mime: "image/webp" };
    }
    at = payload + size + (size & 1);
  }
  return null;
}
