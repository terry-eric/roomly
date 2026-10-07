import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {createHandler,hash} from '../src/worker.ts';
import {CalendarError,sealToken,taipeiWeek,syncCalendars,calendarMaintenance,enqueueCalendarSync} from '../src/calendar.ts';
import {calendarWebhook,ensureCalendarWatches,pruneCalendarWatches} from '../src/calendar-watch.ts';
const origin='https://roomly.example.com',sub='member',version='version-1',week=taipeiWeek(),nextWeek=new Date(Date.parse(week+'T00:00:00Z')+7*86400000).toISOString().slice(0,10);
const scopes='https://www.googleapis.com/auth/calendar.events.readonly https://www.googleapis.com/auth/calendar.calendarlist.readonly';
const now=()=>Math.floor(Date.now()/1000),json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json'}});
const meeting=day=>({id:'event-'+day,iCalUID:'invite-'+day,summary:'Original reservation',location:'Meeting room',start:{dateTime:day+'T10:00:00+08:00'},end:{dateTime:day+'T11:00:00+08:00'}});

async function fixture(){
 const sqlite=new DatabaseSync(':memory:');for(const name of ['0001_access','0002_email_allowlist','0003_shared_calendar','0004_shared_calendar_list','0005_calendar_watch','0006_calendar_revision','0007_calendar_enqueue_gates','0008_feed_cache'])sqlite.exec(readFileSync(new URL('../migrations/'+name+'.sql',import.meta.url),'utf8'));
 const DB={prepare(sql){const statement=sqlite.prepare(sql);let values=[];return {bind(...args){values=args;return this;},async first(){return statement.get(...values)||null;},async all(){return {results:statement.all(...values)};},run(){return {meta:{changes:statement.run(...values).changes}};}};},async batch(statements){sqlite.exec('BEGIN');try{const results=statements.map(statement=>statement.run());sqlite.exec('COMMIT');return results;}catch(error){sqlite.exec('ROLLBACK');throw error;}}};
 const env={DB,EMAIL:{async send(){}},ASSETS:{async fetch(){return new Response('asset');}},APP_ORIGIN:origin,GOOGLE_CLIENT_ID:'fixture-client',GOOGLE_CLIENT_SECRET:'fixture-client-secret',CALENDAR_TOKEN_KEY:'11'.repeat(32),ADMIN_EMAIL:'admin@example.com',MAIL_FROM:'roomly@example.com'};
 sqlite.exec("INSERT INTO members(sub,email,name,role,status,requested_at) VALUES('member','member@example.com','Member','member','approved',1); UPDATE room_settings SET location='Meeting room',revision=2 WHERE id=1;");
 sqlite.prepare("INSERT INTO calendar_connections(member_sub,refresh_cipher,version,status,updated_at,shared_calendars) VALUES(?,?,?,'connected',1,1)").run(sub,await sealToken(env,sub,'fixture-refresh'),version);
 const pending=[],handler=createHandler(async credential=>JSON.parse(credential));
 const call=(path,options={})=>handler.fetch(new Request(origin+'/roomly/api/'+path,options),env,{waitUntil(p){pending.push(p);}});
 const get=(path,cookie='')=>call(path,{headers:{Cookie:cookie}});
 const post=(path,body={},cookie='')=>call(path,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json',Cookie:cookie},body:JSON.stringify(body)});
 async function login(){const response=await get('challenge'),challenge=await response.json(),nonceCookie=response.headers.getSetCookie()[0].split(';')[0],result=await post('login',{nonce:challenge.nonce,credential:JSON.stringify({email:'member@example.com',sub,name:'Member',emailAuthoritative:true})},nonceCookie);assert.equal(result.status,200);await Promise.all(pending.splice(0));return result.headers.getSetCookie()[0].split(';')[0];}
 const connection=()=>sqlite.prepare('SELECT * FROM calendar_connections WHERE member_sub=?').get(sub);
 return {sqlite,env,call,get,post,login,connection};
}
async function insertChannel(f,overrides={}){
 const channel={id:crypto.randomUUID(),token:'22'.repeat(32),resource:'fixture-resource-1',state:'active',version,expires:now()+3600,...overrides};
 f.sqlite.prepare('INSERT INTO calendar_watch_channels(channel_id,member_sub,connection_version,kind,calendar_key,token_hash,resource_id,expires_at,state,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(channel.id,sub,channel.version,'events','',await hash(channel.token),channel.resource,channel.expires,channel.state,now());return channel;
}
const notification=(channel,state='exists',overrides={})=>new Request(origin+'/roomly/api/calendar/notifications',{method:'POST',headers:{'X-Goog-Channel-ID':channel.id,'X-Goog-Channel-Token':channel.token,'X-Goog-Resource-ID':channel.resource,'X-Goog-Resource-State':state,'X-Goog-Message-Number':state==='sync'?'1':'2',...overrides}});
async function mocked(handler,action){const previous=globalThis.fetch,calls=[];globalThis.fetch=async(input,options={})=>{const url=new URL(String(input));calls.push({url:url.href,options});return handler(url,options,calls);};try{return await action(calls);}finally{globalThis.fetch=previous;}}
function google({title='Original reservation',watch,events,calendarList}={}){
 return async(url,options,calls)=>{
  if(url.hostname==='oauth2.googleapis.com')return json({access_token:'fixture-access',scope:scopes});
  if(url.pathname.endsWith('/watch')){const body=JSON.parse(options.body);if(watch)return watch(url,options,body,calls);return json({kind:'api#channel',id:body.id,resourceId:'opaque-'+body.id,expiration:Date.now()+7*86400000});}
  if(url.pathname.endsWith('/calendarList'))return calendarList?calendarList(url,options,calls):json({items:[]});
  if(events)return events(url,options,calls);return json({accessRole:'owner',items:[{...meeting(url.searchParams.get('timeMin').slice(0,10)),summary:title}]});
 };
}
const eventReads=calls=>calls.filter(call=>new URL(call.url).pathname.endsWith('/events'));
function watchOwner(f){
 const connection=f.connection(),lease=crypto.randomUUID();f.sqlite.prepare('INSERT INTO calendar_snapshots(member_sub,week_start,room_revision,connection_version,lease_id,lease_until) VALUES(?,?,?,?,?,?) ON CONFLICT(member_sub,week_start) DO UPDATE SET lease_id=excluded.lease_id,lease_until=excluded.lease_until').run(sub,week,2,connection.version,lease,now()+120);return {...connection,watch_week:week,watch_lease:lease};
}
async function addSource(f,member){
 f.sqlite.prepare("INSERT INTO members(sub,email,name,role,status,requested_at) VALUES(?,?,'Member','member','approved',1)").run(member,member+'@example.test');f.sqlite.prepare("INSERT INTO calendar_connections(member_sub,refresh_cipher,version,status,updated_at,shared_calendars) VALUES(?,?,?,'connected',1,1)").run(member,await sealToken(f.env,member,'fixture-refresh-'+member),version);
}

test('public notification route requires a valid channel binding but no browser session or Origin',async()=>{
 const f=await fixture(),channel=await insertChannel(f);await mocked(()=>{throw Error('webhook only marks durable state');},async calls=>{
  const valid=notification(channel);const response=await f.call('calendar/notifications',{method:'POST',headers:valid.headers});assert.equal(response.status,204);assert.equal(f.connection().change_revision,1);assert.equal(calls.length,0);
  const second=await calendarWebhook(notification(channel,'not_exists'),f.env);assert.equal(second.status,204);assert.equal(f.connection().change_revision,2);
  for(const path of ['calendar/notifications','calendar/notifications/other']){await f.call(path,{method:'GET',headers:valid.headers});assert.equal(f.connection().change_revision,2);}
  await f.call('calendar/notifications/other',{method:'POST',headers:valid.headers});assert.equal(f.connection().change_revision,2,'only the exact public POST path can accept notifications');
 });
});

test('forged, expired, unbound, revoked and old-version notifications never dirty the connection',async()=>{
 for(const scenario of ['unknown-channel','wrong-token','wrong-resource','unknown-state','expired','pending','old-version','rejected','disconnected']){
  const f=await fixture(),channel=await insertChannel(f,{...(scenario==='expired'?{expires:now()-1}:{}),...(scenario==='pending'?{state:'pending'}:{}),...(scenario==='old-version'?{version:'replaced-version'}:{})});
  if(scenario==='rejected')f.sqlite.exec("UPDATE members SET status='rejected' WHERE sub='member'");if(scenario==='disconnected')f.sqlite.exec("UPDATE calendar_connections SET status='reauthorize' WHERE member_sub='member'");
  const headers=scenario==='unknown-channel'?{'X-Goog-Channel-ID':crypto.randomUUID()}:scenario==='wrong-token'?{'X-Goog-Channel-Token':'44'.repeat(32)}:scenario==='wrong-resource'?{'X-Goog-Resource-ID':'wrong'}:{};
  const response=await calendarWebhook(notification(channel,scenario==='unknown-state'?'invalid':'exists',headers),f.env);assert.equal(response.status,204,scenario);assert.equal(f.connection().change_revision,0,scenario);
 }
 const f=await fixture(),response=await calendarWebhook(new Request(origin+'/roomly/api/calendar/notifications',{method:'POST'}),f.env);assert.equal(response.status,204);assert.equal(f.connection().change_revision,0);
});

test('watch registration tolerates an early sync, keeps only hashed calendar and channel secrets, and uses existing readonly scopes',async()=>{
 const f=await fixture(),calendar='shared+private@group.calendar.google.com',calendarKey=await hash(calendar),registered=[];
 await mocked(google({watch:async(url,options,body)=>{
  assert.equal(body.address,origin+'/roomly/api/calendar/notifications');assert.ok(['web_hook','webhook'].includes(body.type));assert.ok(body.token);assert.ok(!JSON.stringify(body).includes('fixture-refresh'));assert.ok(!JSON.stringify(body).includes('fixture-client-secret'));
  const stored=f.sqlite.prepare('SELECT * FROM calendar_watch_channels WHERE channel_id=?').get(body.id);assert.equal(stored.state,'pending');assert.equal(stored.token_hash,await hash(body.token));assert.notEqual(stored.token_hash,body.token);
  const before=f.connection().change_revision,early=await calendarWebhook(notification({id:body.id,token:body.token,resource:'opaque-'+body.id},'sync'),f.env);assert.equal(early.status,204);assert.equal(f.connection().change_revision,before,'initial sync itself never dirties the connection');registered.push({id:body.id,token:body.token});return json({kind:'api#channel',id:body.id,resourceId:'opaque-'+body.id,expiration:Date.now()+3600*1000});
 }}),async calls=>{
  await ensureCalendarWatches(f.env,watchOwner(f),'fixture-access',['primary',calendar],true,AbortSignal.timeout(10000));assert.equal(registered.length,3);assert.ok(calls.some(call=>call.url.includes(encodeURIComponent(calendar))));
  const channels=f.sqlite.prepare('SELECT * FROM calendar_watch_channels').all();assert.equal(channels.length,3);assert.ok(channels.every(channel=>channel.state==='active'&&channel.expires_at>=now()+3598&&channel.expires_at<=now()+3600));assert.ok(channels.some(channel=>channel.kind==='list'));assert.ok(channels.some(channel=>channel.kind==='events'&&channel.calendar_key===calendarKey));
  const stored=JSON.stringify({channels,targets:f.sqlite.prepare('SELECT * FROM calendar_watch_targets').all()});assert.ok(!stored.includes(calendar));for(const registration of registered)assert.ok(!stored.includes(registration.token));assert.equal(f.connection().change_revision,1,'activating the list channel schedules one catch-up for changes before activation');
  const tokenCalls=calls.filter(call=>new URL(call.url).hostname==='oauth2.googleapis.com');assert.equal(tokenCalls.length,0,'watch uses the existing access token without adding consent');
 });
});

test('batched watch targets preserve reused state and immediately reject removed channels through either pruning entry point',async()=>{
 for(const alreadyPruned of [false,true]){
  const f=await fixture(),keep='kept-calendar@example.test',removed='removed-calendar@example.test',added='new-calendar@example.test',keptKey=await hash(keep),removedKey=await hash(removed),addedKey=await hash(added);
  await mocked(google(),async calls=>{
   await ensureCalendarWatches(f.env,watchOwner(f),'fixture-access',['primary',keep,removed],true,AbortSignal.timeout(10000));
   const removedRequest=calls.find(call=>new URL(call.url).pathname.includes(encodeURIComponent(removed))),removedBody=JSON.parse(removedRequest.options.body),beforeChannels=f.sqlite.prepare('SELECT * FROM calendar_watch_channels WHERE calendar_key!=? ORDER BY channel_id').all(removedKey);
   f.sqlite.prepare("UPDATE calendar_watch_targets SET attempts=3,retry_at=?,error_code='WATCH_UNSUPPORTED' WHERE calendar_key=?").run(now()+86400,keptKey);const keptTarget=f.sqlite.prepare('SELECT * FROM calendar_watch_targets WHERE calendar_key=?').get(keptKey),owner=watchOwner(f),beforeRevision=f.connection().change_revision;
   if(alreadyPruned){await pruneCalendarWatches(f.env,owner,['',keptKey,addedKey],true);await calendarWebhook(notification({id:removedBody.id,token:removedBody.token,resource:'opaque-'+removedBody.id}),f.env);assert.equal(f.connection().change_revision,beforeRevision,'caller pruning rejects a removed resource before any new watch setup');}
   const prepare=f.env.DB.prepare,statements=[];f.env.DB.prepare=sql=>{statements.push(sql);return prepare(sql);};const count=calls.length;
   await ensureCalendarWatches(f.env,owner,'fixture-access',['primary',keep,added],true,AbortSignal.timeout(10000),alreadyPruned);f.env.DB.prepare=prepare;
   assert.equal(statements.filter(sql=>sql.startsWith('INSERT INTO calendar_watch_targets')).length,1,'one source ownership check admits all missing targets in one statement');assert.equal(statements.filter(sql=>sql.startsWith('DELETE FROM calendar_watch_')).length,alreadyPruned?1:3,'only replacement-channel cleanup remains when the caller already pruned');
   assert.equal(calls.length,count+1,'only a newly subscribed calendar needs a new watch');assert.ok(new URL(calls.at(-1).url).pathname.includes(encodeURIComponent(added)));assert.deepEqual(f.sqlite.prepare('SELECT * FROM calendar_watch_targets WHERE calendar_key=?').get(keptKey),keptTarget,'existing retry/backoff state is never reset by target discovery');
   assert.deepEqual(f.sqlite.prepare('SELECT * FROM calendar_watch_channels WHERE calendar_key!=? ORDER BY channel_id').all(addedKey),beforeChannels,'unexpired primary, list and kept-calendar channels retain their exact IDs');assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM calendar_watch_targets').get().n,4);assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM calendar_watch_targets WHERE calendar_key=?').get(removedKey).n,0);
   await calendarWebhook(notification({id:removedBody.id,token:removedBody.token,resource:'opaque-'+removedBody.id}),f.env);assert.equal(f.connection().change_revision,beforeRevision,'both pruning entry points immediately stop accepting removed-calendar notifications');
  });
 }
});

