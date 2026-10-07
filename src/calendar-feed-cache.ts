export type FeedRoom={location:string;revision:number;sources_revision:number;feed_revision:number};
export type FeedRow={email:string;status:string|null;shared_calendars:number|null;calendar_count:number|null;data:string|null;synced_at:number|null;error_code:string|null};
type StoredFeed={key:string;expiresAt:number;rows:FeedRow[]};
const ttl=60,namespace='roomly-feed-v1';
const fills=new WeakMap<object,Map<string,Promise<FeedRow[]>>>();
const second=()=>Math.floor(Date.now()/1000);
const sameRoom=(a:FeedRoom,b:FeedRoom)=>a.location===b.location&&a.revision===b.revision&&a.sources_revision===b.sources_revision&&a.feed_revision===b.feed_revision;
const nullableNumber=(value:unknown)=>value===null||Number.isSafeInteger(value)&&Number(value)>=0;
function validData(value:unknown){if(value===null)return true;if(typeof value!=='string'||value.length>1500000)return false;try{return Array.isArray(JSON.parse(value));}catch{return false;}}
function validRows(rows:unknown):rows is FeedRow[]{
  return Array.isArray(rows)&&rows.length<=2000&&rows.every(row=>row&&typeof row==='object'&&!Array.isArray(row)&&Object.keys(row).sort().join(',')==='calendar_count,data,email,error_code,shared_calendars,status,synced_at'
    &&typeof row.email==='string'&&row.email.length<=320&&(row.status===null||row.status==='connected'||row.status==='reauthorize')
    &&(row.shared_calendars===null||row.shared_calendars===0||row.shared_calendars===1)&&nullableNumber(row.calendar_count)&&nullableNumber(row.synced_at)
    &&validData(row.data)&&(row.error_code===null||typeof row.error_code==='string'&&row.error_code.length<=64));
}
async function keyFor(env:Env,week:string,room:FeedRoom){
  const identity=JSON.stringify([namespace,env.APP_ORIGIN,week,room.location,room.revision,room.sources_revision,room.feed_revision]);
  const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(identity))),byte=>byte.toString(16).padStart(2,'0')).join('');
  // A named Cache API namespace is never an ordinary public HTTP response.
  // Keep even its synthetic keys within the authenticated Worker API route.
  return new Request(env.APP_ORIGIN+'/roomly/api/internal/feed-cache/'+hash);
}
async function fill(env:Env,key:string,read:()=>Promise<FeedRow[]>){
  let pending=fills.get(env.DB);if(!pending){pending=new Map();fills.set(env.DB,pending);}
  let value=pending.get(key);if(!value){value=read();pending.set(key,value);}
  try{return await value;}finally{if(pending.get(key)===value)pending.delete(key);}
}
export async function cachedCalendarFeed(env:Env,week:string,initial:FeedRoom,readRoom:()=>Promise<FeedRoom>,readRows:(room:FeedRoom)=>Promise<FeedRow[]>){
  let cache:Cache|undefined;try{if(typeof caches!=='undefined')cache=await caches.open(namespace);}catch{/* D1 remains the durable source when edge cache is unavailable. */}
  let room=initial;
  for(let attempt=0;attempt<2;attempt++){
    const key=await keyFor(env,week,room);let rows:FeedRow[]|undefined;
    try{
      const response=cache?await cache.match(key):undefined;
      if(response?.status===200&&!response.headers.has('Set-Cookie')){
        const saved=await response.json() as StoredFeed;
        if(saved?.key===key.url&&Number.isSafeInteger(saved.expiresAt)&&saved.expiresAt>second()&&saved.expiresAt<=second()+ttl&&validRows(saved.rows))rows=saved.rows;
      }
    }catch{/* A corrupt or failed cache read is a miss, never an API failure. */}
    const hit=!!rows;
    if(!rows)rows=await fill(env,key.url,()=>readRows(room));
    const current=await readRoom();
    // A source revoked during the read must not be published from an old fill.
    // Never label old rows with a newer revision: re-read under the new key.
    if(!sameRoom(room,current)){room=current;continue;}
    if(cache&&!hit){
      const response=new Response(JSON.stringify({key:key.url,expiresAt:second()+ttl,rows}),{headers:{'Content-Type':'application/json','Cache-Control':'public, max-age='+ttl}});
      try{await cache.put(key,response);}catch{/* Cache writes are best-effort; successful D1 reads still work. */}
      const afterPut=await readRoom();
      if(!sameRoom(room,afterPut)){room=afterPut;continue;}
    }
    return {room,rows,cache:cache?(hit?'HIT':'MISS'):'BYPASS'};
  }
  // Do not serve a mismatched permission/data generation during rapid changes.
  throw Error('Calendar feed changed during read');
}
