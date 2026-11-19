// The HTTP server: routing, authentication_window and the smart-HTTP/REST/GraphQL/MCP surfaces.
import { createServer } from 'node:http';
import { handleRest } from './rest.mjs';
import { runGraphql } from './graphql.mjs';
import { mcpHttpAnswer } from './mcp.mjs';
import { fetchResponse, lsRefs, receiveAdvertisement, receiveResponse, uploadAdvertisement } from './git-http.mjs';
import { findRepo, store } from './store.mjs';
import { findIssue, issueResponse } from './issues.mjs';
import { VIEWER } from './util.mjs';
import { sendBuffer, sendJson, sendEmpty, sendPrepared, readBody, parseJson } from './http.mjs';

const TOKEN = (() => {
  const value = process.env.MAKEFUN_SHOP_TOKEN;
  return typeof value === 'string' && value !== '' ? value : 'devtok';
})();
const BEARER = `Bearer ${TOKEN}`;

const EMPTY_PARAMS = new URLSearchParams('');
const HEALTH_BODY = Buffer.from('{"ok":true}\n');
const HEALTH = {
  buf: HEALTH_BODY,
  headers: ['content-type', 'application/json; charset=utf-8', 'content-length', String(HEALTH_BODY.length), 'x-github-request-id', ''],
  idIndex: 5,
};

function authorized(req) {
  return req.headers.authorization === BEARER;
}

function pathOf(rawUrl) {
  if (rawUrl.charCodeAt(0) !== 47) {
    try {
      const parsed = new URL(rawUrl, 'http://entry');
      return { pathname: parsed.pathname, searchParams: parsed.searchParams };
    } catch {
      return { pathname: '/', searchParams: EMPTY_PARAMS };
    }
  }
  const at = rawUrl.indexOf('?');
  if (at === -1) return { pathname: rawUrl, searchParams: EMPTY_PARAMS };
  return { pathname: rawUrl.slice(0, at), searchParams: new URLSearchParams(rawUrl.slice(at + 1)) };
}

export function createApp() {
  const server = createServer((req, res) => {
    void handle(req, res).catch(() => {
      if (!res.headersSent) sendJson(res, 500, { message: 'Internal Server Error' });
      else res.destroy();
    });
  });
  server.keepAliveTimeout = 0;
  server.headersTimeout = 0;
  server.requestTimeout = 0;
  server.timeout = 0;
  server.maxHeadersCount = 2000;
  server.on('connection', (socket) => socket.setNoDelay(true));
  return server;
}

