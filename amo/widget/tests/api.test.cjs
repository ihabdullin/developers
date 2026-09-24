const {test} = require('node:test');
const assert = require('node:assert/strict');
const makeApi = require('../src/api.js');
test('paginates field definitions without following foreign links', async () => {
  const paths=[];
  const api=makeApi(async options => {
    paths.push(options.url);
    return paths.length===1 ? {_embedded:{custom_fields:[{id:1}]},_links:{next:{href:'https://evil.test/'}}} : {_embedded:{custom_fields:[{id:2}]}};
  },async()=>{});
  assert.deepEqual(await api.fields(),[{id:1},{id:2}]);
  assert.equal(paths[1],'/api/v4/leads/custom_fields?page=2&limit=50');
});
test('serializes calls, preserves failure, never retries writes or 429', async () => {
  let calls=0, concurrent=0, maximum=0;
  const api=makeApi(async () => { calls++; concurrent++; maximum=Math.max(maximum,concurrent); await Promise.resolve(); concurrent--; throw {status:429}; },async()=>{});
  await Promise.allSettled([api.request('PATCH','/api/v4/leads',[{id:1}]),api.request('GET','/api/v4/contacts?query=ab')]);
  assert.equal(calls,2); assert.equal(maximum,1);
});
test('blocks external URLs, creation, queued writes after destroy, cancelled queries', async () => {
  let calls=0;
  const api=makeApi(async()=>{calls++;return {};},async()=>{});
  await assert.rejects(api.request('GET','https://evil.test/'));
  await assert.rejects(api.request('POST','/api/v4/contacts'));
  await assert.rejects(api.request('GET','/api/v4/contacts?query=ab',null,()=>false));
  const queued=api.request('PATCH','/api/v4/leads',[]); api.stop();
  await assert.rejects(queued); assert.equal(calls,0);
});
test('204 empty response; company names fetched once per session', async () => {
  let calls=0;
  const api=makeApi(async options => {calls++;return options.url.includes('companies')?{name:'Clinic'}:undefined;},async()=>{});
  assert.deepEqual(await api.request('GET','/api/v4/contacts?query=zz'),{});
  assert.equal(await api.companyName({id:15}),'Clinic');
  assert.equal(await api.companyName({id:15}),'Clinic'); assert.equal(calls,2);
});
