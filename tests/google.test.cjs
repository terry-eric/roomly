const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),core=require('../core.js');
const week=core.weekDays('2026-10-01')[0],email='me@gmail.com';
const event={id:'e1',iCalUID:'shared',summary:'Meeting',location:'主會議室',start:{dateTime:'2026-10-01T10:00:00+08:00'},end:{dateTime:'2026-10-01T11:00:00+08:00'}};
const base=()=>({week,location:'主會議室',configured:true,email,isAdmin:true,sources:[{email,state:'ready',syncedAt:1,events:[event]},{email:'other@gmail.com',state:'ready',syncedAt:1,events:[{...event,id:'e2'}]}]});
const escapeHTML=value=>String(value).replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
function harness(request,allowed=true,selectedDay='2026-09-28',skipWeekends=false,skipHolidays=false,options={}){
  const elements=new Map(),states=[],calls=[],views=[],intervals=[],intervalTimes=[],locations=[],notifications=[],historyUpdates=[],listeners=new Map(),documentListeners=new Map();
  const el=s=>{if(s==='#google-authorize')return null;if(!elements.has(s))elements.set(s,{value:'',hidden:false,disabled:false,innerHTML:'',textContent:'',dataset:{},parentElement:{prepend(){}}});return elements.get(s);};
  const location={origin:'https://roomly.example.com',pathname:'/roomly/',search:options.search||'',hash:options.hash||'',assign:url=>locations.push(url)};
  const context={RoomCore:core,RoomApp:{esc:escapeHTML,day:()=>selectedDay,setLive:s=>states.push(s),showDemo:()=>states.push({local:true}),view:v=>views.push(v),notify:text=>notifications.push(text)},RoomlyAccess:{ready:Promise.resolve(options.accessReady===true),user:()=>options.user||{status:'approved'},ensureAllowed:async()=>allowed,request:async(path,body)=>{calls.push({path,body});return request(path,body);}},document:{querySelector:el,querySelectorAll:()=>[el('csv'),el('panel')],hidden:false,addEventListener(type,fn){documentListeners.set(type,fn);}},location,history:{replaceState(state,title,url){if(options.historyFails)throw Error('history unavailable');historyUpdates.push(url);const parsed=new URL(url,location.origin);location.search=parsed.search;location.hash=parsed.hash;}},addEventListener(type,fn){listeners.set(type,fn);},setInterval:(f,ms)=>{intervals.push(f);intervalTimes.push(ms);},Date,URL,URLSearchParams,encodeURIComponent,Intl};context.window=context;vm.createContext(context);vm.runInContext(fs.readFileSync(require.resolve('../google.js'),'utf8'),context);
  context.RoomApp.days=()=>core.boardDays(selectedDay,skipWeekends,skipHolidays);
  return {el,states,calls,views,locations,intervals,intervalTimes,notifications,historyUpdates,context,emit:type=>listeners.get(type)?.(),emitDocument:type=>documentListeners.get(type)?.(),sync:()=>context.GoogleSync.sync()};
}
test('logged-in shared board loads all authorized users without browser Calendar tokens and dedupes copies',async()=>{
 const h=harness(()=>base());await h.sync();assert.equal(h.calls[0].path,'calendar/feed?day=2026-09-28');assert.equal(h.states.at(-1).events.length,1);assert.equal(h.states.at(-1).events[0].sources.length,2);assert.equal(h.states.at(-1).availabilityComplete,false);assert.match(h.el('#shared-summary').textContent,/2 位/);assert.match(h.el('#shared-calendar-list').innerHTML,/other@gmail.com/);assert.ok(!h.calls.some(c=>c.path.includes('googleapis')));
});
test('grant details stay in sources and settings while the main board has a simple sync label',async()=>{
 const data=base();data.sources[1]={email:'other@gmail.com',state:'unauthorized',syncedAt:null,events:[]};const h=harness(()=>data);await h.sync();assert.match(h.el('#shared-calendar-list').innerHTML,/尚未授權自己的日曆/);assert.match(h.el('#google-status').textContent,/1 個來源尚未完成/);assert.equal(h.states.at(-1).message,'日曆變更時自動同步，每 10 分鐘補查');assert.equal(h.states.at(-1).events.length,1);assert.equal(h.states.at(-1).availabilityComplete,false);
});

test('source badges and counts distinguish missing, expired, primary-only and fully granted calendars',async()=>{
 const data=base();data.sources=[
  {email:'full-ready@example.com',state:'ready',sharedCalendars:true,syncedAt:1,events:[]},
  {email:'full-error@example.com',state:'error',sharedCalendars:true,syncedAt:1,events:[]},
  {email:'full-stale@example.com',state:'stale',sharedCalendars:true,syncedAt:1,events:[]},
  {email:'full-waiting@example.com',state:'waiting',sharedCalendars:true,syncedAt:null,events:[]},
  {email:'partial-ready@example.com',state:'ready',sharedCalendars:false,syncedAt:1,events:[]},
  {email:'partial-error@example.com',state:'error',sharedCalendars:false,syncedAt:1,events:[]},
  {email:'partial-stale@example.com',state:'stale',sharedCalendars:false,syncedAt:1,events:[]},
  {email:'partial-waiting@example.com',state:'waiting',sharedCalendars:false,syncedAt:null,events:[]},
  {email:'missing@example.com',state:'unauthorized',sharedCalendars:false,syncedAt:null,events:[]},
  {email:'expired@example.com',state:'reauthorize',sharedCalendars:false,syncedAt:1,events:[]},
 ];
 const h=harness(()=>data);await h.sync();assert.equal(h.el('#shared-summary').textContent,'已登入帳號 · 10 位 · 1 位未授權 · 1 位授權失效 · 4 位需完整授權');
 const rows=h.el('#shared-calendar-list').innerHTML.split('<div class="shared-calendar"').slice(1),row=email=>rows.find(markup=>markup.includes(email));assert.equal(rows.length,10);
 for(const source of data.sources){
  const expected=source.state==='unauthorized'?['missing','未授權']:source.state==='reauthorize'?['expired','授權失效']:source.sharedCalendars===false?['primary','需完整授權']:['connected','已授權'];
  assert.ok(row(source.email).includes('data-authorization="'+expected[0]+'"'),source.email);assert.ok(row(source.email).includes('>'+expected[1]+'<'),source.email+' badge');
 }
 assert.ok(row('full-error@example.com').includes('同步失敗'));assert.ok(row('full-stale@example.com').includes('資料逾時'));assert.ok(row('partial-error@example.com').includes('同步失敗'));
 const positions=data.sources.map(source=>({source,index:rows.indexOf(row(source.email))})),urgent=positions.filter(({source})=>['unauthorized','reauthorize'].includes(source.state)),others=positions.filter(({source})=>!['unauthorized','reauthorize'].includes(source.state));assert.ok(Math.max(...urgent.map(p=>p.index))<Math.min(...others.map(p=>p.index)),'missing and expired grants appear before connected sources');
});

test('sync errors and legacy connected replies never increase missing-grant counts, and zero categories are omitted',async()=>{
 const data=base();data.sources[0].state='error';data.sources[1].state='stale';const h=harness(()=>data);await h.sync();assert.equal(h.el('#shared-summary').textContent,'已登入帳號 · 2 位');
 const rows=h.el('#shared-calendar-list').innerHTML;assert.equal((rows.match(/data-authorization="connected"/g)||[]).length,2);assert.equal((rows.match(/>已授權</g)||[]).length,2);assert.ok(rows.includes('同步失敗'));assert.ok(rows.includes('資料逾時'));assert.ok(!rows.includes('data-authorization="missing"'));assert.ok(!rows.includes('data-authorization="expired"'));
 data.sources=[];await h.sync();assert.equal(h.el('#shared-summary').textContent,'已登入帳號 · 0 位');
});

