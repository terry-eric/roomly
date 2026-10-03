const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const settle=()=>new Promise(resolve=>setImmediate(resolve));
function harness(){
 const nodes=new Map(),calls=[],timers=[];
 class Node{
  constructor(tag='div',text=''){this.tag=tag;this.textContent=text;this.children=[];this.listeners=new Map();this.disabled=false;this.value='';}
  append(...children){this.children.push(...children);}
  replaceChildren(...children){this.children=children;}
  addEventListener(type,fn){this.listeners.set(type,fn);}
  querySelectorAll(tag){return this.children.flatMap(child=>[...(child.tag===tag?[child]:[]),...child.querySelectorAll(tag)]);}
  async click(){if(this.onclick)await this.onclick({target:this});if(this.listeners.has('click'))await this.listeners.get('click')({target:this});}
 }
 const el=selector=>{if(!nodes.has(selector))nodes.set(selector,new Node());return nodes.get(selector);};
 const member=(sub,status)=>({sub,email:sub+'@gmail.com',name:sub,status,role:'member',requested_at:1});
 const data={members:[member('pending','pending'),member('active','approved'),member('removed','rejected')]},allowlist={emails:[{email:'active@gmail.com',status:'approved',member_sub:'active'},{email:'removed@gmail.com',status:'revoked'}]};
 const context={RoomlyAccess:{ready:Promise.resolve(true),request:async(path,body)=>{
  calls.push({path,body});if(path==='admin/members')return data;if(path==='admin/allowlist')return allowlist;
  if(path==='admin/allowlist/remove'){allowlist.emails.find(e=>e.email===body.email).status='revoked';data.members.find(m=>m.email===body.email).status='rejected';return {ok:true};}
  if(path==='admin/review'){data.members.find(m=>m.sub===body.sub).status=body.status;return {ok:true};}
  throw Error('Unexpected admin request');
 }},document:{hidden:false,createElement:tag=>new Node(tag),querySelector:el},Intl,Date,setInterval:fn=>timers.push(fn)};
 context.window=context;vm.createContext(context);vm.runInContext(fs.readFileSync(require.resolve('../admin.js'),'utf8'),context);
 const text=node=>[node.textContent,...node.children.map(text)].join(' ');
 return {el,calls,timers,data,allowlist,text};
}

test('administration hides revoked emails and rejected applicants even in a historical server reply',async()=>{
 const h=harness();await settle();assert.match(h.text(h.el('#allowlist-members')),/active@gmail.com/);assert.doesNotMatch(h.text(h.el('#allowlist-members')),/removed@gmail.com|重新加入/);
 assert.match(h.text(h.el('#pending-members')),/pending@gmail.com/);assert.match(h.text(h.el('#reviewed-members')),/active@gmail.com/);assert.doesNotMatch(h.text(h.el('#reviewed-members')),/removed@gmail.com/);assert.equal(h.el('#pending-heading').textContent,'待審核 · 1');
});

test('removing access reloads both displayed lists and the former member remains absent on the next poll',async()=>{
 const h=harness();await settle();const remove=h.el('#allowlist-members').querySelectorAll('button').find(button=>button.textContent==='移除資格');await remove.click();
 assert.equal(h.calls.filter(call=>call.path==='admin/allowlist/remove').length,1);assert.doesNotMatch(h.text(h.el('#allowlist-members')),/active@gmail.com/);assert.doesNotMatch(h.text(h.el('#reviewed-members')),/active@gmail.com/);
 assert.equal(h.allowlist.emails.find(e=>e.email==='active@gmail.com').status,'revoked');assert.equal(h.data.members.find(m=>m.sub==='active').status,'rejected');
 h.timers[0]();await settle();assert.doesNotMatch(h.text(h.el('#allowlist-members')),/active@gmail.com/);assert.doesNotMatch(h.text(h.el('#reviewed-members')),/active@gmail.com/);
});
