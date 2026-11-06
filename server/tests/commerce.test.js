'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{DatabaseSync}=require('node:sqlite');
const {createGrowth}=require('../growth');
function setup(db=new DatabaseSync(':memory:'),workspaceId='default'){
  let now=1800000000,seq=0;
  const app=createGrowth({db,workspaceId,clock:()=>now,sendJson:(r,status,data)=>Object.assign(r,{status,data}),readBody:async r=>r.body||{}});
  const call=async(method,path,body,role='admin')=>{const r={};await app.handle({method,body,access:{role,name:'验收管理员'}},r,new URL('http://local/api/growth/commerce'+path));return r;};
  const key=()=>({requestId:'request-'+(++seq)});
  const product=async(sku='SKU-001',stock=5)=>{const r=await call('POST','/products',{sku,name:'测试商品'+sku,price:12050,stock});assert.equal(r.status,201);return r.data;};
  const action=async(type,r,action,extra={})=>call('POST',`/${type}/${r.id}/action`,{...key(),expectedVersion:r.version,action,confirmed:true,...extra});
  return {db,app,call,key,product,action,advance:s=>now+=s,now:()=>now};
}
test('orders reserve atomically, never oversell, replay safely, and fulfillment is not a payment event',async t=>{
  const {db,app,call,key,product,action}=setup();t.after(()=>db.close());const p=await product();
  const create={...key(),customer:'本地验收',items:[{productId:p.id,quantity:4}]};
  const first=(await call('POST','/orders',create)).data;assert.equal(first.amount,48200);
  const replay=(await call('POST','/orders',create)).data;assert.equal(replay.id,first.id);assert.equal(replay.replayed,true);
  assert.equal((await call('POST','/orders',{...create,customer:'不同内容'})).status,409);
  const confirmed=(await action('orders',first,'confirm')).data;assert.equal(app.get('commerceProduct',p.id).reserved,4);
  const second=(await call('POST','/orders',{...key(),customer:'另一位客户',items:[{productId:p.id,quantity:2}]})).data;
  assert.equal((await action('orders',second,'confirm')).status,409);assert.equal(app.get('commerceProduct',p.id).reserved,4);
  assert.equal((await action('orders',first,'confirm')).status,409);
  const fulfilled=(await action('orders',confirmed,'fulfill')).data;assert.equal(fulfilled.status,'fulfilled');assert.equal(app.get('commerceProduct',p.id).stock,1);assert.equal(app.get('commerceProduct',p.id).reserved,0);
  assert.equal((await action('orders',fulfilled,'cancel')).status,409);
  const report=(await call('GET','/report')).data;assert.equal(report.orders.find(x=>x.status==='fulfilled').amount,48200);assert.match(report.basis,/不是收款/);
});
test('multi-product failure rolls back every reservation, cancelling releases once and stock edits are audited',async t=>{
  const {db,app,call,key,product,action}=setup();t.after(()=>db.close());const a=await product('A-001',10),b=await product('B-001',1);
  const o=(await call('POST','/orders',{...key(),customer:'库存测试',items:[{productId:a.id,quantity:2},{productId:b.id,quantity:2}]})).data;
  assert.equal((await action('orders',o,'confirm')).status,409);assert.equal(app.get('commerceProduct',a.id).reserved,0);
  const edited=(await action('orders',o,'edit',{items:[{productId:a.id,quantity:2},{productId:b.id,quantity:1}]})).data;
  const confirmed=(await action('orders',edited,'confirm')).data;
  assert.equal((await call('PATCH','/products/'+a.id,{expectedVersion:2,stock:1,reason:'盘点'})).status,409);
  const payload={...key(),expectedVersion:confirmed.version,action:'cancel',confirmed:true};
  assert.equal((await call('POST','/orders/'+o.id+'/action',payload)).data.status,'cancelled');
  assert.equal((await call('POST','/orders/'+o.id+'/action',payload)).data.replayed,true);assert.equal(app.get('commerceProduct',a.id).reserved,0);
  assert.equal((await call('PATCH','/products/'+a.id,{expectedVersion:3,stock:15})).status,400);
  assert.equal((await call('PATCH','/products/'+a.id,{expectedVersion:3,stock:15,reason:'入库 5 件'})).data.stock,15);
});
test('quotes preserve agreed prices, expire, convert once and link to actual CRM conversations',async t=>{
  const {db,app,call,key,product,action,advance}=setup();t.after(()=>db.close());const p=await product();const c=app.newConversation({name:'报价客户',channel:'sandbox'});
  let q=(await call('POST','/quotes',{...key(),conversationId:c.id,items:[{productId:p.id,quantity:2}],validDays:1})).data;
  assert.equal(q.customer,'报价客户');assert.equal(q.channel,'sandbox');q=(await action('quotes',q,'issue')).data;q=(await action('quotes',q,'accept')).data;
  await call('PATCH','/products/'+p.id,{expectedVersion:1,price:20000});
  const order=(await action('quotes',q,'convert')).data;assert.equal(order.amount,24100);assert.equal(order.quoteId,q.id);assert.equal(order.status,'draft');
  assert.equal((await action('quotes',app.get('commerceQuote',q.id),'convert')).status,409);
  let exp=(await call('POST','/quotes',{...key(),customer:'过期报价',items:[{productId:p.id,quantity:1}],validDays:1})).data;advance(86401);assert.equal((await action('quotes',exp,'issue')).status,409);
});
test('bookings enforce resource overlap and capacity, preserve originals on failed reschedule and require explicit confirmation',async t=>{
  const {db,app,call,key,action,advance,now}=setup();t.after(()=>db.close());
  const first=(await call('POST','/slots',{name:'上午服务',resource:'顾问 A',start:now()+3600,end:now()+7200,capacity:2})).data;
  assert.equal((await call('POST','/slots',{name:'冲突服务',resource:'顾问 A',start:now()+4000,end:now()+8000,capacity:2})).status,409);
  const next=(await call('POST','/slots',{name:'下午服务',resource:'顾问 A',start:now()+9000,end:now()+10000,capacity:1})).data;
  let booking=(await call('POST','/bookings',{...key(),slotId:first.id,customer:'预约客户',quantity:2})).data;
  assert.equal((await action('bookings',booking,'confirm',{confirmed:false})).status,400);
  booking=(await action('bookings',booking,'confirm')).data;assert.equal(app.get('commerceSlot',first.id).reserved,2);
  assert.equal((await action('bookings',booking,'reschedule',{slotId:next.id})).status,409);assert.equal(app.get('commerceBooking',booking.id).slotId,first.id);
  const widened=(await call('PATCH','/slots/'+next.id,{expectedVersion:1,capacity:3})).data;
  booking=(await action('bookings',booking,'reschedule',{slotId:widened.id})).data;assert.equal(app.get('commerceSlot',first.id).reserved,0);assert.equal(app.get('commerceSlot',next.id).reserved,2);
  assert.equal((await action('bookings',booking,'complete')).status,409);advance(9001);booking=(await action('bookings',booking,'complete')).data;assert.equal(booking.status,'completed');assert.equal((await action('bookings',booking,'cancel')).status,409);
});
test('local business permissions, pagination, invalid values and workspace separation',async t=>{
  const {db,call,product}=setup();t.after(()=>db.close());const p=await product();
  for(const role of ['operator','viewer'])assert.equal((await call('GET','/products',undefined,role)).status,403);
  const other=setup(db,'other');assert.equal((await other.call('GET','/products')).data.total,0);assert.equal((await other.call('PATCH','/products/'+p.id,{expectedVersion:1,enabled:false})).status,404);
  assert.equal((await call('POST','/products',{sku:'negative',name:'无效',price:-1,stock:0})).status,400);
  assert.equal((await call('POST','/products',{sku:'SKU-001',name:'重复',price:1,stock:0})).status,409);
  for(let i=0;i<55;i++)await product('ITEM-'+i);
  const list=(await call('GET','/products?page=2')).data;assert.equal(list.total,56);assert.equal(list.list.length,6);
});
