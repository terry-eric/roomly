import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {cachedCalendarFeed} from '../src/calendar-feed-cache.ts';
import {createHandler,hash} from '../src/worker.ts';
import {taipeiWeek} from '../src/calendar.ts';

const origin='https://roomly.example.com',admin='admin@example.com';
const seconds=()=>Math.floor(Date.now()/1000);
const row=(email='member@example.com',synced=seconds())=>({email,status:'connected',shared_calendars:1,calendar_count:2,data:'[{"id":"meeting","summary":"Meeting"}]',synced_at:synced,error_code:null});
const room=()=>({location:'Example room',revision:1,sources_revision:2,feed_revision:3});
const copy=value=>structuredClone(value);

async function withCache(action){
  const old=Object.getOwnPropertyDescriptor(globalThis,'caches');
  const mock={entries:new Map(),names:[],matches:[],puts:[],hooks:{},response:null};
  const cache={
    async match(request){
      mock.matches.push(request);if(mock.hooks.match)await mock.hooks.match(request);
      if(mock.response)return mock.response.clone();
      return mock.entries.get(request.url)?.clone();
    },
    async put(request,response){
      mock.puts.push({request,response:response.clone()});
      if(mock.hooks.put)await mock.hooks.put(request,response);
      mock.entries.set(request.url,response.clone());
    }
  };
  Object.defineProperty(globalThis,'caches',{configurable:true,value:{async open(name){mock.names.push(name);if(mock.hooks.open)await mock.hooks.open(name);return cache;}}});
  try{return await action(mock);}finally{if(old)Object.defineProperty(globalThis,'caches',old);else delete globalThis.caches;}
}

function helperFixture(){
  let current=room(),rows=[row()],reads=0;
  const env={DB:{},APP_ORIGIN:origin};
  const invoke=()=>cachedCalendarFeed(env,taipeiWeek(),copy(current),async()=>copy(current),async()=>{reads++;return copy(rows);});
  return {env,invoke,get current(){return current;},set current(value){current=value;},get rows(){return rows;},set rows(value){rows=value;},get reads(){return reads;}};
}

async function workerFixture(){
  const sqlite=new DatabaseSync(':memory:');
  for(const name of readdirSync(new URL('../migrations/',import.meta.url)).filter(name=>/^\d+.*\.sql$/.test(name)).sort())sqlite.exec(readFileSync(new URL('../migrations/'+name,import.meta.url),'utf8'));
  const queries=[];
  const DB={prepare(sql){
    const statement=sqlite.prepare(sql);let values=[];
    return {bind(...v){values=v;return this;},async first(){queries.push(sql);return statement.get(...values)||null;},async all(){queries.push(sql);return {results:statement.all(...values)};},async run(){queries.push(sql);return {meta:{changes:statement.run(...values).changes}};}};
  },async batch(statements){sqlite.exec('BEGIN');try{const values=await Promise.all(statements.map(statement=>statement.run()));sqlite.exec('COMMIT');return values;}catch(error){sqlite.exec('ROLLBACK');throw error;}}};
  const env={DB,APP_ORIGIN:origin,ADMIN_EMAIL:admin,GOOGLE_CLIENT_ID:'client',GOOGLE_CLIENT_SECRET:'test-secret',CALENDAR_TOKEN_KEY:'11'.repeat(32),EMAIL:{async send(){}},ASSETS:{async fetch(){return new Response('asset');}}};
  const identities=[['admin',admin,'admin','approved'],['member','member@example.com','member','approved'],['pending','pending@example.com','member','pending']];
  const cookies={};
  for(const [sub,email,role,status] of identities){
    sqlite.prepare('INSERT INTO members(sub,email,name,role,status,requested_at) VALUES(?,?,?,?,?,?)').run(sub,email,'Name',role,status,seconds());
    const token=await hash('fixture-session-'+sub);cookies[sub]='roomly_session='+token;
    sqlite.prepare('INSERT INTO sessions(hash,member_sub,expires_at) VALUES(?,?,?)').run(await hash(token),sub,seconds()+30*86400);
  }
  sqlite.prepare('UPDATE room_settings SET location=? WHERE id=1').run('Example room');
  const week=taipeiWeek();
  for(const sub of ['admin','member']){
    sqlite.prepare("INSERT INTO calendar_connections(member_sub,refresh_cipher,version,status,updated_at,shared_calendars) VALUES(?,?,?,'connected',?,1)").run(sub,'ENCRYPTED_PRIVATE_GRANT','version-'+sub,seconds());
    sqlite.prepare('INSERT INTO calendar_snapshots(member_sub,week_start,room_revision,connection_version,data,synced_at,retry_at,calendar_count) VALUES(?,?,1,?,?,?,?,2)').run(sub,week,'version-'+sub,row().data,seconds(),seconds()+600);
  }
  const handler=createHandler(async credential=>JSON.parse(credential));
  const get=(path='calendar/feed?cached=1',sub='admin',headers={})=>handler.fetch(new Request(origin+'/roomly/api/'+path,{headers:{Cookie:sub?cookies[sub]:'',...headers}}),env,{waitUntil(){}});
  const feedReads=()=>queries.filter(sql=>/FROM members m LEFT JOIN calendar_connections/.test(sql)).length;
  return {sqlite,env,queries,cookies,get,feedReads,week};
}

