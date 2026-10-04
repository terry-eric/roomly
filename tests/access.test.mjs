import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {generateKeyPair,exportJWK,createLocalJWKSet,SignJWT} from 'jose';
import {createHandler,verifyCredential,hash,deliverNotifications} from '../src/worker.ts';
const origin='https://roomly.example.com', admin='roomly-admin@gmail.com';
function fixture(verifier=async credential=>JSON.parse(credential)){
  const sqlite=new DatabaseSync(':memory:');sqlite.exec(readFileSync(new URL('../migrations/0001_access.sql',import.meta.url),'utf8'));
  sqlite.exec(readFileSync(new URL('../migrations/0002_email_allowlist.sql',import.meta.url),'utf8'));
  sqlite.exec(readFileSync(new URL('../migrations/0003_shared_calendar.sql',import.meta.url),'utf8'));
  sqlite.exec(readFileSync(new URL('../migrations/0004_shared_calendar_list.sql',import.meta.url),'utf8'));
  sqlite.exec(readFileSync(new URL('../migrations/0005_calendar_watch.sql',import.meta.url),'utf8'));
  sqlite.exec(readFileSync(new URL('../migrations/0006_calendar_revision.sql',import.meta.url),'utf8'));
  sqlite.exec(readFileSync(new URL('../migrations/0007_calendar_enqueue_gates.sql',import.meta.url),'utf8'));
  const DB={prepare(sql){let values=[];const statement=sqlite.prepare(sql);return {bind(...v){values=v;return this;},async first(){return statement.get(...values)||null;},async all(){return {results:statement.all(...values)};},async run(){const r=statement.run(...values);return {meta:{changes:r.changes}};}};},async batch(statements){return Promise.all(statements.map(s=>s.run()));}};
  const mail=[],pending=[];
  const env={DB,EMAIL:{async send(message){mail.push(message);}},ASSETS:{async fetch(r){return new Response(new URL(r.url).pathname,{headers:{'Content-Type':'text/html'}});}},APP_ORIGIN:origin,GOOGLE_CLIENT_ID:'client',ADMIN_EMAIL:admin,MAIL_FROM:'roomly@example.com'};
  const handler=createHandler(verifier);
  const call=(path,options={})=>handler.fetch(new Request(origin+'/roomly/'+path,options),env,{waitUntil(p){pending.push(p);}});
  const post=(path,body,cookie='',extra={})=>call(path,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json',Cookie:cookie,...extra},body:JSON.stringify(body)});
  async function login(email='person@example.com',sub='member',extra={}){
    const c=await call('api/challenge'),challenge=await c.json(),nonceCookie=c.headers.getSetCookie()[0].split(';')[0];
    const body={nonce:challenge.nonce,credential:JSON.stringify({email,sub,name:'測試姓名',...extra})};
    const r=await post('api/login',body,nonceCookie);assert.equal(r.status,200);await Promise.all(pending.splice(0));
    return {cookie:r.headers.getSetCookie()[0].split(';')[0],response:r,body,nonceCookie};
  }
  return {sqlite,env,mail,call,post,login};
}
test('real signed identity requires Google issuer, audience, nonce, verified email and valid lifetime',async()=>{
  const {privateKey,publicKey}=await generateKeyPair('RS256');const key={...await exportJWK(publicKey),kid:'test',alg:'RS256'};const keys=createLocalJWKSet({keys:[key]});
  const defaults={sub:'google-sub',email:'USER@gmail.com',email_verified:true,name:'姓名',nonce:'nonce',iss:'https://accounts.google.com',aud:'client',iat:Math.floor(Date.now()/1000),exp:Math.floor(Date.now()/1000)+300};
  const sign=payload=>new SignJWT(payload).setProtectedHeader({alg:'RS256',kid:'test'}).sign(privateKey);
  assert.deepEqual(await verifyCredential(await sign(defaults),'client','nonce',keys),{sub:'google-sub',email:'user@gmail.com',name:'姓名',emailAuthoritative:true});
  assert.equal((await verifyCredential(await sign({...defaults,email:'person@company.com',hd:'company.com'}),'client','nonce',keys)).emailAuthoritative,true);
  assert.equal((await verifyCredential(await sign({...defaults,email:'person@company.com'}),'client','nonce',keys)).emailAuthoritative,false);
  for(const change of [{iss:'https://evil.example'},{aud:'wrong'},{nonce:'other'},{email_verified:false},{sub:''},{exp:1},{iat:1}])await assert.rejects(verifyCredential(await sign({...defaults,...change}),'client','nonce',keys));
  const other=await generateKeyPair('RS256');const forged=await new SignJWT(defaults).setProtectedHeader({alg:'RS256',kid:'test'}).sign(other.privateKey);await assert.rejects(verifyCredential(forged,'client','nonce',keys));
});

test('configured administrator may use authoritative Workspace identity, but third-party email is not auto-approved',async()=>{
  for(const emailAuthoritative of [true,false]){
    const f=fixture();f.env.ADMIN_EMAIL='admin@example.com';
    const user=await f.login('admin@example.com','configured-admin',{emailAuthoritative});
    const me=await (await f.call('api/me',{headers:{Cookie:user.cookie}})).json();
    assert.equal(me.isAdmin,emailAuthoritative);
    assert.equal(me.status,emailAuthoritative?'approved':'pending');
    assert.equal((await f.call('api/admin/members',{headers:{Cookie:user.cookie}})).status,emailAuthoritative?200:403);
  }
});

test('optional email leaves a persisted approval request without retry attempts and reports manual review',async()=>{
  const f=fixture();delete f.env.EMAIL;
  const user=await f.login();
  let notice=f.sqlite.prepare('SELECT state,attempts FROM notifications').get();
  assert.equal(notice.state,'queued');assert.equal(notice.attempts,0);assert.equal(f.mail.length,0);
  const me=await (await f.call('api/me',{headers:{Cookie:user.cookie}})).json();assert.equal(me.notification,'disabled');
  await deliverNotifications(f.env);
  notice=f.sqlite.prepare('SELECT state,attempts FROM notifications').get();assert.equal(notice.attempts,0);
  const owner=await f.login(admin,'admin');
  const members=await (await f.call('api/admin/members',{headers:{Cookie:owner.cookie}})).json();assert.equal(members.members.find(member=>member.sub==='member').notification,null);
  assert.equal((await f.post('api/admin/review',{sub:'member',status:'approved'},owner.cookie)).status,200);
  assert.equal((await (await f.call('api/me',{headers:{Cookie:user.cookie}})).json()).status,'approved');
});
test('anonymous pages and aliases are gated; admin records reject forged cookies',async()=>{
  const f=fixture();for(const path of ['', 'index','index.html','%69ndex.html','admin.html','admin']){
    const r=await f.call(path);assert.equal(r.status,200);assert.equal(await r.text(),'/roomly/auth.html');assert.equal(r.headers.get('Cache-Control'),'private, no-store');
  }
  assert.equal((await f.call('api/admin/members')).status,401);
  assert.equal((await f.call('api/me',{headers:{Cookie:'roomly_session='+'a'.repeat(64)}})).status,401);
  assert.equal((await f.call('privacy.html')).status,200);assert.equal((await f.call('src/worker.ts')).status,404);
});

test('public PWA assets can install before login without exposing protected board or Calendar APIs',async()=>{
 const f=fixture();for(const file of ['manifest.webmanifest','pwa.js','pwa.css','sw.js','offline.html','icon-192.png','icon-512.png','icon-maskable-512.png','apple-touch-icon.png'])assert.equal((await f.call(file)).status,200,file);
 assert.match((await f.call('manifest.webmanifest')).headers.get('Content-Type'),/^application\/manifest\+json/);const sw=await f.call('sw.js');assert.equal(sw.headers.get('Service-Worker-Allowed'),'/roomly/');assert.match(sw.headers.get('Content-Type'),/^application\/javascript/);
 assert.equal((await f.call('api/calendar/feed')).status,401);assert.equal(await (await f.call('')).text(),'/roomly/auth.html');assert.equal((await f.call('scripts/generate-icons.py')).status,404);
});
test('login nonce is hashed, single-use, origin-bound and size-bounded',async()=>{
  const f=fixture(),user=await f.login();
  assert.equal((await f.post('api/login',user.body,user.nonceCookie)).status,401);
  assert.equal((await f.post('api/logout',{},user.cookie,{Origin:'https://evil.example'})).status,403);
  assert.equal((await f.post('api/login',{credential:'x'.repeat(20000)},user.nonceCookie)).status,413);
  const c=await f.call('api/challenge'),body=await c.json();assert.equal(f.sqlite.prepare('SELECT hash FROM login_nonces').get().hash,await hash(body.nonce));
  const token=user.cookie.split('=')[1];assert.equal(f.sqlite.prepare('SELECT hash FROM sessions').get().hash,await hash(token));
  assert.match(user.response.headers.getSetCookie()[0],/HttpOnly; Secure; SameSite=Lax/);
});

test('GIS redirect accepts a signed identity, sends a protected session and still enforces approval',async()=>{
  const {privateKey,publicKey}=await generateKeyPair('RS256'),keys=createLocalJWKSet({keys:[{...await exportJWK(publicKey),kid:'redirect',alg:'RS256'}]});
  const f=fixture((credential,clientId,nonce)=>verifyCredential(credential,clientId,nonce,keys));
  f.env.GOOGLE_LOGIN_REDIRECT='true';
  const c=await f.call('api/challenge'),challenge=await c.json(),nonceCookie=c.headers.getSetCookie()[0].split(';')[0];
  assert.equal(challenge.loginUri,origin+'/roomly/api/login/redirect');assert.match(c.headers.getSetCookie()[0],/HttpOnly; Secure; SameSite=None/);
  const sign=nonce=>new SignJWT({email:'new@gmail.com',email_verified:true,name:'新成員',nonce}).setProtectedHeader({alg:'RS256',kid:'redirect'}).setSubject('redirect-member').setIssuer('https://accounts.google.com').setAudience('client').setIssuedAt().setExpirationTime('5m').sign(privateKey);
  const credential=await sign(challenge.nonce),body=new URLSearchParams({credential,g_csrf_token:'csrf-from-gis'}).toString();
  const options={method:'POST',headers:{Origin:'https://accounts.google.com','Content-Type':'application/x-www-form-urlencoded',Cookie:nonceCookie+'; g_csrf_token=csrf-from-gis'},body};
  const r=await f.call('api/login/redirect',options);assert.equal(r.status,303);assert.equal(r.headers.get('Location'),'/roomly/?login=success');assert.equal(r.headers.get('Cache-Control'),'private, no-store');
  const sessionCookie=r.headers.getSetCookie()[0];assert.match(sessionCookie,/HttpOnly; Secure; SameSite=Lax/);
  const me=await (await f.call('api/me',{headers:{Cookie:sessionCookie.split(';')[0]}})).json();assert.equal(me.status,'pending');assert.equal(me.isAdmin,false);
  assert.equal(await (await f.call('',{headers:{Cookie:sessionCookie.split(';')[0]}})).text(),'/roomly/auth.html');
  const replay=await f.call('api/login/redirect',options);assert.equal(replay.status,303);assert.equal(replay.headers.get('Location'),'/roomly/?login=expired');assert.ok(!replay.headers.getSetCookie().some(cookie=>cookie.startsWith('roomly_session=')));
  const c2=await f.call('api/challenge'),challenge2=await c2.json();
  const wrongNonce=await f.call('api/login/redirect',{...options,headers:{...options.headers,Cookie:c2.headers.getSetCookie()[0].split(';')[0]+'; g_csrf_token=csrf-from-gis'}});assert.equal(wrongNonce.headers.get('Location'),'/roomly/?login=expired');assert.ok(!wrongNonce.headers.getSetCookie().some(cookie=>cookie.startsWith('roomly_session=')));
  assert.equal(f.sqlite.prepare('SELECT hash FROM login_nonces').get().hash,await hash(challenge2.nonce));
});

test('Google redirect rollout requires an explicit true flag; existing deployments keep popup login',async()=>{
  const f=fixture();
  for(const flag of [undefined,'false','True','1']){
    f.env.GOOGLE_LOGIN_REDIRECT=flag;const r=await f.call('api/challenge'),data=await r.json();
    assert.equal(data.loginUri,'');assert.match(r.headers.getSetCookie()[0],/HttpOnly; Secure; SameSite=Lax/);
  }
  f.env.GOOGLE_LOGIN_REDIRECT='true';const r=await f.call('api/challenge'),data=await r.json();
  assert.equal(data.loginUri,origin+'/roomly/api/login/redirect');assert.match(r.headers.getSetCookie()[0],/HttpOnly; Secure; SameSite=None/);
});

test('GIS redirect admits whitelisted signed accounts with opaque, omitted, Google or same-site origins',async()=>{
  const {privateKey,publicKey}=await generateKeyPair('RS256'),keys=createLocalJWKSet({keys:[{...await exportJWK(publicKey),kid:'opaque',alg:'RS256'}]});
  for(const source of ['null',undefined,'https://accounts.google.com',origin]){
    const f=fixture((credential,clientId,nonce)=>verifyCredential(credential,clientId,nonce,keys));f.env.GOOGLE_LOGIN_REDIRECT='true';
    f.sqlite.exec("INSERT INTO members(sub,email,name,role,status,requested_at) VALUES('reviewer','reviewer@gmail.com','Reviewer','admin','approved',1); INSERT INTO email_allowlist(email,status,created_at,updated_at,updated_by) VALUES('allowed@gmail.com','approved',1,1,'reviewer');");
    const challengeResponse=await f.call('api/challenge'),challenge=await challengeResponse.json(),nonceCookie=challengeResponse.headers.getSetCookie()[0].split(';')[0];
    const credential=await new SignJWT({email:'allowed@gmail.com',email_verified:true,nonce:challenge.nonce}).setProtectedHeader({alg:'RS256',kid:'opaque'}).setSubject('allowed-user').setIssuer('https://accounts.google.com').setAudience('client').setIssuedAt().setExpirationTime('5m').sign(privateKey);
    const requestHeaders={'Content-Type':'application/x-www-form-urlencoded',Cookie:nonceCookie+'; g_csrf_token=csrf'};if(source!==undefined)requestHeaders.Origin=source;
    const response=await f.call('api/login/redirect',{method:'POST',headers:requestHeaders,body:new URLSearchParams({credential,g_csrf_token:'csrf'}).toString()});
    assert.equal(response.status,303,String(source));assert.equal(response.headers.get('Location'),'/roomly/?login=success');
    const sessionCookie=response.headers.getSetCookie().find(value=>value.startsWith('roomly_session='));assert.match(sessionCookie,/HttpOnly; Secure; SameSite=Lax/);
    const me=await (await f.call('api/me',{headers:{Cookie:sessionCookie.split(';')[0]}})).json();assert.equal(me.status,'approved');assert.equal(me.isAdmin,false);
    assert.equal(await (await f.call('',{headers:{Cookie:sessionCookie.split(';')[0]}})).text(),'/roomly/index.html');
    assert.equal(f.sqlite.prepare('SELECT member_sub FROM email_allowlist').get().member_sub,'allowed-user');assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM notifications').get().n,0);
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM login_nonces').get().n,0);
  }
});

test('GIS redirect opaque-origin compatibility preserves CSRF, signed nonce, expiry and destination checks',async()=>{
  const {privateKey,publicKey}=await generateKeyPair('RS256'),other=await generateKeyPair('RS256'),keys=createLocalJWKSet({keys:[{...await exportJWK(publicKey),kid:'opaque-security',alg:'RS256'}]});
  const cases=[
    {name:'missing CSRF cookie',cookie:false,status:303},
    {name:'mismatched CSRF',csrf:'wrong',status:303},
    {name:'missing login cookie',nonceCookie:false,status:303},
    {name:'wrong signed nonce',nonce:'wrong',status:303},
    {name:'forged signature',key:other.privateKey,status:303},
    {name:'expired identity',exp:1,status:303},
    {name:'expired challenge',expired:true,status:303},
    {name:'foreign source',source:'https://evil.example',status:403},
    {name:'Google lookalike source',source:'https://accounts.google.com.evil.example',status:403},
    {name:'invalid opaque spelling',source:'NULL',status:403},
    {name:'foreign destination',destination:'https://other.example',status:403}
  ];
  for(const scenario of cases){
    const f=fixture((credential,clientId,nonce)=>verifyCredential(credential,clientId,nonce,keys)),c=await f.call('api/challenge'),challenge=await c.json();
    const credential=await new SignJWT({email:'allowed@gmail.com',email_verified:true,nonce:scenario.nonce||challenge.nonce}).setProtectedHeader({alg:'RS256',kid:'opaque-security'}).setSubject('allowed-user').setIssuer('https://accounts.google.com').setAudience('client').setIssuedAt().setExpirationTime(scenario.exp??'5m').sign(scenario.key||privateKey);
    const cookies=[];if(scenario.nonceCookie!==false)cookies.push(c.headers.getSetCookie()[0].split(';')[0]);if(scenario.cookie!==false)cookies.push('g_csrf_token=csrf');
    if(scenario.expired)f.sqlite.exec('UPDATE login_nonces SET expires_at=1');if(scenario.destination)f.env.APP_ORIGIN=scenario.destination;
    const response=await f.call('api/login/redirect',{method:'POST',headers:{Origin:scenario.source||'null',Referer:'https://accounts.google.com/','Content-Type':'application/x-www-form-urlencoded',Cookie:cookies.join('; ')},body:new URLSearchParams({credential,g_csrf_token:scenario.csrf||'csrf'}).toString()});
    assert.equal(response.status,scenario.status,scenario.name);if(scenario.status===303)assert.equal(response.headers.get('Location'),'/roomly/?login=expired',scenario.name);
    assert.ok(!response.headers.getSetCookie().some(value=>value.startsWith('roomly_session=')),scenario.name);assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM sessions').get().n,0,scenario.name);
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM members').get().n,0,scenario.name);assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM login_nonces').get().n,1,scenario.name);
  }
});

