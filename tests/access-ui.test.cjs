const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
function harness(user){
 const elements=new Map(),intervals=[],events=[];
 const el=selector=>{if(!elements.has(selector))elements.set(selector,{hidden:true,textContent:'',addEventListener(){}});return elements.get(selector);};
 const context={document:{body:{dataset:{page:'board'}},hidden:false,querySelector:el},fetch:async()=>({ok:true,json:async()=>({...user})}),AbortSignal,location:{replace(){}},setInterval:fn=>intervals.push(fn),CustomEvent:class{constructor(type,options){this.type=type;this.detail=options?.detail;}},dispatchEvent:event=>{events.push(event);return true;}};context.window=context;vm.createContext(context);vm.runInContext(fs.readFileSync(require.resolve('../access.js'),'utf8'),context);
 return {el,intervals,events,context,access:context.RoomlyAccess};
}
test('administrator always sees whitelist management in navigation and settings, with pending count and account identity',async()=>{
 const user={email:'roomly-admin@gmail.com',status:'approved',isAdmin:true,pending:2},h=harness(user);await h.access.ready;
 for(const selector of ['#admin-link','#settings-admin-link']){assert.equal(h.el(selector).hidden,false);assert.match(h.el(selector).textContent,/白名單管理/);assert.match(h.el(selector).textContent,/2 筆待審核/);}
 assert.equal(h.el('#current-account').textContent,user.email);assert.match(h.el('#account-role').textContent,/管理員/);user.pending=0;await h.access.ensureAllowed();assert.equal(h.el('#admin-link').textContent,'白名單管理');
});
test('member identity explains missing management rights, and polling removes admin links after role changes',async()=>{
 const user={email:'roomly-admin@gmail.com',status:'approved',isAdmin:true,pending:0},h=harness(user);await h.access.ready;Object.assign(user,{email:'member@example.com',isAdmin:false});await h.access.ensureAllowed();for(const selector of ['#admin-link','#settings-admin-link'])assert.equal(h.el(selector).hidden,true);assert.equal(h.el('#current-account').textContent,user.email);assert.match(h.el('#account-role').textContent,/一般成員/);
});

test('Google sign-in follows the card width on rotation without resetting the login challenge',async()=>{
 const elements=new Map(),renders=[],observers=[],initializations=[];
 const el=selector=>{if(!elements.has(selector))elements.set(selector,{hidden:false,clientWidth:233,textContent:'',addEventListener(){},replaceChildren(){}});return elements.get(selector);};
 const context={document:{body:{dataset:{page:'gate'}},hidden:false,querySelector:el},google:{accounts:{id:{initialize:options=>initializations.push(options),renderButton:(host,options)=>renders.push(options)}}},fetch:async url=>url.endsWith('/me')?{ok:false,status:401,json:async()=>({error:'登入'})}:{ok:true,json:async()=>({clientId:'fixture-client',nonce:'fixture-nonce',loginUri:'https://roomly.example.com/roomly/api/login/redirect'})},ResizeObserver:class{constructor(callback){observers.push(callback);}observe(){}},AbortSignal,location:{replace(){}},setInterval(){}};context.window=context;vm.createContext(context);vm.runInContext(fs.readFileSync(require.resolve('../access.js'),'utf8'),context);await context.RoomlyAccess.ready;await new Promise(resolve=>setImmediate(resolve));
 assert.equal(renders[0].width,'233');assert.equal(initializations.length,1);const host=el('#sign-in-button');host.clientWidth=180;observers[0]();assert.equal(renders.at(-1).width,'180');host.clientWidth=500;observers[0]();assert.equal(renders.at(-1).width,'300');const count=renders.length;observers[0]();host.hidden=true;host.clientWidth=250;observers[0]();assert.equal(renders.length,count);assert.equal(initializations.length,1);
 assert.equal(initializations[0].ux_mode,'redirect');assert.equal(initializations[0].login_uri,'https://roomly.example.com/roomly/api/login/redirect');assert.equal(initializations[0].nonce,'fixture-nonce');
});