test('a shared generation saves one D1 feed read and contains no viewer/session/token context',async()=>withCache(async cache=>{
  const f=helperFixture(),first=await f.invoke(),second=await f.invoke();
  assert.equal(first.cache,'MISS');assert.equal(second.cache,'HIT');assert.equal(f.reads,1);assert.deepEqual(second.rows,first.rows);
  assert.ok(cache.names.every(name=>name==='roomly-feed-v1'));
  const {request,response}=cache.puts[0];assert.equal(request.method,'GET');assert.equal([...request.headers].length,0);
  assert.match(request.url,/\/roomly\/api\/internal\/feed-cache\/[a-f0-9]{64}$/);assert.ok(!request.url.includes('Example'));assert.ok(!request.url.includes('@'));
  assert.equal(response.headers.get('Cache-Control'),'public, max-age=60');assert.equal(response.headers.get('Set-Cookie'),null);
  const stored=await response.json();assert.deepEqual(Object.keys(stored).sort(),['expiresAt','key','rows']);assert.equal(stored.expiresAt,seconds()+60);
  assert.deepEqual(stored.rows,first.rows);for(const forbidden of ['isAdmin','roomly_session','refresh_cipher','member_sub','ENCRYPTED_PRIVATE_GRANT'])assert.ok(!JSON.stringify(stored).includes(forbidden));
}));

test('cache failures and invalid entries fall back to current D1 rows',async()=>{
  for(const mode of ['open','match','put','json','wrong-key','expired','future-expiry','extra-private-field','non-array-data','invalid-data','set-cookie','non-200'])await withCache(async cache=>{
    const f=helperFixture();
    if(['open','match','put'].includes(mode))cache.hooks[mode]=async()=>{throw Error('cache unavailable');};
    else{
      await f.invoke();const key=cache.puts[0].request.url;let body=await cache.puts[0].response.json(),headers={},status=200;
      if(mode==='json')body='unparseable';
      if(mode==='wrong-key')body.key+='another';
      if(mode==='expired')body.expiresAt=seconds();
      if(mode==='future-expiry')body.expiresAt=seconds()+61;
      if(mode==='extra-private-field')body.rows[0].refresh_cipher='PRIVATE';
      if(mode==='non-array-data')body.rows[0].data='{"private":"value"}';
      if(mode==='invalid-data')body.rows[0].data='not-json';
      if(mode==='set-cookie')headers['Set-Cookie']='private=value';
      if(mode==='non-200')status=206;
      cache.entries.set(key,new Response(typeof body==='string'?body:JSON.stringify(body),{headers,status}));
    }
    const before=f.reads,result=await f.invoke();assert.deepEqual(result.rows,f.rows,mode);assert.equal(f.reads,before+1,mode);assert.notEqual(result.cache,'HIT',mode);
  });
});

