type WatchConnection={member_sub:string;version:string;status:string;watch_week:string;watch_lease:string};
type WatchTarget={kind:'events'|'list';calendar_key:string;attempts:number};
const now=()=>Math.floor(Date.now()/1000);
const renewAhead=6*3600,watchTTL=7*86400;
const endpoint='/roomly/api/calendar/notifications';
const hash=async(value:string)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))),v=>v.toString(16).padStart(2,'0')).join('');
const token=()=>Array.from(crypto.getRandomValues(new Uint8Array(32)),v=>v.toString(16).padStart(2,'0')).join('');
const validSource=`EXISTS(SELECT 1 FROM calendar_connections c JOIN members m ON m.sub=c.member_sub WHERE c.member_sub=? AND c.version=? AND c.status='connected' AND m.status='approved')`;
const sourceGuard=()=>validSource+` AND EXISTS(SELECT 1 FROM calendar_snapshots owner WHERE owner.member_sub=? AND owner.week_start=? AND owner.lease_id=? AND owner.lease_until>?)`;
const sourceValues=(connection:WatchConnection)=>[connection.member_sub,connection.version,connection.member_sub,connection.watch_week,connection.watch_lease,now()];
const opaque=(value:unknown)=>typeof value==='string'&&value.length>0&&value.length<=1024&&!/[\u0000-\u001f\u007f]/.test(value);
const empty=(status=204)=>new Response(null,{status,headers:{'Cache-Control':'private, no-store','Referrer-Policy':'no-referrer',...(status===405?{Allow:'POST'}:{})}});
// Only exact provider reason values become fixed diagnostic codes. Unknown
// reasons, messages, calendar IDs and raw provider bodies are never persisted.
async function watchErrorCode(response:Response){
  const fallback='WATCH_HTTP_'+response.status,reader=response.body?.getReader();if(!reader)return fallback;
  try{
    const chunks:Uint8Array[]=[],limit=16384;let size=0;
    for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>limit)return fallback;chunks.push(value);}
    const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
    const data=JSON.parse(new TextDecoder().decode(bytes)) as {error?:{reason?:unknown;errors?:Array<{reason?:unknown}>}};
    const reasons=[data?.error?.reason,...(Array.isArray(data?.error?.errors)?data.error.errors.slice(0,10).map(error=>error?.reason):[])];
    for(const reason of reasons){
      if(typeof reason!=='string')continue;
      if(response.status===400&&(reason==='pushNotSupportedForRequestedResource'||reason==='unsupportedResource'))return 'WATCH_UNSUPPORTED';
      if([403,429].includes(response.status)&&(reason==='rateLimitExceeded'||reason==='userRateLimitExceeded'))return 'WATCH_RATE_LIMIT';
      if([403,429].includes(response.status)&&reason==='quotaExceeded')return 'WATCH_QUOTA';
      if([401,403].includes(response.status)&&reason==='authError')return 'WATCH_AUTH';
      if([500,503].includes(response.status)&&reason==='backendError')return 'WATCH_BACKEND';
    }
  }catch{/* Invalid or incomplete provider JSON keeps the numeric HTTP code. */}
  finally{try{await reader.cancel();}catch{}}
  return fallback;
}