test('GIS redirect opaque-origin concurrent replay creates one pending session and leaves ordinary APIs origin-bound',async()=>{
  const {privateKey,publicKey}=await generateKeyPair('RS256'),keys=createLocalJWKSet({keys:[{...await exportJWK(publicKey),kid:'opaque-replay',alg:'RS256'}]});
  const f=fixture((credential,clientId,nonce)=>verifyCredential(credential,clientId,nonce,keys)),c=await f.call('api/challenge'),challenge=await c.json();
  const credential=await new SignJWT({email:'new@gmail.com',email_verified:true,nonce:challenge.nonce}).setProtectedHeader({alg:'RS256',kid:'opaque-replay'}).setSubject('new-user').setIssuer('https://accounts.google.com').setAudience('client').setIssuedAt().setExpirationTime('5m').sign(privateKey);
  const options={method:'POST',headers:{Origin:'null','Content-Type':'application/x-www-form-urlencoded',Cookie:c.headers.getSetCookie()[0].split(';')[0]+'; g_csrf_token=csrf'},body:new URLSearchParams({credential,g_csrf_token:'csrf'}).toString()};
  const responses=await Promise.all([f.call('api/login/redirect',options),f.call('api/login/redirect',options)]);
  assert.deepEqual(responses.map(r=>r.headers.get('Location')).sort(),['/roomly/?login=expired','/roomly/?login=success']);assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM sessions').get().n,1);
  const cookie=responses.flatMap(r=>r.headers.getSetCookie()).find(value=>value.startsWith('roomly_session=')).split(';')[0];
  const me=await (await f.call('api/me',{headers:{Cookie:cookie}})).json();assert.equal(me.status,'pending');assert.equal(await (await f.call('',{headers:{Cookie:cookie}})).text(),'/roomly/auth.html');
  for(const path of ['api/login','api/logout','api/admin/review'])for(const source of ['null',undefined]){
    const requestHeaders={'Content-Type':'application/json',Cookie:cookie};if(source!==undefined)requestHeaders.Origin=source;
    assert.equal((await f.call(path,{method:'POST',headers:requestHeaders,body:'{}'})).status,403,path+' '+String(source));
  }
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM sessions').get().n,1);
});

