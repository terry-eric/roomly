import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {communitySyncAPI,consumeCommunityQueue,communityRange} from '../src/community/sync.ts';
import {sealCommunityToken,openCommunityToken} from '../src/community/auth.ts';
import {CommunityError} from '../src/community/common.ts';
import {minimizeEvent} from '../src/calendar.ts';

const origin='https://public-roomly.example',space='a'.repeat(64),otherSpace='b'.repeat(64),seconds=()=>Math.floor(Date.now()/1000);
const day=new Date(Date.now()+8*3600000).toISOString().slice(0,10),offset=n=>new Date(Date.parse(day+'T00:00:00Z')+n*86400000).toISOString().slice(0,10),range={start:day,end:offset(5)};
const eventScope='https://www.googleapis.com/auth/calendar.events.readonly',listScope='https://www.googleapis.com/auth/calendar.calendarlist.readonly',scope='openid email '+eventScope+' '+listScope;
const json=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});
const meeting=(extra={})=>({id:'event',iCalUID:'meeting-uid',summary:'公開小組會議',location:'主會議室',start:{dateTime:day+'T10:00:00+08:00'},end:{dateTime:day+'T11:00:00+08:00'},description:'NEVER_CACHE_PRIVATE_TEXT',attachments:[{fileUrl:'private'}],...extra});
const defaultGoogle=url=>url.hostname==='oauth2.googleapis.com'?json({access_token:'test-token',scope}):url.pathname.endsWith('/calendarList')?json({items:[{id:'primary-real-address@example.test',primary:true,accessRole:'owner'}]}):json({accessRole:'owner',items:[meeting()]});
function fixture(){
  const sqlite=new DatabaseSync(':memory:');sqlite.exec('PRAGMA foreign_keys=ON');sqlite.exec(readFileSync(new URL('../migrations-community/0001_spaces.sql',import.meta.url),'utf8'));
  const operations=[];
  const DB={prepare(sql){const statement=sqlite.prepare(sql);let values=[];return {bind(...args){values=args;return this;},async first(){operations.push({kind:'first',sql});return statement.get(...values)||null;},async all(){operations.push({kind:'all',sql});return {results:statement.all(...values)};},run(){const result=statement.run(...values);operations.push({kind:'run',sql});return {success:true,meta:{changes:result.changes}};}};},async batch(statements){sqlite.exec('BEGIN');try{const results=statements.map(statement=>statement.run());sqlite.exec('COMMIT');return results;}catch(error){sqlite.exec('ROLLBACK');throw error;}}};
  const queued=[],env={PUBLIC_DB:DB,PUBLIC_SYNC_QUEUE:{async send(value){queued.push(value);}},PUBLIC_APP_ORIGIN:origin,PUBLIC_CALENDAR_TOKEN_KEY:'31'.repeat(32),GOOGLE_CLIENT_ID:'public-client',GOOGLE_CLIENT_SECRET:'fixture-secret',ASSETS:{async fetch(){return new Response('asset');}}};
  function member(sub='owner',email=sub+'@example.test',name=sub){sqlite.prepare('INSERT OR IGNORE INTO community_members(sub,email,name,email_authoritative,created_at) VALUES(?,?,?,1,?)').run(sub,email,name,seconds());return {sub,email,name,email_authoritative:1,sessionHash:'test',sessionExpiresAt:seconds()+300};}
  const owner=member(),outsider=member('outsider');
  function addSpace(id=space,by=owner,location='主會議室'){sqlite.prepare('INSERT INTO community_spaces(id,name,location,owner_sub,created_at) VALUES(?,?,?,?,?)').run(id,'共用空間',location,by.sub,seconds());sqlite.prepare("INSERT INTO community_memberships(space_id,member_sub,role,joined_at) VALUES(?,?,'owner',?)").run(id,by.sub,seconds());}
  function join(sub,id=space){member(sub);sqlite.prepare("INSERT INTO community_memberships(space_id,member_sub,role,joined_at) VALUES(?,?,'member',?)").run(id,sub,seconds());return member(sub);}
  addSpace();addSpace(otherSpace,outsider,'另一個會議室');
  async function connect(sub='owner',version='version-'+sub,granted=scope){sqlite.prepare("INSERT OR REPLACE INTO community_grants(member_sub,refresh_cipher,version,status,scope,updated_at) VALUES(?,?,?,'connected',?,?)").run(sub,await sealCommunityToken(env,sub,'refresh-'+sub),version,granted,seconds());}
  function snapshot(sub='owner',events=[meeting()],at=seconds()-100){sqlite.prepare('INSERT OR REPLACE INTO community_snapshots(space_id,member_sub,space_revision,grant_version,range_start,range_end,data,calendar_count,synced_at) VALUES(?,?,1,?,?,?,?,1,?)').run(space,sub,'version-'+sub,range.start,range.end,JSON.stringify(events.map(event=>minimizeEvent(event,'主會議室'))),at);}
  const call=async(action,options={},by=owner,id=space)=>{const request=new Request(origin+'/roomly/api/spaces/'+id+'/'+action,options);try{return await communitySyncAPI(request,env,by,id,action);}catch(error){if(error instanceof CommunityError)return json({error:error.message},error.status);throw error;}};
  const sync=(body=range,by=owner,id=space)=>call('sync',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(body)},by,id);
  async function getFeed(by=owner,id=space,window=range){const request=new Request(origin+'/roomly/api/spaces/'+id+'/feed?'+new URLSearchParams(window));try{return await communitySyncAPI(request,env,by,id,'feed');}catch(error){if(error instanceof CommunityError)return json({error:error.message},error.status);throw error;}}
  async function consume(body,attempts=1){let acked=0,retry;await consumeCommunityQueue({messages:[{body,attempts,ack(){acked++;},retry(value){retry=value;}}]},env,{waitUntil(){}});return {acked,retry};}
  async function drain(){let messages=0;while(queued.length){assert.ok(messages++<25,'continuation is bounded');const outcome=await consume(queued.shift());assert.equal(outcome.acked,1);assert.equal(outcome.retry,undefined);}return messages;}
  return {sqlite,env,operations,queued,owner,outsider,member,join,addSpace,connect,snapshot,call,sync,getFeed,consume,drain};
}
async function mockGoogle(provider,action){const original=globalThis.fetch,calls=[];globalThis.fetch=async(input,options={})=>{const url=new URL(input);calls.push({url,options});return provider(url,options,calls);};try{return await action(calls);}finally{globalThis.fetch=original;}}
function mutateAfterFeedRead(f,mutation,always=false){
  const prepare=f.env.PUBLIC_DB.prepare.bind(f.env.PUBLIC_DB);let reads=0;
  f.env.PUBLIC_DB.prepare=sql=>{const statement=prepare(sql);if(sql.includes('s.name AS space_name')){const all=statement.all.bind(statement);statement.all=async()=>{const result=await all();if(always||reads===0)await mutation();reads++;return result;};}return statement;};
  return ()=>reads;
}

