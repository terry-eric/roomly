import {CommunityError,type CommunityEnv,memberFor,json,checkOrigin} from './common.ts';
import {createCommunityAuth,communityMe,communityLogout,disconnectCalendar,type CommunityVerifier,type CommunityFetcher} from './auth.ts';
import {createSpace,spaceSettings,listMembers,removeMember,leaveSpace,createInvite,revokeInvite,previewInvite,acceptInvite} from './spaces.ts';
import {communitySyncAPI,consumeCommunityQueue} from './sync.ts';

// Public assets are built from an explicit allowlist. The old company access,
// Google sync and administrator scripts are deliberately unreachable here.
const publicFiles=new Set(['index.html','style.css','tablet.css','holidays.js','core.js','app.js','fullscreen.js','community-client.js','community-bootstrap.js','community.css','community-pwa.js','community-sw.js','about.html','privacy.html','support.html','manifest.webmanifest','icon-192.png','icon-512.png']);
const publicCSP="default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; worker-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'self'; manifest-src 'self'";
async function serve(request:Request,env:CommunityEnv,file:string){const url=new URL(request.url);url.pathname='/roomly/'+file;url.search='';const response=await env.ASSETS.fetch(new Request(url,request)),headers=new Headers(response.headers);headers.set('X-Content-Type-Options','nosniff');headers.set('Referrer-Policy','no-referrer');headers.set('Content-Security-Policy',publicCSP);headers.set('Cache-Control',file==='index.html'?'private, no-store':'no-cache');if(file==='community-sw.js')headers.set('Service-Worker-Allowed','/roomly/');return new Response(response.body,{status:response.status,headers});}
export function createCommunityHandler(verify?:CommunityVerifier,fetcher?:CommunityFetcher){const auth=createCommunityAuth(verify,fetcher);return {
  async fetch(request:Request,env:CommunityEnv,_ctx:ExecutionContext):Promise<Response>{try{
    const url=new URL(request.url);if(url.origin!==env.PUBLIC_APP_ORIGIN)throw new CommunityError(403,'請從 Roomly 網站操作。');
    let segments:string[];try{segments=url.pathname.split('/').filter(Boolean).map(value=>decodeURIComponent(value));}catch{throw new CommunityError(400,'網址格式不正確。');}
    if(segments[0]!=='roomly')return new Response('Not found',{status:404});
    if(segments.length===1&&!url.pathname.endsWith('/'))return new Response(null,{status:308,headers:{Location:'/roomly/','Cache-Control':'no-store'}});
    if(segments[1]!=='api'){
      if(!['GET','HEAD'].includes(request.method)||segments.length>2)return new Response('Not found',{status:404});const file=segments[1]||'index.html';if(!publicFiles.has(file))return new Response('Not found',{status:404});return await serve(request,env,file);
    }
    const route=segments.slice(2).join('/');
    if(request.method==='GET'&&route==='login/start')return await auth.startLogin(request,env);
    if(request.method==='GET'&&route==='login/redirect')return await auth.finishLogin(request,env);
    if(request.method==='GET'&&route==='calendar/callback')return await auth.finishCalendar(request,env);
    if(!['GET','POST','DELETE'].includes(request.method))return json({error:'不支援這個操作。'},405);
    if(request.method!=='GET')checkOrigin(request,env);
    const member=await memberFor(request,env);if(!member)throw new CommunityError(401,'請先登入 Google 帳號。');
    if(request.method==='GET'&&(route==='me'||route==='spaces'))return await communityMe(request,env,member);
    if(request.method==='POST'&&route==='logout')return await communityLogout(request,env,member);
    if(request.method==='POST'&&route==='calendar/start')return await auth.startCalendar(request,env,member);
    if(request.method==='POST'&&route==='calendar/disconnect')return await disconnectCalendar(request,env,member);
    if(request.method==='POST'&&route==='spaces')return await createSpace(request,env,member);
    if(request.method==='POST'&&route==='invites/preview')return await previewInvite(request,env,member);
    if(request.method==='POST'&&route==='invites/accept')return await acceptInvite(request,env,member);
    if(segments[2]==='spaces'&&segments[3]){
      const id=segments[3],action=segments[4],tail=segments.slice(5);
      if(!tail.length){
        if(action==='settings'&&request.method==='POST')return await spaceSettings(request,env,member,id);
        if(action==='members'&&request.method==='GET')return await listMembers(request,env,member,id);
        if(action==='leave'&&request.method==='POST')return await leaveSpace(request,env,member,id);
        if(action==='invites'&&request.method==='POST')return await createInvite(request,env,member,id);
        if((action==='feed'&&request.method==='GET')||(action==='sync'&&request.method==='POST'))return await communitySyncAPI(request,env,member,id,action);
      }
      if(action==='members'&&tail.length===1&&request.method==='DELETE')return await removeMember(request,env,member,id,tail[0]);
      if(action==='invites'&&tail.length===2&&tail[1]==='revoke'&&request.method==='POST')return await revokeInvite(request,env,member,id,tail[0]);
      if(action==='jobs'&&tail.length===1&&request.method==='GET')return await communitySyncAPI(request,env,member,id,'jobs/'+tail[0]);
    }
    return json({error:'找不到這個功能。'},404);
  }catch(error){return error instanceof CommunityError?json({error:error.message},error.status):json({error:'服務暫時無法使用，請稍後再試。'},503);}},
  async queue(batch:MessageBatch<{jobId:string}>,env:CommunityEnv,ctx:ExecutionContext){await consumeCommunityQueue(batch,env,ctx);}
};}
export default createCommunityHandler();