test('a revision change during a miss cannot publish old rows under the new generation',async()=>withCache(async cache=>{
  const f=helperFixture();let reads=0;
  const result=await cachedCalendarFeed(f.env,taipeiWeek(),f.current,async()=>copy(f.current),async()=>{
    reads++;const before=copy(f.rows);if(reads===1){f.current={...f.current,sources_revision:f.current.sources_revision+1};f.rows=[];}return before;
  });
  assert.deepEqual(result.rows,[]);assert.equal(reads,2);assert.equal(cache.puts.length,1);assert.deepEqual((await cache.puts[0].response.json()).rows,[]);
}));

test('a revision change during a hit or delayed put retries with the current source set',async()=>{
  for(const during of ['match','put'])await withCache(async cache=>{
    const f=helperFixture();if(during==='match')await f.invoke();
    cache.hooks[during]=async()=>{delete cache.hooks[during];f.current={...f.current,sources_revision:f.current.sources_revision+1};f.rows=[];};
    const result=await f.invoke();assert.deepEqual(result.rows,[],during);assert.equal(result.room.sources_revision,f.current.sources_revision,during);
    assert.deepEqual((await cache.puts.at(-1).response.json()).rows,[],during);
  });
});

test('TTL expiry reloads D1 and rapid generation changes fail closed without caching mismatched rows',async()=>withCache(async cache=>{
  const realNow=Date.now;let clock=Date.parse('2026-10-07T12:00:00+08:00');Date.now=()=>clock;
  try{
    const f=helperFixture();await f.invoke();clock+=59000;assert.equal((await f.invoke()).cache,'HIT');clock+=1000;assert.equal((await f.invoke()).cache,'MISS');assert.equal(f.reads,2);
    cache.entries.clear();cache.puts.length=0;let current=copy(f.current);
    await assert.rejects(cachedCalendarFeed(f.env,taipeiWeek(),current,async()=>{current={...current,feed_revision:current.feed_revision+1};return current;},async()=>[row()]),/changed during read/);
    assert.equal(cache.puts.length,0);
  }finally{Date.now=realNow;}
}));

test('parallel cold requests share the D1 fill without sharing response identities',async()=>withCache(async()=>{
  const f=helperFixture();let reads=0,release;const gate=new Promise(resolve=>{release=resolve;});
  const invoke=()=>cachedCalendarFeed(f.env,taipeiWeek(),f.current,async()=>f.current,async()=>{reads++;await gate;return f.rows;});
  const requests=Array.from({length:20},invoke);await new Promise(resolve=>setImmediate(resolve));release();
  const results=await Promise.all(requests);assert.equal(reads,1);assert.ok(results.every(result=>JSON.stringify(result.rows)===JSON.stringify(f.rows)));
}));

test('different deployment origins and calendar weeks never share a cache entry',async()=>withCache(async cache=>{
  const f=helperFixture(),week=taipeiWeek(),following=new Date(Date.parse(week+'T00:00:00Z')+7*86400000).toISOString().slice(0,10);
  let reads=0;
  const get=(appOrigin,day,email)=>cachedCalendarFeed({...f.env,APP_ORIGIN:appOrigin},day,f.current,async()=>f.current,async()=>{reads++;return [row(email)];});
  const one=await get(origin,week,'first@example.com'),two=await get(origin,following,'following@example.com'),three=await get('https://second.example.com',week,'second@example.com');
  assert.equal(reads,3);assert.equal(cache.entries.size,3);assert.equal(one.rows[0].email,'first@example.com');assert.equal(two.rows[0].email,'following@example.com');assert.equal(three.rows[0].email,'second@example.com');
  const again=await get(origin,week,'must-not-load@example.com');assert.equal(again.cache,'HIT');assert.equal(again.rows[0].email,'first@example.com');assert.equal(reads,3);
}));