test('the authorization list escapes source emails while retaining the grant badge beside the identity',async()=>{
 const data=base(),malformedEmail='odd<"&\'@example.test';data.sources=[{email:malformedEmail,state:'unauthorized',syncedAt:null,events:[]}];const h=harness(()=>data);await h.sync();const markup=h.el('#shared-calendar-list').innerHTML;
 assert.ok(markup.includes(escapeHTML(malformedEmail)));assert.ok(!markup.includes(malformedEmail));assert.ok(markup.includes('data-authorization="missing"'));assert.ok(markup.includes('>未授權<'));assert.equal(h.el('#shared-summary').textContent,'已登入帳號 · 1 位 · 1 位未授權');
});
test('server configuration missing disables authorization and never marks availability as known',async()=>{
 const data=base();data.configured=false;const h=harness(()=>data);await h.sync();assert.equal(h.el('#google-connect').disabled,true);assert.equal(h.states.at(-1).ready,false);assert.match(h.el('#google-status').textContent,/尚未完成後端/);assert.equal(h.states.at(-1).message,'日曆變更時自動同步，每 10 分鐘補查');assert.equal(h.el('#google-start').disabled,false);
});
test('shared location is writable only by administrator, saved to server and resynced',async()=>{
 const data=base(),h=harness((path,body)=>{if(path==='calendar/location'){data.location=body.location;return {ok:true};}return data;});await h.sync();h.el('#room-location').value='新地點';await h.el('#location-filter').onsubmit({preventDefault(){}});assert.equal(h.calls[1].path,'calendar/location');assert.equal(h.calls[1].body.location,'新地點');assert.equal(h.calls[2].path,'calendar/feed?day=2026-09-28');assert.equal(h.el('#room-location').value,'新地點');assert.equal(h.el('#location-status').hidden,false);assert.match(h.el('#location-status').textContent,/已儲存/);assert.equal(h.el('#location-apply').textContent,'儲存地點');
 const member=base();member.isAdmin=false;const other=harness(()=>member);await other.sync();assert.equal(other.el('#room-location').disabled,true);assert.equal(other.el('#location-apply').hidden,true);assert.match(other.el('#location-status').textContent,/目前登入/);await other.el('#location-filter').onsubmit({preventDefault(){}});assert.equal(other.calls.length,1);assert.match(other.el('#location-status').textContent,/沒有地點設定權限/);
});
test('background feed refresh preserves an unfinished location draft',async()=>{
 const h=harness(()=>base());await h.sync();h.el('#room-location').value='新地點尚未儲存';h.el('#room-location').oninput();await h.sync();assert.equal(h.el('#room-location').value,'新地點尚未儲存');
});
test('empty location and server save failures are visible and keep the draft available for retry',async()=>{
 const h=harness(path=>{if(path==='calendar/location')throw Error('暫時無法儲存');return base();});await h.sync();h.el('#room-location').value=' ';await h.el('#location-filter').onsubmit({preventDefault(){}});assert.equal(h.calls.length,1);assert.equal(h.el('#location-status').hidden,false);assert.match(h.el('#location-status').textContent,/1–100/);
 h.el('#room-location').value='新地點';h.el('#room-location').oninput();await h.el('#location-filter').onsubmit({preventDefault(){}});assert.equal(h.el('#location-status').dataset.state,'error');assert.match(h.el('#location-status').textContent,/暫時無法儲存/);assert.equal(h.el('#room-location').value,'新地點');assert.equal(h.el('#room-location').disabled,false);assert.equal(h.el('#location-apply').disabled,false);
});
test('location save suppresses duplicate taps and restores controls after persisting',async()=>{
 let release;const data=base(),pending=new Promise(resolve=>release=resolve);const h=harness(async(path,body)=>{if(path==='calendar/location'){await pending;data.location=body.location;return {ok:true};}return data;});await h.sync();h.el('#room-location').value='  新地點  ';const first=h.el('#location-filter').onsubmit({preventDefault(){}});assert.equal(h.el('#location-apply').disabled,true);assert.equal(h.el('#room-location').disabled,true);assert.equal(h.el('#location-apply').textContent,'儲存中…');await h.el('#location-filter').onsubmit({preventDefault(){}});assert.equal(h.calls.filter(c=>c.path==='calendar/location').length,1);release();await first;assert.equal(h.el('#room-location').value,'新地點');assert.equal(h.el('#location-apply').disabled,false);
});
test('saved location with a failed board reload reports that the save succeeded and clears old room meetings',async()=>{
 let saved=false;const h=harness(path=>{if(path==='calendar/location'){saved=true;return {ok:true};}if(saved)throw Error('連線失敗');return base();});await h.sync();h.el('#room-location').value='新地點';await h.el('#location-filter').onsubmit({preventDefault(){}});assert.equal(h.el('#location-status').hidden,false);assert.match(h.el('#location-status').textContent,/已儲存.*更新失敗/);assert.ok(!h.states.at(-1).events?.length);
});
test('authorization uses server URL and refuses external redirects',async()=>{
 const h=harness(path=>path==='calendar/authorize'?{url:'https://accounts.google.com/o/oauth2/v2/auth?state=random'}:base());await h.sync();await h.el('#google-connect').onclick();assert.equal(h.locations.length,1);assert.equal(h.calls.at(-1).path,'calendar/authorize');
 const bad=harness(path=>path==='calendar/authorize'?{url:'https://evil.example/'}:base());await bad.sync();await bad.el('#google-connect').onclick();assert.equal(bad.locations.length,0);assert.match(bad.el('#google-status').textContent,/網址不正確/);
});

test('a cancelled or unconsented user can retry from settings before the room location is configured',async()=>{
 const data=base();data.location='';data.sources[0]={email,state:'unauthorized',syncedAt:null,events:[]};const h=harness(path=>path==='calendar/authorize'?{url:'https://accounts.google.com/o/oauth2/v2/auth?state=random'}:data);await h.sync();assert.equal(h.el('#google-connect').hidden,false);assert.equal(h.el('#google-connect').disabled,false);assert.equal(h.states.at(-1).ready,false);await h.el('#google-connect').onclick();assert.equal(h.locations.length,1);assert.equal(h.calls.at(-1).path,'calendar/authorize');
 const connected=harness(()=>base());await connected.sync();assert.equal(connected.el('#google-connect').hidden,true);
});
test('website revocation and feed failure clear previously displayed meetings',async()=>{
 let allowed=true,fail=false;const h=harness(()=>{if(fail)throw Error('未登入');return base();});h.context.RoomlyAccess.ensureAllowed=async()=>allowed;await h.sync();allowed=false;await h.sync();assert.equal(h.states.at(-1).events,undefined);assert.equal(h.calls.length,1);allowed=true;fail=true;await h.sync();assert.equal(h.states.at(-1).events,undefined);assert.equal(h.el('#shared-calendar-list').innerHTML,'');assert.equal(h.el('#google-disconnect').disabled,true);
});
test('out-of-order shared feed responses cannot restore older meetings',async()=>{
 let release;const pending=new Promise(resolve=>release=resolve);let count=0;const h=harness(()=>++count===1?pending:{...base(),sources:[]});const first=h.sync();await new Promise(resolve=>setImmediate(resolve));await h.sync();release(base());await first;assert.equal(h.states.at(-1).events.length,0);
});
test('disconnect stops only the current account and local view pauses browser polling',async()=>{
 const h=harness(()=>base());await h.sync();await h.el('#google-disconnect').onclick();assert.equal(h.calls[1].path,'calendar/disconnect');assert.deepEqual(Object.keys(h.calls[1].body),[]);h.el('#google-demo').onclick();const count=h.calls.length;h.intervals[0]();assert.equal(h.calls.length,count);assert.equal(h.states.at(-1).local,true);
});

test('ten-minute polling reads the feed, while the top sync button requests a fresh server sync without opening consent',async()=>{
 const data=base();data.sources[0]={email,state:'unauthorized',syncedAt:null,events:[]};const h=harness(()=>data);await h.sync();assert.deepEqual(h.intervalTimes,[600000,60000]);assert.equal(h.el('#google-start').textContent,'同步');
 await h.el('#google-start').onclick();assert.equal(h.calls.at(-1).path,'calendar/sync');assert.equal(h.calls.at(-1).body.day,'2026-09-28');assert.equal(h.locations.length,0);assert.equal(h.views.at(-1),'overview');
 h.intervals[0]();await new Promise(resolve=>setImmediate(resolve));assert.equal(h.calls.at(-1).path,'calendar/feed?day=2026-09-28');
});

