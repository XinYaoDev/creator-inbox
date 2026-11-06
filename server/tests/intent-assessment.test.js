'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {groundedAssessment}=require('../intent-assessment.js');
test('semantic intent requires confidence, actual customer evidence and bounded tags',()=>{
  const message='我们四个人周日下午能一起过来吗';
  const value={intent:'high',confidence:.9,reason:'有具体人数与到访时间',evidence:'四个人周日下午',tags:['多人活动','多人活动','周末到访']};
  assert.deepEqual(groundedAssessment(value,[message]).tags,['多人活动','周末到访']);
  assert.equal(groundedAssessment({...value,evidence:'马上付款'},[message]),null);
  assert.equal(groundedAssessment({...value,confidence:.5},[message]),null);
  assert.equal(groundedAssessment({...value,intent:'won'},[message]),null);
  assert.equal(groundedAssessment({...value,confidence:'0.9'},[message]),null);
  assert.equal(groundedAssessment({...value,confidence:NaN},[message]),null);
  assert.equal(groundedAssessment(null,[message]),null);
});
