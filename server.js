'use strict';
const http = require('node:http');
const https = require('node:https');
const { pipeline } = require('node:stream');

const list = (v) => (v || '').split(/[\s,]+/).filter(Boolean);
const BOT_TOKENS = new Set(list(process.env.ALLOWED_BOT_TOKENS));
const GH_OWNERS = new Set(list(process.env.GH_ALLOWED_OWNERS).map((s) => s.toLowerCase()));
const LISTEN_HOST = process.env.LISTEN_HOST || '127.0.0.1';

const HOP_HEADERS = ['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'te', 'trailer', 'upgrade'];
const DROP_REQ = new Set([...HOP_HEADERS, 'host', 'cookie', 'forwarded', 'via', 'x-real-ip']);
const DROP_RES = new Set([...HOP_HEADERS, 'set-cookie', 'alt-svc', 'strict-transport-security']);

function send(res, status, text) {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(text);
}

function requestHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    if (!DROP_REQ.has(k) && !k.startsWith('x-forwarded-')) out[k] = v;
  }
  return out;
}

function upstream(url, method, headers, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method, headers }, resolve);
    req.setTimeout(60_000, () => req.destroy(new Error('upstream timeout')));
    req.on('error', reject);
    if (body) pipeline(body, req, () => {});
    else req.end();
  });
}

function relay(upRes, res) {
  const headers = {};
  for (const [k, v] of Object.entries(upRes.headers)) {
    if (!DROP_RES.has(k)) headers[k] = v;
  }
  res.writeHead(upRes.statusCode, headers);
  pipeline(upRes, res, () => {});
}

// Telegram: /bot{TOKEN}/{method} and /file/bot{TOKEN}/{file_path}, same as the Worker version.
async function telegram(req, res) {
  const { pathname } = new URL(req.url, 'http://x');
  const apiMatch = pathname.match(/^\/bot([^/]+)\/\w+$/);
  const fileMatch = pathname.match(/^\/file\/bot([^/]+)\/.+$/);
  if (!apiMatch && !fileMatch) return send(res, 404, 'Not Found');

  if (BOT_TOKENS.size === 0) return send(res, 503, 'ALLOWED_BOT_TOKENS is not configured');
  if (!BOT_TOKENS.has((apiMatch || fileMatch)[1])) return send(res, 403, 'Forbidden');

  const methods = fileMatch ? ['GET'] : ['GET', 'POST'];
  if (!methods.includes(req.method)) return send(res, 405, 'Method Not Allowed');

  const upRes = await upstream(`https://api.telegram.org${req.url}`, req.method,
    requestHeaders(req.headers), req.method === 'POST' ? req : null);
  relay(upRes, res);
}

// GitHub: https://{GH_DOMAIN}/https://github.com/... (scheme optional).
// Only downloads and read-only git clone are proxied, never GitHub web pages.
const GH_RULES = {
  'github.com': [
    /^\/([^/]+)\/[^/]+\/(releases|archive|raw|blob)\//,
    /^\/([^/]+)\/[^/]+\/(info\/refs|git-upload-pack)$/,
  ],
  'raw.githubusercontent.com': [/^\/([^/]+)\//],
  'gist.githubusercontent.com': [/^\/([^/]+)\//],
  'gist.github.com': [/^\/([^/]+)\/[^/]+\/raw\//],
  'codeload.github.com': [/^\/([^/]+)\//],
};
const GH_ASSET_HOSTS = new Set(['objects.githubusercontent.com', 'release-assets.githubusercontent.com']);
const GH_USAGE = `GitHub 加速
用法：在原始链接前加上本站地址，例如
  https://{本站域名}/https://github.com/{owner}/{repo}/releases/download/...
  https://{本站域名}/https://raw.githubusercontent.com/{owner}/{repo}/{ref}/{path}
  git clone https://{本站域名}/https://github.com/{owner}/{repo}.git
`;

function ghOwner(u) {
  for (const re of GH_RULES[u.hostname] || []) {
    const m = u.pathname.match(re);
    if (m) return m[1].toLowerCase();
  }
  return null;
}

async function github(req, res) {
  if (req.url === '/') return send(res, 200, GH_USAGE);

  let target;
  try {
    target = new URL('https://' + req.url.slice(1).replace(/^https?:\/*/i, ''));
  } catch {
    return send(res, 400, 'Bad URL');
  }
  const owner = ghOwner(target);
  if (!owner) return send(res, 403, 'URL not allowed');
  if (GH_OWNERS.size > 0 && !GH_OWNERS.has(owner)) return send(res, 403, 'Owner not allowed');

  const isUploadPack = target.pathname.endsWith('/git-upload-pack');
  if (isUploadPack ? req.method !== 'POST' : req.method !== 'GET' && req.method !== 'HEAD') {
    return send(res, 405, 'Method Not Allowed');
  }
  if (target.hostname === 'github.com') {
    target.pathname = target.pathname.replace(/^(\/[^/]+\/[^/]+)\/blob\//, '$1/raw/');
  }

  const headers = requestHeaders(req.headers);
  let upRes = await upstream(target, req.method, headers, isUploadPack ? req : null);

  for (let hops = 0; hops < 5 && !isUploadPack && [301, 302, 303, 307, 308].includes(upRes.statusCode); hops++) {
    const next = new URL(upRes.headers.location, target);
    if (next.protocol !== 'https:' || (!GH_ASSET_HOSTS.has(next.hostname) && !ghOwner(next))) break;
    upRes.resume();
    if (next.hostname !== target.hostname) delete headers.authorization;
    target = next;
    upRes = await upstream(target, req.method, headers, null);
  }
  relay(upRes, res);
}

function serve(port, handler) {
  const server = http.createServer((req, res) => {
    handler(req, res).catch((err) => {
      if (!res.headersSent) send(res, 502, `Proxy error: ${err.message}`);
      else res.destroy();
    });
  });
  server.requestTimeout = 0;
  server.listen(port, LISTEN_HOST, () => console.log(`listening on ${LISTEN_HOST}:${port}`));
}

serve(Number(process.env.TG_PORT || 8081), telegram);
serve(Number(process.env.GH_PORT || 8082), github);