test('manual sync disables all sync controls until done and suppresses duplicate taps',async()=>{
 let release;const pending=new Promise(resolve=>release=resolve);const h=harness(path=>path==='calendar/sync'?pending:base());await h.sync();const first=h.el('#google-start').onclick();await new Promise(resolve=>setImmediate(resolve));
 for(const selector of ['#google-start','#google-sync','#refresh-sources'])assert.equal(h.el(selector).disabled,true);assert.equal(h.el('#google-start').textContent,'同步中…');await h.el('#google-start').onclick();assert.equal(h.calls.filter(c=>c.path==='calendar/sync').length,1);
 release(base());await first;for(const selector of ['#google-start','#google-sync','#refresh-sources'])assert.equal(h.el(selector).disabled,false);assert.equal(h.el('#google-start').textContent,'同步');
});

test('a failed manual request keeps the displayed meetings, reports the error and allows retry',async()=>{
 const h=harness(path=>{if(path==='calendar/sync')throw Error('Google 暫時無法讀取');return base();});await h.sync();const displayed=h.states.at(-1);await h.el('#google-start').onclick();assert.equal(h.states.at(-1),displayed);assert.match(h.el('#google-status').textContent,/暫時無法/);assert.match(h.el('#shared-calendar-status').textContent,/暫時無法/);assert.match(h.notifications.at(-1),/暫時無法/);assert.equal(h.el('#google-start').disabled,false);
});

const futureEvent=(uid,start,end)=>({...event,id:uid,iCalUID:uid,start:{dateTime:start},end:{dateTime:end}});
function crossWeekFeed(path,body){
 const date=body?.day||new URL('https://roomly.test/'+path).searchParams.get('day'),data=base();data.week=core.weekDays(date)[0];
 const bridge=futureEvent('bridge','2026-10-04T23:30:00+08:00','2026-10-05T10:30:00+08:00');
 const events=data.week===week?[futureEvent('today','2026-10-03T10:00:00+08:00','2026-10-03T11:00:00+08:00'),bridge,event]:[bridge,futureEvent('monday','2026-10-05T12:00:00+08:00','2026-10-05T13:00:00+08:00'),futureEvent('outside','2026-10-08T10:00:00+08:00','2026-10-08T11:00:00+08:00')];
 data.sources=data.sources.map(source=>({...source,events}));return data;
}
test('five-day board fetches both covered weeks, dedupes boundary meetings and excludes other dates',async()=>{
 const h=harness(crossWeekFeed,true,'2026-10-03');await h.sync();assert.deepEqual(h.calls.map(call=>call.path),['calendar/feed?day=2026-10-03','calendar/feed?day=2026-10-05']);
 assert.deepEqual(h.states.at(-1).events.map(event=>event.id.split('|')[0]),['today','bridge','monday']);assert.equal(h.states.at(-1).events[1].sources.length,2);assert.match(h.el('#shared-calendar-list').innerHTML,/這五天 3 場/);
 await h.el('#google-start').onclick();assert.deepEqual(h.calls.slice(-2).map(call=>call.body.day),['2026-10-03','2026-10-05']);
});
test('both automatic and manual cross-week loads finish the first request before starting the second',async()=>{
 for(const manual of [false,true]){
   let release;const pending=new Promise(resolve=>release=resolve);let firstRequest;
   const h=harness((path,body)=>{const data=crossWeekFeed(path,body);if(data.week===week){firstRequest={path,body};return pending;}return data;},true,'2026-10-03');
   const loading=manual?h.el('#google-start').onclick():h.sync();
   try{await new Promise(resolve=>setImmediate(resolve));assert.equal(h.calls.length,1);assert.equal(h.states.length,0);assert.equal(h.calls[0].path,manual?'calendar/sync':'calendar/feed?day=2026-10-03');}
   finally{release(crossWeekFeed(firstRequest?.path||(manual?'calendar/sync':'calendar/feed?day=2026-10-03'),firstRequest?.body||(manual?{day:'2026-10-03'}:undefined)));await loading;}
   assert.equal(h.calls.length,2);assert.equal(h.calls[1].path,manual?'calendar/sync':'calendar/feed?day=2026-10-05');if(manual)assert.equal(h.calls[1].body.day,'2026-10-05');assert.equal(h.states.at(-1).events.length,3);
 }
});

test('a superseded first-week response cannot start its second request or replace the newer board',async()=>{
 let release;const pending=new Promise(resolve=>release=resolve);let requests=0;
 const h=harness((path,body)=>{if(++requests===1)return pending;const data=crossWeekFeed(path,body);data.sources=[];return data;},true,'2026-10-03');
 const old=h.sync();await new Promise(resolve=>setImmediate(resolve));
 try{await h.sync();assert.equal(h.calls.length,3);assert.equal(h.states.at(-1).events.length,0);}
 finally{release(crossWeekFeed('calendar/feed?day=2026-10-03'));await old;}
 assert.equal(h.calls.length,3);assert.equal(h.states.at(-1).events.length,0);
});

test('a source missing or disconnected in either week cannot expose its earlier events',async()=>{
 const h=harness((path,body)=>{const data=crossWeekFeed(path,body);if(data.week!==week){data.sources=data.sources.filter(source=>source.email===email);data.sources[0]={...data.sources[0],state:'unauthorized',events:[]};}return data;},true,'2026-10-03');await h.sync();assert.equal(h.states.at(-1).events.length,0);assert.match(h.el('#shared-summary').textContent,/1 位/);assert.equal(h.el('#shared-calendar-list').innerHTML.includes('other@gmail.com'),false);
});
test('failure of a covered week cannot publish a partial five-day board',async()=>{
 let fail=false;const h=harness((path,body)=>{const data=crossWeekFeed(path,body);if(fail&&data.week!==week)throw Error('第二週暫時無法讀取');return data;},true,'2026-10-03');await h.sync();const original=h.states.at(-1);fail=true;await h.el('#google-start').onclick();assert.equal(h.states.at(-1),original);assert.match(h.el('#google-status').textContent,/第二週/);await h.sync();assert.ok(!h.states.at(-1).events?.length);
});
test('skipping weekends queries the visible weeks, excludes weekend meetings and keeps next-week days',async()=>{
 const h=harness((path,body)=>{
   const data=crossWeekFeed(path,body);
   if(data.week!==week)for(const source of data.sources)source.events.push(futureEvent('thursday','2026-10-08T10:00:00+08:00','2026-10-08T11:00:00+08:00'));
   return data;
 },true,'2026-10-02',true);
 await h.sync();assert.deepEqual(h.calls.map(c=>c.path),['calendar/feed?day=2026-10-02','calendar/feed?day=2026-10-05']);
 const ids=h.states.at(-1).events.map(e=>e.id.split('|')[0]);assert.equal(ids.includes('today'),false);assert.equal(ids.includes('thursday'),true);assert.equal(ids.includes('bridge'),true);
 const weekend=harness(crossWeekFeed,true,'2026-10-03',true);await weekend.sync();assert.deepEqual(weekend.calls.map(c=>c.path),['calendar/feed?day=2026-10-05']);
});
test('authentication failure during manual sync clears old shared meetings',async()=>{
 for(const status of [401,403]){
   const h=harness(path=>{if(path==='calendar/sync')throw Object.assign(Error('已失去存取資格'),{status});return base();});
   await h.sync();await h.el('#google-start').onclick();assert.ok(!h.states.at(-1).events?.length);assert.equal(h.el('#shared-calendar-list').innerHTML,'');assert.equal(h.el('#google-disconnect').disabled,true);
 }
});
test('cross-week deduplication keeps newer meeting revisions even when the second snapshot is older',async()=>{
 const h=harness((path,body)=>{
   const data=crossWeekFeed(path,body);
   for(const source of data.sources)source.events=source.events.map(e=>e.iCalUID==='bridge'?{...e,sequence:data.week===week?2:1,end:{dateTime:data.week===week?'2026-10-05T12:00:00+08:00':'2026-10-05T10:30:00+08:00'}}:e);
   return data;
 },true,'2026-10-03');await h.sync();assert.equal(Date.parse(h.states.at(-1).events.find(e=>e.id.startsWith('bridge|')).endISO),Date.parse('2026-10-05T12:00:00+08:00'));
});
test('a newer meeting moved outside the visible dates removes the old position across weeks and sources',async()=>{
 const h=harness((path,body)=>{
   const data=crossWeekFeed(path,body),newer=data.week!==week;
   for(const source of data.sources)source.events=[{...futureEvent('moved',newer?'2026-10-08T10:00:00+08:00':'2026-10-03T10:00:00+08:00',newer?'2026-10-08T11:00:00+08:00':'2026-10-03T11:00:00+08:00'),recurringEventId:'',sequence:newer?2:1}];
   return data;
 },true,'2026-10-03');await h.sync();assert.equal(h.states.at(-1).events.length,0);
 const acrossSources=harness(()=>{const data=base();data.sources[0].events=[{...event,recurringEventId:'',sequence:1}];data.sources[1].events=[{...event,recurringEventId:'',sequence:2,start:{dateTime:'2026-10-03T10:00:00+08:00'},end:{dateTime:'2026-10-03T11:00:00+08:00'}}];return data;});await acrossSources.sync();assert.equal(acrossSources.states.at(-1).events.length,0);
});

