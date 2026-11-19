// The GitHub-compatible REST v3 surface under /api/v3.
import { clampInt } from './util.mjs';
import { sendJson, sendEmpty, readBody, parseJson, sendPrepared } from './http.mjs';
import { createRepo, findRepo, removeRepo, repoJson, repoUrl, store, userJson, peelToCommit, resolveRef, tipOf, commitChain, parseCommit, parseTree } from './store.mjs';
import { VIEWER, T0 } from './util.mjs';
import {
  commentJson,
  createIssue,
  createLabel,
  findIssue,
  findIssueOrPull,
  findLabelByName,
  findPull,
  issueJson,
  issueResponse,
  bumpIssue,
  labelJson,
} from './issues.mjs';
import { branchTip, commitJson, diffCommits, fileAt, filesAt, listDirectory, removeFile, writeFile } from './contents.mjs';
import { createPullRequest, mergePullRequest, pullFiles, pullJson } from './pulls.mjs';

function fail(res, status, message, extra) {
  sendJson(res, status, { message, ...(extra ?? {}) });
}

function repoOr404(res, owner, name) {
  if (owner !== VIEWER) {
    fail(res, 404, 'Not Found');
    return null;
  }
  const repo = findRepo(owner, name);
  if (repo === undefined) {
    fail(res, 404, 'Not Found');
    return null;
  }
  return repo;
}

function pageOf(rows, query) {
  const perPage = clampInt(query.get('per_page'), 1, 100, 30);
  const page = clampInt(query.get('page'), 1, 1_000_000, 1);
  const start = (page - 1) * perPage;
  return { perPage, page, items: rows.slice(start, start + perPage), total: rows.length };
}

function originOf(req) {
  const host = req.headers.host ?? '127.0.0.1';
  return `http://${host}`;
}

function linkHeader(origin, req, pathname, query, page, perPage, total) {
  if (page * perPage >= total) return undefined;
  const params = new URLSearchParams();
  for (const [name, value] of query) if (name !== 'page' && name !== 'per_page') params.set(name, value);
  params.set('per_page', String(perPage));
  params.set('page', String(page + 1));
  return { link: `<${origin}${pathname}?${params.toString()}>; rel="next"` };
}

export async function handleRest(req, res, url) {
  const method = req.method ?? 'GET';
  const pathname = url.pathname;
  const raw = pathname.replace(/^\/api\/v3\b/, '');
  const segments = raw.split('/').filter((part) => part !== '').map((part) => decodeURIComponent(part));
  const first = segments[0] ?? '';

  let body = {};
  if (method !== 'GET' && method !== 'HEAD') {
    const buf = await readBody(req);
    if (buf.length > 0) {
      const parsed = parseJson(buf);
      if (parsed.ok !== true) {
        fail(res, 400, 'Problems parsing JSON');
        return;
      }
      body = parsed.value;
    }
  }

  if (segments.length === 0 || (segments.length === 1 && first === '')) {
    if (method !== 'GET') return fail(res, 404, 'Not Found');
    sendJson(res, 200, {
      current_user_url: '/api/v3/user',
      current_user_authorizations_html_url: '/api/v3/user',
      authorizations_url: '/api/v3/user/authorizations',
      repositories_url: '/api/v3/user/repos',
      user_url: '/api/v3/user',
    }, { 'x-oauth-scopes': 'repo, read:org', 'x-github-media-type': 'github.v3; format=json' });
    return;
  }
  if (first === 'meta' && segments.length === 1) {
    if (method !== 'GET') return fail(res, 404, 'Not Found');
    sendJson(res, 200, { installed_version: '1.0.0', verifiable_password_authentication: false });
    return;
  }
  if (first === 'user' && segments.length === 1) {
    if (method !== 'GET') return fail(res, 404, 'Not Found');
    sendJson(res, 200, { ...userJson(VIEWER), name: 'Ada Iversen', email: null, public_repos: 0, followers: 0, following: 0 });
    return;
  }
  if (first === 'user' && segments[1] === 'repos') {
    if (method === 'GET') {
      const query = url.searchParams;
      const rows = [...store.repos.values()].filter((repo) => repo.owner === VIEWER).sort((a, b) => a.id - b.id);
      const { perPage, page, items, total } = pageOf(rows, query);
      const headers = linkHeader(originOf(req), req, pathname, query, page, perPage, total);
      sendJson(res, 200, items.map(repoJson), headers);
      return;
    }
    if (method === 'POST') {
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      if (name === '') return fail(res, 422, 'Repository creation failed.', { errors: [{ resource: 'Repository', field: 'name', message: 'name is required' }] });
      if (findRepo(VIEWER, name) !== undefined) {
        return fail(res, 422, `Repository named '${name}' already exists`);
      }
      const repo = createRepo(VIEWER, name, body.description, body.private === true);
      sendJson(res, 201, repoJson(repo));
      return;
    }
    return fail(res, 404, 'Not Found');
  }
  if (first === 'repos' && segments.length >= 3) {
    const repo = repoOr404(res, segments[1], segments[2]);
    if (repo === null) return;
    await handleRepo(req, res, url, repo, segments.slice(3), body);
    return;
  }
  fail(res, 404, 'Not Found');
}

