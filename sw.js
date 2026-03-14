/**
 * sw.js — Service Worker — Ponto dos Fogões v2.1
 *
 * Estratégias:
 *   • Shell (HTMLs + manifest) → Stale-while-revalidate
 *   • API Apps Script          → Network-first, fallback offline JSON
 *   • Fontes/CDN               → Cache-first (longa duração)
 *
 * Funcionalidades:
 *   • Offline completo para o shell do app
 *   • Push Notifications reais (Firebase / VAPID / OneSignal)
 *   • Background Sync para ponto offline
 *   • notificationclick com navegação para a OS/tela correta
 */

const CACHE_VERSION = 'pfg-v2.2';
const CACHE_STATIC  = `${CACHE_VERSION}-static`;

const API_PATTERN  = /script\.google\.com/;
const FONT_PATTERN = /googleapis\.com|gstatic\.com|cdnjs\.cloudflare\.com/;

const SHELL_ASSETS = [
  '/', '/index.html', '/os.html', '/estoque.html',
  '/vendas.html', '/dashboard.html', '/rh.html', '/admin.html', '/relatorios.html',
  '/manifest.json', '/icons/icon-192.png', '/icons/icon-512.png',
];

const OFFLINE_API_RESPONSE = JSON.stringify({
  ok: false,
  mensagem: 'Sem conexão com o servidor. Verifique sua internet.',
  offline: true
});

// ── INSTALL ──────────────────────────────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_STATIC)
      .then(cache => Promise.allSettled(
        SHELL_ASSETS.map(url => cache.add(url).catch(() => null))
      ))
      .then(() => self.skipWaiting())
  );
});

// ── ACTIVATE ─────────────────────────────────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE_STATIC).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

// ── FETCH ────────────────────────────────────────────────────
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  if (request.method !== 'GET') return;
  if (url.protocol === 'chrome-extension:') return;

  // API → Network-first + fallback offline
  if (API_PATTERN.test(url.hostname)) {
    event.respondWith(
      fetch(request).catch(() =>
        new Response(OFFLINE_API_RESPONSE, {
          status: 503,
          headers: { 'Content-Type': 'application/json' }
        })
      )
    );
    return;
  }

  // Fontes/CDN → Cache-first
  if (FONT_PATTERN.test(url.hostname)) {
    event.respondWith(
      caches.match(request).then(cached => {
        if (cached) return cached;
        return fetch(request).then(res => {
          if (res.status === 200) {
            caches.open(CACHE_STATIC).then(c => c.put(request, res.clone()));
          }
          return res;
        }).catch(() => new Response('', { status: 408 }));
      })
    );
    return;
  }

  // Assets locais → Stale-while-revalidate
  event.respondWith(
    caches.open(CACHE_STATIC).then(cache =>
      cache.match(request).then(cached => {
        const fetched = fetch(request).then(res => {
          if (res.status === 200) cache.put(request, res.clone());
          return res;
        }).catch(() => cached || caches.match('/index.html'));
        return cached || fetched;
      })
    )
  );
});

// ── BACKGROUND SYNC ──────────────────────────────────────────
self.addEventListener('sync', event => {
  if (event.tag === 'pfg-sync-ponto') {
    event.waitUntil(sincronizarPonto());
  }
});

async function sincronizarPonto() {
  try {
    const db = await abrirIDB();
    const pendentes = await lerIDB(db, 'ponto_offline');
    let sincronizados = 0;
    for (const item of pendentes) {
      try {
        const res = await fetch(item.api_url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(item.payload)
        });
        if (res.ok) {
          await deletarIDB(db, 'ponto_offline', item.id);
          sincronizados++;
        }
      } catch { /* Tenta na próxima sync */ }
    }
    if (sincronizados > 0) {
      self.registration.showNotification('Ponto dos Fogões', {
        body: `${sincronizados} ponto(s) sincronizado(s) com sucesso.`,
        icon: '/icons/icon-192.png', tag: 'sync-ok', silent: true
      });
    }
  } catch (e) {
    console.warn('[SW] Sync error:', e);
  }
}

// ── PUSH NOTIFICATIONS ───────────────────────────────────────
self.addEventListener('push', event => {
  let payload = {
    title: 'Ponto dos Fogões', body: 'Você tem uma notificação.',
    icon: '/icons/icon-192.png', badge: '/icons/icon-192.png',
    tag: 'pfg', data: { url: '/' }
  };

  if (event.data) {
    try {
      const d = event.data.json();
      switch (d.tipo) {
        case 'OS_PRONTA':
          payload = {
            title: '✅ OS Pronta para Entrega',
            body: `${d.produto || 'Equipamento'} de ${d.cliente || '—'} está pronto!`,
            icon: '/icons/icon-192.png', badge: '/icons/icon-192.png',
            tag: `os-pronta-${d.id_os}`, vibrate: [200, 100, 200],
            data: { url: `/os.html` },
            actions: [
              { action: 'abrir', title: '🔧 Ver OS' },
              { action: 'fechar', title: 'Fechar' }
            ]
          };
          break;
        case 'OS_ATRASO':
          payload = {
            title: `⚠️ OS em Atraso — ${d.id_os}`,
            body: `${d.dias || 1}d de atraso${d.tecnico ? ' · Tec: '+d.tecnico : ''}`,
            icon: '/icons/icon-192.png', badge: '/icons/icon-192.png',
            tag: `os-atraso-${d.id_os}`, data: { url: '/os.html' },
            requireInteraction: true
          };
          break;
        case 'ESTOQUE_BAIXO':
          payload = {
            title: '📦 Estoque Baixo',
            body: `${d.produto}: apenas ${d.qtd_disponivel || 0} un. disponíveis.`,
            icon: '/icons/icon-192.png', badge: '/icons/icon-192.png',
            tag: 'estoque-baixo', data: { url: '/estoque.html' }
          };
          break;
        default:
          Object.assign(payload, d);
      }
    } catch { payload.body = event.data.text(); }
  }

  event.waitUntil(
    self.registration.showNotification(payload.title, payload)
  );
});

// ── NOTIFICATION CLICK ───────────────────────────────────────
self.addEventListener('notificationclick', event => {
  event.notification.close();
  if (event.action === 'fechar') return;
  const url = event.notification.data?.url || '/';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const c of list) {
        if (c.url.includes(location.origin) && 'focus' in c) {
          c.focus();
          c.postMessage({ type: 'NAVIGATE', url });
          return;
        }
      }
      return clients.openWindow(url);
    })
  );
});

// ── MESSAGES ─────────────────────────────────────────────────
self.addEventListener('message', event => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
  if (event.data?.type === 'CACHE_CLEAR')
    caches.keys().then(keys => Promise.all(keys.map(k => caches.delete(k))));
});

// ── INDEXEDDB HELPERS ─────────────────────────────────────────
function abrirIDB() {
  return new Promise((res, rej) => {
    const req = indexedDB.open('pfg-offline', 1);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('ponto_offline'))
        db.createObjectStore('ponto_offline', { keyPath: 'id', autoIncrement: true });
    };
    req.onsuccess = () => res(req.result);
    req.onerror   = () => rej(req.error);
  });
}
function lerIDB(db, store) {
  return new Promise((res, rej) => {
    const r = db.transaction(store, 'readonly').objectStore(store).getAll();
    r.onsuccess = () => res(r.result || []);
    r.onerror   = () => rej(r.error);
  });
}
function deletarIDB(db, store, id) {
  return new Promise((res, rej) => {
    const r = db.transaction(store, 'readwrite').objectStore(store).delete(id);
    r.onsuccess = () => res();
    r.onerror   = () => rej(r.error);
  });
}
