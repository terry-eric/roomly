import {minimizeEvent} from '../calendar.ts';
import {openCommunityToken} from './auth.ts';
import {CommunityError,checkOrigin,json,now,random,readJSON,spaceFor,type CommunityEnv,type SessionMember} from './common.ts';

type EventRecord=Record<string,any>;
type Job={id:string;space_id:string;requested_by:string;requested_at:number;range_start:string;range_end:string;space_revision:number;status:string;lease_id:string;lease_until:number};
type Source={member_sub:string;grant_version:string;refresh_cipher:string|null;scope:string|null;grant_status:string|null;share_enabled:number|null;joined_at:number|null;location:string;revision:number};
type FeedRow={member_sub:string;email:string;name:string;share_enabled:number;grant_status:string|null;grant_version:string|null;scope:string|null;data:string|null;range_start:string|null;range_end:string|null;calendar_count:number|null;synced_at:number|null;error_code:string|null;item_status:string|null;space_name:string;location:string;revision:number};
const eventScope='https://www.googleapis.com/auth/calendar.events.readonly',listScope='https://www.googleapis.com/auth/calendar.calendarlist.readonly';
const maxMembers=10,maxCalendars=20,maxRequests=50,maxEvents=10000,maxPayload=1500000,leaseSeconds=150;
const fullScope=(scope:unknown)=>typeof scope==='string'&&[eventScope,listScope].every(value=>scope.split(/\s+/).includes(value));
const changes=(result:D1Result)=>Number(result.meta.changes||0);
const terminal=(status:string)=>!['queued','running'].includes(status);
const method=(request:Request,value:string)=>{if(request.method!==value)throw new CommunityError(405,'不支援此操作。');};

/** End is exclusive. A range never initiates a provider request by itself. */
export function communityRange(start:unknown,end:unknown){
  const valid=(value:unknown):value is string=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value+'T00:00:00Z'))&&new Date(value+'T00:00:00Z').toISOString().slice(0,10)===value;
  if(!valid(start)||!valid(end))throw new CommunityError(400,'日期格式不正確。');
  const first=Date.parse(start+'T00:00:00Z'),last=Date.parse(end+'T00:00:00Z'),today=Date.parse(new Date(now()*1000+8*3600000).toISOString().slice(0,10)+'T00:00:00Z');
  if(last<=first||last-first>31*86400000||first<today-63*86400000||last>today+64*86400000)throw new CommunityError(400,'每次最多同步 31 天，日期須在今天前後 63 天內。');
  return {start,end};
}

const eventTime=(value:any)=>value?.dateTime?Date.parse(value.dateTime):value?.date?Date.parse(value.date+'T00:00:00+08:00'):NaN;
function recurrenceKey(event:EventRecord){
  const original=event.originalStartTime;
  if(original?.dateTime){const at=Date.parse(original.dateTime);if(Number.isFinite(at))return new Date(at).toISOString();}
  if(original?.date)return String(original.date);
  return event.recurringEventId?String(event.start?.dateTime||event.start?.date||''):'';
}
function eventKey(event:EventRecord,fallback:string){return event.iCalUID?'ical:'+event.iCalUID+'|'+recurrenceKey(event):fallback+'|'+String(event.id||'')+'|'+String(event.start?.dateTime||event.start?.date||'');}
function newer(a:EventRecord,b:EventRecord){
  const sequence=(Number(a.sequence)||0)-(Number(b.sequence)||0);if(sequence)return sequence>0;
  const updated=(Date.parse(a.updated)||0)-(Date.parse(b.updated)||0);return updated>0;
}
function dedupe(values:{event:EventRecord;source:string}[]){
  const map=new Map<string,EventRecord>();
  for(const {event,source} of values){const key=eventKey(event,source),old=map.get(key);if(!old||newer(event,old))map.set(key,event);}
  return [...map.values()].sort((a,b)=>eventTime(a.start)-eventTime(b.start)||String(a.summary).localeCompare(String(b.summary)));
}
function cachedEvents(row:FeedRow,range:{start:string;end:string}){
  if(!row.data||!row.range_start||!row.range_end||row.range_start>range.start||row.range_end<range.end)return [];
  try{
    const parsed=JSON.parse(row.data);if(!Array.isArray(parsed)||parsed.length>maxEvents)return [];
    const start=Date.parse(range.start+'T00:00:00+08:00'),end=Date.parse(range.end+'T00:00:00+08:00');
    return parsed.map(value=>minimizeEvent(value,row.location)).filter((event):event is EventRecord=>!!event&&eventTime(event.start)<end&&eventTime(event.end)>start);
  }catch{return [];}
}