test('GIS redirect rejects missing/mismatched CSRF, foreign origins and unbounded or duplicate form fields',async()=>{
  const f=fixture(),c=await f.call('api/challenge'),challenge=await c.json(),nonceCookie=c.headers.getSetCookie()[0].split(';')[0];
  const credential=JSON.stringify({sub:'redirect',email:'person@gmail.com',name:'姓名'}),form={credential,g_csrf_token:'csrf'};
  const post=(body,headers={})=>f.call('api/login/redirect',{method:'POST',headers:{Origin:'https://accounts.google.com','Content-Type':'application/x-www-form-urlencoded',Cookie:nonceCookie+'; g_csrf_token=csrf',...headers},body:new URLSearchParams(body).toString()});
  for(const rejected of [await post(form,{Cookie:nonceCookie}),await post({...form,g_csrf_token:'other'})]){
    assert.equal(rejected.status,303);assert.equal(rejected.headers.get('Location'),'/roomly/?login=expired');assert.equal(rejected.headers.get('Referrer-Policy'),'no-referrer');
    assert.match(rejected.headers.getSetCookie()[0],/^roomly_login=;.*Max-Age=0/);assert.ok(!rejected.headers.getSetCookie().some(value=>value.startsWith('roomly_session=')||value.startsWith('roomly_code_login=')));
  }
  assert.equal((await post(form,{Origin:'https://evil.example'})).status,403);
  assert.equal((await post({...form,credential:'x'.repeat(20000)})).status,413);
  assert.equal((await post([['credential',credential],['credential',credential],['g_csrf_token','csrf']])).status,400);
  assert.equal((await post(form,{'Content-Type':'text/plain'})).status,415);
  const invalidGet=await f.call('api/login/redirect');assert.equal(invalidGet.status,303);assert.equal(invalidGet.headers.get('Location'),'/roomly/?login=expired');
  assert.equal(f.sqlite.prepare('SELECT hash FROM login_nonces').get().hash,await hash(challenge.nonce));assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM sessions').get().n,0);
  // Current GIS documentation also permits JSON submissions from the site.
  const accepted=await f.post('api/login/redirect',form,nonceCookie+'; g_csrf_token=csrf');assert.equal(accepted.status,303);assert.equal(accepted.headers.get('Location'),'/roomly/?login=success');
});

