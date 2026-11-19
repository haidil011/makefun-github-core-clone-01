// HTTP response and request-body plumbing. Every JSON reply carries an explicit Content-Length.
import { JSON_TYPE } from './util.mjs';

let requestSeq = 0;
const EMPTY = Buffer.alloc(0);
const BODY_LIMIT = 64 * 1024 * 1024;

export function nextRequestId() {
  requestSeq += 1;
  return `MF-${String(requestSeq).padStart(8, '0')}`;
}

function jsonHeaders(buf, headers) {
  const out = ['content-type', JSON_TYPE, 'content-length', String(buf.length), 'x-github-request-id', nextRequestId()];
  if (headers !== undefined) {
    for (const name of Object.keys(headers)) out.push(name.toLowerCase(), headers[name]);
  }
  return out;
}

export function sendJson(res, status, body, headers) {
  const text = typeof body === 'string' ? body : `${JSON.stringify(body)}\n`;
  const buf = Buffer.from(text, 'utf8');
  res.sendDate = false;
  res.writeHead(status, jsonHeaders(buf, headers));
  res.end(buf);
}

/** A reply whose body and header array were built once (the warm read path). */
export function sendPrepared(res, status, prepared) {
  prepared.headers[prepared.idIndex] = nextRequestId();
  res.sendDate = false;
  res.writeHead(status, prepared.headers);
  res.end(prepared.buf);
}

export function sendBuffer(res, status, contentType, buf, headers) {
  res.sendDate = false;
  const out = ['content-type', contentType, 'content-length', String(buf.length)];
  if (headers !== undefined && headers !== null) {
    for (const name of Object.keys(headers)) out.push(name.toLowerCase(), headers[name]);
  }
  res.writeHead(status, out);
  res.end(buf);
}

export function sendEmpty(res, status, headers) {
  const out = ['content-length', '0', 'x-github-request-id', nextRequestId()];
  if (headers !== undefined && headers !== null) {
    for (const name of Object.keys(headers)) out.push(name.toLowerCase(), headers[name]);
  }
  res.sendDate = false;
  res.writeHead(status, out);
  res.end();
}

export async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
    chunks.push(buf);
    size += buf.length;
    if (size > BODY_LIMIT) throw new Error('request body too large');
  }
  if (chunks.length === 0) return EMPTY;
  if (chunks.length === 1) return chunks[0];
  return Buffer.concat(chunks, size);
}

export function parseJson(buf) {
  if (buf.length === 0) return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(buf.toString('utf8')) };
  } catch {
    return { ok: false, value: null };
  }
}
