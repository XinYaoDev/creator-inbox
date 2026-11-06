'use strict';

const {randomUUID, randomBytes, createHash, scrypt, timingSafeEqual} = require('node:crypto');
const {promisify} = require('node:util');
const derive = promisify(scrypt);
const digest = value => createHash('sha256').update(value).digest('hex');
const fail = (message, status = 400) => { throw Object.assign(new Error(message), {status}); };
const roles = ['admin', 'operator', 'viewer'];
const cookieName = 'laike_session';
const sessionLife = 12 * 3600;
const clean = (value, max) => String(value ?? '').trim().slice(0, max);
const publicUser = u => ({id:u.id, username:u.username, name:u.name, role:u.role, workspaceId:u.workspaceId, active:!!u.active, created:u.created});

async function passwordHash(password) {
  if (typeof password !== 'string' || password.length < 12 || password.length > 128) fail('密码需为 12–128 个字符');
  const salt = randomBytes(16).toString('hex');
  const key = await derive(password, salt, 64);
  return salt + ':' + key.toString('hex');
}
async function passwordMatches(password, saved) {
  const [salt, key] = saved.split(':');
  const actual = await derive(String(password ?? '').slice(0, 129), salt, 64);
  const expected = Buffer.from(key, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function createTeam({db, access, sendJson, readBody, clock = () => Math.floor(Date.now()/1000), onMember = () => {}}) {
  db.exec(`CREATE TABLE IF NOT EXISTS team_workspaces(id TEXT PRIMARY KEY,name TEXT NOT NULL,created INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS team_users(id TEXT PRIMARY KEY,username TEXT UNIQUE NOT NULL,name TEXT NOT NULL,password TEXT NOT NULL,role TEXT NOT NULL,workspaceId TEXT NOT NULL REFERENCES team_workspaces(id),active INTEGER NOT NULL DEFAULT 1,created INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS team_sessions(hash TEXT PRIMARY KEY,userId TEXT NOT NULL REFERENCES team_users(id),expires INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS team_session_user ON team_sessions(userId);
    CREATE TABLE IF NOT EXISTS team_audit(id INTEGER PRIMARY KEY AUTOINCREMENT,workspaceId TEXT NOT NULL,actor TEXT NOT NULL,action TEXT NOT NULL,detail TEXT NOT NULL,ts INTEGER NOT NULL);`);
  db.prepare('INSERT OR IGNORE INTO team_workspaces VALUES(?,?,?)').run('default','我的创作团队',clock());
  const attempts = new Map();
  const dummyHash = '0'.repeat(32) + ':' + '0'.repeat(128);
  const workspaces = () => db.prepare('SELECT * FROM team_workspaces ORDER BY created,id').all();
  const workspace = id => db.prepare('SELECT * FROM team_workspaces WHERE id=?').get(id);
  const configured = () => !!db.prepare('SELECT 1 FROM team_users LIMIT 1').get();
  const audit = (who, action, detail) => db.prepare('INSERT INTO team_audit(workspaceId,actor,action,detail,ts) VALUES(?,?,?,?,?)').run(who.workspaceId,who.name,action,detail,clock());
  const cookies = req => String(req.headers.cookie || '').split(';').map(s=>s.trim()).find(s=>s.startsWith(cookieName+'='))?.slice(cookieName.length+1) || '';
  const setCookie = (res, secret = '') => res.setHeader('Set-Cookie',`${cookieName}=${secret}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${secret?sessionLife:0}${process.env.SESSION_COOKIE_SECURE==='1'?'; Secure':''}`);
  function identity(req, url) {
    const explicit = !!req.headers.authorization || !!url.searchParams.get('token');
    let who;
    if (explicit) {
      const tokenIdentity = access.identity(req,url);
      // An unconfigured token layer must not accept arbitrary bearer credentials.
      if (tokenIdentity?.secured) who={...tokenIdentity,workspaceId:'default',platformAdmin:tokenIdentity.role==='admin'};
    } else {
      const secret = cookies(req);
      if (secret) {
        const u = db.prepare('SELECT u.* FROM team_sessions s JOIN team_users u ON u.id=s.userId WHERE s.hash=? AND s.expires>? AND u.active=1').get(digest(secret),clock());
        if (u) who={...publicUser(u),memberId:u.id,secured:true,session:true,platformAdmin:false};
      } else if (!configured()) {
        const fallback=access.identity(req,url);
        if (fallback) who={...fallback,workspaceId:'default',platformAdmin:true};
      }
    }
    if (!who) return null;
    const requested=clean(req.headers['x-workspace-id'],100);
    if (requested && requested!==who.workspaceId) {
      if (!who.platformAdmin) fail('不能访问其他工作空间',403);
      who.workspaceId=requested;
    }
    const space=workspace(who.workspaceId);
    if (!space) fail('工作空间不存在',404);
    return {...who,workspaceName:space.name};
  }
  function checkOrigin(req) {
    if (['GET','HEAD','OPTIONS'].includes(req.method)) return;
    const origin=req.headers.origin;
    if (req.headers['sec-fetch-site']==='cross-site') fail('拒绝跨站操作',403);
    if (origin) {
      let same=false;
      try { const u=new URL(origin);same=['http:','https:'].includes(u.protocol)&&u.host===req.headers.host; } catch { /* invalid origin */ }
      if (!same) fail('拒绝跨站操作',403);
    }
    if (cookies(req) && req.headers['x-requested-with']!=='LaikeAI') fail('缺少请求校验标记，请刷新页面',403);
  }
  function requireAdmin(who) { if(who?.role!=='admin') fail('仅管理员可以管理团队',403); }
  function targetUser(who,id) {
    const u=db.prepare('SELECT * FROM team_users WHERE id=? AND workspaceId=?').get(id,who.workspaceId);
    if (!u) fail('成员不存在',404);
    return u;
  }
  function ensureAdminRemains(u, next) {
    if (u.active && u.role==='admin' && (!next.active || next.role!=='admin')) {
      const count=db.prepare("SELECT COUNT(*) n FROM team_users WHERE workspaceId=? AND active=1 AND role='admin'").get(u.workspaceId).n;
      if (count<=1) fail('不能停用或降级工作空间的最后一位管理员',409);
    }
  }
  async function insertUser(body, workspaceId) {
    const username=clean(body.username,80).toLowerCase(),name=clean(body.name,80),role=body.role||'operator';
    if (!/^[a-z0-9][a-z0-9_.@-]{2,79}$/.test(username)) fail('登录名需为 3–80 位字母、数字或 _ . @ -');
    if (!name || !roles.includes(role)) fail('请填写姓名并选择有效角色');
    const password=await passwordHash(body.password);
    const u={id:randomUUID(),username,name,password,role,workspaceId,active:1,created:clock()};
    try { db.prepare('INSERT INTO team_users VALUES(?,?,?,?,?,?,?,?)').run(u.id,username,name,password,role,workspaceId,1,u.created); }
    catch(e) { if(e.message.includes('UNIQUE'))fail('该登录名已被使用',409);throw e; }
    onMember(publicUser(u));
    return publicUser(u);
  }
  async function handle(req,res,url) {
    try {
      checkOrigin(req);
      const p=url.pathname.slice('/api/team'.length), method=req.method;
      if(method==='GET'&&p==='/status')return sendJson(res,200,{service:'laike-ai',demo:process.env.GROWTH_DEMO==='1',configured:configured()});
      if(method==='POST'&&p==='/login') {
        const b=await readBody(req),username=clean(b.username,80).toLowerCase();
        const now=clock(),ip=req.socket?.remoteAddress||'unknown';
        // Limit both a single source and distributed guesses against a single account.
        for(const [key,value] of attempts)if(now-value.since>900)attempts.delete(key);
        const keys=['ip:'+ip,'user:'+username];
        if(keys.some(k=>(attempts.get(k)?.count||0)>=(k.startsWith('ip:')?30:8)))fail('尝试次数过多，请 15 分钟后再试',429);
        for(const key of keys)attempts.set(key,{since:attempts.get(key)?.since||now,count:(attempts.get(key)?.count||0)+1});
        if(attempts.size>10000)attempts.delete(attempts.keys().next().value);
        const u=db.prepare('SELECT * FROM team_users WHERE username=?').get(username);
        const valid=await passwordMatches(b.password,u?.password||dummyHash);
        const current=u&&db.prepare('SELECT * FROM team_users WHERE id=?').get(u.id);
        if(!valid||!current?.active||current.password!==u.password)fail('登录名或密码错误',401);
        attempts.delete('user:'+username);
        db.prepare('DELETE FROM team_sessions WHERE expires<=?').run(now);
        const secret=randomBytes(32).toString('hex');
        db.prepare('INSERT INTO team_sessions VALUES(?,?,?)').run(digest(secret),u.id,now+sessionLife);
        setCookie(res,secret);
        audit({...u},'登录','密码登录成功');
        return sendJson(res,200,{user:publicUser(current)});
      }
      if(method==='POST'&&p==='/logout') {
        db.prepare('DELETE FROM team_sessions WHERE hash=?').run(digest(cookies(req)));
        setCookie(res);return sendJson(res,200,{ok:true});
      }
      const who=identity(req,url);
      if(!who)fail('请登录',401);
      if(method==='GET'&&p==='/state')return sendJson(res,200,{identity:who,configured:configured(),workspaces:who.platformAdmin?workspaces():[workspace(who.workspaceId)],users:who.role==='admin'?db.prepare('SELECT * FROM team_users WHERE workspaceId=? ORDER BY created').all(who.workspaceId).map(publicUser):[],audit:who.role==='admin'?db.prepare('SELECT * FROM team_audit WHERE workspaceId=? ORDER BY id DESC LIMIT 100').all(who.workspaceId):[]});
      if(method==='POST'&&p==='/password') {
        if(!who.session)fail('当前使用访问令牌，请登录个人账户后修改密码');
        const b=await readBody(req),u=targetUser(who,who.id);
        if(!await passwordMatches(b.currentPassword,u.password))fail('原密码错误',403);
        const password=await passwordHash(b.password);
        const changed=db.prepare('UPDATE team_users SET password=? WHERE id=? AND password=?').run(password,u.id,u.password);
        if(!changed.changes)fail('账户已变更，请重新登录',409);
        db.prepare('DELETE FROM team_sessions WHERE userId=?').run(u.id);
        setCookie(res);audit(who,'修改密码',u.username);
        return sendJson(res,200,{ok:true,relogin:true});
      }
      requireAdmin(who);
      if(method==='POST'&&p==='/workspaces') {
        if(!who.platformAdmin)fail('只有服务器管理员可以创建工作空间',403);
        if(!who.secured)fail('请先配置 AUTH_TOKEN 服务器管理员令牌，再创建多个工作空间',403);
        const b=await readBody(req),name=clean(b.name,80);if(!name)fail('工作空间名称不能为空');
        const w={id:randomUUID(),name,created:clock()};
        db.prepare('INSERT INTO team_workspaces VALUES(?,?,?)').run(w.id,w.name,w.created);
        audit(who,'创建工作空间',w.name);return sendJson(res,201,w);
      }
      if(method==='PATCH'&&p==='/workspace') {
        const b=await readBody(req),name=clean(b.name,80);if(!name)fail('工作空间名称不能为空');
        db.prepare('UPDATE team_workspaces SET name=? WHERE id=?').run(name,who.workspaceId);
        audit(who,'修改工作空间',name);return sendJson(res,200,workspace(who.workspaceId));
      }
      if(method==='POST'&&p==='/users') {
        const b=await readBody(req);
        if(!db.prepare("SELECT 1 FROM team_users WHERE workspaceId=? AND active=1 AND role='admin'").get(who.workspaceId)&&b.role!=='admin')fail('请先为工作空间创建一位管理员');
        // Without a server token bootstrap is deliberately restricted to loopback.
        if(!who.secured&&!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket?.remoteAddress))fail('首次启用账户需在本机操作或设置服务器管理员令牌',403);
        const u=await insertUser(b,who.workspaceId);audit(who,'创建成员',u.username);return sendJson(res,201,u);
      }
      const match=p.match(/^\/users\/([^/]+)$/);
      if(method==='PATCH'&&match) {
        const u=targetUser(who,match[1]),b=await readBody(req);
        const next={...u,name:b.name===undefined?u.name:clean(b.name,80),role:b.role??u.role,active:b.active===undefined?u.active:b.active===true?1:0};
        if(!next.name||!roles.includes(next.role))fail('姓名或角色无效');
        // Await expensive hashing before rechecking the last-admin invariant.
        const password=b.password===undefined?u.password:await passwordHash(b.password);
        const latest=targetUser(who,u.id);ensureAdminRemains(latest,next);
        db.prepare('UPDATE team_users SET name=?,role=?,active=?,password=? WHERE id=?').run(next.name,next.role,next.active,password,u.id);
        db.prepare('DELETE FROM team_sessions WHERE userId=?').run(u.id);
        onMember(publicUser(next));audit(who,'更新成员',u.username+' / '+next.role+' / '+(next.active?'启用':'停用'));
        return sendJson(res,200,publicUser(next));
      }
      fail('接口不存在',404);
    } catch(e) { return sendJson(res,e.status||500,{error:e.status?e.message:'团队服务出错，请查看服务日志'}); }
  }
  return {identity,handle,checkOrigin,workspaces,configured};
}
module.exports={createTeam};