test('GIS redirect expires cleanly without creating a session',async()=>{
  const f=fixture(),c=await f.call('api/challenge'),nonceCookie=c.headers.getSetCookie()[0].split(';')[0];f.sqlite.exec('UPDATE login_nonces SET expires_at=1');
  const r=await f.call('api/login/redirect',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded',Cookie:nonceCookie+'; g_csrf_token=csrf'},body:new URLSearchParams({credential:JSON.stringify({sub:'expired',email:'expired@gmail.com',name:'姓名'}),g_csrf_token:'csrf'}).toString()});
  assert.equal(r.status,303);assert.equal(r.headers.get('Location'),'/roomly/?login=expired');assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM sessions').get().n,0);
});

async function codeStart(f){
  const response=await f.call('api/login/start'),url=new URL(response.headers.get('Location'));
  return {response,url,cookie:response.headers.getSetCookie()[0].split(';')[0],parts:response.headers.getSetCookie()[0].split(';')[0].split('=')[1].split('.')};
}
const codeCallback=(f,start,query='code=one-time-code',cookie=start.cookie)=>f.call('api/login/redirect?state='+encodeURIComponent(start.url.searchParams.get('state'))+'&'+query,{headers:{Cookie:cookie}});
async function mockLoginToken(handler,action){
  const original=globalThis.fetch,calls=[];globalThis.fetch=async(url,options)=>{calls.push({url:String(url),options});return handler(url,options);};
  try{return await action(calls);}finally{globalThis.fetch=original;}
}
const tokenReply=data=>new Response(JSON.stringify(data),{headers:{'Content-Type':'application/json'}});
async function captureLoginDiagnostics(action){
  const warn=console.warn,error=console.error,logs=[];console.warn=(...values)=>logs.push(values);console.error=(...values)=>logs.push(values);
  try{return await action(logs);}finally{console.warn=warn;console.error=error;}
}

test('server login start uses only identity scopes, independent PKCE state and a short secure cookie',async()=>{
  const f=fixture();assert.equal((await f.call('api/login/start')).status,503);
  assert.equal((await (await f.call('api/challenge')).json()).loginStartUri,'');
  f.env.GOOGLE_CLIENT_SECRET='test-server-secret';assert.equal((await (await f.call('api/challenge')).json()).loginStartUri,origin+'/roomly/api/login/start');
  const start=await codeStart(f),params=start.url.searchParams;assert.equal(start.response.status,303);
  assert.equal(start.url.origin,'https://accounts.google.com');assert.equal(start.url.pathname,'/o/oauth2/v2/auth');assert.equal(params.get('client_id'),'client');assert.equal(params.get('redirect_uri'),origin+'/roomly/api/login/redirect');
  assert.equal(params.get('response_type'),'code');assert.equal(params.get('scope'),'openid email profile');assert.equal(params.get('access_type'),'online');assert.equal(params.get('include_granted_scopes'),'false');assert.equal(params.get('prompt'),'select_account');assert.equal(params.get('code_challenge_method'),'S256');
  assert.match(start.response.headers.getSetCookie()[0],/roomly_code_login=.*; Path=\/roomly\/; Max-Age=600; HttpOnly; Secure; SameSite=Lax/);
  assert.equal(start.response.headers.get('Referrer-Policy'),'no-referrer');assert.equal(start.response.headers.get('Cache-Control'),'private, no-store');
  assert.equal(start.parts.length,3);assert.equal(new Set(start.parts).size,3);for(const value of start.parts)assert.match(value,/^[a-f0-9]{64}$/);
  assert.equal(params.get('state'),start.parts[0]);assert.equal(params.get('nonce'),start.parts[1]);
  const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(start.parts[2]));assert.equal(params.get('code_challenge'),Buffer.from(digest).toString('base64url'));
  assert.ok(f.sqlite.prepare('SELECT hash FROM login_nonces WHERE hash=?').get(await hash('code:'+start.parts[1])));assert.ok(!start.response.headers.get('Location').includes('test-server-secret'));
});

test('server code login validates a Google-signed ID token and reuses session and whitelist rules without retaining grants',async()=>{
  const {privateKey,publicKey}=await generateKeyPair('RS256'),keys=createLocalJWKSet({keys:[{...await exportJWK(publicKey),kid:'code-login',alg:'RS256'}]});
  const f=fixture((credential,clientId,nonce)=>verifyCredential(credential,clientId,nonce,keys));f.env.GOOGLE_CLIENT_SECRET='test-server-secret';
  for(const account of [{email:admin,sub:'admin',status:'approved'},{email:'new-person@gmail.com',sub:'new-person',status:'pending'},{email:'allowed@gmail.com',sub:'allowed',status:'approved'}]){
    if(account.sub==='allowed')f.sqlite.exec("INSERT INTO email_allowlist(email,status,created_at,updated_at,updated_by) VALUES('allowed@gmail.com','approved',1,1,'admin');");
    const start=await codeStart(f),credential=await new SignJWT({email:account.email,email_verified:true,name:'姓名',nonce:start.parts[1]}).setProtectedHeader({alg:'RS256',kid:'code-login'}).setSubject(account.sub).setIssuer('https://accounts.google.com').setAudience('client').setIssuedAt().setExpirationTime('5m').sign(privateKey);
    await mockLoginToken((url,options)=>tokenReply({id_token:credential,access_token:'PRIVATE_ACCESS',refresh_token:'PRIVATE_REFRESH'}),async calls=>{
      const r=await codeCallback(f,start);assert.equal(r.status,303);assert.equal(r.headers.get('Location'),'/roomly/?login=success');assert.equal(r.headers.get('Referrer-Policy'),'no-referrer');assert.equal(r.headers.get('Cache-Control'),'private, no-store');
      const sessionCookie=r.headers.getSetCookie().find(cookie=>cookie.startsWith('roomly_session='));assert.ok(sessionCookie);assert.match(sessionCookie,/HttpOnly; Secure; SameSite=Lax/);assert.match(r.headers.getSetCookie()[0],/roomly_code_login=;.*Max-Age=0/);
      const me=await (await f.call('api/me',{headers:{Cookie:sessionCookie.split(';')[0]}})).json();assert.equal(me.status,account.status);assert.equal(me.isAdmin,account.sub==='admin');
      if(account.sub==='allowed'){assert.equal(await (await f.call('',{headers:{Cookie:sessionCookie.split(';')[0]}})).text(),'/roomly/index.html');assert.equal(f.sqlite.prepare("SELECT member_sub FROM email_allowlist WHERE email='allowed@gmail.com'").get().member_sub,'allowed');}
      assert.equal(calls.length,1);assert.equal(calls[0].url,'https://oauth2.googleapis.com/token');assert.equal(calls[0].options.method,'POST');assert.equal(calls[0].options.redirect,'manual');assert.ok(calls[0].options.signal instanceof AbortSignal);
      const values=new URLSearchParams(calls[0].options.body);assert.equal(values.get('client_secret'),'test-server-secret');assert.equal(values.get('grant_type'),'authorization_code');assert.equal(values.get('code_verifier'),start.parts[2]);assert.equal(values.get('redirect_uri'),origin+'/roomly/api/login/redirect');assert.equal(values.get('code'),'one-time-code');assert.equal(values.get('scope'),null);
      assert.equal(await r.text(),'');assert.ok(![...r.headers].flat().join(' ').includes('PRIVATE_'));const replay=await codeCallback(f,start);assert.equal(replay.headers.get('Location'),'/roomly/?login=expired');assert.equal(calls.length,1);
    });
  }
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM calendar_connections').get().n,0);assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM calendar_snapshots').get().n,0);
});

