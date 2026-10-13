// The public service has separate bindings, cookies and tables from the company board.
export interface CommunityEnv {
  PUBLIC_DB:D1Database;
  PUBLIC_SYNC_QUEUE:Queue<{jobId:string}>;
  PUBLIC_APP_ORIGIN:string;
  PUBLIC_CALENDAR_TOKEN_KEY:string;
  GOOGLE_CLIENT_ID:string;
  GOOGLE_CLIENT_SECRET:string;
  ASSETS:Fetcher;
}
export type SessionMember={sub:string;email:string;name:string;email_authoritative:number;sessionHash:string;sessionExpiresAt:number};
export type CommunitySpace={id:string;name:string;location:string;owner_sub:string;revision:number;sources_revision:number;role:'owner'|'member';share_enabled:number};
export class CommunityError extends Error {status:number;constructor(status:number,message:string){super(message);this.status=status;}}
export const now=()=>Math.floor(Date.now()/1000);
export const random=()=>Array.from(crypto.getRandomValues(new Uint8Array(32)),n=>n.toString(16).padStart(2,'0')).join('');
export async function hash(value:string){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))),n=>n.toString(16).padStart(2,'0')).join('');}
export const sessionName='roomly_public_session',oauthName='roomly_public_oauth',sessionAge=30*86400;
export const cookie=(name:string,value:string,age:number)=>`${name}=${value}; Path=/roomly/; Max-Age=${age}; HttpOnly; Secure; SameSite=Lax`;
export function readCookie(request:Request,name:string){const matches=(request.headers.get('Cookie')||'').split(';').map(p=>p.trim()).filter(p=>p.startsWith(name+'='));return matches.length===1?matches[0].slice(name.length+1):'';}
export function json(object:object,status=200,cookies:string[]=[]){const headers=new Headers({'Content-Type':'application/json; charset=utf-8','Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'});for(const value of cookies)headers.append('Set-Cookie',value);return new Response(JSON.stringify(object),{status,headers});}
export function checkOrigin(request:Request,env:CommunityEnv){if(request.headers.get('Origin')!==env.PUBLIC_APP_ORIGIN||new URL(request.url).origin!==env.PUBLIC_APP_ORIGIN)throw new CommunityError(403,'請從 Roomly 網站操作。');}
export async function readJSON(request:Request):Promise<Record<string,unknown>>{
  if(!/^application\/json(?:\s*;|$)/i.test(request.headers.get('Content-Type')||''))throw new CommunityError(415,'請使用 JSON 格式。');
  const reader=request.body?.getReader();if(!reader)throw new CommunityError(400,'缺少資料。');let size=0;const chunks:Uint8Array[]=[];
  for(;;){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>16384){await reader.cancel();throw new CommunityError(413,'資料過大。');}chunks.push(part.value);}
  const data=new Uint8Array(size);let offset=0;for(const chunk of chunks){data.set(chunk,offset);offset+=chunk.length;}
  try{const value:unknown=JSON.parse(new TextDecoder().decode(data));if(!value||typeof value!=='object'||Array.isArray(value))throw Error();return value as Record<string,unknown>;}catch{throw new CommunityError(400,'資料格式不正確。');}
}
export async function memberFor(request:Request,env:CommunityEnv):Promise<SessionMember|null>{
  const token=readCookie(request,sessionName);if(!/^[a-f0-9]{64}$/.test(token))return null;
  return env.PUBLIC_DB.prepare('SELECT m.sub,m.email,m.name,m.email_authoritative,s.hash AS sessionHash,s.expires_at AS sessionExpiresAt FROM community_sessions s JOIN community_members m ON m.sub=s.member_sub WHERE s.hash=? AND s.expires_at>?').bind(await hash(token),now()).first<SessionMember>();
}
export async function spaceFor(env:CommunityEnv,sub:string,spaceId:string,ownerOnly=false):Promise<CommunitySpace>{
  if(!/^[a-f0-9]{64}$/.test(spaceId))throw new CommunityError(403,'無法存取這個空間。');
  const space=await env.PUBLIC_DB.prepare('SELECT s.id,s.name,s.location,s.owner_sub,s.revision,s.sources_revision,m.role,m.share_enabled FROM community_spaces s JOIN community_memberships m ON m.space_id=s.id WHERE s.id=? AND m.member_sub=?').bind(spaceId,sub).first<CommunitySpace>();
  if(!space||(ownerOnly&&(space.role!=='owner'||space.owner_sub!==sub)))throw new CommunityError(403,'無法存取這個空間。');return space;
}
export async function renewSession(request:Request,env:CommunityEnv,member:SessionMember){
  const time=now(),threshold=time+sessionAge-86400;if(member.sessionExpiresAt>threshold)return [];
  const renewed=await env.PUBLIC_DB.prepare('UPDATE community_sessions SET expires_at=? WHERE hash=? AND member_sub=? AND expires_at>? AND expires_at<=? RETURNING expires_at').bind(time+sessionAge,member.sessionHash,member.sub,time,threshold).first<{expires_at:number}>();
  return renewed?[cookie(sessionName,readCookie(request,sessionName),Math.max(0,renewed.expires_at-now()))]:[];
}