test('batch target insertion still requires current approval, connection version and source lease even after caller pruning',async()=>{
 for(const invalid of ['rejected','old-version','expired-lease']){
  const f=await fixture(),owner=watchOwner(f);
  if(invalid==='rejected')f.sqlite.exec("UPDATE members SET status='rejected'");else if(invalid==='old-version')f.sqlite.exec("UPDATE calendar_connections SET version='replacement-version'");else f.sqlite.exec('UPDATE calendar_snapshots SET lease_until=0');
  await mocked(()=>{throw Error('unowned source cannot call Google');},async calls=>{await ensureCalendarWatches(f.env,owner,'fixture-access',['primary','shared-a@example.test','shared-b@example.test'],true,AbortSignal.timeout(10000),true);assert.equal(calls.length,0,invalid);assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM calendar_watch_targets').get().n,0,invalid);assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM calendar_watch_channels').get().n,0,invalid);});
 }
});

test('changed calendars refresh one cached week per tick and leave other fresh-cache generations pending',async()=>{
 const f=await fixture();let title='Original reservation';await mocked(google({events:url=>json({accessRole:'owner',items:[{...meeting(url.searchParams.get('timeMin').slice(0,10)),summary:title}]})}),async calls=>{
  for(const day of [week,nextWeek])await syncCalendars(f.env,day);await calendarMaintenance(f.env,false);assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM calendar_snapshots').get().n,2);const baseRevision=f.connection().change_revision,before=calls.length;
  await calendarMaintenance(f.env,false);assert.equal(calls.length,before,'a clean minute tick does not poll Google events');
  const registration=calls.find(call=>new URL(call.url).pathname.endsWith('/events/watch')),body=JSON.parse(registration.options.body),channel={id:body.id,token:body.token,resource:'opaque-'+body.id};title='Updated reservation';
  assert.equal((await calendarWebhook(notification(channel),f.env)).status,204);assert.equal(f.connection().change_revision,baseRevision+1);await calendarMaintenance(f.env,false);
  assert.equal(eventReads(calls.slice(before)).length,1);assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM calendar_snapshots WHERE change_revision<?').get(baseRevision+1).n,1,'the unvisited week retains its durable pending generation');await calendarMaintenance(f.env,false);
  const refreshed=eventReads(calls.slice(before));assert.deepEqual(refreshed.map(call=>new URL(call.url).searchParams.get('timeMin').slice(0,10)).sort(),[week,nextWeek].sort());
  const snapshots=f.sqlite.prepare('SELECT * FROM calendar_snapshots ORDER BY week_start').all();assert.ok(snapshots.every(snapshot=>snapshot.change_revision===baseRevision+1&&snapshot.attempt_revision===baseRevision+1));assert.ok(snapshots.every(snapshot=>JSON.parse(snapshot.data)[0].summary==='Updated reservation'));
  const count=calls.length;await calendarMaintenance(f.env,false);assert.equal(calls.length,count,'successful dirty work acknowledges exactly that change generation');
 });
});

test('minute maintenance initializes an unwatched current week and then respects its individual ten-minute fallback',async()=>{
 const realNow=Date.now;let clock=Date.parse(week+'T12:00:00+08:00')+2*86400000;Date.now=()=>clock;
 try{
  const f=await fixture(),started=now();assert.equal(f.connection().change_revision,0);
  await mocked(google(),async calls=>{
   await calendarMaintenance(f.env,false);let snapshot=f.sqlite.prepare('SELECT * FROM calendar_snapshots WHERE week_start=?').get(week);assert.ok(snapshot,'missing current-week data must initialize even before any Google notification');assert.equal(snapshot.error_code,null);assert.equal(JSON.parse(snapshot.data).length,1);assert.equal(eventReads(calls).length,1);
   await calendarMaintenance(f.env,false);snapshot=f.sqlite.prepare('SELECT * FROM calendar_snapshots WHERE week_start=?').get(week);assert.equal(snapshot.change_revision,f.connection().change_revision,'the new list channel bootstrap is caught up separately');assert.equal(eventReads(calls).length,2);const count=calls.length;
   clock+=599000;await calendarMaintenance(f.env,true);assert.equal(calls.length,count,'a ten-minute cleanup boundary cannot shorten the individual cache lifetime');
   clock+=1000;await calendarMaintenance(f.env,false);snapshot=f.sqlite.prepare('SELECT * FROM calendar_snapshots WHERE week_start=?').get(week);assert.equal(eventReads(calls).length,3,'normal fallback runs after ten minutes even without a new push');assert.equal(snapshot.synced_at,started+600);assert.equal(snapshot.retry_at,started+1200);assert.equal(snapshot.change_revision,f.connection().change_revision);
  });
 }finally{Date.now=realNow;}
});

test('source failure diagnostics emit only closed categories and validated statuses while keeping private errors out of logs and caches',async()=>{
 const privateText='private-person@example.test private-office-name private-provider-token https://provider.example.test/private-calendar',cases=[
  {fail:()=>{throw Error(privateText);},code:'runtime_error',status:0},
  {fail:()=>{throw TypeError(privateText);},code:'network_or_runtime_type',status:0},
  {fail:()=>{throw new DOMException(privateText,'AbortError');},code:'aborted',status:0},
  {fail:()=>{throw new DOMException(privateText,'TimeoutError');},code:'timeout',status:0},
  {fail:()=>json({error:{message:privateText,resourceUri:privateText}},503),code:'provider_http',status:503},
  {fail:()=>{throw new CalendarError(502,privateText,777);},code:'provider_response',status:0},
  {fail:()=>{throw new CalendarError(502,'toString');},code:'provider_response',status:0},
 ];
 const previousWarn=console.warn;let warnings=[];console.warn=(...args)=>warnings.push(args);
 try{
  for(const scenario of cases){const f=await fixture();await mocked(google(),()=>syncCalendars(f.env,week));const previous=f.sqlite.prepare('SELECT data,synced_at,change_revision FROM calendar_snapshots').get();f.sqlite.exec('UPDATE calendar_snapshots SET retry_at=0');warnings=[];
   await mocked(google({events:scenario.fail}),()=>syncCalendars(f.env,week));assert.deepEqual(warnings,[[JSON.stringify({event:'calendar_sync_failed',code:scenario.code,providerStatus:scenario.status})]],'diagnostics must never include exception text, provider body or request identity');
   assert.equal(f.connection().status,'connected');assert.deepEqual(f.sqlite.prepare('SELECT data,synced_at,change_revision FROM calendar_snapshots').get(),previous,'transient failure preserves the last complete data and acknowledged generation');const failed=f.sqlite.prepare('SELECT error_code,retry_at,lease_until FROM calendar_snapshots').get();assert.equal(failed.error_code,'SYNC_FAILED');assert.ok(failed.retry_at>=now()+599);assert.equal(failed.lease_until,0);const stored=JSON.stringify(f.sqlite.prepare('SELECT * FROM calendar_snapshots').all());assert.ok(!stored.includes(privateText));
  }
 }finally{console.warn=previousWarn;}
});

test('failed dirty synchronization retains the pending generation, honors its backoff and can later complete',async()=>{
 const f=await fixture();let failure=false;await mocked(google({events:url=>failure?json({error:'temporary'},503):json({accessRole:'owner',items:[meeting(url.searchParams.get('timeMin').slice(0,10))]})}),async calls=>{
  await syncCalendars(f.env,week);await calendarMaintenance(f.env,false);const baseRevision=f.connection().change_revision,registration=calls.find(call=>new URL(call.url).pathname.endsWith('/events/watch')),body=JSON.parse(registration.options.body),channel={id:body.id,token:body.token,resource:'opaque-'+body.id};
  await calendarWebhook(notification(channel),f.env);failure=true;await calendarMaintenance(f.env,false);const failed=f.sqlite.prepare('SELECT * FROM calendar_snapshots WHERE week_start=?').get(week);assert.equal(failed.error_code,'SYNC_FAILED');assert.equal(failed.change_revision,baseRevision);assert.equal(failed.attempt_revision,baseRevision+1);assert.ok(failed.retry_at>now());assert.ok(JSON.parse(failed.data).length>0,'last complete data remains explicitly stale');
  const count=calls.length;await calendarMaintenance(f.env,false);assert.equal(calls.length,count,'the same notification generation cannot defeat provider backoff');
  f.sqlite.exec('UPDATE calendar_snapshots SET retry_at=0');failure=false;await calendarMaintenance(f.env,false);const completed=f.sqlite.prepare('SELECT * FROM calendar_snapshots WHERE week_start=?').get(week);assert.equal(completed.change_revision,baseRevision+1);assert.equal(completed.attempt_revision,baseRevision+1);assert.equal(completed.error_code,null);assert.equal(f.connection().change_revision,baseRevision+1);
 });
});

