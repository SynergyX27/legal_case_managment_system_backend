import test from 'node:test';
import assert from 'node:assert/strict';
import {errorHandler} from '../src/utils/errors.js';
test('case-delete diagnostics show safe code/stage to owners and keep raw errors private', () => {
 const original=console.error, logs=[];
 console.error=v=>logs.push(JSON.parse(v));
 try {
  const err=Object.assign(new Error('secret database value'), {code:'XX001',operation:'case.delete',failureStep:'delete-case'});
  const req={id:'test-id',user:{role:'owner'},method:'DELETE',route:{path:'/cases/:id'},headers:{cookie:'private'}};
  let body; const res={headersSent:false,status(n){assert.equal(n,500);return this;},json(v){body=v;}};
  errorHandler(err,req,res,()=>{});
  assert.equal(body.diagnosticCode,'XX001');assert.equal(body.failedStep,'delete-case');
  assert(!JSON.stringify(body).includes('secret'));assert(!JSON.stringify(logs).includes('secret'));assert(!JSON.stringify(logs).includes('private'));
  req.user.role='staff';errorHandler(err,req,res,()=>{});assert.equal(body.diagnosticCode,undefined);
 } finally {console.error=original;}
});
