self.addEventListener('push', event => {
  const data = event.data.json();
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.message,
      icon: '/icon.png'  // Optional icon
    })
  );
});

self.addEventListener('notificationclick', function(event) {
  event.notification.close();
  clients.openWindow(event.notification.data.url);
});
