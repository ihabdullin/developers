const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {JSDOM} = require('jsdom');
const makeJquery = require('jquery');
const clone = value => JSON.parse(JSON.stringify(value));
const fields = [{id:10,name:'Рекомендовал – Contact ID',type:'numeric'},
  {id:20,name:'Канал привлечения',type:'select',enums:[{id:30,value:'Рекомендации'}]}];
async function until(predicate) {
  for (let i=0;i<250;i++) { if(predicate())return; await new Promise(resolve=>setTimeout(resolve,5)); }
  throw new Error('Timed out waiting for widget state');
}
function harness(options={}) {
  const dom = new JSDOM('<html><head></head><body><input name="CFV[10]" value="'+(options.saved||'')+'"><input name="CFV[20]" value="'+(options.channel===false?'31':'30')+'"><input id="unrelated" value="unsaved note"></body></html>',{url:'https://personal-test.amocrm.ru/leads/detail/100',runScripts:'outside-only'});
  const {window} = dom; const $=makeJquery(window); const handlers=new Set(); const calls=[];
  let lead={id:100,name:'Original lead',custom_fields_values:[{field_id:20,values:[{enum_id:options.channel===false?31:30}]}]};
  if(options.saved)lead.custom_fields_values.push({field_id:10,values:[{value:options.saved}]});
  const contact={id:200,name:options.xss?'<img src=x onerror=alert(1)>':'Тестовый Контакт',custom_fields_values:[{field_code:'PHONE',values:[{value:'+70000000000'}]}],_embedded:{companies:[{id:300}]}};
  const app={isCard:()=>true,getBaseEntity:()=> 'leads',data:{current_card:{id:100,model:{on:(event,fn)=>handlers.add(fn),off:(event,fn)=>handlers.delete(fn)}}}};
  window.APP=app;
  window.setTimeout=(fn)=>setTimeout(fn,0); window.clearTimeout=clearTimeout;
  $('input[name^="CFV"]').on('change',()=>handlers.forEach(fn=>fn()));
  $.ajax=async request=>{
    calls.push(clone(request));
    if(options.hook) { const override=await options.hook(request); if(override!==undefined)return override; }
    if(request.url.startsWith('/api/v4/leads/custom_fields'))return {_embedded:{custom_fields:clone(fields)}};
    if(request.method==='PATCH'){
      if(options.failWrite)throw {status:503};
      const update=JSON.parse(request.data)[0];
      lead.custom_fields_values=lead.custom_fields_values.filter(f=>f.field_id!==10).concat(update.custom_fields_values);
      return {_embedded:{leads:[{id:100}]}};
    }
    if(request.url==='/api/v4/leads/100')return clone(lead);
    if(request.url==='/api/v4/contacts/200') { if(options.deleted)throw {status:404};return clone(contact); }
    if(request.url.startsWith('/api/v4/contacts?')) {
      if(options.empty)return {};
      if(options.searchError)throw {status:options.searchError};
      return {_embedded:{contacts:options.multiple?[clone(contact),{id:201,name:'Тёзка'}]:[clone(contact)]}};
    }
    if(request.url==='/api/v4/companies/300')return {id:300,name:'Тестовая компания'};
    throw new Error('Unexpected request '+request.url);
  };
  let Widget;
  window.define=(deps,factory)=> {Widget=factory($);};
  window.eval(fs.readFileSync(path.join(__dirname,'../script.js'),'utf8'));
  const widget=new Widget();
  widget.params={path:'/widget'}; widget.get_version=()=> '1.0.0'; widget.get_settings=()=>({});
  widget.render_template=({render})=>$(window.document.body).append(render);
  widget.callbacks.render();
  const status=()=>$('.personal-referrer-status').text();
  return {$,widget,calls,app,status,lead:()=>lead,close:()=>{widget.callbacks.destroy();dom.window.close();},
    ready:()=>until(()=>!$('.personal-referrer-refresh').prop('disabled')),
    search:async text=>{$('.personal-referrer input').val(text).trigger('input');await until(()=>$('.personal-referrer-option').length>0||/не найдены|Лимит|прав/.test(status()));}};
}
test('search, company/phone, save only contact ID, native sync and reopen', async()=>{
  const h=harness();try {
    await h.ready(); await h.search('Те');
    await until(()=>h.$('.personal-referrer-option').text().includes('Тестовая компания'));
    assert.match(h.$('.personal-referrer-option').text(),/\+70000000000/);
    h.$('.personal-referrer-option').first().trigger('click');
    await until(()=>h.status()==='Рекомендатель сохранён.');
    const writes=h.calls.filter(c=>c.method==='PATCH');assert.equal(writes.length,1);
    assert.deepEqual(JSON.parse(writes[0].data),[{id:100,custom_fields_values:[{field_id:10,values:[{value:200}]}]}]);
    assert.equal(h.$('input[name="CFV[10]"]').val(),'200');
    assert.equal(h.$('#unrelated').val(),'unsaved note');
    assert.equal(h.$('.personal-referrer-selected a').attr('href'),'/contacts/detail/200');
    h.widget.callbacks.render(); await h.ready();
    assert.equal(h.$('.personal-referrer-selected a').text(),'Тестовый Контакт');
    assert.equal(h.calls.filter(c=>c.method==='PATCH').length,1);
  } finally {h.close();}
});
test('two symbols minimum, ambiguous search requires click; renders malicious name as text',async()=>{
  const h=harness({multiple:true,xss:true});try{
    await h.ready();h.$('.personal-referrer input').val('Т').trigger('input');await new Promise(r=>setTimeout(r,20));
    assert.equal(h.calls.filter(c=>c.url.includes('query=')).length,0);
    await h.search('Те');await until(()=>h.$('.personal-referrer-option').length===2);
    assert.equal(h.calls.filter(c=>c.method==='PATCH').length,0);
    assert.equal(h.$('.personal-referrer img').length,0);
    assert.match(h.$('.personal-referrer-option').first().text(),/<img/);
  }finally{h.close();}
});
test('empty search never creates a contact; 429 explains error',async()=>{
  for(const opts of [{empty:true},{searchError:429},{searchError:403}]){
    const h=harness(opts);try{await h.ready();await h.search('Ни');
      assert.equal(h.calls.filter(c=>c.method!=='GET').length,0);
      assert.match(h.status(),/не найдены|Лимит|прав/);
    }finally{h.close();}
  }
});
test('channel gate and unsaved field changes disable selection',async()=>{
  const h=harness({channel:false});try{await h.ready();assert.equal(h.$('.personal-referrer input').prop('disabled'),true);}finally{h.close();}
  const h2=harness();try{await h2.ready();h2.$('input[name="CFV[20]"]').val('31').trigger('change');
    assert.equal(h2.$('.personal-referrer input').prop('disabled'),true);
    assert.match(h2.status(),/Сохраните/);
  }finally{h2.close();}
});
test('deleted contact retains ID; write failures never display success or retry',async()=>{
  const h=harness({saved:200,deleted:true});try{await h.ready();assert.match(h.$('.personal-referrer-selected').text(),/Contact ID 200/);assert.equal(h.$('input[name="CFV[10]"]').val(),'200');}finally{h.close();}
  const h2=harness({failWrite:true});try{await h2.ready();await h2.search('Те');h2.$('.personal-referrer-option').first().trigger('click');
    await until(()=>h2.status().includes('Результат записи'));
    assert.equal(h2.calls.filter(c=>c.method==='PATCH').length,1);
    assert.equal(h2.$('input[name="CFV[10]"]').val(),'');
    assert.doesNotMatch(h2.status(),/Рекомендатель сохранён/);
  }finally{h2.close();}
});
test('pending search results discarded after query shortened and on destroy',async()=>{
  let release;
  const pending=new Promise(resolve=>{release=resolve;});
  const h=harness({hook:async req=>{if(req.url.includes('query='))return pending;}});
  try{await h.ready();h.$('.personal-referrer input').val('Те').trigger('input');
    await until(()=>h.calls.some(c=>c.url.includes('query=')));
    h.$('.personal-referrer input').val('Т').trigger('input');
    release({_embedded:{contacts:[{id:200,name:'Stale'}]}});
    await new Promise(r=>setTimeout(r,20));assert.equal(h.$('.personal-referrer-option').length,0);
    h.widget.callbacks.destroy();assert.equal(h.$('.personal-referrer').length,0);
  }finally{h.close();}
});
test('reselecting saved contact does not issue another PATCH',async()=>{
  const h=harness({saved:200});try{await h.ready();await h.search('Те');h.$('.personal-referrer-option').first().trigger('click');
    await until(()=>h.status()==='Рекомендатель сохранён.');
    assert.equal(h.calls.filter(c=>c.method==='PATCH').length,0);
  }finally{h.close();}
});
test('card navigation during verification cancels write',async()=>{
  let release;const pending=new Promise(resolve=>{release=resolve;});let getCount=0;
  const h=harness({hook:async req=>{if(req.url==='/api/v4/contacts/200'){getCount++;return pending;}}});
  try{await h.ready();await h.search('Те');h.$('.personal-referrer-option').first().trigger('click');
    await until(()=>getCount===1);h.app.data.current_card={id:101};release({id:200,name:'Test'});
    await new Promise(r=>setTimeout(r,20));assert.equal(h.calls.filter(c=>c.method==='PATCH').length,0);
  }finally{h.close();}
});