function refJson(repo, name, oid) {
  const object = repo.objects.get(oid);
  return {
    ref: name,
    node_id: Buffer.from(`Ref:${name}:${oid}`).toString('base64'),
    url: `${repoUrl(repo)}/git/${name}`,
    object: { sha: oid, type: object?.type ?? 'commit', url: `${repoUrl(repo)}/git/commits/${oid}` },
  };
}

async function handleRepo(req, res, url, repo, rest, body) {
  const method = req.method ?? 'GET';
  const query = url.searchParams;

  if (rest.length === 0) {
    if (method === 'GET') return sendJson(res, 200, repoJson(repo));
    if (method === 'PATCH') {
      if (typeof body.description === 'string') repo.description = body.description;
      if (typeof body.private === 'boolean') repo.private = body.private;
      if (typeof body.has_issues === 'boolean') repo.hasIssues = body.has_issues;
      repo.updatedAt = T0;
      return sendJson(res, 200, repoJson(repo));
    }
    if (method === 'DELETE') {
      removeRepo(repo);
      return sendEmpty(res, 204);
    }
    return fail(res, 404, 'Not Found');
  }

  if (rest[0] === 'git' && rest[1] === 'refs') {
    const refName = rest.length <= 2 ? '' : `refs/${rest.slice(2).join('/')}`;
    if (method === 'GET' && refName === '') {
      const rows = [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([name, oid]) => refJson(repo, name, oid));
      return sendJson(res, 200, rows);
    }
    if (method === 'GET') {
      const oid = repo.refs.get(refName);
      if (oid === undefined) return fail(res, 404, 'Not Found');
      return sendJson(res, 200, refJson(repo, refName, oid));
    }
    if (method === 'POST') {
      let name = typeof body.ref === 'string' ? body.ref : '';
      if (!name.startsWith('refs/')) name = `refs/${name}`;
      const sha = typeof body.sha === 'string' ? body.sha : '';
      if (!name.startsWith('refs/heads/') && !name.startsWith('refs/tags/')) return fail(res, 422, 'Reference name is invalid');
      if (repo.refs.has(name)) return fail(res, 422, 'Reference already exists');
      if (repo.objects.get(sha) === undefined) return fail(res, 422, 'Object does not exist');
      repo.refs.set(name, sha);
      repo.updatedAt = T0;
      return sendJson(res, 201, refJson(repo, name, sha));
    }
    return fail(res, 404, 'Not Found');
  }

  if (rest[0] === 'branches') {
    if (rest.length === 1) {
      const rows = [...repo.refs.entries()]
        .filter(([name]) => name.startsWith('refs/heads/'))
        .sort((a, b) => (a[0] < b[0] ? -1 : 1))
        .map(([name, oid]) => ({ name: name.slice('refs/heads/'.length), commit: { sha: oid, url: `${repoUrl(repo)}/commits/${oid}` } }));
      return sendJson(res, 200, rows);
    }
    const branch = rest.slice(1).join('/');
    const oid = repo.refs.get(`refs/heads/${branch}`);
    if (oid === undefined) return fail(res, 404, 'Branch not found');
    return sendJson(res, 200, { name: branch, commit: { sha: oid }, protected: false });
  }

  if (rest[0] === 'commits') {
    if (rest.length >= 2) {
      const commit = commitJson(repo, rest[1]);
      if (commit === null) return fail(res, 404, 'Not Found');
      return sendJson(res, 200, commit);
    }
    const wanted = query.get('sha') ?? repo.defaultBranch;
    const start = resolveRef(repo, wanted);
    if (start === null) return sendJson(res, 200, []);
    const limit = clampInt(query.get('per_page'), 1, 100, 30);
    const rows = commitChain(repo, peelToCommit(repo, start), limit);
    return sendJson(res, 200, rows.map((row) => commitJson(repo, row.oid)).filter((row) => row !== null));
  }

  if (rest[0] === 'labels') {
    if (rest.length === 1 && method === 'GET') {
      return sendJson(res, 200, repo.labels.map((label) => labelJson(repo, label)));
    }
    if (rest.length === 1 && method === 'POST') {
      if (typeof body.name !== 'string' || body.name.trim() === '') return fail(res, 422, 'Validation Failed');
      const result = createLabel(repo, body.name.trim(), body.color, body.description);
      return sendJson(res, result.created === true ? 201 : 200, labelJson(repo, result.label));
    }
    const name = rest.slice(1).join('/');
    const label = findLabelByName(repo, name);
    if (label === null) return fail(res, 404, 'Not Found');
    if (method === 'GET') return sendJson(res, 200, labelJson(repo, label));
    if (method === 'PATCH') {
      if (typeof body.new_name === 'string' && body.new_name !== '') {
        label.name = body.new_name;
        for (const issue of repo.issues) bumpIssue(issue);
      }
      if (typeof body.color === 'string') label.color = body.color;
      if (typeof body.description === 'string') label.description = body.description;
      return sendJson(res, 200, labelJson(repo, label));
    }
    if (method === 'DELETE') {
      repo.labels = repo.labels.filter((candidate) => candidate.id !== label.id);
      return sendEmpty(res, 204);
    }
    return fail(res, 404, 'Not Found');
  }

  if (rest[0] === 'issues') {
    if (rest.length === 1 && method === 'GET') {
      const state = query.get('state') ?? 'open';
      let rows = repo.issues.slice();
      if (state === 'open' || state === 'closed') rows = rows.filter((issue) => issue.state === state);
      const direction = (query.get('direction') ?? 'desc').toLowerCase();
      rows.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
      const { perPage, page, items } = pageOf(rows, query);
      const headers = linkHeader(originOf(req), req, url.pathname, query, page, perPage, rows.length);
      return sendJson(res, 200, items.map((issue) => issueJson(repo, issue)), headers);
    }
    if (rest.length === 1 && method === 'POST') {
      if (typeof body.title !== 'string' || body.title === '') return fail(res, 422, 'Validation Failed');
      const issue = createIssue(repo, { title: body.title, body: body.body });
      const wanted = Array.isArray(body.labels) ? body.labels : [];
      for (const entry of wanted) {
        const name = typeof entry === 'string' ? entry : (entry !== null && typeof entry === 'object' && typeof entry.name === 'string' ? entry.name : '');
        const label = name === '' ? null : findLabelByName(repo, name);
        if (label === null) {
          repo.issues = repo.issues.filter((candidate) => candidate.number !== issue.number);
          return fail(res, 422, 'Validation Failed', { errors: [{ resource: 'Issue', field: 'labels', code: 'missing_field' }] });
        }
        issue.labelIds.push(label.id);
      }
      const assignees = Array.isArray(body.assignees) ? body.assignees.filter((name) => typeof name === 'string') : [];
      issue.assignees = assignees;
      return sendPrepared(res, 201, issueResponse(repo, issue));
    }
    const number = Number.parseInt(rest[1] ?? '', 10);
    const issue = Number.isInteger(number) ? findIssue(repo, number) : null;
    if (issue !== null && rest.length === 2) {
      if (method === 'GET') return sendPrepared(res, 200, issueResponse(repo, issue));
      if (method === 'PATCH') return patchIssue(res, repo, issue, body);
      return fail(res, 404, 'Not Found');
    }
    if (issue !== null && rest.length === 3 && rest[2] === 'comments') {
      if (method === 'GET') {
        const { perPage, page, items } = pageOf(issue.comments, query);
        const headers = linkHeader(originOf(req), req, url.pathname, query, page, perPage, issue.comments.length);
        return sendJson(res, 200, items.map((comment) => commentJson(repo, issue, comment)), headers);
      }
      if (method === 'POST') {
        if (typeof body.body !== 'string') return fail(res, 422, 'Validation Failed');
        const comment = {
          id: repo.id * 100_000 + repo.nextComment++,
          body: body.body,
          user: VIEWER,
          createdAt: T0,
          updatedAt: T0,
        };
        issue.comments.push(comment);
        issue.updatedAt = T0;
        bumpIssue(issue);
        return sendJson(res, 201, commentJson(repo, issue, comment));
      }
    }
    return fail(res, 404, 'Not Found');
  }

  if (rest[0] === 'pulls') {
    if (rest.length === 1 && method === 'GET') {
      const state = query.get('state') ?? 'open';
      let rows;
      if (state === 'all') rows = repo.pulls.slice();
      else if (state === 'closed') rows = repo.pulls.filter((pull) => pull.state === 'closed' || pull.merged === true);
      else rows = repo.pulls.filter((pull) => pull.state === 'open' && pull.merged !== true);
      const direction = (query.get('direction') ?? 'desc').toLowerCase();
      rows.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
      const { perPage, page, items } = pageOf(rows, query);
      const headers = linkHeader(originOf(req), req, url.pathname, query, page, perPage, rows.length);
      return sendJson(res, 200, items.map((pull) => pullJson(repo, pull)), headers);
    }
    if (rest.length === 1 && method === 'POST') {
      const created = createPullRequest(repo, body);
      if (created.error !== undefined) return fail(res, created.error.status, created.error.message, { errors: [{ message: created.error.detail }] });
      return sendJson(res, 201, pullJson(repo, created.pull));
    }
    const number = Number.parseInt(rest[1] ?? '', 10);
    const pull = Number.isInteger(number) ? findPull(repo, number) : null;
    if (pull === null) return fail(res, 404, 'Not Found');
    if (rest.length === 2 && method === 'GET') return sendJson(res, 200, pullJson(repo, pull));
    if (rest.length === 3 && rest[2] === 'files' && method === 'GET') {
      const rows = pullFiles(repo, pull).map((file) => ({
        sha: file.sha,
        filename: file.filename,
        status: file.status,
        additions: file.additions,
        deletions: file.deletions,
        changes: file.changes,
        blob_url: `${repoUrl(repo)}/blob/${pull.baseRef}/${file.filename}`,
        raw_url: null,
        contents_url: `${repoUrl(repo)}/contents/${file.filename}`,
      }));
      return sendJson(res, 200, rows);
    }
    if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') {
      const merged = mergePullRequest(repo, pull, body.merge_method);
      if (merged.error !== undefined) return fail(res, merged.error.status, merged.error.message);
      return sendJson(res, 200, { sha: merged.sha, merged: true, message: 'Pull request successfully merged' });
    }
    return fail(res, 404, 'Not Found');
  }

  if (rest[0] === 'contents') {
    return handleContents(req, res, url, repo, rest.slice(1), body);
  }
  return fail(res, 404, 'Not Found');
}

