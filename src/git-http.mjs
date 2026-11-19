// Git smart HTTP: upload-pack protocol v2 (v0 advertisement too) and receive-pack v0.
import { deflateSync } from 'node:zlib';
import { FORGE_NAME, FORGE_VERSION, FLUSH, ZERO_OID, decodePackets, line, pkt, pktLines } from './util.mjs';
import { commitInfo, isAncestor, parentsOf, parseTree, tipOf } from './store.mjs';
import { decodePack, encodePack } from './pack.mjs';

const AGENT = `${FORGE_NAME}/${FORGE_VERSION}`;
const UPLOAD_CAPS = `multi_ack_detailed thin-pack side-band-64k ofs-delta shallow deepen-since deepen-not no-progress include-tag symref=HEAD:refs/heads/main agent=${AGENT}`;
const RECEIVE_CAPS = `report-status side-band-64k delete-refs ofs-delta quiet agent=${AGENT}`;

export function refList(repo) {
  const out = [];
  for (const [name, oid] of repo.refs) out.push({ name, oid });
  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return out;
}

function annotatedPeel(repo, oid) {
  const obj = repo.objects.get(oid);
  if (obj === undefined || obj.type !== 'tag') return null;
  const match = /^object ([0-9a-f]{40})$/m.exec(obj.data.toString('utf8'));
  return match === null ? null : match[1];
}

function headOid(repo) {
  return tipOf(repo, repo.defaultBranch);
}

// ---------------------------------------------------------------- advertisements

export function uploadAdvertisement(repo, wantV2) {
  if (wantV2) return v2Advertisement();
  const version = repo.gitVersion ?? 0;
  const cached = repo._uploadAdv;
  if (cached !== undefined && cached.version === version) return cached.buffer;
  const buffer = buildUploadAdvertisementV0(repo);
  repo._uploadAdv = { version, buffer };
  return buffer;
}

function v2Advertisement() {
  if (v2AdvertisementCache !== null) return v2AdvertisementCache;
  v2AdvertisementCache = Buffer.concat([
    pkt('# service=git-upload-pack\n'),
    FLUSH,
    pkt('version 2\n'),
    pkt(`agent=${AGENT}\n`),
    pkt('ls-refs=unborn\n'),
    pkt('fetch=shallow wait-for-done\n'),
    pkt('object-format=sha1\n'),
    FLUSH,
  ]);
  return v2AdvertisementCache;
}

let v2AdvertisementCache = null;

