// ZoFHub · storage.js
const NS = 'zofhub:v2:';

function read(key, fallback) {
  try { const r = localStorage.getItem(NS + key); return r == null ? fallback : JSON.parse(r); }
  catch { return fallback; }
}
function write(key, value) { try { localStorage.setItem(NS + key, JSON.stringify(value)); } catch {} }

export const store = {
  favorites: {
    get: () => read('favorites', []),
    has: (id) => store.favorites.get().includes(id),
    toggle: (id) => {
      const s = new Set(store.favorites.get());
      s.has(id) ? s.delete(id) : s.add(id);
      write('favorites', [...s]);
      return s.has(id);
    }
  },
  history: {
    get: () => read('history', []),
    push: (id) => {
      const cur = store.history.get().filter(h => h.id !== id);
      cur.unshift({ id, ts: Date.now() });
      write('history', cur.slice(0, 80));
    },
    clear: () => write('history', [])
  },
  chats: {
    list: () => { const v = read('chats', []); return Array.isArray(v) ? v : []; },
    save: (chat) => {
      if (!chat || !chat.id) return;
      // Trim so one long conversation can never blow past the localStorage
      // quota (writes are already try/caught, but trimming keeps history
      // actually saving instead of silently failing on a huge chat).
      const safe = {
        ...chat,
        messages: Array.isArray(chat.messages)
          ? chat.messages.slice(-80).map(m => ({
              ...m,
              content: typeof m.content === 'string' ? m.content.slice(0, 12000) : m.content
            }))
          : []
      };
      const list = store.chats.list().filter(c => c.id !== safe.id);
      list.unshift(safe);
      write('chats', list.slice(0, 40));
    },
    get: (id) => store.chats.list().find(c => c.id === id),
    remove: (id) => write('chats', store.chats.list().filter(c => c.id !== id)),
    clear: () => write('chats', [])
  },
  bookmarks: {
    get: () => read('bookmarks', []),
    add: (url, title) => {
      const list = store.bookmarks.get().filter(b => b.url !== url);
      list.unshift({ url, title, ts: Date.now() });
      write('bookmarks', list.slice(0, 50));
    },
    remove: (url) => write('bookmarks', store.bookmarks.get().filter(b => b.url !== url))
  },
  panic: {
    get: () => read('panic', { url: 'https://classroom.google.com/h', mode: 'cloak', disguise: true, key: 'ctrl+Backquote' }),
    set: (patch) => { const cur = { ...store.panic.get(), ...patch }; write('panic', cur); return cur; }
  },
  wipe: () => { for (const k of Object.keys(localStorage)) if (k.startsWith(NS)) localStorage.removeItem(k); }
};