function patchIssue(res, repo, issue, body) {
  if (typeof body.title === 'string') issue.title = body.title;
  if (typeof body.body === 'string') issue.body = body.body;
  if (body.state === 'open' || body.state === 'closed') {
    issue.state = body.state;
    issue.closedAt = body.state === 'closed' ? T0 : null;
  }
  if (Array.isArray(body.labels)) {
    const ids = [];
    for (const entry of body.labels) {
      const name = typeof entry === 'string' ? entry : (entry !== null && typeof entry === 'object' && typeof entry.name === 'string' ? entry.name : '');
      const label = name === '' ? null : findLabelByName(repo, name);
      if (label === null) return fail(res, 422, 'Validation Failed', { errors: [{ resource: 'Issue', field: 'labels', code: 'missing_field' }] });
      if (!ids.includes(label.id)) ids.push(label.id);
    }
    issue.labelIds = ids;
  }
  if (Array.isArray(body.assignees)) issue.assignees = body.assignees.filter((name) => typeof name === 'string');
  issue.updatedAt = T0;
  bumpIssue(issue);
  return sendPrepared(res, 200, issueResponse(repo, issue));
}

function wrapBase64(text) {
  return text.replace(/(.{60})/g, '$1\n');
}

function contentJson(repo, path, hit, object) {
  const base = `${repoUrl(repo)}/contents/${path}`;
  const name = path.split('/').pop() ?? path;
  return {
    name,
    path,
    sha: hit.oid,
    size: object.data.length,
    url: base,
    html_url: base,
    git_url: `${repoUrl(repo)}/git/blobs/${hit.oid}`,
    download_url: null,
    type: 'file',
    content: wrapBase64(object.data.toString('base64')),
    encoding: 'base64',
    _links: { self: base, git: `${repoUrl(repo)}/git/blobs/${hit.oid}`, html: base },
  };
}

