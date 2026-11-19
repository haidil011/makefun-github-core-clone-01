// The MCP Streamable-HTTP endpoint: JSON-RPC 2.0 over POST /mcp, acting on the same store as REST.
import { FORGE_NAME, FORGE_VERSION, VIEWER } from './util.mjs';
import { findRepo, repoJson, store, tipOf, createRepo } from './store.mjs';
import { createIssue, findIssue, findPull, issueJson } from './issues.mjs';
import { createPullRequest, mergePullRequest, pullJson } from './pulls.mjs';
import { commitJson, fileAt, removeFile, writeFile } from './contents.mjs';

export const SUPPORTED_VERSIONS = ['2026-07-28', '2026-07-07', '2025-11-25', '2025-06-18'];

export const TOOLS = [
  {
    name: 'create_repo',
    title: 'Create repository',
    description: 'Create a repository owned by the authenticated viewer.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name' },
        description: { type: 'string', description: 'Repository description' },
        private: { type: 'boolean', description: 'Whether the repository is private' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    title: 'Get repository',
    description: 'Read one repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    title: 'Create issue',
    description: 'Open a new issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Issue title' },
        body: { type: 'string', description: 'Issue body' },
        labels: { type: 'array', items: { type: 'string' }, description: 'Label names' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    title: 'List issues',
    description: 'List issues in a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        state: { type: 'string', enum: ['open', 'closed', 'all'], description: 'Issue state' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'get_issue',
    title: 'Get issue',
    description: 'Read one issue by number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        number: { type: 'integer', description: 'Issue number' },
      },
      required: ['owner', 'repo', 'number'],
    },
  },
  {
    name: 'create_pull_request',
    title: 'Create pull request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Pull request title' },
        body: { type: 'string', description: 'Pull request body' },
        head: { type: 'string', description: 'Head branch' },
        base: { type: 'string', description: 'Base branch' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    title: 'Merge pull request',
    description: 'Merge a pull request into its base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        pull_number: { type: 'integer', description: 'Pull request number' },
        merge_method: { type: 'string', enum: ['merge', 'squash', 'rebase'], description: 'Merge method' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
  {
    name: 'create_or_update_file',
    title: 'Create or update file',
    description: 'Create or update one file in a repository with a commit.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        path: { type: 'string', description: 'Repository-relative file path' },
        content: { type: 'string', description: 'File content' },
        message: { type: 'string', description: 'Commit message' },
        branch: { type: 'string', description: 'Branch name' },
      },
      required: ['owner', 'repo', 'path', 'content'],
    },
  },
  {
    name: 'get_file',
    title: 'Get file',
    description: 'Read one file from a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        path: { type: 'string', description: 'Repository-relative file path' },
        ref: { type: 'string', description: 'Branch or commit' },
      },
      required: ['owner', 'repo', 'path'],
    },
  },
];

function toolResult(value) {
  const structured = value !== null && typeof value === 'object' ? value : { value };
  return {
    content: [{ type: 'text', text: JSON.stringify(structured) }],
    structuredContent: structured,
    isError: false,
  };
}

function toolError(message) {
  return {
    content: [{ type: 'text', text: message }],
    structuredContent: { error: message },
    isError: true,
  };
}

function repoOf(args) {
  if (typeof args.owner !== 'string' || args.owner !== VIEWER) return null;
  if (typeof args.repo !== 'string' || args.repo === '') return null;
  return findRepo(args.owner, args.repo) ?? null;
}

