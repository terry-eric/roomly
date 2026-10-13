import {verifyCredential} from '../worker.ts';
import {CommunityError,type CommunityEnv,type SessionMember,now,random,hash,json,readCookie,cookie,sessionName,oauthName,sessionAge,memberFor,renewSession,checkOrigin} from './common.ts';

export const eventScope='https://www.googleapis.com/auth/calendar.events.readonly';
export const listScope='https://www.googleapis.com/auth/calendar.calendarlist.readonly';
type Identity={sub:string;email:string;name:string;emailAuthoritative:boolean};
export type CommunityVerifier=(credential:string,clientId:string,nonce:string)=>Promise<Identity>;
export type CommunityFetcher=typeof fetch;
type OAuthState={state_hash:string;purpose:'login'|'calendar';member_sub:string|null;session_hash:string|null;nonce:string;verifier:string;grant_generation:number;expires_at:number};
const callback=(purpose:'login'|'calendar')=>'/roomly/api/'+(purpose==='login'?'login/redirect':'calendar/callback');
const requiredScopes=(scope:unknown)=>typeof scope==='string'&&[eventScope,listScope].every(value=>scope.split(/\s+/).includes(value));
function ready(env:CommunityEnv){if(!env.GOOGLE_CLIENT_ID||!env.GOOGLE_CLIENT_SECRET)throw new CommunityError(503,'Google 登入尚未設定完成。');}
async function tokenKey(env:CommunityEnv){if(!/^[a-f0-9]{64}$/i.test(env.PUBLIC_CALENDAR_TOKEN_KEY||''))throw new CommunityError(503,'日曆授權尚未設定完成。');return crypto.subtle.importKey('raw',new Uint8Array((env.PUBLIC_CALENDAR_TOKEN_KEY.match(/../g)||[]).map(value=>parseInt(value,16))),'AES-GCM',false,['encrypt','decrypt']);}
// The distinct key and authenticated namespace prevent a public grant being
// accepted as a company grant, or copied to a different Google subject.
export async function sealCommunityToken(env:CommunityEnv,sub:string,token:string){const iv=crypto.getRandomValues(new Uint8Array(12)),cipher=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:new TextEncoder().encode('roomly-public:'+sub)},await tokenKey(env),new TextEncoder().encode(token));return JSON.stringify([Array.from(iv),Array.from(new Uint8Array(cipher))]);}
export async function openCommunityToken(env:CommunityEnv,sub:string,cipher:string){const [iv,data]=JSON.parse(cipher);return new TextDecoder().decode(await crypto.subtle.decrypt({name:'AES-GCM',iv:new Uint8Array(iv),additionalData:new TextEncoder().encode('roomly-public:'+sub)},await tokenKey(env),new Uint8Array(data)));}
function redirect(env:CommunityEnv,purpose:'login'|'calendar',result:string,cookies:string[]=[]){const headers=new Headers({'Location':env.PUBLIC_APP_ORIGIN+'/roomly/?'+purpose+'='+result,'Cache-Control':'private, no-store','Referrer-Policy':'no-referrer'});headers.append('Set-Cookie',cookie(oauthName,'',0));for(const value of cookies)headers.append('Set-Cookie',value);return new Response(null,{status:303,headers});}
async function challenge(verifier:string){const bytes=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(verifier)));return btoa(String.fromCharCode(...bytes)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');}
async function begin(request:Request,env:CommunityEnv,purpose:'login'|'calendar',member:SessionMember|null){
  ready(env);if(new URL(request.url).origin!==env.PUBLIC_APP_ORIGIN)throw new CommunityError(403,'請從 Roomly 網站操作。');
  if(purpose==='calendar'){checkOrigin(request,env);await tokenKey(env);if(!member)throw new CommunityError(401,'請先登入。');}
  const state=random(),nonce=random(),verifier=random(),time=now(),previous=readCookie(request,oauthName);
  const statements=[env.PUBLIC_DB.prepare('DELETE FROM community_oauth_states WHERE expires_at<=?').bind(time),env.PUBLIC_DB.prepare('DELETE FROM community_sessions WHERE expires_at<=?').bind(time)];
  if(/^[a-f0-9]{64}$/.test(previous))statements.push(env.PUBLIC_DB.prepare('DELETE FROM community_oauth_states WHERE state_hash=?').bind(await hash(previous)));
  if(purpose==='calendar'){
    statements.push(env.PUBLIC_DB.prepare('UPDATE community_members SET calendar_generation=calendar_generation+1 WHERE sub=?').bind(member!.sub));
    statements.push(env.PUBLIC_DB.prepare("INSERT INTO community_oauth_states(state_hash,purpose,member_sub,session_hash,nonce,verifier,grant_generation,expires_at) SELECT ?,'calendar',m.sub,?,?,?,m.calendar_generation,? FROM community_members m JOIN community_sessions s ON s.member_sub=m.sub WHERE m.sub=? AND s.hash=? AND s.expires_at>?").bind(await hash(state),member!.sessionHash,nonce,verifier,time+600,member!.sub,member!.sessionHash,time));
  }else statements.push(env.PUBLIC_DB.prepare("INSERT INTO community_oauth_states(state_hash,purpose,nonce,verifier,expires_at) VALUES(?,'login',?,?,?)").bind(await hash(state),nonce,verifier,time+600));
  const result=await env.PUBLIC_DB.batch(statements);if(!result.at(-1)?.meta.changes)throw new CommunityError(401,'登入已失效，請重新登入。');
  const url=new URL('https://accounts.google.com/o/oauth2/v2/auth');const params:Record<string,string>={client_id:env.GOOGLE_CLIENT_ID,redirect_uri:env.PUBLIC_APP_ORIGIN+callback(purpose),response_type:'code',scope:'openid email profile'+(purpose==='calendar'?' '+eventScope+' '+listScope:''),state,nonce,code_challenge:await challenge(verifier),code_challenge_method:'S256'};
  if(purpose==='calendar'){params.access_type='offline';params.prompt='consent';params.login_hint=member!.email;params.include_granted_scopes='true';}else params.prompt='select_account';
  for(const[key,value]of Object.entries(params))url.searchParams.set(key,value);
  const oauthCookie=cookie(oauthName,state,600);
  return purpose==='login'?new Response(null,{status:303,headers:{Location:url.href,'Cache-Control':'private, no-store','Referrer-Policy':'no-referrer','Set-Cookie':oauthCookie}}):json({url:url.href},200,[oauthCookie]);
}
async function exchange(env:CommunityEnv,state:OAuthState,code:string,fetcher:CommunityFetcher){
  const response=await fetcher('https://oauth2.googleapis.com/token',{method:'POST',redirect:'manual',headers:{'Content-Type':'application/x-www-form-urlencoded'},signal:AbortSignal.timeout(20000),body:new URLSearchParams({client_id:env.GOOGLE_CLIENT_ID,client_secret:env.GOOGLE_CLIENT_SECRET,redirect_uri:env.PUBLIC_APP_ORIGIN+callback(state.purpose),grant_type:'authorization_code',code,code_verifier:state.verifier})});
  if(!response.ok)throw new CommunityError(401,'Google 授權未完成，請重新登入。');
  const text=await response.text();if(text.length>65536)throw new CommunityError(502,'Google 授權回應不正確。');let data:Record<string,unknown>;try{data=JSON.parse(text);}catch{throw new CommunityError(502,'Google 授權回應不正確。');}
  if(!data||typeof data!=='object'||typeof data.id_token!=='string'||!data.id_token||data.id_token.length>14000)throw new CommunityError(401,'Google 身分驗證未完成。');return data;
}
async function finish(request:Request,env:CommunityEnv,purpose:'login'|'calendar',verify:CommunityVerifier,fetcher:CommunityFetcher){
  ready(env);const url=new URL(request.url);if(url.origin!==env.PUBLIC_APP_ORIGIN)throw new CommunityError(403,'請從 Roomly 網站操作。');
  const stateValue=url.searchParams.get('state')||'',code=url.searchParams.get('code')||'',browserState=readCookie(request,oauthName);
  const providerError=url.searchParams.get('error'),errorReturn=providerError!==null&&url.searchParams.getAll('error').length===1&&url.searchParams.getAll('code').length===0;
  if(url.searchParams.getAll('state').length!==1||!/^[a-f0-9]{64}$/.test(stateValue)||browserState!==stateValue||(!errorReturn&&(url.searchParams.getAll('code').length!==1||!code||code.length>4096||/[\u0000-\u0020\u007f]/.test(code)))||(providerError!==null&&!errorReturn))return redirect(env,purpose,'expired');
  const member=purpose==='calendar'?await memberFor(request,env):null;if(purpose==='calendar'&&!member)return redirect(env,purpose,'expired');
  const state=await env.PUBLIC_DB.prepare("DELETE FROM community_oauth_states WHERE state_hash=? AND purpose=? AND expires_at>? AND (?='login' OR (member_sub=? AND session_hash=? AND grant_generation=(SELECT calendar_generation FROM community_members WHERE sub=?))) RETURNING *").bind(await hash(stateValue),purpose,now(),purpose,member?.sub||'',member?.sessionHash||'',member?.sub||'').first<OAuthState>();
  if(!state)return redirect(env,purpose,'expired');
  if(errorReturn)return redirect(env,purpose,providerError==='access_denied'?'cancelled':'failed');
  try{
    const data=await exchange(env,state,code,fetcher),identity=await verify(data.id_token as string,env.GOOGLE_CLIENT_ID,state.nonce);
    if(!identity.sub||!identity.email||typeof identity.name!=='string')throw new CommunityError(401,'Google 身分驗證未完成。');
    if(purpose==='login'){
      const token=random(),time=now();const old=readCookie(request,sessionName);const statements=[env.PUBLIC_DB.prepare('INSERT INTO community_members(sub,email,name,email_authoritative,created_at) VALUES(?,?,?,?,?) ON CONFLICT(sub) DO UPDATE SET email=excluded.email,name=excluded.name,email_authoritative=excluded.email_authoritative').bind(identity.sub,identity.email,identity.name,identity.emailAuthoritative?1:0,time),env.PUBLIC_DB.prepare('INSERT INTO community_sessions(hash,member_sub,expires_at) VALUES(?,?,?)').bind(await hash(token),identity.sub,time+sessionAge)];
      if(/^[a-f0-9]{64}$/.test(old))statements.push(env.PUBLIC_DB.prepare('DELETE FROM community_sessions WHERE hash=?').bind(await hash(old)));
      statements.push(env.PUBLIC_DB.prepare('DELETE FROM community_sessions WHERE member_sub=? AND hash NOT IN (SELECT hash FROM community_sessions WHERE member_sub=? ORDER BY expires_at DESC,rowid DESC LIMIT 10)').bind(identity.sub,identity.sub));
      await env.PUBLIC_DB.batch(statements);return redirect(env,purpose,'success',[cookie(sessionName,token,sessionAge)]);
    }
    if(identity.sub!==member!.sub||identity.email!==member!.email)return redirect(env,purpose,'wrong_account');
    if(!requiredScopes(data.scope))return redirect(env,purpose,'permissions');
    if(typeof data.refresh_token!=='string'||!data.refresh_token||data.refresh_token.length>8192)return redirect(env,purpose,'refresh_required');
    const version=random(),cipher=await sealCommunityToken(env,member!.sub,data.refresh_token),time=now();
    // Revocation or a newer authorization invalidates this callback's generation.
    // This test occurs in the same transaction as grant replacement/cache removal.
    const result=await env.PUBLIC_DB.batch([env.PUBLIC_DB.prepare("INSERT INTO community_grants(member_sub,refresh_cipher,version,status,scope,updated_at) SELECT m.sub,?,?,'connected',?,? FROM community_members m JOIN community_sessions s ON s.member_sub=m.sub WHERE m.sub=? AND m.calendar_generation=? AND s.hash=? AND s.expires_at>? ON CONFLICT(member_sub) DO UPDATE SET refresh_cipher=excluded.refresh_cipher,version=excluded.version,status='connected',scope=excluded.scope,updated_at=excluded.updated_at").bind(cipher,version,data.scope,time,member!.sub,state.grant_generation,member!.sessionHash,time),env.PUBLIC_DB.prepare('DELETE FROM community_snapshots WHERE member_sub=? AND EXISTS(SELECT 1 FROM community_grants WHERE member_sub=? AND version=?)').bind(member!.sub,member!.sub,version),env.PUBLIC_DB.prepare("UPDATE community_sync_items SET status='skipped',error_code='GRANT_CHANGED' WHERE member_sub=? AND status IN ('pending','running') AND EXISTS(SELECT 1 FROM community_grants WHERE member_sub=? AND version=?)").bind(member!.sub,member!.sub,version)]);
    return redirect(env,purpose,result[0].meta.changes?'success':'expired');
  }catch{return redirect(env,purpose,'failed');}
}
export function createCommunityAuth(verify:CommunityVerifier=verifyCredential,fetcher:CommunityFetcher=fetch){return {
  startLogin:(request:Request,env:CommunityEnv)=>begin(request,env,'login',null),
  finishLogin:(request:Request,env:CommunityEnv)=>finish(request,env,'login',verify,fetcher),
  startCalendar:(request:Request,env:CommunityEnv,member:SessionMember)=>begin(request,env,'calendar',member),
  finishCalendar:(request:Request,env:CommunityEnv)=>finish(request,env,'calendar',verify,fetcher)
};}
export async function communityMe(request:Request,env:CommunityEnv,member:SessionMember){
  const [spaces,grant]=await Promise.all([env.PUBLIC_DB.prepare('SELECT s.id,s.name,s.location,m.role,m.share_enabled AS shareEnabled FROM community_spaces s JOIN community_memberships m ON m.space_id=s.id WHERE m.member_sub=? ORDER BY s.created_at,s.id').bind(member.sub).all<{id:string;name:string;location:string;role:string;shareEnabled:number}>(),env.PUBLIC_DB.prepare('SELECT status,scope FROM community_grants WHERE member_sub=?').bind(member.sub).first<{status:string;scope:string}>()]);
  const state=!grant?'unauthorized':grant.status==='connected'&&requiredScopes(grant.scope)?'connected':'reauthorize';
  return json({user:{email:member.email,name:member.name},spaces:spaces.results.map(space=>({...space,shareEnabled:!!space.shareEnabled})),calendar:{state},mode:'manual'},200,await renewSession(request,env,member));
}
export async function communityLogout(request:Request,env:CommunityEnv,member:SessionMember){checkOrigin(request,env);await env.PUBLIC_DB.batch([env.PUBLIC_DB.prepare('DELETE FROM community_sessions WHERE hash=? AND member_sub=?').bind(member.sessionHash,member.sub),env.PUBLIC_DB.prepare('DELETE FROM community_oauth_states WHERE session_hash=?').bind(member.sessionHash)]);return json({ok:true},200,[cookie(sessionName,'',0),cookie(oauthName,'',0)]);}
export async function disconnectCalendar(request:Request,env:CommunityEnv,member:SessionMember){checkOrigin(request,env);await env.PUBLIC_DB.batch([env.PUBLIC_DB.prepare('UPDATE community_members SET calendar_generation=calendar_generation+1 WHERE sub=?').bind(member.sub),env.PUBLIC_DB.prepare('DELETE FROM community_grants WHERE member_sub=?').bind(member.sub),env.PUBLIC_DB.prepare('DELETE FROM community_snapshots WHERE member_sub=?').bind(member.sub),env.PUBLIC_DB.prepare("DELETE FROM community_oauth_states WHERE member_sub=? AND purpose='calendar'").bind(member.sub),env.PUBLIC_DB.prepare("UPDATE community_sync_items SET status='skipped',error_code='GRANT_REMOVED' WHERE member_sub=? AND status IN ('pending','running')").bind(member.sub)]);return json({ok:true,calendar:{state:'unauthorized'}});}