test('idle login refreshes its nonce before expiration and a rejected return has a fresh retry button',async()=>{
 const elements=new Map(),initializations=[],timers=[];let clock=1000,requests=0;
 const el=selector=>{if(!elements.has(selector))elements.set(selector,{hidden:false,clientWidth:260,textContent:'',addEventListener(){},replaceChildren(){}});return elements.get(selector);};
 const context={document:{body:{dataset:{page:'gate'}},hidden:false,querySelector:el},google:{accounts:{id:{initialize:options=>initializations.push(options),renderButton(){}}}},fetch:async url=>url.endsWith('/me')?{ok:false,status:401,json:async()=>({error:'登入'})}:{ok:true,json:async()=>({clientId:'client',nonce:'nonce-'+(++requests),loginUri:'https://roomly.example.com/roomly/api/login/redirect'})},Date:{now:()=>clock},AbortSignal,location:{search:'?login=expired',replace(){}},setInterval:fn=>timers.push(fn)};context.window=context;vm.createContext(context);vm.runInContext(fs.readFileSync(require.resolve('../access.js'),'utf8'),context);await context.RoomlyAccess.ready;await new Promise(resolve=>setImmediate(resolve));
 assert.equal(initializations.length,1);assert.match(el('#access-status').textContent,/再按一次/);
 clock+=7*60000;await timers[0]();await new Promise(resolve=>setImmediate(resolve));assert.equal(initializations.length,1);
 clock+=60000;await timers[0]();await new Promise(resolve=>setImmediate(resolve));assert.equal(initializations.length,2);assert.equal(initializations[1].nonce,'nonce-2');
});

test('popup fallback posts its nonce and refreshes a failed challenge before retrying',async()=>{
 const elements=new Map(),initializations=[],posts=[],navigations=[];let challenges=0;
 const el=selector=>{if(!elements.has(selector))elements.set(selector,{hidden:false,clientWidth:260,textContent:'',addEventListener(){},replaceChildren(){}});return elements.get(selector);};
 const context={document:{body:{dataset:{page:'gate'}},hidden:false,querySelector:el},google:{accounts:{id:{initialize:options=>initializations.push(options),renderButton(){}}}},fetch:async(url,options)=>{
   if(url.endsWith('/me'))return {ok:false,status:401,json:async()=>({error:'登入'})};
   if(url.endsWith('/challenge'))return {ok:true,json:async()=>({clientId:'client',nonce:'nonce-'+(++challenges),loginUri:''})};
   posts.push(JSON.parse(options.body));return posts.length===1?{ok:false,status:401,json:async()=>({error:'登入已失效'})}:{ok:true,json:async()=>({ok:true})};
 },AbortSignal,location:{replace:url=>navigations.push(url)},setInterval(){}};context.window=context;vm.createContext(context);vm.runInContext(fs.readFileSync(require.resolve('../access.js'),'utf8'),context);await context.RoomlyAccess.ready;await new Promise(resolve=>setImmediate(resolve));
 assert.equal(initializations[0].ux_mode,'popup');assert.equal(initializations[0].login_uri,undefined);assert.equal(typeof initializations[0].callback,'function');
 await initializations[0].callback({credential:'credential-1'});assert.deepEqual(posts[0],{credential:'credential-1',nonce:'nonce-1'});assert.equal(challenges,2);assert.equal(initializations[1].nonce,'nonce-2');assert.match(el('#access-status').textContent,/再按一次/);
 await initializations[1].callback({credential:'credential-2'});assert.deepEqual(posts[1],{credential:'credential-2',nonce:'nonce-2'});assert.deepEqual(navigations,['/roomly/?login=success']);
});