function callTool(name, args) {
  const input = args !== null && typeof args === 'object' ? args : {};
  createFile: {
    if (name === 'create_repo') {
      if (typeof input.name !== 'string' || input.name.trim() === '') break createFile;
      const existing = findRepo(VIEWER, input.name.trim());
      if (existing !== undefined) return toolResult(repoJson(existing));
      const repo = createRepo(VIEWER, input.name.trim(), input.description, input.private === true);
      return toolResult(repoJson(repo));
    }
    if (name === 'get_repo') {
      const repo = repoOf(input);
      return repo === null ? toolError('Not Found') : toolResult(repoJson(repo));
    }
    if (name === 'create_issue') {
      const repo = repoOf(input);
      if (repo === null) return toolError('Not Found');
      if (typeof input.title !== 'string' || input.title === '') return toolError('title is required');
      const issue = createIssue(repo, { title: input.title, body: input.body });
      return toolResult(issueJson(repo, issue));
    }
    if (name === 'list_issues') {
      const repo = repoOf(input);
      if (repo === null) return toolError('Not Found');
      const state = typeof input.state === 'string' ? input.state : 'open';
      const rows = repo.issues
        .filter((issue) => state === 'all' || issue.state === state)
        .slice()
        .sort((a, b) => b.number - a.number);
      return toolResult({ total_count: rows.length, issues: rows.map((issue) => issueJson(repo, issue)) });
    }
    if (name === 'get_issue') {
      const repo = repoOf(input);
      if (repo === null) return toolError('Not Found');
      const number = Number(input.number);
      const issue = Number.isInteger(number) ? findIssue(repo, number) : null;
      return issue === null ? toolError('Not Found') : toolResult(issueJson(repo, issue));
    }
    if (name === 'create_pull_request') {
      const repo = repoOf(input);
      if (repo === null) return toolError('Not Found');
      const created = createPullRequest(repo, input);
      if (created.error !== undefined) return toolError(created.error.message);
      return toolResult(pullJson(repo, created.pull));
    }
    if (name === 'merge_pull_request') {
      const repo = repoOf(input);
      if (repo === null) return toolError('Not Found');
      const number = Number(input.pull_number);
      const pull = Number.isInteger(number) ? findPull(repo, number) : null;
      if (pull === null) return toolError('Not Found');
      const merged = mergePullRequest(repo, pull, input.merge_method);
      if (merged.error !== undefined) return toolError(merged.error.message);
      return toolResult({
        merged: true,
        sha: merged.sha,
        message: 'Pull request successfully merged',
        pull_request: pullJson(repo, pull),
      });
    }
    if (name === 'create_or_update_file') {
      const repo = repoOf(input);
      if (repo === null) return toolError('Not Found');
      const path = typeof input.path === 'string' ? input.path : '';
      if (path === '') return toolError('path is required');
      const branch = typeof input.branch === 'string' && input.branch !== '' ? input.branch : repo.defaultBranch;
      if (tipOf(repo, branch) === null && branch !== repo.defaultBranch) {
        const base = tipOf(repo, repo.defaultBranch);
        if (base === null) return toolError(`Branch not found: ${branch}`);
        repo.refs.set(`refs/heads/${branch}`, base);
      }
      let bytes;
      try {
        const decoded = Buffer.from(String(input.content ?? ''), 'base64');
        const compact = String(input.content ?? '').replace(/\s+/g, '').replace(/=+$/, '');
        const roundTrip = decoded.toString('base64').replace(/=+$/, '');
        bytes = roundTrip === compact ? decoded : Buffer.from(String(input.content ?? ''), 'utf8');
      } catch {
        bytes = Buffer.from(String(input.content ?? ''), 'utf8');
      }
      const message = typeof input.message === 'string' ? input.message : `Update ${path}`;
      const written = writeFile(repo, branch, path, bytes, message);
      const hit = fileAt(repo, branch, path);
      return toolResult({
        content: { name: path.split('/').pop(), path, sha: hit.oid, size: bytes.length },
        commit: commitJson(repo, written.commit),
      });
    }
    if (name === 'get_file') {
      const repo = repoOf(input);
      if (repo === null) return toolError('Not Found');
      const path = typeof input.path === 'string' ? input.path : '';
      const hit = fileAt(repo, input.ref, path);
      if (hit === null) return toolError('Not Found');
      const object = repo.objects.get(hit.oid);
      if (object === undefined || object.type !== 'blob') return toolError('Not Found');
      return toolResult({
        name: path.split('/').pop(),
        path,
        sha: hit.oid,
        size: object.data.length,
        content: object.data.toString('base64'),
        encoding: 'base64',
      });
    }
    return { error: { code: -32602, message: `Unknown tool: ${name}` } };
  }
  return toolError('Missing required arguments');
}

