import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {createHandler} from '../src/worker.ts';
import {sealToken,openToken,taipeiWeek,minimizeEvent,syncCalendars,calendarMaintenance} from '../src/calendar.ts';
import {createRequire} from 'node:module';
const Core=createRequire(import.meta.url)('../core.js');
const origin='https://roomly.example.com',admin='roomly-admin@gmail.com',week=taipeiWeek();
const eventScope='https://www.googleapis.com/auth/calendar.events.readonly',listScope='https://www.googleapis.com/auth/calendar.calendarlist.readonly',fullScopes='openid '+eventScope+' '+listScope;
const meeting={id:'e1',iCalUID:'shared-invitation',summary:'共同會議',location:'台北 主會議室',start:{dateTime:week+'T10:00:00+08:00'},end:{dateTime:week+'T11:00:00+08:00'},attendees:[{email:'teammate@gmail.com',displayName:'成員',responseStatus:'accepted'}],description:'NEVER_STORE_PRIVATE_NOTES',attachments:[{fileUrl:'private-url'}],hangoutLink:'https://meet.google.com/abc-defg-hij'};
const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json'}});
function fixture(){
  const sqlite=new DatabaseSync(':memory:');for(const name of ['0001_access','0002_email_allowlist','0003_shared_calendar','0004_shared_calendar_list','0005_calendar_watch','0006_calendar_revision','0007_calendar_enqueue_gates'])sqlite.exec(readFileSync(new URL('../migrations/'+name+'.sql',import.meta.url),'utf8'));
  const DB={prepare(sql){const s=sqlite.prepare(sql);let values=[];return {bind(...v){values=v;return this;},async first(){return s.get(...values)||null;},async all(){return {results:s.all(...values)};},run(){return {meta:{changes:s.run(...values).changes}};}};},async batch(statements){sqlite.exec('BEGIN');try{const values=statements.map(statement=>statement.run());sqlite.exec('COMMIT');return values;}catch(error){sqlite.exec('ROLLBACK');throw error;}}};
  const env={DB,EMAIL:{async send(){}},ASSETS:{async fetch(){return new Response('asset');}},APP_ORIGIN:origin,GOOGLE_CLIENT_ID:'client',GOOGLE_CLIENT_SECRET:'test-client-secret',CALENDAR_TOKEN_KEY:'11'.repeat(32),ADMIN_EMAIL:admin,MAIL_FROM:'roomly@example.com'};
  const pending=[],verifications=[];const handler=createHandler(async(credential,clientId,nonce)=>{verifications.push({clientId,nonce});return JSON.parse(credential);});
  const call=(path,options={})=>handler.fetch(new Request(origin+'/roomly/api/'+path,options),env,{waitUntil(p){pending.push(p);}});
  const post=(path,body,cookie='',headers={})=>call(path,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json',Cookie:cookie,...headers},body:JSON.stringify(body)});
  const get=(path,cookie='')=>call(path,{headers:{Cookie:cookie}});
  async function login(email,sub){const challenge=await call('challenge'),data=await challenge.json(),nonceCookie=challenge.headers.getSetCookie()[0].split(';')[0];const r=await post('login',{nonce:data.nonce,credential:JSON.stringify({email,sub,name:'姓名',emailAuthoritative:true})},nonceCookie);assert.equal(r.status,200);await Promise.all(pending.splice(0));return r.headers.getSetCookie()[0].split(';')[0];}
  async function connect(sub){await env.DB.prepare("INSERT INTO calendar_connections(member_sub,refresh_cipher,version,status,updated_at) VALUES(?,?,?,'connected',0)").bind(sub,await sealToken(env,sub,'refresh-'+sub),'version-'+sub).run();}
  async function location(cookie){assert.equal((await post('calendar/location',{location:'主會議室'},cookie)).status,200);}
  return {sqlite,env,call,post,get,login,connect,location,verifications};
}
async function mocked(handler,action){const original=globalThis.fetch;const calls=[];globalThis.fetch=async(url,options={})=>{calls.push({url:String(url),options});if(new URL(url).pathname.endsWith('/watch')){const body=JSON.parse(options.body);return json({kind:'api#channel',id:body.id,resourceId:'fixture-resource-'+body.id,expiration:Date.now()+7*86400000});}return handler(new URL(url),options);};try{return await action(calls);}finally{globalThis.fetch=original;}}
const normalGoogle=(url,options)=>url.hostname==='oauth2.googleapis.com'?json({access_token:'access-'+new URLSearchParams(options.body).get('refresh_token')}):json({accessRole:'owner',items:[meeting]});
async function team(){const f=fixture(),owner=await f.login(admin,'admin'),member=await f.login('teammate@gmail.com','member');await f.post('admin/review',{sub:'member',status:'approved'},owner);await f.location(owner);return {f,owner,member};}
test('shared feed is gated; only logged-in approved accounts become sources, not preapproved Emails',async()=>{
  const f=fixture();for(const path of ['calendar-sources','calendar/feed'])assert.equal((await f.get(path)).status,401);
  const pending=await f.login('waiting@gmail.com','pending');assert.equal((await f.get('calendar/feed',pending)).status,403);
  const owner=await f.login(admin,'admin');await f.post('admin/allowlist/add',{email:'unregistered@gmail.com'},owner);
  const feed=await (await f.get('calendar/feed',owner)).json();assert.deepEqual(feed.sources.map(s=>s.email),[admin]);assert.equal(feed.sources[0].state,'unauthorized');assert.equal(feed.location,'');
  assert.ok(!JSON.stringify(feed).includes('pending'));assert.ok(!JSON.stringify(feed).includes('member_sub'));
  assert.deepEqual((await (await f.get('calendar-sources',owner)).json()).emails,[admin]);
});

test('cached membership refresh drops revoked sources without contacting Google or renewing expired snapshots',async()=>{
  const {f,owner,member}=await team();await f.connect('admin');await f.connect('member');
  await mocked(normalGoogle,async()=>{const feed=await (await f.get('calendar/feed?day='+week,owner)).json();assert.equal(feed.sources.length,2);assert.ok(feed.sources.every(source=>source.events.length===1));});
  f.sqlite.exec('UPDATE calendar_snapshots SET retry_at=0,synced_at=1');await f.post('admin/review',{sub:'member',status:'rejected'},owner);
  await mocked(()=>{throw Error('cached membership refresh must not contact Google');},async calls=>{
    const response=await f.get('calendar/feed?day='+week+'&cached=1',owner);assert.equal(response.status,200);const feed=await response.json();assert.deepEqual(feed.sources.map(source=>source.email),[admin]);assert.equal(calls.length,0);assert.equal(f.sqlite.prepare("SELECT synced_at FROM calendar_snapshots WHERE member_sub='admin'").get().synced_at,1);
    assert.equal((await f.get('calendar/feed?day='+week+'&cached=1',member)).status,403);assert.equal(calls.length,0);
  });
  for(const table of ['calendar_connections','calendar_snapshots'])assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM '+table+' WHERE member_sub=?').get('member').n,0);
});
test('only administrator can set the shared location; malformed changes do not clear data',async()=>{
  const {f,owner,member}=await team();assert.equal((await f.post('calendar/location',{location:'Other'},member)).status,403);
  for(const location of ['', ' ', 'x'.repeat(101), null])assert.equal((await f.post('calendar/location',{location},owner)).status,400);
  assert.equal((await f.post('calendar/location',{location:'Other'},owner,{Origin:'https://evil.example'})).status,403);
  assert.equal(f.sqlite.prepare('SELECT location FROM room_settings').get().location,'主會議室');
});
test('OAuth start binds state to member and session, requests event and calendar-list readonly offline scopes and hides secrets',async()=>{
  const {f,member}=await team(),response=await f.post('calendar/authorize',{},member),data=await response.json();assert.equal(response.status,200);
  const url=new URL(data.url);assert.equal(url.origin,'https://accounts.google.com');assert.equal(url.searchParams.get('access_type'),'offline');assert.equal(url.searchParams.get('prompt'),'consent');assert.equal(url.searchParams.get('redirect_uri'),origin+'/roomly/api/calendar/callback');assert.equal(url.searchParams.get('login_hint'),'teammate@gmail.com');assert.deepEqual(url.searchParams.get('scope').split(' '),['openid','email','https://www.googleapis.com/auth/calendar.events.readonly','https://www.googleapis.com/auth/calendar.calendarlist.readonly']);
  assert.ok(!JSON.stringify(data).includes('test-client-secret'));assert.ok(!JSON.stringify(data).includes('11'.repeat(32)));
  const row=f.sqlite.prepare('SELECT * FROM calendar_oauth_states').get();assert.notEqual(row.hash,url.searchParams.get('state'));assert.equal(row.member_sub,'member');assert.ok(row.expires_at>Math.floor(Date.now()/1000));
});
test('authorization works before room setup while missing server credentials still block it',async()=>{
  const f=fixture(),owner=await f.login(admin,'admin');const start=await f.post('calendar/authorize',{},owner);assert.equal(start.status,200);assert.equal(new URL((await start.json()).url).hostname,'accounts.google.com');assert.equal(f.sqlite.prepare('SELECT location FROM room_settings').get().location,'');
  delete f.env.GOOGLE_CLIENT_SECRET;assert.equal((await f.post('calendar/authorize',{},owner)).status,503);assert.equal((await (await f.get('calendar/feed',owner)).json()).configured,false);
});

test('consent before room setup saves only the grant and begins meeting sync after a location is supplied',async()=>{
  const f=fixture(),owner=await f.login(admin,'admin');const start=new URL((await (await f.post('calendar/authorize',{},owner)).json()).url);
  await mocked((url,options)=>url.hostname==='oauth2.googleapis.com'&&new URLSearchParams(options.body).get('grant_type')==='authorization_code'?json({id_token:JSON.stringify({sub:'admin'}),refresh_token:'fixture-refresh',scope:fullScopes}):normalGoogle(url,options),async calls=>{
    const response=await f.get('calendar/callback?state='+encodeURIComponent(start.searchParams.get('state'))+'&code=fixture-code',owner);assert.equal(response.status,303);assert.match(response.headers.get('Location'),/calendar=connected/);assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM calendar_connections').get().n,1);assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM calendar_snapshots').get().n,0);assert.equal(calls.filter(c=>new URL(c.url).pathname.endsWith('/calendars/primary/events')).length,0);
    await f.location(owner);const feed=await (await f.get('calendar/feed',owner)).json();assert.equal(feed.sources[0].state,'ready');assert.equal(feed.sources[0].events.length,1);assert.equal(calls.filter(c=>new URL(c.url).pathname.endsWith('/calendars/primary/events')).length,1);
  });
});
test('callback cannot use another member/session or replay a consumed state',async()=>{
  const {f,owner,member}=await team();const url=new URL((await (await f.post('calendar/authorize',{},member)).json()).url),state=url.searchParams.get('state'),path='calendar/callback?state='+encodeURIComponent(state)+'&error=access_denied';
  assert.equal((await f.get(path,owner)).status,400);const anotherSession=await f.login('teammate@gmail.com','member');assert.equal((await f.get(path,anotherSession)).status,400);
  const cancelled=await f.get(path,member);assert.equal(cancelled.status,303);assert.equal(cancelled.headers.get('Location'),origin+'/roomly/?calendar=cancelled');assert.equal((await f.get(path,member)).status,400);assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM calendar_connections').get().n,0);
});
test('code exchange requires complete readonly consent, accepts exact legacy grants and enforces account and token privacy',async()=>{
  const scopes={
    'wrong-account':fullScopes,
    'missing-scope':'openid',
    'absent-scope':undefined,
    'event-only':'openid '+eventScope,
    'list-only':'openid '+listScope,
    'near-event':'openid '+eventScope+'.extra '+listScope,
    'near-list':'openid '+eventScope+' '+listScope+'.extra',
    'near-legacy':'openid https://www.googleapis.com/auth/calendar.readonly.extra',
    'correct-shared':fullScopes,
    'correct-legacy':'openid https://www.googleapis.com/auth/calendar.readonly',
    'correct-both':'openid https://www.googleapis.com/auth/calendar.events.readonly https://www.googleapis.com/auth/calendar.readonly'
  };
  for(const [mode,scope] of Object.entries(scopes)){
    const accepted=mode.startsWith('correct-');
    const {f,member}=await team(),url=new URL((await (await f.post('calendar/authorize',{},member)).json()).url),nonce=url.searchParams.get('nonce');
    await mocked((url,options)=>url.hostname==='oauth2.googleapis.com'&&new URLSearchParams(options.body).get('grant_type')==='authorization_code'?json({id_token:JSON.stringify({sub:mode==='wrong-account'?'someone-else':'member'}),refresh_token:'PRIVATE_REFRESH',access_token:'PRIVATE_ACCESS',scope}):normalGoogle(url,options),async calls=>{
      const r=await f.get('calendar/callback?state='+encodeURIComponent(url.searchParams.get('state'))+'&code=one-time-code',member);assert.equal(r.status,303);const location=r.headers.get('Location');assert.match(location,new RegExp('calendar='+(accepted?'connected':mode==='wrong-account'?'account':'scope')),mode);assert.ok(!location.includes('PRIVATE'));assert.equal(await r.text(),'');
      if(!accepted)assert.equal(calls.length,1,'rejected consent only exchanges the authorization code, without Calendar sync');
    });
    const c=f.sqlite.prepare('SELECT * FROM calendar_connections').get();if(!accepted){assert.equal(c,undefined,mode);assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM calendar_snapshots').get().n,0);}else {assert.ok(!c.refresh_cipher.includes('PRIVATE_REFRESH'));assert.equal(await openToken(f.env,'member',c.refresh_cipher),'PRIVATE_REFRESH');assert.equal(c.shared_calendars,1);assert.equal(f.verifications.at(-1).nonce,nonce);assert.equal(f.verifications.at(-1).clientId,'client');}
  }
});

test('partial consent preserves an existing primary-only or complete grant and cached meetings without starting synchronization',async()=>{
  for(const shared of [0,1])for(const scope of ['openid '+eventScope,'openid '+listScope]){
    const {f,owner,member}=await team();await f.connect('member');f.sqlite.prepare("UPDATE calendar_connections SET shared_calendars=? WHERE member_sub='member'").run(shared);
    await mocked(normalGoogle,()=>f.get('calendar/feed?day='+week,owner));
    const previous=f.sqlite.prepare("SELECT * FROM calendar_connections WHERE member_sub='member'").get(),snapshots=f.sqlite.prepare("SELECT * FROM calendar_snapshots WHERE member_sub='member' ORDER BY week_start").all();assert.equal(snapshots.length,1);
    const url=new URL((await (await f.post('calendar/authorize',{},member)).json()).url);
    await mocked((requestUrl,options)=>{
      assert.equal(requestUrl.href,'https://oauth2.googleapis.com/token');assert.equal(new URLSearchParams(options.body).get('grant_type'),'authorization_code');return json({id_token:JSON.stringify({sub:'member'}),refresh_token:'replacement-refresh-must-not-be-saved',scope});
    },async calls=>{
      const callback=await f.get('calendar/callback?state='+encodeURIComponent(url.searchParams.get('state'))+'&code=partial-code',member);assert.equal(callback.status,303);assert.equal(callback.headers.get('Location'),origin+'/roomly/?calendar=scope');assert.equal(calls.length,1);
    });
    assert.deepEqual(f.sqlite.prepare("SELECT * FROM calendar_connections WHERE member_sub='member'").get(),previous,'cipher, version, status and shared capability are unchanged');assert.deepEqual(f.sqlite.prepare("SELECT * FROM calendar_snapshots WHERE member_sub='member' ORDER BY week_start").all(),snapshots,'partial consent must not erase cached meetings');assert.equal(await openToken(f.env,'member',previous.refresh_cipher),'refresh-member');
    const me=await (await f.get('me',member)).json();assert.equal(me.calendarAuthorizationRequired,!shared);assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM calendar_oauth_states WHERE member_sub='member'").get().n,0,'partial consent consumes its callback state');
  }
});
test('AES encryption binds grants to Google subject and detects tampering',async()=>{
  const f=fixture(),cipher=await sealToken(f.env,'a','refresh');assert.equal(await openToken(f.env,'a',cipher),'refresh');await assert.rejects(openToken(f.env,'b',cipher));const data=JSON.parse(cipher);data[1][0]^=1;await assert.rejects(openToken(f.env,'a',JSON.stringify(data)));
});
test('backend reads each authorized primary Calendar and shares matching events across sessions',async()=>{
  const {f,owner,member}=await team();await f.connect('admin');await f.connect('member');
  await mocked((url,options)=>url.hostname==='oauth2.googleapis.com'?normalGoogle(url,options):json({accessRole:'owner',items:[meeting,{...meeting,id:'private',iCalUID:'private',location:'私人地點'},{...meeting,id:'cancelled',status:'cancelled'}]}),async calls=>{
    const feed=await (await f.get('calendar/feed?day='+week,owner)).json();assert.equal(feed.sources.length,2);for(const source of feed.sources){assert.equal(source.state,'ready');assert.equal(source.events.length,1);assert.equal(source.events[0].iCalUID,'shared-invitation');}
    const count=calls.length,other=await (await f.get('calendar/feed?day='+week,member)).json();assert.deepEqual(other.sources,feed.sources);assert.equal(calls.length,count,'fresh snapshots do not refresh again');
    assert.equal(calls.filter(c=>new URL(c.url).pathname.endsWith('/calendars/primary/events')).length,2);const serialized=JSON.stringify(other);for(const forbidden of ['PRIVATE_NOTES','description','attachments','refresh-', 'access-', 'member_sub'])assert.ok(!serialized.includes(forbidden));
    assert.ok(f.sqlite.prepare('SELECT data FROM calendar_snapshots').get().data.includes('共同會議'));
  });
});

const companyCalendar='company+team@group.calendar.google.com';
const calendarId=url=>decodeURIComponent(url.pathname.split('/')[4]);
const recurringMeeting=day=>({...meeting,id:'series_'+day.replaceAll('-',''),iCalUID:'company-weekly',summary:'例行週會',start:{dateTime:day+'T14:00:00+08:00'},end:{dateTime:day+'T16:00:00+08:00'},recurringEventId:'company_series',originalStartTime:{dateTime:day+'T14:00:00+08:00'}});

test('shared company calendars bring in weekly meetings, pagination and distinct occurrences without persisting the calendar list',async()=>{
  const {f,owner}=await team();await f.connect('admin');f.sqlite.exec('UPDATE calendar_connections SET shared_calendars=1');let cancelled=false;
  const google=(url,options)=>{
    if(url.hostname==='oauth2.googleapis.com')return json({access_token:'fixture-access',scope:listScope+' https://www.googleapis.com/auth/calendar.events.readonly'});
    if(url.pathname.endsWith('/calendarList'))return url.searchParams.has('pageToken')?json({items:[{id:companyCalendar,accessRole:'reader'},{id:'hidden-calendar',hidden:true,accessRole:'owner'},{id:'deleted-calendar',deleted:true,accessRole:'owner'},{id:'busy-only',accessRole:'freeBusyReader'}]}):json({items:[{id:'admin@gmail.com',primary:true,accessRole:'owner'}],nextPageToken:'list-page-2'});
    if(calendarId(url)==='primary')return json({accessRole:'owner',items:[]});
    assert.equal(calendarId(url),companyCalendar);const day=url.searchParams.get('timeMin').startsWith('2026-10-05')?'2026-10-08':'2026-10-15';
    return url.searchParams.has('pageToken')?json({accessRole:'reader',items:[{...meeting,location:'私人地點',description:'PRIVATE_NOTES'}]}):json({accessRole:'reader',items:[{...recurringMeeting(day),...(cancelled?{status:'cancelled'}:{})}],nextPageToken:'events-page-2'});
  };
  await mocked(google,async calls=>{
    const first=await (await f.get('calendar/feed?day=2026-10-08',owner)).json(),source=first.sources.find(s=>s.email===admin);
    assert.equal(source.state,'ready');assert.equal(source.sharedCalendars,true);assert.equal(source.calendarCount,2);assert.equal(source.events.length,1);assert.equal(source.events[0].start.dateTime,'2026-10-08T14:00:00+08:00');assert.match(source.events[0].calendarKey,/^[a-f0-9]{64}$/);
    for(const c of calls.filter(c=>new URL(c.url).pathname.endsWith('/events'))){const u=new URL(c.url);assert.equal(u.searchParams.get('singleEvents'),'true');assert.equal(u.searchParams.get('timeZone'),'Asia/Taipei');assert.equal(u.searchParams.get('timeMin'),'2026-10-05T00:00:00+08:00');assert.equal(u.searchParams.get('timeMax'),'2026-10-11T16:00:00.000Z');}
    assert.ok(calls.some(c=>c.url.includes(encodeURIComponent(companyCalendar))));assert.equal(calls.filter(c=>new URL(c.url).pathname.endsWith('/calendarList')).length,2);
    const second=await (await f.get('calendar/feed?day=2026-10-15',owner)).json(),events=[...source.events,...second.sources.find(s=>s.email===admin).events];
    const merged=Core.mergeGoogle([{calendar:{id:admin,name:admin,kind:'person'},events}],{room:{id:'forest',name:'主會議室'}});assert.equal(merged.length,2);assert.deepEqual(merged.map(e=>Core.date(e.startISO)).sort(),['2026-10-08','2026-10-15']);
    assert.ok(Core.overlapsDays(Date.parse(merged[0].startISO),Date.parse(merged[0].endISO),Core.boardDays('2026-10-04')));
    const stored=f.sqlite.prepare('SELECT data FROM calendar_snapshots WHERE week_start=?').get('2026-10-05').data;for(const forbidden of [companyCalendar,'hidden-calendar','PRIVATE_NOTES','私人地點'])assert.ok(!stored.includes(forbidden));
    cancelled=true;f.sqlite.exec('UPDATE calendar_snapshots SET retry_at=0');const refreshed=await (await f.get('calendar/feed?day=2026-10-08',owner)).json();assert.deepEqual(refreshed.sources.find(s=>s.email===admin).events,[]);
  });
});

test('projected Google responses preserve pagination, room permissions, recurring versions and participant/Meet details',async()=>{
  const {f,owner}=await team();await f.connect('admin');f.sqlite.exec('UPDATE calendar_connections SET shared_calendars=1');
  // Model partial responses from the requested selector, rather than returning
  // full fixtures that could hide an accidentally omitted required field.
  function project(value,fields){
    assert.ok(typeof fields==='string'&&fields.length,'list requests must select fields');
    if(Array.isArray(value))return value.map(item=>project(item,fields));
    const selected={};let depth=0,start=0;
    for(let i=0;i<=fields.length;i++){
      if(fields[i]==='(')depth++;else if(fields[i]===')')depth--;
      assert.ok(depth>=0,'balanced fields selector');
      if(i<fields.length&&(fields[i]!==','||depth!==0))continue;
      const match=/^([A-Za-z]\w*)(?:\((.*)\))?$/.exec(fields.slice(start,i));assert.ok(match,'valid field selector');start=i+1;
      const [,name,nested]=match;if(Object.hasOwn(value,name))selected[name]=nested===undefined?value[name]:project(value[name],nested);
    }
    assert.equal(depth,0);return selected;
  }
  const addDays=n=>new Date(Date.parse(week+'T00:00:00Z')+n*86400000).toISOString().slice(0,10);
  const occurrence={...meeting,id:'old-series',iCalUID:'projected-series',summary:'Old reservation',sequence:1,updated:week+'T08:00:00Z',recurringEventId:'projected_series',originalStartTime:{dateTime:week+'T10:00:00+08:00',timeZone:'Asia/Taipei'}};
  const moved={...occurrence,id:'new-series',summary:'Moved reservation',sequence:2,updated:week+'T09:00:00Z',start:{dateTime:addDays(2)+'T14:07:00+08:00'},end:{dateTime:addDays(2)+'T15:12:00+08:00'}};
  const another={...occurrence,id:'next-occurrence',originalStartTime:{dateTime:addDays(3)+'T10:00:00+08:00'},start:{dateTime:addDays(3)+'T10:00:00+08:00'},end:{dateTime:addDays(3)+'T11:00:00+08:00'}};
  const allDay={...meeting,id:'all-day',iCalUID:'projected-all-day',start:{date:addDays(4)},end:{date:addDays(5)},recurringEventId:'all_day_series',originalStartTime:{date:addDays(4)}};
  const resource={...meeting,id:'resource',iCalUID:'projected-resource',summary:'Resource reservation',location:'Elsewhere',hangoutLink:undefined,organizer:{email:'organizer@example.com',displayName:'Example organizer'},attendees:[{email:'room@example.com',displayName:'主會議室',resource:true,responseStatus:'accepted'},{email:'participant@example.com',displayName:'Example participant',responseStatus:'tentative',self:true}],attendeesOmitted:true,transparency:'transparent',conferenceData:{entryPoints:[{entryPointType:'phone',uri:'tel:+10000000000'},{entryPointType:'video',uri:'https://meet.google.com/xyz-abcd-efg'}]}};
  const directMeet={...meeting,id:'direct-meet',iCalUID:'projected-direct-meet'};
  const excluded=[
    {...meeting,id:'declined-room',attendees:[{resource:true,displayName:'主會議室',responseStatus:'declined'}]},
    {...meeting,id:'declined-self',attendees:[{self:true,responseStatus:'declined'}]},
    {...meeting,id:'cancelled',status:'cancelled'},
    {...meeting,id:'different-room',location:'Other room'}
  ];
  let restricted=false;
  await mocked((url,options)=>{
    if(url.hostname==='oauth2.googleapis.com'){assert.equal(url.searchParams.has('fields'),false);return json({access_token:'fixture-access',scope:fullScopes});}
    let response;
    if(url.pathname.endsWith('/calendarList')){
      const token=url.searchParams.get('pageToken');assert.ok(token===null||token==='list-next');
      response=token?{items:[{id:companyCalendar,accessRole:'reader'},{id:'hidden',hidden:true,accessRole:'owner'},{id:'deleted',deleted:true,accessRole:'owner'},{id:'free-busy',accessRole:'freeBusyReader'}]}:{items:[{id:'primary-identifier',primary:true,accessRole:'owner',summary:'discard-this-list-name'}],nextPageToken:'list-next'};
    }else{
      const id=calendarId(url),token=url.searchParams.get('pageToken');assert.ok(id==='primary'||id===companyCalendar,'restricted list entries must not be read');assert.ok(token===null||token==='event-next');
      response=id==='primary'?(token?{accessRole:'owner',items:[directMeet]}:{accessRole:'owner',items:[occurrence],nextPageToken:'event-next'}):(token?{accessRole:restricted?'freeBusyReader':'reader',items:[resource]}:{accessRole:'reader',items:[moved,another,allDay,...excluded],nextPageToken:'event-next'});
    }
    const projected=project(response,url.searchParams.get('fields'));assert.ok(!JSON.stringify(projected).includes('discard-this-list-name'));assert.ok(!JSON.stringify(projected).includes('NEVER_STORE_PRIVATE_NOTES'));return json(projected);
  },async calls=>{
    const feed=await (await f.get('calendar/feed?day='+week,owner)).json(),source=feed.sources.find(s=>s.email===admin),events=source.events;
    assert.equal(source.state,'ready');assert.equal(source.calendarCount,2);assert.equal(events.length,6);
    assert.deepEqual(events.map(event=>event.id).sort(),['all-day','direct-meet','new-series','next-occurrence','old-series','resource']);
    const savedMoved=events.find(event=>event.id==='new-series');assert.equal(savedMoved.sequence,2);assert.equal(savedMoved.updated,week+'T09:00:00.000Z');assert.deepEqual(savedMoved.originalStartTime,{dateTime:week+'T02:00:00.000Z'});
    assert.deepEqual(events.find(event=>event.id==='all-day').originalStartTime,{date:addDays(4)});
    const savedResource=events.find(event=>event.id==='resource');assert.deepEqual(savedResource.organizer,{email:'organizer@example.com',displayName:'Example organizer'});assert.deepEqual(savedResource.attendees,[{email:'room@example.com',displayName:'主會議室',resource:true,responseStatus:'accepted',self:false},{email:'participant@example.com',displayName:'Example participant',resource:false,responseStatus:'tentative',self:true}]);assert.equal(savedResource.attendeesOmitted,true);assert.equal(savedResource.hangoutLink,'https://meet.google.com/xyz-abcd-efg');assert.equal(savedResource.transparency,'transparent');
    assert.equal(events.find(event=>event.id==='direct-meet').hangoutLink,meeting.hangoutLink);
    const merged=Core.mergeGoogle([{calendar:{id:'fixture-member',name:'Example member',kind:'person'},events}],{room:{id:'fixture-room',name:'主會議室'}});assert.equal(merged.length,5);assert.ok(!merged.some(event=>event.title==='Old reservation'&&event.startISO===new Date(week+'T10:00:00+08:00').toISOString()));assert.equal(merged.find(event=>event.title==='Moved reservation').startISO,new Date(moved.start.dateTime).toISOString());assert.deepEqual(merged.find(event=>event.title==='Resource reservation').busyRoomIds,[]);
    assert.equal(calls.filter(call=>new URL(call.url).pathname.endsWith('/calendarList')).length,2);assert.equal(calls.filter(call=>new URL(call.url).pathname.endsWith('/events')).length,4);
    assert.ok(calls.filter(call=>new URL(call.url).pathname.endsWith('/watch')).every(call=>!new URL(call.url).searchParams.has('fields')));
    const stored=f.sqlite.prepare('SELECT data FROM calendar_snapshots WHERE member_sub=? AND week_start=?').get('admin',week).data;for(const privateField of ['description','attachments','NEVER_STORE_PRIVATE_NOTES',companyCalendar])assert.ok(!stored.includes(privateField));
    restricted=true;f.sqlite.exec('UPDATE calendar_snapshots SET retry_at=0');const next=await (await f.get('calendar/feed?day='+week,owner)).json(),restrictedSource=next.sources.find(s=>s.email===admin);assert.equal(restrictedSource.state,'error');assert.deepEqual(restrictedSource.events.map(event=>event.id).sort(),['direct-meet','old-series']);assert.equal(f.sqlite.prepare('SELECT status FROM calendar_connections WHERE member_sub=?').get('admin').status,'connected');
  });
});

test('existing event-only grants keep primary sync and scope changes safely add or remove shared-calendar data',async()=>{
  const {f,owner}=await team();await f.connect('admin');let scope='https://www.googleapis.com/auth/calendar.events.readonly';
  await mocked((url,options)=>{
    if(url.hostname==='oauth2.googleapis.com')return json({access_token:'fixture-access',scope});
    if(url.pathname.endsWith('/calendarList'))return json({items:[{id:companyCalendar,accessRole:'reader'}]});
    return json({accessRole:'owner',items:[{...meeting,iCalUID:calendarId(url)}]});
  },async calls=>{
    let feed=await (await f.get('calendar/feed?day='+week,owner)).json(),own=feed.sources.find(s=>s.email===admin);assert.equal(own.sharedCalendars,false);assert.equal(own.events.length,1);assert.equal(calls.filter(c=>new URL(c.url).pathname.endsWith('/calendarList')).length,0);
    scope='https://www.googleapis.com/auth/calendar.readonly';f.sqlite.exec('UPDATE calendar_snapshots SET retry_at=0');feed=await (await f.get('calendar/feed?day='+week,owner)).json();own=feed.sources.find(s=>s.email===admin);assert.equal(own.sharedCalendars,true);assert.equal(own.events.length,2);assert.equal(own.calendarCount,2);
    scope='https://www.googleapis.com/auth/calendar.events.readonly';f.sqlite.exec('UPDATE calendar_snapshots SET retry_at=0');feed=await (await f.get('calendar/feed?day='+week,owner)).json();own=feed.sources.find(s=>s.email===admin);assert.equal(own.sharedCalendars,false);assert.equal(own.events.length,1);assert.equal(own.calendarCount,1);assert.equal(own.state,'ready');
  });
});

test('a refresh grant without exact event-read permission clears every cached week before any Calendar API call',async()=>{
  for(const scope of ['openid '+listScope,'openid','openid '+eventScope+'.extra '+listScope]){
    const {f,owner}=await team();await f.connect('admin');f.sqlite.exec('UPDATE calendar_connections SET shared_calendars=1');const nextWeek=new Date(Date.parse(week+'T00:00:00Z')+7*86400000).toISOString().slice(0,10);let missingEvents=false;
    await mocked((url,options)=>{
      if(url.hostname==='oauth2.googleapis.com')return json({access_token:'fixture-access',scope:missingEvents?scope:fullScopes});
      assert.equal(missingEvents,false,'no Calendar request may use a token lacking event-read permission');
      if(url.pathname.endsWith('/calendarList'))return json({items:[{id:companyCalendar,accessRole:'reader'}]});return json({accessRole:'reader',items:[meeting]});
    },async calls=>{
      for(const day of [week,nextWeek])await f.get('calendar/feed?day='+day,owner);assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM calendar_snapshots WHERE member_sub='admin'").get().n,2);
      f.sqlite.prepare("UPDATE calendar_snapshots SET retry_at=0 WHERE member_sub='admin' AND week_start=?").run(week);const before=calls.length;missingEvents=true;
      const feed=await (await f.get('calendar/feed?day='+week,owner)).json(),own=feed.sources.find(source=>source.email===admin);assert.equal(own.state,'reauthorize');assert.deepEqual(own.events,[]);assert.equal(own.syncedAt,null);assert.equal(calls.length,before+1,'only the refresh-token exchange runs');assert.equal(calls.at(-1).url,'https://oauth2.googleapis.com/token');
      const connection=f.sqlite.prepare("SELECT status,refresh_cipher,error_code FROM calendar_connections WHERE member_sub='admin'").get();assert.equal(connection.status,'reauthorize');assert.equal(connection.refresh_cipher,'');assert.equal(connection.error_code,'REAUTHORIZE');assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM calendar_snapshots WHERE member_sub='admin'").get().n,0);
      const count=calls.length,later=await (await f.get('calendar/feed?day='+nextWeek,owner)).json();assert.equal(later.sources.find(source=>source.email===admin).state,'reauthorize');assert.equal(calls.length,count,'invalidated grants are not retried before new consent');assert.equal((await (await f.get('me',owner)).json()).calendarAuthorizationRequired,true);
    });
  }
});

test('revoked or detail-restricted shared calendars remove their cached meetings without revoking the whole account',async()=>{
  for(const failure of ['403','404','freeBusyReader']){
    const {f,owner}=await team();await f.connect('admin');f.sqlite.exec('UPDATE calendar_connections SET shared_calendars=1');let denied=false;
    await mocked((url,options)=>{
      if(url.hostname==='oauth2.googleapis.com')return normalGoogle(url,options);
      if(url.pathname.endsWith('/calendarList'))return json({items:[{id:companyCalendar,accessRole:'reader'}]});
      if(calendarId(url)!=='primary'&&denied)return failure==='freeBusyReader'?json({accessRole:'freeBusyReader',items:[]}):json({error:{message:'denied'}},Number(failure));
      return json({accessRole:'owner',items:[{...meeting,iCalUID:calendarId(url)}]});
    },async()=>{
      await f.get('calendar/feed?day='+week,owner);denied=true;f.sqlite.exec('UPDATE calendar_snapshots SET retry_at=0');
      const feed=await (await f.get('calendar/feed?day='+week,owner)).json(),own=feed.sources.find(s=>s.email===admin);assert.equal(own.state,'error',failure);assert.equal(own.events.length,1,failure);assert.equal(own.events[0].iCalUID,'primary');assert.equal(f.sqlite.prepare('SELECT status FROM calendar_connections').get().status,'connected');assert.equal(f.sqlite.prepare('SELECT error_code FROM calendar_snapshots').get().error_code,'PARTIAL_CALENDARS');
    });
  }
});

test('transient shared-calendar or calendar-list failures preserve an explicitly stale complete snapshot',async()=>{
  for(const failedPath of ['calendarList','events']){
    const {f,owner}=await team();await f.connect('admin');f.sqlite.exec('UPDATE calendar_connections SET shared_calendars=1');let fail=false;
    await mocked((url,options)=>{
      if(url.hostname==='oauth2.googleapis.com')return normalGoogle(url,options);
      if(url.pathname.endsWith('/calendarList'))return fail&&failedPath==='calendarList'?json({error:'temporary'},503):json({items:[{id:companyCalendar,accessRole:'reader'}]});
      if(fail&&failedPath==='events'&&calendarId(url)!=='primary')return json({error:'temporary'},503);
      return json({accessRole:'owner',items:[{...meeting,iCalUID:calendarId(url)}]});
    },async()=>{
      await f.get('calendar/feed?day='+week,owner);const previous=f.sqlite.prepare('SELECT data,synced_at FROM calendar_snapshots').get();fail=true;f.sqlite.exec('UPDATE calendar_snapshots SET retry_at=0');
      const feed=await (await f.get('calendar/feed?day='+week,owner)).json(),own=feed.sources.find(s=>s.email===admin);assert.equal(own.state,'error');assert.equal(own.events.length,2);const current=f.sqlite.prepare('SELECT data,synced_at FROM calendar_snapshots').get();assert.deepEqual(current,previous);assert.equal(f.sqlite.prepare('SELECT status FROM calendar_connections').get().status,'connected');
    });
  }
});

test('shared-calendar discovery bounds pagination and event request concurrency',async()=>{
  const {f,owner}=await team();await f.connect('admin');f.sqlite.exec('UPDATE calendar_connections SET shared_calendars=1');let active=0,maxActive=0,loop=false;
  await mocked(async(url,options)=>{
    if(url.hostname==='oauth2.googleapis.com')return normalGoogle(url,options);
    if(url.pathname.endsWith('/calendarList'))return loop?json({items:[],nextPageToken:'loop'}):json({items:Array.from({length:7},(_,i)=>({id:'shared-'+i,accessRole:'reader'}))});
    active++;maxActive=Math.max(maxActive,active);await new Promise(resolve=>setTimeout(resolve,1));active--;return json({accessRole:'reader',items:[{...meeting,iCalUID:calendarId(url)}]});
  },async calls=>{
    const feed=await (await f.get('calendar/feed?day='+week,owner)).json(),own=feed.sources.find(s=>s.email===admin);assert.equal(own.events.length,8);assert.equal(own.calendarCount,8);assert.equal(maxActive,3);
    loop=true;f.sqlite.exec('UPDATE calendar_snapshots SET retry_at=0');const before=calls.length;const failed=await (await f.get('calendar/feed?day='+week,owner)).json();assert.equal(failed.sources.find(s=>s.email===admin).state,'error');assert.equal(calls.slice(before).filter(c=>new URL(c.url).pathname.endsWith('/calendarList')).length,5);
  });
});

test('a refresh scope downgrade removes shared meetings from every cached week even when primary refresh fails',async()=>{
  const {f,owner}=await team();await f.connect('admin');f.sqlite.exec('UPDATE calendar_connections SET shared_calendars=1');
  const nextWeek=new Date(Date.parse(week+'T00:00:00Z')+7*86400000).toISOString().slice(0,10);let downgraded=false;
  await mocked((url)=>{
    if(url.hostname==='oauth2.googleapis.com')return json({access_token:'fixture-access',scope:'https://www.googleapis.com/auth/calendar.events.readonly'+(downgraded?'':' '+listScope)});
    if(url.pathname.endsWith('/calendarList'))return json({items:[{id:companyCalendar,accessRole:'reader'}]});
    if(downgraded)return json({error:'temporary'},503);
    const date=url.searchParams.get('timeMin').slice(0,10),id=calendarId(url)==='primary'?'primary':'shared';
    return json({accessRole:'owner',items:[{...meeting,id:id+'-'+date,iCalUID:id+'-'+date,start:{dateTime:date+'T10:00:00+08:00'},end:{dateTime:date+'T11:00:00+08:00'}}]});
  },async calls=>{
    for(const day of [week,nextWeek])await f.get('calendar/feed?day='+day,owner);
    const before=f.sqlite.prepare('SELECT week_start,data,synced_at FROM calendar_snapshots WHERE member_sub=? ORDER BY week_start').all('admin');assert.equal(before.length,2);assert.ok(before.every(row=>JSON.parse(row.data).some(event=>event.calendarKey)));
    downgraded=true;f.sqlite.prepare('UPDATE calendar_snapshots SET retry_at=0 WHERE member_sub=? AND week_start=?').run('admin',week);const callCount=calls.length;
    const data=await (await f.get('calendar/feed?day='+week,owner)).json(),own=data.sources.find(source=>source.email===admin);
    assert.equal(own.sharedCalendars,false);assert.equal(own.state,'error');assert.deepEqual(own.events.map(event=>event.id),['primary-'+week]);
    const after=f.sqlite.prepare('SELECT week_start,data,synced_at FROM calendar_snapshots WHERE member_sub=? ORDER BY week_start').all('admin');
    for(const row of after){assert.deepEqual(JSON.parse(row.data).map(event=>event.id),['primary-'+row.week_start]);assert.equal(JSON.parse(row.data).some(event=>event.calendarKey),false);assert.equal(row.synced_at,before.find(old=>old.week_start===row.week_start).synced_at);}
    assert.equal(calls.slice(callCount).some(call=>call.url.includes('/calendarList')),false);
    const otherWeek=await (await f.get('calendar/feed?day='+nextWeek,owner)).json();assert.deepEqual(otherWeek.sources.find(source=>source.email===admin).events.map(event=>event.id),['primary-'+nextWeek]);
  });
});

test('a denied shared calendar is purged across weeks despite another calendar failing transiently in the same batch',async()=>{
  for(const status of [403,404]){
    const {f,owner}=await team();await f.connect('admin');f.sqlite.exec('UPDATE calendar_connections SET shared_calendars=1');
    const nextWeek=new Date(Date.parse(week+'T00:00:00Z')+7*86400000).toISOString().slice(0,10),calendarB='shared-b@group.calendar.google.com';let fail=false;
    await mocked(async(url)=>{
      if(url.hostname==='oauth2.googleapis.com')return json({access_token:'fixture-access',scope:'https://www.googleapis.com/auth/calendar.events.readonly '+listScope});
      if(url.pathname.endsWith('/calendarList'))return json({items:[{id:companyCalendar,accessRole:'reader'},{id:calendarB,accessRole:'reader'}]});
      const id=calendarId(url),date=url.searchParams.get('timeMin').slice(0,10),name=id==='primary'?'primary':id===companyCalendar?'shared-a':'shared-b';
      if(fail&&id===companyCalendar)return json({error:'denied'},status);
      if(fail&&id===calendarB){await new Promise(resolve=>setImmediate(resolve));return json({error:'temporary'},503);}
      return json({accessRole:'owner',items:[{...meeting,id:name+'-'+date,iCalUID:name+'-'+date,start:{dateTime:date+'T10:00:00+08:00'},end:{dateTime:date+'T11:00:00+08:00'}}]});
    },async()=>{
      for(const day of [week,nextWeek])await f.get('calendar/feed?day='+day,owner);
      const before=f.sqlite.prepare('SELECT week_start,data,synced_at FROM calendar_snapshots WHERE member_sub=? ORDER BY week_start').all('admin');assert.equal(before.length,2);assert.ok(before.every(row=>JSON.parse(row.data).length===3));
      fail=true;f.sqlite.prepare('UPDATE calendar_snapshots SET retry_at=0 WHERE member_sub=? AND week_start=?').run('admin',week);
      const feed=await (await f.get('calendar/feed?day='+week,owner)).json(),own=feed.sources.find(source=>source.email===admin);assert.equal(own.state,'error');assert.equal(own.sharedCalendars,true);assert.deepEqual(own.events.map(event=>event.id).sort(),['primary-'+week,'shared-b-'+week].sort(),String(status));
      const after=f.sqlite.prepare('SELECT week_start,data,synced_at FROM calendar_snapshots WHERE member_sub=? ORDER BY week_start').all('admin');
      for(const row of after){assert.deepEqual(JSON.parse(row.data).map(event=>event.id).sort(),['primary-'+row.week_start,'shared-b-'+row.week_start].sort(),String(status));assert.equal(row.synced_at,before.find(old=>old.week_start===row.week_start).synced_at);}
      assert.equal(f.sqlite.prepare('SELECT status FROM calendar_connections WHERE member_sub=?').get('admin').status,'connected');
      const next=await (await f.get('calendar/feed?day='+nextWeek,owner)).json();assert.equal(next.sources.find(source=>source.email===admin).events.some(event=>event.id.startsWith('shared-a-')),false);
    });
  }
});

test('fast event rejection waits for its delayed siblings before starting the next source batch',{timeout:4000},async()=>{
  const {f,owner}=await team();await f.connect('admin');await f.connect('member');
  for(let i=0;i<6;i++){await f.login(`queued${i}@gmail.com`,'queued'+i);await f.post('admin/review',{sub:'queued'+i,status:'approved'},owner);await f.connect('queued'+i);}
  f.sqlite.exec('UPDATE calendar_connections SET shared_calendars=1');
  const firstSubjects=['admin','member','queued0','queued1','queued2'],first=new Set(firstSubjects),starts=new Map();let reached,release,active=0,maxActive=0,settled=false;
  const firstBatchStarted=new Promise(resolve=>reached=resolve),gate=new Promise(resolve=>release=resolve);
  await mocked(async(url,options)=>{
    if(url.hostname==='oauth2.googleapis.com')return json({access_token:new URLSearchParams(options.body).get('refresh_token').slice('refresh-'.length),scope:'https://www.googleapis.com/auth/calendar.events.readonly '+listScope});
    if(url.pathname.endsWith('/calendarList'))return json({items:[{id:'shared-a',accessRole:'reader'},{id:'shared-b',accessRole:'reader'}]});
    const subject=options.headers.Authorization.slice('Bearer '.length);starts.set(subject,(starts.get(subject)||0)+1);active++;maxActive=Math.max(maxActive,active);
    if(firstSubjects.every(sub=>starts.get(sub)===3))reached();
    try{if(calendarId(url)==='primary')throw Error('fixture fast event rejection');await gate;return json({accessRole:'reader',items:[{...meeting,iCalUID:subject+'-'+calendarId(url)}]});}finally{active--;}
  },async()=>{
    const pending=syncCalendars(f.env,week).then(()=>{settled=true;});let observed;
    try{
      await firstBatchStarted;await new Promise(resolve=>setImmediate(resolve));await new Promise(resolve=>setImmediate(resolve));
      observed={settled,active,startedSubjects:[...starts.keys()],claimedSubjects:f.sqlite.prepare('SELECT member_sub FROM calendar_snapshots ORDER BY member_sub').all().map(row=>row.member_sub)};
    }finally{release();await pending;}
    assert.equal(observed.settled,false,'sync must not finish while event requests remain in flight');
    assert.deepEqual(observed.claimedSubjects,firstSubjects,'later sources must not start while the first batch has pending event requests');
    assert.ok(observed.startedSubjects.every(subject=>first.has(subject)));assert.equal(observed.active,10);
    assert.ok(maxActive<=15,`at most five sources with three event requests each may run, observed ${maxActive}`);
    assert.equal(starts.size,8);assert.ok([...starts.values()].every(count=>count===3));assert.equal(active,0);
  });
});

test('room matching ignores formatting spaces and full-width parentheses in office resource names',()=>{
  const name='示範辦公室(範例大樓B棟)-3-範例會議室 (15)',location='示範辦公室 （範例大樓 B 棟）-3-範例會議室 （15）';
  assert.ok(minimizeEvent({...meeting,location},name));assert.equal(Core.googleRoomMatch({location},{name}),true);
  assert.equal(minimizeEvent({...meeting,location:location.replace('15','16')},name),null);
});

test('source refresh preserves normalized resource matching and canonical public event data',async()=>{
  const {f,owner}=await team();await f.connect('admin');
  const location='示範會議室 (A)';assert.equal((await f.post('calendar/location',{location},owner)).status,200);
  const roomLocation='台北　示範會議室（Ａ）',records=[
    {...meeting,id:'z',summary:'Resource',location:'Elsewhere',attendees:[{resource:true,displayName:roomLocation,responseStatus:'accepted'}]},
    {...meeting,id:'same',summary:'Zulu',location:roomLocation},
    {...meeting,id:'same',summary:'Alpha',location:roomLocation},
    {...meeting,id:'a',summary:'Location',location:roomLocation,start:{dateTime:week+'T10:07:00+08:00'}},
    {...meeting,id:'resource-declined',location:roomLocation,attendees:[{resource:true,displayName:roomLocation,responseStatus:'declined'}]},
    {...meeting,id:'cancelled',location:roomLocation,status:'cancelled'},
    {...meeting,id:'self-declined',location:roomLocation,attendees:[{self:true,responseStatus:'declined'}]}
  ];
  await mocked((url,options)=>url.hostname==='oauth2.googleapis.com'?normalGoogle(url,options):json({accessRole:'owner',items:records}),async()=>{
    const feed=await (await f.get('calendar/feed?day='+week,owner)).json(),events=feed.sources.find(source=>source.email===admin).events;
    assert.deepEqual(events.map(event=>[event.id,event.summary]),[['a','Location'],['same','Alpha'],['same','Zulu'],['z','Resource']]);
    assert.equal(events[0].start.dateTime,week+'T10:07:00+08:00');
    assert.ok(events.every(event=>!('key' in event)&&!('serialized' in event)&&!('description' in event)&&!('attachments' in event)));
    const data=f.sqlite.prepare('SELECT data FROM calendar_snapshots WHERE member_sub=? AND week_start=?').get('admin',week).data;
    assert.equal(data,JSON.stringify(events),'stored payload contains precisely the public event records');
    assert.ok(!data.includes('NEVER_STORE_PRIVATE_NOTES'));
  });
});

test('successful and failed source refreshes wait ten minutes before automatic retry',async()=>{
  const {f,owner}=await team();await f.connect('admin');let fail=false;
  await mocked((url,options)=>fail?json({error:'unavailable'},503):normalGoogle(url,options),async calls=>{
    await f.get('calendar/feed?day='+week,owner);let row=f.sqlite.prepare('SELECT synced_at,retry_at FROM calendar_snapshots').get();assert.equal(row.retry_at-row.synced_at,600);
    const count=calls.length;f.sqlite.exec('UPDATE calendar_snapshots SET retry_at=retry_at-300');await f.get('calendar/feed?day='+week,owner);assert.equal(calls.length,count,'five minutes does not expire the cache');
    f.sqlite.exec('UPDATE calendar_snapshots SET retry_at=retry_at-300');fail=true;await f.get('calendar/feed?day='+week,owner);row=f.sqlite.prepare('SELECT retry_at,error_code FROM calendar_snapshots').get();assert.equal(row.error_code,'SYNC_FAILED');assert.ok(row.retry_at-Math.floor(Date.now()/1000)>=599);
    const failedCount=calls.length;await f.get('calendar/feed?day='+week,owner);assert.equal(calls.length,failedCount,'a failed request also backs off');
  });
});

test('manual sync bypasses a fresh ten-minute cache and repeated taps reuse the last thirty seconds',async()=>{
  const {f,owner,member}=await team();await f.connect('admin');await f.connect('member');let title='原本預約';
  await mocked((url,options)=>url.hostname==='oauth2.googleapis.com'?normalGoogle(url,options):json({items:[{...meeting,summary:title}]}),async calls=>{
    await f.get('calendar/feed?day='+week,owner);f.sqlite.exec('UPDATE calendar_snapshots SET synced_at=synced_at-31,retry_at=retry_at-31');title='更新後預約';const count=calls.length;
    const cached=await (await f.get('calendar/feed?day='+week,member)).json();assert.equal(cached.sources[0].events[0].summary,'原本預約');assert.equal(calls.length,count);
    const response=await f.post('calendar/sync',{day:week},member);assert.equal(response.status,200);assert.equal(response.headers.get('Cache-Control'),'private, no-store');const updated=await response.json();for(const source of updated.sources)assert.equal(source.events[0].summary,'更新後預約');assert.equal(calls.length,count+4);
    await f.post('calendar/sync',{day:week},owner);assert.equal(calls.length,count+4,'manual cooldown is shared across viewers');
  });
});

test('manual sync enforces login, whitelist, origin, POST, date bounds and server setup',async()=>{
  const f=fixture();assert.equal((await f.post('calendar/sync',{})).status,401);const pending=await f.login('pending@gmail.com','pending');assert.equal((await f.post('calendar/sync',{},pending)).status,403);
  const owner=await f.login(admin,'admin');assert.equal((await f.post('calendar/sync',{},owner,{Origin:'https://evil.example'})).status,403);assert.equal((await f.get('calendar/sync',owner)).status,404);
  for(const day of ['bad','2026-02-30','2099-01-01',42])assert.equal((await f.post('calendar/sync',{day},owner)).status,400);
  delete f.env.GOOGLE_CLIENT_SECRET;assert.equal((await f.post('calendar/sync',{day:week},owner)).status,503);
});

test('minute cron waits for the actual ten-minute retry time even when cleanup runs on a ten-minute boundary',async()=>{
  const {f,owner}=await team();await f.connect('admin');
  await mocked(normalGoogle,async calls=>{
    await f.get('calendar/feed?day='+week,owner);const time=Math.floor(Date.now()/1000);f.sqlite.prepare('UPDATE calendar_snapshots SET retry_at=?,synced_at=?').run(time+5,time-595);const count=calls.length;
    await calendarMaintenance(f.env);assert.equal(calls.length,count,'cleanup does not force a refresh with five seconds left on the cache');
    f.sqlite.prepare('UPDATE calendar_snapshots SET retry_at=?').run(time);await calendarMaintenance(f.env,false);assert.equal(calls.length,count+2,'the next minute can refresh when this individual snapshot is due');
    await calendarMaintenance(f.env);assert.equal(calls.length,count+2,'cleanup does not add another refresh after the same week just completed');
  });
});

test('one sync cycle visits every due source beyond the first five with bounded concurrency',{timeout:2000},async()=>{
  const {f,owner}=await team();await f.connect('admin');await f.connect('member');for(let i=0;i<5;i++){await f.login(`person${i}@gmail.com`,'person'+i);await f.post('admin/review',{sub:'person'+i,status:'approved'},owner);await f.connect('person'+i);}
  let active=0,maxActive=0,started=0;const releases=[];
  await mocked(async(url,options)=>{if(url.hostname==='oauth2.googleapis.com'){active++;started++;maxActive=Math.max(maxActive,active);await new Promise(resolve=>{releases.push(resolve);if(started===5||started===7)for(const release of releases.splice(0))release();});active--;return normalGoogle(url,options);}return normalGoogle(url,options);},async calls=>{
    const feed=await (await f.get('calendar/feed?day='+week,owner)).json();assert.equal(feed.sources.length,7);assert.ok(feed.sources.every(s=>s.state==='ready'));assert.equal(calls.filter(c=>new URL(c.url).pathname.endsWith('/calendars/primary/events')).length,7);assert.equal(maxActive,5);
  });
});
test('pagination commits only a complete snapshot and read failures retain explicitly stale data',async()=>{
  const {f,owner}=await team();await f.connect('admin');let failure=false;
  await mocked((url,options)=>{if(url.hostname==='oauth2.googleapis.com')return normalGoogle(url,options);if(url.searchParams.has('pageToken'))return failure?json({error:'failed'},503):json({items:[{...meeting,id:'2',iCalUID:'2'}]});return json({items:[meeting],nextPageToken:'next'});},async()=>{
    let data=await (await f.get('calendar/feed?day='+week,owner)).json();assert.equal(data.sources[0].events.length,2);
    f.sqlite.exec('UPDATE calendar_snapshots SET retry_at=0');failure=true;data=await (await f.get('calendar/feed?day='+week,owner)).json();assert.equal(data.sources[0].state,'error');assert.equal(data.sources[0].events.length,2);assert.ok(data.sources[0].syncedAt);
  });
});
test('expired/revoked Google grant drops cached meetings and shows reauthorization',async()=>{
  const {f,owner}=await team();await f.connect('admin');await mocked(normalGoogle,()=>f.get('calendar/feed?day='+week,owner));f.sqlite.exec('UPDATE calendar_snapshots SET retry_at=0');
  await mocked(()=>json({error:'invalid_grant'},400),async()=>{const data=await (await f.get('calendar/feed?day='+week,owner)).json();assert.equal(data.sources[0].state,'reauthorize');assert.deepEqual(data.sources[0].events,[]);});assert.equal(f.sqlite.prepare('SELECT refresh_cipher FROM calendar_connections').get().refresh_cipher,'');
});
test('changing room location immediately invalidates old results and resyncs with new filter',async()=>{
  const {f,owner}=await team();await f.connect('admin');await mocked(normalGoogle,()=>f.get('calendar/feed?day='+week,owner));assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM calendar_snapshots').get().n,1);
  await f.post('calendar/location',{location:'另間會議室'},owner);assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM calendar_snapshots').get().n,0);
  await mocked(normalGoogle,async()=>{const data=await (await f.get('calendar/feed?day='+week,owner)).json();assert.equal(data.sources[0].state,'ready');assert.deepEqual(data.sources[0].events,[]);});
});
test('disconnect only removes the current account; whitelist revocation removes its grants and meetings',async()=>{
  const {f,owner,member}=await team();await f.connect('admin');await f.connect('member');await mocked(normalGoogle,()=>f.get('calendar/feed?day='+week,owner));
  await f.post('calendar/disconnect',{sub:'admin'},member);assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM calendar_connections').get().n,1);assert.equal(f.sqlite.prepare('SELECT member_sub FROM calendar_connections').get().member_sub,'admin');
  await f.connect('member');await mocked(normalGoogle,()=>f.get('calendar/feed?day='+week,owner));await f.post('admin/review',{sub:'member',status:'rejected'},owner);
  for(const table of ['calendar_connections','calendar_snapshots'])assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM '+table+' WHERE member_sub=?').get('member').n,0);
  assert.equal((await f.get('calendar/feed',member)).status,403);assert.equal((await (await f.get('calendar-sources',owner)).json()).emails.length,1);
});
test('revocation during Calendar fetch cannot commit data or restore a connection',async()=>{
  const {f,owner,member}=await team();await f.connect('member');let reached;
  const signal=new Promise(resolve=>reached=resolve);let release;const gate=new Promise(resolve=>release=resolve);
  await mocked(async(url,options)=>{if(url.hostname==='oauth2.googleapis.com')return normalGoogle(url,options);reached();await gate;return json({items:[meeting]});},async()=>{const fetching=f.get('calendar/feed?day='+week,owner);await signal;await f.post('admin/review',{sub:'member',status:'rejected'},owner);release();await fetching;});
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM calendar_snapshots').get().n,0);assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM calendar_connections').get().n,0);assert.equal((await f.get('calendar/feed',member)).status,403);
});
test('concurrent readers and cron share a sync lease instead of duplicating refresh requests',async()=>{
  const {f,owner}=await team();await f.connect('admin');let release,reached;const signal=new Promise(resolve=>reached=resolve),gate=new Promise(resolve=>release=resolve);
  await mocked(async(url,options)=>{if(url.hostname==='oauth2.googleapis.com'){reached();await gate;return normalGoogle(url,options);}return json({items:[meeting]});},async calls=>{
    const first=f.get('calendar/feed?day='+week,owner);await signal;await syncCalendars(f.env,week);const second=await (await f.post('calendar/sync',{day:week},owner)).json();assert.equal(second.sources[0].state,'waiting');assert.equal(calls.length,1);release();await first;
  });
});
test('the same grant cannot sync two weeks concurrently or restore a calendar removed by the later week',{timeout:3000},async()=>{
  const {f,owner}=await team();await f.connect('admin');f.sqlite.exec('UPDATE calendar_connections SET shared_calendars=1');
  const nextWeek=new Date(Date.parse(week+'T00:00:00Z')+7*86400000).toISOString().slice(0,10);let hold=false,removed=false,reached,release;
  const entered=new Promise(resolve=>reached=resolve),gate=new Promise(resolve=>release=resolve);
  await mocked(async(url,options)=>{
    if(url.hostname==='oauth2.googleapis.com')return json({access_token:'fixture-access',scope:'https://www.googleapis.com/auth/calendar.events.readonly '+listScope});
    if(url.pathname.endsWith('/calendarList'))return json({items:removed?[]:[{id:companyCalendar,accessRole:'reader'}]});
    const date=url.searchParams.get('timeMin').slice(0,10),id=calendarId(url)==='primary'?'primary':'shared';
    if(hold&&id==='shared'&&date===week){reached();await gate;if(options.signal?.aborted)throw options.signal.reason;}
    return json({accessRole:'reader',items:[{...meeting,id:id+'-'+date,iCalUID:id+'-'+date,start:{dateTime:date+'T10:00:00+08:00'},end:{dateTime:date+'T11:00:00+08:00'}}]});
  },async calls=>{
    for(const day of [week,nextWeek])await f.get('calendar/feed?day='+day,owner);
    f.sqlite.exec('UPDATE calendar_snapshots SET retry_at=0');hold=true;const first=syncCalendars(f.env,week);let observed;
    try{await entered;removed=true;const count=calls.length;await syncCalendars(f.env,nextWeek);observed=calls.slice(count);}
    finally{release();await first;}
    assert.deepEqual(observed,[],'another week must not refresh this grant while its current source lease is active');
    await syncCalendars(f.env,nextWeek);
    const rows=f.sqlite.prepare('SELECT week_start,data FROM calendar_snapshots WHERE member_sub=? ORDER BY week_start').all('admin');assert.equal(rows.length,2);
    for(const row of rows){assert.deepEqual(JSON.parse(row.data).map(event=>event.id),['primary-'+row.week_start]);assert.equal(JSON.parse(row.data).some(event=>event.calendarKey),false);}
  });
});

