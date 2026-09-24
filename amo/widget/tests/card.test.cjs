const {test}=require('node:test');
const assert=require('node:assert/strict');
const {JSDOM}=require('jsdom');
const jquery=require('jquery');
const makeCard=require('../src/card.js');
function setup(html) {
  const dom=new JSDOM(html); const $=jquery(dom.window);
  const app={data:{current_card:{id:100,model:{on(){},off(){}}}}};
  return {dom,$,app,card:makeCard($,app,10)};
}
test('native adapter syncs only an unchanged field and emits input/change',()=>{
  const h=setup('<input name="CFV[10]" value="200"><input name="CFV[20]" value="other">');
  try {
    const events=[];h.$('input[name="CFV[10]"]').on('input change',e=>events.push(e.type));
    assert.equal(h.card.sync('200',201),true);assert.deepEqual(events,['input','change']);
    assert.equal(h.$('input[name="CFV[20]"]').val(),'other');
    assert.equal(h.card.sync('200',202),false);assert.equal(h.card.raw(),'201');
    h.app.data.current_card={id:101};assert.equal(h.card.sync('201',202),false);
  }finally{h.dom.window.close();}
});
test('ambiguous, missing, disabled and readonly inputs fail closed',()=>{
  for(const html of ['', '<input name="CFV[10]"><input name="CFV[10]">', '<input name="CFV[10]" disabled>', '<input name="CFV[10]" readonly>']){
    const h=setup(html);try{assert.throws(()=>h.card.raw(),/недоступно/);}finally{h.dom.window.close();}
  }
});