function gateHarness({loginStartUri='https://roomly.example.com/roomly/api/login/start',googleReady=false,search='',challengeReply,abortSignal=AbortSignal,abortController=AbortController,requestReply}={}){
 const elements=new Map(),timers=[],requests=[],requestOptions=[],navigations=[],initializations=[],renders=[],deadlineTimers=new Map(),timerDelays=[];let clock=1000,user=null,timerId=0;
 const el=selector=>{
  if(!elements.has(selector)){const listeners=new Map();elements.set(selector,{hidden:false,clientWidth:180,textContent:'',href:selector==='#server-sign-in'?'/roomly/api/login/start':'',replaceChildren(){},addEventListener(name,fn){if(!listeners.has(name))listeners.set(name,[]);listeners.get(name).push(fn);},dispatch(name){for(const fn of listeners.get(name)||[])fn();}});}return elements.get(selector);
 };
 const google={accounts:{id:{initialize:options=>initializations.push(options),renderButton:(host,options)=>renders.push(options)}}};
 const context={document:{body:{dataset:{page:'gate'}},hidden:false,querySelector:el},fetch:async(url,options)=>{
  requests.push(url);requestOptions.push(options);if(requestReply){const reply=await requestReply(url,options);if(reply)return reply;}
  if(url.endsWith('/me'))return user?{ok:true,json:async()=>({...user})}:{ok:false,status:401,json:async()=>({error:'登入'})};
  if(url.endsWith('/challenge'))return {ok:true,json:async()=>challengeReply?challengeReply():({clientId:'client',nonce:'fixture-nonce',loginUri:'https://roomly.example.com/roomly/api/login/redirect',loginStartUri})};
  throw Error('Unexpected automatic request: '+url);
 },Date:{now:()=>clock},AbortSignal:abortSignal,AbortController:abortController,location:{origin:'https://roomly.example.com',pathname:'/roomly/',search,replace:url=>navigations.push(url)},setInterval:fn=>timers.push(fn),setTimeout:(fn,ms)=>{const id=++timerId;deadlineTimers.set(id,fn);timerDelays.push(ms);return id;},clearTimeout:id=>deadlineTimers.delete(id)};
 if(abortSignal===null)delete context.AbortSignal;if(abortController===null)delete context.AbortController;
 if(googleReady)context.google=google;context.window=context;vm.createContext(context);vm.runInContext(fs.readFileSync(require.resolve('../access.js'),'utf8'),context);
 return {el,timers,requests,requestOptions,navigations,initializations,renders,deadlineTimers,timerDelays,context,access:context.RoomlyAccess,google,setUser(value){user=value;},advance(ms){clock+=ms;},expireRequests(){for(const fn of [...deadlineTimers.values()])fn();}};
}
const settle=()=>new Promise(resolve=>setImmediate(resolve));

test('server Google login is a same-window native link without GIS or automatic OAuth navigation',async()=>{
 for(const googleReady of [false,true]){
  const h=gateHarness({googleReady});await h.access.ready;await settle();
  assert.equal(h.el('#server-sign-in').hidden,false);assert.equal(h.el('#server-sign-in').href,'/roomly/api/login/start');assert.equal(h.el('#sign-in-button').hidden,true);assert.equal(h.el('#sign-in-fallback').hidden,true);
  assert.equal(h.initializations.length,0);assert.equal(h.renders.length,0);assert.equal(h.navigations.length,0);assert.ok(h.requests.every(url=>!url.endsWith('/login/start')));
  const message=h.el('#access-status').textContent;h.el('#gis').dispatch('error');h.context.google=h.google;h.el('#gis').dispatch('load');
  assert.equal(h.el('#server-sign-in').hidden,false);assert.equal(h.el('#access-status').textContent,message);assert.equal(h.initializations.length,0);
 }
 const html=fs.readFileSync(require.resolve('../auth.html'),'utf8'),anchor=/<a id="server-sign-in"[^>]*>/.exec(html)[0];
 assert.match(anchor,/href="\/roomly\/api\/login\/start"/);assert.doesNotMatch(anchor,/target=|onclick=|\bhidden\b/);
});