test('range boundaries use real Taipei days, an exclusive end and bounded windows',()=>{
  assert.deepEqual(communityRange(range.start,range.end),range);assert.deepEqual(communityRange(offset(-63),offset(-32)),{start:offset(-63),end:offset(-32)});
  for(const [start,end] of [[day,day],[day,offset(32)],[offset(-64),offset(-63)],[offset(63),offset(65)],['2026-02-30','2026-03-01'],['bad',range.end]])assert.throws(()=>communityRange(start,end),error=>error.status===400);
});

test('public grant ciphertext cannot be opened for another user or deployment key',async()=>{
  const f=fixture(),cipher=await sealCommunityToken(f.env,'owner','private-refresh');assert.equal(await openCommunityToken(f.env,'owner',cipher),'private-refresh');
  await assert.rejects(openCommunityToken(f.env,'outsider',cipher));await assert.rejects(openCommunityToken({...f.env,PUBLIC_CALENDAR_TOKEN_KEY:'52'.repeat(32)},'owner',cipher));assert.ok(!cipher.includes('private-refresh'));
});

test('feeds and date changes only read cache; missing ranges never enqueue or contact Google',async()=>{
  const f=fixture();await f.connect();f.snapshot();
  await mockGoogle(()=>{throw Error('no automatic network');},async calls=>{
    const feed=await (await f.getFeed()).json();assert.equal(feed.events.length,1);assert.equal(feed.sources[0].state,'ready');assert.equal(feed.mode,'manual');
    const missing=await (await f.getFeed(f.owner,space,{start:offset(6),end:offset(11)})).json();assert.equal(missing.events.length,0);assert.equal(missing.sources[0].state,'missing');assert.equal(missing.rangeMissing,true);
    assert.equal(calls.length,0);assert.equal(f.queued.length,0);assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM community_sync_jobs').get().n,0);
    assert.ok(!JSON.stringify(feed).includes('NEVER_CACHE_PRIVATE_TEXT'));assert.ok(!JSON.stringify(feed).includes('attachments'));
  });
});

