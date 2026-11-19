// Small, dependency-free helpers shared by every surface of the forge.
import { createHash } from 'node:crypto';

export const JSON_TYPE = 'application/json; charset=utf-8';
export const ZERO_OID = '0'.repeat(40);
export const T0 = '2026-11-14T00:00:00.000Z';
export const T0_SEC = Math.floor(Date.parse(T0) / 1000);
export const VIEWER = 'adaiversen';
export const FORGE_NAME = 'makefun-forge';
export const FORGE_VERSION = '1.0.0';

export function b64(bytes) {
  return Buffer.from(bytes).toString('base64');
}

/** SHA-1 of a git object: `<type> <size>\0` + bytes. */
export function oidOf(type, data) {
  const header = Buffer.from(`${type} ${data.length}\u0000`, 'utf8');
  return createHash('sha1').update(header).update(data).digest('hex');
}

/** An opaque relay-style global id for a GraphQL node. */
export function globalId(kind, repoId, number) {
  const text = number === undefined ? `${kind}:${repoId}` : `${kind}:${repoId}:${number}`;
  return Buffer.from(text, 'utf8').toString('base64');
}

export function parseGlobalId(value) {
  if (typeof value !== 'string' || value === '') return null;
  let text;
  try {
    text = Buffer.from(value, 'base64').toString('utf8');
  } catch {
    return null;
  }
  if (!text.includes(':')) return null;
  const parts = text.split(':');
  const kind = parts[0];
  const repoId = Number(parts[1]);
  if (!Number.isInteger(repoId)) return null;
  if (Buffer.from(text, 'utf8').toString('base64') !== value) return null;
  if (parts.length === 2) return { kind, repoId, number: null };
  if (parts.length === 3) {
    const number = Number(parts[2]);
    if (!Number.isInteger(number)) return null;
    return { kind, repoId, number };
  }
  return null;
}

export function nodeIdOf(kind, id) {
  return Buffer.from(`${kind}:${id}`).toString('base64');
}

export const FLUSH = Buffer.from('0000', 'ascii');
export const DELIM = Buffer.from('0001', 'ascii');
export const MAX_PKT_PAYLOAD = 65516;

export function pkt(payload) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  if (body.length > MAX_PKT_PAYLOAD) {
    throw new Error(`pkt-line payload ${body.length} exceeds ${MAX_PKT_PAYLOAD}`);
  }
  const head = Buffer.allocUnsafe(4);
  head.write((body.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([head, body]);
}

export function pktLines(items) {
  const parts = [];
  for (const item of items) {
    if (item === 'flush') parts.push(FLUSH);
    else if (item === 'delim') parts.push(DELIM);
    else parts.push(pkt(item));
  }
  return Buffer.concat(parts);
}

export function nextPacket(buf, state) {
  const at = state.at;
  if (buf.length - at < 4) return null;
  const hex = buf.toString('ascii', at, at + 4);
  if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
    const err = new Error('bad pkt-line length');
    err.code = 'pktline';
    throw err;
  }
  const len = Number.parseInt(hex, 16);
  if (len === 0) {
    state.at = at + 4;
    return { kind: 'flush' };
  }
  if (len === 1) {
    state.at = at + 4;
    return { kind: 'delim' };
  }
  if (len === 2) {
    state.at = at + 4;
    return { kind: 'response-end' };
  }
  if (len < 4) throw Object.assign(new Error('bad pkt-line length'), { code: 'pktline' });
  if (buf.length - at < len) return null;
  const payload = buf.subarray(at + 4, at + len);
  state.at = at + len;
  return { kind: 'data', payload };
}

export function decodePackets(buf) {
  const state = { at: 0 };
  const out = [];
  for (;;) {
    const packet = nextPacket(buf, state);
    if (packet === null) break;
    out.push(packet);
  }
  if (state.at !== buf.length) {
    const err = new Error('trailing bytes after pkt-line stream');
    err.code = 'pktline';
    throw err;
  }
  return out;
}

export function pktText(payload) {
  return Buffer.isBuffer(payload) ? payload.toString('utf8') : String(payload);
}

export function line(payload) {
  const text = pktText(payload);
  return text.endsWith('\n') ? text.slice(0, -1) : text;
}

export function jsonText(value) {
  return `${JSON.stringify(value)}\n`;
}

export function b64decodeText(content) {
  return Buffer.from(content.replace(/[\r\n\t ]+/g, ''), 'base64').toString('utf8');
}

export function b64encodeText(text) {
  return Buffer.from(text, 'utf8').toString('base64');
}

export function wrapBase64(text) {
  if (text.length === 0) return '';
  const withNewlines = text.replace(/(.{60})/g, '$1\n');
  return withNewlines.endsWith('\n') ? withNewlines : `${withNewlines}\n`;
}

export function clampInt(value, min, max, fallback) {
  const n = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

export function firstLineDate(text) {
  return T0;
}