function entryJson(repo, path, hit, object) {
  const full = path === '' ? hit.name : `${path}/${hit.name}`;
  const dir = hit.mode === '40000' || hit.mode === '040000';
  const base = `${repoUrl(repo)}/contents/${full}`;
  return {
    name: hit.name,
    path: full,
    sha: hit.oid,
    size: dir ? 0 : (object?.data.length ?? 0),
    url: base,
    html_url: base,
    git_url: `${repoUrl(repo)}/git/${dir ? 'trees' : 'blobs'}/${hit.oid}`,
    download_url: null,
    type: dir ? 'dir' : 'file',
    mode: dir ? '040000' : hit.mode,
  };
}

async function handleContents(req, res, url, repo, pathSegments, body) {
  const method = req.method ?? 'GET';
  const path = pathSegments.join('/');
  const ref = url.searchParams.get('ref');

  if (method === 'GET') {
    if (path === '') {
      const commitOid = resolveRef(repo, ref);
      if (commitOid === null) return fail(res, 404, 'Not Found');
      const commit = peelToCommit(repo, commitOid);
      const treeOid = commit === null ? null : parseCommit(repo.objects.get(commit).data).tree;
      const tree = treeOid === null ? undefined : repo.objects.get(treeOid);
      if (tree === undefined) return fail(res, 404, 'Not Found');
      const rows = parseTree(tree.data).map((entry) => entryJson(repo, '', entry, repo.objects.get(entry.oid)));
      return sendJson(res, 200, rows);
    }
    const hit = fileAt(repo, ref, path);
    if (hit === null) return fail(res, 404, 'Not Found');
    const object = repo.objects.get(hit.oid);
    if (object === undefined) return fail(res, 404, 'Not Found');
    if (object.type === 'tree') {
      const rows = parseTree(object.data).map((entry) => entryJson(repo, path, entry, repo.objects.get(entry.oid)));
      return sendJson(res, 200, rows);
    }
    return sendJson(res, 200, contentJson(repo, path, hit, object));
  }

  if (method === 'PUT') {
    const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
    if (path === '') return fail(res, 422, 'Validation Failed');
    if (typeof body.content !== 'string' || typeof body.message !== 'string') return fail(res, 422, 'Validation Failed');
    const data = Buffer.from(body.content.replace(/\s+/g, ''), 'base64');
    const existing = fileAt(repo, branch, path);
    if (body.sha !== undefined && body.sha !== null) {
      if (existing === null || existing.oid !== body.sha) return fail(res, 409, 'sha does not match');
    }
    if (branchTip(repo, branch) === null) {
      const defaultTip = tipOf(repo, repo.defaultBranch);
      if (branch !== repo.defaultBranch && defaultTip === null) return fail(res, 404, 'Branch not found');
      if (branch !== repo.defaultBranch) repo.refs.set(`refs/heads/${branch}`, defaultTip);
    }
    const written = writeFile(repo, branch, path, data, body.message);
    repo.updatedAt = T0;
    repo.pushedAt = T0;
    const current = fileAt(repo, branch, path);
    const object = repo.objects.get(current.oid);
    return sendJson(res, written.created ? 201 : 200, {
      content: contentJson(repo, path, current, object),
      commit: commitJson(repo, written.commit),
    });
  }

  if (method === 'DELETE') {
    const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
    if (path === '') return fail(res, 422, 'Validation Failed');
    const existing = fileAt(repo, branch, path);
    if (existing === null) return fail(res, 404, 'Not Found');
    if (typeof body.sha === 'string' && body.sha !== '' && existing.oid !== body.sha) return fail(res, 409, 'sha does not match');
    const removed = removeFile(repo, branch, path, typeof body.message === 'string' ? body.message : `Delete ${path}`);
    if (removed === null) return fail(res, 404, 'Not Found');
    repo.updatedAt = T0;
    repo.pushedAt = T0;
    return sendJson(res, 200, { content: null, commit: commitJson(repo, removed.commit) });
  }

  return fail(res, 404, 'Not Found');
}