test('server code login rejects invalid state, expired or reused nonce before contacting Google',async()=>{
  const f=fixture();f.env.GOOGLE_CLIENT_SECRET='test-server-secret';const start=await codeStart(f);
  await mockLoginToken(()=>{throw Error('must not exchange');},async calls=>{
    const invalid=[()=>codeCallback(f,start,'code=code',''),()=>f.call('api/login/redirect?state=wrong&code=code',{headers:{Cookie:start.cookie}}),()=>codeCallback(f,start,'state='+start.parts[0]+'&code=code'),()=>codeCallback(f,start,'code=code','roomly_code_login=bad')];
    for(const request of invalid){const r=await request();assert.equal(r.status,303);assert.equal(r.headers.get('Location'),'/roomly/?login=expired');}
    f.sqlite.exec('UPDATE login_nonces SET expires_at=1');const expired=await codeCallback(f,start);assert.equal(expired.headers.get('Location'),'/roomly/?login=expired');assert.equal(calls.length,0);assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM sessions').get().n,0);
  });
});

test('server code callback clears authorization parameters even if its nonce claim fails',async()=>{
  const f=fixture();f.env.GOOGLE_CLIENT_SECRET='test-server-secret';const start=await codeStart(f);
  const prepare=f.env.DB.prepare.bind(f.env.DB);f.env.DB.prepare=sql=>{if(sql.startsWith('DELETE FROM login_nonces'))throw Error('private database details');return prepare(sql);};
  await mockLoginToken(()=>{throw Error('must not exchange');},async calls=>{
    const r=await codeCallback(f,start,'code=private-code');assert.equal(r.status,303);assert.equal(r.headers.get('Location'),'/roomly/?login=failed');assert.equal(r.headers.get('Referrer-Policy'),'no-referrer');assert.equal(r.headers.get('Cache-Control'),'private, no-store');assert.equal(await r.text(),'');assert.equal(calls.length,0);assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM sessions').get().n,0);
  });
});

test('server code exchange rejects redirects without reading the response or following its destination',async()=>{
  for(const status of [301,302,303,307,308]){
    const f=fixture();f.env.GOOGLE_CLIENT_SECRET='test-server-secret';const start=await codeStart(f);
    await captureLoginDiagnostics(async logs=>{
      await mockLoginToken(()=>new Response('PRIVATE_REDIRECT_BODY',{status,headers:{Location:'https://untrusted.invalid/PRIVATE_LOCATION'}}),async calls=>{
        const r=await codeCallback(f,start);assert.equal(r.status,303);assert.equal(r.headers.get('Location'),'/roomly/?login=failed');assert.equal(calls.length,1);assert.equal(calls[0].options.redirect,'manual');
        assert.deepEqual(logs,[[JSON.stringify({event:'login_failed',phase:'token_exchange',code:'provider_error'})]]);assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM sessions').get().n,0);
      });
    });
  }
});

test('server code login handles cancel, malformed code and token failure with clean URLs and no session',async()=>{
  for(const mode of ['cancel','missing-code','duplicate-code','long-code','token-error','bad-json','missing-token','wrong-nonce','network-error']){
    const f=fixture(async(credential,clientId,nonce)=>{const identity=JSON.parse(credential);if(identity.nonce!==nonce)throw Error('wrong nonce');return identity;});f.env.GOOGLE_CLIENT_SECRET='test-server-secret';const start=await codeStart(f);
    const queries={cancel:'error=access_denied','missing-code':'','duplicate-code':'code=code&code=other','long-code':'code='+('x'.repeat(8001))};
    await mockLoginToken(()=>{
      if(mode==='token-error')return new Response('{}',{status:400});if(mode==='bad-json')return new Response('bad-json');if(mode==='missing-token')return tokenReply({access_token:'PRIVATE_ACCESS'});if(mode==='network-error')throw Error('private provider details');
      return tokenReply({id_token:JSON.stringify({sub:'bad',email:'bad@gmail.com',name:'姓名',nonce:'wrong'})});
    },async calls=>{
      const r=await codeCallback(f,start,queries[mode]??'code=private-code');assert.equal(r.status,303);assert.equal(r.headers.get('Location'),'/roomly/?login='+(mode==='cancel'?'cancelled':'failed'),mode);assert.equal(r.headers.get('Referrer-Policy'),'no-referrer');assert.equal(await r.text(),'');
      assert.ok(!r.headers.getSetCookie().some(cookie=>cookie.startsWith('roomly_session=')));assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM sessions').get().n,0);assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM login_nonces').get().n,0);assert.equal(calls.length,mode in queries?0:1);
    });
  }
});

test('server login nonce is isolated from GIS challenges and callback concurrency creates only one session',async()=>{
  const f=fixture(async(credential,clientId,nonce)=>{const identity=JSON.parse(credential);if(identity.nonce!==nonce)throw Error('wrong nonce');return identity;});f.env.GOOGLE_CLIENT_SECRET='test-server-secret';const start=await codeStart(f);
  const challenge=await (await f.call('api/challenge')).json();assert.notEqual(challenge.nonce,start.parts[1]);
  const gisAttempt=await f.post('api/login',{credential:JSON.stringify({sub:'x',email:'x@gmail.com',name:'姓名',nonce:start.parts[1]}),nonce:start.parts[1]},'roomly_login='+start.parts[1]);assert.equal(gisAttempt.status,401);
  assert.ok(f.sqlite.prepare('SELECT hash FROM login_nonces WHERE hash=?').get(await hash('code:'+start.parts[1])));
  await mockLoginToken(async()=>{await new Promise(resolve=>setImmediate(resolve));return tokenReply({id_token:JSON.stringify({sub:'code-person',email:'code-person@gmail.com',name:'姓名',nonce:start.parts[1]})});},async calls=>{
    const responses=await Promise.all([codeCallback(f,start),codeCallback(f,start)]);assert.equal(responses.filter(r=>r.headers.get('Location')==='/roomly/?login=success').length,1);assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM sessions').get().n,1);assert.equal(calls.length,1);
  });
});
test('server login failure diagnostics expose only fixed phase and code enums, never raw provider or database details',async()=>{
  const cases=[
    {mode:'invalid-client',phase:'token_exchange',code:'invalid_client'},
    {mode:'invalid-grant',phase:'token_exchange',code:'invalid_grant'},
    {mode:'provider-error',phase:'token_exchange',code:'provider_error'},
    {mode:'network',phase:'token_exchange',code:'network'},
    {mode:'invalid-response',phase:'token_exchange',code:'invalid_response'},
    {mode:'missing-token',phase:'token_exchange',code:'missing_id_token'},
    {mode:'missing-secret',phase:'token_exchange',code:'missing_secret'},
    {mode:'jwt',phase:'identity_verify',code:'jwt_invalid'},
    {mode:'nonce-db',phase:'nonce_claim',code:'database_error'},
    {mode:'member-db',phase:'database_write',code:'database_error'},
    {mode:'callback-error',phase:'callback',code:'callback_error'},
    {mode:'malformed-code',phase:'callback',code:'malformed_code'}
  ];
  for(const expected of cases){
    const f=fixture(async(credential,clientId,nonce)=>{if(expected.mode==='jwt')throw Error('PRIVATE_JWT_DETAILS');const identity=JSON.parse(credential);assert.equal(identity.nonce,nonce);return identity;});
    f.env.GOOGLE_CLIENT_SECRET='PRIVATE_SERVER_SECRET';const start=await codeStart(f);
    const prepare=f.env.DB.prepare.bind(f.env.DB);f.env.DB.prepare=sql=>{if((expected.mode==='nonce-db'&&sql.startsWith('DELETE FROM login_nonces'))||(expected.mode==='member-db'&&sql.startsWith('INSERT INTO members')))throw Error('PRIVATE_DATABASE_DETAILS');return prepare(sql);};
    if(expected.mode==='missing-secret')delete f.env.GOOGLE_CLIENT_SECRET;
    await captureLoginDiagnostics(async logs=>{
      await mockLoginToken(()=>{
        if(expected.mode==='network')throw Error('PRIVATE_NETWORK_DETAILS');
        if(expected.mode==='invalid-response')return new Response('PRIVATE_INVALID_JSON');
        if(expected.mode==='missing-token')return tokenReply({access_token:'PRIVATE_ACCESS_TOKEN',refresh_token:'PRIVATE_REFRESH_TOKEN'});
        if(['invalid-client','invalid-grant','provider-error'].includes(expected.mode))return new Response(JSON.stringify({error:expected.mode==='invalid-client'?'invalid_client':expected.mode==='invalid-grant'?'invalid_grant':'PRIVATE_ERROR_CODE',error_description:'PRIVATE_PROVIDER_DETAILS',access_token:'PRIVATE_ACCESS_TOKEN'}),{status:400});
        return tokenReply({id_token:JSON.stringify({sub:'person',email:'person@gmail.com',name:'姓名',nonce:start.parts[1]})});
      },async calls=>{
        const query=expected.mode==='callback-error'?'error=PRIVATE_PROVIDER_DETAILS&error_description=PRIVATE_DESCRIPTION':expected.mode==='malformed-code'?'code=PRIVATE_CODE&code=PRIVATE_OTHER_CODE':'code=PRIVATE_AUTHORIZATION_CODE';
        const r=await codeCallback(f,start,query);assert.equal(r.status,303);assert.equal(r.headers.get('Location'),'/roomly/?login=failed');assert.equal(await r.text(),'');
        assert.deepEqual(logs,[[JSON.stringify({event:'login_failed',phase:expected.phase,code:expected.code})]],expected.mode);
        assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM sessions').get().n,0);
        assert.equal(calls.length,['missing-secret','nonce-db','callback-error','malformed-code'].includes(expected.mode)?0:1);
      });
    });
  }
});