test('a primary-only connection offers a settings retry without opening consent during ordinary refresh',async()=>{
 const data=base();data.sources[0].sharedCalendars=false;data.sources[0].calendarCount=1;
 const request=path=>path==='calendar/authorize'?{url:'https://accounts.google.com/o/oauth2/v2/auth?state=upgrade'}:data;
 const h=harness(request);await h.sync();assert.equal(h.el('#google-connect').hidden,false);assert.equal(h.el('#google-connect').textContent,'重新授權日曆');assert.equal(h.el('#google-shared-hint').hidden,false);assert.match(h.el('#shared-calendar-list').innerHTML,/1 個日曆.*目前僅主要日曆/);
 await h.el('#google-start').onclick();h.intervals[0]();await new Promise(resolve=>setImmediate(resolve));assert.equal(h.locations.length,0);assert.equal(h.calls.some(c=>c.path==='calendar/authorize'),false);assert.equal(h.el('#google-connect').hidden,false);
 await h.el('#google-connect').onclick();assert.equal(h.calls.at(-1).path,'calendar/authorize');assert.equal(h.locations.length,1);
 const settings=harness(request);await settings.sync();await settings.el('#google-connect').onclick();assert.equal(settings.calls.at(-1).path,'calendar/authorize');assert.equal(settings.locations.length,1);
});

test('shared-calendar access is displayed from the server grant, while older responses keep their authorization behavior',async()=>{
 const data=base();data.sources[0].sharedCalendars=true;data.sources[0].calendarCount=3;data.sources[1].sharedCalendars=false;data.sources[1].calendarCount=1;
 const h=harness(()=>data);await h.sync();assert.equal(h.el('#google-connect').hidden,true);assert.equal(h.el('#google-connect').textContent,'重新授權日曆');assert.equal(h.el('#google-shared-hint').hidden,true);assert.match(h.el('#shared-calendar-list').innerHTML,/3 個日曆/);assert.match(h.el('#shared-calendar-list').innerHTML,/1 個日曆.*目前僅主要日曆/);assert.equal(h.locations.length,0);
 const legacy=harness(()=>base());await legacy.sync();assert.equal(legacy.el('#google-connect').hidden,true);assert.equal(h.el('#google-connect').textContent,'重新授權日曆');assert.equal(legacy.el('#google-shared-hint').hidden,true);assert.equal(legacy.el('#shared-calendar-list').innerHTML.includes('個日曆'),false);
});

test('a shared-calendar upgrade does not hide a missing grant or claim that an errored source has synchronized',async()=>{
 for(const state of ['unauthorized','reauthorize','waiting','error','stale']){
   const data=base();data.sources[0]={...data.sources[0],state,sharedCalendars:false,calendarCount:1};const h=harness(()=>data);await h.sync();
   assert.equal(h.el('#google-connect').hidden,false);assert.equal(h.el('#google-connect').textContent,'重新授權日曆');assert.equal(h.locations.length,0);assert.equal(h.calls.some(c=>c.path==='calendar/authorize'),false);assert.equal(h.states.at(-1).message,'日曆變更時自動同步，每 10 分鐘補查');
   const ownMarkup=h.el('#shared-calendar-list').innerHTML.split('<div class="shared-calendar"')[1];assert.equal(ownMarkup.includes('這五天'),false);
 }
 const data=base();data.configured=false;data.sources[0].sharedCalendars=false;const disabled=harness(()=>data);await disabled.sync();assert.equal(disabled.el('#google-connect').disabled,true);await disabled.el('#google-connect').onclick();assert.equal(disabled.calls.some(c=>c.path==='calendar/authorize'),false);
});

test('cross-week responses conservatively report shared-calendar consent and the smallest complete calendar count',async()=>{
 for(const reverse of [false,true]){
   const h=harness((path,body)=>{const data=crossWeekFeed(path,body);const expanded=(data.week===week)!==reverse;data.sources[0]={...data.sources[0],sharedCalendars:expanded,calendarCount:expanded?3:1};return data;},true,'2026-10-03');await h.sync();assert.equal(h.el('#google-connect').textContent,'重新授權日曆');assert.equal(h.el('#google-connect').hidden,false);assert.match(h.el('#shared-calendar-list').innerHTML,/1 個日曆.*目前僅主要日曆/);assert.equal(h.el('#shared-calendar-list').innerHTML.includes('3 個日曆'),false);
 }
 const missing=harness((path,body)=>{const data=crossWeekFeed(path,body);data.sources[0].sharedCalendars=true;if(data.week===week)data.sources[0].calendarCount=3;return data;},true,'2026-10-03');await missing.sync();assert.equal(missing.el('#google-connect').hidden,true);assert.equal(missing.el('#shared-calendar-list').innerHTML.includes('個日曆'),false);
});

test('a failed shared-calendar upgrade keeps the explicit upgrade available for a user-controlled retry',async()=>{
 let failure=true;const data=base();data.sources[0].sharedCalendars=false;data.sources[0].calendarCount=1;
 const h=harness(path=>{if(path==='calendar/authorize'){if(failure)throw Error('授權暫時無法開啟');return {url:'https://accounts.google.com/o/oauth2/v2/auth?state=retry'};}return data;});await h.sync();await h.el('#google-connect').onclick();assert.equal(h.locations.length,0);assert.equal(h.el('#google-connect').disabled,false);assert.equal(h.el('#google-connect').hidden,false);assert.equal(h.el('#google-connect').textContent,'重新授權日曆');assert.match(h.el('#google-status').textContent,/暫時無法/);
 failure=false;await h.el('#google-connect').onclick();assert.equal(h.locations.length,1);assert.equal(h.calls.filter(c=>c.path==='calendar/authorize').length,2);
});