test('space isolation rejects other members, other job IDs and forged origin syncs',async()=>{
  const f=fixture();await f.connect();f.snapshot();
  assert.equal((await f.getFeed(f.outsider)).status,403);assert.equal((await f.sync(range,f.outsider)).status,403);
  const job=(await (await f.sync()).json()).job;assert.equal((await f.call('jobs/'+job.id,{},f.outsider)).status,403);assert.equal((await f.call('jobs/'+job.id,{},f.outsider,otherSpace)).status,404);
  assert.equal((await f.call('sync',{method:'POST',headers:{Origin:'https://evil.test','Content-Type':'application/json'},body:JSON.stringify(range)})).status,403);
  assert.equal((await f.call('sync')).status,405);assert.equal((await f.getFeed(f.owner,otherSpace)).status,403);
});

test('manual POST only admits durable work; polling pending jobs and feeds performs zero Google reads',async()=>{
  const f=fixture();await f.connect();
  await mockGoogle(()=>{throw Error('not yet consuming');},async calls=>{
    const response=await f.sync();assert.equal(response.status,202);const job=(await response.json()).job;assert.deepEqual({...job,id:undefined},{id:undefined,status:'queued',total:1,completed:0,succeeded:0,failed:0});assert.equal(f.queued.length,1);
    assert.equal((await (await f.call('jobs/'+job.id)).json()).job.status,'queued');assert.equal((await (await f.getFeed()).json()).sources[0].state,'syncing');assert.equal(calls.length,0);assert.equal(f.queued.length,1);
  });
});

test('full calendar and event pagination succeeds before timestamps advance, including secondary groups',async()=>{
  const f=fixture();await f.connect();
  const provider=(url)=>{
    if(url.hostname==='oauth2.googleapis.com')return json({access_token:'a',scope});
    if(url.pathname.endsWith('/calendarList'))return url.searchParams.get('pageToken')?json({items:[{id:'new-group',accessRole:'reader'}]}):json({items:[{id:'primary',primary:true,accessRole:'owner'}],nextPageToken:'next-list'});
    const group=url.pathname.includes('new-group');
    return url.searchParams.get('pageToken')?json({items:[meeting({id:'other-copy',summary:group?'更新後名稱':'原始名稱',sequence:group?2:1})]}):json({items:[],nextPageToken:'next-events'});
  };
  await mockGoogle(provider,async calls=>{
    const job=(await (await f.sync()).json()).job;assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM community_snapshots').get().n,0);await f.drain();
    const status=(await (await f.call('jobs/'+job.id)).json()).job;assert.equal(status.status,'complete');assert.equal(status.succeeded,1);assert.equal(status.completed,1);
    const feed=await (await f.getFeed()).json();assert.equal(feed.sources[0].state,'ready');assert.equal(feed.sources[0].calendarCount,2);assert.ok(feed.sources[0].syncedAt>0);assert.equal(feed.events.length,1);assert.equal(feed.events[0].summary,'更新後名稱');
    assert.equal(calls.filter(call=>call.url.pathname.endsWith('/calendarList')).length,2);assert.equal(calls.filter(call=>call.url.pathname.endsWith('/events')).length,4);assert.ok(!calls.some(call=>call.url.pathname.endsWith('/watch')));
    for(const call of calls.filter(call=>call.url.pathname.endsWith('/events'))){assert.equal(call.url.searchParams.get('singleEvents'),'true');assert.equal(call.url.searchParams.get('timeMax'),range.end+'T00:00:00+08:00');}
  });
});

