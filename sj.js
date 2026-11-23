const BASE = new URL('./', self.location.href);
const CACHE = 'fluxo-records-c58801c5902b3310';
self.addEventListener('install',event=>event.waitUntil((async()=>{
  const response=await fetch(new URL('shell.json',BASE),{cache:'no-store'});
  if(!response.ok)throw new Error('Lista offline indisponível.');
  const files=await response.json();
  if(!Array.isArray(files)||files.some(f=>typeof f!=='string'||f.startsWith('/')||f.includes('..')||new URL(f,BASE).origin!==BASE.origin))throw new Error('Lista offline inválida.');
  const cache=await caches.open(CACHE);
  await cache.addAll(files.map(f=>new Request(new URL(f,BASE),{cache:'reload'})));
})()));
// Não substituir páginas abertas nem apagar caches anteriores.
self.addEventListener('activate',event=>event.waitUntil(self.clients.claim()));
self.addEventListener('fetch',event=>{
  const url=new URL(event.request.url);
  if(event.request.method!=='GET'||url.origin!==BASE.origin||!url.pathname.startsWith(BASE.pathname))return;
  event.respondWith((async()=>{
    try{return await fetch(event.request);}catch(error){
      const cache=await caches.open(CACHE),saved=await cache.match(event.request,{ignoreSearch:true});
      if(saved)return saved;
      if(event.request.mode==='navigate'){const page=await cache.match(new URL('index.html',BASE));if(page)return page;}
      throw error;
    }
  })());
});
self.addEventListener('push',event=>{
  let data;try{data=event.data?.json();}catch{return;}
  if(typeof data?.title!=='string')return;
  event.waitUntil(self.registration.showNotification(data.title,{body:typeof data.body==='string'?data.body:'',icon:new URL('logo.png',BASE).href}));
});