function springHolidayFeed(path,body){
 const day=body?.day||new URL('https://roomly.test/'+path).searchParams.get('day'),data=base();data.week=core.weekDays(day)[0];
 const at=(uid,date)=>futureEvent(uid,date+'T10:00:00+08:00',date+'T11:00:00+08:00');
 const bridge=futureEvent('bridge-monday','2026-02-22T23:30:00+08:00','2026-02-23T10:30:00+08:00');
 const eventsByWeek={
  '2026-02-09':[at('friday','2026-02-13'),at('saturday-before','2026-02-14'),at('hidden-holiday','2026-02-15')],
  '2026-02-16':[at('hidden-substitute','2026-02-20'),futureEvent('bridge-saturday','2026-02-20T23:30:00+08:00','2026-02-21T10:30:00+08:00'),at('saturday-after','2026-02-21'),at('sunday-after','2026-02-22'),bridge],
  '2026-02-23':[bridge,at('monday','2026-02-23'),at('tuesday','2026-02-24'),at('wednesday','2026-02-25'),at('thursday','2026-02-26'),at('outside','2026-02-27')],
 };
 data.sources=data.sources.map(source=>({...source,events:eventsByWeek[data.week]||[]}));return data;
}
test('holiday-only five-day boards fetch three weeks without including hidden holiday meetings',async()=>{
 const h=harness(springHolidayFeed,true,'2026-02-13',false,true);await h.sync();
 assert.deepEqual(h.calls.map(call=>call.path),['calendar/feed?day=2026-02-13','calendar/feed?day=2026-02-16','calendar/feed?day=2026-02-23']);
 assert.deepEqual(h.states.at(-1).events.map(e=>e.id.split('|')[0]),['friday','saturday-before','bridge-saturday','saturday-after','sunday-after','bridge-monday','monday']);
 assert.equal(h.states.at(-1).events.filter(e=>e.id.startsWith('bridge-monday|')).length,1);assert.match(h.el('#shared-calendar-list').innerHTML,/這五天 7 場/);
 await h.el('#google-start').onclick();assert.deepEqual(h.calls.slice(-3).map(call=>call.path),['calendar/sync','calendar/sync','calendar/sync']);assert.deepEqual(h.calls.slice(-3).map(call=>call.body.day),['2026-02-13','2026-02-16','2026-02-23']);
});
test('combining weekend and holiday skipping requests only visible weeks after the spring break',async()=>{
 const h=harness(springHolidayFeed,true,'2026-02-13',true,true);await h.sync();
 assert.deepEqual(h.calls.map(call=>call.path),['calendar/feed?day=2026-02-13','calendar/feed?day=2026-02-23']);
 assert.deepEqual(h.states.at(-1).events.map(e=>e.id.split('|')[0]),['friday','bridge-monday','monday','tuesday','wednesday','thursday']);
 assert.match(h.el('#shared-calendar-list').innerHTML,/這五天 6 場/);
});
test('three-week automatic and manual loads await the second week before requesting the third',async()=>{
 for(const manual of [false,true]){
  let release;const pending=new Promise(resolve=>release=resolve);let secondRequest;
  const h=harness((path,body)=>{const data=springHolidayFeed(path,body);if(data.week==='2026-02-16'){secondRequest={path,body};return pending;}return data;},true,'2026-02-13',false,true);
  const loading=manual?h.el('#google-start').onclick():h.sync();
  try{await new Promise(resolve=>setImmediate(resolve));assert.equal(h.calls.length,2);assert.equal(h.states.length,0);assert.ok(!h.calls.some(call=>(call.body?.day||call.path).includes('2026-02-23')));}
  finally{release(springHolidayFeed(secondRequest?.path||(manual?'calendar/sync':'calendar/feed?day=2026-02-16'),secondRequest?.body||(manual?{day:'2026-02-16'}:undefined)));await loading;}
  assert.equal(h.calls.length,3);assert.equal(h.calls.at(-1).path,manual?'calendar/sync':'calendar/feed?day=2026-02-23');if(manual)assert.equal(h.calls.at(-1).body.day,'2026-02-23');assert.equal(h.states.at(-1).events.length,7);
 }
});
test('sources removed in the third visible week cannot expose meetings from the first two weeks',async()=>{
 const h=harness((path,body)=>{const data=springHolidayFeed(path,body);if(data.week==='2026-02-23')data.sources=[];return data;},true,'2026-02-13',false,true);
 await h.sync();assert.equal(h.calls.length,3);assert.equal(h.states.at(-1).events.length,0);assert.match(h.el('#shared-summary').textContent,/0 位/);
});
test('a failed third week never publishes a partial holiday range and manual sync can be retried',async()=>{
 let fail=false;const h=harness((path,body)=>{const data=springHolidayFeed(path,body);if(fail&&data.week==='2026-02-23')throw Error('第三週暫時無法讀取');return data;},true,'2026-02-13',false,true);
 await h.sync();const complete=h.states.at(-1);assert.equal(complete.events.length,7);fail=true;
 await h.el('#google-start').onclick();assert.equal(h.states.at(-1),complete);assert.match(h.el('#google-status').textContent,/第三週/);assert.equal(h.el('#google-start').disabled,false);
 await h.sync();assert.ok(!h.states.at(-1).events?.length);
 fail=false;await h.el('#google-start').onclick();assert.equal(h.states.at(-1).events.length,7);
});

const settle=()=>new Promise(resolve=>setImmediate(resolve));
const loginOptions=(user={status:'approved',calendarConfigured:true,calendarAuthorizationRequired:true},extra={})=>({accessReady:true,search:'?login=success',user,...extra});
const consentUrl={url:'https://accounts.google.com/o/oauth2/v2/auth?state=fixture'};

test('a successful approved login opens required Calendar consent directly, before requesting any meeting feed',async()=>{
 const h=harness(path=>{assert.equal(path,'calendar/authorize');return consentUrl;},true,'2026-09-28',false,false,loginOptions());await settle();
 assert.deepEqual(h.calls.map(call=>call.path),['calendar/authorize']);assert.equal(h.locations.length,1);assert.deepEqual(h.historyUpdates,['/roomly/']);assert.equal(h.context.location.search,'');
});

test('the login marker is consumed while other query values and hash survive; reloading that URL never repeats consent',async()=>{
 const h=harness(path=>path==='calendar/authorize'?consentUrl:base(),true,'2026-09-28',false,false,loginOptions(undefined,{search:'?view=overview&login=success&day=2026-10-01',hash:'#board'}));await settle();
 assert.deepEqual(h.historyUpdates,['/roomly/?view=overview&day=2026-10-01#board']);assert.equal(h.locations.length,1);
 const reload=harness(()=>base(),true,'2026-09-28',false,false,loginOptions(undefined,{search:h.context.location.search,hash:h.context.location.hash}));await settle();assert.equal(reload.calls.some(call=>call.path==='calendar/authorize'),false);
});

test('already connected, unconfigured, pending and rejected accounts never open Calendar consent automatically',async()=>{
 for(const user of [{status:'approved',calendarConfigured:true,calendarAuthorizationRequired:false},{status:'approved',calendarConfigured:false,calendarAuthorizationRequired:true},{status:'pending',calendarConfigured:true,calendarAuthorizationRequired:true},{status:'rejected',calendarConfigured:true,calendarAuthorizationRequired:true}]){
  const allowed=user.status==='approved',h=harness(()=>base(),allowed,'2026-09-28',false,false,loginOptions(user));await settle();assert.equal(h.calls.some(call=>call.path==='calendar/authorize'),false,JSON.stringify(user));assert.equal(h.locations.length,0);assert.deepEqual(h.historyUpdates,['/roomly/']);
 }
});

test('Calendar callbacks, ordinary page visits and failed marker cleanup cannot trigger another authorization loop',async()=>{
 for(const search of ['', '?login=failed','?calendar=cancelled','?login=success&calendar=cancelled','?login=success&calendar=failed','?login=success&calendar=scope','?login=success&calendar=connected']){
  const data=base();data.sources[0].state='unauthorized';const h=harness(()=>data,true,'2026-09-28',false,false,loginOptions(undefined,{search}));await settle();await h.sync();h.intervals[0]();await settle();assert.equal(h.calls.some(call=>call.path==='calendar/authorize'),false,search);assert.equal(h.locations.length,0);
 }
 const historyFails=harness(()=>base(),true,'2026-09-28',false,false,loginOptions(undefined,{historyFails:true}));await settle();assert.equal(historyFails.calls.some(call=>call.path==='calendar/authorize'),false);assert.equal(historyFails.locations.length,0);
});

test('incomplete scope callbacks explain both required permissions and offer only a user-controlled settings retry',async()=>{
 for(const state of ['unauthorized','reauthorize','ready']){
  const data=base();data.sources[0]={...data.sources[0],state,sharedCalendars:false};const h=harness(path=>path==='calendar/authorize'?consentUrl:data,true,'2026-09-28',false,false,loginOptions(undefined,{search:'?login=success&calendar=scope'}));await settle();
  const message=h.el('#google-status').textContent;assert.match(message,/日曆活動唯讀/);assert.match(message,/日曆清單唯讀/);assert.match(message,/兩項權限/);assert.equal(h.el('#google-connect').hidden,false);assert.equal(h.el('#google-connect').disabled,false);assert.equal(h.calls.some(call=>call.path==='calendar/authorize'),false);assert.equal(h.locations.length,0);
  h.intervals[0]();await settle();assert.equal(h.calls.some(call=>call.path==='calendar/authorize'),false);await h.el('#google-connect').onclick();assert.equal(h.calls.filter(call=>call.path==='calendar/authorize').length,1);assert.equal(h.locations.length,1);
 }
 const data=base();data.sources[0].sharedCalendars=true;const complete=harness(()=>data,true,'2026-09-28',false,false,loginOptions({status:'approved',calendarConfigured:true,calendarAuthorizationRequired:false},{search:'?calendar=scope'}));await settle();assert.equal(complete.el('#google-connect').hidden,true,'a previously complete grant remains usable after a declined upgrade');assert.equal(complete.calls.some(call=>call.path==='calendar/authorize'),false);
});

