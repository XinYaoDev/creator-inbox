'use strict';
const { timingSafeEqual, createHash } = require('node:crypto');

// Desktop sessions are local-only and separate from team/workspace authorization.
// The native host receives the launch secret through its private child-process IPC.
function createDesktopGateway(secret) {
  if (!secret) return null;
  if (!/^[a-f0-9]{64}$/.test(secret)) throw new Error('Invalid desktop launch secret');
  const same = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) && timingSafeEqual(Buffer.from(value), Buffer.from(secret));
  return (req, res, u) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    const port = req.socket.localPort;
    const host = `127.0.0.1:${port}`;
    const deny = (status, message) => { res.writeHead(status, {'Content-Type':'application/json; charset=utf-8'}); res.end(JSON.stringify({error:message})); return true; };
    if (req.headers.host !== host || !['127.0.0.1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)) return deny(403, '桌面服务仅允许本机访问');
    if (req.headers.origin && req.headers.origin !== `http://${host}`) return deny(403, '拒绝跨站访问');
    const cookieName = `laike_desktop_${port}`;
    if (u.pathname === '/_desktop/connect' && req.method === 'GET' && same(u.searchParams.get('ticket'))) {
      // WebKit withholds Strict cookies along a redirect chain originating at
      // tauri://localhost. Commit a same-origin document before navigating;
      // retain Strict/HttpOnly rather than relaxing the session boundary.
      const script="window.location.replace('/')";
      const hash=createHash('sha256').update(script).digest('base64');
      res.writeHead(200, {'Set-Cookie':`${cookieName}=${secret}; HttpOnly; SameSite=Strict; Path=/`,'Content-Type':'text/html; charset=utf-8','Content-Security-Policy':`default-src 'none'; script-src 'sha256-${hash}'; base-uri 'none'; frame-ancestors 'none'`});
      res.end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>正在打开来客工作台</title><p>正在打开本机工作台…</p><script>${script}</script><noscript><a href="/">进入工作台</a></noscript></html>`); return true;
    }
    if (u.pathname === '/_desktop/health' && req.method === 'GET' && same((req.headers.authorization || '').replace(/^Bearer /, ''))) {
      res.writeHead(200, {'Content-Type':'application/json'}); res.end(JSON.stringify({ready:true, pid:process.pid})); return true;
    }
    const cookies = String(req.headers.cookie || '').split(';').map(v => v.trim());
    if (!cookies.some(v => v.startsWith(cookieName+'=') && same(v.slice(cookieName.length+1)))) return deny(401, '请从来客桌面客户端打开本机工作台');
    if (u.pathname.startsWith('/api/update/')) return deny(409, '桌面端请从“启动与维护”安装签名更新或回滚版本');
    return false;
  };
}
module.exports = { createDesktopGateway };