test('expired source responses cannot change grant metadata, prune current calendars or refill old meetings',{timeout:4000},async()=>{
  for(const pausedStage of ['token','list','events']){
    const {f,owner}=await team();await f.connect('admin');f.sqlite.exec('UPDATE calendar_connections SET shared_calendars=1');
    const nextWeek=new Date(Date.parse(week+'T00:00:00Z')+7*86400000).toISOString().slice(0,10),calendarB='valid-b@group.calendar.google.com';let phase='seed',reached,release;
    const entered=new Promise(resolve=>reached=resolve),gate=new Promise(resolve=>release=resolve);
    const pause=async(signal)=>{
      reached();await new Promise((resolve,reject)=>{
        const abort=()=>reject(signal.reason);if(signal?.aborted){reject(signal.reason);return;}signal?.addEventListener('abort',abort,{once:true});
        gate.then(()=>{signal?.removeEventListener('abort',abort);if(signal?.aborted)reject(signal.reason);else resolve();},reject);
      });
    };
    await mocked(async(url,options)=>{
      const current=phase;
      if(url.hostname==='oauth2.googleapis.com'){
        if(current==='old'&&pausedStage==='token')await pause(options.signal);
        return json({access_token:'fixture-access',scope:'https://www.googleapis.com/auth/calendar.events.readonly'+(current==='old'&&pausedStage==='token'?'':' '+listScope)});
      }
      if(url.pathname.endsWith('/calendarList')){
        if(current==='old'&&pausedStage==='list')await pause(options.signal);
        const ids=current==='seed'?[companyCalendar,calendarB]:current==='old'?[companyCalendar]:[calendarB];return json({items:ids.map(id=>({id,accessRole:'reader'}))});
      }
      const id=calendarId(url),date=url.searchParams.get('timeMin').slice(0,10),name=id==='primary'?'primary':id===companyCalendar?'shared-a':'shared-b';
      if(current==='old'&&pausedStage==='events'&&id===companyCalendar)await pause(options.signal);
      return json({accessRole:'reader',items:[{...meeting,id:name+'-'+date+'-'+current,iCalUID:name+'-'+date,start:{dateTime:date+'T10:00:00+08:00'},end:{dateTime:date+'T11:00:00+08:00'}}]});
    },async()=>{
      for(const day of [week,nextWeek])await f.get('calendar/feed?day='+day,owner);
      f.sqlite.exec('UPDATE calendar_snapshots SET retry_at=0');phase='old';const old=syncCalendars(f.env,week);let accepted;
      try{
        await entered;f.sqlite.prepare('UPDATE calendar_snapshots SET lease_until=0 WHERE member_sub=? AND week_start=?').run('admin',week);phase='new';await syncCalendars(f.env,nextWeek);
        accepted=f.sqlite.prepare('SELECT data,synced_at,calendar_count FROM calendar_snapshots WHERE member_sub=? AND week_start=?').get('admin',nextWeek);
        assert.deepEqual(JSON.parse(accepted.data).map(event=>event.id).sort(),['primary-'+nextWeek+'-new','shared-b-'+nextWeek+'-new'].sort(),pausedStage);
      }finally{release();await old;}
      assert.equal(f.sqlite.prepare('SELECT shared_calendars FROM calendar_connections WHERE member_sub=?').get('admin').shared_calendars,1,pausedStage+' expired metadata');
      assert.deepEqual(f.sqlite.prepare('SELECT data,synced_at,calendar_count FROM calendar_snapshots WHERE member_sub=? AND week_start=?').get('admin',nextWeek),accepted,pausedStage+' expired prune');
      const rows=f.sqlite.prepare('SELECT data FROM calendar_snapshots WHERE member_sub=?').all('admin');assert.ok(rows.every(row=>JSON.parse(row.data).every(event=>!event.id.startsWith('shared-a-'))),pausedStage+' expired commit');
    });
  }
});