test('pending login sends one administrator notification and cannot assign its own role',async()=>{
  const f=fixture(),user=await f.login('person@example.com','member',{role:'admin',status:'approved'});
  const me=await (await f.call('api/me',{headers:{Cookie:user.cookie}})).json();assert.equal(me.status,'pending');assert.equal(me.isAdmin,false);assert.equal(me.notification,'sent');
  assert.equal(await (await f.call('',{headers:{Cookie:user.cookie}})).text(),'/roomly/auth.html');
  assert.equal((await f.post('api/admin/review',{sub:'member',status:'approved'},user.cookie)).status,403);
  await f.login();assert.equal(f.mail.length,1);assert.equal(f.mail[0].to,admin);assert.match(f.mail[0].text,/person@example.com/);assert.match(f.mail[0].text,/roomly\/admin.html/);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM notifications').get().n,1);
});
test('administrator approval/revocation is enforced server-side; admin role protected',async()=>{
  const f=fixture(),user=await f.login(),owner=await f.login(admin,'admin');
  assert.equal((await f.call('admin.html',{headers:{Cookie:user.cookie}})).status,403);
  assert.equal(await (await f.call('admin.html',{headers:{Cookie:owner.cookie}})).text(),'/roomly/admin.html');
  assert.equal((await f.post('api/admin/review',{sub:'member',status:'approved'},owner.cookie)).status,200);
  assert.equal(await (await f.call('index.html',{headers:{Cookie:user.cookie}})).text(),'/roomly/index.html');
  const member=f.sqlite.prepare('SELECT * FROM members WHERE sub=?').get('member');assert.equal(member.reviewed_by,'admin');assert.ok(member.reviewed_at);
  assert.equal((await f.post('api/admin/review',{sub:'admin',status:'rejected'},owner.cookie)).status,404);
  assert.equal((await f.post('api/admin/review',{sub:'member',status:'rejected'},owner.cookie)).status,200);
  assert.equal(await (await f.call('',{headers:{Cookie:user.cookie}})).text(),'/roomly/auth.html');
  assert.equal(f.mail.length,1);
});
test('logout and expiration invalidate sessions',async()=>{
  const f=fixture(),owner=await f.login(admin,'admin');await f.post('api/logout',{},owner.cookie);
  assert.equal((await f.call('api/me',{headers:{Cookie:owner.cookie}})).status,401);
  const next=await f.login(admin,'admin');f.sqlite.exec('UPDATE sessions SET expires_at=1');assert.equal((await f.call('api/me',{headers:{Cookie:next.cookie}})).status,401);
});
test('failed notification stays queued, retries once and concurrent delivery holds a lease',async()=>{
  const f=fixture();f.env.EMAIL.send=async()=>{throw Error('provider failure');};await f.login();
  const queued=f.sqlite.prepare('SELECT * FROM notifications').get();assert.equal(queued.state,'queued');assert.equal(queued.attempts,1);assert.equal(queued.error_code,'EMAIL_SEND_FAILED');
  await deliverNotifications(f.env);assert.equal(f.sqlite.prepare('SELECT attempts FROM notifications').get().attempts,1);
  f.sqlite.exec('UPDATE notifications SET next_attempt_at=0');f.env.EMAIL.send=async m=>{f.mail.push(m);await new Promise(resolve=>setImmediate(resolve));};
  await Promise.all([deliverNotifications(f.env),deliverNotifications(f.env)]);assert.equal(f.mail.length,1);assert.equal(f.sqlite.prepare('SELECT state FROM notifications').get().state,'sent');
});
test('only an authenticated administrator can add, list or remove whitelist emails',async()=>{
  const f=fixture();assert.equal((await f.post('api/admin/allowlist/add',{email:'other@gmail.com'})).status,401);
  const user=await f.login();for(const path of ['add','remove'])assert.equal((await f.post('api/admin/allowlist/'+path,{email:'other@gmail.com'},user.cookie)).status,403);
  assert.equal((await f.call('api/admin/allowlist',{headers:{Cookie:user.cookie}})).status,403);
  const owner=await f.login(admin,'admin');assert.equal((await f.post('api/admin/allowlist/add',{email:'other@gmail.com'},owner.cookie,{Origin:'https://evil.example'})).status,403);
  for(const email of ['', '<bad>@gmail.com', 'not an email',admin])assert.equal((await f.post('api/admin/allowlist/add',{email},owner.cookie)).status,400);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM email_allowlist').get().n,0);
});
test('preapproved Gmail first login is admitted without request email or administrator role',async()=>{
  const f=fixture(),owner=await f.login(admin,'admin');assert.equal((await f.post('api/admin/allowlist/add',{email:' OTHER@gmail.com '},owner.cookie)).status,200);
  let listing=await (await f.call('api/admin/allowlist',{headers:{Cookie:owner.cookie}})).json();assert.equal(listing.emails[0].email,'other@gmail.com');assert.equal(listing.emails[0].member_sub,null);
  const user=await f.login('other@gmail.com','other');const me=await (await f.call('api/me',{headers:{Cookie:user.cookie}})).json();assert.equal(me.status,'approved');assert.equal(me.isAdmin,false);
  assert.equal(await (await f.call('',{headers:{Cookie:user.cookie}})).text(),'/roomly/index.html');assert.equal(f.mail.length,0);
  listing=await (await f.call('api/admin/allowlist',{headers:{Cookie:owner.cookie}})).json();assert.equal(listing.emails[0].member_sub,'other');assert.equal(listing.emails[0].updated_by,'admin');
});
test('adding an existing pending email approves its session; removing revokes it across future logins',async()=>{
  const f=fixture(),user=await f.login(),owner=await f.login(admin,'admin');assert.equal((await f.post('api/admin/allowlist/add',{email:'person@example.com'},owner.cookie)).status,200);
  assert.equal((await (await f.call('api/me',{headers:{Cookie:user.cookie}})).json()).status,'approved');
  assert.equal((await f.post('api/admin/allowlist/remove',{email:'person@example.com'},owner.cookie)).status,200);
  assert.equal(await (await f.call('',{headers:{Cookie:user.cookie}})).text(),'/roomly/auth.html');
  const again=await f.login();assert.equal((await (await f.call('api/me',{headers:{Cookie:again.cookie}})).json()).status,'rejected');
  await f.post('api/admin/allowlist/add',{email:'person@example.com'},owner.cookie);assert.equal((await (await f.call('api/me',{headers:{Cookie:again.cookie}})).json()).status,'approved');
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM email_allowlist').get().n,1);assert.equal(f.mail.length,1);
});
test('revoking preapproval before first login leaves the applicant pending; review refusal persists',async()=>{
  const f=fixture(),owner=await f.login(admin,'admin');await f.post('api/admin/allowlist/add',{email:'other@gmail.com'},owner.cookie);await f.post('api/admin/allowlist/remove',{email:'other@gmail.com'},owner.cookie);
  let user=await f.login('other@gmail.com','other');assert.equal((await (await f.call('api/me',{headers:{Cookie:user.cookie}})).json()).status,'pending');assert.equal(f.mail.length,1);
  await f.post('api/admin/allowlist/add',{email:'other@gmail.com'},owner.cookie);await f.post('api/admin/review',{sub:'other',status:'rejected'},owner.cookie);
  user=await f.login('other@gmail.com','other');assert.equal((await (await f.call('api/me',{headers:{Cookie:user.cookie}})).json()).status,'rejected');assert.equal(f.sqlite.prepare('SELECT status FROM email_allowlist').get().status,'revoked');
});
test('unbound third-party Email requires review; Workspace authority allows automatic admission',async()=>{
  const f=fixture(),owner=await f.login(admin,'admin');await f.post('api/admin/allowlist/add',{email:'person@example.com'},owner.cookie);
  const user=await f.login();assert.equal((await (await f.call('api/me',{headers:{Cookie:user.cookie}})).json()).status,'pending');
  await f.post('api/admin/review',{sub:'member',status:'approved'},owner.cookie);const again=await f.login();assert.equal((await (await f.call('api/me',{headers:{Cookie:again.cookie}})).json()).status,'approved');
  await f.post('api/admin/allowlist/add',{email:'person@company.com'},owner.cookie);const company=await f.login('person@company.com','workspace',{emailAuthoritative:true});assert.equal((await (await f.call('api/me',{headers:{Cookie:company.cookie}})).json()).status,'approved');
});
test('claimed whitelist Email does not automatically admit a different Google subject',async()=>{
  const f=fixture(),owner=await f.login(admin,'admin');await f.post('api/admin/allowlist/add',{email:'other@gmail.com'},owner.cookie);await f.login('other@gmail.com','first');
  const another=await f.login('other@gmail.com','second');assert.equal((await (await f.call('api/me',{headers:{Cookie:another.cookie}})).json()).status,'pending');assert.equal(f.sqlite.prepare('SELECT member_sub FROM email_allowlist').get().member_sub,'first');
  assert.equal((await f.post('api/admin/allowlist/add',{email:'other@gmail.com'},owner.cookie)).status,409);
});
test('revocation between claim and approval cannot revive access',async()=>{
  const f=fixture(),owner=await f.login(admin,'admin');await f.post('api/admin/allowlist/add',{email:'other@gmail.com'},owner.cookie);
  const prepare=f.env.DB.prepare.bind(f.env.DB);f.env.DB.prepare=sql=>{const statement=prepare(sql);if(sql.startsWith('UPDATE email_allowlist SET member_sub=?')){const first=statement.first.bind(statement);statement.first=async()=>{const row=await first();if(row)f.sqlite.exec("UPDATE email_allowlist SET status='revoked'; UPDATE members SET status='rejected' WHERE role='member';");return row;};}return statement;};
  const user=await f.login('other@gmail.com','other');assert.equal((await (await f.call('api/me',{headers:{Cookie:user.cookie}})).json()).status,'rejected');
});

