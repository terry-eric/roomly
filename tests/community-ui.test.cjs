'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {createClient}=require('../community/client.js'),core=require('../core.js');
const root=path.resolve(__dirname,'..');
const deferred=()=>{let resolve;const promise=new Promise(done=>resolve=done);return {promise,resolve};};
const make=(options={})=>{
  const requests=[],renders=[],signals={},stored=new Map(),routes=options.routes||{},space={id:'space1',name:'Team room',location:'Team room',role:'owner',shareEnabled:true};
  const me={user:{email:'owner@example.invalid',name:'Owner'},spaces:[space],calendar:{state:'connected'},mode:'manual'};
  const app={days:()=>options.days||['2026-10-14','2026-10-15','2026-10-16','2026-10-19','2026-10-20'],setLive:data=>renders.push(data)};
  const location={pathname:'/roomly/',search:options.search||'',assign:url=>signals.navigation=url};
  const storage={setItem:(key,value)=>stored.set(key,value),getItem:key=>stored.get(key),removeItem:key=>stored.delete(key)};
  const client=createClient({app,core,location,storage,history:{replaceState:(_state,_title,url)=>signals.cleanURL=url},delay:async()=>{},ui:Object.fromEntries(['session','space','sources','members','invites','invite','newInvite','error','busy','job','message','clear','authorizationNeeded'].map(name=>[name,value=>{signals[name]=value;}])),fetcher:async(url,init)=>{
    const key=init.method+' '+url.replace('/roomly/api/','');requests.push({key,body:init.body&&JSON.parse(init.body)});
    let response=routes[key];if(typeof response==='function')response=await response(requests);
    if(!response){if(key==='GET me')response={body:me};else if(key.includes('/feed?'))response={body:{space:me.spaces.find(s=>key.startsWith('GET spaces/'+s.id+'/'))||space,events:[],sources:[{email:me.user.email,state:'ready',syncedAt:1,calendarCount:1}],rangeMissing:false}};else if(key.endsWith('/members'))response={body:{members:[]}};else response={body:{}};}
    return {ok:!response.status||response.status<400,status:response.status||200,json:async()=>response.body};
  }});
  return {client,requests,renders,signals,stored,me,space};
};

