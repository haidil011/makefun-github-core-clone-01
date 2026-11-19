// The forge's in-memory store: repositories, git objects and refs.
import { T0, T0_SEC, VIEWER, globalId, nodeIdOf, oidOf } from './util.mjs';

export const store = { repos: new Map(), nextRepoId: 1, issueRoutes: new Map() };

export const ADA = { name: 'ada iversen', email: 'adaiversen@example.invalid' };

export function repoKey(owner, name) {
  return `${owner}/${name}`;
}

export function findRepo(owner, name) {
  return store.repos.get(repoKey(owner, name));
}

export function createRepo(owner, name, description, isPrivate) {
  const id = store.nextRepoId++;
  const repo = {
    id,
    nodeId: nodeIdOf('Repository', id),
    owner,
    name,
    description: description === undefined || description === null ? '' : String(description),
    private: isPrivate === true,
    defaultBranch: 'main',
    hasIssues: true,
    createdAt: T0,
    updatedAt: T0,
    pushedAt: T0,
    objects: new Map(),
    refs: new Map(),
    issues: [],
    pulls: [],
    labels: [],
    nextIssue: 1,
    nextLabel: 1,
    nextPull: 1,
    nextComment: 1,
    gitVersion: 0,
    _commitInfo: new Map(),
    _key: repoKey(owner, name),
  };
  store.repos.set(repoKey(owner, name), repo);
  return repo;
}

export function removeRepo(repo) {
  store.repos.delete(repoKey(repo.owner, repo.name));
  for (const [path, entry] of store.issueRoutes) {
    if (entry.repo === repo) store.issueRoutes.delete(path);
  }
}
export function repoUrl(repo) {
  return `https://makefun.invalid/repos/${repo.owner}/${repo.name}`;
}

export function userJson(login) {
  const id = login === VIEWER ? 1000 : 1001;
  return {
    login,
    id,
    node_id: nodeIdOf('User', id),
    avatar_url: '',
    url: `https://makefun.invalid/users/${login}`,
    html_url: `https://makefun.invalid/users/${login}`,
    type: 'User',
    site_admin: false,
  };
}

export function repoJson(repo) {
  const base = repoUrl(repo);
  return {
    id: repo.id,
    node_id: repo.nodeId,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    private: repo.private,
    owner: userJson(repo.owner),
    html_url: base,
    description: repo.description,
    fork: false,
    url: base,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.pushedAt,
    homepage: null,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: repo.hasIssues,
    has_projects: false,
    has_downloads: true,
    has_wiki: false,
    has_pages: false,
    forks_count: 0,
    open_issues_count: repo.issues.filter((issue) => issue.state === 'open').length,
    default_branch: repo.defaultBranch,
    clone_url: `${base}.git`,
    git_url: `git://makefun.invalid/${repo.owner}/${repo.name}.git`,
    ssh_url: `git@makefun.invalid:${repo.owner}/${repo.name}.git`,
  };
}

// ---------------------------------------------------------------- trees and commits

export function parseTree(data) {
  const out = [];
  let p = 0;
  while (p < data.length) {
    const sp = data.indexOf(0x20, p);
    if (sp < 0) break;
    const nul = data.indexOf(0x00, sp + 1);
    if (nul < 0 || nul + 21 > data.length) break;
    out.push({
      mode: data.toString('ascii', p, sp),
      name: data.toString('utf8', sp + 1, nul),
      oid: data.toString('hex', nul + 1, nul + 21),
    });
    p = nul + 21;
  }
  return out;
}

export function isDir(entry) {
  return entry.mode === '40000' || entry.mode === '040000';
}