function buildUploadAdvertisementV0(repo) {
  const parts = [pkt('# service=git-upload-pack\n'), FLUSH];
  const refs = refList(repo);
  const head = headOid(repo);
  if (refs.length === 0 && head === null) {
    parts.push(pkt(`${ZERO_OID} capabilities^{}\u0000${UPLOAD_CAPS}\n`));
    parts.push(FLUSH);
    return Buffer.concat(parts);
  }
  let first = true;
  if (head !== null) {
    parts.push(pkt(`${head} HEAD\u0000${UPLOAD_CAPS}\n`));
    first = false;
  }
  for (const ref of refs) {
    parts.push(pkt(`${ref.oid} ${ref.name}${first ? `\u0000${UPLOAD_CAPS}` : ''}\n`));
    first = false;
    const peeled = annotatedPeel(repo, ref.oid);
    if (peeled !== null && ref.name.startsWith('refs/tags/')) parts.push(pkt(`${peeled} ${ref.name}^{}\n`));
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

export function receiveAdvertisement(repo) {
  const version = repo.gitVersion ?? 0;
  const cached = repo._receiveAdv;
  if (cached !== undefined && cached.version === version) return cached.buffer;
  const refs = refList(repo);
  const parts = [pkt('# service=git-receive-pack\n'), FLUSH];
  if (refs.length === 0) {
    parts.push(pkt(`${ZERO_OID} capabilities^{}\u0000${RECEIVE_CAPS}\n`));
  } else {
    refs.forEach((ref, index) => {
      parts.push(pkt(`${ref.oid} ${ref.name}${index === 0 ? `\u0000${RECEIVE_CAPS}` : ''}\n`));
    });
  }
  parts.push(FLUSH);
  const buffer = Buffer.concat(parts);
  repo._receiveAdv = { version, buffer };
  return buffer;
}

// ---------------------------------------------------------------- file_upload-pack

export function lsRefs(repo, body) {
  const packets = decodePackets(body);
  const args = [];
  let afterDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      afterDelim = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const text = line(packet.payload);
    if (!afterDelim) continue;
    args.push(text);
  }
  const peel = args.includes('peel');
  const symrefs = args.includes('symrefs');
  const unborn = args.includes('unborn');
  const prefixes = args.filter((arg) => arg.startsWith('ref-prefix ')).map((arg) => arg.slice('ref-prefix '.length));
  const version = repo.gitVersion ?? 0;
  const cacheKey = `${version}|${peel}|${symrefs}|${unborn}|${prefixes.slice().sort().join('\u0000')}`;
  const cache = repo._lsRefsCache ?? new Map();
  repo._lsRefsCache = cache;
  const cached = cache.get(cacheKey);
  if (cached !== undefined) return cached;
  const keep = (name) => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const lines = [];
  const head = tipOf(repo, repo.defaultBranch);
  if (head === null) {
    if (unborn && keep('HEAD')) lines.push(`unborn HEAD symref-target:refs/heads/${repo.defaultBranch}\n`);
  } else if (keep('HEAD')) {
    lines.push(`${head} HEAD${symrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : ''}\n`);
  }

  for (const ref of refList(repo)) {
    if (!keep(ref.name)) continue;
    let text = `${ref.oid} ${ref.name}`;
    if (peel && ref.name.startsWith('refs/tags/')) {
      const peeled = annotatedPeel(repo, ref.oid);
      if (peeled !== null) text += ` peeled:${peeled}`;
    }
    lines.push(`${text}\n`);
  }
  const buffer = pktLines([...lines, 'flush']);
  cache.set(cacheKey, buffer);
  if (cache.size > 64) cache.delete(cache.keys().next().value);
  return buffer;
}

function addTree(repo, treeOid, target, exclude) {
  if (treeOid === null || treeOid === undefined) return;
  if (target.has(treeOid)) return;
  if (exclude !== null && exclude.has(treeOid)) return;
  const obj = repo.objects.get(treeOid);
  if (obj === undefined || obj.type !== 'tree') return;
  target.add(treeOid);
  for (const entry of parseTree(obj.data)) {
    if (entry.mode === '40000' || entry.mode === '040000') addTree(repo, entry.oid, target, exclude);
    else if (exclude === null || !exclude.has(entry.oid)) target.add(entry.oid);
  }
}

/** Every object a client holding these commits already has (walk stops at the client's shallow commits). */
export function haveObjects(repo, haves, shallow) {
  const closed = new Set();
  const shallowSet = new Set(shallow ?? []);
  const stack = [...(haves ?? [])];
  while (stack.length) {
    const oid = stack.pop();
    if (oid === undefined || closed.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (obj === undefined) continue;
    if (obj.type === 'commit') {
      closed.add(oid);
      const info = commitInfo(repo, oid);
      if (info === null) continue;
      addTree(repo, info.tree, closed, null);
      if (shallowSet.has(oid)) continue;
      for (const parent of info.parents) stack.push(parent);
    } else if (obj.type === 'tag') {
      closed.add(oid);
      const target = /^object ([0-9a-f]{40})$/m.exec(obj.data.toString('utf8'));
      if (target !== null) stack.push(target[1]);
    }
  }
  return closed;
}

function commitParents(repo, oid) {
  return parentsOf(repo, oid);
}

export function collectFetch(repo, wants, haves, shallow, depth) {
  const haveClosed = haveObjects(repo, haves, shallow);
  const includeCommits = new Set();
  const send = new Set();
  const queue = [];
  for (const want of wants) queue.push({ oid: want, level: 1 });

  while (queue.length) {
    const item = queue.shift();
    if (item === undefined) break;
    const { oid, level } = item;
    const obj = repo.objects.get(oid);
    if (obj === undefined) continue;
    if (obj.type === 'tag') {
      if (!haveClosed.has(oid)) send.add(oid);
      const target = /^object ([0-9a-f]{40})$/m.exec(obj.data.toString('utf8'));
      if (target !== null) queue.push({ oid: target[1], level });
      continue;
    }
    if (obj.type !== 'commit') {
      if (!haveClosed.has(oid)) send.add(oid);
      continue;
    }
    if (includeCommits.has(oid)) continue;
    if (depth !== null && level > depth) continue;
    const info = commitInfo(repo, oid);
    if (info === null) continue;
    includeCommits.add(oid);
    if (!haveClosed.has(oid)) send.add(oid);
    addTree(repo, info.tree, send, haveClosed);
    if (depth === null || level < depth) {
      for (const parent of info.parents) queue.push({ oid: parent, level: level + 1 });
    }
  }

  const oldShallow = new Set(shallow ?? []);
  const boundary = new Set();
  for (const oid of includeCommits) {
    for (const parent of commitParents(repo, oid)) {
      if (!includeCommits.has(parent) && !haveClosed.has(parent)) boundary.add(oid);
    }
  }
  const shallowLines = [];
  const unshallowLines = [];
  for (const oid of boundary) if (!oldShallow.has(oid)) shallowLines.push(oid);
  for (const oid of oldShallow) if (includeCommits.has(oid) && !boundary.has(oid)) unshallowLines.push(oid);
  shallowLines.sort();
  unshallowLines.sort();
  return { objects: send, shallowLines, unshallowLines };
}

export function fetchResponse(repo, body) {
  const packets = decodePackets(body);
  const args = [];
  let afterDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      afterDelim = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    if (afterDelim) args.push(line(packet.payload));
  }
  const wants = args.filter((arg) => arg.startsWith('want ')).map((arg) => arg.slice(5).trim());
  const haves = args.filter((arg) => arg.startsWith('have ')).map((arg) => arg.slice(5).trim());
  const shallow = args.filter((arg) => arg.startsWith('shallow ')).map((arg) => arg.slice(8).trim());
  let depth = null;
  const deepen = args.find((arg) => arg.startsWith('deepen '));
  if (deepen !== undefined) {
    const value = Number.parseInt(deepen.slice(7), 10);
    if (Number.isFinite(value) && value > 0) depth = value;
  }
  const version = repo.gitVersion ?? 0;
  const fetchKey = `${version}|${depth ?? ''}|${wants.slice().sort().join(',')}|${haves.slice().sort().join(',')}|${shallow.slice().sort().join(',')}`;
  const cache = repo._fetchCache ?? new Map();
  repo._fetchCache = cache;
  const cached = cache.get(fetchKey);
  if (cached !== undefined) return cached;

  const parts = [pkt('acknowledgments\n'), pkt('NAK\n'), FLUSH];
  if (wants.length === 0) {
    parts.push(FLUSH);
    return Buffer.concat(parts);
  }
  const found = collectFetch(repo, wants, haves, shallow, depth);
  if (found.shallowLines.length > 0 || found.unshallowLines.length > 0) {
    parts.push(pkt('shallow-info\n'));
    for (const oid of found.shallowLines) parts.push(pkt(`shallow ${oid}\n`));
    for (const oid of found.unshallowLines) parts.push(pkt(`unshallow ${oid}\n`));
    parts.push(FLUSH);
  }
  const ordered = [...found.objects].sort();
  const objects = ordered.map((oid) => repo.objects.get(oid)).filter((obj) => obj !== undefined);
  if (objects.length > 0) {
    const pack = encodePack(objects);
    parts.push(pkt('packfile\n'));
    for (let at = 0; at < pack.length; at += 65000) {
      parts.push(pkt(Buffer.concat([Buffer.from([1]), pack.subarray(at, at + 65000)])));
    }
    parts.push(FLUSH);
  }
  parts.push(FLUSH);
  const buffer = Buffer.concat(parts);
  cache.set(fetchKey, buffer);
  if (cache.size > 32) cache.delete(cache.keys().next().value);
  return buffer;
}

// ---------------------------------------------------------------- receive-pack

function parseReceiveCommands(body) {
  const commands = [];
  let caps = '';
  let p = 0;
  while (p + 4 <= body.length) {
    const hex = body.toString('ascii', p, p + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Error('bad push command pkt-line');
    const len = Number.parseInt(hex, 16);
    p += 4;
    if (len === 0) break;
    if (len < 4 || p + len - 4 > body.length) throw new Error('truncated push command');
    const payload = body.subarray(p, p + len - 4).toString('utf8');
    p += len - 4;
    let text = payload.replace(/\n$/, '');
    if (commands.length === 0 && caps === '') {
      const nul = text.indexOf('\u0000');
      if (nul >= 0) {
        caps = text.slice(nul + 1).trim();
        text = text.slice(0, nul);
      }
    }
    const firstSpace = text.indexOf(' ');
    const secondSpace = firstSpace < 0 ? -1 : text.indexOf(' ', firstSpace + 1);
    if (secondSpace < 0) throw new Error('malformed push command');
    commands.push({
      oldOid: text.slice(0, firstSpace).trim(),
      newOid: text.slice(firstSpace + 1, secondSpace).trim(),
      ref: text.slice(secondSpace + 1).trim(),
    });
  }
  return { commands, caps, packStart: p };
}

export function receiveResponse(repo, body) {
  let commands = [];
  let caps = '';
  let packStart = 0;
  try {
    const parsed = parseReceiveCommands(body);
    commands = parsed.commands;
    caps = parsed.caps;
    packStart = parsed.packStart;
  } catch (err) {
    return receiveReportFromLines(caps, false, `error ${err instanceof Error ? err.message : String(err)}`, []);
  }

  let unpackOk = true;
  let unpackDetail = 'ok';
  const packData = body.subarray(packStart);
  if (packData.length > 0) {
    if (packData.toString('ascii', 0, 4) !== 'PACK') {
      unpackOk = false;
      unpackDetail = 'error bad pack signature';
    } else {
      try {
        const decoded = decodePack(packData, (oid) => repo.objects.get(oid));
        for (const [oid, object] of decoded.objects) {
          if (!repo.objects.has(oid)) repo.objects.set(oid, object);
        }
      } catch (err) {
        unpackOk = false;
        unpackDetail = `error ${err instanceof Error ? err.message : String(err)}`;
      }
    }
  } else if (commands.some((command) => command.newOid !== ZERO_OID)) {
    unpackOk = false;
    unpackDetail = 'error no pack for a ref update';
  }

  const report = [];
  if (unpackOk) {
    for (const command of commands) {
      if (!command.ref.startsWith('refs/heads/') && !command.ref.startsWith('refs/tags/')) continue;
      const current = repo.refs.get(command.ref) ?? ZERO_OID;
      if (command.oldOid !== current) {
        report.push(`ng ${command.ref} stale info`);
        continue;
      }
      if (command.newOid === ZERO_OID) {
        repo.refs.delete(command.ref);
        report.push(`ok ${command.ref}`);
        continue;
      }
      if (!repo.objects.has(command.newOid)) {
        report.push(`ng ${command.ref} missing necessary objects`);
        continue;
      }
      if (command.ref.startsWith('refs/heads/') && current !== ZERO_OID && !isAncestor(repo, current, command.newOid)) {
        report.push(`ng ${command.ref} non-fast-forward`);
        continue;
      }
      repo.refs.set(command.ref, command.newOid);
      report.push(`ok ${command.ref}`);
    }
    if (report.some((reportLine) => reportLine.startsWith('ok '))) {
      repo.updatedAt = '2026-11-14T00:00:00.000Z';
      repo.pushedAt = '2026-11-14T00:00:00.000Z';
      repo.gitVersion = (repo.gitVersion ?? 0) + 1;
    }
  }

  return receiveReportFromLines(caps, unpackOk, unpackDetail, report);
}

function receiveReportFromLines(caps, unpackOk, unpackDetail, report) {
  const inner = [pkt(`unpack ${unpackOk ? 'ok' : unpackDetail}\n`)];
  for (const reportLine of report) inner.push(pkt(`${reportLine}\n`));
  inner.push(FLUSH);
  const stream = Buffer.concat(inner);
  if (!caps.split(' ').includes('side-band-64k')) return stream;
  const parts = [];
  for (let at = 0; at < stream.length; at += 65000) {
    parts.push(pkt(Buffer.concat([Buffer.from([1]), stream.subarray(at, at + 65000)])));
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}