function discoverResult() {
  return {
    serverInfo: { name: FORGE_NAME, version: FORGE_VERSION },
    capabilities: { tools: { listChanged: false } },
    supportedVersions: SUPPORTED_VERSIONS.slice(),
    latestSupportedVersion: '2026-07-28',
    instructions: 'A GitHub-compatible git forge: repositories, issues, pull requests and file contents.',
  };
}

function initializeResult(params) {
  const requested = params !== null && typeof params === 'object' ? params.protocolVersion : undefined;
  const version = SUPPORTED_VERSIONS.includes(requested) ? requested : '2025-11-25';
  return {
    protocolVersion: version,
    serverInfo: { name: FORGE_NAME, version: FORGE_VERSION },
    capabilities: { tools: { listChanged: false } },
    instructions: 'A GitHub-compatible git forge.',
  };
}

function requiredMissing(name, args) {
  const tool = TOOLS.find((entry) => entry.name === name);
  if (tool === undefined) return [];
  const required = Array.isArray(tool.inputSchema.required) ? tool.inputSchema.required : [];
  const missing = [];
  for (const key of required) {
    const value = args[key];
    if (value === undefined || value === null || value === '') missing.push(key);
  }
  return missing;
}

function rpcResponse(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function handleMessage(message) {
  if (message === null || typeof message !== 'object' || Array.isArray(message)) {
    return rpcError(null, -32600, 'Invalid Request');
  }
  const method = typeof message.method === 'string' ? message.method : '';
  const isNotification = message.id === undefined || message.id === null;
  const params = message.params !== null && typeof message.params === 'object' ? message.params : {};
  if (isNotification) return null;
  const id = message.id;
  if (method === 'server/discover') {
    return rpcResponse(id, discoverResult());
  }
  if (method === 'initialize') {
    return rpcResponse(id, initializeResult(params));
  }
  if (method === 'ping') return rpcResponse(id, {});
  if (method === 'tools/list') return rpcResponse(id, { tools: TOOLS });
  if (method === 'tools/call') {
    const name = typeof params.name === 'string' ? params.name : '';
    if (name === '') return rpcError(id, -32602, 'Unknown tool');
    if (!TOOLS.some((tool) => tool.name === name)) return rpcError(id, -32602, `Unknown tool: ${name}`);
    const args = params.arguments !== null && typeof params.arguments === 'object' ? params.arguments : {};
    const missing = requiredMissing(name, args);
    if (missing.length > 0) return rpcResponse(id, toolError(`Missing required arguments: ${missing.join(', ')}`));
    const result = callTool(name, args);
    if (result.error !== undefined) return rpcError(id, result.error.code, result.error.message);
    return rpcResponse(id, result);
  }
  return rpcError(id, -32601, `Method not found: ${method}`);
}

export function mcpJsonResponse(id, result) {
  return { jsonrpc: '2.0', id, result };
}

export function mcpHttpAnswer(bodyText) {
  let parsed;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return {
      status: 400,
      body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } },
    };
  }
  if (Array.isArray(parsed)) {
    const answers = parsed.map((entry) => handleMessage(entry)).filter((entry) => entry !== null);
    if (answers.length === 0) return { status: 202, body: null };
    return { status: 200, body: answers };
  }
  const answer = handleMessage(parsed);
  if (answer === null) return { status: 202, body: null };
  return { status: 200, body: answer };
}
