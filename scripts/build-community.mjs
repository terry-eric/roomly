import {copyFile,lstat,mkdir,readFile,rm,writeFile,readdir} from 'node:fs/promises';
import {basename,dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Script} from 'node:vm';

export const projectRoot=resolve(dirname(fileURLToPath(import.meta.url)),'..');
export const COMMUNITY_FILES=Object.freeze(['index.html','style.css','tablet.css','holidays.js','core.js','app.js','fullscreen.js','community-client.js','community-bootstrap.js','community.css','community-pwa.js','community-sw.js','about.html','privacy.html','support.html','manifest.webmanifest','icon-192.png','icon-512.png']);
export const COMMUNITY_CSP="default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; worker-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'self'; manifest-src 'self'";

function replaceOnce(source,from,to){if(source.split(from).length!==2)throw Error('Shared board template changed; review community transform');return source.replace(from,to);}
export function privateStorageFreeApp(source){
  let app=source.replace(/try\{\r?\n  const saved=localStorage\.getItem\(storageKey\)[\s\S]*?\/\* A corrupt local store leaves the board empty; no samples are regenerated\. \*\/ \}/,'')
    .replace(/^try\{const legacy=JSON\.parse\(localStorage\.getItem\('roomly\.bookings\.v1'\)[^\n]*\n/m,'')
    .replace(/const storageKey='roomly\.single-room\.bookings\.v2';/,'')
    .replace("mode='local'","mode='google'")
    .replace(/function persist\(next\)\{[^\n]*\}/,"function persist(){notify('預約請於 Google 日曆建立。');return false;}");
  const exported=app.match(/^window\.RoomApp=\{([^\r\n]*),showDemo:\(\)=>\{[^\r\n]*\}\};$/m);
  if(!exported)throw Error('Shared board export changed; review community transform');
  // Replace the complete export statement so the callback's closing brace and
  // the surrounding object's closing brace cannot be confused by a greedy match.
  app=replaceOnce(app,exported[0],`window.RoomApp={${exported[1]},showDemo:()=>{}};`);
  if(/roomly\.single-room|roomly\.bookings|localStorage\.setItem\(storageKey|localStorage\.getItem\(storageKey|mode='local'/.test(app))throw Error('Local calendar data remains in community app');
  app=app.replaceAll("'roomly.'+id","'roomly.public.'+id");
  // Only display preferences (skip weekends/holidays) may use localStorage.
  if((app.match(/localStorage/g)||[]).length!==2)throw Error('Unexpected persistent storage in community app');
  new Script(app,{filename:'community/app.js'});
  return app;
}
async function boardHTML(project){
  let html=await readFile(join(project,'index.html'),'utf8');
  const [controls,settings,dialog]=await Promise.all(['controls.html','settings.html','dialog.html'].map(file=>readFile(join(project,'community',file),'utf8')));
  html=html.replace(/\s*<link rel="(?:manifest|apple-touch-icon)"[^>]*>/g,'')
    .replace(/\s*<meta name="apple-mobile-web-app-[^"]+"[^>]*>/g,'')
    .replace(/\s*<link rel="stylesheet" href="(?:access|pwa)\.css">/g,'')
    .replace(/\s*<script src="(?:pwa|access|config|google)\.js"[^>]*><\/script>/g,'')
    .replace(/\s*<script src="https:\/\/accounts\.google\.com\/gsi\/client"[^>]*><\/script>/g,'');
  html=replaceOnce(html,'<title>Roomly — 會議室預約</title>','<title>Roomly — 共用會議室看板</title>');
  html=replaceOnce(html,'<meta name="viewport" content="width=device-width, initial-scale=1">',`<meta name="viewport" content="width=device-width, initial-scale=1">\n  <meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="${COMMUNITY_CSP}">\n  <meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-title" content="Roomly"><link rel="manifest" href="manifest.webmanifest"><link rel="icon" href="icon-192.png">`);
  html=replaceOnce(html,'<link rel="stylesheet" href="tablet.css">','<link rel="stylesheet" href="tablet.css"><link rel="stylesheet" href="community.css">');
  html=html.replace(/<body data-page="board">/, '<body data-page="board" data-space="empty">')
    .replace(/<aside class="sidebar">[\s\S]*?<\/aside>/,`<aside class="sidebar"><a class="brand" href="./"><span class="brand-mark">r.</span>roomly<span class="brand-dot">●</span></a><nav aria-label="主要導覽"><button class="nav-item active" data-view="overview"><span>▦</span>時間表</button><button class="nav-item" data-view="import"><span>⚙</span>空間設定</button><a class="nav-support" href="support.html">支持 Roomly</a></nav><div id="account-controls" class="account-controls" hidden><span id="account-email"></span><button id="sign-out" type="button" class="quiet">登出</button></div><div class="sidebar-bottom"></div></aside>\n<section id="login-gate" class="login-gate"><div class="login-copy"><p class="eyebrow">ROOM TOGETHER</p><h1>會議室的空檔，<br>讓大家一眼看見。</h1><p>放在會議室外的平板，或打開手機。用自己的 Google 帳號建立空間，邀請同事加入，共用同一份會議看板。</p><button id="google-login" class="primary" type="button">使用 Google 登入</button><p class="login-note">免費公開版 · 手動同步 · 每人自行授權日曆</p><div class="login-links"><a href="about.html">使用說明</a><a href="privacy.html">隱私說明</a><a href="support.html">支持 Roomly</a></div></div><div class="login-art" aria-hidden="true"><div class="art-top"><span>ROOMLY</span><i></i></div><div class="art-status">在門口看空檔<br><small>在手機規劃下一場會議</small></div><div class="art-grid"><b>09:00</b><b>10:00</b><b>11:00</b><span></span><span class="art-booking"></span><span></span><span></span><span></span><span class="art-booking pale"></span></div><p>示意圖 · 非實際會議資料</p></div></section>`)
    .replace(/<header>[\s\S]*?<\/header>/,'<header><strong id="breadcrumb">預約總覽</strong><span class="demo-label">Google 日曆</span></header>');
  html=replaceOnce(html,'<main>','<main id="community-main" hidden>'+controls);
  html=replaceOnce(html,'<div class="login-links">','<p id="login-error" class="community-error" role="alert" hidden></p><div class="login-links">');
  const start=html.indexOf('      <div class="tablet-heading">'),end=html.indexOf('      <div class="tablet-toolbar">');
  if(start<0||end<start)throw Error('Missing timeline heading');
  html=html.slice(0,start)+`<div class="tablet-heading"><div><h1 id="room-name"></h1><p id="week-label"></p></div><button id="new-booking" hidden disabled>預約請於 Google 日曆建立</button></div><div class="google-entry"><div class="google-entry-status"><div class="notice" role="status">新增或變更會議後，請按同步。</div><p id="sync-job" role="status" hidden></p></div><div class="google-entry-actions"><button id="pwa-install" class="quiet outlined" type="button" hidden>安裝 App</button><button id="google-start" class="primary" type="button" disabled>同步會議</button></div></div><div class="location-filter" hidden></div><details id="shared-calendars" class="shared-calendars"><summary id="shared-summary">同步來源</summary><p class="small muted">只在手動同步完成後更新成功時間。未授權或失敗的來源會分別標示。</p><button id="refresh-sources" class="quiet outlined" type="button">查看同步結果</button><div id="shared-calendar-list"></div></details>`+html.slice(end);
  const settingsStart=html.indexOf('    <section id="import"'),settingsEnd=html.indexOf('\n  </main>',settingsStart);
  if(settingsStart<0||settingsEnd<settingsStart)throw Error('Missing settings view');
  html=html.slice(0,settingsStart)+settings+html.slice(settingsEnd);
  html=replaceOnce(html,'<div id="toast" role="status" hidden></div>',dialog+'<div id="toast" role="status" hidden></div>');
  html=replaceOnce(html,'<script src="fullscreen.js"></script>','<script src="fullscreen.js"></script>\n<script src="community-client.js"></script>\n<script src="community-bootstrap.js"></script>\n<script src="community-pwa.js"></script>');
  if(/(?:access|config|google)\.js|admin\.html|demo-fixtures/.test(html)||/<script[^>]*src="https?:/i.test(html))throw Error('Production integration remains in community board');
  return html;
}
export async function buildCommunity({projectDir=projectRoot}={}){
  const project=resolve(projectDir),output=join(project,'community-dist');
  if(basename(output)!=='community-dist'||dirname(output)!==project)throw Error('Invalid community destination');
  try{if((await lstat(output)).isSymbolicLink())throw Error('Community output must not be a symlink');}catch(error){if(error.code!=='ENOENT')throw error;}
  const [html,app,style]=await Promise.all([boardHTML(project),readFile(join(project,'app.js'),'utf8').then(privateStorageFreeApp),readFile(join(project,'style.css'),'utf8').then(value=>value.replace(/^@import\s+url\([^\n]*\);\s*/gm,''))]);
  if(/@import|url\(\s*["']?(?:https?:|\/\/)/i.test(style))throw Error('External CSS remains');
  await rm(output,{recursive:true,force:true});await mkdir(join(output,'roomly'),{recursive:true});const destination=join(output,'roomly');
  for(const file of ['tablet.css','holidays.js','core.js','fullscreen.js','icon-192.png','icon-512.png'])await copyFile(join(project,file),join(destination,file));
  for(const [from,to] of [['client.js','community-client.js'],['bootstrap.js','community-bootstrap.js'],['community.css','community.css'],['pwa.js','community-pwa.js'],['sw.js','community-sw.js'],['about.html','about.html'],['privacy.html','privacy.html'],['support.html','support.html'],['manifest.webmanifest','manifest.webmanifest']])await copyFile(join(project,'community',from),join(destination,to));
  await Promise.all([writeFile(join(destination,'index.html'),html),writeFile(join(destination,'app.js'),app),writeFile(join(destination,'style.css'),style),writeFile(join(output,'_headers'),`/roomly/*\n  X-Content-Type-Options: nosniff\n  Referrer-Policy: no-referrer\n  Cache-Control: no-store\n  Content-Security-Policy: ${COMMUNITY_CSP}\n`)]);
  const built=await readdir(destination);if(built.length!==COMMUNITY_FILES.length||built.some(file=>!COMMUNITY_FILES.includes(file)))throw Error('Unexpected public community asset');
  // Parse the exact browser files being deployed, including generated output.
  // This checks syntax without executing code or contacting external services.
  for(const file of built.filter(file=>file.endsWith('.js')))new Script(await readFile(join(destination,file),'utf8'),{filename:'community/'+file});
  return output;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){await buildCommunity();console.log('Built public community assets under /roomly/');}