async function feed(request:Request,env:CommunityEnv,member:SessionMember,spaceId:string){
  method(request,'GET');const url=new URL(request.url),range=communityRange(url.searchParams.get('start'),url.searchParams.get('end'));
  for(let attempt=0;attempt<2;attempt++){
    const space=await spaceFor(env,member.sub,spaceId);
    const result=await env.PUBLIC_DB.prepare(`SELECT m.sub AS member_sub,m.email,m.name,ms.share_enabled,g.status AS grant_status,g.version AS grant_version,g.scope,
      sn.data,sn.range_start,sn.range_end,sn.calendar_count,sn.synced_at,sn.error_code,
      (SELECT i.status FROM community_sync_items i JOIN community_sync_jobs j ON j.id=i.job_id WHERE j.space_id=s.id AND i.member_sub=m.sub AND j.status IN ('queued','running') ORDER BY j.requested_at DESC LIMIT 1) AS item_status,
      s.name AS space_name,s.location,s.revision
      FROM community_spaces s JOIN community_memberships ms ON ms.space_id=s.id JOIN community_members m ON m.sub=ms.member_sub
      LEFT JOIN community_grants g ON g.member_sub=m.sub
      LEFT JOIN community_snapshots sn ON sn.space_id=s.id AND sn.member_sub=m.sub AND sn.space_revision=s.revision AND sn.grant_version=g.version
      WHERE s.id=? AND s.revision=? AND s.sources_revision=? AND EXISTS(SELECT 1 FROM community_memberships viewer WHERE viewer.space_id=s.id AND viewer.member_sub=?) ORDER BY m.email LIMIT 11`).bind(spaceId,space.revision,space.sources_revision,member.sub).all<FeedRow>();
    const rows=result.results;
    if(!rows.length)continue;
    if(rows.length>maxMembers)throw new CommunityError(409,'此空間超過來源上限。');
    const values:{event:EventRecord;source:string}[]=[];
    const sources=rows.map(row=>{
      const authorized=row.share_enabled===1&&row.grant_status==='connected'&&fullScope(row.scope);
      const covers=authorized&&!!row.synced_at&&!!row.range_start&&!!row.range_end&&row.range_start<=range.start&&row.range_end>=range.end;
      const events=covers?cachedEvents(row,range):[];for(const event of events)values.push({event,source:row.member_sub});
      let state=!row.share_enabled?'sharing_disabled':!row.grant_status?'unauthorized':row.grant_status!=='connected'||!fullScope(row.scope)?'reauthorize':row.error_code?'error':!covers?'missing':'ready';
      if(authorized&&['pending','running'].includes(row.item_status||''))state='syncing';
      return {email:row.email,name:row.name,state,syncedAt:authorized?Number(row.synced_at||0):0,calendarCount:authorized?Number(row.calendar_count||0):0,eventCount:events.length,errorCode:authorized?row.error_code||null:null,rangeMissing:!covers};
    });
    // Recheck location and source permission generations after reading. A source
    // removed or disconnected during this read must not escape in the response.
    const current=await spaceFor(env,member.sub,spaceId);if(current.revision!==space.revision||current.sources_revision!==space.sources_revision)continue;
    return json({space:{id:spaceId,name:rows[0].space_name,location:rows[0].location},range,events:dedupe(values),sources,rangeMissing:sources.some(source=>source.rangeMissing),mode:'manual'});
  }
  throw new CommunityError(409,'空間設定剛有變更，請重新載入。');
}

