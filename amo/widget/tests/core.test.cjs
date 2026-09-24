const {test} = require('node:test');
const assert = require('node:assert/strict');
const core = require('../src/core.js')();
const fields = [{id: 10, name: 'Рекомендовал – Contact ID', type: 'numeric'},
  {id: 20, name: 'Канал привлечения', type: 'select', enums: [{id: 30, value: 'Рекомендации'}]}];
test('resolves existing plural channel; ID is the only stored field', () => {
  const schema = core.resolve(fields, {});
  assert.equal(schema.referral.id, 30);
  assert.deepEqual(core.payload(100, 200, schema), [{id:100,custom_fields_values:[{field_id:10,values:[{value:200}]}]}]);
});
test('rejects duplicate/missing/wrong-type fields and invalid settings', () => {
  assert.throws(() => core.resolve([...fields, {...fields[0],id:11}], {}), /Несколько/);
  assert.equal(core.resolve([...fields, {...fields[0],id:11}], {contact_id_field:'11'}).referrer.id, 11);
  assert.throws(() => core.resolve([], {}), /Нет поля/);
  assert.throws(() => core.resolve([{...fields[0],type:'url'}], {}), /числом/);
  assert.throws(() => core.resolve(fields, {contact_id_field:'999'}), /Проверьте/);
  assert.throws(() => core.resolve(fields, {referral_enum:'999'}), /значения/);
});
test('does not guess between singular and plural enum or duplicate fields', () => {
  assert.throws(() => core.resolve([fields[0], {...fields[1],enums:[{id:30,value:'Рекомендации'},{id:31,value:'Рекомендация'}]}], {}), /значения/);
});
test('strict contact IDs and gating; absent channel remains usable', () => {
  for (const value of ['1x', '-1', 0, 1.5, '9007199254740992', '<script>', '']) assert.equal(core.id(value), null);
  const schema = core.resolve(fields, {});
  assert.equal(core.eligible({}, schema), false);
  assert.equal(core.eligible({custom_fields_values:[{field_id:20,values:[{enum_id:30}]}]}, schema), true);
  assert.equal(core.eligible({}, core.resolve([fields[0]], {})), true);
  assert.throws(() => core.savedId({custom_fields_values:[{field_id:10,values:[{value:'bad'}]}]}, 10));
  assert.equal(core.savedId({custom_fields_values:[{field_id:10,values:[{value:'200'}]}]}, 10),200);
});
test('phone metadata and safe error text', () => {
  assert.equal(core.phone({custom_fields_values:[{field_code:'PHONE',values:[{value:'+70000000000'}]}]}), '+70000000000');
  assert.equal(core.phone({}), '');
  assert.match(core.errorMessage({status:429,responseText:'SECRET'}), /Лимит/);
  assert.doesNotMatch(core.errorMessage({status:403,responseText:'SECRET'}), /SECRET/);
});
