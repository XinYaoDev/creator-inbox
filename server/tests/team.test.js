'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {DatabaseSync}=require('node:sqlite');
const {createTeam}=require('../team.js');
const {createAccess}=require('../access.js');
const {createGrowth}=require('../growth.js');

function setup(adminToken='root-secret') {
  const db=new DatabaseSync(':memory:');let now=1000;
  const access=createAccess({adminToken}),members=[];
  const team=createTeam({db,access,clock:()=>now,sendJson:(r,status,data)=>Object.assign(r,{status,data}),readBody:async r=>r.body,onMember:u=>members.push(u)});
  const req=(method,body,headers={})=>({method,body,headers:{host:'localhost',...headers},socket:{remoteAddress:'127.0.0.1'}});
  const call=async(method,path,body,headers={authorization:'Bearer '+adminToken})=>{
    const r={headers:{},setHeader(k,v){this.headers[k]=v;}};
    await team.handle(req(method,body,headers),r,new URL('http://localhost/api/team'+path));return r;
  };
  const identity=(headers={})=>team.identity(req('GET',null,headers),new URL('http://localhost'));
  return {db,team,members,call,identity,advance:n=>now+=n};
}
const user=(username='owner',role='admin')=>({username,name:'测试 '+username,role,password:'test-Only-Password-123'});
const sessionHeaders=r=>({cookie:r.headers['Set-Cookie'].split(';')[0],'x-requested-with':'LaikeAI'});

test('accounts: hashed credentials, bounded session, logout, no plaintext returned',async t=>{
  const {db,call,identity,advance,members}=setup();t.after(()=>db.close());
  const created=await call('POST','/users',user());assert.equal(created.status,201);assert.equal(created.data.password,undefined);assert.equal(members.length,1);
  assert.notEqual(db.prepare('SELECT password FROM team_users').get().password,user().password);
  assert.equal((await call('POST','/login',{...user(),password:'wrong'},{})).status,401);
  const login=await call('POST','/login',user(),{}),h=sessionHeaders(login);
  assert.equal(login.status,200);assert.match(login.headers['Set-Cookie'],/HttpOnly; SameSite=Strict/);
  assert.equal(identity(h).role,'admin');assert.equal(identity(h).platformAdmin,false);
  const hash=db.prepare('SELECT hash FROM team_sessions').get().hash;assert.ok(!h.cookie.includes(hash));
  advance(12*3600+1);assert.equal(identity(h),null);
  const again=await call('POST','/login',user(),{}),hh=sessionHeaders(again);
  assert.equal((await call('POST','/logout',{},hh)).status,200);assert.equal(identity(hh),null);
});
test('workspace permissions: scope headers, users, audit and admin boundary',async t=>{
  const {db,call,identity}=setup();t.after(()=>db.close());
  await call('POST','/users',user());
  const w=(await call('POST','/workspaces',{name:'另一团队'})).data;
  const root={authorization:'Bearer root-secret','x-workspace-id':w.id};
  const other=await call('POST','/users',user('other'),root);assert.equal(other.status,201);
  const h=sessionHeaders(await call('POST','/login',user(),{}));
  assert.throws(()=>identity({...h,'x-workspace-id':w.id}),/其他工作空间/);
  assert.equal((await call('POST','/workspaces',{name:'越权'},h)).status,403);
  assert.equal((await call('PATCH','/users/'+other.data.id,{name:'越权'},h)).status,404);
  const state=await call('GET','/state',null,h);
  assert.equal(state.data.users.length,1);assert.equal(state.data.workspaces.length,1);
  assert.ok(state.data.audit.every(a=>a.workspaceId==='default'));
  assert.equal((await call('GET','/state',null,root)).data.users[0].username,'other');
});
test('role changes and password reset revoke sessions; last admin cannot be removed',async t=>{
  const {db,call,identity}=setup();t.after(()=>db.close());
  const admin=(await call('POST','/users',user())).data;
  assert.equal((await call('PATCH','/users/'+admin.id,{active:false})).status,409);
  assert.equal((await call('PATCH','/users/'+admin.id,{role:'viewer'})).status,409);
  const op=(await call('POST','/users',user('operator','operator'))).data;
  let h=sessionHeaders(await call('POST','/login',user('operator'),{}));
  assert.equal((await call('POST','/users',user('denied'),h)).status,403);
  assert.equal((await call('PATCH','/users/'+op.id,{role:'viewer'})).status,200);assert.equal(identity(h),null);
  h=sessionHeaders(await call('POST','/login',user('operator'),{}));
  assert.equal(identity(h).role,'viewer');
  assert.equal((await call('POST','/password',{currentPassword:user().password,password:'changed-password-123'},h)).status,200);
  assert.equal(identity(h),null);
  assert.equal((await call('POST','/login',user('operator'),{})).status,401);
  assert.equal((await call('POST','/login',{username:'operator',password:'changed-password-123'},{})).status,200);
});
test('bootstrap closes anonymous access; rejects invalid tokens and cross-site writes',async t=>{
  const {db,call,identity}=setup('');t.after(()=>db.close());
  assert.equal(identity().secured,false);assert.equal(identity({authorization:'Bearer anything'}),null);
  assert.equal((await call('POST','/users',user(),{origin:'https://evil.example'})).status,403);
  assert.equal((await call('POST','/users',user(),{})).status,201);assert.equal(identity(),null);
  const login=await call('POST','/login',user(),{}),h=sessionHeaders(login);
  assert.equal((await call('POST','/logout',{}, {cookie:h.cookie})).status,403);
  assert.equal((await call('POST','/logout',{}, {...h,origin:'null'})).status,403);
  assert.equal((await call('POST','/logout',{}, {...h,origin:'http://localhost'})).status,200);
});
test('login brute force is rate limited even for unknown accounts',async t=>{
  const {db,call,advance}=setup();t.after(()=>db.close());
  for(let i=0;i<8;i++)assert.equal((await call('POST','/login',{username:'missing',password:'bad'},{})).status,401);
  assert.equal((await call('POST','/login',{username:'missing',password:'bad'},{})).status,429);
  advance(901);assert.equal((await call('POST','/login',{username:'missing',password:'bad'},{})).status,401);
});
test('growth tenants isolate all resource types, idempotency keys, history and workflow state',async t=>{
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());
  const opts={db,sendJson:(r,status,data)=>Object.assign(r,{status,data}),readBody:async r=>r.body};
  const a=createGrowth(opts),b=createGrowth({...opts,workspaceId:'tenant-b'});
  for(const kind of ['knowledge','lead','task','workflow','workflowRun','rule','card'])a.put(kind,{title:'private'},'same-id');
  for(const kind of ['knowledge','lead','task','workflow','workflowRun','rule','card'])assert.equal(b.get(kind,'same-id'),null);
  const ca=a.newConversation({id:'shared-id',name:'A'}),cb=b.newConversation({id:'shared-id',name:'B'});
  a.receive(ca,'private A',{id:'msg-id'});b.receive(cb,'private B',{id:'msg-id'});
  await a.send(ca,'reply A','key');await b.send(cb,'reply B','key');
  assert.equal(b.history('shared-id').length,2);assert.equal(b.history('shared-id')[0].content,'private B');
  assert.equal(a.history('shared-id')[1].content,'reply A');
  assert.equal(b.sync().added,0);
  const restarted=createGrowth({...opts,workspaceId:'tenant-b'});assert.equal(restarted.get('conversation','shared-id').name,'B');
  const c=a.newConversation({name:'Only A'}),res={};
  await b.handle({method:'GET'},res,new URL('http://localhost/api/growth/conversations/'+c.id));assert.equal(res.status,404);
});
