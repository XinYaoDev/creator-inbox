'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http'),{once}=require('node:events'),{DatabaseSync}=require('node:sqlite');
const {createChannelListener}=require('../channel-listener.js');
test('callback listener rejects malformed settings and occupied ports without losing previous listener',async t=>{
  const db=new DatabaseSync(':memory:'),occupied=http.createServer();occupied.listen(0,'127.0.0.1');await once(occupied,'listening');
  const free=http.createServer();free.listen(0,'127.0.0.1');await once(free,'listening');const port=free.address().port;await new Promise(r=>free.close(r));
  const listener=createChannelListener({db,callback:(req,res)=>res.end('signed endpoint')});t.after(()=>{listener.close();occupied.close();db.close()});
  await assert.rejects(()=>listener.configure({enabled:'false',port}),/明确/);
  await assert.rejects(()=>listener.configure({enabled:true,port:80}),/1024/);
  await listener.configure({enabled:true,port});assert.equal(listener.status().listening,true);
  await assert.rejects(()=>listener.configure({enabled:true,port:occupied.address().port}),/占用|使用/);
  assert.equal(listener.status().port,port);assert.equal(listener.status().actualPort,port);assert.equal(listener.status().listening,true);
  assert.equal((await fetch('http://127.0.0.1:'+port+'/api/growth/state')).status,404);
  await listener.configure({enabled:false,port});assert.equal(listener.status().error,'');assert.equal(listener.status().enabled,false);
});