export function buildTree(entries) {
  const sortKey = (entry) => Buffer.from(entry.name + (isDir(entry) ? '/' : ''), 'utf8');
  const sorted = entries.slice().sort((a, b) => Buffer.compare(sortKey(a), sortKey(b)));
  const parts = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\u0000`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export function putObj(repo, type, data) {
  const oid = oidOf(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

function timeOf(identity) {
  const match = /> (\d+)(?: [+-]\d{4})?\s*$/.exec(identity);
  return match === null ? 0 : Number(match[1]);
}

export function parseCommit(data) {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const head = blank < 0 ? text : text.slice(0, blank);
  const message = blank < 0 ? '' : text.slice(blank + 2);
  const info = { tree: '', parents: [], author: '', authorTime: 0, committer: '', committerTime: 0, message };
  for (const headerLine of head.split('\n')) {
    const sp = headerLine.indexOf(' ');
    if (sp < 0) continue;
    const key = headerLine.slice(0, sp);
    const value = headerLine.slice(sp + 1);
    if (key === 'tree') info.tree = value;
    else if (key === 'parent') info.parents.push(value);
    else if (key === 'author') {
      info.author = value;
      info.authorTime = timeOf(value);
    } else if (key === 'committer') {
      info.committer = value;
      info.committerTime = timeOf(value);
    }
  }
  return info;
}

export function makeCommitObject(repo, tree, parents, message, identity, timestamp) {
  const who = identity ?? ADA;
  const time = timestamp ?? T0_SEC;
  const ls = [`tree ${tree}`];
  for (const parent of parents) ls.push(`parent ${parent}`);
  ls.push(`author ${who.name} <${who.email}> ${time} +0000`);
  ls.push(`committer ${who.name} <${who.email}> ${time} +0000`);
  const body = message.endsWith('\n') ? message : `${message}\n`;
  return putObj(repo, 'commit', Buffer.from(`${ls.join('\n')}\n\n${body}`, 'utf8'));
}

export function tipOf(repo, branch) {
  return repo.refs.get(`refs/heads/${branch}`) ?? null;
}

export function findInTree(repo, treeOid, path) {
  if (treeOid === null) return null;
  const parts = path.split('/').filter((part) => part !== '');
  let current = treeOid;
  for (let i = 0; i < parts.length; i += 1) {
    const obj = repo.objects.get(current);
    if (obj === undefined || obj.type !== 'tree') return null;
    let found = null;
    for (const entry of parseTree(obj.data)) {
      if (entry.name === parts[i]) {
        found = entry;
        break;
      }
    }
    if (found === null) return null;
    if (i === parts.length - 1) return { oid: found.oid, mode: found.mode };
    if (!isDir(found)) return null;
    current = found.oid;
  }
  return null;
}

export function putPath(repo, rootOid, path, blobOid) {
  const parts = path.split('/').filter((part) => part !== '');
  const walk = (treeOid, index) => {
    const entries = treeOid === null ? [] : parseTree(repo.objects.get(treeOid).data).slice();
    const name = parts[index];
    const at = entries.findIndex((entry) => entry.name === name);
    if (index === parts.length - 1) {
      if (at >= 0) entries[at] = { mode: '100644', name, oid: blobOid };
      else entries.push({ mode: '100644', name, oid: blobOid });
    } else {
      let child = null;
      if (at >= 0 && isDir(entries[at])) child = entries[at].oid;
      const childOid = walk(child, index + 1);
      if (at >= 0) entries[at] = { mode: '40000', name, oid: childOid };
      else entries.push({ mode: '40000', name, oid: childOid });
    }
    return putObj(repo, 'tree', buildTree(entries));
  };
  return walk(rootOid, 0);
}

export function delPath(repo, rootOid, path) {
  const parts = path.split('/').filter((part) => part !== '');
  const walk = (treeOid, index) => {
    const obj = repo.objects.get(treeOid);
    if (obj === undefined || obj.type !== 'tree') return treeOid;
    const entries = parseTree(obj.data).slice();
    const name = parts[index];
    const at = entries.findIndex((entry) => entry.name === name);
    if (at < 0) return treeOid;
    if (index === parts.length - 1) {
      entries.splice(at, 1);
      if (entries.length === 0) return '';
      return putObj(repo, 'tree', buildTree(entries));
    }
    if (!isDir(entries[at])) return treeOid;
    const next = walk(entries[at].oid, index + 1);
    if (next === '') entries.splice(at, 1);
    else entries[at] = { mode: '40000', name, oid: next };
    if (entries.length === 0) return '';
    return putObj(repo, 'tree', buildTree(entries));
  };
  return walk(rootOid, 0);
}

export function walkFiles(repo, treeOid, prefix, out) {
  const files = out ?? new Map();
  if (treeOid === null || treeOid === '') return files;
  const obj = repo.objects.get(treeOid);
  if (obj === undefined || obj.type !== 'tree') return files;
  for (const entry of parseTree(obj.data)) {
    const path = prefix === undefined || prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (isDir(entry)) walkFiles(repo, entry.oid, path, files);
    else files.set(path, { oid: entry.oid, mode: entry.mode });
  }
  return files;
}

export function buildTreeFromMap(repo, files) {
  const root = { files: new Map(), dirs: new Map() };
  for (const [path, hit] of files) {
    const segments = path.split('/').filter((part) => part !== '');
    if (segments.length === 0) continue;
    let node = root;
    for (let i = 0; i < segments.length - 1; i += 1) {
      if (!node.dirs.has(segments[i])) node.dirs.set(segments[i], { files: new Map(), dirs: new Map() });
      node = node.dirs.get(segments[i]);
    }
    node.files.set(segments[segments.length - 1], hit);
  }
  const build = (node) => {
    const entries = [];
    for (const [name, hit] of node.files) entries.push({ mode: hit.mode ?? '100644', name, oid: hit.oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    return putObj(repo, 'tree', buildTree(entries));
  };
  return build(root);
}

export function commitInfo(repo, oid) {
  if (oid === null || oid === undefined) return null;
  const cached = repo._commitInfo.get(oid);
  if (cached !== undefined) return cached;
  const obj = repo.objects.get(oid);
  if (obj === undefined || obj.type !== 'commit') return null;
  const info = parseCommit(obj.data);
  if (repo._commitInfo.size > 4096) repo._commitInfo.clear();
  repo._commitInfo.set(oid, info);
  return info;
}

export function parentsOf(repo, oid) {
  const info = commitInfo(repo, oid);
  return info === null ? EMPTY_PARENTS : info.parents;
}

const EMPTY_PARENTS = [];

export function isAncestor(repo, ancestor, tip) {
  if (ancestor === tip) return true;
  const seen = new Set();
  const stack = [tip];
  while (stack.length) {
    const oid = stack.pop();
    if (oid === undefined) continue;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    for (const parent of parentsOf(repo, oid)) stack.push(parent);
  }
  return false;
}

export function commitChain(repo, startOid, limit) {
  const out = [];
  const seen = new Set();
  let current = startOid;
  while (current !== null && current !== undefined && !seen.has(current) && out.length < limit) {
    const obj = repo.objects.get(current);
    if (obj === undefined || obj.type !== 'commit') break;
    out.push({ oid: current, data: obj.data });
    seen.add(current);
    current = parseCommit(obj.data).parents[0] ?? null;
  }
  return out;
}

export function resolveRef(repo, name) {
  if (name === null || name === undefined || name === '') return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
  const heads = `refs/heads/${name}`;
  if (repo.refs.has(heads)) return repo.refs.get(heads);
  const tags = `refs/tags/${name}`;
  if (repo.refs.has(tags)) return repo.refs.get(tags);
  if (repo.refs.has(name)) return repo.refs.get(name);
  if (repo.objects.has(name)) return name;
  return null;
}

export function peelToCommit(repo, oid) {
  let current = oid;
  const seen = new Set();
  while (current !== null && current !== undefined) {
    if (seen.has(current)) return null;
    seen.add(current);
    const obj = repo.objects.get(current);
    if (obj === undefined) return null;
    if (obj.type === 'commit') return current;
    if (obj.type === 'tag') {
      const match = /^object ([0-9a-f]{40})$/m.exec(obj.data.toString('utf8'));
      if (match === null) return null;
      current = match[1];
      continue;
    }
    return null;
  }
  return null;
}

export function makeForgeCommit(repo, tree, parents, message) {
  return makeCommitObject(repo, tree, parents, message, ADA, T0_SEC);
}