test('a notification arriving during a lease is not acknowledged by the older response and remains for another dirty tick',async()=>{
 const f=await fixture();let hold=false,release,reached;const gate=new Promise(resolve=>release=resolve),entered=new Promise(resolve=>reached=resolve);await mocked(google({events:async url=>{if(hold){reached();await gate;}return json({accessRole:'owner',items:[meeting(url.searchParams.get('timeMin').slice(0,10))]});}}),async calls=>{
  await syncCalendars(f.env,week);await calendarMaintenance(f.env,false);const baseRevision=f.connection().change_revision,body=JSON.parse(calls.find(call=>new URL(call.url).pathname.endsWith('/events/watch')).options.body),channel={id:body.id,token:body.token,resource:'opaque-'+body.id};await calendarWebhook(notification(channel),f.env);
  hold=true;const first=calendarMaintenance(f.env,false);await entered;await calendarWebhook(notification(channel),f.env);assert.equal(f.connection().change_revision,baseRevision+2);release();await first;
  const older=f.sqlite.prepare('SELECT * FROM calendar_snapshots WHERE week_start=?').get(week);assert.equal(older.change_revision,baseRevision+1,'the old response only acknowledges the generation it started with');assert.equal(older.attempt_revision,baseRevision+1);hold=false;const count=eventReads(calls).length;await calendarMaintenance(f.env,false);assert.equal(eventReads(calls).length,count+1,'a newer notification bypasses the old successful cache');assert.equal(f.sqlite.prepare('SELECT change_revision FROM calendar_snapshots WHERE week_start=?').get(week).change_revision,baseRevision+2);
 });
});

test('watch registration failure does not turn a successful event sync into an error and retries respect watch backoff',async()=>{
 const f=await fixture();await mocked(google({watch:()=>json({error:'watch unavailable'},503)}),async calls=>{
  await syncCalendars(f.env,week);const snapshot=f.sqlite.prepare('SELECT * FROM calendar_snapshots WHERE week_start=?').get(week);assert.equal(snapshot.error_code,null);assert.ok(snapshot.synced_at>0);assert.ok(JSON.parse(snapshot.data).length>0);
  const targets=f.sqlite.prepare('SELECT * FROM calendar_watch_targets').all();assert.equal(targets.length,2);assert.ok(targets.every(target=>target.attempts===1&&target.retry_at>now()));assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM calendar_watch_channels').get().n,0);
  const watchCount=calls.filter(call=>new URL(call.url).pathname.endsWith('/watch')).length;await ensureCalendarWatches(f.env,watchOwner(f),'fixture-access',['primary'],true,AbortSignal.timeout(10000));assert.equal(calls.filter(call=>new URL(call.url).pathname.endsWith('/watch')).length,watchCount);
 });
});

test('watch diagnostics classify only exact provider reasons with their expected HTTP statuses',async()=>{
 const cases=[
  [400,'pushNotSupportedForRequestedResource','WATCH_UNSUPPORTED'],[400,'unsupportedResource','WATCH_UNSUPPORTED'],
  [403,'rateLimitExceeded','WATCH_RATE_LIMIT'],[429,'userRateLimitExceeded','WATCH_RATE_LIMIT'],
  [403,'quotaExceeded','WATCH_QUOTA'],[429,'quotaExceeded','WATCH_QUOTA'],
  [401,'authError','WATCH_AUTH'],[403,'authError','WATCH_AUTH'],
  [500,'backendError','WATCH_BACKEND'],[503,'backendError','WATCH_BACKEND'],
  [503,'unsupportedResource','WATCH_HTTP_503'],[400,'backendError','WATCH_HTTP_400'],
  [400,'UnsupportedResource','WATCH_HTTP_400'],[403,'unknownReason','WATCH_HTTP_403'],
 ];
 for(const [index,[status,reason,code]] of cases.entries()){
  const f=await fixture(),before=now(),body=index%2?{error:{errors:[{reason}]}}:{error:{reason}};
  await mocked(google({watch:()=>json(body,status)}),async()=>{
   await ensureCalendarWatches(f.env,watchOwner(f),'fixture-access',['primary'],false,AbortSignal.timeout(10000));
   const target=f.sqlite.prepare('SELECT * FROM calendar_watch_targets').get();assert.equal(target.error_code,code,status+' '+reason);assert.equal(target.attempts,1);assert.equal(target.lease_until,0);
   const delay=code==='WATCH_UNSUPPORTED'?86400:600;assert.ok(target.retry_at>=before+delay);assert.ok(target.retry_at<=now()+delay+(code==='WATCH_UNSUPPORTED'?0:59));
   assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM calendar_watch_channels').get().n,0,'failed registrations leave no pending channel');assert.equal(f.connection().status,'connected');
  });
 }
});

test('an unsupported event watch leaves reservations available and waits a full day before another registration',async()=>{
 const realNow=Date.now,started=Date.now();let clock=started,failure=true;Date.now=()=>clock;
 try{
  const f=await fixture();await mocked(google({watch:(url,options,body)=>failure&&url.pathname.endsWith('/events/watch')?json({error:{errors:[{reason:'pushNotSupportedForRequestedResource'}]}},400):json({kind:'api#channel',id:body.id,resourceId:'opaque-'+body.id,expiration:Date.now()+7*86400000})}),async calls=>{
   await syncCalendars(f.env,week);const snapshot=f.sqlite.prepare('SELECT * FROM calendar_snapshots WHERE week_start=?').get(week);assert.equal(snapshot.error_code,null);assert.ok(snapshot.synced_at>0);assert.equal(JSON.parse(snapshot.data).length,1);assert.equal(f.connection().status,'connected');
   const failed=f.sqlite.prepare("SELECT * FROM calendar_watch_targets WHERE kind='events'").get();assert.equal(failed.error_code,'WATCH_UNSUPPORTED');assert.equal(failed.retry_at,Math.floor(started/1000)+86400);assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM calendar_watch_channels WHERE state='active' AND kind='list'").get().n,1);
   const watches=()=>calls.filter(call=>new URL(call.url).pathname.endsWith('/events/watch')).length,watchCount=watches(),reads=eventReads(calls).length;
   clock=started+600000;await syncCalendars(f.env,week);assert.equal(eventReads(calls).length,reads+1,'the normal event fallback still refreshes while push registration is backed off');assert.equal(watches(),watchCount);
   clock=started+86399000;await ensureCalendarWatches(f.env,watchOwner(f),'fixture-access',['primary'],true,AbortSignal.timeout(10000));assert.equal(watches(),watchCount,'23:59:59 is still inside the daily registration backoff');
   clock=started+86400000;failure=false;await ensureCalendarWatches(f.env,watchOwner(f),'fixture-access',['primary'],true,AbortSignal.timeout(10000));assert.equal(watches(),watchCount+1);const recovered=f.sqlite.prepare("SELECT * FROM calendar_watch_targets WHERE kind='events'").get();assert.equal(recovered.error_code,null);assert.equal(recovered.retry_at,0);assert.equal(recovered.attempts,0);assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM calendar_watch_channels WHERE state='active'").get().n,2);
  });
 }finally{Date.now=realNow;}
});

test('unknown watch error reasons, private messages and routing URLs are never persisted',async()=>{
 const f=await fixture(),calendar='private-calendar@example.test',privateText=['private-person@example.test','private-office-name','private-provider-token'];let responseSecrets=[];
 await mocked(google({watch:(url,options,body)=>{
  responseSecrets=[...privateText,calendar,body.token,body.id,'https://provider.example.test/calendar/'+calendar];
  return json({error:{reason:'unknown:'+privateText[0],message:privateText.join(' '),errors:[{reason:'unknown:'+privateText[2],message:body.token,location:responseSecrets.at(-1)}],resourceUri:responseSecrets.at(-1),channelId:body.id}},400);
 }}),async()=>{
  await ensureCalendarWatches(f.env,watchOwner(f),'fixture-access',[calendar],false,AbortSignal.timeout(10000));assert.equal(f.sqlite.prepare('SELECT error_code FROM calendar_watch_targets').get().error_code,'WATCH_HTTP_400');
  const stored=JSON.stringify(Object.fromEntries(['calendar_watch_targets','calendar_watch_channels','calendar_connections','calendar_snapshots'].map(table=>[table,f.sqlite.prepare('SELECT * FROM '+table).all()])));
  assert.ok(responseSecrets.every(value=>!stored.includes(value)),'only a fixed diagnostic code and hashed calendar routing key may survive the failed response');assert.equal(f.sqlite.prepare('SELECT calendar_key FROM calendar_watch_targets').get().calendar_key,await hash(calendar));
 });
});