async function handle(req, res) {
  const method = req.method ?? 'GET';
  const rawUrl = req.url ?? '/';
  const at = rawUrl.indexOf('?');
  const rawPath = at === -1 ? rawUrl : rawUrl.slice(0, at);
  if (method === 'GET' && rawPath === '/healthz') {
    sendPrepared(res, 200, HEALTH);
    return;
  }

  if (!authorized(req)) {
    sendJson(res, 401, { message: 'Requires authentication' });
    return;
  }

  if (method === 'GET') {
    const fast = store.issueRoutes.get(rawPath);
    if (fast !== undefined) {
      sendPrepared(res, 200, issueResponse(fast.repo, fast.issue));
      return;
    }
  }

  if (method === 'GET') {
    const issueMatch = /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)$/.exec(rawPath);
    if (issueMatch !== null) {
      const owner = decodeURIComponent(issueMatch[1]);
      const repoName = decodeURIComponent(issueMatch[2]);
      const repo = owner === VIEWER ? findRepo(owner, repoName) : undefined;
      const issue = repo === undefined ? null : findIssue(repo, Number.parseInt(issueMatch[3], 10));
      if (issue === null) {
        sendJson(res, 404, { message: 'Not Found' });
        return;
      }
      sendPrepared(res, 200, issueResponse(repo, issue));
      return;
    }
  }

  const gitMatch = /^\/([^/]+)\/([^/]+)\.git(\/info\/refs|\/git-upload-pack|\/git-receive-pack)$/.exec(rawPath);
  if (gitMatch !== null) {
    const owner = decodeURIComponent(gitMatch[1]);
    const repoName = decodeURIComponent(gitMatch[2]);
    const suffix = gitMatch[3];
    if (owner !== VIEWER) {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    const repo = findRepo(owner, repoName);
    if (repo === undefined) {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    const service = suffix === '/git-upload-pack' ? 'git-upload-pack' : suffix === '/git-receive-pack' ? 'git-receive-pack' : rawUrl.includes('service=git-upload-pack') ? 'git-upload-pack' : rawUrl.includes('service=git-receive-pack') ? 'git-receive-pack' : null;
    if (suffix === '/info/refs') {
      if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
        sendJson(res, 403, { message: 'Unsupported service' });
        return;
      }
      if (service === 'git-upload-pack') {
        const wantV2 = String(req.headers['git-protocol'] ?? '').includes('version=2');
        sendBuffer(res, 200, 'application/x-git-upload-pack-advertisement', uploadAdvertisement(repo, wantV2));
      } else {
        sendBuffer(res, 200, 'application/x-git-receive-pack-advertisement', receiveAdvertisement(repo));
      }
      return;
    }
    if (suffix === '/git-upload-pack') {
      if (method !== 'POST') {
        sendJson(res, 405, { message: 'Method Not Allowed' });
        return;
      }
      const body = await readBody(req);
      let answer;
      try {
        const head = body.subarray(0, 128).toString('utf8');
        if (head.includes('command=ls-refs')) {
          answer = lsRefs(repo, body);
        } else {
          answer = fetchResponse(repo, body);
        }
      } catch (err) {
        sendJson(res, 400, { message: err instanceof Error ? err.message : String(err) });
        return;
      }
      sendBuffer(res, 200, 'application/x-git-upload-pack-result', answer);
      return;
    }
    if (suffix === '/git-receive-pack') {
      if (method !== 'POST') {
        sendJson(res, 405, { message: 'Method Not Allowed' });
        return;
      }
      const body = await readBody(req);
      try {
        sendBuffer(res, 200, 'application/x-git-receive-pack-result', receiveResponse(repo, body));
      } catch (err) {
        sendBuffer(res, 200, 'application/x-git-receive-pack-result', Buffer.alloc(0));
      }
      return;
    }
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }

  const url = pathOf(rawUrl);
  if (url.pathname === '/mcp' || url.pathname === '/mcp/') {
    if (method !== 'POST') {
      sendJson(res, 405, { message: 'Method Not Allowed' });
      return;
    }
    const buf = await readBody(req);
    const answer = mcpHttpAnswer(buf.toString('utf8'));
    if (answer.body === null) {
      sendEmpty(res, answer.status);
      return;
    }
    sendJson(res, answer.status, answer.body);
    return;
  }

  if (url.pathname === '/api/graphql') {
    if (method !== 'POST') {
      sendJson(res, 405, { message: 'Method Not Allowed' });
      return;
    }
    const buf = await readBody(req);
    const parsed = parseJson(buf);
    if (parsed.ok !== true) {
      sendJson(res, 400, { errors: [{ message: 'Problems parsing JSON' }] });
      return;
    }
    const body = parsed.value;
    if (Array.isArray(body)) {
      const answers = body.map((entry) => runGraphql(entry?.query, entry?.variables, entry?.operationName));
      sendJson(res, 200, answers);
      return;
    }
    const answer = runGraphql(body?.query, body?.variables, body?.operationName);
    sendJson(res, 200, answer);
    return;
  }

  if (url.pathname === '/api/v3' || url.pathname.startsWith('/api/v3/')) {
    await handleRest(req, res, url);
    return;
  }

  sendJson(res, 404, { message: 'Not Found' });
}