test('approved viewers share cached source rows, while every response retains its own identity and private headers',async()=>withCache(async cache=>{
  const f=await workerFixture(),owner=await f.get(),first=await owner.json();assert.equal(owner.status,200);assert.equal(owner.headers.get('X-Roomly-Cache'),'MISS');assert.equal(first.email,admin);assert.equal(first.isAdmin,true);
  const reads=f.feedReads();
  for(let i=0;i<5;i++){
    const response=await f.get('calendar/feed?cached=1','member',{Range:'bytes=0-10','If-None-Match':'anything'}),feed=await response.json();
    assert.equal(response.status,200);assert.equal(response.headers.get('X-Roomly-Cache'),'HIT');assert.equal(response.headers.get('Cache-Control'),'private, no-store');assert.equal(response.headers.get('Set-Cookie'),null);
    assert.equal(feed.email,'member@example.com');assert.equal(feed.isAdmin,false);assert.deepEqual(feed.sources,first.sources);
    assert.equal(response.headers.get('X-Roomly-Cache').includes('/'),false);
  }
  assert.equal(f.feedReads(),reads);assert.ok(cache.matches.every(request=>[...request.headers].length===0));
  const key=cache.puts[0].request.url;
  const raw=await f.get(key.slice((origin+'/roomly/api/').length),null);assert.equal(raw.status,401);assert.ok(!(await raw.text()).includes('meeting'));
  assert.equal((await f.get(key.slice((origin+'/roomly/api/').length),'admin')).status,404);
}));

test('unauthorized, expired and revoked viewers cannot access cache, including a revoke during match',async()=>withCache(async cache=>{
  const f=await workerFixture();await f.get();const before=cache.matches.length;
  assert.equal((await f.get('calendar/feed?cached=1',null)).status,401);assert.equal((await f.get('calendar/feed?cached=1','pending')).status,403);
  f.sqlite.prepare("UPDATE sessions SET expires_at=? WHERE member_sub='member'").run(seconds());assert.equal((await f.get('calendar/feed?cached=1','member')).status,401);assert.equal(cache.matches.length,before);
  f.sqlite.prepare("UPDATE sessions SET expires_at=? WHERE member_sub='member'").run(seconds()+1000);
  cache.hooks.match=async()=>{delete cache.hooks.match;f.sqlite.exec("UPDATE members SET status='rejected' WHERE sub='member'");};
  const revoked=await f.get('calendar/feed?cached=1','member');assert.equal(revoked.status,403);assert.ok(!(await revoked.text()).includes('meeting'));
}));

test('source withdrawal, success timestamps, sync errors, grant changes and room changes invalidate cached data',async()=>withCache(async()=>{
  const f=await workerFixture();await f.get();
  const changed=async mutation=>{mutation();const response=await f.get();assert.equal(response.status,200);assert.equal(response.headers.get('X-Roomly-Cache'),'MISS');return response.json();};
  let feed=await changed(()=>f.sqlite.exec("UPDATE members SET status='rejected' WHERE sub='member'"));assert.deepEqual(feed.sources.map(source=>source.email),[admin]);
  feed=await changed(()=>f.sqlite.prepare("UPDATE calendar_snapshots SET synced_at=synced_at+1 WHERE member_sub='admin'").run());assert.equal(feed.sources[0].syncedAt,seconds()+1);
  feed=await changed(()=>f.sqlite.exec("UPDATE calendar_snapshots SET error_code='SYNC_FAILED' WHERE member_sub='admin'"));assert.equal(feed.sources[0].state,'error');
  feed=await changed(()=>f.sqlite.exec("UPDATE calendar_connections SET status='reauthorize' WHERE member_sub='admin'"));assert.equal(feed.sources[0].state,'reauthorize');assert.deepEqual(feed.sources[0].events,[]);
  feed=await changed(()=>f.sqlite.exec("UPDATE room_settings SET location='Changed room',revision=revision+1 WHERE id=1"));assert.equal(feed.location,'Changed room');assert.deepEqual(feed.sources[0].events,[]);
}));

test('a cached source crossing the stale boundary is evaluated at response time',async()=>withCache(async()=>{
  const realNow=Date.now;let clock=Date.parse('2026-10-07T12:00:00+08:00');Date.now=()=>clock;
  try{
    const f=await workerFixture();f.sqlite.prepare('UPDATE calendar_snapshots SET synced_at=?').run(seconds()-1199);
    const before=await f.get();assert.equal((await before.json()).sources[0].state,'ready');clock+=2000;
    const after=await f.get();assert.equal(after.headers.get('X-Roomly-Cache'),'HIT');assert.equal((await after.json()).sources[0].state,'stale');
  }finally{Date.now=realNow;}
}));
