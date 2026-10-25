/** Dimensions for formats supported by ImageScript 1.3.1, before decoding. */
export function readImageHeader(bytes: Buffer): { width: number; height: number; mime: string } | null {
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
      bytes.readUInt32BE(8) === 13 && bytes.toString("latin1", 12, 16) === "IHDR") {
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), mime: "image/png" };
  }
  if (bytes.length >= 13 && ["GIF87a", "GIF89a"].includes(bytes.toString("latin1", 0, 6))) {
    // Frame rectangles can exceed the logical screen. Bound the first frame
    // as well as the canvas; decoding stops after that frame.
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
  return null;
}