test('older browsers without AbortSignal.timeout can load access and offer native Google login',async()=>{
 for(const options of [{abortSignal:{}},{abortSignal:null,abortController:null}]){
  const h=gateHarness(options);await h.access.ready;await settle();
  assert.equal(h.el('#server-sign-in').hidden,false);assert.equal(h.el('#server-sign-in').href,'/roomly/api/login/start');
  assert.equal(h.el('#sign-in-button').hidden,true);assert.deepEqual(h.navigations,[]);assert.equal(h.initializations.length,0);
  assert.deepEqual(h.requests,['/roomly/api/me','/roomly/api/challenge']);assert.equal(h.deadlineTimers.size,0);assert.deepEqual(h.timerDelays,[15000,15000]);
  assert.ok(h.requestOptions.every(options=>options.credentials==='same-origin'));
 }
});

test('native Google link remains available when an access request cannot finish',async()=>{
 const h=gateHarness({abortSignal:null,abortController:null,requestReply:()=>new Promise(()=>{})});await settle();
 assert.equal(h.el('#server-sign-in').hidden,false);assert.equal(h.el('#server-sign-in').href,'/roomly/api/login/start');
 h.expireRequests();await h.access.ready;assert.equal(h.deadlineTimers.size,0);assert.match(h.el('#access-status').textContent,/暫時無法連線/);assert.deepEqual(h.navigations,[]);
});

test('fallback request deadline covers JSON bodies and cancels fetch when supported',async()=>{
 for(const abortController of [AbortController,null]){
  const h=gateHarness({abortSignal:null,abortController});await h.access.ready;await settle();
  let requestSignal;h.context.fetch=async(url,options)=>{requestSignal=options.signal;return {ok:true,json:()=>new Promise(()=>{})};};
  const failed=assert.rejects(h.access.request('calendar/feed'),/暫時無法連線/);await settle();
  assert.equal(h.deadlineTimers.size,1);assert.equal(h.timerDelays.at(-1),60000);
  h.expireRequests();await failed;assert.equal(h.deadlineTimers.size,0);
  if(abortController)assert.equal(requestSignal.aborted,true);else assert.equal(requestSignal,undefined);
  assert.deepEqual(h.navigations,[]);
 }
});

test('fallback deadlines clear after body success and preserve HTTP and parsing failures',async()=>{
 const h=gateHarness({abortSignal:{}});await h.access.ready;await settle();let finishBody;
 h.context.fetch=async()=>({ok:true,json:()=>new Promise(resolve=>{finishBody=resolve;})});
 const pending=h.access.request('calendar/feed');await settle();assert.equal(h.deadlineTimers.size,1);
 finishBody({ok:true});assert.equal((await pending).ok,true);assert.equal(h.deadlineTimers.size,0);
 h.context.fetch=async()=>({ok:false,status:403,json:async()=>({error:'未取得資格'})});
 await assert.rejects(h.access.request('me'),error=>error.status===403&&error.message==='未取得資格');assert.equal(h.deadlineTimers.size,0);
 h.context.fetch=async()=>{throw Error('offline');};await assert.rejects(h.access.request('me'),/暫時無法連線/);assert.equal(h.deadlineTimers.size,0);
 h.context.fetch=async()=>({ok:true,json:async()=>{throw Error('invalid JSON');}});await assert.rejects(h.access.request('me'),/invalid JSON/);assert.equal(h.deadlineTimers.size,0);
});

