import {cleanupCalendarWatches,ensureCalendarWatches,pruneCalendarWatches} from './calendar-watch.ts';
type CalendarMember={sub:string;email:string;status:string;role:string};
type IdentityVerifier=(credential:string,clientId:string,nonce:string)=>Promise<{sub:string}>;
type Room={location:string;revision:number};
type Connection={member_sub:string;refresh_cipher:string;version:string;status:string;shared_calendars:number;change_revision:number};
type Snapshot={data:string;synced_at:number;retry_at:number;error_code:string|null};
type EventRecord=Record<string,any>;
export class CalendarError extends Error {status:number;providerStatus:number;constructor(status:number,message:string,providerStatus=0){super(message);this.status=status;this.providerStatus=providerStatus;}}
// Logs contain only a fixed category and a validated HTTP status. Never include
// provider bodies, request URLs, member identities, or exception text.
function syncFailureDiagnostic(error:unknown){
  let code='runtime_error',providerStatus=0;
  if(error instanceof CalendarError){
    const known:Record<string,string>={REAUTHORIZE:'reauthorize',TOKEN_RESPONSE:'token_response',CALENDAR_LIST_RESPONSE:'calendar_list_response',NO_DETAILS:'no_details',EVENT_RESPONSE:'event_response',SOURCE_LIMIT:'source_limit'};
    providerStatus=Number.isInteger(error.providerStatus)&&error.providerStatus>=100&&error.providerStatus<=599?error.providerStatus:0;
    code=Object.prototype.hasOwnProperty.call(known,error.message)?known[error.message]:(providerStatus?'provider_http':'provider_response');
  }else if(error instanceof Error){
    if(error.name==='TimeoutError')code='timeout';
    else if(error.name==='AbortError')code='aborted';
    else if(error.name==='TypeError')code='network_or_runtime_type';
  }
  console.warn(JSON.stringify({event:'calendar_sync_failed',code,providerStatus}));
}
const second=()=>Math.floor(Date.now()/1000);
const syncInterval=10*60,manualCooldown=30;
const readonly='https://www.googleapis.com/auth/calendar.events.readonly';
const legacyReadonly='https://www.googleapis.com/auth/calendar.readonly';
const listReadonly='https://www.googleapis.com/auth/calendar.calendarlist.readonly';
const canReadEvents=(scope:unknown)=>typeof scope==='string'&&scope.split(/\s+/).some(value=>value===readonly||value===legacyReadonly);
const canListCalendars=(scope:unknown)=>typeof scope==='string'&&scope.split(/\s+/).some(value=>value===listReadonly||value===legacyReadonly);
const callbackPath='/roomly/api/calendar/callback';
const random=()=>crypto.randomUUID()+crypto.randomUUID();
async function digest(value:string){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))),v=>v.toString(16).padStart(2,'0')).join('');}
const session=(request:Request)=>(request.headers.get('Cookie')||'').split(';').map(p=>p.trim()).find(p=>p.startsWith('roomly_session='))?.slice(15)||'';
const reply=(data:object,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Cross-Origin-Opener-Policy':'same-origin-allow-popups'}});
const redirect=(env:Env,result:string)=>new Response(null,{status:303,headers:{Location:env.APP_ORIGIN+'/roomly/?calendar='+result,'Cache-Control':'no-store','Referrer-Policy':'no-referrer'}});
export function calendarReady(env:Env){return !!env.GOOGLE_CLIENT_SECRET&&/^[a-f0-9]{64}$/i.test(env.CALENDAR_TOKEN_KEY||'');}
function requireSetup(env:Env){if(!calendarReady(env))throw new CalendarError(503,'管理員尚未完成共用日曆的後端授權設定。');}
async function tokenKey(env:Env){requireSetup(env);const bytes=new Uint8Array((env.CALENDAR_TOKEN_KEY!.match(/../g)||[]).map(v=>parseInt(v,16)));return crypto.subtle.importKey('raw',bytes,'AES-GCM',false,['encrypt','decrypt']);}
export async function sealToken(env:Env,sub:string,token:string){const iv=crypto.getRandomValues(new Uint8Array(12));const cipher=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:new TextEncoder().encode(sub)},await tokenKey(env),new TextEncoder().encode(token));return JSON.stringify([Array.from(iv),Array.from(new Uint8Array(cipher))]);}
export async function openToken(env:Env,sub:string,cipher:string){const [iv,data]=JSON.parse(cipher);return new TextDecoder().decode(await crypto.subtle.decrypt({name:'AES-GCM',iv:new Uint8Array(iv),additionalData:new TextEncoder().encode(sub)},await tokenKey(env),new Uint8Array(data)));}
const normalize=(value:unknown)=>String(value||'').normalize('NFKC').replace(/\s+/gu,'').toLocaleLowerCase();
function normalizedRoomMatch(event:EventRecord,name:string){if(!name)return false;const resources=(event.attendees||[]).filter((a:EventRecord)=>a.resource&&normalize(a.displayName).includes(name));if(resources.length)return resources.some((a:EventRecord)=>a.responseStatus!=='declined');return normalize(event.location).includes(name);}
export function roomMatch(event:EventRecord,location:string){return normalizedRoomMatch(event,normalize(location));}
function safeMeet(value:unknown){try{const url=new URL(String(value));return url.protocol==='https:'&&url.hostname==='meet.google.com'&&!url.username&&!url.password&&!url.port?url.href:'';}catch{return '';}}
// Persist only room meetings and fields required by the board, never descriptions or attachments.
export function minimizeEvent(event:EventRecord,location:string):EventRecord|null {return minimizeRoomEvent(event,normalize(location));}
function minimizeRoomEvent(event:EventRecord,normalizedLocation:string):EventRecord|null {
  if(!normalizedRoomMatch(event,normalizedLocation)||event.status==='cancelled'||event.attendees?.some((a:EventRecord)=>a.self&&a.responseStatus==='declined'))return null;
  const time=(v:any)=>v?.dateTime?{dateTime:String(v.dateTime).slice(0,50)}:v?.date?{date:String(v.date).slice(0,10)}:null;
  const start=time(event.start),end=time(event.end);if(!start||!end)return null;
  const identity=(v:any)=>({email:String(v?.email||'').slice(0,254),displayName:String(v?.displayName||'').slice(0,100)});
  const timestamp=(value:unknown)=>{
    if(typeof value!=='string'||value.length>50||!/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(value))return undefined;
    const day=value.slice(0,10),midnight=Date.parse(day+'T00:00:00Z'),at=Date.parse(value);
    return Number.isFinite(midnight)&&new Date(midnight).toISOString().slice(0,10)===day&&Number.isFinite(at)?new Date(at).toISOString():undefined;
  };
  const updated=timestamp(event.updated);
  const sequence=Number.isInteger(event.sequence)&&event.sequence>=0&&event.sequence<=2147483647?event.sequence:undefined;
  const recurringEventId=event.recurringEventId===undefined||event.recurringEventId===null||event.recurringEventId===''?'':typeof event.recurringEventId==='string'&&/^[A-Za-z0-9_-]{1,1024}$/.test(event.recurringEventId)?event.recurringEventId:undefined;
  let originalStartTime:{dateTime:string}|{date:string}|undefined;
  if(recurringEventId){
    const original=event.originalStartTime;
    if(original?.dateTime&&!original.date){const value=timestamp(original.dateTime);if(value)originalStartTime={dateTime:value};}
    if(typeof original?.date==='string'&&!original.dateTime&&/^\d{4}-\d{2}-\d{2}$/.test(original.date)){
      const at=Date.parse(original.date+'T00:00:00Z');if(Number.isFinite(at)&&new Date(at).toISOString().slice(0,10)===original.date)originalStartTime={date:original.date};
    }
  }
  return {id:String(event.id||'').slice(0,1024),iCalUID:String(event.iCalUID||'').slice(0,1024),summary:String(event.summary||'私人 / 忙碌時段').slice(0,300),start,end,sequence,updated,recurringEventId,originalStartTime,location:String(event.location||'').slice(0,300),organizer:identity(event.organizer),attendees:(event.attendees||[]).slice(0,200).map((a:EventRecord)=>({...identity(a),resource:!!a.resource,responseStatus:['accepted','declined','tentative','needsAction'].includes(a.responseStatus)?a.responseStatus:'needsAction',self:!!a.self})),attendeesOmitted:!!event.attendeesOmitted||(event.attendees?.length||0)>200,transparency:event.transparency==='transparent'?'transparent':'opaque',hangoutLink:safeMeet(event.hangoutLink||event.conferenceData?.entryPoints?.find((p:EventRecord)=>p.entryPointType==='video')?.uri)};
}
export function taipeiWeek(value:string|number=Date.now()){
  const day=typeof value==='number'?new Date(value+8*3600000).toISOString().slice(0,10):value;
  if(!/^\d{4}-\d{2}-\d{2}$/.test(day)||!Number.isFinite(Date.parse(day+'T00:00:00Z'))||new Date(day+'T00:00:00Z').toISOString().slice(0,10)!==day)throw new CalendarError(400,'日期格式不正確。');
  const d=new Date(day+'T00:00:00Z');d.setUTCDate(d.getUTCDate()-((d.getUTCDay()+6)%7));return d.toISOString().slice(0,10);
}
async function settings(env:Env){return (await env.DB.prepare('SELECT location,revision FROM room_settings WHERE id=1').first<Room>())!;}
async function googleJSON(url:string,options:RequestInit={}){const response=await fetch(url,{...options,signal:options.signal?AbortSignal.any([options.signal,AbortSignal.timeout(20000)]):AbortSignal.timeout(20000)});let data:EventRecord;try{data=await response.json();}catch{throw new CalendarError(502,'Google 回應暫時無法讀取。');}if(!response.ok){if(data.error==='invalid_grant')throw new CalendarError(401,'REAUTHORIZE');throw new CalendarError(response.status===401?401:502,'Google 日曆暫時無法同步，請稍後重試。',response.status);}return data;}
const tokenRequest=(env:Env,values:Record<string,string>,signal?:AbortSignal)=>googleJSON('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:env.GOOGLE_CLIENT_ID,client_secret:env.GOOGLE_CLIENT_SECRET!,...values}),signal});
async function removeConnection(env:Env,sub:string){await env.DB.batch(['calendar_connections','calendar_snapshots','calendar_oauth_states','calendar_watch_channels','calendar_watch_targets'].map(table=>env.DB.prepare('DELETE FROM '+table+' WHERE member_sub=?').bind(sub)));}
export async function removeRevokedCalendars(env:Env){
  await env.DB.batch(['calendar_connections','calendar_snapshots','calendar_oauth_states','calendar_watch_channels','calendar_watch_targets'].map(table=>env.DB.prepare(`DELETE FROM ${table} WHERE member_sub IN (SELECT sub FROM members WHERE status!='approved')`)));
}
async function readableCalendars(accessToken:string,signal:AbortSignal){
  const ids=['primary'],seen=new Set(ids);let next='',pages=0;
  do{
    const url=new URL('https://www.googleapis.com/calendar/v3/users/me/calendarList');
    for(const[k,v]of Object.entries({minAccessRole:'reader',showHidden:'false',showDeleted:'false',maxResults:'250',...(next?{pageToken:next}:{})}))url.searchParams.set(k,v);
    const page=await googleJSON(url.href,{headers:{Authorization:'Bearer '+accessToken},signal});
    if(!Array.isArray(page.items))throw new CalendarError(502,'CALENDAR_LIST_RESPONSE');
    for(const calendar of page.items){
      if(calendar.primary||calendar.deleted||calendar.hidden||!['reader','writer','owner','writerWithoutPrivateAccess'].includes(calendar.accessRole))continue;
      const id=calendar.id;if(typeof id!=='string'||!id||id.length>1024||/[\u0000-\u001f\u007f]/.test(id))throw new CalendarError(502,'CALENDAR_LIST_RESPONSE');
      if(!seen.has(id)){seen.add(id);ids.push(id);if(ids.length>50)throw new CalendarError(502,'SOURCE_LIMIT');}
    }
    next=page.nextPageToken||'';if(typeof next!=='string'||(++pages>=5&&next))throw new CalendarError(502,'SOURCE_LIMIT');
  }while(next);
  return ids;
}
async function pruneCalendarSnapshots(env:Env,connection:Connection,week:string,lease:string,keys:string[],exclude=false){
  // Permission changes apply to every cached week, even when another Google
  // request fails. Keep primary and still-authorized calendar meetings.
  await env.DB.prepare(`UPDATE calendar_snapshots SET data=COALESCE((SELECT json_group_array(json(value)) FROM json_each(calendar_snapshots.data) WHERE json_extract(value,'$.calendarKey') IS NULL OR json_extract(value,'$.calendarKey') ${exclude?'NOT IN':'IN'} (SELECT value FROM json_each(?))), '[]') WHERE member_sub=? AND connection_version=? AND EXISTS(SELECT 1 FROM members WHERE sub=? AND status='approved') AND EXISTS(SELECT 1 FROM calendar_connections WHERE member_sub=? AND version=? AND status='connected') AND EXISTS(SELECT 1 FROM calendar_snapshots owner WHERE owner.member_sub=? AND owner.week_start=? AND owner.lease_id=? AND owner.lease_until>?)`).bind(JSON.stringify(keys),connection.member_sub,connection.version,connection.member_sub,connection.member_sub,connection.version,connection.member_sub,week,lease,second()).run();
}
async function syncSource(env:Env,connection:Connection,week:string,room:Room,manual=false){
  if(!room.location||connection.status!=='connected')return;
  const time=second(),lease=random();
  await env.DB.prepare('INSERT INTO calendar_snapshots(member_sub,week_start,room_revision,connection_version) VALUES(?,?,?,?) ON CONFLICT(member_sub,week_start) DO NOTHING').bind(connection.member_sub,week,room.revision,connection.version).run();
  // Manual refresh bypasses the ten-minute cache, with a short per-source cooldown.
  const due=manual?time+syncInterval-manualCooldown:time;
  const claimed=await env.DB.prepare(`UPDATE calendar_snapshots SET lease_until=?,lease_id=?,attempt_revision=(SELECT c.change_revision FROM calendar_connections c WHERE c.member_sub=calendar_snapshots.member_sub) WHERE member_sub=? AND week_start=? AND lease_until<=? AND (retry_at<=? OR room_revision!=? OR connection_version!=? OR attempt_revision<(SELECT c.change_revision FROM calendar_connections c WHERE c.member_sub=calendar_snapshots.member_sub)) AND EXISTS(SELECT 1 FROM members WHERE sub=? AND status='approved') AND EXISTS(SELECT 1 FROM calendar_connections WHERE member_sub=? AND version=? AND status='connected') AND NOT EXISTS(SELECT 1 FROM calendar_snapshots other WHERE other.member_sub=? AND other.connection_version=? AND other.week_start!=? AND other.lease_until>?) RETURNING attempt_revision`).bind(time+180,lease,connection.member_sub,week,time,due,room.revision,connection.version,connection.member_sub,connection.member_sub,connection.version,connection.member_sub,connection.version,week,time).first<{attempt_revision:number}>();
  if(!claimed)return;
  // A complete source has a shorter deadline than its lease. Expired work may
  // neither change permission metadata nor commit over a later week's result.
  const deadline=AbortSignal.timeout(120000);
  const watchSource={...connection,watch_week:week,watch_lease:lease};
  const normalizedLocation=normalize(room.location),encoder=new TextEncoder();
  try{
    const refresh=await openToken(env,connection.member_sub,connection.refresh_cipher),result=await tokenRequest(env,{grant_type:'refresh_token',refresh_token:refresh},deadline);
    if(typeof result.access_token!=='string')throw new CalendarError(502,'TOKEN_RESPONSE');
    if(typeof result.scope==='string'&&!canReadEvents(result.scope))throw new CalendarError(401,'REAUTHORIZE');
    const shared=typeof result.scope==='string'?canListCalendars(result.scope):!!connection.shared_calendars;
    await env.DB.prepare("UPDATE calendar_connections SET shared_calendars=? WHERE member_sub=? AND version=? AND status='connected' AND EXISTS(SELECT 1 FROM members WHERE sub=? AND status='approved') AND EXISTS(SELECT 1 FROM calendar_snapshots owner WHERE owner.member_sub=? AND owner.week_start=? AND owner.lease_id=? AND owner.lease_until>?)").bind(shared?1:0,connection.member_sub,connection.version,connection.member_sub,connection.member_sub,week,lease,second()).run();
    if(!shared){await pruneCalendarSnapshots(env,connection,week,lease,[]);await pruneCalendarWatches(env,watchSource,[''],false);}
    const calendarIds=shared?await readableCalendars(result.access_token,deadline):['primary'];
    if(shared){const keys=await Promise.all(calendarIds.filter(id=>id!=='primary').map(digest));await pruneCalendarSnapshots(env,connection,week,lease,keys);await pruneCalendarWatches(env,watchSource,['',...keys],true);}
    // Establish the watch before reading events so ignored early initial-sync
    // notifications cannot leave a gap between the read and subscription.
    await ensureCalendarWatches(env,watchSource,result.access_token,calendarIds,shared,deadline);
    const items:EventRecord[]=[];let payloadSize=2,partial=false;
    const deniedKeys:string[]=[];
    const readCalendar=async(calendarId:string)=>{
      let next='',pages=0;const key=calendarId==='primary'?'':await digest(calendarId),calendarItems:EventRecord[]=[];
      const end=new Date(Date.parse(week+'T00:00:00+08:00')+7*86400000).toISOString();
      try{
        do{
          const url=new URL('https://www.googleapis.com/calendar/v3/calendars/'+encodeURIComponent(calendarId)+'/events');
          for(const [k,v]of Object.entries({timeMin:week+'T00:00:00+08:00',timeMax:end,timeZone:'Asia/Taipei',singleEvents:'true',showDeleted:'false',orderBy:'startTime',maxResults:'2500',...(next?{pageToken:next}:{})}))url.searchParams.set(k,v);
          const page=await googleJSON(url.href,{headers:{Authorization:'Bearer '+result.access_token},signal:deadline});
          if(page.accessRole==='freeBusyReader'||page.accessRole==='none')throw new CalendarError(502,'NO_DETAILS');
          if(!Array.isArray(page.items||[]))throw new CalendarError(502,'EVENT_RESPONSE');
          for(const event of page.items||[]){const safe=minimizeRoomEvent(event,normalizedLocation);if(safe){if(key)safe.calendarKey=key;calendarItems.push(safe);payloadSize+=encoder.encode(JSON.stringify(safe)).length+1;if(payloadSize>1500000)throw new CalendarError(502,'SOURCE_LIMIT');}}
          next=page.nextPageToken||'';if(typeof next!=='string'||(++pages>=10&&next))throw new CalendarError(502,'SOURCE_LIMIT');
        }while(next);
        items.push(...calendarItems);
      }catch(error){
        // A removed or restricted shared calendar must not revoke the person's
        // entire grant, or preserve that calendar's old meetings as current.
        if(calendarId!=='primary'&&error instanceof CalendarError&&([403,404].includes(error.providerStatus)||error.message==='NO_DETAILS')){partial=true;deniedKeys.push(key);return;}
        throw error;
      }
    };
    for(let i=0;i<calendarIds.length;i+=3){
      // Settle every request before releasing the source slot, including after
      // a fast failure, so later sources cannot exceed the concurrency limit.
      const batch=await Promise.allSettled(calendarIds.slice(i,i+3).map(readCalendar));
      if(deniedKeys.length){await pruneCalendarSnapshots(env,connection,week,lease,deniedKeys,true);await pruneCalendarWatches(env,watchSource,deniedKeys,shared,true);}
      const failures=batch.filter((result):result is PromiseRejectedResult=>result.status==='rejected');
      const failure=failures.find(result=>result.reason instanceof CalendarError&&result.reason.status===401)||failures[0];
      if(failure)throw failure.reason;
    }
    // Concurrent calendar reads may finish in either order. Stable ordering
    // prevents unchanged meetings from changing the board's data revision.
    const sorted=items.map(event=>({key:JSON.stringify([event.calendarKey||'',event.id,event.start]),serialized:JSON.stringify(event)}));
    sorted.sort((a,b)=>a.key.localeCompare(b.key)||a.serialized.localeCompare(b.serialized));
    const payload='['+sorted.map(event=>event.serialized).join(',')+']';if(encoder.encode(payload).length>1500000)throw new CalendarError(502,'SOURCE_LIMIT');
    await env.DB.prepare(`UPDATE calendar_snapshots SET data=?,synced_at=?,retry_at=?,room_revision=?,connection_version=?,calendar_count=?,change_revision=?,lease_until=0,error_code=? WHERE member_sub=? AND week_start=? AND lease_id=? AND lease_until>? AND EXISTS(SELECT 1 FROM members WHERE sub=? AND status='approved') AND EXISTS(SELECT 1 FROM calendar_connections WHERE member_sub=? AND version=? AND status='connected') AND EXISTS(SELECT 1 FROM room_settings WHERE id=1 AND revision=?)`).bind(payload,second(),second()+syncInterval,room.revision,connection.version,calendarIds.length,claimed.attempt_revision,partial?'PARTIAL_CALENDARS':null,connection.member_sub,week,lease,second(),connection.member_sub,connection.member_sub,connection.version,room.revision).run();
  }catch(error){
    syncFailureDiagnostic(error);
    const reauthorize=error instanceof CalendarError&&error.status===401;
    if(reauthorize)await env.DB.batch([env.DB.prepare("UPDATE calendar_connections SET status='reauthorize',refresh_cipher='',error_code='REAUTHORIZE' WHERE member_sub=? AND version=? AND EXISTS(SELECT 1 FROM calendar_snapshots owner WHERE owner.member_sub=? AND owner.week_start=? AND owner.lease_id=? AND owner.lease_until>?)").bind(connection.member_sub,connection.version,connection.member_sub,week,lease,second()),env.DB.prepare("DELETE FROM calendar_snapshots WHERE member_sub=? AND connection_version=? AND EXISTS(SELECT 1 FROM calendar_connections WHERE member_sub=? AND version=? AND status='reauthorize')").bind(connection.member_sub,connection.version,connection.member_sub,connection.version),...['calendar_watch_channels','calendar_watch_targets'].map(table=>env.DB.prepare(`DELETE FROM ${table} WHERE member_sub=? AND connection_version=? AND EXISTS(SELECT 1 FROM calendar_connections WHERE member_sub=? AND version=? AND status='reauthorize')`).bind(connection.member_sub,connection.version,connection.member_sub,connection.version))]);
    else await env.DB.prepare('UPDATE calendar_snapshots SET error_code=?,retry_at=?,lease_until=0 WHERE member_sub=? AND week_start=? AND lease_id=? AND lease_until>?').bind('SYNC_FAILED',second()+syncInterval,connection.member_sub,week,lease,second()).run();
  }
}
export async function syncCalendars(env:Env,week=taipeiWeek(),manual=false,dirtyOnly=false,maxSources=Infinity){
  if(!calendarReady(env))return;
  const limit=Number.isFinite(maxSources)?Math.max(0,Math.floor(maxSources)):null;if(limit===0)return;
  const room=await settings(env);if(!room.location)return;
  const time=second(),due=manual?time+syncInterval-manualCooldown:time;
  const {results}=await env.DB.prepare(`SELECT c.* FROM calendar_connections c JOIN members m ON m.sub=c.member_sub LEFT JOIN calendar_snapshots s ON s.member_sub=c.member_sub AND s.week_start=? WHERE m.status='approved' AND c.status='connected' ${dirtyOnly?'AND c.change_revision>COALESCE(s.change_revision,0)':''} AND (s.member_sub IS NULL OR (s.lease_until<=? AND (s.retry_at<=? OR s.room_revision!=? OR s.connection_version!=c.version OR s.attempt_revision<c.change_revision))) AND NOT EXISTS(SELECT 1 FROM calendar_snapshots other WHERE other.member_sub=c.member_sub AND other.connection_version=c.version AND other.week_start!=? AND other.lease_until>?) ORDER BY COALESCE(s.retry_at,0),c.member_sub ${limit===null?'':'LIMIT ?'}`).bind(week,time,due,room.revision,week,time,...(limit===null?[]:[limit])).all<Connection>();
  // Keep Google request concurrency bounded while visiting every due source.
  for(let i=0;i<results.length;i+=5){
    const batch=await Promise.allSettled(results.slice(i,i+5).map(c=>syncSource(env,c,week,room,manual)));
    for(const result of batch)if(result.status==='rejected')syncFailureDiagnostic(result.reason);
  }
}
export async function calendarAPI(path:string,request:Request,env:Env,member:CalendarMember,readBody:()=>Promise<Record<string,unknown>>,verify:IdentityVerifier){
  if(member.status!=='approved')throw new CalendarError(403,'通過白名單後才能使用共用日曆。');
  if(path==='calendar/authorize'&&request.method==='POST'){
    requireSetup(env);
    const state=random(),nonce=random();await env.DB.prepare('INSERT INTO calendar_oauth_states(hash,member_sub,session_hash,nonce,expires_at) VALUES(?,?,?,?,?)').bind(await digest(state),member.sub,await digest(session(request)),nonce,second()+600).run();
    const url=new URL('https://accounts.google.com/o/oauth2/v2/auth');
    for(const[k,v]of Object.entries({client_id:env.GOOGLE_CLIENT_ID,redirect_uri:env.APP_ORIGIN+callbackPath,response_type:'code',scope:'openid email '+readonly+' '+listReadonly,access_type:'offline',prompt:'consent',include_granted_scopes:'true',login_hint:member.email,state,nonce}))url.searchParams.set(k,v);
    return reply({url:url.href});
  }
  if(path==='calendar/callback'&&request.method==='GET'){
    requireSetup(env);const url=new URL(request.url),state=url.searchParams.get('state')||'';
    if(state.length>200)throw new CalendarError(400,'授權狀態不正確。');
    const claimed=await env.DB.prepare('DELETE FROM calendar_oauth_states WHERE hash=? AND member_sub=? AND session_hash=? AND expires_at>? RETURNING nonce').bind(await digest(state),member.sub,await digest(session(request)),second()).first<{nonce:string}>();
    if(!claimed)throw new CalendarError(400,'授權已失效，請回看板重新連接。');
    if(url.searchParams.has('error'))return redirect(env,'cancelled');
    const code=url.searchParams.get('code');if(!code||code.length>8000)throw new CalendarError(400,'缺少 Google 授權碼。');
    try{
      const tokens=await tokenRequest(env,{grant_type:'authorization_code',code,redirect_uri:env.APP_ORIGIN+callbackPath});
      // New connections must include both event details and calendar discovery.
      // Reject partial consent before storing tokens or changing an existing
      // connection; previously granted primary access remains valid until the
      // person completes the upgrade. Legacy readonly includes both rights.
      if(typeof tokens.id_token!=='string'||!canReadEvents(tokens.scope)||!canListCalendars(tokens.scope))return redirect(env,'scope');
      const identity=await verify(tokens.id_token,env.GOOGLE_CLIENT_ID,claimed.nonce);if(identity.sub!==member.sub)return redirect(env,'account');
      const previous=await env.DB.prepare('SELECT * FROM calendar_connections WHERE member_sub=?').bind(member.sub).first<Connection>();
      const cipher=typeof tokens.refresh_token==='string'&&tokens.refresh_token?await sealToken(env,member.sub,tokens.refresh_token):previous?.refresh_cipher;
      if(!cipher)return redirect(env,'refresh');
      // The member may have been revoked while Google was responding.
      await env.DB.batch([env.DB.prepare(`INSERT INTO calendar_connections(member_sub,refresh_cipher,version,status,updated_at,shared_calendars) SELECT ?,?,?,'connected',?,? WHERE EXISTS(SELECT 1 FROM members WHERE sub=? AND status='approved') ON CONFLICT(member_sub) DO UPDATE SET refresh_cipher=excluded.refresh_cipher,version=excluded.version,status='connected',updated_at=excluded.updated_at,shared_calendars=excluded.shared_calendars,error_code=NULL`).bind(member.sub,cipher,random(),second(),canListCalendars(tokens.scope)?1:0,member.sub),...['calendar_snapshots','calendar_watch_channels','calendar_watch_targets'].map(table=>env.DB.prepare('DELETE FROM '+table+' WHERE member_sub=?').bind(member.sub))]);
      await syncCalendars(env);return redirect(env,'connected');
    }catch{return redirect(env,'failed');}
  }
  if(path==='calendar/disconnect'&&request.method==='POST'){await removeConnection(env,member.sub);return reply({ok:true});}
  if(path==='calendar/location'&&request.method==='POST'){
    if(member.role!=='admin'||member.email!==env.ADMIN_EMAIL)throw new CalendarError(403,'只有管理員可以設定共用會議室地點。');
    const body=await readBody();if(typeof body.location!=='string'||!body.location.trim()||body.location.trim().length>100)throw new CalendarError(400,'請輸入 1–100 字的會議室地點。');
    await env.DB.batch([env.DB.prepare('UPDATE room_settings SET location=?,revision=revision+1 WHERE id=1 AND location!=?').bind(body.location.trim(),body.location.trim()),env.DB.prepare('DELETE FROM calendar_snapshots WHERE room_revision!=(SELECT revision FROM room_settings WHERE id=1)')]);
    return reply({ok:true});
  }
  if((path==='calendar/feed'&&request.method==='GET')||(path==='calendar/sync'&&request.method==='POST')){
    const manual=path==='calendar/sync';
    const day=manual?(await readBody()).day:new URL(request.url).searchParams.get('day');
    if(day!==undefined&&day!==null&&typeof day!=='string')throw new CalendarError(400,'日期格式不正確。');
    const week=taipeiWeek(day||taipeiWeek()),current=Date.parse(taipeiWeek()+'T00:00:00Z');
    if(Math.abs(Date.parse(week+'T00:00:00Z')-current)>56*86400000)throw new CalendarError(400,'共用看板可查詢前後 8 週，請選擇範圍內的日期。');
    if(manual)requireSetup(env);
    // Approval changes only need the existing cache. Avoid contacting Google
    // while promptly removing revoked sources from already-open boards.
    const cachedOnly=!manual&&new URL(request.url).searchParams.get('cached')==='1';
    if(!cachedOnly)await syncCalendars(env,week,manual);const room=await settings(env);
    const {results}=await env.DB.prepare(`SELECT m.sub,m.email,c.status,c.version,c.shared_calendars,s.calendar_count,s.data,s.synced_at,s.error_code FROM members m LEFT JOIN calendar_connections c ON c.member_sub=m.sub LEFT JOIN calendar_snapshots s ON s.member_sub=m.sub AND s.week_start=? AND s.room_revision=? AND s.connection_version=c.version WHERE m.status='approved' ORDER BY m.email`).bind(week,room.revision).all<{sub:string;email:string;status:string|null;shared_calendars:number|null;calendar_count:number|null;data:string|null;synced_at:number|null;error_code:string|null}>();
    const sources=results.map(row=>({email:row.email,state:!row.status?'unauthorized':row.status==='reauthorize'?'reauthorize':row.error_code?'error':!row.synced_at?'waiting':second()-row.synced_at>2*syncInterval?'stale':'ready',syncedAt:row.synced_at||null,sharedCalendars:!!row.shared_calendars,calendarCount:row.shared_calendars?(row.calendar_count||1):1,events:row.status==='connected'&&row.data?JSON.parse(row.data).filter((event:EventRecord)=>row.shared_calendars||!event.calendarKey):[]}));
    return reply({week,location:room.location,configured:calendarReady(env),email:member.email,isAdmin:member.role==='admin'&&member.email===env.ADMIN_EMAIL,sources});
  }
  throw new CalendarError(404,'找不到此功能。');
}
export async function calendarMaintenance(env:Env,fullSync=true){
  await removeRevokedCalendars(env);
  await cleanupCalendarWatches(env);
  if(fullSync){
    await env.DB.batch([env.DB.prepare('DELETE FROM calendar_oauth_states WHERE expires_at<=?').bind(second()),env.DB.prepare("DELETE FROM calendar_snapshots WHERE week_start<? OR week_start>?").bind(new Date(Date.now()-63*86400000).toISOString().slice(0,10),new Date(Date.now()+63*86400000).toISOString().slice(0,10))]);
  }
  if(!calendarReady(env))return;
  const time=second(),current=taipeiWeek();
  // Every tick shares one CPU and provider request allowance. Select one week
  // from regular due work and push generations, without a second fallback loop.
  // retry_at advances after both success and failure, so oldest eligible work
  // rotates fairly even when the current week receives continuous changes.
  // A missing current-week snapshot initializes once with priority zero.
  const {results}=await env.DB.prepare(`SELECT week_start FROM (SELECT s.week_start,MIN(s.retry_at) AS attempted FROM calendar_snapshots s JOIN calendar_connections c ON c.member_sub=s.member_sub JOIN members m ON m.sub=c.member_sub JOIN room_settings r ON r.id=1 WHERE c.status='connected' AND m.status='approved' AND s.lease_until<=? AND (s.retry_at<=? OR s.room_revision!=r.revision OR s.connection_version!=c.version OR s.attempt_revision<c.change_revision) AND NOT EXISTS(SELECT 1 FROM calendar_snapshots other WHERE other.member_sub=c.member_sub AND other.connection_version=c.version AND other.week_start!=s.week_start AND other.lease_until>?) GROUP BY s.week_start UNION ALL SELECT ? AS week_start,0 AS attempted WHERE EXISTS(SELECT 1 FROM calendar_connections c JOIN members m ON m.sub=c.member_sub LEFT JOIN calendar_snapshots s ON s.member_sub=c.member_sub AND s.week_start=? WHERE c.status='connected' AND m.status='approved' AND s.member_sub IS NULL AND NOT EXISTS(SELECT 1 FROM calendar_snapshots other WHERE other.member_sub=c.member_sub AND other.connection_version=c.version AND other.week_start!=? AND other.lease_until>?))) GROUP BY week_start ORDER BY MIN(attempted),week_start LIMIT 1`).bind(time,time,time,current,current,current,time).all<{week_start:string}>();
  if(results[0])await syncCalendars(env,results[0].week_start,false,false,2);
}
