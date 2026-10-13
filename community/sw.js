'use strict';
const CACHE='roomly-community-assets-v1';
const STATIC=new Set(['style.css','tablet.css','community.css','holidays.js','core.js','app.js','fullscreen.js','community-client.js','community-bootstrap.js','community-pwa.js','manifest.webmanifest','icon-192.png','icon-512.png'].map(file=>'/roomly/'+file));
self.addEventListener('install',event=>event.waitUntil((async()=>{
  const cache=await caches.open(CACHE);
  await cache.addAll([...STATIC]);
  await self.skipWaiting();
})()));
self.addEventListener('activate',event=>event.waitUntil((async()=>{
  for(const name of await caches.keys())if(name==='roomly-public-v1'||(name.startsWith('roomly-community-assets-')&&name!==CACHE))await caches.delete(name);
  await self.clients.claim();
})()));
self.addEventListener('fetch',event=>{
  const request=event.request,url=new URL(request.url);
  // Pages, OAuth flows, invite links and private API responses always use the network.
  if(request.method!=='GET'||request.mode==='navigate'||url.origin!==self.location.origin||url.search||!STATIC.has(url.pathname))return;
  event.respondWith((async()=>{
    const cache=await caches.open(CACHE);
    try{
      const response=await fetch(request);
      if(response.ok&&response.type!=='opaque'&&!response.redirected)await cache.put(request,response.clone());
      return response;
    }catch(error){const cached=await cache.match(request);if(cached)return cached;throw error;}
  })());
});