test('server login remains clickable after expired, cancelled or failed returns and idle polling never starts OAuth',async()=>{
 for(const outcome of ['expired','cancelled','failed']){
  const h=gateHarness({search:'?login='+outcome});await h.access.ready;await settle();assert.equal(h.el('#server-sign-in').hidden,false);assert.match(h.el('#access-status').textContent,/再按一次|再試一次/);
  h.advance(9*60000);await h.timers[0]();await settle();assert.equal(h.el('#server-sign-in').href,'/roomly/api/login/start');assert.equal(h.el('#server-sign-in').hidden,false);assert.equal(h.navigations.length,0);assert.equal(h.initializations.length,0);assert.ok(h.requests.every(url=>!url.endsWith('/login/start')));
 }
});

test('pending and rejected sessions hide all login entries, including a challenge that completes late',async()=>{
 for(const status of ['pending','rejected']){
  let resolveChallenge;const delayed=new Promise(resolve=>{resolveChallenge=resolve;});
  const h=gateHarness({challengeReply:()=>delayed});await h.access.ready;await settle();h.setUser({email:'member@example.com',status,notification:'sent'});await h.access.ensureAllowed();
  resolveChallenge({loginStartUri:'https://roomly.example.com/roomly/api/login/start'});await settle();
  for(const selector of ['#server-sign-in','#sign-in-button','#sign-in-fallback'])assert.equal(h.el(selector).hidden,true,status+' '+selector);
  assert.equal(h.el('#pending-actions').hidden,false);assert.equal(h.navigations.length,0);assert.equal(h.initializations.length,0);
 }
});

test('unavailable server capability keeps GIS fallback and rejects a foreign server-login destination',async()=>{
 const h=gateHarness({loginStartUri:''});await h.access.ready;await settle();assert.equal(h.el('#server-sign-in').hidden,true);assert.equal(h.el('#sign-in-fallback').hidden,true);assert.equal(h.initializations.length,0);
 h.context.google=h.google;h.el('#gis').dispatch('load');assert.equal(h.initializations.length,1);assert.equal(h.initializations[0].ux_mode,'redirect');assert.equal(h.el('#sign-in-button').hidden,false);
 for(const loginStartUri of ['https://evil.example/roomly/api/login/start','https://roomly.example.com/roomly/api/logout']){
  const bad=gateHarness({loginStartUri,googleReady:true});await bad.access.ready;await settle();assert.equal(bad.el('#server-sign-in').hidden,true);assert.equal(bad.navigations.length,0);assert.equal(bad.initializations.length,0);assert.match(bad.el('#access-status').textContent,/設定不正確/);
 }
});

test('approved access polling emits a source revision change once, after the initial snapshot',async()=>{
 const user={email:'member@example.com',status:'approved',isAdmin:false,sourcesRevision:'first'},h=harness(user);await h.access.ready;assert.equal(h.events.length,0);assert.equal(h.access.user().sourcesRevision,'first');
 await h.access.ensureAllowed();assert.equal(h.events.length,0);user.sourcesRevision='second';await h.access.ensureAllowed();assert.equal(h.events.length,1);assert.equal(h.events[0].type,'roomly:sourceschanged');assert.equal(h.events[0].detail.sourcesRevision,'second');
 await h.access.ensureAllowed();assert.equal(h.events.length,1);user.name='Renamed';await h.access.ensureAllowed();assert.equal(h.events.length,1);
 user.sourcesRevision='third';h.intervals[0]();await settle();assert.equal(h.events.length,2);assert.equal(h.events[1].detail.sourcesRevision,'third');
 h.context.document.hidden=true;user.sourcesRevision='fourth';h.intervals[0]();await settle();assert.equal(h.events.length,2,'hidden tabs do not make access requests');
});

test('source changes are not emitted for unapproved sessions or legacy me replies without a revision',async()=>{
 const user={email:'member@example.com',status:'approved',isAdmin:false},h=harness(user);await h.access.ready;await h.access.ensureAllowed();assert.equal(h.events.length,0);
 Object.assign(user,{status:'pending',sourcesRevision:null});await h.access.ensureAllowed();assert.equal(h.events.length,0);Object.assign(user,{status:'rejected',sourcesRevision:null});await h.access.ensureAllowed();assert.equal(h.events.length,0);
});

