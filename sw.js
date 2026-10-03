'use strict';
// Cache only the public offline notice. Sessions, meetings and whitelist data
// always use the network and remain behind the server's access checks.
const CACHE='roomly-public-v1',OFFLINE='/roomly/offline.html';
self.addEventListener('install',event=>{
  event.waitUntil((async()=>{const cache=await caches.open(CACHE);await cache.add(OFFLINE);await self.skipWaiting();})());
});
self.addEventListener('activate',event=>{
  event.waitUntil((async()=>{for(const name of await caches.keys())if(name.startsWith('roomly-public-')&&name!==CACHE)await caches.delete(name);await self.clients.claim();})());
});
self.addEventListener('fetch',event=>{
  const request=event.request,url=new URL(request.url);
  if(request.method!=='GET'||request.mode!=='navigate'||url.origin!==self.location.origin||!url.pathname.startsWith('/roomly/')||url.pathname.startsWith('/roomly/api/'))return;
  event.respondWith((async()=>{
    try{return await fetch(request);}
    catch{return await caches.match(OFFLINE,{cacheName:CACHE})||new Response('目前無法連線，請恢復網路後重新開啟 Roomly。',{status:503,headers:{'Content-Type':'text/plain; charset=utf-8'}});}
  })());
});