test('malformed, oversized and out-of-window watch error bodies retain only the HTTP diagnostic',async()=>{
 const oversized=new TextEncoder().encode(JSON.stringify({error:{reason:'unsupportedResource',message:'x'.repeat(17000)}}));let cancelled=false;
 const cases=[
  ()=>new Response('{"error":{"reason":"unsupportedResource"}} trailing',{status:400}),
  ()=>new Response(new ReadableStream({start(controller){controller.enqueue(oversized.slice(0,8192));controller.enqueue(oversized.slice(8192,16384));controller.enqueue(oversized.slice(16384));},cancel(){cancelled=true;}}),{status:400,headers:{'Content-Type':'application/json','Content-Length':'1'}}),
  ()=>json({error:{errors:[...Array.from({length:10},()=>({reason:'unknownReason'})),{reason:'unsupportedResource'}]}},400),
 ];
 for(const response of cases){const f=await fixture();await mocked(google({watch:response}),async()=>{await ensureCalendarWatches(f.env,watchOwner(f),'fixture-access',['primary'],false,AbortSignal.timeout(10000));const target=f.sqlite.prepare('SELECT * FROM calendar_watch_targets').get();assert.equal(target.error_code,'WATCH_HTTP_400');assert.ok(target.retry_at<=now()+659,'untrusted JSON does not select the unsupported daily backoff');assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM calendar_watch_channels').get().n,0);});}
 assert.equal(cancelled,true,'the oversized stream is cancelled even when its Content-Length claims one byte');
});

test('watch renewal uses a new channel and the real server expiration, while stale connection channels cannot trigger work',async()=>{
 const f=await fixture();await mocked(google(),async calls=>{
  await ensureCalendarWatches(f.env,watchOwner(f),'fixture-access',['primary'],true,AbortSignal.timeout(10000));const first=f.sqlite.prepare('SELECT * FROM calendar_watch_channels ORDER BY channel_id').all();assert.equal(first.length,2);
  const count=calls.length;await ensureCalendarWatches(f.env,watchOwner(f),'fixture-access',['primary'],true,AbortSignal.timeout(10000));assert.equal(calls.length,count,'unexpired channels outside the renewal window are reused');
  f.sqlite.exec('UPDATE calendar_watch_channels SET expires_at=1');await ensureCalendarWatches(f.env,watchOwner(f),'fixture-access',['primary'],true,AbortSignal.timeout(10000));const active=f.sqlite.prepare("SELECT * FROM calendar_watch_channels WHERE expires_at>? AND state='active'").all(now());assert.equal(active.length,2);assert.ok(active.every(channel=>!first.some(old=>old.channel_id===channel.channel_id)));
  const body=JSON.parse(calls.find(call=>new URL(call.url).pathname.endsWith('/watch')).options.body),baseRevision=f.connection().change_revision;f.sqlite.exec("UPDATE calendar_connections SET version='replacement-version' WHERE member_sub='member'");await calendarWebhook(notification({id:body.id,token:body.token,resource:'opaque-'+body.id}),f.env);assert.equal(f.connection().change_revision,baseRevision);
 });
});

test('a classified backend renewal failure preserves the still-valid old channel and cannot bypass registration backoff',async()=>{
 const f=await fixture();let failure=false;await mocked(google({watch:(url,options,body)=>failure?json({error:{errors:[{reason:'backendError'}]}},503):json({kind:'api#channel',id:body.id,resourceId:'opaque-'+body.id,expiration:Date.now()+7*86400000})}),async calls=>{
  await ensureCalendarWatches(f.env,watchOwner(f),'fixture-access',['primary'],true,AbortSignal.timeout(10000));const old=f.sqlite.prepare('SELECT * FROM calendar_watch_channels ORDER BY channel_id').all();f.sqlite.prepare('UPDATE calendar_watch_channels SET expires_at=?').run(now()+3600);failure=true;
  await ensureCalendarWatches(f.env,watchOwner(f),'fixture-access',['primary'],true,AbortSignal.timeout(10000));const retained=f.sqlite.prepare('SELECT * FROM calendar_watch_channels ORDER BY channel_id').all();assert.deepEqual(retained.map(channel=>channel.channel_id),old.map(channel=>channel.channel_id));assert.ok(retained.every(channel=>channel.state==='active'));
  const targets=f.sqlite.prepare('SELECT * FROM calendar_watch_targets').all();assert.ok(targets.every(target=>target.error_code==='WATCH_BACKEND'&&target.retry_at>now()&&target.retry_at<=now()+659));
  const original=calls.find(call=>new URL(call.url).pathname.endsWith('/events/watch')),body=JSON.parse(original.options.body),baseRevision=f.connection().change_revision;await calendarWebhook(notification({id:body.id,token:body.token,resource:'opaque-'+body.id}),f.env);assert.equal(f.connection().change_revision,baseRevision+1,'the old channel continues to accept changes during failed renewal');
  const count=calls.length;await ensureCalendarWatches(f.env,watchOwner(f),'fixture-access',['primary'],true,AbortSignal.timeout(10000));assert.equal(calls.length,count);
 });
});

test('a watch response from an expired source lease cannot activate notifications',async()=>{
 const f=await fixture();let release,reached;const gate=new Promise(resolve=>release=resolve),entered=new Promise(resolve=>reached=resolve),registrations=[];await mocked(google({watch:async(url,options,body)=>{registrations.push(body);reached();await gate;return json({kind:'api#channel',id:body.id,resourceId:'opaque-'+body.id,expiration:Date.now()+7*86400000});}}),async()=>{
  const pending=ensureCalendarWatches(f.env,watchOwner(f),'fixture-access',['primary'],false,AbortSignal.timeout(10000));await entered;f.sqlite.exec('UPDATE calendar_snapshots SET lease_until=0');release();await pending;assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM calendar_watch_channels WHERE state='active'").get().n,0);
  const body=registrations[0];await calendarWebhook(notification({id:body.id,token:body.token,resource:'opaque-'+body.id}),f.env);assert.equal(f.connection().change_revision,0);
 });
});

test('watch setup limits one source to six registrations per round and at most three simultaneous HTTP requests',async()=>{
 const f=await fixture(),calendars=['primary',...Array.from({length:10},(_,i)=>'shared-'+i+'@example.test')];let active=0,maximum=0;await mocked(google({watch:async(url,options,body)=>{active++;maximum=Math.max(maximum,active);await new Promise(resolve=>setImmediate(resolve));active--;return json({kind:'api#channel',id:body.id,resourceId:'opaque-'+body.id,expiration:Date.now()+7*86400000});}}),async calls=>{
  await ensureCalendarWatches(f.env,watchOwner(f),'fixture-access',calendars,true,AbortSignal.timeout(10000));assert.equal(calls.length,6);assert.ok(maximum<=3,'watch request concurrency never exceeds three');assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM calendar_watch_targets').get().n,12);
  await ensureCalendarWatches(f.env,watchOwner(f),'fixture-access',calendars,true,AbortSignal.timeout(10000));assert.equal(calls.length,12);assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM calendar_watch_channels WHERE state='active'").get().n,12);assert.ok(maximum<=3,'watch request concurrency never exceeds three');
 });
});

test('one change signal removes deleted reservations and moves an invitation across four successive cached-week ticks',async()=>{
 const f=await fixture(),weeks=Array.from({length:4},(_,i)=>new Date(Date.parse(week+'T00:00:00Z')+i*7*86400000).toISOString().slice(0,10));let changed=false;
 await mocked(google({events:url=>{const day=url.searchParams.get('timeMin').slice(0,10),event=meeting(day);return json({accessRole:'owner',items:!changed?[event]:day===weeks[3]?[{...event,iCalUID:meeting(weeks[0]).iCalUID,summary:'Moved invitation'}]:[]});}}),async calls=>{
  for(const day of weeks)await syncCalendars(f.env,day);await calendarMaintenance(f.env,false);assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM calendar_snapshots').get().n,4);
  const baseRevision=f.connection().change_revision,body=JSON.parse(calls.find(call=>new URL(call.url).pathname.endsWith('/events/watch')).options.body);changed=true;await calendarWebhook(notification({id:body.id,token:body.token,resource:'opaque-'+body.id}),f.env);const before=eventReads(calls).length;
  for(let tick=0;tick<weeks.length;tick++){const count=eventReads(calls).length;await calendarMaintenance(f.env,false);assert.equal(eventReads(calls).length,count+1);assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM calendar_snapshots WHERE change_revision<?').get(baseRevision+1).n,weeks.length-tick-1,'unvisited weeks are never acknowledged by another week');}
  assert.deepEqual(eventReads(calls).slice(before).map(call=>new URL(call.url).searchParams.get('timeMin').slice(0,10)).sort(),weeks);
  const snapshots=f.sqlite.prepare('SELECT week_start,data,change_revision FROM calendar_snapshots ORDER BY week_start').all();assert.ok(snapshots.every(snapshot=>snapshot.change_revision===baseRevision+1));for(const snapshot of snapshots.slice(0,3))assert.deepEqual(JSON.parse(snapshot.data),[],'deleted or moved meetings vanish from their old week');const destination=JSON.parse(snapshots[3].data);assert.equal(destination.length,1);assert.equal(destination[0].iCalUID,meeting(weeks[0]).iCalUID);assert.equal(destination[0].summary,'Moved invitation');
 });
});

test('continuous notifications fairly rotate one dirty week per tick so later cached weeks cannot starve',async()=>{
 const realNow=Date.now;let clock=Date.parse(week+'T12:00:00+08:00')+2*86400000;Date.now=()=>clock;
 try{
  const f=await fixture(),weeks=Array.from({length:8},(_,i)=>new Date(Date.parse(week+'T00:00:00Z')+i*7*86400000).toISOString().slice(0,10));await mocked(google(),async calls=>{
   for(const day of weeks){await syncCalendars(f.env,day);clock+=1000;}await calendarMaintenance(f.env,false);const baseRevision=f.connection().change_revision,body=JSON.parse(calls.find(call=>new URL(call.url).pathname.endsWith('/events/watch')).options.body),channel={id:body.id,token:body.token,resource:'opaque-'+body.id},visited=new Map();
   for(let tick=0;tick<weeks.length;tick++){
    clock+=60000;await calendarWebhook(notification(channel),f.env);const before=eventReads(calls).length;await calendarMaintenance(f.env,false);const reads=eventReads(calls).slice(before);assert.equal(reads.length,1,'each minute processes only one week even when every cached week is dirty');const day=new URL(reads[0].url).searchParams.get('timeMin').slice(0,10);visited.set(day,baseRevision+tick+1);assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM calendar_snapshots WHERE change_revision<?').get(f.connection().change_revision).n,weeks.length-1,'only the visited week may acknowledge this notification generation');
   }
   assert.deepEqual([...visited.keys()].sort(),weeks,'new notifications between ticks must not keep selecting only the current week');assert.equal(f.connection().change_revision,baseRevision+weeks.length);for(const snapshot of f.sqlite.prepare('SELECT week_start,change_revision FROM calendar_snapshots').all())assert.equal(snapshot.change_revision,visited.get(snapshot.week_start),'each week acknowledges only the generation processed during its own tick');
  });
 }finally{Date.now=realNow;}
});

test('six shared-calendar sources refresh every cached week with at most two sources per maintenance tick without losing queued work',async()=>{
 const realNow=Date.now;let clock=Date.parse(week+'T12:00:00+08:00')+2*86400000;Date.now=()=>clock;
 try{
  const f=await fixture(),members=[sub,...Array.from({length:5},(_,i)=>'member-'+i)],weeks=Array.from({length:5},(_,i)=>new Date(Date.parse(week+'T00:00:00Z')+i*7*86400000).toISOString().slice(0,10)),started=now();
  for(const member of members.slice(1))await addSource(f,member);
  for(const [index,day] of weeks.entries())for(const member of members)f.sqlite.prepare('INSERT INTO calendar_snapshots(member_sub,week_start,room_revision,connection_version,data,synced_at,retry_at) VALUES(?,?,?,?,?,?,?)').run(member,day,2,version,JSON.stringify([{id:'cached-'+member+'-'+day,summary:'Cached reservation'}]),started-601-index,started-1-index);
  let invocationCalls=0,limitHits=0;const provider=google({calendarList:()=>json({items:[{id:'shared-a@example.test',accessRole:'reader'},{id:'shared-b@example.test',accessRole:'reader'}]}),title:'Fresh reservation'}),visited=new Set();
  await mocked((url,options,calls)=>{if(++invocationCalls>50){limitHits++;throw Error('fixture subrequest limit');}return provider(url,options,calls);},async calls=>{
   for(let tick=0;tick<18;tick++){
    clock+=60000;invocationCalls=0;const before=calls.length;await calendarMaintenance(f.env,tick%10===0);assert.equal(limitHits,0,'each cron invocation must stay below the synthetic Free-plan external fetch limit');assert.ok(invocationCalls<=50);
    const invocation=calls.slice(before),tokens=invocation.filter(call=>new URL(call.url).hostname==='oauth2.googleapis.com'),sources=new Set(tokens.map(call=>new URLSearchParams(call.options.body).get('refresh_token')));assert.ok(sources.size>0&&sources.size<=2,'CPU budgeting must limit actual provider work to two different accounts per invocation');assert.equal(tokens.length,sources.size,'each selected account refreshes its access token once');
    const reads=eventReads(invocation),days=new Set(reads.map(call=>new URL(call.url).searchParams.get('timeMin').slice(0,10)));assert.equal(days.size,1,'the ten-minute cleanup tick must not add extra fallback weeks');for(const day of days)visited.add(day);assert.equal(reads.length,sources.size*3,'every selected source completes primary and both shared calendars');
    const snapshots=f.sqlite.prepare('SELECT * FROM calendar_snapshots').all();assert.ok(snapshots.every(snapshot=>snapshot.error_code===null),'local invocation pressure must not falsely mark unrelated sources as failed');
    if(tick<14)assert.ok(snapshots.some(snapshot=>JSON.parse(snapshot.data)[0].summary==='Cached reservation'),'unvisited complete data stays intact until that account and week can be processed');
   }
   assert.deepEqual([...visited].sort(),weeks);const snapshots=f.sqlite.prepare('SELECT s.*,c.change_revision AS source_revision FROM calendar_snapshots s JOIN calendar_connections c ON c.member_sub=s.member_sub').all();assert.equal(snapshots.length,members.length*weeks.length);assert.ok(snapshots.every(snapshot=>snapshot.synced_at>=started&&JSON.parse(snapshot.data).length===3&&JSON.parse(snapshot.data).every(event=>event.summary==='Fresh reservation')));assert.ok(snapshots.every(snapshot=>snapshot.change_revision===snapshot.source_revision),'list-watch bootstrap generations also finish without discarding any week');
  });
 }finally{Date.now=realNow;}
});

test('warmed six-source five-week caches remain fresh and fairly revisited across several background rotations',async()=>{
 const realNow=Date.now;let clock=Date.parse(week+'T12:00:00+08:00')+2*86400000;Date.now=()=>clock;
 try{
  const f=await fixture(),members=[sub,...Array.from({length:5},(_,i)=>'member-'+i)],weeks=Array.from({length:5},(_,i)=>new Date(Date.parse(week+'T00:00:00Z')+i*7*86400000).toISOString().slice(0,10));for(const member of members.slice(1))await addSource(f,member);
  await mocked(google({calendarList:()=>json({items:[{id:'shared-a@example.test',accessRole:'reader'},{id:'shared-b@example.test',accessRole:'reader'}]})}),async()=>{
   // Initial reads and list-watch catch-up can align all deadlines. Exempt
   // that first background pass, then measure the settled rotating schedule.
   for(const day of weeks)await syncCalendars(f.env,day);await syncCalendars(f.env,week);const seeded=now(),rows=()=>f.sqlite.prepare('SELECT s.*,c.change_revision AS source_revision FROM calendar_snapshots s JOIN calendar_connections c ON c.member_sub=s.member_sub ORDER BY s.member_sub,s.week_start').all();assert.equal(rows().length,30);assert.ok(rows().every(row=>row.change_revision===row.source_revision));
   let warmed=false;for(let tick=0;tick<30&&!warmed;tick++){clock+=60000;await calendarMaintenance(f.env,tick%10===0);warmed=rows().every(row=>row.synced_at>seeded);}assert.equal(warmed,true,'all thirty account-week caches must join the background rotation');
   const visits=new Map(rows().map(row=>[row.member_sub+'|'+row.week_start,0]));
   const assertFresh=snapshots=>{assert.equal(snapshots.length,30);for(const snapshot of snapshots){assert.equal(snapshot.error_code,null,'healthy rotation must not label a source as failed');assert.ok(now()-snapshot.synced_at<=1200,'each warmed snapshot stays within the twenty-minute feed freshness threshold');assert.equal(snapshot.change_revision,snapshot.source_revision,'ordinary fallback does not drop the acknowledged watch generation');assert.equal(JSON.parse(snapshot.data).length,3);}};
   for(let tick=0;tick<60;tick++){
    const before=rows();clock+=60000;assertFresh(before);await calendarMaintenance(f.env,tick%10===0);const after=rows();assertFresh(after);
    for(const [index,row] of after.entries())if(row.synced_at>before[index].synced_at){const key=row.member_sub+'|'+row.week_start;visits.set(key,visits.get(key)+1);}
   }
   assert.ok([...visits.values()].every(count=>count>=3),'every source and week must participate repeatedly, rather than only the most active or current week');
  });
 }finally{Date.now=realNow;}
});

test('sources locked on another week cannot consume the source budget or block a different claimable week',async()=>{
 const f=await fixture(),blocked=[sub,'blocked-member'],available='ready-member',thirdWeek=new Date(Date.parse(week+'T00:00:00Z')+14*86400000).toISOString().slice(0,10),started=now();for(const member of [blocked[1],available])await addSource(f,member);
 const insert=f.sqlite.prepare('INSERT INTO calendar_snapshots(member_sub,week_start,room_revision,connection_version,data,synced_at,retry_at,lease_id,lease_until) VALUES(?,?,?,?,?,?,?,?,?)');
 for(const member of blocked){for(const day of [week,nextWeek])insert.run(member,day,2,version,JSON.stringify([{summary:'Locked source reservation'}]),started-601,started-200,'',0);insert.run(member,thirdWeek,2,version,'[]',started,started+600,'existing-source-lease',started+120);}
 insert.run(available,week,2,version,'[]',started,started+600,'',0);insert.run(available,nextWeek,2,version,JSON.stringify([{summary:'Available source old reservation'}]),started-601,started-1,'',0);
 const before=f.sqlite.prepare("SELECT * FROM calendar_snapshots WHERE member_sub!=? ORDER BY member_sub,week_start").all(available);
 await mocked(google({title:'Available source refreshed reservation'}),async calls=>{
  await calendarMaintenance(f.env,false);const tokens=calls.filter(call=>new URL(call.url).hostname==='oauth2.googleapis.com');assert.equal(tokens.length,1);assert.equal(new URLSearchParams(tokens[0].options.body).get('refresh_token'),'fixture-refresh-'+available,'only the account without another-week ownership may contact Google');
  assert.deepEqual(eventReads(calls).map(call=>new URL(call.url).searchParams.get('timeMin').slice(0,10)),[nextWeek],'an older but unclaimable week cannot keep winning the scheduler');const updated=f.sqlite.prepare('SELECT * FROM calendar_snapshots WHERE member_sub=? AND week_start=?').get(available,nextWeek);assert.equal(JSON.parse(updated.data)[0].summary,'Available source refreshed reservation');assert.equal(updated.error_code,null);
  assert.deepEqual(f.sqlite.prepare("SELECT * FROM calendar_snapshots WHERE member_sub!=? ORDER BY member_sub,week_start").all(available),before,'blocked work retains both its complete data and its active ownership');
 });
});

test('a rejected initial database claim emits a safe diagnostic while another source can finish and queued work can retry',async()=>{
 const f=await fixture(),other='healthy-member',privateText='private-person@example.test private-office private-token https://private.example.test/calendar';await addSource(f,other);const prepare=f.env.DB.prepare.bind(f.env.DB),previousWarn=console.warn;let warnings=[];
 f.env.DB.prepare=sql=>{const statement=prepare(sql);if(sql.startsWith('UPDATE calendar_snapshots SET lease_until=')){const bind=statement.bind,first=statement.first;let values=[];statement.bind=function(...args){values=args;return bind.apply(this,args);};statement.first=async function(){if(values[2]===sub)throw Error(privateText);return first.call(this);};}return statement;};console.warn=(...args)=>warnings.push(args);
 try{
  await mocked(google(),async calls=>{await syncCalendars(f.env,week);assert.deepEqual(warnings,[[JSON.stringify({event:'calendar_sync_failed',code:'runtime_error',providerStatus:0})]],'allSettled must not silently swallow a claim rejection or leak its exception text');const healthy=f.sqlite.prepare('SELECT * FROM calendar_snapshots WHERE member_sub=?').get(other);assert.equal(healthy.error_code,null);assert.equal(JSON.parse(healthy.data).length,1);assert.equal(eventReads(calls).length,1);assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM calendar_snapshots WHERE member_sub=? AND lease_until>0').get(sub).n,0);assert.ok(!JSON.stringify(f.sqlite.prepare('SELECT * FROM calendar_snapshots').all()).includes(privateText));});
  f.env.DB.prepare=prepare;warnings=[];await mocked(google(),()=>syncCalendars(f.env,week));const recovered=f.sqlite.prepare('SELECT * FROM calendar_snapshots WHERE member_sub=? AND week_start=?').get(sub,week);assert.ok(recovered.synced_at>0);assert.equal(recovered.error_code,null);assert.equal(JSON.parse(recovered.data).length,1);assert.deepEqual(warnings,[]);
 }finally{f.env.DB.prepare=prepare;console.warn=previousWarn;}
});

test('list-channel activation catches a shared calendar added after discovery but before its pending notification can be trusted',async()=>{
 const f=await fixture(),shared='new-shared@example.test';let added=false,pendingNotices=0,sharedReads=0;
 await mocked(google({
  calendarList:()=>json({items:added?[{id:shared,accessRole:'reader'}]:[]}),
  watch:async(url,options,body)=>{if(url.pathname.endsWith('/calendarList/watch')){added=true;const before=f.connection().change_revision;await calendarWebhook(notification({id:body.id,token:body.token,resource:'opaque-'+body.id}),f.env);assert.equal(f.connection().change_revision,before,'pending exists is not accepted before resource binding');pendingNotices++;}return json({kind:'api#channel',id:body.id,resourceId:'opaque-'+body.id,expiration:Date.now()+7*86400000});},
  events:url=>{const calendar=decodeURIComponent(url.pathname.split('/')[4]);if(calendar==='primary')return json({accessRole:'owner',items:[]});assert.equal(calendar,shared);sharedReads++;return json({accessRole:'reader',items:[{...meeting(week),summary:'New shared reservation'}]});},
 }),async calls=>{
  await syncCalendars(f.env,week);const first=f.sqlite.prepare('SELECT * FROM calendar_snapshots WHERE week_start=?').get(week);assert.equal(pendingNotices,1);assert.equal(sharedReads,0);assert.deepEqual(JSON.parse(first.data),[]);assert.equal(first.change_revision,0);assert.equal(f.connection().change_revision,1,'list activation leaves the discovery gap queued durably');
  await calendarMaintenance(f.env,false);const caughtUp=f.sqlite.prepare('SELECT * FROM calendar_snapshots WHERE week_start=?').get(week);assert.equal(sharedReads,1);assert.equal(caughtUp.change_revision,f.connection().change_revision);const events=JSON.parse(caughtUp.data);assert.equal(events.length,1);assert.equal(events[0].summary,'New shared reservation');assert.match(events[0].calendarKey,/^[a-f0-9]{64}$/);assert.equal(calls.filter(call=>new URL(call.url).pathname.endsWith('/calendarList')).length,2);
});
});

function queueMessage(body){
 const result={acks:0,retries:[]};
 return {body,ack(){result.acks++;},retry(options){result.retries.push(options);},result};
}
const consume=(f,messages)=>createHandler().queue({queue:'fixture-calendar-sync',messages},f.env,{waitUntil(){throw Error('queue work must finish before acknowledgment');}});

test('configured maintenance only enqueues the selected week without reading Google or advancing snapshot success',async()=>{
 const f=await fixture(),sent=[];f.env.CALENDAR_SYNC_QUEUE={async send(body){sent.push(body);}};
 f.sqlite.prepare('INSERT INTO calendar_snapshots(member_sub,week_start,room_revision,connection_version,data,synced_at,retry_at) VALUES(?,?,?,?,?,?,?)').run(sub,week,2,version,JSON.stringify([{summary:'Complete cached reservation'}]),now()-601,now()-1);
 const before=f.sqlite.prepare('SELECT * FROM calendar_snapshots').all();
 await mocked(()=>{throw Error('a producer must not contact Google');},async calls=>{
  await calendarMaintenance(f.env,false);assert.deepEqual(sent,[{week}]);assert.equal(calls.length,0);assert.deepEqual(f.sqlite.prepare('SELECT * FROM calendar_snapshots').all(),before,'queueing does not claim a source or report a successful refresh');
 });
});

test('queued work really commits current data for at most two approved sources and acknowledges after completion',async()=>{
 const f=await fixture(),sent=[],batches=[];await addSource(f,'member-2');await addSource(f,'member-3');f.env.CALENDAR_SYNC_QUEUE={async send(body){sent.push(body);},async sendBatch(messages){batches.push(messages);sent.push(...messages.map(message=>message.body));}};
 await mocked(google({title:'Queued fresh reservation'}),async calls=>{
  await calendarMaintenance(f.env,false);assert.equal(calls.length,0);assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM calendar_snapshots').get().n,0);assert.deepEqual(batches,[[{body:{week}},{body:{week}}]],'three eligible sources are split into two small CPU-isolated jobs');
  const message=queueMessage(sent[0]);await consume(f,[message]);assert.deepEqual(message.result,{acks:1,retries:[]});
  const completed=f.sqlite.prepare('SELECT * FROM calendar_snapshots').all();assert.equal(completed.length,2);assert.ok(completed.every(row=>row.synced_at>0&&row.lease_until===0&&row.error_code===null&&JSON.parse(row.data)[0].summary==='Queued fresh reservation'));
  assert.equal(calls.filter(call=>new URL(call.url).hostname==='oauth2.googleapis.com').length,2);assert.equal(eventReads(calls).length,2);
 });
});

test('queue delivery rechecks approval and connection state changed since enqueue without sharing revoked data',async()=>{
 for(const change of ["UPDATE members SET status='rejected' WHERE sub='member'","UPDATE calendar_connections SET status='reauthorize' WHERE member_sub='member'","DELETE FROM calendar_connections WHERE member_sub='member'"]){
  const f=await fixture(),sent=[];f.env.CALENDAR_SYNC_QUEUE={async send(body){sent.push(body);}};await calendarMaintenance(f.env,false);f.sqlite.exec(change);
  await mocked(()=>{throw Error('a revoked source must not contact Google');},async calls=>{const message=queueMessage(sent[0]);await consume(f,[message]);assert.deepEqual(message.result,{acks:1,retries:[]});assert.equal(calls.length,0);assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM calendar_snapshots').get().n,0);});
 }
});

test('a queued week uses the latest connection version rather than the grant present when it was enqueued',async()=>{
 const f=await fixture(),sent=[];f.env.CALENDAR_SYNC_QUEUE={async send(body){sent.push(body);}};await calendarMaintenance(f.env,false);
 f.sqlite.prepare('UPDATE calendar_connections SET version=?,refresh_cipher=? WHERE member_sub=?').run('new-connection',await sealToken(f.env,sub,'new-fixture-refresh'),sub);
 await mocked(google(),async calls=>{const message=queueMessage(sent[0]);await consume(f,[message]);assert.deepEqual(message.result,{acks:1,retries:[]});const token=calls.find(call=>new URL(call.url).hostname==='oauth2.googleapis.com');assert.equal(new URLSearchParams(token.options.body).get('refresh_token'),'new-fixture-refresh');assert.equal(f.sqlite.prepare('SELECT connection_version FROM calendar_snapshots').get().connection_version,'new-connection');});
});

test('concurrent and repeated queue deliveries cannot overlap a source lease or refresh a completed unchanged snapshot',async()=>{
 const f=await fixture(),realNow=Date.now;let clock=realNow(),block=false,release,reached;const gate=new Promise(resolve=>release=resolve),entered=new Promise(resolve=>reached=resolve),provider=google();Date.now=()=>clock;
 try{
  await mocked(async(url,options,calls)=>{if(block&&url.hostname==='oauth2.googleapis.com'){reached();await gate;}return provider(url,options,calls);},async calls=>{
   await syncCalendars(f.env,week);await syncCalendars(f.env,week);clock+=601000;const count=calls.length;block=true;
   const first=queueMessage({week}),duplicate=queueMessage({week}),pending=consume(f,[first]);await entered;await consume(f,[duplicate]);assert.deepEqual(duplicate.result,{acks:1,retries:[]});assert.equal(calls.length,count+1,'the second delivery does not perform provider work while a source lease is owned');assert.equal(first.result.acks,0);
   release();await pending;assert.deepEqual(first.result,{acks:1,retries:[]});const complete=f.sqlite.prepare('SELECT * FROM calendar_snapshots').get(),finishedCalls=calls.length;
   const repeated=queueMessage({week});await consume(f,[repeated]);assert.deepEqual(repeated.result,{acks:1,retries:[]});assert.equal(calls.length,finishedCalls);assert.deepEqual(f.sqlite.prepare('SELECT * FROM calendar_snapshots').get(),complete,'repeated delivery cannot advance success without an eligible refresh');
  });
 }finally{Date.now=realNow;release();}
});

test('malformed and expired queue weeks are acknowledged without database or Google work',async()=>{
 const f=await fixture(),offset=days=>new Date(Date.parse(week+'T00:00:00Z')+days*86400000).toISOString().slice(0,10),inherited=Object.create({week}),getter={};Object.defineProperty(getter,'week',{enumerable:true,get(){throw Error('queue validation must not invoke accessors');}});
 const invalid=[null,[],week,{},new Date(),{week:1},{week:'2026-02-30'},{week:offset(1)},{week:offset(-63)},{week:offset(63)},{week,extra:'private-value'},{week,manual:'true'},{week,manual:null},{week,manual:undefined},inherited,getter];
 f.env.DB={prepare(){throw Error('invalid queue work must not reach the database');}};
 await mocked(()=>{throw Error('invalid queue work must not contact Google');},async calls=>{const messages=invalid.map(queueMessage);await consume(f,messages);assert.equal(calls.length,0);for(const message of messages)assert.deepEqual(message.result,{acks:1,retries:[]});});
});

test('uncaught queue work failure retries after 180 seconds with a fixed diagnostic and no private exception',async()=>{
 const f=await fixture(),privateText='private-person@example.test private-office private-token https://private.example.test/calendar',warnings=[],previousWarn=console.warn;f.env.DB={prepare(){throw Error(privateText);}};console.warn=(...args)=>warnings.push(args);
 try{await mocked(()=>{throw Error('database failure happens before Google');},async calls=>{const message=queueMessage({week});await consume(f,[message]);assert.deepEqual(message.result,{acks:0,retries:[{delaySeconds:180}]});assert.equal(calls.length,0);assert.deepEqual(warnings,[[JSON.stringify({event:'calendar_queue_failed',code:'runtime_error'})]]);assert.ok(!JSON.stringify(warnings).includes(privateText));});}finally{console.warn=previousWarn;}
});

test('an enqueue failure preserves due data and emits only a safe category for the next cron attempt',async()=>{
 const f=await fixture(),privateText='private-queue-token private-person@example.test',warnings=[],previousWarn=console.warn;console.warn=(...args)=>warnings.push(args);f.env.CALENDAR_SYNC_QUEUE={async send(){throw Error(privateText);}};
 try{await mocked(()=>{throw Error('a failed producer must not contact Google');},async calls=>{await assert.rejects(calendarMaintenance(f.env,false),{message:'Calendar queue enqueue failed'});assert.equal(calls.length,0);assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM calendar_snapshots').get().n,0);assert.deepEqual(warnings,[[JSON.stringify({event:'calendar_queue_failed',code:'send_failed'})]]);assert.ok(!JSON.stringify(warnings).includes(privateText));});}finally{console.warn=previousWarn;}
});

test('initial feed enqueues due work while cached and freshly completed feeds never send empty queue jobs',async()=>{
 const f=await fixture(),cookie=await f.login(),sent=[];f.env.CALENDAR_SYNC_QUEUE={async send(body){sent.push(body);}};
 await mocked(google(),async calls=>{
  const initial=await (await f.get('calendar/feed?day='+week,cookie)).json();assert.equal(initial.syncQueued,true);assert.equal(initial.sources[0].state,'waiting');assert.equal(initial.sources[0].syncedAt,null);assert.deepEqual(sent,[{week}]);assert.equal(calls.length,0);
  const cached=await (await f.get('calendar/feed?day='+week+'&cached=1',cookie)).json();assert.equal(cached.syncQueued,false);assert.equal(sent.length,1);assert.equal(calls.length,0);
  await consume(f,[queueMessage(sent[0])]);await consume(f,[queueMessage(sent[0])]);const complete=f.sqlite.prepare('SELECT * FROM calendar_snapshots').get(),count=calls.length;
  const fresh=await (await f.get('calendar/feed?day='+week,cookie)).json();assert.equal(fresh.syncQueued,false);assert.equal(fresh.sources[0].state,'ready');assert.equal(fresh.sources[0].syncedAt,complete.synced_at);assert.equal(sent.length,1);assert.equal(calls.length,count);
 });
});

test('first regular feed for a new future week schedules all six sources immediately rather than leaving four uninitialized',async()=>{
 const f=await fixture(),cookie=await f.login(),members=[sub,...Array.from({length:5},(_,i)=>'future-member-'+i)],batches=[];for(const member of members.slice(1))await addSource(f,member);
 f.env.CALENDAR_SYNC_QUEUE={async send(){throw Error('six due sources require a batch');},async sendBatch(messages){batches.push(messages);}};
 await mocked(google({title:'All-source future reservation'}),async calls=>{
  const response=await f.get('calendar/feed?day='+nextWeek,cookie),data=await response.json();assert.equal(response.status,200);assert.equal(data.syncQueued,true);assert.equal(calls.length,0);assert.ok(data.sources.every(source=>source.state==='waiting'&&source.syncedAt===null));assert.deepEqual(batches,[Array.from({length:3},()=>({body:{week:nextWeek}}))]);const waiting=f.sqlite.prepare('SELECT * FROM calendar_snapshots').all();assert.equal(waiting.length,6);assert.ok(waiting.every(row=>row.synced_at===0&&row.lease_until===0&&row.data==='[]'),'requested weeks are durable empty waiting rows, never successful snapshots');
  for(const entry of batches[0]){const message=queueMessage(entry.body);await consume(f,[message]);assert.deepEqual(message.result,{acks:1,retries:[]});}
  const completed=f.sqlite.prepare('SELECT * FROM calendar_snapshots WHERE week_start=?').all(nextWeek);assert.equal(completed.length,6);assert.ok(completed.every(row=>row.synced_at>0&&row.lease_until===0&&row.error_code===null&&JSON.parse(row.data)[0].summary==='All-source future reservation'));assert.equal(calls.filter(call=>new URL(call.url).hostname==='oauth2.googleapis.com').length,6);
  const cached=await (await f.get('calendar/feed?day='+nextWeek+'&cached=1',cookie)).json();assert.equal(cached.syncQueued,false);assert.ok(cached.sources.every(source=>source.state==='ready'));assert.equal(batches.length,1);
 });
});

test('manual HTTP sync batches enough two-source jobs for six members without faking completion and retains the thirty-second cooldown',async()=>{
 const f=await fixture(),cookie=await f.login(),members=[sub,...Array.from({length:5},(_,i)=>'manual-member-'+i)],batches=[];for(const member of members.slice(1))await addSource(f,member);
 await mocked(google({title:'Real queued refresh'}),async calls=>{
  await syncCalendars(f.env,week);await syncCalendars(f.env,week);f.sqlite.prepare('UPDATE calendar_snapshots SET synced_at=?,retry_at=?').run(now()-60,now()+540);const before=f.sqlite.prepare('SELECT * FROM calendar_snapshots ORDER BY member_sub').all(),count=calls.length;
  f.env.CALENDAR_SYNC_QUEUE={async send(){throw Error('manual sync must use one batch send');},async sendBatch(messages){batches.push(messages);}};
  const response=await f.post('calendar/sync',{day:week},cookie),data=await response.json();assert.equal(response.status,200);assert.equal(data.syncQueued,true);assert.equal(calls.length,count);assert.deepEqual(batches,[Array.from({length:3},()=>({body:{week,manual:true}}))]);assert.deepEqual(f.sqlite.prepare('SELECT * FROM calendar_snapshots ORDER BY member_sub').all(),before);assert.ok(data.sources.every(source=>source.syncedAt===before[0].synced_at));
  for(const entry of batches[0]){const message=queueMessage(entry.body);await consume(f,[message]);assert.deepEqual(message.result,{acks:1,retries:[]});}
  const completed=f.sqlite.prepare('SELECT * FROM calendar_snapshots ORDER BY member_sub').all();assert.equal(completed.length,6);assert.ok(completed.every(row=>row.synced_at>before[0].synced_at&&row.error_code===null&&row.lease_until===0));assert.equal(calls.slice(count).filter(call=>new URL(call.url).hostname==='oauth2.googleapis.com').length,6,'manual requests visit all six sources, rather than only the first two');
  const repeated=await (await f.post('calendar/sync',{day:week},cookie)).json(),finishedCalls=calls.length;assert.equal(repeated.syncQueued,false);assert.equal(batches.length,1,'the server also coalesces duplicate taps before any queue write');assert.equal(calls.length,finishedCalls);assert.deepEqual(f.sqlite.prepare('SELECT * FROM calendar_snapshots ORDER BY member_sub').all(),completed,'duplicate taps inside thirty seconds never rewrite a fresh snapshot');
 });
});

test('manual enqueue counts only approved connected members and sends at most one hundred small jobs',async()=>{
 const realNow=Date.now;let clock=realNow();Date.now=()=>clock;
 try{
 const f=await fixture(),batches=[];await addSource(f,'eligible-member');await addSource(f,'rejected-member');await addSource(f,'reauthorize-member');f.sqlite.exec("UPDATE members SET status='rejected' WHERE sub='rejected-member'; UPDATE calendar_connections SET status='reauthorize' WHERE member_sub='reauthorize-member';");
 f.env.CALENDAR_SYNC_QUEUE={async sendBatch(messages){batches.push(messages);}};assert.equal(await enqueueCalendarSync(f.env,week,true),true);assert.deepEqual(batches,[ [{body:{week,manual:true}}] ],'only two approved connected members require one job');batches.length=0;
 for(let i=0;i<203;i++){
  const member='count-member-'+i;f.sqlite.prepare("INSERT INTO members(sub,email,name,role,status,requested_at) VALUES(?,?,'Fixture','member',?,1)").run(member,member+'@example.test',i===201?'rejected':'approved');f.sqlite.prepare("INSERT INTO calendar_connections(member_sub,refresh_cipher,version,status,updated_at,shared_calendars) VALUES(?,'unread-fixture-cipher','version-1',?,1,1)").run(member,i===202?'reauthorize':'connected');
 }
 clock+=31000;await mocked(()=>{throw Error('enqueue does not read credentials or Google');},async calls=>{assert.equal(await enqueueCalendarSync(f.env,week,true),true);assert.equal(calls.length,0);assert.equal(batches.length,1);assert.equal(batches[0].length,100);assert.ok(batches[0].every(message=>JSON.stringify(message)==JSON.stringify({body:{week,manual:true}})));assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM calendar_snapshots').get().n,0);});
 }finally{Date.now=realNow;}
});

test('OAuth grant completion queues a regular refresh and returns before reading any calendar activities',async()=>{
 const f=await fixture(),cookie=await f.login(),sent=[];f.env.CALENDAR_SYNC_QUEUE={async send(body){sent.push(body);}};const start=await (await f.post('calendar/authorize',{},cookie)).json(),state=new URL(start.url).searchParams.get('state'),provider=google();
 await mocked((url,options,calls)=>url.hostname==='oauth2.googleapis.com'&&new URLSearchParams(options.body).get('grant_type')==='authorization_code'?json({access_token:'fixture-access',refresh_token:'new-fixture-grant',id_token:JSON.stringify({sub}),scope:scopes}):provider(url,options,calls),async calls=>{
  const response=await f.get('calendar/callback?state='+encodeURIComponent(state)+'&code=fixture-code',cookie);assert.equal(response.status,303);assert.ok(response.headers.get('Location').endsWith('?calendar=connected'));assert.deepEqual(sent,[{week}]);assert.equal(calls.length,1,'only the authorized code exchange runs in the HTTP callback');assert.equal(eventReads(calls).length,0);const waiting=f.sqlite.prepare('SELECT * FROM calendar_snapshots').all();assert.equal(waiting.length,1);assert.ok(waiting.every(row=>row.synced_at===0&&row.lease_until===0&&row.data==='[]'),'successful authorization still does not claim a completed calendar sync');
  const message=queueMessage(sent[0]);await consume(f,[message]);assert.deepEqual(message.result,{acks:1,retries:[]});assert.ok(f.sqlite.prepare('SELECT synced_at FROM calendar_snapshots').get().synced_at>0);assert.equal(eventReads(calls).length,1);
 });
});

test('regular queue messages accept false and null-prototype records but preserve the backend ten-minute retry gate',async()=>{
 const f=await fixture();await mocked(google(),async calls=>{await syncCalendars(f.env,week);await syncCalendars(f.env,week);const count=calls.length,bodies=[{week,manual:false},Object.assign(Object.create(null),{week})];for(const body of bodies){const message=queueMessage(body);await consume(f,[message]);assert.deepEqual(message.result,{acks:1,retries:[]});}assert.equal(calls.length,count);});
});

test('a future feed blocked by the current-week lease remains durable waiting work and runs after expiry without another HTTP visit',async()=>{
 const f=await fixture(),cookie=await f.login(),realNow=Date.now;let clock=realNow();Date.now=()=>clock;const sent=[];f.env.CALENDAR_SYNC_QUEUE={async send(body){sent.push(body);}};
 try{
  f.sqlite.prepare('INSERT INTO calendar_snapshots(member_sub,week_start,room_revision,connection_version,data,synced_at,retry_at,lease_id,lease_until) VALUES(?,?,?,?,?,?,?,?,?)').run(sub,week,2,version,JSON.stringify([{summary:'Current-week complete reservation'}]),now(),now()+600,'current-lease',now()+180);
  await mocked(google({title:'Recovered future reservation'}),async calls=>{
   const feed=await (await f.get('calendar/feed?day='+nextWeek,cookie)).json();assert.equal(feed.syncQueued,false);assert.equal(feed.sources[0].state,'waiting');assert.equal(feed.sources[0].syncedAt,null);assert.equal(calls.length,0);assert.deepEqual(sent,[]);const waiting=f.sqlite.prepare('SELECT * FROM calendar_snapshots WHERE week_start=?').get(nextWeek);assert.equal(waiting.data,'[]');assert.equal(waiting.synced_at,0);assert.equal(waiting.lease_until,0);
   clock+=181000;await calendarMaintenance(f.env,false);assert.deepEqual(sent,[{week:nextWeek}]);assert.equal(calls.length,0,'cron still only enqueues after ownership expires');const message=queueMessage(sent[0]);await consume(f,[message]);assert.deepEqual(message.result,{acks:1,retries:[]});const fresh=f.sqlite.prepare('SELECT * FROM calendar_snapshots WHERE week_start=?').get(nextWeek);assert.ok(fresh.synced_at>0);assert.equal(fresh.error_code,null);assert.equal(JSON.parse(fresh.data)[0].summary,'Recovered future reservation');
  });
 }finally{Date.now=realNow;}
});

test('a manual queue job blocked by another-week lease retries rather than acknowledging only a partial refresh',async()=>{
 const f=await fixture(),other='unblocked-manual-member';await addSource(f,other);const realNow=Date.now;let clock=realNow();Date.now=()=>clock;
 try{
  const old=now()-601;for(const member of [sub,other])f.sqlite.prepare('INSERT INTO calendar_snapshots(member_sub,week_start,room_revision,connection_version,data,synced_at,retry_at) VALUES(?,?,?,?,?,?,?)').run(member,nextWeek,2,version,JSON.stringify([{summary:'Original future reservation'}]),old,now()-1);
  f.sqlite.prepare('INSERT INTO calendar_snapshots(member_sub,week_start,room_revision,connection_version,data,synced_at,retry_at,lease_id,lease_until) VALUES(?,?,?,?,?,?,?,?,?)').run(sub,week,2,version,'[]',now(),now()+600,'other-week-owner',now()+180);const before=f.sqlite.prepare('SELECT * FROM calendar_snapshots ORDER BY member_sub,week_start').all();
  await mocked(google({title:'Complete manual future reservation'}),async calls=>{
   const message=queueMessage({week:nextWeek,manual:true});await consume(f,[message]);assert.deepEqual(message.result,{acks:0,retries:[{delaySeconds:180}]});assert.equal(calls.length,0);assert.deepEqual(f.sqlite.prepare('SELECT * FROM calendar_snapshots ORDER BY member_sub,week_start').all(),before,'even the unblocked account waits so the manual request remains intact');
   clock+=181000;const retried=queueMessage(message.body);await consume(f,[retried]);assert.deepEqual(retried.result,{acks:1,retries:[]});const completed=f.sqlite.prepare('SELECT * FROM calendar_snapshots WHERE week_start=?').all(nextWeek);assert.equal(completed.length,2);assert.ok(completed.every(row=>row.synced_at>old&&row.error_code===null&&JSON.parse(row.data)[0].summary==='Complete manual future reservation'));assert.equal(calls.filter(call=>new URL(call.url).hostname==='oauth2.googleapis.com').length,2);
  });
 }finally{Date.now=realNow;}
});

test('ten concurrent requests for the same week share one server admission across manual and regular feeds',async()=>{
 for(const manual of [true,false]){
  const f=await fixture(),cookie=await f.login(),sends=[],batches=[];
  if(manual)for(let i=0;i<5;i++)await addSource(f,'concurrent-member-'+i);
  f.env.CALENDAR_SYNC_QUEUE={async send(body){sends.push(body);},async sendBatch(messages){batches.push(messages);}};
  await mocked(()=>{throw Error('admission must not perform provider work');},async calls=>{
   const responses=await Promise.all(Array.from({length:10},()=>manual?f.post('calendar/sync',{day:nextWeek},cookie):f.get('calendar/feed?day='+nextWeek,cookie)));
   const data=await Promise.all(responses.map(response=>{assert.equal(response.status,200);return response.json();}));
   assert.equal(data.filter(item=>item.syncQueued).length,1,'only the atomic admission winner reports a new queue send');
   assert.equal(calls.length,0);assert.equal(sends.length+batches.length,1);
   if(manual)assert.deepEqual(batches,[Array.from({length:3},()=>({body:{week:nextWeek,manual:true}}))]);else assert.deepEqual(sends,[{week:nextWeek}]);
   assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM calendar_snapshots WHERE synced_at>0 OR lease_until>0').get().n,0,'coalescing only saves empty waiting rows');
   assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM calendar_enqueue_gates').get().n,1);
  });
 }
});

test('manual admission upgrades a regular job once, with exact thirty-second and three-minute recovery boundaries',async()=>{
 const realNow=Date.now;let clock=Date.parse(week+'T12:00:00+08:00');Date.now=()=>clock;
 try{
  const f=await fixture(),sent=[],batches=[];f.env.CALENDAR_SYNC_QUEUE={async send(body){sent.push(body);},async sendBatch(messages){batches.push(messages);}};
  await mocked(()=>{throw Error('enqueue boundaries do not read Google');},async calls=>{
   const start=now();assert.equal(await enqueueCalendarSync(f.env,week,false,true),true);assert.equal(await enqueueCalendarSync(f.env,week,true,true),true,'a requested all-source refresh can upgrade one regular job');
   assert.equal(await enqueueCalendarSync(f.env,week,true,true),false);assert.equal(await enqueueCalendarSync(f.env,week,false,true),false);
   clock+=29000;assert.equal(await enqueueCalendarSync(f.env,week,true,true),false);clock+=1000;assert.equal(await enqueueCalendarSync(f.env,week,true,true),true);
   let gate=f.sqlite.prepare('SELECT * FROM calendar_enqueue_gates').get();assert.equal(gate.regular_until,start+210);assert.equal(gate.manual_until,start+60);
   clock=Date.parse(week+'T12:00:00+08:00')+209000;assert.equal(await enqueueCalendarSync(f.env,week,false,true),false);clock+=1000;assert.equal(await enqueueCalendarSync(f.env,week,false,true),true);
   gate=f.sqlite.prepare('SELECT * FROM calendar_enqueue_gates').get();assert.equal(gate.regular_until,start+390);assert.equal(gate.manual_until,start+60,'regular work cannot erase the independent manual cooldown');
   assert.equal(sent.length,2);assert.equal(batches.length,2);assert.equal(calls.length,0);assert.equal(f.sqlite.prepare('SELECT synced_at FROM calendar_snapshots').get().synced_at,0);
  });
 }finally{Date.now=realNow;}
});

test('an accepted send with a lost response stays reserved and is rebuilt from waiting data after expiry',async()=>{
 const realNow=Date.now;let clock=Date.parse(week+'T12:00:00+08:00'),uncertain=true;Date.now=()=>clock;
 const warnings=[],previousWarn=console.warn;console.warn=(...args)=>warnings.push(args);
 try{
  const f=await fixture(),cookie=await f.login(),sent=[];
  f.sqlite.exec('UPDATE calendar_connections SET change_revision=4');f.sqlite.prepare('INSERT INTO calendar_snapshots(member_sub,week_start,room_revision,connection_version,data,synced_at,retry_at,change_revision,attempt_revision) VALUES(?,?,?,?,?,?,?,?,?)').run(sub,week,2,version,'[]',now(),now()+600,4,4);
  f.env.CALENDAR_SYNC_QUEUE={async send(body){sent.push(body);if(uncertain)throw Error('private queue response was lost after acceptance');}};
  await mocked(google({title:'Recovered accepted job'}),async calls=>{
   const response=await f.get('calendar/feed?day='+nextWeek,cookie);assert.equal(response.status,503);const gate=f.sqlite.prepare('SELECT * FROM calendar_enqueue_gates WHERE week_start=?').get(nextWeek),waiting=f.sqlite.prepare('SELECT * FROM calendar_snapshots WHERE week_start=?').get(nextWeek);
   assert.equal(gate.regular_until,now()+180);assert.equal(waiting.synced_at,0);assert.equal(waiting.change_revision,0);assert.equal(waiting.attempt_revision,0);assert.equal(waiting.lease_until,0);assert.equal(f.connection().change_revision,4,'enqueue failure cannot acknowledge the outstanding source generation');
   uncertain=false;for(let i=0;i<10;i++)assert.equal((await (await f.get('calendar/feed?day='+nextWeek,cookie)).json()).syncQueued,false);
   clock+=179000;await calendarMaintenance(f.env,false);assert.equal(sent.length,1);assert.equal(calls.length,0);assert.deepEqual(f.sqlite.prepare('SELECT * FROM calendar_snapshots WHERE week_start=?').get(nextWeek),waiting,'an uncertain send cannot pretend to have completed or acknowledged changes');
   clock+=2000;await calendarMaintenance(f.env,false);assert.deepEqual(sent,[{week:nextWeek},{week:nextWeek}]);assert.equal(calls.length,0);
   const message=queueMessage(sent[1]);await consume(f,[message]);assert.deepEqual(message.result,{acks:1,retries:[]});const complete=f.sqlite.prepare('SELECT * FROM calendar_snapshots WHERE week_start=?').get(nextWeek);assert.ok(complete.synced_at>0);assert.equal(complete.error_code,null);assert.equal(JSON.parse(complete.data)[0].summary,'Recovered accepted job');assert.equal(complete.change_revision,4);assert.equal(complete.attempt_revision,4);assert.equal(f.connection().change_revision,5,'new list-bootstrap changes remain pending beyond the captured successful generation');
   assert.deepEqual(warnings,[[JSON.stringify({event:'calendar_queue_failed',code:'send_failed'})]],'the uncertain result logs no raw queue exception');
  });
 }finally{Date.now=realNow;console.warn=previousWarn;}
});

test('a killed consumer with an active source lease and admission gate recovers after both expire',async()=>{
 const realNow=Date.now;let clock=Date.parse(week+'T12:00:00+08:00');Date.now=()=>clock;
 try{
  const f=await fixture(),sent=[],old=now()-601;f.env.CALENDAR_SYNC_QUEUE={async send(body){sent.push(body);}};
  f.sqlite.prepare('INSERT INTO calendar_snapshots(member_sub,week_start,room_revision,connection_version,data,synced_at,retry_at,lease_id,lease_until,change_revision,attempt_revision) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(sub,week,2,version,JSON.stringify([{summary:'Last complete cache'}]),old,now()-1,'killed-consumer',now()+180,0,1);
  f.sqlite.exec('UPDATE calendar_connections SET change_revision=1');f.sqlite.prepare('INSERT INTO calendar_enqueue_gates(week_start,regular_until,manual_until) VALUES(?,?,?)').run(week,now()+180,0);
  const before=f.sqlite.prepare('SELECT * FROM calendar_snapshots').get();
  await mocked(google({title:'Recovered killed consumer'}),async calls=>{
   await calendarMaintenance(f.env,false);clock+=179000;await calendarMaintenance(f.env,false);assert.deepEqual(sent,[]);assert.equal(calls.length,0);assert.deepEqual(f.sqlite.prepare('SELECT * FROM calendar_snapshots').get(),before,'hard termination leaves the prior success and generation unchanged');
   clock+=2000;await calendarMaintenance(f.env,false);assert.deepEqual(sent,[{week}]);assert.equal(calls.length,0);const message=queueMessage(sent[0]);await consume(f,[message]);assert.deepEqual(message.result,{acks:1,retries:[]});
   const complete=f.sqlite.prepare('SELECT * FROM calendar_snapshots').get();assert.ok(complete.synced_at>old);assert.equal(complete.lease_until,0);assert.equal(complete.error_code,null);assert.equal(complete.change_revision,1);assert.equal(complete.attempt_revision,1);assert.equal(JSON.parse(complete.data)[0].summary,'Recovered killed consumer');
  });
 }finally{Date.now=realNow;}
});

test('a still-gated oldest week does not block a different eligible week in minute maintenance',async()=>{
 const f=await fixture(),sent=[];f.env.CALENDAR_SYNC_QUEUE={async send(body){sent.push(body);}};
 for(const [day,retry] of [[week,0],[nextWeek,1]])f.sqlite.prepare('INSERT INTO calendar_snapshots(member_sub,week_start,room_revision,connection_version,data,synced_at,retry_at) VALUES(?,?,?,?,?,?,?)').run(sub,day,2,version,'[]',now()-601,retry);
 f.sqlite.prepare('INSERT INTO calendar_enqueue_gates(week_start,regular_until,manual_until) VALUES(?,?,?)').run(week,now()+180,0);const before=f.sqlite.prepare('SELECT * FROM calendar_snapshots ORDER BY week_start').all();
 await mocked(()=>{throw Error('maintenance cannot contact Google');},async calls=>{await calendarMaintenance(f.env,false);assert.deepEqual(sent,[{week:nextWeek}]);assert.equal(calls.length,0);assert.deepEqual(f.sqlite.prepare('SELECT * FROM calendar_snapshots ORDER BY week_start').all(),before);});
});

test('sixty queued minute ticks handle thirty simultaneously due caches and rebuild one lost job within the freshness deadline',async()=>{
 const realNow=Date.now;let clock=Date.parse(week+'T12:00:00+08:00')+86400000;Date.now=()=>clock;
 try{
  const f=await fixture(),members=[sub,...Array.from({length:5},(_,i)=>'rotation-member-'+i)],weeks=Array.from({length:5},(_,i)=>new Date(Date.parse(week+'T00:00:00Z')+i*7*86400000).toISOString().slice(0,10)),pending=[],jobs=[];
  for(const member of members.slice(1))await addSource(f,member);
  await mocked(google({title:'Live rotating reservation'}),async calls=>{
   // All thirty caches finish at the same time, as after a manual refresh.
   // At minute ten they all become due together; this must not go stale while
   // the producer safely splits one selected week's work into small jobs.
   for(const day of weeks)await syncCalendars(f.env,day);await syncCalendars(f.env,week);
   const started=now();assert.equal(f.sqlite.prepare('SELECT COUNT(DISTINCT synced_at) AS n FROM calendar_snapshots').get().n,1);
   const record=body=>{pending.push(body);jobs.push({body,time:now()});};f.env.CALENDAR_SYNC_QUEUE={async send(body){record(body);},async sendBatch(messages){messages.forEach(message=>record(message.body));}};
   let lost=null,recovered=false,processed=0;
   for(let tick=0;tick<60;tick++){
    const before=jobs.length;await calendarMaintenance(f.env,tick%10===0);assert.ok(jobs.length-before<=3,'one minute sends at most three small CPU-isolated jobs');
    for(const body of pending.splice(0)){
     if(tick===10&&!lost){lost={body,time:now()};continue;}
     const readCount=calls.length,message=queueMessage(body);await consume(f,[message]);assert.deepEqual(message.result,{acks:1,retries:[]});
     const refreshes=calls.slice(readCount).filter(call=>new URL(call.url).hostname==='oauth2.googleapis.com');assert.ok(refreshes.length<=2,'each consumer keeps its source allowance');assert.ok(eventReads(calls.slice(readCount)).every(call=>new URL(call.url).searchParams.get('timeMin').slice(0,10)===body.week));processed++;
     if(lost&&body.week===lost.body.week&&now()-lost.time>=180)recovered=true;
    }
    const rows=f.sqlite.prepare('SELECT * FROM calendar_snapshots').all();assert.equal(rows.length,30);assert.ok(rows.every(row=>row.synced_at>0&&now()-row.synced_at<=1200&&row.error_code===null&&row.lease_until===0),'every visible source/week stays within the existing twenty-minute freshness deadline at minute '+tick);
    assert.ok(rows.every(row=>row.change_revision===f.sqlite.prepare('SELECT change_revision FROM calendar_connections WHERE member_sub=?').get(row.member_sub).change_revision));clock+=60000;
   }
   assert.ok(lost,'the test really discards a sent job without acknowledgment');assert.ok(recovered,'durable due data rebuilds the lost week after the gate expires');assert.ok(processed>=30,'the queue really executes multiple refresh cycles');assert.ok(f.sqlite.prepare('SELECT MIN(synced_at) AS oldest FROM calendar_snapshots').get().oldest>started);assert.ok(jobs.some(job=>job.body.week===lost.body.week&&job.time>=lost.time+180));
  });
 }finally{Date.now=realNow;}
});
