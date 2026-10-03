const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
function harness({supported=true,requestFails=false,exitFails=false,pending=false}={}){
  const events={},classes=new Set(),changes=[],scrolls=[],attrs={};let requests=0,exits=0,focuses=0,modal=false,release;
  const button={disabled:false,textContent:'全螢幕',setAttribute:(key,value)=>attrs[key]=value,focus:()=>focuses++};
  const document={body:{classList:{toggle:(name,value)=>value?classes.add(name):classes.delete(name)}},documentElement:{},fullscreenElement:null,fullscreenEnabled:supported,addEventListener:(name,fn)=>events[name]=fn,querySelector:selector=>selector==='#board-fullscreen'?button:modal?{}:null};
  const enter=()=>{document.fullscreenElement=document.documentElement;events.fullscreenchange();};
  if(supported)document.documentElement.requestFullscreen=async()=>{requests++;if(requestFails)throw Error('unsupported');if(pending)await new Promise(resolve=>release=resolve);enter();};
  document.exitFullscreen=async()=>{exits++;if(exitFails)throw Error('blocked');document.fullscreenElement=null;events.fullscreenchange();};
  const context={document,Event:class{constructor(type){this.type=type;}},scrollX:0,scrollY:180,scrollTo:position=>scrolls.push(position),dispatchEvent:event=>changes.push(event.type)};context.window=context;vm.createContext(context);vm.runInContext(fs.readFileSync(require.resolve('../fullscreen.js'),'utf8'),context);
  return {button,document,classes,attrs,changes,scrolls,events,get requests(){return requests;},get exits(){return exits;},get focuses(){return focuses;},set modal(value){modal=value;},release:()=>release()};
}
test('native fullscreen is user initiated, with a working exit and restored scroll position',async()=>{
  const h=harness();assert.equal(h.requests,0);await h.button.onclick();assert.equal(h.requests,1);assert.ok(h.classes.has('board-fullscreen'));assert.equal(h.attrs['aria-pressed'],'true');assert.equal(h.button.textContent,'退出全螢幕');await h.button.onclick();assert.equal(h.exits,1);assert.equal(h.classes.has('board-fullscreen'),false);assert.equal(h.attrs['aria-pressed'],'false');assert.equal(h.scrolls.at(-1).top,180);assert.equal(h.focuses,1);
});
test('browser Escape or leaving native fullscreen restores the normal board',async()=>{
  const h=harness();await h.button.onclick();h.document.fullscreenElement=null;h.events.fullscreenchange();assert.equal(h.classes.size,0);assert.equal(h.button.textContent,'全螢幕');assert.equal(h.focuses,1);
});
test('unsupported and rejected fullscreen still provide a reversible viewport preview',async()=>{
  for(const options of [{supported:false},{requestFails:true}]){const h=harness(options);await h.button.onclick();assert.ok(h.classes.has('board-fullscreen'));assert.equal(h.button.disabled,false);h.modal=true;h.events.keydown({key:'Escape'});assert.ok(h.classes.has('board-fullscreen'));h.modal=false;h.events.keydown({key:'Escape'});assert.equal(h.classes.size,0);await h.button.onclick();await h.button.onclick();assert.equal(h.classes.size,0);}
});
test('duplicate taps cannot start competing fullscreen requests',async()=>{
  const h=harness({pending:true});const first=h.button.onclick();await h.button.onclick();assert.equal(h.requests,1);assert.equal(h.button.disabled,true);h.events.keydown({key:'Escape'});assert.ok(h.classes.has('board-fullscreen'));h.release();await first;assert.equal(h.button.disabled,false);await h.button.onclick();assert.equal(h.classes.size,0);
});
test('a failed native exit leaves the exit button usable',async()=>{
  const h=harness({exitFails:true});await h.button.onclick();await h.button.onclick();assert.ok(h.classes.has('board-fullscreen'));assert.equal(h.button.disabled,false);assert.equal(h.button.textContent,'退出全螢幕');h.document.fullscreenElement=null;h.events.fullscreenchange();assert.equal(h.classes.size,0);
});
test('fallback preview Escape does not query an unsupported Popover selector or close an open name',async()=>{
  const h=harness({supported:false}),query=h.document.querySelector;let open=true;
  h.document.querySelector=selector=>{assert.ok(!selector.includes(':popover-open'));return selector==='#person-popover'?{dataset:{open:String(open)}}:query(selector);};
  await h.button.onclick();h.events.keydown({key:'Escape'});assert.ok(h.classes.has('board-fullscreen'));
  open=false;h.events.keydown({key:'Escape'});assert.equal(h.classes.size,0);
});