test('Calendar and non-invalid-grant token 401s preserve the complete grant and caches, then recover through background refresh',async()=>{
  const realNow=Date.now;let clock=realNow();Date.now=()=>clock;
  try{
    for(const failedPath of ['calendarList','primaryEvents','sharedEvents','mixedBatch','tokenConfig','calendarNotGrant']){
      const {f,owner}=await team();await f.connect('admin');f.sqlite.exec('UPDATE calendar_connections SET shared_calendars=1');
      const nextWeek=new Date(Date.parse(week+'T00:00:00Z')+7*86400000).toISOString().slice(0,10);let fail=false,recovered=false;
      await mocked(async(url)=>{
        if(url.hostname==='oauth2.googleapis.com')return fail&&failedPath==='tokenConfig'?json({error:'invalid_client'},401):json({access_token:recovered?'fresh-recovered-access':'fixture-access',scope:fullScopes});
        if(url.pathname.endsWith('/calendarList'))return fail&&failedPath==='calendarList'?json({error:{code:401,errors:[{reason:'authError'}]}},401):json({items:[{id:companyCalendar,accessRole:'reader'}]});
        const id=calendarId(url)==='primary'?'primary':'shared';
        if(fail){
          if(failedPath==='mixedBatch'&&id==='primary')return json({error:'temporary'},503);
          if((failedPath==='primaryEvents'&&id==='primary')||((failedPath==='sharedEvents'||failedPath==='mixedBatch')&&id==='shared')){await new Promise(resolve=>setImmediate(resolve));return json({error:{code:401,errors:[{reason:'authError'}]}},401);}
          // Only the OAuth token endpoint can assert that a refresh grant failed.
          if(failedPath==='calendarNotGrant'&&id==='shared')return json({error:'invalid_grant'},401);
        }
        const date=url.searchParams.get('timeMin').slice(0,10);return json({accessRole:'reader',items:[{...meeting,id:id+'-'+date,iCalUID:id+'-'+date,summary:recovered?'Recovered reservation':'Last complete reservation',start:{dateTime:date+'T10:00:00+08:00'},end:{dateTime:date+'T11:00:00+08:00'}}]});
      },async calls=>{
        for(const day of [week,nextWeek,week])await f.get('calendar/feed?day='+day,owner);
        const previous=f.sqlite.prepare('SELECT data,synced_at FROM calendar_snapshots WHERE member_sub=? AND week_start=?').get('admin',week),otherWeek=f.sqlite.prepare('SELECT * FROM calendar_snapshots WHERE member_sub=? AND week_start=?').get('admin',nextWeek),grant=f.sqlite.prepare('SELECT * FROM calendar_connections WHERE member_sub=?').get('admin');assert.equal((await (await f.get('me',owner)).json()).calendarAuthorizationRequired,false);
        fail=true;f.sqlite.prepare('UPDATE calendar_snapshots SET retry_at=0 WHERE member_sub=? AND week_start=?').run('admin',week);
        const failed=await (await f.get('calendar/feed?day='+week,owner)).json(),own=failed.sources.find(source=>source.email===admin);
        assert.equal(own.state,'error',failedPath);assert.equal(own.sharedCalendars,true);assert.equal(own.events.length,2);assert.equal(own.syncedAt,previous.synced_at);assert.deepEqual(f.sqlite.prepare('SELECT data,synced_at FROM calendar_snapshots WHERE member_sub=? AND week_start=?').get('admin',week),previous,'a rejected access token never advances successful data or time');assert.deepEqual(f.sqlite.prepare('SELECT * FROM calendar_connections WHERE member_sub=?').get('admin'),grant,'encrypted refresh grant and complete scope capability stay unchanged');assert.deepEqual(f.sqlite.prepare('SELECT * FROM calendar_snapshots WHERE member_sub=? AND week_start=?').get('admin',nextWeek),otherWeek,'another cached week must not be erased');assert.equal((await (await f.get('me',owner)).json()).calendarAuthorizationRequired,false);
        const failedSnapshot=f.sqlite.prepare('SELECT error_code,retry_at,lease_until FROM calendar_snapshots WHERE member_sub=? AND week_start=?').get('admin',week);assert.equal(failedSnapshot.error_code,'SYNC_FAILED');assert.equal(failedSnapshot.lease_until,0);assert.ok(failedSnapshot.retry_at>Math.floor(clock/1000));
        const count=calls.length;await f.get('calendar/feed?day='+week,owner);assert.equal(calls.length,count,'the same failure respects normal retry backoff instead of asking for consent');
        fail=false;recovered=true;clock+=601000;await calendarMaintenance(f.env,false);
        const fresh=await (await f.get('calendar/feed?day='+week,owner)).json(),complete=fresh.sources.find(source=>source.email===admin);assert.equal(complete.state,'ready');assert.equal(complete.sharedCalendars,true);assert.ok(complete.syncedAt>previous.synced_at);assert.equal(complete.events.length,2);assert.ok(complete.events.every(event=>event.summary==='Recovered reservation'));assert.equal((await (await f.get('me',owner)).json()).calendarAuthorizationRequired,false);
        const newCalls=calls.slice(count);assert.equal(newCalls.filter(call=>new URL(call.url).hostname==='oauth2.googleapis.com').length,1,'recovery uses the existing background refresh grant');assert.equal(newCalls.filter(call=>new URL(call.url).pathname.endsWith('/events')).length,2);assert.ok(newCalls.filter(call=>new URL(call.url).pathname.endsWith('/events')).every(call=>call.options.headers.Authorization==='Bearer fresh-recovered-access'));assert.deepEqual(f.sqlite.prepare('SELECT * FROM calendar_connections WHERE member_sub=?').get('admin'),grant);
      });
    }
  }finally{Date.now=realNow;}
});