test('successful zero-event response is real success, including omitted empty items',async()=>{
  const f=fixture();await f.connect();f.snapshot();
  await mockGoogle(url=>url.hostname==='oauth2.googleapis.com'?json({access_token:'a'}):json({}),async()=>{
    await f.sync();await f.drain();const row=f.sqlite.prepare('SELECT * FROM community_snapshots').get();assert.equal(row.data,'[]');assert.ok(row.synced_at>seconds()-10);assert.equal(row.error_code,null);
    const feed=await (await f.getFeed()).json();assert.equal(feed.events.length,0);assert.equal(feed.sources[0].state,'ready');assert.equal(feed.rangeMissing,false);
  });
});

test('transient Google error retains last good events and success timestamp, exposes only fixed error code',async()=>{
  const f=fixture();await f.connect();const old=seconds()-200;f.snapshot('owner',[meeting()],old);
  await mockGoogle(url=>url.hostname==='oauth2.googleapis.com'?json({access_token:'a'}):url.pathname.endsWith('/calendarList')?json({items:[]}):json({error:{message:'secret-person@other-tenant.test calendar detail'}},503),async calls=>{
    const job=(await (await f.sync()).json()).job;await f.drain();const row=f.sqlite.prepare('SELECT data,synced_at,error_code FROM community_snapshots').get();assert.equal(row.synced_at,old);assert.equal(row.error_code,'PROVIDER_UNAVAILABLE');assert.equal(JSON.parse(row.data).length,1);
    const feed=await (await f.getFeed()).json();assert.equal(feed.events.length,1);assert.equal(feed.sources[0].state,'error');assert.equal(feed.sources[0].syncedAt,old);assert.ok(!JSON.stringify(feed).includes('other-tenant'));
    assert.equal((await (await f.call('jobs/'+job.id)).json()).job.status,'partial');const count=calls.length;await f.getFeed();await f.call('jobs/'+job.id);assert.equal(calls.length,count);assert.equal(f.queued.length,0);
  });
});

test('all visible members contribute stats; unauthorized or partially authorized sources make a partial job',async()=>{
  const f=fixture();await f.connect();f.join('missing');f.join('partial');await f.connect('partial','version-partial',eventScope);
  await mockGoogle(defaultGoogle,async calls=>{
    const job=(await (await f.sync()).json()).job;assert.equal(job.total,3);assert.equal(job.failed,2);await f.drain();
    const final=(await (await f.call('jobs/'+job.id)).json()).job;assert.deepEqual({...final,id:undefined},{id:undefined,status:'partial',total:3,completed:3,succeeded:1,failed:2});
    const feed=await (await f.getFeed()).json();assert.deepEqual(feed.sources.map(source=>source.state),['unauthorized','ready','reauthorize']);assert.equal(calls.filter(call=>call.url.hostname==='oauth2.googleapis.com').length,1);
    assert.equal(feed.sources.find(source=>source.email==='partial@example.test').syncedAt,0);
  });
});

test('invalid refresh grants are reauthorization failures and never zero-event success',async()=>{
  const f=fixture();await f.connect();f.snapshot();
  await mockGoogle(()=>json({error:'invalid_grant',error_description:'private provider text'},400),async()=>{
    const job=(await (await f.sync()).json()).job;await f.drain();assert.equal(f.sqlite.prepare('SELECT status FROM community_grants').get().status,'reauthorize');assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM community_snapshots').get().n,0);
    assert.equal((await (await f.getFeed()).json()).sources[0].state,'reauthorize');assert.equal((await (await f.call('jobs/'+job.id)).json()).job.succeeded,0);
  });
});

test('disconnect or reauthorization during a provider request cannot restore old snapshots or invalidate a new grant',async()=>{
  for(const change of ['disconnect','reauthorize','newgrant-before-error']){
    const f=fixture();await f.connect();f.snapshot();let changed=false;
    await mockGoogle(async url=>{
      if(!changed&&url.hostname==='oauth2.googleapis.com'){
        changed=true;f.sqlite.prepare('DELETE FROM community_snapshots WHERE member_sub=?').run('owner');
        if(change==='disconnect')f.sqlite.prepare('DELETE FROM community_grants WHERE member_sub=?').run('owner');else await f.connect('owner','new-version');
        if(change==='newgrant-before-error')return json({error:'invalid_grant'},400);
      }return defaultGoogle(url);
    },async()=>{
      const job=(await (await f.sync()).json()).job;await f.drain();assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM community_snapshots').get().n,0,change);const final=(await (await f.call('jobs/'+job.id)).json()).job;assert.equal(final.succeeded,0);assert.equal(final.status,'partial');
      if(change!=='disconnect')assert.equal(f.sqlite.prepare('SELECT status FROM community_grants').get().status,'connected');
    });
  }
});

