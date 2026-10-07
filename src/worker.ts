import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import {calendarAPI,CalendarError,calendarMaintenance,calendarReady,removeRevokedCalendars,syncCalendars,taipeiWeek} from './calendar.ts';
import {calendarWebhook} from './calendar-watch.ts';

const googleKeys = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));
const base='/roomly/', sessionName='roomly_session', nonceName='roomly_login';
const codeLoginName='roomly_code_login',loginCallbackPath=base+'api/login/redirect',codeNoncePrefix='code:';
const sessionAge=30*86400, sessionRenewInterval=86400, nonceAge=600;
type Member={sub:string;email:string;name:string;role:'admin'|'member';status:'pending'|'approved'|'rejected';requested_at:number;reviewed_at:number|null;reviewed_by:string|null};
type SessionMember=Member&{sessionExpiresAt:number;sessionHash:string};
type Notification={id:string;member_sub:string;state:string;attempts:number;next_attempt_at:number;lease_until:number;email:string;name:string};
type Identity={sub:string;email:string;name:string;emailAuthoritative:boolean};
type Verifier=(credential:string,clientId:string,nonce:string)=>Promise<Identity>;
type CodeLoginPhase='callback'|'nonce_claim'|'token_exchange'|'identity_verify'|'database_write';
type CodeLoginCode='callback_error'|'malformed_code'|'missing_secret'|'invalid_client'|'invalid_grant'|'provider_error'|'network'|'invalid_response'|'missing_id_token'|'jwt_invalid'|'database_error';
class CodeLoginError extends Error {code:CodeLoginCode;constructor(code:CodeLoginCode){super('Google login failed');this.code=code;}}
function codeLoginFailure(phase:CodeLoginPhase,code:CodeLoginCode){console.warn(JSON.stringify({event:'login_failed',phase,code}));}
function unexpectedCodeLoginFailure(phase:CodeLoginPhase,error:unknown){codeLoginFailure(phase,error instanceof CodeLoginError?error.code:phase==='identity_verify'?'jwt_invalid':'database_error');}
function calendarQueueWork(value:unknown){
  try{
    if(!value||typeof value!=='object'||Array.isArray(value))return null;
    const prototype=Object.getPrototypeOf(value),keys=Reflect.ownKeys(value);
    if((prototype!==Object.prototype&&prototype!==null)||keys.length<1||keys.length>2||keys.some(key=>key!=='week'&&key!=='manual'))return null;
    const property=Object.getOwnPropertyDescriptor(value,'week');
    if(!property||!('value' in property)||typeof property.value!=='string'||property.value.length!==10)return null;
    const manual=Object.getOwnPropertyDescriptor(value,'manual');
    if(manual&&(!('value' in manual)||typeof manual.value!=='boolean'))return null;
    const week=property.value;
    if(taipeiWeek(week)!==week||Math.abs(Date.parse(week+'T00:00:00Z')-Date.parse(taipeiWeek()+'T00:00:00Z'))>56*86400000)return null;
    return {week,manual:!!manual&&manual.value===true};
  }catch{return null;}
}
async function manualCalendarSyncBlocked(env:Env,week:string){
  return !!await env.DB.prepare("SELECT 1 FROM calendar_snapshots s JOIN calendar_connections c ON c.member_sub=s.member_sub AND c.version=s.connection_version JOIN members m ON m.sub=c.member_sub WHERE c.status='connected' AND m.status='approved' AND s.week_start!=? AND s.lease_until>? LIMIT 1").bind(week,now()).first();
}
class HttpError extends Error { status:number;constructor(status:number,message:string){super(message);this.status=status;} }
const now=()=>Math.floor(Date.now()/1000);
function normalizeEmail(value:unknown){if(typeof value!=='string')return '';const email=value.trim().toLowerCase();return email.length<=254&&/^[^\s@<>"']+@[a-z0-9.-]+\.[a-z]{2,63}$/i.test(email)?email:'';}
const random=()=>Array.from(crypto.getRandomValues(new Uint8Array(32)),n=>n.toString(16).padStart(2,'0')).join('');
export async function hash(value:string){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))),n=>n.toString(16).padStart(2,'0')).join('');}
const cookie=(name:string,value:string,age:number,sameSite='Lax')=>`${name}=${value}; Path=${base}; Max-Age=${age}; HttpOnly; Secure; SameSite=${sameSite}`;
function readCookie(request:Request,name:string){return (request.headers.get('Cookie')||'').split(';').map(p=>p.trim()).find(p=>p.startsWith(name+'='))?.slice(name.length+1)||'';}
function headers(){return new Headers({'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'strict-origin-when-cross-origin','Cross-Origin-Opener-Policy':'same-origin-allow-popups'});}
function json(data:object,status=200,cookies:string[]=[]){const h=headers();h.set('Content-Type','application/json; charset=utf-8');for(const c of cookies)h.append('Set-Cookie',c);return new Response(JSON.stringify(data),{status,headers:h});}
function checkOrigin(request:Request,env:Env){if(request.headers.get('Origin')!==env.APP_ORIGIN||new URL(request.url).origin!==env.APP_ORIGIN)throw new HttpError(403,'請從 Roomly 網站操作。');}
async function readText(request:Request):Promise<string>{
  const reader=request.body?.getReader();if(!reader)throw new HttpError(400,'缺少資料。');
  let bytes=0;const chunks:Uint8Array[]=[];
  for(;;){const part=await reader.read();if(part.done)break;bytes+=part.value.byteLength;if(bytes>16384){await reader.cancel();throw new HttpError(413,'資料過大。');}chunks.push(part.value);}
  const body=new Uint8Array(bytes);let offset=0;for(const c of chunks){body.set(c,offset);offset+=c.length;}
  return new TextDecoder().decode(body);
}
async function readJSON(request:Request):Promise<Record<string,unknown>>{
  if(!request.headers.get('Content-Type')?.startsWith('application/json'))throw new HttpError(415,'請使用 JSON 格式。');
  try{const value:unknown=JSON.parse(await readText(request));if(!value||typeof value!=='object'||Array.isArray(value))throw Error();return value as Record<string,unknown>;}catch(error){if(error instanceof HttpError)throw error;throw new HttpError(400,'資料格式不正確。');}
}
async function readGoogleLogin(request:Request):Promise<Record<string,unknown>>{
  if(request.headers.get('Content-Type')?.startsWith('application/json'))return readJSON(request);
  if(!request.headers.get('Content-Type')?.startsWith('application/x-www-form-urlencoded'))throw new HttpError(415,'Google 登入回應格式不正確。');
  const form=new URLSearchParams(await readText(request));
  if(form.getAll('credential').length!==1||form.getAll('g_csrf_token').length!==1)throw new HttpError(400,'Google 登入回應格式不正確。');
  return Object.fromEntries(form);
}
export async function verifyCredential(credential:string,clientId:string,nonce:string,keys:JWTVerifyGetKey=googleKeys):Promise<Identity>{
  const {payload}=await jwtVerify(credential,keys,{audience:clientId,issuer:['https://accounts.google.com','accounts.google.com'],algorithms:['RS256'],requiredClaims:['exp','iat','sub'],maxTokenAge:'10m',clockTolerance:5});
  if(typeof payload.sub!=='string'||!payload.sub||payload.sub.length>255||typeof payload.email!=='string'||payload.email.length>320||payload.email_verified!==true||payload.nonce!==nonce)throw new HttpError(401,'Google 身分驗證未完成，請重新登入。');
  return {sub:payload.sub,email:payload.email.toLowerCase(),name:typeof payload.name==='string'?payload.name.slice(0,100):payload.email,emailAuthoritative:payload.email.toLowerCase().endsWith('@gmail.com')||(typeof payload.hd==='string'&&payload.hd.length>0)};
}
async function memberFor(request:Request,env:Env){
  const token=readCookie(request,sessionName);if(!/^[a-f0-9]{64}$/.test(token))return null;
  return env.DB.prepare('SELECT m.*,s.expires_at AS sessionExpiresAt,s.hash AS sessionHash FROM sessions s JOIN members m ON m.sub=s.member_sub WHERE s.hash=? AND s.expires_at>?').bind(await hash(token),now()).first<SessionMember>();
}
async function renewSession(request:Request,env:Env,member:SessionMember){
  const time=now(),threshold=time+sessionAge-sessionRenewInterval;
  if(member.status!=='approved'||member.sessionExpiresAt>threshold)return [];
  // Keep the same token so parallel requests and an in-flight OAuth callback
  // stay valid. A conditional UPDATE cannot revive logout or expired sessions.
  const renewed=await env.DB.prepare("UPDATE sessions SET expires_at=? WHERE hash=? AND member_sub=? AND expires_at>? AND expires_at<=? AND EXISTS(SELECT 1 FROM members WHERE sub=? AND status='approved') RETURNING expires_at").bind(time+sessionAge,member.sessionHash,member.sub,time,threshold,member.sub).first<{expires_at:number}>();
  return renewed?[cookie(sessionName,readCookie(request,sessionName),Math.max(0,renewed.expires_at-now()))]:[];
}
function isAdmin(member:Member|null,env:Env){return !!member&&member.role==='admin'&&member.status==='approved'&&member.email===env.ADMIN_EMAIL;}
export async function deliverNotifications(env:Env,onlyId?:string){
  // Email is optional; manual approval and queued requests remain available.
  if(!env.EMAIL||!env.MAIL_FROM)return;
  const time=now();
  const {results}=await env.DB.prepare(`SELECT n.*,m.email,m.name FROM notifications n JOIN members m ON m.sub=n.member_sub WHERE m.status='pending' AND n.state!='sent' AND n.next_attempt_at<=? AND n.lease_until<=? ${onlyId?'AND n.id=?':''} ORDER BY n.next_attempt_at LIMIT 10`).bind(...(onlyId?[time,time,onlyId]:[time,time])).all<Notification>();
  for(const n of results){
    const claimed=await env.DB.prepare("UPDATE notifications SET state='sending',lease_until=?,attempts=attempts+1 WHERE id=? AND state!='sent' AND lease_until<=? RETURNING id").bind(time+120,n.id,time).first();if(!claimed)continue;
    try{
      await env.EMAIL.send({to:env.ADMIN_EMAIL,from:env.MAIL_FROM,subject:'Roomly：有人申請加入白名單',text:`申請者：${n.name.replace(/[\r\n]/g,' ')}\nGoogle 帳號：${n.email}\n\n請登入管理員帳號，在下列頁面核准或拒絕：\n${env.APP_ORIGIN}${base}admin.html\n\n核准只影響 Roomly 的使用資格，使用者仍須自行同意 Google 日曆唯讀授權。`});
      await env.DB.prepare("UPDATE notifications SET state='sent',sent_at=?,lease_until=0,error_code=NULL WHERE id=?").bind(now(),n.id).run();
    }catch(error){
      const code='EMAIL_SEND_FAILED';
      await env.DB.prepare("UPDATE notifications SET state='queued',next_attempt_at=?,lease_until=0,error_code=? WHERE id=?").bind(time+Math.min(3600,300*2**Math.min(n.attempts,4)),code,n.id).run();
      console.warn(JSON.stringify({event:'notification_failed',code}));
    }
  }
}
async function serve(request:Request,env:Env,file?:string){
  const url=new URL(request.url);if(file)url.pathname=base+file;
  const result=await env.ASSETS.fetch(new Request(url,request));const h=new Headers(result.headers);for(const[k,v]of headers())h.set(k,v);
  return new Response(result.body,{status:result.status,headers:h});
}
async function finishLogin(env:Env,ctx:ExecutionContext,verify:Verifier,credential:unknown,nonce:string,nonceClaimed=false,diagnostic?:(phase:CodeLoginPhase)=>void){
  diagnostic?.('identity_verify');
  if(typeof credential!=='string'||credential.length>14000||!/^[a-f0-9]{64}$/.test(nonce))throw new HttpError(401,'登入已失效，請重新整理再試。');
  let identity:Identity;try{identity=await verify(credential,env.GOOGLE_CLIENT_ID,nonce);}catch{throw new HttpError(401,'Google 身分驗證失敗，請重新登入。');}
  diagnostic?.('database_write');
  if(!nonceClaimed){
    const consumed=await env.DB.prepare('DELETE FROM login_nonces WHERE hash=? AND expires_at>? RETURNING hash').bind(await hash(nonce),now()).first();if(!consumed)throw new HttpError(401,'登入已失效，請重新整理再試。');
  }
  const admin=identity.email===env.ADMIN_EMAIL&&(identity.emailAuthoritative||identity.email.endsWith('@gmail.com'));
  const inserted=await env.DB.prepare('INSERT INTO members(sub,email,name,role,status,requested_at) VALUES(?,?,?,?,?,?) ON CONFLICT(sub) DO NOTHING').bind(identity.sub,identity.email,identity.name,admin?'admin':'member',admin?'approved':'pending',now()).run();
  await env.DB.prepare('UPDATE members SET email=?,name=? WHERE sub=?').bind(identity.email,identity.name,identity.sub).run();
  const admitted=!admin?await env.DB.prepare("UPDATE email_allowlist SET member_sub=? WHERE email=? AND status='approved' AND (member_sub=? OR (member_sub IS NULL AND ?=1)) RETURNING updated_at,updated_by").bind(identity.sub,identity.email,identity.sub,identity.emailAuthoritative||identity.email.endsWith('@gmail.com')?1:0).first<{updated_at:number;updated_by:string}>():null;
  if(admitted)await env.DB.prepare("UPDATE members SET status='approved',reviewed_at=?,reviewed_by=? WHERE sub=? AND role='member' AND EXISTS(SELECT 1 FROM email_allowlist WHERE email=? AND status='approved' AND member_sub=?)").bind(admitted.updated_at,admitted.updated_by,identity.sub,identity.email,identity.sub).run();
  if(inserted.meta.changes&&!admin&&!admitted){
    const id=crypto.randomUUID();await env.DB.prepare('INSERT INTO notifications(id,member_sub,next_attempt_at) VALUES(?,?,?) ON CONFLICT(member_sub) DO NOTHING').bind(id,identity.sub,now()).run();
    ctx.waitUntil(deliverNotifications(env,id));
  }
  const token=random();await env.DB.prepare('INSERT INTO sessions(hash,member_sub,expires_at) VALUES(?,?,?)').bind(await hash(token),identity.sub,now()+sessionAge).run();
  return [cookie(sessionName,token,sessionAge),cookie(nonceName,'',0,'None')];
}
async function codeChallenge(verifier:string){
  const bytes=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(verifier)));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}
function codeLoginCookie(request:Request){
  const parts=readCookie(request,codeLoginName).split('.');
  return parts.length===3&&parts.every(value=>/^[a-f0-9]{64}$/.test(value))?{state:parts[0],nonce:parts[1],verifier:parts[2]}:null;
}
function loginRedirect(result='',cookies:string[]=[]){
  const h=headers();h.set('Location',base+(result?'?login='+result:''));h.set('Referrer-Policy','no-referrer');
  h.append('Set-Cookie',cookie(codeLoginName,'',0));for(const c of cookies)h.append('Set-Cookie',c);
  return new Response(null,{status:303,headers:h});
}
async function exchangeLoginCode(env:Env,code:string,verifier:string){
  if(!env.GOOGLE_CLIENT_SECRET)throw new CodeLoginError('missing_secret');
  let response:Response;
  // workerd supports manual/follow only. Reject redirects ourselves so the
  // credential-bearing POST can never follow a different destination.
  try{response=await fetch('https://oauth2.googleapis.com/token',{method:'POST',redirect:'manual',headers:{'Content-Type':'application/x-www-form-urlencoded'},signal:AbortSignal.timeout(20000),body:new URLSearchParams({client_id:env.GOOGLE_CLIENT_ID,client_secret:env.GOOGLE_CLIENT_SECRET,redirect_uri:env.APP_ORIGIN+loginCallbackPath,grant_type:'authorization_code',code,code_verifier:verifier})});}
  catch{throw new CodeLoginError('network');}
  if(response.status>=300&&response.status<400)throw new CodeLoginError('provider_error');
  let data:unknown;try{data=await response.json();}catch{throw new CodeLoginError('invalid_response');}
  if(!response.ok){
    // Only map known literal codes. Provider descriptions and all other
    // response fields must never appear in diagnostics or the result URL.
    const error=data&&typeof data==='object'&&'error' in data?data.error:null;
    throw new CodeLoginError(error==='invalid_client'?'invalid_client':error==='invalid_grant'?'invalid_grant':'provider_error');
  }
  if(!data||typeof data!=='object'||!('id_token' in data)||typeof data.id_token!=='string'||!data.id_token)throw new CodeLoginError('missing_id_token');
  return data.id_token;
}
export function createHandler(verify:Verifier=verifyCredential){return {
  async fetch(request:Request,env:Env,ctx:ExecutionContext):Promise<Response>{
    try{
      const url=new URL(request.url);let path:string;try{path=decodeURIComponent(url.pathname).replace(/\/+$/,'');}catch{throw new HttpError(400,'網址格式不正確。');}
      if(!path.startsWith('/roomly'))return new Response('Not found',{status:404});
      if(path==='/roomly'&&!url.pathname.endsWith('/'))return new Response(null,{status:307,headers:{Location:base,'Cache-Control':'no-store'}});
      if(path!=='/roomly'&&url.pathname.endsWith('/'))return new Response(null,{status:307,headers:{Location:path,'Cache-Control':'no-store'}});
      const apiPath=path.startsWith(base+'api/')?path.slice((base+'api/').length):null;
      if(apiPath!==null){
        // Google sends header-authenticated server notifications without a user
        // session or browser Origin. Only this precise route gets that exception.
        if(apiPath==='calendar/notifications'){
          if(url.origin!==env.APP_ORIGIN)throw new HttpError(403,'請從 Roomly 網站操作。');
          return await calendarWebhook(request,env);
        }
        if(apiPath==='login/start'&&request.method==='GET'){
          if(url.origin!==env.APP_ORIGIN)throw new HttpError(403,'請從 Roomly 網站操作。');
          if(!env.GOOGLE_CLIENT_SECRET)throw new HttpError(503,'Google 登入尚未完成設定。');
          const state=random(),nonce=random(),verifier=random();
          await env.DB.prepare('INSERT INTO login_nonces(hash,expires_at) VALUES(?,?)').bind(await hash(codeNoncePrefix+nonce),now()+nonceAge).run();
          const destination=new URL('https://accounts.google.com/o/oauth2/v2/auth');
          for(const[k,v]of Object.entries({client_id:env.GOOGLE_CLIENT_ID,redirect_uri:env.APP_ORIGIN+loginCallbackPath,response_type:'code',scope:'openid email profile',access_type:'online',include_granted_scopes:'false',prompt:'select_account',state,nonce,code_challenge:await codeChallenge(verifier),code_challenge_method:'S256'}))destination.searchParams.set(k,v);
          const h=headers();h.set('Location',destination.href);h.set('Referrer-Policy','no-referrer');h.append('Set-Cookie',cookie(codeLoginName,[state,nonce,verifier].join('.'),nonceAge));
          return new Response(null,{status:303,headers:h});
        }
        if(apiPath==='login/redirect'&&request.method==='GET'){
          if(url.origin!==env.APP_ORIGIN)throw new HttpError(403,'請從 Roomly 網站操作。');
          let phase:CodeLoginPhase='nonce_claim';
          try{
            const login=codeLoginCookie(request),query=url.searchParams;
            if(!login||query.getAll('state').length!==1||query.get('state')!==login.state)return loginRedirect('expired');
            const nonceHash=await hash(codeNoncePrefix+login.nonce);
            // Claim once before exchanging: a concurrent callback must never
            // send the same code twice or interfere with the first response.
            const claimed=await env.DB.prepare('DELETE FROM login_nonces WHERE hash=? AND expires_at>? RETURNING hash').bind(nonceHash,now()).first();
            if(!claimed)return loginRedirect('expired');
            if(query.has('error')){
              if(query.getAll('error').length===1&&query.get('error')==='access_denied')return loginRedirect('cancelled');
              codeLoginFailure('callback','callback_error');return loginRedirect('failed');
            }
            const code=query.get('code');
            if(query.getAll('code').length!==1||!code||code.length>8000){codeLoginFailure('callback','malformed_code');return loginRedirect('failed');}
            phase='token_exchange';
            const credential=await exchangeLoginCode(env,code,login.verifier);
            return loginRedirect('success',await finishLogin(env,ctx,verify,credential,login.nonce,true,value=>{phase=value;}));
          }catch(error){
            unexpectedCodeLoginFailure(phase,error);
            return loginRedirect('failed');
          }
        }
        // GIS redirect mode posts across sites. Only this endpoint accepts that
        // return, protected by Google's double-submit CSRF token and our nonce.
        if(apiPath==='login/redirect'&&request.method==='POST'){
          const origin=request.headers.get('Origin');
          // Cross-site redirects can have an opaque ("null") origin. This GIS-only
          // exception still requires double-submit CSRF, a signed ID token and a
          // single-use nonce; ordinary API mutations retain strict origin checks.
          if(url.origin!==env.APP_ORIGIN||(origin&&origin!=='null'&&origin!==env.APP_ORIGIN&&origin!=='https://accounts.google.com'))throw new HttpError(403,'Google 登入來源不正確。');
          const body=await readGoogleLogin(request),csrf=readCookie(request,'g_csrf_token');
          const h=headers();h.set('Location',base+'?login=success');h.set('Referrer-Policy','no-referrer');
          if(!csrf||csrf.length>1024||typeof body.g_csrf_token!=='string'||body.g_csrf_token!==csrf){
            // Reject old GIS returns without creating a session. Only clear the
            // GIS nonce, so a separate code-flow login is not interrupted.
            h.set('Location',base+'?login=expired');h.append('Set-Cookie',cookie(nonceName,'',0,'None'));
            return new Response(null,{status:303,headers:h});
          }
          try{for(const c of await finishLogin(env,ctx,verify,body.credential,readCookie(request,nonceName)))h.append('Set-Cookie',c);}
          catch(error){if(!(error instanceof HttpError)||error.status!==401)throw error;h.set('Location',base+'?login=expired');h.append('Set-Cookie',cookie(nonceName,'',0,'None'));}
          return new Response(null,{status:303,headers:h});
        }
        if(request.method==='POST')checkOrigin(request,env);
        if(apiPath==='challenge'&&request.method==='GET'){
          const nonce=random();await env.DB.prepare('INSERT INTO login_nonces(hash,expires_at) VALUES(?,?)').bind(await hash(nonce),now()+nonceAge).run();
          const redirect=env.GOOGLE_LOGIN_REDIRECT==='true';
          return json({nonce,clientId:env.GOOGLE_CLIENT_ID,loginUri:redirect?env.APP_ORIGIN+loginCallbackPath:'',loginStartUri:env.GOOGLE_CLIENT_SECRET?env.APP_ORIGIN+base+'api/login/start':''},200,[cookie(nonceName,nonce,nonceAge,redirect?'None':'Lax')]);
        }
        if(apiPath==='login'&&request.method==='POST'){
          const body=await readJSON(request),nonce=readCookie(request,nonceName);
          if(!nonce||body.nonce!==nonce)throw new HttpError(401,'登入已失效，請重新整理再試。');
          return json({ok:true},200,await finishLogin(env,ctx,verify,body.credential,nonce));
        }
        if(apiPath==='logout'&&request.method==='POST'){
          const token=readCookie(request,sessionName);if(token)await env.DB.prepare('DELETE FROM sessions WHERE hash=?').bind(await hash(token)).run();return json({ok:true},200,[cookie(sessionName,'',0),cookie(nonceName,'',0)]);
        }
        const member=await memberFor(request,env);if(!member)throw new HttpError(401,'請先登入 Google 帳號。');
        if(apiPath==='me'&&request.method==='GET'){
          const approved=member.status==='approved',admin=isAdmin(member,env),calendarConfigured=calendarReady(env);
          // Authentication remains a fresh lookup. Content-free revisions avoid
          // scanning every approved account on each visible board's minute poll.
          const metadata=await env.DB.prepare(`SELECT r.sources_revision,r.calendar_revision,
            (SELECT state FROM notifications WHERE member_sub=?) AS notification,
            CASE WHEN ?=1 THEN (SELECT COUNT(*) FROM members WHERE status='pending') ELSE 0 END AS pending,
            c.status AS connection_status,c.shared_calendars
            FROM room_settings r LEFT JOIN calendar_connections c ON c.member_sub=? AND ?=1 AND ?=1 WHERE r.id=1`)
            .bind(member.sub,admin?1:0,member.sub,approved?1:0,calendarConfigured?1:0)
            .first<{sources_revision:number;calendar_revision:number;notification:string|null;pending:number;connection_status:string|null;shared_calendars:number|null}>();
          if(!metadata)throw new HttpError(503,'服務暫時無法使用，請稍後重試。');
          const sourcesRevision=approved?await hash(String(metadata.sources_revision)):null;
          const calendarRevision=approved&&calendarConfigured?await hash(String(metadata.calendar_revision)):null;
          const calendarAuthorizationRequired=approved&&calendarConfigured&&(metadata.connection_status!=='connected'||!metadata.shared_calendars);
          return json({email:member.email,name:member.name,status:member.status,isAdmin:admin,notification:env.EMAIL&&env.MAIL_FROM?(metadata.notification||null):'disabled',pending:metadata.pending||0,sourcesRevision,calendarRevision,calendarConfigured,calendarAuthorizationRequired},200,await renewSession(request,env,member));
        }
        if(apiPath==='calendar-sources'&&request.method==='GET'){
          if(member.status!=='approved')throw new HttpError(403,'通過白名單後才能讀取日曆來源。');
          const {results}=await env.DB.prepare("SELECT DISTINCT email FROM members WHERE status='approved' ORDER BY email").all<{email:string}>();
          return json({emails:results.map(row=>normalizeEmail(row.email)).filter(Boolean)});
        }
        if(apiPath.startsWith('calendar/'))return await calendarAPI(apiPath,request,env,member,()=>readJSON(request),verify);
        if(!isAdmin(member,env))throw new HttpError(403,'只有管理員可以審核白名單。');
        if(apiPath==='admin/allowlist'&&request.method==='GET'){
          const {results}=await env.DB.prepare("SELECT a.*,m.name,m.email AS member_email FROM email_allowlist a LEFT JOIN members m ON m.sub=a.member_sub WHERE a.status='approved' ORDER BY a.updated_at DESC LIMIT 200").all();return json({emails:results});
        }
        if(apiPath==='admin/allowlist/add'&&request.method==='POST'){
          const body=await readJSON(request),email=normalizeEmail(body.email);if(!email)throw new HttpError(400,'請輸入有效的 Google Email。');if(email===env.ADMIN_EMAIL)throw new HttpError(400,'管理員已具有使用資格。');
          const {results}=await env.DB.prepare("SELECT sub FROM members WHERE email=? AND role='member' LIMIT 2").bind(email).all<{sub:string}>();if(results.length>1)throw new HttpError(409,'這個 Email 有多個帳號申請，請在申請名單個別審核。');
          const time=now(),changed=await env.DB.batch([
            // Count only active entries, atomically for both new and re-added
            // addresses. Retain revoked rows so login cannot reinstate them.
            env.DB.prepare("INSERT INTO email_allowlist(email,status,member_sub,created_at,updated_at,updated_by) SELECT ?,'approved',?,?,?,? WHERE (SELECT COUNT(*) FROM email_allowlist WHERE status='approved')<200 OR EXISTS(SELECT 1 FROM email_allowlist WHERE email=? AND status='approved') ON CONFLICT(email) DO UPDATE SET status='approved',member_sub=excluded.member_sub,updated_at=excluded.updated_at,updated_by=excluded.updated_by").bind(email,results[0]?.sub||null,time,time,member.sub,email),
            env.DB.prepare("UPDATE members SET status='approved',reviewed_at=?,reviewed_by=? WHERE sub=(SELECT member_sub FROM email_allowlist WHERE email=? AND status='approved') AND role='member'").bind(time,member.sub,email)
          ]);if(!changed[0].meta.changes)throw new HttpError(409,'Email 白名單已達 200 筆上限。');return json({ok:true,email});
        }
        if(apiPath==='admin/allowlist/remove'&&request.method==='POST'){
          const body=await readJSON(request),email=normalizeEmail(body.email);if(!email||email===env.ADMIN_EMAIL)throw new HttpError(400,'Email 不正確或為管理員帳號。');
          const entry=await env.DB.prepare('SELECT email FROM email_allowlist WHERE email=?').bind(email).first();if(!entry)throw new HttpError(404,'找不到這個 Email。');
          const time=now();await env.DB.batch([
            env.DB.prepare("UPDATE email_allowlist SET status='revoked',updated_at=?,updated_by=? WHERE email=?").bind(time,member.sub,email),
            env.DB.prepare("UPDATE members SET status='rejected',reviewed_at=?,reviewed_by=? WHERE sub=(SELECT member_sub FROM email_allowlist WHERE email=?) AND role='member'").bind(time,member.sub,email)
          ]);await removeRevokedCalendars(env);return json({ok:true});
        }
        if(apiPath==='admin/members'&&request.method==='GET'){
          const {results}=await env.DB.prepare("SELECT m.*,n.state AS notification,n.error_code FROM members m LEFT JOIN notifications n ON n.member_sub=m.sub WHERE m.status IN ('pending','approved') ORDER BY CASE m.status WHEN 'pending' THEN 0 ELSE 1 END,m.requested_at DESC LIMIT 200").all();return json({members:env.EMAIL&&env.MAIL_FROM?results:results.map(member=>({...member,notification:null,error_code:null}))});
        }
        if(apiPath==='admin/review'&&request.method==='POST'){
          const body=await readJSON(request);if(typeof body.sub!=='string'||!['approved','rejected'].includes(String(body.status)))throw new HttpError(400,'審核資料不正確。');
          const target=await env.DB.prepare("SELECT email FROM members WHERE sub=? AND role='member'").bind(body.sub).first<{email:string}>();if(!target)throw new HttpError(404,'找不到可審核的使用者。');
          const time=now();await env.DB.batch([
            env.DB.prepare("UPDATE members SET status=?,reviewed_at=?,reviewed_by=? WHERE sub=? AND role='member'").bind(body.status,time,member.sub,body.sub),
            env.DB.prepare('UPDATE email_allowlist SET status=?,member_sub=?,updated_at=?,updated_by=? WHERE email=? AND (member_sub IS NULL OR member_sub=?)').bind(body.status==='approved'?'approved':'revoked',body.sub,time,member.sub,target.email,body.sub)
          ]);if(body.status==='rejected')await removeRevokedCalendars(env);return json({ok:true});
        }
        if(apiPath==='admin/retry-notifications'&&request.method==='POST'){
          await env.DB.prepare("UPDATE notifications SET next_attempt_at=? WHERE state='queued'").bind(now()).run();await deliverNotifications(env);return json({ok:true});
        }
        throw new HttpError(404,'找不到此功能。');
      }
      if(!['GET','HEAD'].includes(request.method))throw new HttpError(405,'不支援此操作。');
      const page=path.slice(base.length);
      if(path==='/roomly'||['index','index.html'].includes(page)){
        const member=await memberFor(request,env);return serve(request,env,member?.status==='approved'?'index.html':'auth.html');
      }
      if(['admin','admin.html'].includes(page)){
        const member=await memberFor(request,env);if(!member)return serve(request,env,'auth.html');if(!isAdmin(member,env))throw new HttpError(403,'只有管理員可以開啟審核名單。');return serve(request,env,'admin.html');
      }
      if(['manifest.webmanifest','pwa.js','pwa.css','sw.js','offline.html','icon-192.png','icon-512.png','icon-maskable-512.png','apple-touch-icon.png'].includes(page)){
        const response=await serve(request,env),h=new Headers(response.headers);
        if(page==='manifest.webmanifest')h.set('Content-Type','application/manifest+json; charset=utf-8');
        if(page==='sw.js'){h.set('Content-Type','application/javascript; charset=utf-8');h.set('Service-Worker-Allowed',base);}
        return new Response(response.body,{status:response.status,headers:h});
      }
      if(['auth.html','access.js','admin.js','style.css','tablet.css','access.css','holidays.js','core.js','app.js','fullscreen.js','google.js','config.js','setup.html','privacy.html','about.html'].includes(page))return serve(request,env);
      throw new HttpError(404,'找不到此頁面。');
    }catch(error){
      if(error instanceof HttpError||error instanceof CalendarError)return json({error:error.message},error.status);
      console.error(JSON.stringify({event:'request_failed'}));return json({error:'服務暫時無法使用，請稍後重試。'},503);
    }
  },
  async scheduled(event:ScheduledController,env:Env,ctx:ExecutionContext){
    // Change notifications are durable work, checked each minute. The broader
    // safety refresh remains on ten-minute boundaries, including when idle.
    const fullSync=Math.floor(event.scheduledTime/60000)%10===0;
    ctx.waitUntil((async()=>{if(fullSync){await deliverNotifications(env);await env.DB.batch([env.DB.prepare('DELETE FROM sessions WHERE expires_at<=?').bind(now()),env.DB.prepare('DELETE FROM login_nonces WHERE expires_at<=?').bind(now())]);}await calendarMaintenance(env,fullSync);})());
  },
  async queue(batch:MessageBatch<unknown>,env:Env,_ctx:ExecutionContext){
    for(const message of batch.messages){
      const work=calendarQueueWork(message.body);
      if(!work){message.ack();continue;}
      try{
        if(work.manual&&await manualCalendarSyncBlocked(env,work.week)){message.retry({delaySeconds:180});continue;}
        // Queue jobs carry only a week. Approval, credentials, room settings,
        // retry times and leases are re-read by the existing source selector.
        await syncCalendars(env,work.week,work.manual,false,2);
        // Also cover a lease claimed between the initial check and selection.
        if(work.manual&&await manualCalendarSyncBlocked(env,work.week)){message.retry({delaySeconds:180});continue;}
        message.ack();
      }catch{
        console.warn(JSON.stringify({event:'calendar_queue_failed',code:'runtime_error'}));
        message.retry({delaySeconds:180});
      }
    }
  }
};}
export default createHandler();
