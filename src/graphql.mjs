// A small GraphQL v4 document parser: enough for the documents gh and github-mcp-server send.
import { clampInt, globalId, parseGlobalId, VIEWER, T0 } from './util.mjs';
import { findRepo, peelToCommit, resolveRef, store, tipOf } from './store.mjs';
import { createIssue, findIssue, findPull, issueJson, bumpIssue } from './issues.mjs';
import { createPullRequest, mergePullRequest, pullConflict, pullFiles, pullJson } from './pulls.mjs';

const PUNCT = new Set(['{', '}', '(', ')', '[', ']', ':', '!', '$', '@', '=', '|', '&']);

function isNameStart(ch) {
  return (ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z') || ch === '_';
}

function isNamePart(ch) {
  return isNameStart(ch) || (ch >= '0' && ch <= '9');
}

function lex(source) {
  const tokens = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && source.slice(i, i + 3) === '...') {
      tokens.push({ type: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if (PUNCT.has(ch)) {
      tokens.push({ type: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      if (source.slice(i, i + 3) === '"""') {
        const end = source.indexOf('"""', i + 3);
        if (end < 0) throw new Error('unterminated block string');
        tokens.push({ type: 'string', value: source.slice(i + 3, end) });
        i = end + 3;
        continue;
      }
      let j = i + 1;
      let value = '';
      let closed = false;
      while (j < source.length) {
        const c = source[j];
        if (c === '"') {
          closed = true;
          j += 1;
          break;
        }
        if (c === '\\') {
          const next = source[j + 1];
          if (next === 'n') value += '\n';
          else if (next === 't') value += '\t';
          else if (next === 'r') value += '\r';
          else if (next === 'b') value += '\b';
          else if (next === 'f') value += '\f';
          else if (next === 'u') {
            value += String.fromCharCode(Number.parseInt(source.slice(j + 2, j + 6), 16));
            j += 4;
          } else value += next ?? '';
          j += 2;
          continue;
        }
        value += c;
        j += 1;
      }
      if (!closed) throw new Error('unterminated string');
      tokens.push({ type: 'string', value });
      i = j;
      continue;
    }
    if (ch === '-' || (ch >= '0' && ch <= '9')) {
      let j = i;
      if (source[j] === '-') j += 1;
      while (j < source.length && source[j] >= '0' && source[j] <= '9') j += 1;
      if (source[j] === '.') {
        j += 1;
        while (j < source.length && source[j] >= '0' && source[j] <= '9') j += 1;
      }
      if (source[j] === 'e' || source[j] === 'E') {
        j += 1;
        if (source[j] === '+' || source[j] === '-') j += 1;
        while (j < source.length && source[j] >= '0' && source[j] <= '9') j += 1;
      }
      tokens.push({ type: 'number', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (isNameStart(ch)) {
      let j = i + 1;
      while (j < source.length && isNamePart(source[j])) j += 1;
      tokens.push({ type: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)}`);
  }
  tokens.push({ type: 'eof', value: '' });
  return tokens;
}

/** Parse one GraphQL document into operations and fragment definitions. */
export function parseDocument(source) {
  const tokens = lex(source);
  let at = 0;
  const peek = () => tokens[at];
  const next = () => tokens[at++];
  const isPunct = (value) => peek().type === 'punct' && peek().value === value;
  const isName = (value) => peek().type === 'name' && peek().value === value;
  const expectPunct = (value) => {
    if (!isPunct(value)) throw new Error(`expected ${value}`);
    next();
  };
  const expectName = () => {
    const token = next();
    if (token.type !== 'name') throw new Error('expected a name');
    return token.value;
  };

  function parseValue() {
    const token = peek();
    if (token.type === 'punct' && token.value === '$') {
      next();
      return { kind: 'var', name: expectName() };
    }
    if (token.type === 'number') {
      next();
      return { kind: 'number', value: Number(token.value) };
    }
    if (token.type === 'string') {
      next();
      return { kind: 'string', value: token.value };
    }
    if (token.type === 'name') {
      next();
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null', value: null };
      return { kind: 'enum', value: token.value };
    }
    if (isPunct('[')) {
      next();
      const values = [];
      while (!isPunct(']')) values.push(parseValue());
      next();
      return { kind: 'list', values };
    }
    if (isPunct('{')) {
      next();
      const fields = {};
      while (!isPunct('}')) {
        const name = expectName();
        expectPunct(':');
        fields[name] = parseValue();
      }
      next();
      return { kind: 'object', fields };
    }
    throw new Error(`unexpected value token ${JSON.stringify(token.value)}`);
  }

  function parseArguments() {
    const args = {};
    if (!isPunct('(')) return args;
    next();
    while (!isPunct(')')) {
      const name = expectName();
      expectPunct(':');
      args[name] = parseValue();
    }
    next();
    return args;
  }

  function skipDirectives() {
    while (isPunct('@')) {
      next();
      next();
      if (isPunct('(')) parseArguments();
    }
  }

  function parseSelectionSet() {
    expectPunct('{');
    const selections = [];
    while (!isPunct('}')) {
      if (isPunct('...')) {
        next();
        if (isName('on')) {
          next();
          const typeName = expectName();
          skipDirectives();
          selections.push({ kind: 'inline', typeName, selections: parseSelectionSet() });
        } else {
          const name = expectName();
          skipDirectives();
          selections.push({ kind: 'spread', name });
        }
        continue;
      }
      let name = expectName();
      let alias = null;
      if (isPunct(':')) {
        next();
        alias = name;
        name = expectName();
      }
      const args = parseArguments();
      skipDirectives();
      let fieldSelections = null;
      if (isPunct('{')) fieldSelections = parseSelectionSet();
      selections.push({ kind: 'field', name, alias: alias ?? name, args, selections: fieldSelections ?? [] });
    }
    next();
    return selections;
  }

  function skipType() {
    if (isPunct('[')) {
      next();
      skipType();
      expectPunct(']');
    } else {
      expectName();
    }
    if (isPunct('!')) next();
  }

  function parseVariableDefs() {
    const defs = {};
    if (!isPunct('(')) return defs;
    next();
    while (!isPunct(')')) {
      expectPunct('$');
      const name = expectName();
      expectPunct(':');
      skipType();
      let defaultValue;
      if (isPunct('=')) {
        next();
        defaultValue = parseValue();
      }
      defs[name] = defaultValue;
    }
    next();
    return defs;
  }

  const operations = [];
  const fragments = {};
  while (peek().type !== 'eof') {
    let type = 'query';
    let name = '';
    if (peek().type === 'name' && peek().value === 'fragment') {
      next();
      const fragmentName = expectName();
      if (!isName('on')) throw new Error('expected on');
      next();
      const onType = expectName();
      skipDirectives();
      fragments[fragmentName] = { typeName: onType, selections: parseSelectionSet() };
      continue;
    }
    if (peek().type === 'name' && ['query', 'mutation', 'subscription'].includes(peek().value)) {
      type = next().value;
      if (peek().type === 'name') name = next().value;
    }
    const variables = parseVariableDefs();
    skipDirectives();
    const selections = parseSelectionSet();
    operations.push({ type, name, variables, selections });
  }
  return { operations, fragments };
}

function evalValue(node, variables) {
  if (node === null || node === undefined) return null;
  switch (node.kind) {
    case 'string':
    case 'number':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'var':
      return variables[node.name];
    case 'list':
      return node.values.map((entry) => evalValue(entry, variables));
    case 'object': {
      const out = {};
      for (const [name, entry] of Object.entries(node.fields)) out[name] = evalValue(entry, variables);
      return out;
    }
    default:
      return null;
  }
}

function argMap(selection, variables) {
  const out = {};
  for (const [name, node] of Object.entries(selection.args ?? {})) out[name] = evalValue(node, variables);
  return out;
}

const TYPE_FIELDS = {
  Query: ['viewer', 'repository', 'node', '__type', '__typename'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment', '__typename'],
  User: ['login', 'id', 'name', 'email', 'databaseId', '__typename'],
  Ref: ['name', 'target', '__typename'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'description', 'defaultBranchRef',
    'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest',
    'isPrivate', 'createdAt', 'updatedAt', 'pushedAt', 'url', '__typename',
  ],
  Issue: ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'closed', 'closedAt', 'url', 'author', 'repository', '__typename'],
  IssueConnection: ['nodes', 'totalCount', 'pageInfo', '__typename'],
  PullRequest: [
    'id', 'number', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'title', 'body',
    'files', 'createdAt', 'updatedAt', 'mergedAt', 'url', 'isDraft', 'additions', 'deletions',
    'changedFiles', 'baseRef', 'headRef', '__typename',
  ],
  PullRequestConnection: ['nodes', 'totalCount', 'pageInfo', '__typename'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changes', 'filename', '__typename'],
  PullRequestChangedFileConnection: ['nodes', 'totalCount', 'pageInfo', '__typename'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'endCursor', 'startCursor', '__typename'],
  IssueComment: ['id', 'body', 'createdAt', 'updatedAt', 'author', '__typename'],
  CommentEdge: ['node', 'cursor', '__typename'],
  CreateIssuePayload: ['issue', 'clientMutationId', '__typename'],
  CloseIssuePayload: ['issue', 'clientMutationId', '__typename'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId', '__typename'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId', '__typename'],
  AddCommentPayload: ['commentEdge', 'clientMutationId', '__typename'],
  Label: ['id', 'name', 'color', 'description', '__typename'],
  __Type: ['name', 'kind', 'fields', 'enumValues', 'description', '__typename'],
  __Field: ['name', 'isDeprecated', 'deprecationReason', 'type', 'args', '__typename'],
  __EnumValue: ['name', 'isDeprecated', 'deprecationReason', '__typename'],
};

const INTROSPECTION = {
  Issue: { fields: ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'closed', 'closedAt', 'url', 'author'] },
  PullRequest: { fields: ['id', 'number', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files', 'title', 'body', 'isDraft', 'createdAt', 'updatedAt', 'mergedAt', 'url'] },
  Repository: { fields: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'isPrivate', 'createdAt', 'updatedAt', 'pushedAt', 'url'] },
  SearchType: { enums: ['ISSUE', 'REPOSITORY', 'USER'] },
};

function repoForId(id) {
  const parsed = parseGlobalId(id);
  if (parsed === null || parsed.kind !== 'Repository') return null;
  for (const repo of store.repos.values()) if (repo.id === parsed.repoId) return repo;
  return null;
}

function kindMatches(kind, wanted) {
  if (kind === wanted) return true;
  if (wanted === 'Node') return kind === 'Repository' || kind === 'Issue' || kind === 'PullRequest';
  return false;
}

function completeValue(value, selections, ctx) {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((entry) => completeValue(entry, selections, ctx));
  if (typeof value !== 'object') return value;
  coded: {
    const kind = value.__kind;
    if (kind === undefined) break coded;
    const out = {};
    for (const selection of selections ?? []) {
      if (selection.kind === 'field') {
        if (selection.name === '__typename') {
          out[selection.alias] = kind;
          continue;
        }
        const allowed = TYPE_FIELDS[kind];
        if (allowed === undefined || !allowed.includes(selection.name)) {
          ctx.errors.push({ message: `Field "${selection.name}" doesn't exist on type "${kind}"` });
          continue;
        }
        const args = argMap(selection, ctx.variables);
        out[selection.alias] = completeValue(resolveField(kind, value, selection.name, args, ctx), selection.selections, ctx);
        continue;
      }
      if (selection.kind === 'inline') {
        if (!kindMatches(kind, selection.typeName)) continue;
        for (const [key, child] of Object.entries(completeValue(value, selection.selections, ctx))) out[key] = child;
        continue;
      }
      const fragment = ctx.fragments[selection.name];
      if (fragment === undefined || !kindMatches(kind, fragment.typeName)) continue;
      for (const [key, child] of Object.entries(completeValue(value, fragment.selections, ctx))) out[key] = child;
    }
    return out;
  }
  return value;
}

function sortedByNumber(rows, direction) {
  const copy = rows.slice();
  copy.sort((a, b) => (direction === 'ASC' ? a.number - b.number : b.number - a.number));
  return copy;
}

function resolveField(kind, value, name, args, ctx) {
  if (kind === 'User') {
    if (name === 'login') return value.login;
    if (name === 'id') return globalId('User', 1000);
    if (name === 'databaseId') return 1000;
    if (name === 'name') return 'Ada Iversen';
    if (name === 'email') return '';
    return null;
  }
  if (kind === 'Ref') {
    if (name === 'name') return value.name;
    if (name === 'target') {
      const repo = value.repo;
      if (repo === undefined) return null;
      const oid = resolveRef(repo, value.name);
      return oid === null ? null : { __kind: 'Commit', oid, repo };
    }
    return null;
  }
  if (kind === 'Query') return resolveQueryField(name, args, ctx);
  if (kind === 'Mutation') return resolveMutationField(name, args, ctx);
  if (kind === 'Repository') return resolveRepoField(value.repo, name, args, ctx);
  if (kind === 'Issue') return resolveIssueField(value.repo, value.issue, name, args, ctx);
  if (kind === 'PullRequest') return resolvePullField(value.repo, value.pull, name, args, ctx);
  if (kind === 'PullRequestChangedFile') return resolveChangedFileField(value.file, name);
  if (kind === 'CreateIssuePayload' || kind === 'CloseIssuePayload') return value.issue ?? null;
  if (kind === 'CreatePullRequestPayload' || kind === 'MergePullRequestPayload') return value.pullRequest ?? null;
  if (kind === 'AddCommentPayload') return value.commentEdge ?? null;
  if (kind === 'IssueConnection' || kind === 'PullRequestConnection' || kind === 'PullRequestChangedFileConnection') return resolveConnectionField(value, name, args, ctx);
  if (kind === 'PageInfo') {
    if (name === 'hasNextPage') return value.hasNextPage;
    if (name === 'hasPreviousPage') return false;
    if (name === 'endCursor') return value.endCursor ?? null;
    if (name === 'startCursor') return value.endCursor ?? null;
    return null;
  }
  if (kind === 'IssueComment') {
    if (name === 'id') return globalId('IssueComment', value.repo.id, value.comment.id);
    if (name === 'body') return value.comment.body;
    if (name === 'createdAt' || name === 'updatedAt') return value.comment.createdAt;
    if (name === 'author') return { __kind: 'User', login: value.comment.user ?? VIEWER };
    return null;
  }
  if (kind === 'CommentEdge') {
    if (name === 'node') return value.node;
    if (name === 'cursor') return null;
    return null;
  }
  if (kind === 'Label') {
    if (name === 'id') return `LA_${value.label.id}`;
    if (name === 'name') return value.label.name;
    if (name === 'color') return value.label.color;
    if (name === 'description') return value.label.description;
    return null;
  }
  if (kind === '__Type') {
    if (name === 'name') return value.def.name;
    if (name === 'kind') return value.def.kind ?? 'OBJECT';
    if (name === 'description') return null;
    if (name === 'fields') {
      if (value.def.fields === undefined) return null;
      return value.def.fields.map((field) => ({ __kind: '__Field', name: field }));
    }
    if (name === 'enumValues') {
      if (value.def.enums === undefined) return null;
      return value.def.enums.map((entry) => ({ __kind: '__EnumValue', name: entry }));
    }
    return null;
  }
  if (kind === '__Field') {
    if (name === 'name') return value.name;
    if (name === 'isDeprecated') return false;
    if (name === 'deprecationReason') return null;
    if (name === 'type') return { __kind: '__Type', def: { name: 'String', kind: 'SCALAR' } };
    if (name === 'args') return [];
    return null;
  }
  if (kind === '__EnumValue') {
    if (name === 'name') return value.name;
    if (name === 'isDeprecated') return false;
    if (name === 'deprecationReason') return null;
    return null;
  }
  return null;
}

function resolveConnectionField(value, name, args, ctx) {
  if (name === 'nodes') {
    const limit = value.nodes.length;
    return value.nodes.slice(0, limit).map((entry) => entry);
  }
  if (name === 'totalCount') return value.total;
  if (name === 'pageInfo') {
    return { __kind: 'PageInfo', hasNextPage: value.hasNextPage === true, endCursor: value.endCursor ?? null };
  }
  return null;
}

function resolveChangedFileField(file, name) {
  if (name === 'path' || name === 'filename') return file.filename;
  if (name === 'additions') return file.additions;
  if (name === 'deletions') return file.deletions;
  if (name === 'changes') return file.changes;
  return null;
}

function resolveRepoField(repo, name, args, ctx) {
  switch (name) {
    case 'id': return globalId('Repository', repo.id);
    case 'databaseId': return repo.id;
    case 'name': return repo.name;
    case 'nameWithOwner': return `${repo.owner}/${repo.name}`;
    case 'owner': return { __kind: 'User', login: repo.owner };
    case 'description': return repo.description;
    case 'defaultBranchRef': return { __kind: 'Ref', name: repo.defaultBranch, repo };
    case 'viewerPermission': return 'ADMIN';
    case 'hasIssuesEnabled': return repo.hasIssues;
    case 'isPrivate': return repo.private;
    case 'createdAt': return repo.createdAt;
    case 'updatedAt': return repo.updatedAt;
    case 'pushedAt': return repo.pushedAt;
    case 'url': return repoUrl(repo);
    case 'issue': {
      const number = Number(args.number);
      const issue = findIssue(repo, number);
      if (issue !== null) return { __kind: 'Issue', repo, issue };
      const pull = findPull(repo, number);
      if (pull !== null) return { __kind: 'PullRequest', repo, pull };
      return null;
    }
    case 'issues': return issueConnection(repo, args);
    case 'pullRequest': {
      const pull = findPull(repo, Number(args.number));
      return pull === null ? null : { __kind: 'PullRequest', repo, pull };
    }
    case 'pullRequests': return pullConnection(repo, args);
    default: return null;
  }
}

function issueConnection(repo, args) {
  let rows = repo.issues.slice();
  const states = Array.isArray(args.states) ? args.states : null;
  if (states !== null) {
    const open = states.includes('OPEN');
    const closed = states.includes('CLOSED');
    if (open !== closed) rows = rows.filter((issue) => (open ? issue.state === 'open' : issue.state === 'closed'));
  }
  const order = args.orderBy !== null && typeof args.orderBy === 'object' ? args.orderBy : {};
  const direction = order.direction === 'ASC' ? 'ASC' : 'DESC';
  rows.sort((a, b) => (direction === 'ASC' ? a.number - b.number : b.number - a.number));
  const after = args.after;
  if (typeof after === 'string' && after !== '') {
    const cursor = Number.parseInt(after.replace(/[^0-9]/g, ''), 10);
    if (Number.isFinite(cursor)) rows = rows.filter((issue) => (direction === 'ASC' ? issue.number > cursor : issue.number < cursor));
  }
  const first = clampInt(args.first, 0, 100, 30);
  const nodes = rows.slice(0, first);
  return {
    __kind: 'IssueConnection',
    nodes: nodes.map((issue) => ({ __kind: 'Issue', repo, issue })),
    total: rows.length,
    hasNextPage: rows.length > nodes.length,
    endCursor: nodes.length > 0 ? String(nodes[nodes.length - 1].number) : null,
  };
}

function pullConnection(repo, args) {
  let rows = repo.pulls.slice();
  const states = Array.isArray(args.states) ? args.states : null;
  if (states !== null) {
    const open = states.includes('OPEN');
    const closed = states.includes('CLOSED');
    if (open !== closed) rows = rows.filter((pull) => (open ? pull.state === 'open' : pull.state !== 'open'));
  }
  rows.sort((a, b) => b.number - a.number);
  const first = clampInt(args.first, 0, 100, 30);
  const nodes = rows.slice(0, first);
  return {
    __kind: 'PullRequestConnection',
    nodes: nodes.map((pull) => ({ __kind: 'PullRequest', repo, pull })),
    total: rows.length,
    hasNextPage: rows.length > nodes.length,
    endCursor: nodes.length > 0 ? String(nodes[nodes.length - 1].number) : null,
  };
}

function resolveIssueField(repo, issue, name) {
  switch (name) {
    case 'id': return globalId('Issue', repo.id, issue.number);
    case 'number': return issue.number;
    case 'title': return issue.title;
    case 'state': return issue.state === 'open' ? 'OPEN' : 'CLOSED';
    case 'body': return issue.body;
    case 'createdAt': return issue.createdAt;
    case 'updatedAt': return issue.updatedAt;
    case 'closed': return issue.state === 'closed';
    case 'closedAt': return issue.closedAt;
    case 'url': return `${repoUrl(repo)}/issues/${issue.number}`;
    case 'author': return { __kind: 'User', login: issue.user ?? VIEWER };
    case 'repository': return { __kind: 'Repository', repo };
    default: return null;
  }
}

function resolvePullField(repo, pull, name, args, ctx) {
  switch (name) {
    case 'id': return globalId('PullRequest', repo.id, pull.number);
    case 'number': return pull.number;
    case 'state': return pull.merged === true ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
    case 'merged': return pull.merged === true;
    case 'mergeable': return pullConflict(repo, pull) ? 'CONFLICTING' : 'MERGEABLE';
    case 'headRefName': return pull.headRef;
    case 'baseRefName': return pull.baseRef;
    case 'title': return pull.title;
    case 'body': return pull.body;
    case 'createdAt': return pull.createdAt;
    case 'updatedAt': return pull.updatedAt;
    case 'mergedAt': return pull.mergedAt;
    case 'url': return `${repoUrl(repo)}/pulls/${pull.number}`;
    case 'isDraft': return false;
    case 'additions': return 0;
    case 'deletions': return 0;
    case 'changedFiles': return pullFiles(repo, pull).length;
    case 'baseRef': return { __kind: 'Ref', name: pull.baseRef, repo };
    case 'headRef': return { __kind: 'Ref', name: pull.headRef, repo };
    case 'files': {
      const rows = pullFiles(repo, pull).slice(0, clampInt(args.first, 0, 100, 30));
      return {
        __kind: 'PullRequestChangedFileConnection',
        nodes: rows.map((file) => ({ __kind: 'PullRequestChangedFile', file })),
        total: rows.length,
        hasNextPage: false,
        endCursor: null,
      };
    }
    default: return null;
  }
}

function resolveQueryField(name, args, ctx) {
  if (name === 'viewer') return { __kind: 'User', login: VIEWER };
  if (name === 'repository') {
    if (String(args.owner ?? '') !== VIEWER) return null;
    const repo = findRepo(VIEWER, String(args.name ?? ''));
    return repo === undefined ? null : { __kind: 'Repository', repo };
  }
  if (name === 'node') {
    const parsed = parseGlobalId(args.id);
    if (parsed === null) return null;
    for (const repo of store.repos.values()) {
      if (repo.id !== parsed.repoId) continue;
      if (parsed.kind === 'Repository') return { __kind: 'Repository', repo };
      if (parsed.kind === 'Issue') {
        const issue = findIssue(repo, parsed.number);
        return issue === null ? null : { __kind: 'Issue', repo, issue };
      }
      if (parsed.kind === 'PullRequest') {
        const pull = findPull(repo, parsed.number);
        return pull === null ? null : { __kind: 'PullRequest', repo, pull };
      }
    }
    return null;
  }
  if (name === '__type') {
    const typeName = String(args.name ?? '');
    const def = INTROSPECTION[typeName];
    if (def === undefined) return { __kind: '__Type', def: { name: typeName, fields: [] } };
    return { __kind: '__Type', def: { name: typeName, fields: def.fields, enums: def.enums } };
  }
  return null;
}

function repoByIdOnly(id) {
  const parsed = parseGlobalId(id);
  if (parsed === null) return null;
  for (const repo of store.repos.values()) if (repo.id === parsed.repoId) return repo;
  return null;
}

export function runGraphql(document, variables, operationName) {
  let parsed;
  try {
    parsed = parseDocument(String(document ?? ''));
  } catch (err) {
    return { errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
  const operations = parsed.operations;
  let operation = null;
  if (typeof operationName === 'string' && operationName !== '') {
    operation = operations.find((entry) => entry.name === operationName) ?? null;
  } else {
    operation = operations[0] ?? null;
  }
  if (operation === null) return { errors: [{ message: 'No operation in the document' }] };
  const vars = {};
  for (const [name, defaultNode] of Object.entries(operation.variables)) {
    if (defaultNode !== undefined) vars[name] = evalValue(defaultNode, {});
  }
  if (variables !== null && typeof variables === 'object' && !Array.isArray(variables)) {
    for (const [name, value] of Object.entries(variables)) if (value !== undefined) vars[name] = value;
  }
  const ctx = { variables: vars, fragments: parsed.fragments, errors: [] };
  const rootKind = operation.type === 'mutation' ? 'Mutation' : 'Query';
  const data = completeValue({ __kind: rootKind }, operation.selections, ctx);
  const body = { data };
  if (ctx.errors.length > 0) body.errors = ctx.errors;
  return body;
}

function resolveMutationField(name, args, ctx) {
  const input = args.input !== null && typeof args.input === 'object' ? args.input : {};
  if (name === 'createIssue') {
    const repo = repoForId(input.repositoryId);
    if (repo === null) {
      ctx.errors.push({ message: 'Could not resolve to a Repository with the given id' });
      return { __kind: 'CreateIssuePayload', issue: null };
    }
    const issue = createIssue(repo, { title: input.title ?? '', body: input.body ?? '' });
    return { __kind: 'CreateIssuePayload', issue: { __kind: 'Issue', repo, issue } };
  }
  if (name === 'closeIssue') {
    const parsed = parseGlobalId(input.issueId);
    const repo = parsed === null ? null : repoByIdOnly(input.issueId);
    if (parsed === null || repo === null) {
      ctx.errors.push({ message: 'Could not resolve to an Issue with the given id' });
      return { __kind: 'CloseIssuePayload', issue: null };
    }
    const issue = findIssue(repo, parsed.number);
    if (issue === null) {
      ctx.errors.push({ message: 'Could not resolve to an Issue with the given id' });
      return { __kind: 'CloseIssuePayload', issue: null };
    }
    issue.state = 'closed';
    issue.closedAt = T0;
    issue.updatedAt = T0;
    bumpIssue(issue);
    return { __kind: 'CloseIssuePayload', issue: { __kind: 'Issue', repo, issue } };
  }
  if (name === 'createPullRequest') {
    const repo = repoForId(input.repositoryId);
    if (repo === null) {
      ctx.errors.push({ message: 'Could not resolve to a Repository with the given id' });
      return { __kind: 'CreatePullRequestPayload', pullRequest: null };
    }
    const created = createPullRequest(repo, {
      head: input.headRefName,
      base: input.baseRefName,
      title: input.title,
      body: input.body,
    });
    if (created.error !== undefined) {
      ctx.errors.push({ message: created.error.detail ?? created.error.message });
      return { __kind: 'CreatePullRequestPayload', pullRequest: null };
    }
    return { __kind: 'CreatePullRequestPayload', pullRequest: { __kind: 'PullRequest', repo, pull: created.pull } };
  }
  if (name === 'mergePullRequest') {
    const parsed = parseGlobalId(input.pullRequestId);
    if (parsed === null) {
      ctx.errors.push({ message: 'Could not resolve to a PullRequest with the given id' });
      return { __kind: 'MergePullRequestPayload', pullRequest: null };
    }
    let found = null;
    for (const candidate of store.repos.values()) {
      if (candidate.id !== parsed.repoId) continue;
      found = candidate;
      break;
    }
    const pull = found === null ? null : findPull(found, parsed.number);
    if (pull === null) {
      ctx.errors.push({ message: 'Could not resolve to a PullRequest with the given id' });
      return { __kind: 'MergePullRequestPayload', pullRequest: null };
    }
    const method = input.mergeMethod === 'SQUASH' ? 'squash' : input.mergeMethod === 'REBASE' ? 'rebase' : 'merge';
    const merged = mergePullRequest(found, pull, method);
    if (merged.error !== undefined) ctx.errors.push({ message: merged.error.message });
    return { __kind: 'MergePullRequestPayload', pullRequest: { __kind: 'PullRequest', repo: found, pull } };
  }
  if (name === 'addComment') {
    const parsed = parseGlobalId(input.subjectId);
    const repo = parsed === null ? null : repoByIdOnly(input.subjectId);
    commentBlock: {
      if (parsed === null || repo === null) break commentBlock;
      const issue = findIssue(repo, parsed.number);
      if (issue === null) break commentBlock;
      const comment = {
        id: repo.id * 100_000 + repo.nextComment++,
        body: input.body ?? '',
        user: VIEWER,
        createdAt: T0,
        updatedAt: T0,
      };
      issue.comments.push(comment);
      issue.updatedAt = T0;
      bumpIssue(issue);
      return {
        __kind: 'AddCommentPayload',
        commentEdge: { __kind: 'CommentEdge', node: { __kind: 'IssueComment', repo, comment } },
      };
    }
    ctx.errors.push({ message: 'Could not resolve to an Issue with the given id' });
    return { __kind: 'AddCommentPayload', commentEdge: null };
  }
  return null;
}

