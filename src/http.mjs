// HTTP response and request-body plumbing. Every JSON reply carries an explicit Content-Length.
import { JSON_TYPE } from './util.mjs';

let requestSeq = 0;

export function nextRequestId() {
  requestSeq += 1;
  return `MF-${String(requestSeq).padStart(8, '0')}`;
}

export function sendJson(res, status, body, headers) {
  const text = typeof body === 'string' ? body : `${JSON.stringify(body)}\n`;
  const buf = Buffer.from(text, 'utf8');
  const out = {
    'content-type': JSON_TYPE,
    'content-length': String(buf.length),
    'cache-control': 'no-store',
    'x-github-request-id': nextRequestId(),
  };
  if (headers !== undefined) for (const [name, value] of Object.entries(headers)) out[name.toLowerCase()] = value;
  res.writeHead(status, out);
  res.end(buf);
}

/** A reply whose body and alternating [name, value] header array were built once (the warm read path). */
export function sendPrepared(res, status, prepared) {
  prepared.headers[prepared.idIndex] = nextRequestId();
  res.writeHead(status, prepared.headers);
  res.end(prepared.buf);
}

export function sendBuffer(res, status, contentType, buf, headers) {
  const out = {
    'content-type': contentType,
    'content-length': String(buf.length),
    'cache-control': 'no-cache, max-age=0, must-revalidate',
    pragma: 'no-cache',
    expires: 'Fri, 01 Jan 1980 00:00:00 GMT',
    'x-github-request-id': nextRequestId(),
  };
  if (headers !== undefined) for (const [name, value] of Object.entries(headers)) out[name.toLowerCase()] = value;
  res.writeHead(status, out);
  res.end(buf);
}

export function sendEmpty(res, status) {
  res.writeHead(status, { 'content-length': '0', 'x-github-request-id': nextRequestId() });
  res.end();
}

export async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    chunks.push(chunk);
    size += chunk.length;
    if (size > 64 * 1024 * 1024) throw new Error('request body too large');
  }
  return Buffer.concat(chunks);
}

export function parseJson(buf) {
  if (buf.length === 0) return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(buf.toString('utf8')) };
  } catch {
    return { ok: false, value: null };
  }
}
