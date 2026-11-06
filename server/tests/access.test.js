'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createAccess}=require('../access.js');
const adminToken='admin-123456789012345678901234',operatorToken='operator-123456789012345678901234',viewerToken='viewer-123456789012345678901234';
const access=createAccess({adminToken,teamJson:JSON.stringify([{token:operatorToken,name:'接待员',role:'operator'},{token:viewerToken,name:'观察员',role:'viewer'}])});
const identity=token=>access.identity({headers:{authorization:'Bearer '+token}},new URL('http://localhost/api/growth/state'));
test('access: missing/wrong tokens rejected, independent roles resolved',()=>{
  assert.equal(identity('wrong'),null);assert.equal(identity(''),null);
  assert.equal(identity(adminToken).role,'admin');assert.equal(identity(operatorToken).role,'operator');assert.equal(identity(viewerToken).role,'viewer');
});
test('access: operator can reply and update CRM but cannot configure AI or read account secrets',()=>{
  const user=identity(operatorToken);
  assert.equal(access.allowed(user,'POST','/api/growth/conversations/1/reply'),true);
  assert.equal(access.allowed(user,'PATCH','/api/growth/leads/1'),true);
  assert.equal(access.allowed(user,'PATCH','/api/growth/agent/default'),false);
  assert.equal(access.allowed(user,'GET','/api/accounts'),false);
  assert.equal(access.allowed(user,'POST','/api/growth/workflow/start'),false);
  assert.equal(access.allowed(user,'POST','/api/growth/conversations/1/cards/2/adopt'),true);
  assert.equal(access.allowed(user,'PATCH','/api/growth/card/2'),false);
});
test('access: read-only role cannot mutate or bulk export',()=>{
  const user=identity(viewerToken);
  assert.equal(access.allowed(user,'GET','/api/growth/state'),true);
  assert.equal(access.allowed(user,'POST','/api/growth/conversations/1/reply'),false);
  assert.equal(access.allowed(user,'GET','/api/growth/leads.csv'),false);
  assert.equal(access.allowed(user,'POST','/api/growth/conversations/1/cards/2/adopt'),false);
});
test('access: invalid, duplicated and unprotected team configurations fail closed',()=>{
  assert.throws(()=>createAccess({teamJson:'oops'}),/JSON/);
  assert.throws(()=>createAccess({teamJson:'[{"token":"short","name":"a","role":"admin"}]'}),/24/);
  assert.throws(()=>createAccess({teamJson:JSON.stringify([{token:operatorToken,name:'a',role:'operator'}])}),/AUTH_TOKEN/);
  assert.throws(()=>createAccess({adminToken,teamJson:JSON.stringify([{token:adminToken,name:'a',role:'operator'}])}),/重复/);
});