test('removed whitelist and rejected members disappear from admin lists while revocation survives another login',async()=>{
  const f=fixture(),owner=await f.login(admin,'admin'),pending=await f.login('pending@gmail.com','pending');
  await f.post('api/admin/allowlist/add',{email:'removed@gmail.com'},owner.cookie);await f.login('removed@gmail.com','removed');
  await f.post('api/admin/allowlist/add',{email:'kept@gmail.com'},owner.cookie);await f.login('kept@gmail.com','kept');
  await f.post('api/admin/allowlist/remove',{email:'removed@gmail.com'},owner.cookie);
  const list=await (await f.call('api/admin/allowlist',{headers:{Cookie:owner.cookie}})).json();assert.deepEqual(list.emails.map(e=>e.email),['kept@gmail.com']);
  const members=await (await f.call('api/admin/members',{headers:{Cookie:owner.cookie}})).json();assert.deepEqual(members.members.map(m=>m.sub).sort(),['admin','kept','pending']);assert.ok(members.members.every(m=>['pending','approved'].includes(m.status)));
  assert.equal(f.sqlite.prepare("SELECT status FROM email_allowlist WHERE email='removed@gmail.com'").get().status,'revoked');assert.equal(f.sqlite.prepare("SELECT status FROM members WHERE sub='removed'").get().status,'rejected');
  const again=await f.login('removed@gmail.com','removed');assert.equal((await (await f.call('api/me',{headers:{Cookie:again.cookie}})).json()).status,'rejected');assert.equal(f.mail.length,1);assert.equal((await (await f.call('api/me',{headers:{Cookie:pending.cookie}})).json()).status,'pending');
});

test('the whitelist limit counts active emails and cannot reactivate a historical entry beyond 200',async()=>{
  const f=fixture(),owner=await f.login(admin,'admin');const insert=f.sqlite.prepare('INSERT INTO email_allowlist(email,status,created_at,updated_at,updated_by) VALUES(?,?,1,1,?)');
  for(let i=0;i<220;i++)insert.run('old-'+i+'@gmail.com','revoked','admin');
  for(let i=0;i<199;i++)insert.run('active-'+i+'@gmail.com','approved','admin');
  assert.equal((await f.post('api/admin/allowlist/add',{email:'new@gmail.com'},owner.cookie)).status,200);
  assert.equal((await f.post('api/admin/allowlist/add',{email:'overflow@gmail.com'},owner.cookie)).status,409);
  assert.equal((await f.post('api/admin/allowlist/add',{email:'old-0@gmail.com'},owner.cookie)).status,409);assert.equal(f.sqlite.prepare("SELECT status FROM email_allowlist WHERE email='old-0@gmail.com'").get().status,'revoked');
  assert.equal((await f.post('api/admin/allowlist/add',{email:'new@gmail.com'},owner.cookie)).status,200,'updating an already active entry consumes no slot');
  await f.post('api/admin/allowlist/remove',{email:'active-0@gmail.com'},owner.cookie);assert.equal((await f.post('api/admin/allowlist/add',{email:'old-0@gmail.com'},owner.cookie)).status,200);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM email_allowlist WHERE status='approved'").get().n,200);assert.equal((await (await f.call('api/admin/allowlist',{headers:{Cookie:owner.cookie}})).json()).emails.length,200);
});

