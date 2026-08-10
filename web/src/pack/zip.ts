/**
 * A minimal ZIP writer, so the browser can produce a data pack with no
 * dependency.
 *
 * Writes the classic 32-bit format: local headers, then a central directory,
 * then the end record. Entries are deflated with CompressionStream when it is
 * available and stored uncompressed otherwise, which every unzip
 * implementation — including Minecraft's — accepts.
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

async function deflateRaw(bytes: Uint8Array): Promise<Uint8Array | null> {
  if (typeof CompressionStream === "undefined") return null;
  try {
    const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream("deflate-raw"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    return null;
  }
}

export interface ZipEntry {
  /** Path inside the archive, always forward slashes. */
  path: string;
  data: Uint8Array | string;
}

interface Staged {
  nameBytes: Uint8Array;
  payload: Uint8Array;
  crc: number;
  rawSize: number;
  method: number;
  offset: number;
}

/** DOS date/time, which is what the ZIP header stores. */
function dosDateTime(date: Date): { time: number; date: number } {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
  const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, date: day };
}

export async function createZip(entries: ZipEntry[], modified = new Date()): Promise<Blob> {
  const encoder = new TextEncoder();
  const { time, date } = dosDateTime(modified);
  const staged: Staged[] = [];
  const chunks: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const raw = typeof entry.data === "string" ? encoder.encode(entry.data) : entry.data;
    const nameBytes = encoder.encode(entry.path);
    const compressed = await deflateRaw(raw);
    // Only keep the compressed form when it actually helps.
    const useDeflate = compressed !== null && compressed.length < raw.length;
    const payload = useDeflate ? compressed : raw;

    const header = new Uint8Array(30 + nameBytes.length);
    const view = new DataView(header.buffer);
    view.setUint32(0, 0x04034b50, true); // local file header
    view.setUint16(4, 20, true); // version needed
    view.setUint16(6, 0x0800, true); // UTF-8 names
    view.setUint16(8, useDeflate ? 8 : 0, true);
    view.setUint16(10, time, true);
    view.setUint16(12, date, true);
    view.setUint32(14, crc32(raw), true);
    view.setUint32(18, payload.length, true);
    view.setUint32(22, raw.length, true);
    view.setUint16(26, nameBytes.length, true);
    view.setUint16(28, 0, true); // no extra field
    header.set(nameBytes, 30);

    staged.push({
      nameBytes,
      payload,
      crc: crc32(raw),
      rawSize: raw.length,
      method: useDeflate ? 8 : 0,
      offset,
    });
    chunks.push(header, payload);
    offset += header.length + payload.length;
  }

  const directoryStart = offset;
  for (const item of staged) {
    const record = new Uint8Array(46 + item.nameBytes.length);
    const view = new DataView(record.buffer);
    view.setUint32(0, 0x02014b50, true); // central directory header
    view.setUint16(4, 20, true); // version made by
    view.setUint16(6, 20, true); // version needed
    view.setUint16(8, 0x0800, true);
    view.setUint16(10, item.method, true);
    view.setUint16(12, time, true);
    view.setUint16(14, date, true);
    view.setUint32(16, item.crc, true);
    view.setUint32(20, item.payload.length, true);
    view.setUint32(24, item.rawSize, true);
    view.setUint16(28, item.nameBytes.length, true);
    view.setUint16(30, 0, true);
    view.setUint16(32, 0, true);
    view.setUint16(34, 0, true);
    view.setUint16(36, 0, true);
    view.setUint32(38, 0, true); // external attributes
    view.setUint32(42, item.offset, true);
    record.set(item.nameBytes, 46);
    chunks.push(record);
    offset += record.length;
  }

  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true); // end of central directory
  endView.setUint16(8, staged.length, true);
  endView.setUint16(10, staged.length, true);
  endView.setUint32(12, offset - directoryStart, true);
  endView.setUint32(16, directoryStart, true);
  chunks.push(end);

  return new Blob(chunks as BlobPart[], { type: "application/zip" });
}
