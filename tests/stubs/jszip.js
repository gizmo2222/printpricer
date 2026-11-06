// A small stand-in for the parts of JSZip 3 that parser.js uses:
//   JSZip.loadAsync(data) -> { files: { [path]: { dir } }, file(path) }
//   zip.file(path).async('string')
// Reads stored (0) and deflated (8) entries with node:zlib. Like JSZip, it
// rejects input that is not a zip or whose central directory is cut off.

import { inflateRawSync } from 'node:zlib';

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;

async function toBuffer(data) {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof Uint8Array) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (data && typeof data.arrayBuffer === 'function') return Buffer.from(await data.arrayBuffer());
  throw new Error("Can't read the data: unsupported input type");
}

function findEocd(buf) {
  const min = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  return -1;
}

class ZipEntry {
  constructor(buf, name, method, compSize, localOffset) {
    this.name = name;
    this.dir = name.endsWith('/');
    this._buf = buf;
    this._method = method;
    this._compSize = compSize;
    this._localOffset = localOffset;
  }

  _bytes() {
    const buf = this._buf;
    const off = this._localOffset;
    if (off + 30 > buf.length || buf.readUInt32LE(off) !== LOC_SIG) {
      throw new Error(`Corrupted zip: bad local header for ${this.name}`);
    }
    const start = off + 30 + buf.readUInt16LE(off + 26) + buf.readUInt16LE(off + 28);
    const end = start + this._compSize;
    if (end > buf.length) throw new Error(`Corrupted zip: data for ${this.name} is truncated`);
    const raw = buf.subarray(start, end);
    if (this._method === 0) return raw;
    if (this._method === 8) return inflateRawSync(raw);
    throw new Error(`Unsupported compression method ${this._method}`);
  }

  async async(type) {
    const bytes = this._bytes();
    if (type === 'string' || type === 'text') return bytes.toString('utf8');
    if (type === 'uint8array') return new Uint8Array(bytes);
    if (type === 'arraybuffer') return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length);
    throw new Error(`Unsupported output type ${type}`);
  }
}

export class JSZip {
  constructor() { this.files = {}; }

  file(path) { return this.files[path] || null; }

  static async loadAsync(data) {
    const buf = await toBuffer(data);
    const eocd = buf.length >= 22 ? findEocd(buf) : -1;
    if (eocd < 0) {
      throw new Error("End of data reached (data length = " + buf.length + "). Corrupted zip ?");
    }
    const count = buf.readUInt16LE(eocd + 10);
    const cdSize = buf.readUInt32LE(eocd + 12);
    const cdOffset = buf.readUInt32LE(eocd + 16);
    if (cdOffset + cdSize > eocd) throw new Error('Corrupted zip: central directory is out of range');

    const zip = new JSZip();
    let p = cdOffset;
    for (let i = 0; i < count; i++) {
      if (p + 46 > eocd || buf.readUInt32LE(p) !== CEN_SIG) {
        throw new Error('Corrupted zip: bad central directory entry');
      }
      const method = buf.readUInt16LE(p + 10);
      const compSize = buf.readUInt32LE(p + 20);
      const nameLen = buf.readUInt16LE(p + 28);
      const extraLen = buf.readUInt16LE(p + 30);
      const commentLen = buf.readUInt16LE(p + 32);
      const localOffset = buf.readUInt32LE(p + 42);
      const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
      zip.files[name] = new ZipEntry(buf, name, method, compSize, localOffset);
      p += 46 + nameLen + extraLen + commentLen;
    }
    return zip;
  }
}