async function jobView(env:CommunityEnv,sub:string,spaceId:string,jobId:string){
  const row=await env.PUBLIC_DB.prepare(`SELECT j.id,j.status,COUNT(i.member_sub) AS total,
    COALESCE(SUM(i.status IN ('success','error','skipped')),0) AS completed,COALESCE(SUM(i.status='success'),0) AS succeeded,COALESCE(SUM(i.status IN ('error','skipped')),0) AS failed
    FROM community_sync_jobs j LEFT JOIN community_sync_items i ON i.job_id=j.id
    WHERE j.id=? AND j.space_id=? AND EXISTS(SELECT 1 FROM community_memberships ms WHERE ms.space_id=j.space_id AND ms.member_sub=?) GROUP BY j.id`).bind(jobId,spaceId,sub).first<{id:string;status:string;total:number;completed:number;succeeded:number;failed:number}>();
  if(!row)throw new CommunityError(404,'找不到這次同步。');
  return row;
}
async function settle(env:CommunityEnv,jobId:string,lease?:string){
  await env.PUBLIC_DB.prepare(`UPDATE community_sync_jobs SET status=CASE WHEN NOT EXISTS(SELECT 1 FROM community_sync_items WHERE job_id=community_sync_jobs.id AND status IN ('error','skipped')) AND EXISTS(SELECT 1 FROM community_sync_items WHERE job_id=community_sync_jobs.id) THEN 'complete' ELSE 'partial' END,finished_at=?,lease_id='',lease_until=0
    WHERE id=? AND status IN ('queued','running') AND NOT EXISTS(SELECT 1 FROM community_sync_items WHERE job_id=community_sync_jobs.id AND status IN ('pending','running'))${lease?' AND lease_id=?':''}`).bind(now(),jobId,...(lease?[lease]:[])).run();
}
async function requestSync(request:Request,env:CommunityEnv,member:SessionMember,spaceId:string){
  method(request,'POST');checkOrigin(request,env);const body=await readJSON(request),range=communityRange(body.start,body.end),space=await spaceFor(env,member.sub,spaceId);
  if(!space.location)throw new CommunityError(400,'請先設定會議室地點。');
  if(!env.PUBLIC_SYNC_QUEUE||!env.GOOGLE_CLIENT_SECRET||!/^[a-f0-9]{64}$/i.test(env.PUBLIC_CALENDAR_TOKEN_KEY||''))throw new CommunityError(503,'日曆同步尚未完成設定。');
  const at=now();
  const admission=await env.PUBLIC_DB.prepare(`INSERT INTO community_sync_admissions(member_sub,last_at) SELECT ?,? WHERE EXISTS(SELECT 1 FROM community_memberships ms JOIN community_spaces s ON s.id=ms.space_id WHERE ms.space_id=? AND ms.member_sub=? AND s.revision=?)
    ON CONFLICT(member_sub) DO UPDATE SET last_at=excluded.last_at WHERE community_sync_admissions.last_at<=?`).bind(member.sub,at,spaceId,member.sub,space.revision,at-30).run();
  const active=await env.PUBLIC_DB.prepare("SELECT id,range_start,range_end,lease_until FROM community_sync_jobs WHERE space_id=? AND status IN ('queued','running')").bind(spaceId).first<{id:string;range_start:string;range_end:string;lease_until:number}>();
  if(active){
    if(active.range_start!==range.start||active.range_end!==range.end)throw new CommunityError(409,'另一次同步正在進行，完成後再更新此日期。');
    if(changes(admission)&&active.lease_until<=now())await env.PUBLIC_SYNC_QUEUE.send({jobId:active.id});return json({job:await jobView(env,member.sub,spaceId,active.id)},202);
  }
  if(!changes(admission))throw new CommunityError(429,'請等 30 秒後再同步。');
  const id=random();
  // Job admission and its source set are one transaction. A duplicate manual
  // request can never enqueue a job whose items have not been inserted yet.
  const admitted=await env.PUBLIC_DB.batch([env.PUBLIC_DB.prepare(`INSERT INTO community_sync_jobs(id,space_id,requested_by,requested_at,range_start,range_end,space_revision,status)
    SELECT ?,?,?,?, ?,?,?,'queued' WHERE EXISTS(SELECT 1 FROM community_memberships ms JOIN community_spaces s ON s.id=ms.space_id WHERE ms.space_id=? AND ms.member_sub=? AND s.revision=?)
    AND (SELECT COUNT(*) FROM community_memberships WHERE space_id=?) BETWEEN 1 AND ?
    AND NOT EXISTS(SELECT 1 FROM community_sync_jobs WHERE requested_by=? AND requested_at>?)
    AND NOT EXISTS(SELECT 1 FROM community_sync_jobs WHERE space_id=? AND status IN ('queued','running'))`).bind(id,spaceId,member.sub,at,range.start,range.end,space.revision,spaceId,member.sub,space.revision,spaceId,maxMembers,member.sub,at-30,spaceId),
    env.PUBLIC_DB.prepare(`INSERT INTO community_sync_items(job_id,member_sub,grant_version,status,error_code)
      SELECT ?,ms.member_sub,COALESCE(g.version,''),CASE WHEN ms.share_enabled=1 AND g.status='connected' AND instr(' '||g.scope||' ',?)>0 AND instr(' '||g.scope||' ',?)>0 THEN 'pending' ELSE 'skipped' END,
      CASE WHEN ms.share_enabled!=1 THEN 'SHARING_DISABLED' WHEN g.member_sub IS NULL THEN 'UNAUTHORIZED' WHEN g.status!='connected' THEN 'REAUTHORIZE' WHEN instr(' '||g.scope||' ',?)=0 OR instr(' '||g.scope||' ',?)=0 THEN 'PARTIAL_SCOPE' ELSE NULL END
      FROM community_memberships ms LEFT JOIN community_grants g ON g.member_sub=ms.member_sub WHERE ms.space_id=? AND EXISTS(SELECT 1 FROM community_sync_jobs j JOIN community_spaces s ON s.id=j.space_id WHERE j.id=? AND j.space_revision=s.revision AND EXISTS(SELECT 1 FROM community_memberships viewer WHERE viewer.space_id=s.id AND viewer.member_sub=j.requested_by))`).bind(id,' '+eventScope+' ',' '+listScope+' ',' '+eventScope+' ',' '+listScope+' ',spaceId,id)]);
  if(!changes(admitted[0])){
    const concurrent=await env.PUBLIC_DB.prepare("SELECT id FROM community_sync_jobs WHERE space_id=? AND status IN ('queued','running')").bind(spaceId).first<{id:string}>();
    if(concurrent)return json({job:await jobView(env,member.sub,spaceId,concurrent.id)},202);
    await spaceFor(env,member.sub,spaceId);throw new CommunityError(429,'請等 30 秒後再同步。');
  }
  await settle(env,id);
  const job=await jobView(env,member.sub,spaceId,id);
  if(!terminal(job.status)){
    try{await env.PUBLIC_SYNC_QUEUE.send({jobId:id});}catch{throw new CommunityError(503,'同步已排入，請稍後按同步重試。');}
  }
  return json({job},202);
}