test('member removal and immediate rejoin cannot resurrect a source from an old requested job',async()=>{
  const f=fixture(),member=f.join('source');await f.connect('source');let changed=false;
  await mockGoogle(url=>{
    if(!changed){changed=true;f.sqlite.prepare("UPDATE community_sync_items SET status='skipped',error_code='SOURCE_REMOVED' WHERE member_sub='source' AND status IN ('pending','running')").run();f.sqlite.prepare('DELETE FROM community_memberships WHERE space_id=? AND member_sub=?').run(space,'source');f.join('source');}
    return defaultGoogle(url);
  },async()=>{await f.sync();await f.drain();assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM community_snapshots WHERE member_sub=?').get(member.sub).n,0);assert.equal((await (await f.getFeed()).json()).sources.find(source=>source.email===member.email).syncedAt,0);});
});

test('room revision changes invalidate cache and cancel in-flight commits',async()=>{
  const f=fixture();await f.connect();f.snapshot();let changed=false;
  await mockGoogle(url=>{if(!changed){changed=true;f.sqlite.prepare('UPDATE community_spaces SET location=?,revision=revision+1 WHERE id=?').run('另一個地方',space);}return defaultGoogle(url);},async()=>{
    await f.sync();await f.drain();const feed=await (await f.getFeed()).json();assert.equal(feed.space.location,'另一個地方');assert.equal(feed.events.length,0);assert.equal(feed.sources[0].syncedAt,0);
    assert.equal(f.sqlite.prepare('SELECT synced_at FROM community_snapshots').get().synced_at<seconds()-50,true);assert.equal(f.sqlite.prepare('SELECT status FROM community_sync_items').get().status,'skipped');
  });
});

test('cross-source recurrence dedupe preserves instances and merges moved-event copies by original start',async()=>{
  const f=fixture();await f.connect();f.join('second');await f.connect('second');
  const original={dateTime:day+'T10:00:00+08:00'},a=meeting({recurringEventId:'series',originalStartTime:original,sequence:1}),moved=meeting({id:'copy',recurringEventId:'series',originalStartTime:{dateTime:new Date(Date.parse(original.dateTime)).toISOString()},start:{dateTime:day+'T12:00:00+08:00'},end:{dateTime:day+'T13:00:00+08:00'},sequence:2}),next=meeting({id:'next',recurringEventId:'series',originalStartTime:{dateTime:offset(1)+'T10:00:00+08:00'},start:{dateTime:offset(1)+'T10:00:00+08:00'},end:{dateTime:offset(1)+'T11:00:00+08:00'}});
  f.snapshot('owner',[a,next]);f.snapshot('second',[moved,next]);
  await mockGoogle(()=>{throw Error('cache only');},async()=>{const feed=await (await f.getFeed()).json();assert.equal(feed.events.length,2);assert.equal(feed.events[0].start.dateTime,moved.start.dateTime);assert.equal(feed.events[1].start.dateTime,next.start.dateTime);});
});

test('concurrent queue deliveries respect a durable lease and only one provider read proceeds',async()=>{
  const f=fixture();await f.connect();const job=(await (await f.sync()).json()).job;f.queued.length=0;let release,started;
  const entered=new Promise(resolve=>started=resolve),blocked=new Promise(resolve=>release=resolve);
  await mockGoogle(async url=>{if(url.hostname==='oauth2.googleapis.com'){started();await blocked;}return defaultGoogle(url);},async calls=>{
    const first=f.consume({jobId:job.id});await entered;const duplicate=await f.consume({jobId:job.id});assert.equal(duplicate.acked,0);assert.equal(duplicate.retry.delaySeconds,30);assert.equal(calls.length,1);release();assert.equal((await first).acked,1);assert.equal((await (await f.call('jobs/'+job.id)).json()).job.status,'complete');
  });
});

test('manual cooldown is global per requester and active duplicate uses one source set',async()=>{
  const f=fixture();await f.connect();const first=(await (await f.sync()).json()).job,duplicate=(await (await f.sync()).json()).job;assert.equal(first.id,duplicate.id);assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM community_sync_items').get().n,1);
  assert.equal(f.queued.length,1,'repeated manual POST within cooldown must not add queue messages');
  assert.equal((await f.sync({start:offset(1),end:offset(6)})).status,409);
  f.sqlite.prepare("UPDATE community_sync_jobs SET status='error',finished_at=? WHERE id=?").run(seconds(),first.id);assert.equal((await f.sync()).status,429);
  const ownSecond='c'.repeat(64);f.addSpace(ownSecond);assert.equal((await f.sync(range,f.owner,ownSecond)).status,429);
});

test('simultaneous sync intents across spaces have one atomic per-user admission',async()=>{
  const f=fixture();await f.connect();const second='c'.repeat(64);f.addSpace(second);
  const responses=await Promise.all([f.sync(),f.sync(range,f.owner,second)]);assert.deepEqual(responses.map(response=>response.status).sort(),[202,429]);assert.equal(f.queued.length,1);assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM community_sync_jobs').get().n,1);
});

test('source limits and repeated provider page tokens never publish partial pages as fresh',async()=>{
  for(const variant of ['loop','calendars','bad-items']){
    const f=fixture();await f.connect();const old=seconds()-100;f.snapshot('owner',[meeting()],old);
    await mockGoogle(url=>url.hostname==='oauth2.googleapis.com'?json({access_token:'a'}):url.pathname.endsWith('/calendarList')?variant==='calendars'?json({items:Array.from({length:21},(_,i)=>({id:'group-'+i,accessRole:'reader'}))}):json({items:[]}):variant==='bad-items'?json({items:'private malformed'}):json({items:[meeting()],nextPageToken:'repeated'}),async()=>{
      await f.sync();await f.drain();const row=f.sqlite.prepare('SELECT synced_at,error_code FROM community_snapshots').get();assert.equal(row.synced_at,old);assert.equal(row.error_code,variant==='bad-items'?'PROVIDER_RESPONSE':'SOURCE_LIMIT');assert.equal(f.sqlite.prepare('SELECT status FROM community_sync_items').get().status,'error');
    });
  }
});

test('forged queue bodies and completed jobs never trigger provider calls',async()=>{
  const f=fixture();await f.connect();
  await mockGoogle(()=>{throw Error('no work');},async calls=>{
    for(const body of [{jobId:'bad'},{jobId:'d'.repeat(64),email:'private'},null,[],{jobId:'d'.repeat(64)}])assert.equal((await f.consume(body)).acked,1);
    const job=(await (await f.sync()).json()).job;f.sqlite.prepare("UPDATE community_sync_jobs SET status='partial' WHERE id=?").run(job.id);assert.equal((await f.consume({jobId:job.id})).acked,1);assert.equal(calls.length,0);
  });
});

test('expired leases recover only existing explicit work and transport exhaustion stays terminal',async()=>{
  const f=fixture();await f.connect();const job=(await (await f.sync()).json()).job;f.queued.length=0;
  f.sqlite.prepare("UPDATE community_sync_jobs SET status='running',lease_id='lost',lease_until=? WHERE id=?").run(seconds()-1,job.id);f.sqlite.prepare("UPDATE community_sync_items SET status='running' WHERE job_id=?").run(job.id);
  await mockGoogle(defaultGoogle,async()=>{assert.equal((await f.consume({jobId:job.id},2)).acked,1);assert.equal((await (await f.call('jobs/'+job.id)).json()).job.status,'complete');});
  const g=fixture();await g.connect();const failed=(await (await g.sync()).json()).job;g.queued.length=0;
  g.sqlite.prepare("UPDATE community_sync_jobs SET status='running',lease_id='lost',lease_until=? WHERE id=?").run(seconds()+60,failed.id);
  await mockGoogle(()=>{throw Error('no new retry reads');},async calls=>{
    const waiting=await g.consume({jobId:failed.id},5);assert.equal(waiting.acked,0);assert.ok(waiting.retry.delaySeconds>=60);
    g.sqlite.prepare('UPDATE community_sync_jobs SET lease_until=? WHERE id=?').run(seconds()-1,failed.id);assert.equal((await g.consume({jobId:failed.id},6)).acked,1);
    assert.equal((await (await g.call('jobs/'+failed.id)).json()).job.status,'error');await g.getFeed();await g.call('jobs/'+failed.id);assert.equal(calls.length,0);assert.equal(g.queued.length,0);
  });
});

test('revoked membership and a new grant generation immediately hide cached events',async()=>{
  const f=fixture();f.join('source');await f.connect('source');f.snapshot('source');assert.equal((await (await f.getFeed()).json()).events.length,1);
  await f.connect('source','new-version');let feed=await (await f.getFeed()).json();assert.equal(feed.events.length,0);assert.equal(feed.sources.find(source=>source.email==='source@example.test').syncedAt,0);
  f.sqlite.prepare('DELETE FROM community_memberships WHERE space_id=? AND member_sub=?').run(space,'source');feed=await (await f.getFeed()).json();assert.equal(feed.sources.length,1);assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM community_snapshots').get().n,0);
});

test('source permissions changed after feed rows are read cannot expose removed or revoked events',async()=>{
  for(const mutation of ['remove','disconnect','new-grant','reauthorize']){
    const f=fixture();await f.connect();f.snapshot('owner',[meeting({iCalUID:'owner-valid',summary:'仍授權的會議'})]);f.join('source');await f.connect('source');f.snapshot('source',[meeting({iCalUID:'source-private',summary:'撤除來源的會議'})]);
    const reads=mutateAfterFeedRead(f,async()=>{
      if(mutation==='remove')f.sqlite.prepare('DELETE FROM community_memberships WHERE space_id=? AND member_sub=?').run(space,'source');
      else if(mutation==='disconnect')f.sqlite.prepare('DELETE FROM community_grants WHERE member_sub=?').run('source');
      else if(mutation==='new-grant')await f.connect('source','new-version');
      else f.sqlite.prepare("UPDATE community_grants SET status='reauthorize' WHERE member_sub=?").run('source');
    });
    await mockGoogle(()=>{throw Error('privacy retry cannot synchronize');},async calls=>{
      const response=await f.getFeed();assert.equal(response.status,200,mutation);const feed=await response.json();assert.equal(reads(),2);assert.deepEqual(feed.events.map(event=>event.iCalUID),['owner-valid']);assert.ok(!JSON.stringify(feed).includes('撤除來源的會議'));assert.equal(feed.sources.find(source=>source.email==='owner@example.test').state,'ready');
      if(mutation==='remove')assert.equal(feed.sources.length,1);else assert.equal(feed.sources.find(source=>source.email==='source@example.test').syncedAt,0);assert.equal(calls.length,0);assert.equal(f.queued.length,0);
    });
  }
});

test('rapid repeated permission changes fail closed after bounded feed reads',async()=>{
  const f=fixture();await f.connect();f.snapshot();f.join('source');await f.connect('source');f.snapshot('source');
  const reads=mutateAfterFeedRead(f,()=>f.sqlite.prepare('UPDATE community_memberships SET share_enabled=1-share_enabled WHERE space_id=? AND member_sub=?').run(space,'source'),true);
  const response=await f.getFeed();assert.equal(response.status,409);assert.equal(reads(),2);assert.ok(!await response.text().then(text=>text.includes('公開小組會議')));assert.equal(f.queued.length,0);
});

test('fixed Google requests reject redirects without forwarding credentials or claiming a fresh success',async()=>{
  for(const stage of ['token','list','events']){
    const f=fixture();await f.connect();const old=seconds()-100;f.snapshot('owner',[meeting()],old);
    await mockGoogle((url,options)=>{
      const current=url.hostname==='oauth2.googleapis.com'?'token':url.pathname.endsWith('/calendarList')?'list':'events';
      if(current===stage)return new Response(JSON.stringify({error:'redirect'}),{status:307,headers:{Location:'https://unrelated.example/collect'}});
      return defaultGoogle(url);
    },async calls=>{
      await f.sync();await f.drain();assert.ok(calls.every(call=>call.options.redirect==='manual'));assert.ok(calls.every(call=>['oauth2.googleapis.com','www.googleapis.com'].includes(call.url.hostname)));
      const row=f.sqlite.prepare('SELECT synced_at,error_code FROM community_snapshots').get();assert.equal(row.synced_at,old);assert.equal(row.error_code,'PROVIDER_UNAVAILABLE');assert.equal(f.sqlite.prepare('SELECT status FROM community_sync_items').get().status,'error');
    });
  }
});