test('sources revision changes with approved source identities, excludes pending sessions and exposes no source identifiers',async()=>{
  const f=fixture(),owner=await f.login(admin,'admin');const me=async cookie=>(await (await f.call('api/me',{headers:{Cookie:cookie}})).json());
  const first=await me(owner.cookie);assert.match(first.sourcesRevision,/^[a-f0-9]{64}$/);
  const applicant=await f.login('pending@gmail.com','pending');assert.equal((await me(applicant.cookie)).sourcesRevision,null);assert.equal((await me(owner.cookie)).sourcesRevision,first.sourcesRevision);
  await f.post('api/admin/review',{sub:'pending',status:'approved'},owner.cookie);const expanded=await me(owner.cookie);assert.notEqual(expanded.sourcesRevision,first.sourcesRevision);assert.equal((await me(applicant.cookie)).sourcesRevision,expanded.sourcesRevision);
  f.sqlite.exec("UPDATE members SET name='Renamed',requested_at=999 WHERE sub='pending'");assert.equal((await me(owner.cookie)).sourcesRevision,expanded.sourcesRevision);
  f.sqlite.exec("UPDATE members SET email='updated@gmail.com' WHERE sub='pending'");assert.notEqual((await me(owner.cookie)).sourcesRevision,expanded.sourcesRevision,'a changed source email invalidates cached source metadata');
  await f.post('api/admin/review',{sub:'pending',status:'rejected'},owner.cookie);assert.equal((await me(owner.cookie)).sourcesRevision,first.sourcesRevision);assert.equal((await me(applicant.cookie)).sourcesRevision,null);assert.equal(expanded.approved,undefined);assert.equal(expanded.sources,undefined);
});

test('a rejected applicant is never sent a delayed queued approval-request notification',async()=>{
  const f=fixture();f.env.EMAIL.send=async()=>{throw Error('provider unavailable');};await f.login();const owner=await f.login(admin,'admin');
  await f.post('api/admin/review',{sub:'member',status:'rejected'},owner.cookie);f.sqlite.exec('UPDATE notifications SET next_attempt_at=0');f.env.EMAIL.send=async message=>f.mail.push(message);
  await deliverNotifications(f.env);assert.equal(f.mail.length,0);assert.equal(f.sqlite.prepare('SELECT state FROM notifications').get().state,'queued');
});

test('me requests Calendar consent only for approved users with configured backend and incomplete grants',async()=>{
  const f=fixture(),owner=await f.login(admin,'admin'),applicant=await f.login('pending@gmail.com','pending');const me=async cookie=>(await (await f.call('api/me',{headers:{Cookie:cookie}})).json());
  let current=await me(owner.cookie);assert.equal(current.calendarConfigured,false);assert.equal(current.calendarAuthorizationRequired,false);
  f.env.GOOGLE_CLIENT_SECRET='test-server-secret';f.env.CALENDAR_TOKEN_KEY='11'.repeat(32);current=await me(owner.cookie);assert.equal(current.calendarConfigured,true);assert.equal(current.calendarAuthorizationRequired,true,'a missing grant requires consent');
  assert.equal((await me(applicant.cookie)).calendarAuthorizationRequired,false);await f.post('api/admin/review',{sub:'pending',status:'rejected'},owner.cookie);assert.equal((await me(applicant.cookie)).calendarAuthorizationRequired,false);
  f.sqlite.exec("INSERT INTO calendar_connections(member_sub,refresh_cipher,version,status,updated_at,shared_calendars) VALUES('admin','fixture-encrypted-token','version','connected',1,0)");assert.equal((await me(owner.cookie)).calendarAuthorizationRequired,true,'event-only grants require a shared-calendar update');
  f.sqlite.exec("UPDATE calendar_connections SET shared_calendars=1 WHERE member_sub='admin'");assert.equal((await me(owner.cookie)).calendarAuthorizationRequired,false);
  f.sqlite.exec("UPDATE calendar_connections SET status='reauthorize' WHERE member_sub='admin'");assert.equal((await me(owner.cookie)).calendarAuthorizationRequired,true);
  delete f.env.CALENDAR_TOKEN_KEY;current=await me(owner.cookie);assert.equal(current.calendarConfigured,false);assert.equal(current.calendarAuthorizationRequired,false);
  assert.equal(current.refresh_cipher,undefined);assert.equal(current.connection,undefined);
});

test('me exposes only an opaque calendar content revision, without Google reads or changes on timestamp-only syncs',async()=>{
  const f=fixture(),owner=await f.login(admin,'admin'),pending=await f.login('pending@gmail.com','pending');const me=async cookie=>(await (await f.call('api/me',{headers:{Cookie:cookie}})).json());
  assert.equal((await me(owner.cookie)).calendarRevision,null);f.env.GOOGLE_CLIENT_SECRET='test-server-secret';f.env.CALENDAR_TOKEN_KEY='11'.repeat(32);
  await mockLoginToken(()=>{throw Error('me must not contact Google');},async calls=>{
    const before=await me(owner.cookie);assert.match(before.calendarRevision,/^[a-f0-9]{64}$/);assert.equal((await me(pending.cookie)).calendarRevision,null);
    f.sqlite.exec("INSERT INTO calendar_connections(member_sub,refresh_cipher,version,status,updated_at,shared_calendars) VALUES('admin','fixture-encrypted-token','version','connected',1,1)");const connected=await me(owner.cookie);assert.notEqual(connected.calendarRevision,before.calendarRevision);
    f.sqlite.exec("INSERT INTO calendar_snapshots(member_sub,week_start,room_revision,connection_version,data,synced_at,retry_at) VALUES('admin','2026-09-28',1,'version','[]',1,600)");const ready=await me(owner.cookie);assert.notEqual(ready.calendarRevision,connected.calendarRevision);
    f.sqlite.exec("UPDATE calendar_snapshots SET synced_at=2,retry_at=601,lease_until=999,lease_id='new-lease'; UPDATE calendar_connections SET updated_at=2,change_revision=change_revision+1");const timed=await me(owner.cookie);assert.equal(timed.calendarRevision,ready.calendarRevision,'lease, polling timestamps and notification dirty markers do not change visible content');
    f.sqlite.prepare('UPDATE calendar_snapshots SET data=?').run(JSON.stringify([{id:'event',summary:'fixture private meeting'}]));const changed=await me(owner.cookie);assert.notEqual(changed.calendarRevision,ready.calendarRevision);assert.equal(changed.sourcesRevision,before.sourcesRevision);assert.equal(changed.events,undefined);assert.equal(changed.data,undefined);assert.equal(changed.refresh_cipher,undefined);assert.ok(!JSON.stringify(changed).includes('fixture private meeting'));
    f.sqlite.exec('UPDATE calendar_snapshots SET data=data');assert.equal((await me(owner.cookie)).calendarRevision,changed.calendarRevision);f.sqlite.exec('DELETE FROM calendar_snapshots');assert.notEqual((await me(owner.cookie)).calendarRevision,changed.calendarRevision);assert.equal(calls.length,0);
  });
});