class ProviderError extends Error {code:string;constructor(code:string){super(code);this.code=code;}}
async function readGoogle(env:CommunityEnv,source:Source,job:Job){
  const deadline=AbortSignal.timeout(90000);let requests=0,rawCount=0,bytes=2;
  const google=async(url:string,options:RequestInit={},exchange=false):Promise<EventRecord>=>{
    if(++requests>maxRequests)throw new ProviderError('SOURCE_LIMIT');
    let response:Response;try{response=await fetch(url,{...options,redirect:'manual',signal:AbortSignal.any([deadline,AbortSignal.timeout(20000)])});}catch{throw new ProviderError('PROVIDER_UNAVAILABLE');}
    let text:string;try{text=await response.text();}catch{throw new ProviderError('PROVIDER_UNAVAILABLE');}
    if(text.length>2000000)throw new ProviderError('SOURCE_LIMIT');
    let data:EventRecord;try{data=JSON.parse(text);}catch{throw new ProviderError('PROVIDER_RESPONSE');}
    if(!data||typeof data!=='object'||Array.isArray(data))throw new ProviderError('PROVIDER_RESPONSE');
    if(!response.ok){if(exchange&&data.error==='invalid_grant')throw new ProviderError('REAUTHORIZE');throw new ProviderError('PROVIDER_UNAVAILABLE');}
    return data;
  };
  let refresh:string;try{refresh=await openCommunityToken(env,source.member_sub,source.refresh_cipher!);}catch{throw new ProviderError('REAUTHORIZE');}
  const token=await google('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:env.GOOGLE_CLIENT_ID,client_secret:env.GOOGLE_CLIENT_SECRET!,grant_type:'refresh_token',refresh_token:refresh})},true);
  if(typeof token.access_token!=='string'||!token.access_token||token.access_token.length>8192)throw new ProviderError('PROVIDER_RESPONSE');
  if(token.scope!==undefined&&!fullScope(token.scope))throw new ProviderError('REAUTHORIZE');
  const headers={Authorization:'Bearer '+token.access_token},ids=['primary'],seen=new Set(ids),listTokens=new Set<string>();let next='',pages=0;
  do{
    const url=new URL('https://www.googleapis.com/calendar/v3/users/me/calendarList');
    for(const [key,value] of Object.entries({minAccessRole:'reader',showHidden:'false',showDeleted:'false',maxResults:'250',fields:'nextPageToken,items(id,primary,deleted,hidden,accessRole)',...(next?{pageToken:next}:{})}))url.searchParams.set(key,value);
    const page=await google(url.href,{headers});if(page.items!==undefined&&!Array.isArray(page.items))throw new ProviderError('PROVIDER_RESPONSE');
    for(const calendar of page.items||[]){
      if(!calendar||typeof calendar!=='object')throw new ProviderError('PROVIDER_RESPONSE');
      if(calendar.primary||calendar.deleted||calendar.hidden||!['reader','writer','owner','writerWithoutPrivateAccess'].includes(calendar.accessRole))continue;
      if(typeof calendar.id!=='string'||!calendar.id||calendar.id.length>1024||/[\u0000-\u001f\u007f]/.test(calendar.id))throw new ProviderError('PROVIDER_RESPONSE');
      if(!seen.has(calendar.id)){seen.add(calendar.id);ids.push(calendar.id);if(ids.length>maxCalendars)throw new ProviderError('SOURCE_LIMIT');}
    }
    next=page.nextPageToken||'';if(typeof next!=='string'||next.length>4096||next&&(listTokens.has(next)||++pages>=3))throw new ProviderError('SOURCE_LIMIT');if(next)listTokens.add(next);
  }while(next);
  const values:{event:EventRecord;source:string}[]=[];
  for(const calendarId of ids){
    next='';pages=0;const eventTokens=new Set<string>();
    do{
      const url=new URL('https://www.googleapis.com/calendar/v3/calendars/'+encodeURIComponent(calendarId)+'/events');
      for(const [key,value] of Object.entries({timeMin:job.range_start+'T00:00:00+08:00',timeMax:job.range_end+'T00:00:00+08:00',timeZone:'Asia/Taipei',singleEvents:'true',showDeleted:'false',orderBy:'startTime',maxResults:'500',fields:'accessRole,nextPageToken,items(id,iCalUID,status,summary,start,end,sequence,updated,recurringEventId,originalStartTime,location,organizer(email,displayName),attendees(email,displayName,resource,responseStatus,self),attendeesOmitted,transparency,hangoutLink,conferenceData(entryPoints(entryPointType,uri)))',...(next?{pageToken:next}:{})}))url.searchParams.set(key,value);
      const page=await google(url.href,{headers});if(['freeBusyReader','none'].includes(page.accessRole))throw new ProviderError('NO_DETAILS');
      if(page.items!==undefined&&!Array.isArray(page.items))throw new ProviderError('PROVIDER_RESPONSE');
      for(const value of page.items||[]){
        if(++rawCount>maxEvents)throw new ProviderError('SOURCE_LIMIT');
        if(!value||typeof value!=='object'||Array.isArray(value))throw new ProviderError('PROVIDER_RESPONSE');
        let event:EventRecord|null;try{event=minimizeEvent(value,source.location);}catch{throw new ProviderError('PROVIDER_RESPONSE');}
        if(event){bytes+=new TextEncoder().encode(JSON.stringify(event)).length+1;if(bytes>maxPayload)throw new ProviderError('SOURCE_LIMIT');values.push({event,source:calendarId});}
      }
      next=page.nextPageToken||'';if(typeof next!=='string'||next.length>4096||next&&(eventTokens.has(next)||++pages>=8))throw new ProviderError('SOURCE_LIMIT');if(next)eventTokens.add(next);
    }while(next);
  }
  return {events:dedupe(values),calendarCount:ids.length};
}

// Every durable write after a provider request validates the same permission
// generation and live lease. Reauth, room edits and removal invalidate old work.
const commitGuard=`EXISTS(SELECT 1 FROM community_sync_jobs j JOIN community_spaces s ON s.id=j.space_id
  JOIN community_memberships viewer ON viewer.space_id=s.id AND viewer.member_sub=j.requested_by
  JOIN community_memberships ms ON ms.space_id=s.id AND ms.member_sub=?
  JOIN community_grants g ON g.member_sub=ms.member_sub
  JOIN community_sync_items i ON i.job_id=j.id AND i.member_sub=ms.member_sub
  WHERE j.id=? AND j.lease_id=? AND j.lease_until>? AND j.status='running' AND s.revision=? AND j.space_revision=s.revision AND ms.share_enabled=1 AND ms.joined_at=? AND g.status='connected' AND g.version=? AND i.grant_version=g.version AND i.status='running')`;
const guardValues=(job:Job,source:Source,lease:string)=>[source.member_sub,job.id,lease,now(),job.space_revision,source.joined_at,source.grant_version];
async function commitSuccess(env:CommunityEnv,job:Job,source:Source,lease:string,result:{events:EventRecord[];calendarCount:number}){
  const at=now(),guard=guardValues(job,source,lease);
  await env.PUBLIC_DB.batch([
    env.PUBLIC_DB.prepare(`INSERT INTO community_snapshots(space_id,member_sub,space_revision,grant_version,range_start,range_end,data,calendar_count,synced_at,error_code) SELECT ?,?,?,?,?,?,?,?,?,NULL WHERE ${commitGuard}
      ON CONFLICT(space_id,member_sub) DO UPDATE SET space_revision=excluded.space_revision,grant_version=excluded.grant_version,range_start=excluded.range_start,range_end=excluded.range_end,data=excluded.data,calendar_count=excluded.calendar_count,synced_at=excluded.synced_at,error_code=NULL`).bind(job.space_id,source.member_sub,job.space_revision,source.grant_version,job.range_start,job.range_end,JSON.stringify(result.events),result.calendarCount,at,...guard),
    env.PUBLIC_DB.prepare(`UPDATE community_sync_items SET status='success',error_code=NULL WHERE job_id=? AND member_sub=? AND ${commitGuard}`).bind(job.id,source.member_sub,...guard)
  ]);
}
async function commitError(env:CommunityEnv,job:Job,source:Source,lease:string,code:string){
  const guard=guardValues(job,source,lease);
  if(code==='REAUTHORIZE'){
    // Invalid refresh grant is a permission failure, not a fresh zero-event sync.
    // Version checks ensure an old error cannot invalidate a newly granted token.
    await env.PUBLIC_DB.batch([
      env.PUBLIC_DB.prepare(`DELETE FROM community_snapshots WHERE member_sub=? AND grant_version=? AND ${commitGuard}`).bind(source.member_sub,source.grant_version,...guard),
      env.PUBLIC_DB.prepare(`UPDATE community_sync_items SET status='error',error_code='REAUTHORIZE' WHERE job_id=? AND member_sub=? AND ${commitGuard}`).bind(job.id,source.member_sub,...guard),
      env.PUBLIC_DB.prepare(`UPDATE community_grants SET status='reauthorize' WHERE member_sub=? AND version=? AND EXISTS(SELECT 1 FROM community_sync_jobs j JOIN community_sync_items i ON i.job_id=j.id WHERE j.id=? AND j.lease_id=? AND j.lease_until>? AND j.status='running' AND i.member_sub=community_grants.member_sub AND i.grant_version=community_grants.version AND i.status='error' AND i.error_code='REAUTHORIZE')`).bind(source.member_sub,source.grant_version,job.id,lease,now())
    ]);return;
  }
  await env.PUBLIC_DB.batch([
    env.PUBLIC_DB.prepare(`INSERT INTO community_snapshots(space_id,member_sub,space_revision,grant_version,range_start,range_end,error_code) SELECT ?,?,?,?,?,?,? WHERE ${commitGuard}
      ON CONFLICT(space_id,member_sub) DO UPDATE SET error_code=excluded.error_code,
      data=CASE WHEN community_snapshots.space_revision=excluded.space_revision AND community_snapshots.grant_version=excluded.grant_version THEN community_snapshots.data ELSE '[]' END,
      synced_at=CASE WHEN community_snapshots.space_revision=excluded.space_revision AND community_snapshots.grant_version=excluded.grant_version THEN community_snapshots.synced_at ELSE 0 END,
      calendar_count=CASE WHEN community_snapshots.space_revision=excluded.space_revision AND community_snapshots.grant_version=excluded.grant_version THEN community_snapshots.calendar_count ELSE 0 END,
      range_start=CASE WHEN community_snapshots.space_revision=excluded.space_revision AND community_snapshots.grant_version=excluded.grant_version THEN community_snapshots.range_start ELSE excluded.range_start END,
      range_end=CASE WHEN community_snapshots.space_revision=excluded.space_revision AND community_snapshots.grant_version=excluded.grant_version THEN community_snapshots.range_end ELSE excluded.range_end END,
      space_revision=excluded.space_revision,grant_version=excluded.grant_version`).bind(job.space_id,source.member_sub,job.space_revision,source.grant_version,job.range_start,job.range_end,code,...guard),
    env.PUBLIC_DB.prepare(`UPDATE community_sync_items SET status='error',error_code=? WHERE job_id=? AND member_sub=? AND ${commitGuard}`).bind(code,job.id,source.member_sub,...guard)
  ]);
}
async function cancelInvalidJob(env:CommunityEnv,jobId:string){
  await env.PUBLIC_DB.prepare(`UPDATE community_sync_jobs SET status='error',error_code='SPACE_CHANGED',finished_at=?,lease_id='',lease_until=0 WHERE id=? AND status IN ('queued','running') AND NOT EXISTS(SELECT 1 FROM community_spaces s JOIN community_memberships ms ON ms.space_id=s.id WHERE s.id=community_sync_jobs.space_id AND s.revision=community_sync_jobs.space_revision AND ms.member_sub=community_sync_jobs.requested_by)`).bind(now(),jobId).run();
}
async function processJob(env:CommunityEnv,jobId:string){
  await cancelInvalidJob(env,jobId);const lease=random(),at=now();
  const job=await env.PUBLIC_DB.prepare(`UPDATE community_sync_jobs SET status='running',lease_id=?,lease_until=? WHERE id=? AND status IN ('queued','running') AND lease_until<=? RETURNING *`).bind(lease,at+leaseSeconds,jobId,at).first<Job>();
  if(!job){const current=await env.PUBLIC_DB.prepare('SELECT status,lease_until FROM community_sync_jobs WHERE id=?').bind(jobId).first<{status:string;lease_until:number}>();return current&&!terminal(current.status)?'busy':'done';}
  await env.PUBLIC_DB.prepare(`UPDATE community_sync_items SET status='pending' WHERE job_id=? AND status='running' AND EXISTS(SELECT 1 FROM community_sync_jobs WHERE id=? AND lease_id=?)`).bind(jobId,jobId,lease).run();
  const source=await env.PUBLIC_DB.prepare(`SELECT i.member_sub,i.grant_version,g.refresh_cipher,g.scope,g.status AS grant_status,ms.share_enabled,ms.joined_at,s.location,s.revision FROM community_sync_items i JOIN community_sync_jobs j ON j.id=i.job_id JOIN community_spaces s ON s.id=j.space_id LEFT JOIN community_memberships ms ON ms.space_id=j.space_id AND ms.member_sub=i.member_sub LEFT JOIN community_grants g ON g.member_sub=i.member_sub WHERE i.job_id=? AND i.status='pending' ORDER BY i.member_sub LIMIT 1`).bind(jobId).first<Source>();
  if(source){
    const eligible=source.share_enabled===1&&source.grant_status==='connected'&&source.refresh_cipher&&fullScope(source.scope)&&source.grant_version&&source.revision===job.space_revision;
    if(eligible){
      const claimed=await env.PUBLIC_DB.prepare(`UPDATE community_sync_items SET status='running' WHERE job_id=? AND member_sub=? AND status='pending'
        AND EXISTS(SELECT 1 FROM community_sync_jobs j JOIN community_spaces s ON s.id=j.space_id JOIN community_memberships ms ON ms.space_id=s.id AND ms.member_sub=? JOIN community_grants g ON g.member_sub=ms.member_sub WHERE j.id=? AND j.lease_id=? AND j.lease_until>? AND j.status='running' AND s.revision=j.space_revision AND ms.share_enabled=1 AND ms.joined_at=? AND g.status='connected' AND g.version=community_sync_items.grant_version AND g.version=?)`).bind(jobId,source.member_sub,source.member_sub,jobId,lease,now(),source.joined_at,source.grant_version).run();
      if(changes(claimed)){
        try{await commitSuccess(env,job,source,lease,await readGoogle(env,source,job));}
        catch(error){await commitError(env,job,source,lease,error instanceof ProviderError?error.code:'PROVIDER_UNAVAILABLE');}
      }
    }
    // If a permission changed while Google was read, the failed CAS is terminal
    // for this item; it never becomes a retry with the new token or membership.
    await env.PUBLIC_DB.prepare(`UPDATE community_sync_items SET status='skipped',error_code='SOURCE_CHANGED' WHERE job_id=? AND member_sub=? AND status IN ('pending','running') AND EXISTS(SELECT 1 FROM community_sync_jobs WHERE id=? AND lease_id=? AND lease_until>?)`).bind(jobId,source.member_sub,jobId,lease,now()).run();
  }
  await settle(env,jobId,lease);
  const released=await env.PUBLIC_DB.prepare("UPDATE community_sync_jobs SET lease_id='',lease_until=0 WHERE id=? AND lease_id=? AND status='running'").bind(jobId,lease).run();
  if(changes(released)){await env.PUBLIC_SYNC_QUEUE.send({jobId});return 'continued';}
  const current=await env.PUBLIC_DB.prepare('SELECT status FROM community_sync_jobs WHERE id=?').bind(jobId).first<{status:string}>();return current&&!terminal(current.status)?'busy':'done';
}

export async function communitySyncAPI(request:Request,env:CommunityEnv,member:SessionMember,spaceId:string,action:string){
  if(action==='feed')return feed(request,env,member,spaceId);
  if(action==='sync')return requestSync(request,env,member,spaceId);
  if(/^jobs\/[a-f0-9]{64}$/.test(action)){method(request,'GET');await spaceFor(env,member.sub,spaceId);return json({job:await jobView(env,member.sub,spaceId,action.slice(5))});}
  throw new CommunityError(404,'找不到這個頁面。');
}
export async function consumeCommunityQueue(batch:MessageBatch<unknown>,env:CommunityEnv,_ctx:ExecutionContext){
  for(const message of batch.messages){
    const body=message.body as {jobId?:unknown};
    if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).join(',')!=='jobId'||typeof body.jobId!=='string'||!/^[a-f0-9]{64}$/.test(body.jobId)){message.ack();continue;}
    try{
      if(message.attempts>4){
        // Queue transport retries are bounded and belong only to this explicit
        // request. A later GET cannot restart a failed run.
        const current=await env.PUBLIC_DB.prepare('SELECT status,lease_until FROM community_sync_jobs WHERE id=?').bind(body.jobId).first<{status:string;lease_until:number}>();
        if(current&&!terminal(current.status)&&current.lease_until>now()){message.retry({delaySeconds:Math.min(150,current.lease_until-now()+1)});continue;}
        await env.PUBLIC_DB.batch([
          env.PUBLIC_DB.prepare(`UPDATE community_sync_items SET status='error',error_code='TRANSPORT_FAILED' WHERE job_id=? AND status IN ('pending','running') AND EXISTS(SELECT 1 FROM community_sync_jobs WHERE id=? AND status IN ('queued','running') AND lease_until<=?)`).bind(body.jobId,body.jobId,now()),
          env.PUBLIC_DB.prepare(`UPDATE community_sync_jobs SET status='error',error_code='TRANSPORT_FAILED',finished_at=?,lease_id='',lease_until=0 WHERE id=? AND status IN ('queued','running') AND lease_until<=?`).bind(now(),body.jobId,now())
        ]);message.ack();continue;
      }
      const result=await processJob(env,body.jobId);if(result==='busy')message.retry({delaySeconds:30});else message.ack();
    }catch{message.retry({delaySeconds:30});}
  }
}
