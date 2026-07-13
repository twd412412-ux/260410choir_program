const SW_VERSION = 'choir-push-v2';

self.addEventListener('install', function(event) {
  self.skipWaiting();
});

self.addEventListener('activate', function(event) {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', function(event) {
  // Intentionally no cache. Data freshness is managed by the app.
});

self.addEventListener('push', function(event) {
  var payload={};
  try{payload=event.data?event.data.json():{};}catch(e){payload={body:event.data?event.data.text():''};}
  var title=payload.title||'광주교회 찬양대';
  var options={
    body:payload.body||'새로운 소식이 있습니다.',
    icon:payload.icon||'./assets/hymn-dove-book.png',
    badge:'./assets/hymn-dove-book.png',
    tag:payload.tag||'choir-update',
    renotify:false,
    data:{url:payload.url||'./'}
  };
  event.waitUntil(self.registration.showNotification(title,options));
});

self.addEventListener('notificationclick', function(event) {
  event.notification.close();
  var target=new URL((event.notification.data&&event.notification.data.url)||'./',self.registration.scope).href;
  event.waitUntil(clients.matchAll({type:'window',includeUncontrolled:true}).then(function(rows){
    for(var i=0;i<rows.length;i++){
      if(rows[i].url.indexOf(self.registration.scope)===0){
        return rows[i].focus().then(function(client){return 'navigate' in client?client.navigate(target):client;});
      }
    }
    return clients.openWindow(target);
  }));
});