// The receiver has no browser session. A secret channel token, resource ID,
// live connection version and current approval bind every accepted signal.
// Google sends no event data here, and Resource-URI is deliberately unused.
export async function calendarWebhook(request:Request,env:Env):Promise<Response>{
  if(request.method!=='POST')return empty(405);
  const url=new URL(request.url);if(url.origin!==env.APP_ORIGIN||url.pathname!==endpoint)return empty();
  const state=request.headers.get('X-Goog-Resource-State');
  if(state==='sync')return empty();
  if(state!=='exists'&&state!=='not_exists')return empty();
  const id=request.headers.get('X-Goog-Channel-ID')||'',secret=request.headers.get('X-Goog-Channel-Token')||'',resource=request.headers.get('X-Goog-Resource-ID')||'';
  if(!/^[a-f0-9-]{36}$/i.test(id)||!/^[a-f0-9]{64}$/i.test(secret)||!opaque(resource))return empty();
  // Persist before replying. An in-flight sync only acknowledges its captured
  // revision, so a later notification cannot be lost when that sync commits.
  await env.DB.prepare(`UPDATE calendar_connections SET change_revision=change_revision+1 WHERE status='connected' AND EXISTS(SELECT 1 FROM members m WHERE m.sub=calendar_connections.member_sub AND m.status='approved') AND EXISTS(SELECT 1 FROM calendar_watch_channels w WHERE w.channel_id=? AND w.token_hash=? AND w.resource_id=? AND w.state='active' AND w.expires_at>? AND w.member_sub=calendar_connections.member_sub AND w.connection_version=calendar_connections.version)`).bind(id,await hash(secret),resource,now()).run();
  return empty();
}

