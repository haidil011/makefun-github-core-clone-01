// Packfile v2 writer and reader (plain objects plus OFS/REF deltas).
import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import { oidOf } from './util.mjs';

const TYPE_CODE = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function sha1(buf) {
  return createHash('sha1').update(buf).digest();
}

function u32(value) {
  const buf = Buffer.alloc(4);
  buf.writeUInt32BE(value >>> 0, 0);
  return buf;
}

function entryHeader(type, size) {
  const bytes = [];
  let value = (TYPE_CODE[type] << 4) | (size & 15);
  size >>>= 4;
  while (size > 0) {
    bytes.push(value | 0x80);
    value = size & 0x7f;
    size >>>= 7;
  }
  bytes.push(value);
  return Buffer.from(bytes);
}

/** Build a pack (version 2 All). `objects` is [{type, data}]. */
export function encodePack(objects) {
  const parts = [Buffer.from('PACK', 'ascii'), u32(2), u32(objects.length)];
  for (const object of objects) {
    parts.push(entryHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data, { level: 0 }));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, sha1(body)]);
}

export function applyDelta(base, delta) {
  let p = 0;
  let value = 0;
  let shift = 0;
  for (;;) {
    const byte = delta[p++];
    value += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    if ((byte & 0x80) === 0) break;
  }
  const sourceSize = value;
  value = 0;
  shift = 0;
  for (;;) {
    const byte = delta[p++];
    value += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    if ((byte & 0x80) === 0) break;
  }
  const targetSize = value;
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (p < delta.length) {
    const op = delta[p++];
    if (op & 0x80) {
      let offset = 0;
      let size = 0;
      if (op & 0x01) offset |= delta[p++];
      if (op & 0x02) offset |= delta[p++] << 8;
      if (op & 0x04) offset |= delta[p++] << 16;
      if (op & 0x08) offset |= delta[p++] << 24;
      if (op & 0x10) size |= delta[p++];
      if (op & 0x20) size |= delta[p++] << 8;
      if (op & 0x40) size |= delta[p++] << 16;
      if (size === 0) size = 0x10000;
      if (offset + size > base.length) throw new Error('delta copy out of range');
      if (written + size > targetSize) throw new Error('delta output overflow');
      base.copy(out, written, offset, offset + size);
      written += size;
    } else if (op !== 0) {
      if (p + op > delta.length) throw new Error('delta insert truncated');
      if (written + op > targetSize) throw new Error('delta output overflow');
      delta.copy(out, written, p, p + op);
      p += op;
      written += op;
    } else {
      throw new Error('invalid delta opcode 0');
    }
  }
  if (written !== targetSize) throw new Error('delta output size mismatch');
  return out;
}

export function inflateAt(buf, offset) {
  const view = buf.subarray(offset);
  const result = inflateSync(view, { info: true });
  const consumed = result.engine.bytesWritten;
  if (!consumed || consumed <= 0) throw new Error('zlib stream consumed no bytes');
  return { data: result.buffer, next: offset + consumed };
}

function readHeader(buf, start) {
  if (start >= buf.length) throw new Error('pack entry truncated');
  let byte = buf[start];
  const type = (byte >> 4) & 7;
  let size = byte & 15;
  let shift = 4;
  let p = start + 1;
  while (byte & 0x80) {
    if (p >= buf.length) throw new Error('pack entry header truncated');
    byte = buf[p++];
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    if (shift > 63) throw new Error('pack entry size overflow');
  }
  return { type, size, next: p };
}

function readOfsBase(buf, start) {
  if (start >= buf.length) throw new Error('ofs-delta truncated');
  let byte = buf[start];
  let p = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    if (p >= buf.length) throw new Error('ofs-delta truncated');
    byte = buf[p++];
    value = ((value + 1) * 128) + (byte & 0x7f);
  }
  return { value, next: p };
}

/**
 * Read a pack. `lookup(oid)` resolves a REF_DELTA base that is not in the pack (a thin pack).
 * Returns every object resolved to its real type and id.
 */
export function decodePack(pack, lookup) {
  if (pack.length < 32 || pack.toString('ascii', 0, 4) !== 'PACK') throw new Error('pack has no PACK signature');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const declaredCount = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const trailer = pack.subarray(trailerStart).toString('hex');
  const computed = sha1(pack.subarray(0, trailerStart)).toString('hex');
  if (trailer !== computed) throw new Error('pack checksum mismatch');

  const raw = [];
  const byOffset = new Map();
  let offset = 12;
  for (let index = 0; index < declaredCount; index += 1) {
    const start = offset;
    const header = readHeader(pack, offset);
    offset = header.next;
    const entry = { offset: start, typeCode: header.type, size: header.size, data: null, baseOffset: null, baseOid: null };
    if (header.type === 6) {
      const base = readOfsBase(pack, offset);
      offset = base.next;
      if (base.value <= 0 || base.value > start) throw new Error(`bad ofs-delta base distance at ${start}`);
      entry.baseOffset = start - base.value;
    } else if (header.type === 7) {
      if (offset + 20 > trailerStart) throw new Error('ref-delta base truncated');
      entry.baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (!CODE_TYPE[header.type]) {
      throw new Error(`unknown pack object type ${header.type}`);
    }
    const inflated = inflateAt(pack.subarray(0, trailerStart), offset);
    if (inflated.data.length !== header.size) {
      throw new Error(`pack entry at ${start} inflated ${inflated.data.length} of ${header.size} bytes`);
    }
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(start, entry);
  }
  if (offset !== trailerStart) throw new Error('pack has bytes before its trailer');

  const objects = new Map();
  const entries = [];
  const resolvedByOid = new Map();

  function resolve(entry) {
    if (entry.oid !== undefined) return entry;
    if (entry.typeCode === 6) {
      const base = byOffset.get(entry.baseOffset);
      if (base === undefined) throw new Error('ofs-delta base is not in the pack');
      const baseObject = resolve(base);
      entry.type = baseObject.resolvedType !== undefined ? baseObject.resolvedType : baseObject.type;
      entry.resolved = applyDelta(baseObject.resolved ?? baseObject.data, entry.data);
    } else if (entry.typeCode === 7) {
      const base = resolvedByOid.get(entry.baseOid) ?? lookup?.(entry.baseOid);
      if (base === undefined || base === null) throw new Error('ref-delta base is missing');
      const baseData = base.resolved !== undefined ? base.resolved : base.data;
      const baseType = base.resolvedType !== undefined ? base.resolvedType : base.type;
      entry.type = baseType;
      entry.resolved = applyDelta(baseData, entry.data);
    } else {
      entry.type = CODE_TYPE[entry.typeCode];
      entry.resolved = entry.data;
    }
    entry.oid = oidOf(entry.type, entry.resolved);
    resolvedByOid.set(entry.oid, entry);
    if (!objects.has(entry.oid)) objects.set(entry.oid, { type: entry.type, data: entry.resolved });
    return entry;
  }

  for (const entry of raw) {
    resolve(entry);
    entries.push({ offset: entry.offset, type: entry.type, oid: entry.oid, delta: entry.typeCode === 6 || entry.typeCode === 7 });
  }
  return { version, declaredCount, trailer, computed, objects, entries };
}