test('room matching skips unrelated, cancelled and declined copies, preserves exact times, minimizes attendees',()=>{
  assert.equal(minimizeEvent({...meeting,location:'Elsewhere'},'主會議室'),null);assert.equal(minimizeEvent({...meeting,attendees:[{self:true,responseStatus:'declined'}]},'主會議室'),null);
  const safe=minimizeEvent({...meeting,start:{dateTime:week+'T10:07:00+08:00'},hangoutLink:'https://evil.example/meet'},'主會議室');assert.equal(safe.start.dateTime,week+'T10:07:00+08:00');assert.equal(safe.hangoutLink,'');assert.equal(safe.description,undefined);
  assert.ok(minimizeEvent({...meeting,location:'',attendees:[{resource:true,displayName:'台北 主會議室',responseStatus:'accepted'}]},'主會議室'));
  assert.equal(minimizeEvent({...meeting,attendees:[{resource:true,displayName:'主會議室',responseStatus:'declined'}]},'主會議室'),null);
});
test('date validation bounds shared queries and maintenance cleans expired auth states',async()=>{
  const {f,owner}=await team();for(const day of ['2026-02-30','bad','2001-01-01','2099-01-01'])assert.equal((await f.get('calendar/feed?day='+day,owner)).status,400);
  await f.post('calendar/authorize',{},owner);f.sqlite.exec('UPDATE calendar_oauth_states SET expires_at=1');await calendarMaintenance(f.env);assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM calendar_oauth_states').get().n,0);
});