test('opening and changing dates only reads cached feeds, with an exclusive end date',async()=>{
  const h=make();await h.client.init();await h.client.readFeed();
  assert.equal(h.requests.filter(r=>r.key.includes('/sync')).length,0);
  assert(h.requests.filter(r=>r.key.includes('/feed?')).every(r=>r.key.includes('start=2026-10-14&end=2026-10-21')));
  assert(h.requests.every(r=>r.key.startsWith('GET ')));
  assert.equal(h.renders.at(-1).availabilityComplete,true);
});
test('an anonymous first visit displays the sign-in gate without an error alert',async()=>{
  const h=make({routes:{'GET me':{status:401,body:{error:'請先登入'}}}});await h.client.init();
  assert.equal(h.signals.session,null);assert.equal(h.signals.error,'');assert.deepEqual(h.renders.at(-1).events,[]);
  assert(h.requests.every(request=>request.key==='GET me'));
});
test('an OAuth cancellation still explains why sign-in did not complete',async()=>{
  const h=make({search:'?login=cancelled',routes:{'GET me':{status:401,body:{error:'請先登入'}}}});await h.client.init();assert.match(h.signals.error,/取消/);
});
test('a user without a complete calendar grant is guided to authorization before requesting sync',async()=>{
  for(const state of ['unauthorized','reauthorize']){
    const h=make();h.me.calendar.state=state;await h.client.init();await h.client.manualSync();
    assert.equal(h.signals.authorizationNeeded,state);assert(!h.requests.some(request=>request.key.startsWith('POST ')));assert.equal(h.signals.job,undefined);
  }
});
test('manual button is the sole Calendar sync trigger and polls only the explicit job',async()=>{
  const h=make({routes:{'POST spaces/space1/sync':{status:202,body:{job:{id:'job1',status:'queued',total:2,completed:0,succeeded:0,failed:0}}},'GET spaces/space1/jobs/job1':{body:{job:{id:'job1',status:'partial',total:2,completed:2,succeeded:1,failed:1}}}}});
  await h.client.init();assert(!h.requests.some(r=>r.key.includes('/jobs/')));
  await h.client.manualSync();
  assert.deepEqual(h.requests.filter(r=>r.key.startsWith('POST ')),[{key:'POST spaces/space1/sync',body:{start:'2026-10-14',end:'2026-10-21'}}]);
  assert.equal(h.requests.filter(r=>r.key.includes('/jobs/')).length,1);
  assert.equal(h.signals.busy,false);
});
test('unauthorized and stale sources cannot mark unknown room time as free',async()=>{
  const h=make({routes:{'GET spaces/space1/feed?start=2026-10-14&end=2026-10-21':{body:{events:[],sources:[{state:'unauthorized',syncedAt:0}],rangeMissing:true}}}});
  await h.client.init();assert.equal(h.renders.at(-1).availabilityComplete,false);assert.equal(h.renders.at(-1).events.length,0);
});
test('a removed membership clears visible meeting data and a failed feed retains no private details',async()=>{
  const h=make();await h.client.init();
  h.me.spaces=[];await h.client.refreshMe();
  assert.deepEqual(h.renders.at(-1).events,[]);assert.equal(h.renders.at(-1).ready,false);
  assert.equal(h.signals.space,null);assert.deepEqual(h.signals.members,[]);assert.equal(h.signals.busy,false);
});
test('invite survives Google redirect, but is removed after successful matching-email acceptance',async()=>{
  const token='a'.repeat(64),h=make({search:'?invite='+token,routes:{'POST invites/preview':{body:{invite:{spaceId:'space1',spaceName:'Team room',email:'owner@example.invalid',canAccept:true}}},'POST invites/accept':{body:{space:{id:'space1'}}}}});
  await h.client.init();assert.equal(h.stored.get('roomly.public.invite'),token);assert.equal(h.signals.cleanURL,'/roomly/');
  await assert.rejects(h.client.acceptInvite(false),/同意/);assert(!h.requests.some(r=>r.key==='POST invites/accept'));
  await h.client.acceptInvite(true);assert(!h.stored.has('roomly.public.invite'));
  assert.deepEqual(h.requests.find(r=>r.key==='POST invites/accept').body,{token,shareConsent:true});
});
test('logout and personal calendar disconnect remove displayed meetings; no event persistence',async()=>{
  const h=make();await h.client.init();await h.client.disconnect();await h.client.logout();
  assert.equal(h.signals.session,null);assert.deepEqual(h.renders.at(-1).events,[]);assert.equal(h.stored.size,0);
  assert(!h.requests.some(r=>r.key.endsWith('/sync')));
});
test('authorization never redirects to an arbitrary server URL',async()=>{
  const h=make({routes:{'POST calendar/start':{body:{url:'https://example.invalid/steal'}}}});await h.client.init();await assert.rejects(h.client.authorize(),/無效/);assert.equal(h.signals.navigation,undefined);
});
test('a delayed identity response cannot restore the session after logout',async()=>{
  const routes={},h=make({routes});await h.client.init();const wait=deferred();routes['GET me']=()=>wait.promise;
  const stale=h.client.refreshMe();await h.client.logout();wait.resolve({body:h.me});await stale;
  assert.equal(h.signals.session,null);assert.equal(h.signals.space,null);assert.deepEqual(h.renders.at(-1).events,[]);
});
test('pending invitation metadata remains manageable after reload without recovering secret links',async()=>{
  const routes={'GET spaces/space1/members':{body:{members:[],invites:[{id:'invite1',email:'guest@example.invalid',expiresAt:1791970000}]}}},h=make({routes});await h.client.init();
  assert.deepEqual(h.signals.invites,[{id:'invite1',email:'guest@example.invalid',expiresAt:1791970000}]);assert(!Object.hasOwn(h.signals.invites[0],'url'));
  routes['GET spaces/space1/members']={body:{members:[],invites:[]}};await h.client.revokeInvite('invite1');
  assert.deepEqual(h.signals.invites,[]);assert(h.requests.some(r=>r.key==='POST spaces/space1/invites/invite1/revoke'));
});
test('creating an invitation refreshes the pending list immediately while retaining only its current secret link',async()=>{
  const pending={id:'invite1',email:'guest@example.invalid',expiresAt:1791970000},invite={...pending,url:'https://example.invalid/roomly/?invite=secret'},routes={'GET spaces/space1/members':{body:{members:[],invites:[]}}},h=make({routes});
  routes['POST spaces/space1/invites']=()=>{routes['GET spaces/space1/members']={body:{members:[],invites:[pending]}};return {body:{invite}};};
  await h.client.init();assert.deepEqual(h.signals.invites,[]);await h.client.invite(pending.email);
  assert.deepEqual(h.signals.invites,[pending]);assert.equal(h.signals.newInvite.url,invite.url);assert(!Object.hasOwn(h.signals.invites[0],'url'));
});
test('an invitation returned for a previous space never appears in the next space',async()=>{
  const wait=deferred(),h=make({routes:{'POST spaces/space1/invites':()=>wait.promise}});h.me.spaces.push({...h.space,id:'space2',name:'Other room'});await h.client.init();
  const oldInvite=h.client.invite('guest@example.invalid');await h.client.selectSpace('space2');
  wait.resolve({body:{invite:{id:'invite1',email:'guest@example.invalid',url:'https://example.invalid/private-token'}}});
  assert.equal(await oldInvite,null);assert.equal(h.signals.newInvite,undefined);assert.equal(h.signals.space.id,'space2');
});
test('a previous manual run cannot unset the busy state of a new space run',async()=>{
  const a=deferred(),b=deferred(),h=make({routes:{'POST spaces/space1/sync':()=>a.promise,'POST spaces/space2/sync':()=>b.promise}});h.me.spaces.push({...h.space,id:'space2'});await h.client.init();
  const previous=h.client.manualSync();await h.client.selectSpace('space2');const current=h.client.manualSync();
  a.resolve({body:{job:{id:'old',status:'queued'}}});await previous;assert.equal(h.signals.busy,true);
  b.resolve({body:{job:{id:'new',status:'error',total:1,completed:1,failed:1,succeeded:0}}});await current;assert.equal(h.signals.busy,false);
  assert(!h.requests.some(r=>r.key==='GET spaces/space1/jobs/old'));
});
test('a stale feed from a previously selected space never paints meetings into the current one',async()=>{
  const routes={},h=make({routes});h.me.spaces.push({...h.space,id:'space2'});await h.client.init();const wait=deferred();routes['GET spaces/space1/feed?start=2026-10-14&end=2026-10-21']=()=>wait.promise;
  const old=h.client.readFeed();await h.client.selectSpace('space2');
  wait.resolve({body:{space:h.space,events:[{id:'old',summary:'Private previous meeting',start:{dateTime:'2026-10-14T10:00:00+08:00'},end:{dateTime:'2026-10-14T11:00:00+08:00'}}],sources:[{state:'ready'}],rangeMissing:false}});await old;
  assert.equal(h.renders.at(-1).rooms[0].id,'space2');assert.deepEqual(h.renders.at(-1).events,[]);
});
test('service worker never caches navigation, API, OAuth or invitation query responses',async()=>{
  const vm=require('node:vm'),listeners={},writes=[],cacheNames=[];
  const cache={addAll:async values=>writes.push(...values),put:async request=>writes.push(request.url),match:async()=>null};
  vm.runInNewContext(fs.readFileSync(path.join(root,'community/sw.js'),'utf8'),{URL,Set,self:{location:{origin:'https://demo.terry878.org'},addEventListener:(name,fn)=>listeners[name]=fn,skipWaiting:async()=>{},clients:{claim:async()=>{}}},caches:{open:async name=>{cacheNames.push(name);return cache;},keys:async()=>['roomly-public-v1','another-app','roomly-community-assets-old'],delete:async name=>cacheNames.push('deleted:'+name)},fetch:async()=>({ok:true,type:'basic',redirected:false,clone(){return this;}})});
  let install;listeners.install({waitUntil:value=>install=value});await install;
  assert(writes.every(url=>url.startsWith('/roomly/')&&!/\.html|api\//.test(url)));
  for(const request of [{url:'/roomly/api/me',method:'GET',mode:'cors'},{url:'/roomly/api/calendar/callback?code=secret',method:'GET',mode:'navigate'},{url:'/roomly/?invite=secret',method:'GET',mode:'navigate'},{url:'/roomly/index.html',method:'GET',mode:'navigate'},{url:'/roomly/core.js?invite=secret',method:'GET',mode:'cors'},{url:'/roomly/api/spaces/space1/sync',method:'POST',mode:'cors'}]){
    let handled=false;listeners.fetch({request:{...request,url:'https://demo.terry878.org'+request.url},respondWith:()=>handled=true});assert.equal(handled,false,request.url);
  }
  let served;listeners.fetch({request:{url:'https://demo.terry878.org/roomly/core.js',method:'GET',mode:'cors'},respondWith:value=>served=value});await served;assert(writes.includes('https://demo.terry878.org/roomly/core.js'));
  let activation;listeners.activate({waitUntil:value=>activation=value});await activation;
  assert(cacheNames.includes('deleted:roomly-public-v1'));assert(cacheNames.includes('deleted:roomly-community-assets-old'));assert(!cacheNames.includes('deleted:another-app'));
});
test('public builds isolate browser assets and keep the fictional preview separate',async()=>{
  const {buildCommunity,COMMUNITY_FILES,privateStorageFreeApp}=await import('../scripts/build-community.mjs');
  const {buildPages,PAGES_FILES}=await import('../scripts/build-pages.mjs');
  const community=await buildCommunity(),pages=await buildPages();
  assert.deepEqual(fs.readdirSync(path.join(community,'roomly')).sort(),[...COMMUNITY_FILES].sort());
  assert.deepEqual(fs.readdirSync(pages).sort(),[...PAGES_FILES].sort());
  const html=fs.readFileSync(path.join(community,'roomly/index.html'),'utf8'),app=fs.readFileSync(path.join(community,'roomly/app.js'),'utf8'),landing=fs.readFileSync(path.join(pages,'index.html'),'utf8');
  const {Script}=require('node:vm');
  for(const file of COMMUNITY_FILES.filter(file=>file.endsWith('.js')))assert.doesNotThrow(()=>new Script(fs.readFileSync(path.join(community,'roomly',file),'utf8'),{filename:file}),`${file} must compile as the actual deployed browser script`);
  assert.match(app,/window\.RoomApp=\{[^\r\n]+,showDemo:\(\)=>\{\}\};/);
  assert.match(html,/<main id="community-main" hidden>/);assert.match(html,/<script src="community-bootstrap.js"/);
  assert(!/(?:access|google|config)\.js|demo-fixtures|admin\.html/.test(html));
  assert(!/roomly\.bookings|roomly\.single-room|mode='local'/.test(app));
  assert.equal((app.match(/localStorage/g)||[]).length,2);
  assert.match(app,/roomly\.public\.'/);
  assert.match(landing,/https:\/\/demo\.terry878\.org\/roomly\//);assert(!/<script/.test(landing));
  assert.match(fs.readFileSync(path.join(root,'community/support.html'),'utf8'),/尚未開放收款/);
  assert(!/paypal|buymeacoffee|checkout|付款按鈕/i.test(fs.readFileSync(path.join(root,'community/support.html'),'utf8')));
  assert.throws(()=>privateStorageFreeApp(fs.readFileSync(path.join(root,'app.js'),'utf8')+'\nlocalStorage.setItem("private",data);'));
  assert.match(fs.readFileSync(path.join(root,'package.json'),'utf8'),/"demo": "node scripts\/serve-demo.mjs"/);
});

test('community transform retains a valid RoomApp export and rejects syntactically broken shared output',async()=>{
  const {privateStorageFreeApp}=await import('../scripts/build-community.mjs'),{Script}=require('node:vm');
  const source=fs.readFileSync(path.join(root,'app.js'),'utf8'),transformed=privateStorageFreeApp(source);
  assert.doesNotThrow(()=>new Script(transformed));
  assert.match(transformed,/window\.RoomApp=\{[^\r\n]+,showDemo:\(\)=>\{\}\};/);
  assert.throws(()=>privateStorageFreeApp(source+'\nconst invalid = ;'),SyntaxError,'syntax validation must reject bad generated output before deployment');
  assert.throws(()=>privateStorageFreeApp(source.replace('window.RoomApp=','window.UnexpectedApp=')),/export changed/,'an unfamiliar export must fail closed instead of producing broken JavaScript');
});
test('GitHub Pages can point all service links to an own HTTPS deployment and rejects mixed or unsafe targets',async t=>{
  const {buildPages}=await import('../scripts/build-pages.mjs'),os=require('node:os'),temporaryRoot=path.resolve(os.tmpdir()),project=fs.mkdtempSync(path.join(temporaryRoot,'roomly-pages-'));
  t.after(()=>{assert.equal(path.dirname(path.resolve(project)),temporaryRoot);assert(path.basename(project).startsWith('roomly-pages-'));fs.rmSync(project,{recursive:true,force:true});});
  fs.mkdirSync(path.join(project,'community'));
  for(const file of ['community.css','pages.css'])fs.copyFileSync(path.join(root,'community',file),path.join(project,'community',file));fs.copyFileSync(path.join(root,'icon-192.png'),path.join(project,'icon-192.png'));
  const source=fs.readFileSync(path.join(root,'community/pages.html'),'utf8').replaceAll('https://demo.terry878.org/roomly/','https://roomly.example.com/roomly/');
  fs.writeFileSync(path.join(project,'community/pages.html'),source);const built=await buildPages({projectDir:project});
  const published=fs.readFileSync(path.join(built,'index.html'),'utf8');assert.match(published,/data-service-entry href="https:\/\/roomly\.example\.com\/roomly\/"/);assert(!published.includes('demo.terry878.org'));
  fs.writeFileSync(path.join(project,'community/pages.html'),source.replace('data-service-entry href="https://roomly.example.com/roomly/"','data-service-entry href="http://roomly.example.com/roomly/"'));await assert.rejects(buildPages({projectDir:project}),/HTTPS/);
  fs.writeFileSync(path.join(project,'community/pages.html'),source.replace('https://roomly.example.com/roomly/support.html','https://other.example.com/roomly/support.html'));await assert.rejects(buildPages({projectDir:project}),/entry origin/);
});
