const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=name=>fs.readFileSync(require.resolve('../'+name),'utf8');
function installHarness(inApp=false){
 const events={},registrations=[],button={hidden:true,disabled:false,textContent:''},media={matches:inApp,addEventListener(){}},guides=[];
 const context={window:null,navigator:{serviceWorker:{register:async(...args)=>{registrations.push(args);}}},document:{querySelector:()=>button,body:{append:guide=>guides.push(guide)},createElement:()=>({open:false,setAttribute(){},querySelector:()=>({}),showModal(){this.open=true;},close(){this.open=false;}})},matchMedia:()=>media,addEventListener:(name,fn)=>events[name]=fn};context.window=context;vm.createContext(context);vm.runInContext(source('pwa.js'),context);return {button,events,registrations,guides,media};
}
function workerHarness(){
 const events={},added=[],deleted=[],cached=[],offline=new Response('公開的斷線提示'),context={URL,Response,self:{location:{origin:'https://roomly.example.com'},addEventListener:(name,fn)=>events[name]=fn,skipWaiting:async()=>{},clients:{claim:async()=>{}}},caches:{open:async()=>({add:async path=>added.push(path)}),keys:async()=>['trip-static-v1','roomly-public-old','roomly-public-v1'],delete:async name=>deleted.push(name),match:async(...args)=>{cached.push(args);return offline;}},fetch:async()=>new Response('PRIVATE_LIVE_BOARD')};vm.createContext(context);vm.runInContext(source('sw.js'),context);
 const lifecycle=async name=>{let done;events[name]({waitUntil:promise=>done=promise});await done;};
 const request=async(path,mode='navigate',method='GET')=>{let response;events.fetch({request:{url:new URL(path,'https://roomly.example.com').href,mode,method},respondWith:promise=>response=promise});return response?await response:undefined;};
 return {context,added,deleted,cached,lifecycle,request};
}
test('manifest installs Roomly as a standalone app limited to its existing path, with valid PNG icon dimensions',()=>{
 const manifest=JSON.parse(source('manifest.webmanifest'));assert.equal(manifest.display,'standalone');for(const key of ['id','start_url','scope'])assert.equal(manifest[key],'/roomly/');assert.equal(manifest.icons.filter(icon=>icon.purpose==='maskable').length,1);
 for(const icon of manifest.icons){const png=fs.readFileSync(require.resolve('..'+icon.src.replace('/roomly/','/')));assert.equal(png.subarray(1,4).toString(),'PNG');assert.equal(`${png.readUInt32BE(16)}x${png.readUInt32BE(20)}`,icon.sizes);}
 for(const page of ['index.html','auth.html','admin.html'])assert.match(source(page),/rel="manifest" href="\/roomly\/manifest.webmanifest"/);
});
test('installation stays user initiated and duplicate taps do not prompt twice',async()=>{
 const h=installHarness();assert.equal(h.button.hidden,false);let prompts=0,release;const choice=new Promise(resolve=>release=resolve);h.events.beforeinstallprompt({preventDefault(){},prompt:async()=>{prompts++;},userChoice:choice});assert.equal(prompts,0);const first=h.button.onclick();await h.button.onclick();assert.equal(prompts,1);assert.equal(h.button.disabled,true);release({outcome:'accepted'});await first;assert.equal(h.button.hidden,true);
});
test('browser fallback explains home-screen installation, while installed mode hides the install button',async()=>{
 const h=installHarness();await h.button.onclick();assert.equal(h.guides[0].open,true);assert.match(h.guides[0].innerHTML,/Safari.*加入主畫面/s);assert.match(h.guides[0].innerHTML,/Chrome/);h.events.appinstalled();assert.equal(h.button.hidden,true);assert.equal(h.guides[0].open,false);assert.equal(installHarness(true).button.hidden,true);await h.events.load();assert.equal(h.registrations[0][0],'/roomly/sw.js');assert.equal(h.registrations[0][1].scope,'/roomly/');
});
test('service worker caches only the public offline notice and preserves other applications caches',async()=>{
 const h=workerHarness();await h.lifecycle('install');assert.deepEqual(h.added,['/roomly/offline.html']);await h.lifecycle('activate');assert.deepEqual(h.deleted,['roomly-public-old']);
});
test('private pages always use live network, with a generic notice when offline, and are never cached',async()=>{
 const h=workerHarness();assert.equal(await (await h.request('/roomly/')).text(),'PRIVATE_LIVE_BOARD');assert.equal(h.cached.length,0);assert.equal(h.added.length,0);h.context.fetch=async()=>{throw Error('offline');};assert.equal(await (await h.request('/roomly/admin.html')).text(),'公開的斷線提示');assert.equal(h.cached[0][0],'/roomly/offline.html');assert.equal(h.added.length,0);
});
test('service worker leaves APIs, OAuth callbacks, mutations and other sites untouched',async()=>{
 const h=workerHarness();for(const path of ['/roomly/api/me','/roomly/api/calendar/callback?code=test','/roomly/api/admin/allowlist','/trip/','https://accounts.google.com/o/oauth2/v2/auth'])assert.equal(await h.request(path),undefined);assert.equal(await h.request('/roomly/', 'navigate', 'POST'),undefined);assert.equal(await h.request('/roomly/app.js','cors'),undefined);
});
