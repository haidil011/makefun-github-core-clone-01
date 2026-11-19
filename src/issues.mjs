// Issues, labels and comments over the same store the REST and GraphQL surfaces read.
import { T0, VIEWER, globalId, nodeIdOf, JSON_TYPE } from './util.mjs';
import { repoUrl, userJson } from './store.mjs';

export function labelJson(repo, label) {
  const base = repoUrl(repo);
  return {
    id: label.id,
    node_id: nodeIdOf('Label', label.id),
    name: label.name,
    color: label.color,
    description: label.description,
    default: false,
    url: `${base}/labels/${encodeURIComponent(label.name)}`,
  };
}

export function issueUrl(repo, number) {
  return `${repoUrl(repo)}/issues/${number}`;
}

export function issueJson(repo, issue) {
  const base = issueUrl(repo, issue.number);
  return {
    id: issue.id,
    node_id: nodeIdOf('Issue', issue.id),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    locked: false,
    user: userJson(issue.user ?? VIEWER),
    labels: issue.labelIds.map((labelId) => {
      const label = repo.labels.find((candidate) => candidate.id === labelId);
      return label === undefined ? null : labelJson(repo, label);
    }).filter((label) => label !== null),
    assignees: [],
    assignee: null,
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    closed_by: null,
    author_association: 'OWNER',
    url: base,
    repository_url: repoUrl(repo),
    html_url: base,
    comments_url: `${base}/comments`,
    events_url: `${base}/events`,
  };
}

export function commentJson(repo, issue, comment) {
  return {
    id: comment.id,
    node_id: nodeIdOf('IssueComment', comment.id),
    url: `${issueUrl(repo, issue.number)}/comments`,
    html_url: `${issueUrl(repo, issue.number)}/comments`,
    issue_url: issueUrl(repo, issue.number),
    body: comment.body,
    user: userJson(comment.user ?? VIEWER),
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
    author_association: 'OWNER',
  };
}

export function findLabelByName(repo, name) {
  return repo.labels.find((label) => label.name === name) ?? null;
}

export function createLabel(repo, name, color, description) {
  const existing = findLabelByName(repo, name);
  if (existing !== null) return { label: existing, created: false };
  const label = {
    id: repo.nextLabel++,
    name: String(name),
    color: typeof color === 'string' && /^[0-9a-fA-F]{6}$/.test(color) ? color.toLowerCase() : 'ededed',
    description: description === undefined || description === null ? null : String(description),
  };
  repo.labels.push(label);
  return { label, created: true };
}

export function findIssue(repo, number) {
  return repo.issues.find((issue) => issue.number === number) ?? null;
}

/** A pre-serialized JSON reply for one issue: the read benchmark repeats the same GET 2,000 times. */
export function issueResponse(repo, issue) {
  if (issue._response === undefined || issue._responseVersion !== issue.version) {
    const buf = Buffer.from(`${JSON.stringify(issueJson(repo, issue))}\n`, 'utf8');
    issue._response = {
      buf,
      idIndex: 7,
      headers: ['content-type', JSON_TYPE, 'content-length', String(buf.length), 'cache-control', 'no-store', 'x-github-request-id', ''],
    };
    issue._responseVersion = issue.version;
  }
  return issue._response;
}

export function bumpIssue(endIssue) {
  endIssue.version = (endIssue.version ?? 0) + 1;
}

export function findPull(repo, number) {
  return repo.pulls.find((pull) => pull.number === number) ?? null;
}

export function findIssueOrPull(repo, number) {
  return findIssue(repo, number) ?? findPull(repo, number);
}

export function findIssueOrPullByGlobal(repo, id) {
  const issue = findIssue(repo, id);
  if (issue !== null) return issue;
  return findPull(repo, id);
}

export function createIssue(repo, input) {
  const number = repo.nextIssue++;
  const issue = {
    id: repo.id * 1_000_000 + number,
    number,
    title: String(input.title ?? ''),
    body: input.body === undefined || input.body === null ? '' : String(input.body),
    state: 'open',
    user: input.user ?? VIEWER,
    labelIds: [],
    comments: [],
    createdAt: T0,
    updatedAt: T0,
    closedAt: null,
    isPull: false,
    version: 0,
  };
  repo.issues.push(issue);
  return issue;
}
