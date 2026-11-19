// Content writes, reads, tree diffs and three-way merges for one repository.
import { T0 } from './util.mjs';
import {
  buildTreeFromMap,
  delPath,
  findInTree,
  makeForgeCommit,
  parseCommit,
  parseTree,
  peelToCommit,
  putObj,
  putPath,
  resolveRef,
  tipOf,
  walkFiles,
} from './store.mjs';

export function commitJson(repo, oid) {
  const obj = repo.objects.get(oid);
  if (obj === undefined || obj.type !== 'commit') return null;
  const info = parseCommit(obj.data);
  return {
    sha: oid,
    node_id: `C_${oid}`,
    url: `https://makefun.invalid/commits/${oid}`,
    html_url: `https://makefun.invalid/commits/${oid}`,
    commit: {
      author: { name: 'ada iversen', email: 'adaiversen@example.invalid', date: T0 },
      committer: { name: 'ada iversen', email: 'adaiversen@example.invalid', date: T0 },
      message: info.message.replace(/\n+$/, ''),
      tree: { sha: info.tree },
    },
    author: { login: 'adaiversen', id: 1000, type: 'User' },
    committer: { login: 'adaiversen', id: 1000, type: 'User' },
    parents: info.parents.map((parent) => ({ sha: parent })),
  };
}

export function branchTip(repo, branch) {
  return repo.refs.get(`refs/heads/${branch}`) ?? null;
}

/** Write bytes at `path` on `branch`; answer the commit, blob and whether the file existed. */
export function writeFile(repo, branch, path, data, message) {
  const tip = branchTip(repo, branch);
  const treeOid = tip === null ? null : parseCommit(repo.objects.get(tip).data).tree;
  const existing = treeOid === null ? null : findInTree(repo, treeOid, path);
  const blob = putObj(repo, 'blob', data);
  const newTree = putPath(repo, treeOid, path, blob);
  const commit = makeForgeCommit(repo, newTree, tip === null ? [] : [tip], message);
  repo.refs.set(`refs/heads/${branch}`, commit);
  repo.gitVersion = (repo.gitVersion ?? 0) + 1;
  return { commit, blob, tree: newTree, created: existing === null };
}

export function removeFile(repo, branch, path, message) {
  const tip = branchTip(repo, branch);
  if (tip === null) return null;
  const treeOid = parseCommit(repo.objects.get(tip).data).tree;
  const existing = findInTree(repo, treeOid, path);
  if (existing === null) return null;
  let newTree = delPath(repo, treeOid, path);
  if (newTree === '') newTree = putObj(repo, 'tree', Buffer.alloc(0));
  const commit = makeForgeCommit(repo, newTree, [tip], message);
  repo.refs.set(`refs/heads/${branch}`, commit);
  repo.gitVersion = (repo.gitVersion ?? 0) + 1;
  return { commit, blob: existing.oid };
}

export function fileAt(repo, ref, path) {
  const commitOid = resolveRef(repo, ref);
  if (commitOid === null) return null;
  const commit = peelToCommit(repo, commitOid);
  if (commit === null) return null;
  const treeOid = parseCommit(repo.objects.get(commit).data).tree;
  return findInTree(repo, treeOid, path);
}

export function filesAt(repo, commitOid) {
  if (commitOid === null) return new Map();
  const obj = repo.objects.get(commitOid);
  if (obj === undefined || obj.type !== 'commit') return new Map();
  return walkFiles(repo, parseCommit(obj.data).tree);
}

export function listDirectory(repo, ref, path) {
  const hit = fileAt(repo, ref, path);
  if (hit === null) return null;
  const obj = repo.objects.get(hit.oid);
  if (obj === undefined) return null;
  const tree = obj.type === 'blob' ? [hit] : parseTree(obj.data);
  return tree.map((entry) => ({ entry, object: repo.objects.get(entry.oid) }));
}

function lineCount(data) {
  if (data.length === 0) return 0;
  const text = data.toString('utf8');
  return text.endsWith('\n') ? text.split('\n').length - 1 : text.split('\n').length;
}

export function diffCommits(repo, baseCommitOid, headCommitOid) {
  const before = filesAt(repo, baseCommitOid);
  const after = filesAt(repo, headCommitOid);
  const out = [];
  for (const [path, hit] of after) {
    const prev = before.get(path);
    const object = repo.objects.get(hit.oid);
    const additions = object === undefined ? 0 : lineCount(object.data);
    if (prev === undefined) {
      out.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions, sha: hit.oid });
    } else if (prev.oid !== hit.oid) {
      out.push({ filename: path, status: 'modified', additions, deletions: additions, changes: additions * 2, sha: hit.oid });
    }
  }
  for (const [path, hit] of before) {
    if (after.has(path)) continue;
    const object = repo.objects.get(hit.oid);
    const deletions = object === undefined ? 0 : lineCount(object.data);
    out.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions, sha: hit.oid });
  }
  out.sort((a, b) => (a.filename < b.filename ? -1 : a.filename > b.filename ? 1 : 0));
  return out;
}

export function ancestorSet(repo, startOid) {
  const seen = new Set();
  const stack = startOid === null || startOid === undefined ? [] : [startOid];
  while (stack.length) {
    const oid = stack.pop();
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.data).parents) stack.push(parent);
  }
  return seen;
}

export function mergeBase(repo, aOid, bOid) {
  if (aOid === null || bOid === null) return null;
  const ancestorsOfA = ancestorSet(repo, aOid);
  const queue = [bOid];
  const seen = new Set();
  while (queue.length) {
    const oid = queue.shift();
    if (oid === undefined || seen.has(oid)) continue;
    seen.add(oid);
    if (ancestorsOfA.has(oid)) return oid;
    const obj = repo.objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.data).parents) queue.push(parent);
  }
  return null;
}

export function threeWayTree(repo, baseCommit, headCommit, currentCommit) {
  const base = filesAt(repo, baseCommit);
  const head = filesAt(repo, headCommit);
  const current = filesAt(repo, currentCommit);
  const result = new Map(current);
  const same = (left, right) => {
    if (left === undefined && right === undefined) return true;
    if (left === undefined || right === undefined) return false;
    return left.oid === right.oid && (left.mode ?? '100644') === (right.mode ?? '100644');
  };
  const paths = new Set([...base.keys(), ...head.keys()]);
  for (const path of paths) {
    const baseHit = base.get(path);
    const headHit = head.get(path);
    if (same(baseHit, headHit)) continue;
    const currentHit = current.get(path);
    if (same(currentHit, baseHit)) {
      if (headHit === undefined) result.delete(path);
      else result.set(path, headHit);
      continue;
    }
    if (same(currentHit, headHit)) continue;
    return { tree: null, conflict: true };
  }
  return { tree: buildTreeFromMap(repo, result), conflict: false };
}
