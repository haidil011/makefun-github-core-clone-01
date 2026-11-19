// Pull requests: creation, serialization, changed files and merge.
import { T0, VIEWER, nodeIdOf } from './util.mjs';
import { makeForgeCommit, parseCommit, repoUrl, tipOf, userJson } from './store.mjs';
import { diffCommits, mergeBase, threeWayTree } from './contents.mjs';

export function findPullRequest(repo, number) {
  return repo.pulls.find((pull) => pull.number === number) ?? null;
}

export function findOpenPull(repo, head, base) {
  return repo.pulls.find((pull) => pull.state === 'open' && pull.headRef === head && pull.baseRef === base) ?? null;
}

export function normalizeBranchName(value) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  const colon = trimmed.indexOf(':');
  return colon >= 0 ? trimmed.slice(colon + 1) : trimmed;
}

export function pullShas(repo, pull) {
  const headTip = tipOf(repo, pull.headRef);
  const baseTip = tipOf(repo, pull.baseRef);
  return { headSha: headTip ?? pull.headSha, baseSha: baseTip ?? pull.baseSha };
}

export function pullJson(repo, pull) {
  const { headSha, baseSha } = pullShas(repo, pull);
  const base = `${repoUrl(repo)}/pulls/${pull.number}`;
  return {
    id: pull.id,
    node_id: nodeIdOf('PullRequest', pull.id),
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    user: userJson(pull.user ?? VIEWER),
    head: {
      label: `${repo.owner}:${pull.headRef}`,
      ref: pull.headRef,
      sha: headSha,
      repo: repoJsonRef(repo),
    },
    base: {
      label: `${repo.owner}:${pull.baseRef}`,
      ref: pull.baseRef,
      sha: baseSha,
      repo: repoJsonRef(repo),
    },
    merged: pull.merged === true,
    mergeable: pullConflict(repo, pull) ? false : true,
    merge_commit_sha: pull.mergeCommitSha ?? null,
    merged_at: pull.mergedAt ?? null,
    draft: false,
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.closedAt ?? null,
    url: base,
    html_url: base,
    commits: 1,
    additions: 0,
    deletions: 0,
    changed_files: 0,
  };
}

function repoJsonRef(repo) {
  return {
    id: repo.id,
    node_id: repo.nodeId,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    private: repo.private,
    owner: userJson(repo.owner),
    html_url: repoUrl(repo),
    default_branch: repo.defaultBranch,
  };
}

export function pullConflict(repo, pull) {
  const baseTip = tipOf(repo, pull.baseRef);
  const headTip = tipOf(repo, pull.headRef);
  if (baseTip === null || headTip === null) return true;
  const base = mergeBase(repo, baseTip, headTip);
  if (base === null) return true;
  return threeWayTree(repo, base, headTip, baseTip).conflict;
}

export function createPullRequest(repo, input) {
  const headRef = normalizeBranchName(input.head);
  const baseRef = normalizeBranchName(input.base) || repo.defaultBranch;
  if (headRef === '') return { error: { status: 422, message: 'Validation Failed', detail: 'head is required' } };
  const headSha = tipOf(repo, headRef);
  const baseSha = tipOf(repo, baseRef);
  if (headSha === null) return { error: { status: 422, message: 'Validation Failed', detail: `head branch ${headRef} does not exist` } };
  if (baseSha === null) return { error: { status: 422, message: 'Validation Failed', detail: `base branch ${baseRef} does not exist` } };
  const existing = findOpenPull(repo, headRef, baseRef);
  if (existing !== null) return { error: { status: 422, message: 'Validation Failed', detail: `A pull request already exists for ${repo.owner}:${headRef}` }, pull: existing };
  const number = repo.nextPull++;
  const pull = {
    id: repo.id * 100_000 + number,
    number,
    title: input.title === undefined || input.title === null ? '' : String(input.title),
    body: input.body === undefined || input.body === null ? '' : String(input.body),
    state: 'open',
    merged: false,
    mergedAt: null,
    closedAt: null,
    mergeCommitSha: null,
    headRef,
    baseRef,
    user: input.user ?? VIEWER,
    createdAt: T0,
    updatedAt: T0,
  };
  repo.pulls.push(pull);
  return { pull };
}

export function mergePullRequest(repo, pull, method) {
  const baseTip = tipOf(repo, pull.baseRef);
  const headTip = tipOf(repo, pull.headRef);
  if (baseTip === null || headTip === null) return { error: { status: 405, message: 'Pull Request is not mergeable' } };
  if (pull.merged === true) {
    return { sha: pull.mergeCommitSha, mergeMethod: method ?? 'merge', already: true };
  }
  if (baseTip === headTip) return { error: { status: 405, message: 'Pull Request is not mergeable' } };
  const base = mergeBase(repo, baseTip, headTip);
  if (base === null) return { error: { status: 405, message: 'Pull Request is not mergeable' } };
  const merged = threeWayTree(repo, base, headTip, baseTip);
  if (merged.conflict !== false) return { error: { status: 405, message: 'Pull Request is not mergeable' } };
  const chosen = method ?? 'merge';
  const message = chosen === 'squash'
    ? `${pull.title} (#${pull.number})\n\n${pull.body === '' ? '' : `${pull.body}\n\n`}`
    : `Merge pull request #${pull.number} from ${repo.owner}/${pull.headRef}\n\n${pull.title}\n`;
  const parents = chosen === 'merge' && headTip !== baseTip ? [baseTip, headTip] : [baseTip];
  const commit = makeForgeCommit(repo, merged.tree, parents, message);
  repo.refs.set(`refs/heads/${pull.baseRef}`, commit);
  repo.gitVersion = (repo.gitVersion ?? 0) + 1;
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = T0;
  pull.closedAt = T0;
  pull.mergeCommitSha = commit;
  pull.updatedAt = T0;
  repo.updatedAt = T0;
  repo.pushedAt = T0;
  return { sha: commit, mergeMethod: chosen };
}

export function pullFiles(repo, pull) {
  const baseTip = tipOf(repo, pull.baseRef);
  const headTip = tipOf(repo, pull.headRef);
  if (baseTip === null || headTip === null) return [];
  const base = mergeBase(repo, baseTip, headTip);
  if (base === null) return [];
  return diffCommits(repo, base, headTip);
}