test('older me responses fall back to one feed-based consent decision only after a successful login',async()=>{
 for(const state of ['unauthorized','reauthorize','ready']){
  const data=base();data.sources[0]={...data.sources[0],state,sharedCalendars:false};const h=harness(path=>path==='calendar/authorize'?consentUrl:data,true,'2026-09-28',false,false,loginOptions({status:'approved'}));await settle();
  assert.equal(h.calls[0].path,'calendar/feed?day=2026-09-28');assert.equal(h.calls.filter(call=>call.path==='calendar/authorize').length,1);await h.sync();assert.equal(h.calls.filter(call=>call.path==='calendar/authorize').length,1);
 }
 for(const variant of ['configured','source']){
  const data=base();if(variant==='configured')data.configured=false;else data.sources=data.sources.filter(s=>s.email!==email);const h=harness(()=>data,true,'2026-09-28',false,false,loginOptions({status:'approved'}));await settle();assert.equal(h.calls.some(call=>call.path==='calendar/authorize'),false,variant);
 }
});

test('an automatic consent failure exposes a settings retry and feed polling never retries the POST',async()=>{
 let fail=true;const data=base();data.sources[0].state='unauthorized';const h=harness(path=>{if(path==='calendar/authorize'){if(fail)throw Error('授權暫時無法開啟');return consentUrl;}return data;},true,'2026-09-28',false,false,loginOptions());await settle();
 assert.equal(h.locations.length,0);assert.equal(h.el('#google-connect').hidden,false);assert.equal(h.el('#google-connect').disabled,false);assert.match(h.el('#google-status').textContent,/授權暫時無法/);
 await h.sync();h.intervals[0]();await settle();assert.equal(h.calls.filter(call=>call.path==='calendar/authorize').length,1);fail=false;await h.el('#google-connect').onclick();assert.equal(h.calls.filter(call=>call.path==='calendar/authorize').length,2);assert.equal(h.locations.length,1);
 const bad=harness(path=>path==='calendar/authorize'?{url:'https://evil.example/'}:data,true,'2026-09-28',false,false,loginOptions());await settle();assert.equal(bad.locations.length,0);assert.equal(bad.el('#google-connect').hidden,false);assert.match(bad.el('#google-status').textContent,/網址不正確/);
});

test('a source revision change immediately clears old meetings, then reads only the cached shared feed',async()=>{
 let release;const changed=new Promise(resolve=>release=resolve);const h=harness(path=>path.endsWith('&cached=1')?changed:base());await h.sync();assert.equal(h.states.at(-1).events.length,1);
 h.emit('roomly:sourceschanged');assert.equal(h.states.at(-1).events.length,0);assert.equal(h.el('#shared-calendar-list').innerHTML,'');await settle();assert.equal(h.calls.at(-1).path,'calendar/feed?day=2026-09-28&cached=1');assert.equal(h.calls.some(call=>['calendar/sync','calendar/authorize'].includes(call.path)),false);
 release({...base(),sources:[]});await settle();assert.equal(h.states.at(-1).events.length,0);assert.match(h.el('#shared-summary').textContent,/0 位/);
});

test('a membership change invalidates an in-flight old feed so it cannot restore a removed source',async()=>{
 let release;const old=new Promise(resolve=>release=resolve);let first=true;const h=harness(path=>{if(path.endsWith('&cached=1'))return {...base(),sources:[]};if(first){first=false;return old;}return base();});const initial=h.sync();await settle();h.emit('roomly:sourceschanged');await settle();assert.equal(h.states.at(-1).events.length,0);release(base());await initial;assert.equal(h.states.at(-1).events.length,0);assert.equal(h.el('#shared-calendar-list').innerHTML,'');
});

test('source revision refreshes cover every visible week, and local-only viewing makes no extra requests',async()=>{
 const h=harness(crossWeekFeed,true,'2026-10-03');await h.sync();h.emit('roomly:sourceschanged');await settle();assert.deepEqual(h.calls.slice(-2).map(call=>call.path),['calendar/feed?day=2026-10-03&cached=1','calendar/feed?day=2026-10-05&cached=1']);
 h.el('#google-demo').onclick();const count=h.calls.length;h.emit('roomly:sourceschanged');await settle();assert.equal(h.calls.length,count);assert.equal(h.states.at(-1).local,true);
});

test('calendar changes retain the displayed meetings until all visible cached weeks finish, without consent or Google sync',async()=>{
 let release;const pending=new Promise(resolve=>release=resolve);const h=harness((path,body)=>path.endsWith('&cached=1')&&path.includes('day=2026-10-03')?pending:crossWeekFeed(path,body),true,'2026-10-03');await h.sync();const displayed=h.states.at(-1),rows=h.el('#shared-calendar-list').innerHTML;
 h.emit('roomly:calendarchanged');assert.equal(h.states.at(-1),displayed);assert.equal(h.el('#shared-calendar-list').innerHTML,rows);await settle();assert.equal(h.calls.at(-1).path,'calendar/feed?day=2026-10-03&cached=1');assert.equal(h.calls.length,3);
 release(crossWeekFeed('calendar/feed?day=2026-10-03&cached=1'));await settle();assert.deepEqual(h.calls.slice(2).map(call=>call.path),['calendar/feed?day=2026-10-03&cached=1','calendar/feed?day=2026-10-05&cached=1']);assert.notEqual(h.states.at(-1),displayed);assert.equal(h.states.at(-1).events.length,3);assert.equal(h.calls.some(call=>['calendar/sync','calendar/authorize'].includes(call.path)),false);assert.equal(h.locations.length,0);
});

test('meeting-version refreshes do not start or consume a pending login-consent handoff',async()=>{
 const data=base();data.sources[0]={...data.sources[0],state:'unauthorized',sharedCalendars:false,events:[]};const h=harness(path=>path==='calendar/authorize'?consentUrl:data,true,'2026-09-28',false,false,{search:'?login=success'});
 h.emit('roomly:calendarchanged');await settle();assert.deepEqual(h.calls.map(call=>call.path),['calendar/feed?day=2026-09-28&cached=1']);assert.equal(h.locations.length,0);assert.equal(h.el('#google-connect').hidden,false);
 await h.sync();assert.equal(h.calls.filter(call=>call.path==='calendar/authorize').length,1,'the real login load still makes its single required consent decision');
});

test('multiple calendar notifications during a pending sync coalesce into one cached refresh after it finishes',async()=>{
 let release;const pending=new Promise(resolve=>release=resolve);let regular=0;const h=harness(path=>path.endsWith('&cached=1')?{...base(),sources:[]}:++regular===1?base():pending);await h.sync();const updating=h.sync();await settle();
 for(let i=0;i<4;i++)h.emit('roomly:calendarchanged');await settle();assert.equal(h.calls.length,2);assert.equal(h.states.at(-1).events.length,1);
 release(base());await updating;await settle();assert.equal(h.calls.filter(call=>call.path.endsWith('&cached=1')).length,1);assert.equal(h.states.at(-1).events.length,0);assert.equal(h.el('#google-start').disabled,false);
});

test('notifications arriving during a cached refresh are retained for one following refresh',async()=>{
 let release;const pending=new Promise(resolve=>release=resolve);let cached=0;const h=harness(path=>path.endsWith('&cached=1')?(++cached===1?pending:{...base(),sources:[]}):base());await h.sync();h.emit('roomly:calendarchanged');await settle();
 for(let i=0;i<3;i++)h.emit('roomly:calendarchanged');await settle();assert.equal(cached,1);
 release(base());await settle();assert.equal(cached,2);assert.equal(h.states.at(-1).events.length,0);assert.equal(h.el('#google-start').disabled,false);
});