export async function cleanupCalendarWatches(env:Env){
  // Qualify outer identifiers: a same-named inner column must never turn this
  // into a check for an unrelated person's still-connected calendar.
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM calendar_watch_channels WHERE (state='active' AND expires_at<=?) OR (state='pending' AND created_at<?) OR NOT EXISTS(SELECT 1 FROM calendar_connections c JOIN members m ON m.sub=c.member_sub WHERE c.member_sub=calendar_watch_channels.member_sub AND c.version=calendar_watch_channels.connection_version AND c.status='connected' AND m.status='approved')`).bind(now(),now()-300),
    env.DB.prepare(`DELETE FROM calendar_watch_targets WHERE NOT EXISTS(SELECT 1 FROM calendar_connections c JOIN members m ON m.sub=c.member_sub WHERE c.member_sub=calendar_watch_targets.member_sub AND c.version=calendar_watch_targets.connection_version AND c.status='connected' AND m.status='approved')`)
  ]);
}

export async function pruneCalendarWatches(env:Env,connection:WatchConnection,keys:string[],shared:boolean,exclude=false){
  const removed=`member_sub=? AND connection_version=? AND ((kind='list' AND ?=0) OR (kind='events' AND calendar_key ${exclude?'IN':'NOT IN'} (SELECT value FROM json_each(?)))) AND ${sourceGuard()}`;
  await env.DB.batch(['calendar_watch_channels','calendar_watch_targets'].map(table=>env.DB.prepare('DELETE FROM '+table+' WHERE '+removed).bind(connection.member_sub,connection.version,shared?1:0,JSON.stringify(keys),...sourceValues(connection))));
}

// IDs are only used transiently to create watches. The persisted target keys
// and Google's resource IDs contain no calendar names or routing URLs.
export async function ensureCalendarWatches(env:Env,connection:WatchConnection,accessToken:string,calendarIds:string[],shared:boolean,signal:AbortSignal,alreadyPruned=false){
  try{
    // Setup is best-effort and must leave time for the actual meeting read.
    const setupSignal=AbortSignal.any([signal,AbortSignal.timeout(10000)]),source=sourceGuard();
    const desired=new Map<string,{kind:'events'|'list';key:string;url:string}>();
    for(const id of calendarIds){const key=id==='primary'?'':await hash(id);desired.set('events:'+key,{kind:'events',key,url:'https://www.googleapis.com/calendar/v3/calendars/'+encodeURIComponent(id)+'/events/watch'});}
    if(shared)desired.set('list:',{kind:'list',key:'',url:'https://www.googleapis.com/calendar/v3/users/me/calendarList/watch'});
    const keys=JSON.stringify([...desired.values()].filter(t=>t.kind==='events').map(t=>t.key));
    if(!alreadyPruned)await pruneCalendarWatches(env,connection,JSON.parse(keys),shared);
    // One statement checks current approval/version/source ownership once,
    // then probes target primary keys. Reused targets retain retry and lease
    // state; only missing opaque keys are inserted, without routing URLs.
    const targets=JSON.stringify([...desired.values()].map(target=>[target.kind,target.key]));
    await env.DB.prepare(`INSERT INTO calendar_watch_targets(member_sub,connection_version,kind,calendar_key) SELECT ?,?,json_extract(wanted.value,'$[0]'),json_extract(wanted.value,'$[1]') FROM json_each(?) wanted WHERE ${source} AND NOT EXISTS(SELECT 1 FROM calendar_watch_targets t WHERE t.member_sub=? AND t.connection_version=? AND t.kind=json_extract(wanted.value,'$[0]') AND t.calendar_key=json_extract(wanted.value,'$[1]')) ON CONFLICT(member_sub,connection_version,kind,calendar_key) DO NOTHING`).bind(connection.member_sub,connection.version,targets,...sourceValues(connection),connection.member_sub,connection.version).run();
    // Bound setup work per source. Remaining targets are durable, and the next
    // ten-minute full refresh has the transient calendar IDs needed to retry.
    const {results}=await env.DB.prepare(`SELECT t.kind,t.calendar_key,t.attempts FROM calendar_watch_targets t WHERE t.member_sub=? AND t.connection_version=? AND t.retry_at<=? AND t.lease_until<=? AND ${source} AND NOT EXISTS(SELECT 1 FROM calendar_watch_channels w WHERE w.member_sub=t.member_sub AND w.connection_version=t.connection_version AND w.kind=t.kind AND w.calendar_key=t.calendar_key AND w.state='active' AND w.expires_at>?) ORDER BY CASE WHEN t.kind='list' THEN 0 WHEN t.calendar_key='' THEN 1 ELSE 2 END,t.attempts,t.calendar_key LIMIT 6`).bind(connection.member_sub,connection.version,now(),now(),...sourceValues(connection),now()+renewAhead).all<WatchTarget>();
    const register=async(target:WatchTarget)=>{
      const destination=desired.get(target.kind+':'+target.calendar_key);if(!destination||setupSignal.aborted)return;
      const time=now(),lease=crypto.randomUUID(),id=crypto.randomUUID(),secret=token();
      const claimed=await env.DB.prepare(`UPDATE calendar_watch_targets SET lease_until=?,lease_id=?,attempts=attempts+1 WHERE member_sub=? AND connection_version=? AND kind=? AND calendar_key=? AND retry_at<=? AND lease_until<=? AND ${source} AND NOT EXISTS(SELECT 1 FROM calendar_watch_channels w WHERE w.member_sub=calendar_watch_targets.member_sub AND w.connection_version=calendar_watch_targets.connection_version AND w.kind=calendar_watch_targets.kind AND w.calendar_key=calendar_watch_targets.calendar_key AND w.state='active' AND w.expires_at>?) RETURNING attempts`).bind(time+120,lease,connection.member_sub,connection.version,target.kind,target.calendar_key,time,time,...sourceValues(connection),time+renewAhead).first<{attempts:number}>();
      if(!claimed)return;
      const owner=`EXISTS(SELECT 1 FROM calendar_watch_targets t WHERE t.member_sub=? AND t.connection_version=? AND t.kind=? AND t.calendar_key=? AND t.lease_id=? AND t.lease_until>?)`;
      const ownerValues=()=>[connection.member_sub,connection.version,target.kind,target.calendar_key,lease,now()];
      let errorCode='WATCH_FAILED';
      try{
        const pending=await env.DB.prepare(`INSERT INTO calendar_watch_channels(channel_id,member_sub,connection_version,kind,calendar_key,token_hash,state,created_at) SELECT ?,?,?,?,?,?,'pending',? WHERE ${source} AND ${owner}`).bind(id,connection.member_sub,connection.version,target.kind,target.calendar_key,await hash(secret),time,...sourceValues(connection),...ownerValues()).run();
        if(!pending.meta.changes)return;
        // The initial sync message can arrive before this response; pending
        // channels intentionally cannot schedule work until activation.
        const response=await fetch(destination.url,{method:'POST',redirect:'manual',headers:{Authorization:'Bearer '+accessToken,'Content-Type':'application/json'},body:JSON.stringify({id,type:'web_hook',address:env.APP_ORIGIN+endpoint,token:secret,params:{ttl:String(watchTTL)}}),signal:AbortSignal.any([setupSignal,AbortSignal.timeout(20000)])});
        if(!response.ok||response.status>=300){errorCode=await watchErrorCode(response);throw Error('WATCH_FAILED');}
        const data=await response.json() as Record<string,unknown>,expiration=Number(data.expiration);
        if(data.id!==id||!opaque(data.resourceId)||!Number.isSafeInteger(expiration)||expiration<=Date.now()||expiration>Date.now()+(watchTTL+300)*1000){errorCode='WATCH_RESPONSE';throw Error('WATCH_RESPONSE');}
        await env.DB.batch([
          env.DB.prepare(`UPDATE calendar_watch_channels SET state='active',resource_id=?,expires_at=? WHERE channel_id=? AND ${source} AND ${owner}`).bind(data.resourceId,Math.floor(expiration/1000),id,...sourceValues(connection),...ownerValues()),
          // Calendar discovery precedes this list watch. Schedule one follow-up
          // discovery to cover changes between that read and activation, even
          // if Google's early notification arrived while the row was pending.
          ...(target.kind==='list'?[env.DB.prepare(`UPDATE calendar_connections SET change_revision=change_revision+1 WHERE member_sub=? AND version=? AND ${source} AND EXISTS(SELECT 1 FROM calendar_watch_channels active WHERE active.channel_id=? AND active.state='active')`).bind(connection.member_sub,connection.version,...sourceValues(connection),id)]:[]),
          // Activate the replacement first; a failed renewal leaves the old
          // channel usable. Stop is unnecessary for security: removed IDs are
          // rejected immediately, and Google expires them automatically.
          env.DB.prepare(`DELETE FROM calendar_watch_channels WHERE member_sub=? AND connection_version=? AND kind=? AND calendar_key=? AND channel_id!=? AND EXISTS(SELECT 1 FROM calendar_watch_channels active WHERE active.channel_id=? AND active.state='active')`).bind(connection.member_sub,connection.version,target.kind,target.calendar_key,id,id),
          env.DB.prepare(`UPDATE calendar_watch_targets SET attempts=0,retry_at=0,lease_until=0,error_code=NULL WHERE member_sub=? AND connection_version=? AND kind=? AND calendar_key=? AND lease_id=? AND EXISTS(SELECT 1 FROM calendar_watch_channels active WHERE active.channel_id=? AND active.state='active')`).bind(connection.member_sub,connection.version,target.kind,target.calendar_key,lease,id)
        ]);
      }catch{
        const delay=errorCode==='WATCH_UNSUPPORTED'?86400:Math.min(3600,600*2**Math.min(claimed.attempts-1,3))+Math.floor(Math.random()*60);
        await env.DB.batch([
          env.DB.prepare("DELETE FROM calendar_watch_channels WHERE channel_id=? AND state='pending'").bind(id),
          env.DB.prepare(`UPDATE calendar_watch_targets SET retry_at=?,lease_until=0,error_code=? WHERE member_sub=? AND connection_version=? AND kind=? AND calendar_key=? AND lease_id=? AND ${source}`).bind(now()+delay,errorCode,connection.member_sub,connection.version,target.kind,target.calendar_key,lease,...sourceValues(connection))
        ]);
      }
    };
    for(let i=0;i<results.length;i+=3)await Promise.allSettled(results.slice(i,i+3).map(register));
  }catch{/* Watch setup never prevents publication of a successfully read week. */}
}