test('a newly approved gate enters the board with a login marker for the calendar-consent handoff',async()=>{
 const h=gateHarness();await h.access.ready;await settle();h.setUser({email:'member@example.com',status:'approved',isAdmin:false});await h.access.ensureAllowed();assert.equal(h.navigations.at(-1),'/roomly/?login=success');
});

test('calendar revisions emit only after a changed approved snapshot, and hidden polling makes no requests',async()=>{
 const user={email:'member@example.com',status:'approved',isAdmin:false,sourcesRevision:'members',calendarRevision:'meetings-1'},h=harness(user);await h.access.ready;assert.equal(h.events.length,0);
 await h.access.ensureAllowed();user.name='Renamed';await h.access.ensureAllowed();assert.equal(h.events.length,0);
 user.calendarRevision='meetings-2';h.intervals[0]();await settle();assert.equal(h.events.length,1);assert.equal(h.events[0].type,'roomly:calendarchanged');assert.equal(h.events[0].detail.calendarRevision,'meetings-2');
 await h.access.ensureAllowed();assert.equal(h.events.length,1);h.context.document.hidden=true;user.calendarRevision='meetings-3';h.intervals[0]();await settle();assert.equal(h.events.length,1);assert.equal(h.access.user().calendarRevision,'meetings-2');
 h.context.document.hidden=false;h.intervals[0]();await settle();assert.equal(h.events.length,2);assert.equal(h.events[1].detail.calendarRevision,'meetings-3');
});

test('a simultaneous membership and calendar change emits only the safety-first source event',async()=>{
 const user={email:'member@example.com',status:'approved',isAdmin:false,sourcesRevision:'members-1',calendarRevision:'meetings-1'},h=harness(user);await h.access.ready;
 Object.assign(user,{sourcesRevision:'members-2',calendarRevision:'meetings-2'});await h.access.ensureAllowed();assert.deepEqual(h.events.map(event=>event.type),['roomly:sourceschanged']);assert.equal(h.access.user().calendarRevision,'meetings-2');
 await h.access.ensureAllowed();assert.equal(h.events.length,1);user.calendarRevision='meetings-3';await h.access.ensureAllowed();assert.deepEqual(h.events.map(event=>event.type),['roomly:sourceschanged','roomly:calendarchanged']);
});

test('missing or null calendar revisions and unapproved sessions cannot announce meeting changes',async()=>{
 const user={email:'member@example.com',status:'approved',isAdmin:false},h=harness(user);await h.access.ready;await h.access.ensureAllowed();user.calendarRevision='first';await h.access.ensureAllowed();assert.equal(h.events.length,0);
 user.calendarRevision=null;await h.access.ensureAllowed();user.calendarRevision='after-null';await h.access.ensureAllowed();assert.equal(h.events.length,0);
 Object.assign(user,{status:'pending',calendarRevision:'pending'});await h.access.ensureAllowed();Object.assign(user,{status:'rejected',calendarRevision:'rejected'});await h.access.ensureAllowed();assert.equal(h.events.length,0);
});

test('an older access response cannot roll back the calendar revision or emit a stale notification',async()=>{
 const user={email:'member@example.com',status:'approved',isAdmin:false,calendarRevision:'first'},h=harness(user);await h.access.ready;
 let release;const older=new Promise(resolve=>release=resolve);let requests=0;
 h.context.fetch=async()=>({ok:true,json:async()=>++requests===1?older:{...user,calendarRevision:'latest'}});
 const pending=h.access.ensureAllowed();await settle();await h.access.ensureAllowed();assert.equal(h.events.length,1);assert.equal(h.events[0].detail.calendarRevision,'latest');
 release({...user,calendarRevision:'obsolete'});await pending;assert.equal(h.events.length,1);assert.equal(h.access.user().calendarRevision,'latest');
});