test('revocation clears immediately while a cached refresh is pending, invalidates its old result and queues only one safe reload',async()=>{
 let release;const pending=new Promise(resolve=>release=resolve);let cached=0;const h=harness(path=>path.endsWith('&cached=1')?(++cached===1?pending:{...base(),sources:[]}):base());await h.sync();h.emit('roomly:calendarchanged');await settle();
 h.emit('roomly:sourceschanged');h.emit('roomly:sourceschanged');h.emit('roomly:calendarchanged');assert.equal(h.states.at(-1).events.length,0);assert.equal(h.el('#shared-calendar-list').innerHTML,'');await settle();assert.equal(cached,1);
 const cleared=h.states.length;release(base());await settle();assert.equal(cached,2);assert.ok(h.states.slice(cleared).every(state=>state.events?.length===0),'a superseded response cannot republish the removed source');assert.equal(h.el('#google-start').disabled,false);
});

test('calendar changes during location saving are merged and read the cache only after the save and its normal reload',async()=>{
 let release;const pending=new Promise(resolve=>release=resolve),data=base();const h=harness(async(path,body)=>{if(path==='calendar/location'){await pending;data.location=body.location;return {ok:true};}return data;});await h.sync();h.el('#room-location').value='新地點';const saving=h.el('#location-filter').onsubmit({preventDefault(){}});
 h.emit('roomly:calendarchanged');h.emit('roomly:calendarchanged');await settle();assert.equal(h.calls.length,2);
 release();await saving;await settle();assert.deepEqual(h.calls.map(call=>call.path),['calendar/feed?day=2026-09-28','calendar/location','calendar/feed?day=2026-09-28','calendar/feed?day=2026-09-28&cached=1']);assert.equal(h.el('#room-location').value,'新地點');assert.equal(h.el('#location-apply').disabled,false);
});

test('a failed calendar-change refresh preserves meetings and controls, then the ten-minute fallback retries without requesting consent',async()=>{
 const h=harness(path=>{if(path.endsWith('&cached=1'))throw Error('快取暫時無法讀取');return base();});await h.sync();const displayed=h.states.at(-1);h.emit('roomly:calendarchanged');await settle();assert.equal(h.states.at(-1),displayed);assert.match(h.el('#google-status').textContent,/快取暫時/);assert.equal(h.el('#google-start').disabled,false);assert.equal(h.calls.filter(call=>call.path.endsWith('&cached=1')).length,1,'a failed cache read does not create a rapid retry loop');
 h.intervals[0]();await settle();assert.notEqual(h.states.at(-1),displayed);assert.equal(h.calls.at(-1).path,'calendar/feed?day=2026-09-28');assert.equal(h.calls.some(call=>['calendar/sync','calendar/authorize'].includes(call.path)),false);
});

test('calendar-change authentication failures clear meetings rather than preserving stale access',async()=>{
 const h=harness(path=>{if(path.endsWith('&cached=1')){const error=Error('請重新登入');error.status=403;throw error;}return base();});await h.sync();h.emit('roomly:calendarchanged');await settle();assert.equal(h.states.at(-1).events,undefined);assert.equal(h.el('#shared-calendar-list').innerHTML,'');assert.match(h.el('#google-status').textContent,/重新登入/);
});

test('hidden calendar notifications wait for visibility and local-only viewing ignores further notifications',async()=>{
 const h=harness(crossWeekFeed,true,'2026-10-03');await h.sync();const displayed=h.states.at(-1);h.context.document.hidden=true;h.emit('roomly:calendarchanged');h.emit('roomly:calendarchanged');await settle();assert.equal(h.calls.length,2);assert.equal(h.states.at(-1),displayed);
 h.context.document.hidden=false;h.emitDocument('visibilitychange');await settle();assert.deepEqual(h.calls.slice(2).map(call=>call.path),['calendar/feed?day=2026-10-03&cached=1','calendar/feed?day=2026-10-05&cached=1']);
 h.el('#google-demo').onclick();const count=h.calls.length;h.emit('roomly:calendarchanged');h.emitDocument('visibilitychange');await settle();assert.equal(h.calls.length,count);assert.equal(h.states.at(-1).local,true);
});

const minuteStatusCheck=h=>h.intervals[h.intervalTimes.indexOf(60000)]();
function unresolvedFeed(state='stale'){
 const data=base();data.sources[1]={...data.sources[1],state,syncedAt:state==='waiting'?null:1};return data;
}

test('unchanged meetings becoming ready keep timestamps refreshed from cache each minute',async()=>{
 for(const state of ['stale','waiting']){
  let completed=false;const h=harness(()=>completed?base():unresolvedFeed(state));await h.sync();const displayed=h.states.at(-1);
  assert.match(h.el('#shared-calendar-list').innerHTML,state==='stale'?/資料逾時/:/等待首次同步/);
  // No calendarRevision or source-change event is emitted; only the server's
  // successful sync time/state changes, while the reservation stays identical.
  completed=true;minuteStatusCheck(h);await settle();
  assert.deepEqual(h.calls.map(call=>call.path),['calendar/feed?day=2026-09-28','calendar/feed?day=2026-09-28&cached=1']);
  assert.notEqual(h.states.at(-1),displayed);assert.deepEqual(h.states.at(-1).events,displayed.events);
  assert.doesNotMatch(h.el('#shared-calendar-list').innerHTML,/資料逾時|等待首次同步/);assert.doesNotMatch(h.el('#google-status').textContent,/來源尚未完成/);
  const count=h.calls.length;for(let i=0;i<3;i++){minuteStatusCheck(h);await settle();}assert.equal(h.calls.length,count+3,'ready source timestamps remain observable');
  assert.equal(h.calls.some(call=>['calendar/sync','calendar/authorize'].includes(call.path)),false);assert.equal(h.locations.length,0);
 }
});

test('connected sources keep minute cache checks while missing-only grants retain the ten-minute fallback',async()=>{
 for(const state of ['ready','error','unauthorized','reauthorize']){
  const data=base();data.sources=data.sources.map(source=>({...source,state}));const h=harness(()=>data);await h.sync();const count=h.calls.length;
  for(let i=0;i<3;i++){minuteStatusCheck(h);await settle();}const checks=['ready','error'].includes(state)?3:0;assert.equal(h.calls.length,count+checks,state);
  assert.ok(h.calls.slice(1).every(call=>call.path.endsWith('&cached=1')));
  h.intervals[0]();await settle();assert.equal(h.calls.length,count+checks+1);assert.equal(h.calls.at(-1).path,'calendar/feed?day=2026-09-28');
  assert.equal(h.calls.some(call=>['calendar/sync','calendar/authorize'].includes(call.path)),false);
 }
});

test('a stale covered week reads all visible weeks sequentially and keeps successful timestamps observable',async()=>{
 let release,completed=false;const pending=new Promise(resolve=>release=resolve);
 const h=harness((path,body)=>{
  const data=crossWeekFeed(path,body);if(!completed&&data.week!==week)data.sources[1].state='stale';
  if(path.endsWith('&cached=1')&&data.week===week)return pending;return data;
 },true,'2026-10-03');await h.sync();assert.match(h.el('#shared-calendar-list').innerHTML,/資料逾時/);
 completed=true;minuteStatusCheck(h);await settle();assert.equal(h.calls.length,3);assert.equal(h.calls.at(-1).path,'calendar/feed?day=2026-10-03&cached=1');
 for(let i=0;i<3;i++)minuteStatusCheck(h);await settle();assert.equal(h.calls.length,3,'a pending first week cannot start parallel or second-week requests');
 release(crossWeekFeed('calendar/feed?day=2026-10-03&cached=1'));await settle();
 assert.deepEqual(h.calls.slice(2).map(call=>call.path),['calendar/feed?day=2026-10-03&cached=1','calendar/feed?day=2026-10-05&cached=1']);
 assert.doesNotMatch(h.el('#shared-calendar-list').innerHTML,/資料逾時/);minuteStatusCheck(h);await settle();assert.equal(h.calls.length,6);
 assert.equal(h.calls.some(call=>['calendar/sync','calendar/authorize'].includes(call.path)),false);assert.equal(h.locations.length,0);
});

test('successful feed reloads consume queued minute checks without overlapping requests',async()=>{
 for(const resolved of [false,true]){
  let release,regular=0;const pending=new Promise(resolve=>release=resolve);
  const h=harness(path=>path.endsWith('&cached=1')?base():++regular===1?unresolvedFeed():pending);
  await h.sync();const updating=h.sync();await settle();
  for(let i=0;i<4;i++)minuteStatusCheck(h);await settle();assert.equal(h.calls.length,2,'busy updates do not overlap');
  release(resolved?base():unresolvedFeed());await updating;await settle();
  assert.equal(h.calls.filter(call=>call.path.endsWith('&cached=1')).length,0,'the completed reload already reads current status');
  if(resolved)assert.doesNotMatch(h.el('#shared-calendar-list').innerHTML,/資料逾時/);else assert.match(h.el('#shared-calendar-list').innerHTML,/資料逾時/);assert.equal(h.el('#google-start').disabled,false);
 }
});

test('minute status checks and calendar notifications during location saving share one queued cached reload',async()=>{
 let release;const pending=new Promise(resolve=>release=resolve),data=unresolvedFeed();
 const h=harness(async(path,body)=>{if(path==='calendar/location'){await pending;data.location=body.location;return {ok:true};}return data;});
 await h.sync();h.el('#room-location').value='新地點';const saving=h.el('#location-filter').onsubmit({preventDefault(){}});
 for(let i=0;i<3;i++){minuteStatusCheck(h);h.emit('roomly:calendarchanged');}await settle();assert.equal(h.calls.length,2);
 release();await saving;await settle();assert.deepEqual(h.calls.map(call=>call.path),['calendar/feed?day=2026-09-28','calendar/location','calendar/feed?day=2026-09-28','calendar/feed?day=2026-09-28&cached=1']);
 assert.equal(h.el('#room-location').value,'新地點');assert.equal(h.locations.length,0);
});

test('hidden and local-only boards skip minute status checks while pending or completed consent suppresses all polls',async()=>{
 const hidden=harness(()=>unresolvedFeed());await hidden.sync();hidden.context.document.hidden=true;
 for(let i=0;i<3;i++)minuteStatusCheck(hidden);await settle();assert.equal(hidden.calls.length,1);
 hidden.context.document.hidden=false;minuteStatusCheck(hidden);await settle();assert.equal(hidden.calls.at(-1).path,'calendar/feed?day=2026-09-28&cached=1');
 hidden.el('#google-demo').onclick();const count=hidden.calls.length;minuteStatusCheck(hidden);hidden.intervals[0]();hidden.emit('roomly:calendarchanged');await settle();assert.equal(hidden.calls.length,count);

 let release;const pending=new Promise(resolve=>release=resolve),data=unresolvedFeed();data.sources[0].state='unauthorized';
 const consent=harness(path=>path==='calendar/authorize'?pending:data);await consent.sync();const authorizing=consent.el('#google-connect').onclick();await settle();
 for(let i=0;i<3;i++)minuteStatusCheck(consent);consent.intervals[0]();consent.emitDocument('visibilitychange');consent.emit('roomly:calendarchanged');await consent.sync();await settle();
 assert.deepEqual(consent.calls.map(call=>call.path),['calendar/feed?day=2026-09-28','calendar/authorize']);
 release(consentUrl);await authorizing;minuteStatusCheck(consent);consent.intervals[0]();await settle();assert.equal(consent.calls.length,2);assert.equal(consent.locations.length,1);
});

test('failed minute cache reads preserve stale meetings, retry on the next minute and never open consent',async()=>{
 let fail=true;const h=harness(path=>{if(path.endsWith('&cached=1')){if(fail)throw Error('快取暫時無法讀取');return base();}return unresolvedFeed();});
 await h.sync();const displayed=h.states.at(-1);minuteStatusCheck(h);await settle();
 assert.equal(h.states.at(-1),displayed);assert.match(h.el('#google-status').textContent,/快取暫時/);assert.equal(h.calls.length,2,'cache failures do not immediately loop');assert.equal(h.el('#google-start').disabled,false);
 fail=false;minuteStatusCheck(h);await settle();assert.equal(h.calls.length,3);assert.doesNotMatch(h.el('#shared-calendar-list').innerHTML,/資料逾時/);minuteStatusCheck(h);await settle();assert.equal(h.calls.length,4);
 assert.equal(h.calls.some(call=>['calendar/sync','calendar/authorize'].includes(call.path)),false);assert.equal(h.locations.length,0);
});

test('source success dates include Taipei seconds and the owner stays visible with the list collapsed',async()=>{
 const data=base(),first=Math.floor(Date.parse('2026-10-04T04:20:59Z')/1000);data.sources[0].syncedAt=first;
 const h=harness(()=>data);await h.sync();
 assert.equal(h.el('#own-sync-status').hidden,false);assert.equal(h.el('#own-sync-status').textContent,'我的來源：同步成功 · 最後成功 2026/10/04 12:20:59');
 const rows=h.el('#shared-calendar-list').innerHTML;assert.match(rows,/data-own="true"/);assert.match(rows,/shared-sync-state">同步成功 · 這五天 1 場/);assert.match(rows,/最後成功同步：2026\/10\/04 12:20:59/);
 const before=h.states.at(-1).events;data.sources[0].syncedAt=first+601;minuteStatusCheck(h);await settle();
 assert.match(h.el('#own-sync-status').textContent,/2026\/10\/04 12:31:00/);assert.deepEqual(h.states.at(-1).events,before);assert.equal(h.calls.at(-1).path,'calendar/feed?day=2026-09-28&cached=1');
 assert.equal(h.calls.some(call=>call.path==='calendar/sync'||call.path==='calendar/authorize'),false);
});

test('failed refreshes cannot advance the last-success timestamp or claim manual sync succeeded',async()=>{
 const data=base();data.sources[0].syncedAt=Math.floor(Date.parse('2026-10-03T15:59:58Z')/1000);let fail=false;
 const h=harness(path=>{if(fail)throw Error('暫時無法同步');return data;});await h.sync();const rows=h.el('#shared-calendar-list').innerHTML;
 fail=true;await h.el('#google-start').onclick();assert.equal(h.el('#own-sync-status').textContent,'我的來源：本次同步失敗 · 最後成功 2026/10/03 23:59:58');assert.equal(h.el('#own-sync-status').dataset.state,'error');assert.equal(h.el('#shared-calendar-list').innerHTML,rows);
 minuteStatusCheck(h);await settle();assert.match(h.el('#own-sync-status').textContent,/狀態讀取失敗.*2026\/10\/03 23:59:58/);
 fail=false;minuteStatusCheck(h);await settle();assert.match(h.el('#own-sync-status').textContent,/同步成功.*2026\/10\/03 23:59:58/);
});

test('multiweek success time uses the oldest covered week and missing, revoked and local sources cannot show success',async()=>{
 const old=Math.floor(Date.parse('2026-10-04T04:00:05Z')/1000),recent=old+600;
 const h=harness((path,body)=>{const data=crossWeekFeed(path,body);data.sources[0].syncedAt=data.week===week?recent:old;return data;},true,'2026-10-03');await h.sync();
 assert.match(h.el('#own-sync-status').textContent,/2026\/10\/04 12:00:05/);assert.doesNotMatch(h.el('#own-sync-status').textContent,/12:10:05/);
 for(const state of ['unauthorized','reauthorize','waiting']){
  const data=base();data.sources=[{...data.sources[0],state,syncedAt:state==='waiting'?null:recent,events:[]}];const missing=harness(()=>data);await missing.sync();
  assert.doesNotMatch(missing.el('#own-sync-status').textContent,/同步成功|最後成功/);assert.doesNotMatch(missing.el('#shared-calendar-list').innerHTML,/最後成功同步：/);
 }
 h.el('#google-demo').onclick();assert.equal(h.el('#own-sync-status').hidden,true);assert.equal(h.el('#own-sync-status').textContent,'');
 const removed=harness(()=>base());await removed.sync();removed.emit('roomly:sourceschanged');assert.equal(removed.el('#own-sync-status').hidden,true);assert.equal(removed.el('#own-sync-status').textContent,'');await settle();
});
