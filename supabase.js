// ─── SFFU App — Supabase Auth ─────────────────────────────────────
// Replace these two values after creating your Supabase project:
// 1. Go to supabase.com → your project → Settings → API
// 2. Copy "Project URL" and "anon / public" key below

const SUPABASE_URL      = 'YOUR_SUPABASE_URL';
const SUPABASE_ANON_KEY = 'YOUR_SUPABASE_ANON_KEY';

(function () {
  'use strict';

  if (!window.supabase) { console.error('[SA] Supabase CDN not loaded.'); return; }

  const client = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { flowType: 'implicit', detectSessionInUrl: false, persistSession: true },
  });

  const _state = { session: null, ready: false };
  const _cleanUrl = window.location.origin + window.location.pathname;
  const _listeners = [];

  async function signInWithGoogle() {
    const { error } = await client.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: _cleanUrl },
    });
    if (error) console.error('[SA] signIn error:', error.message);
  }

  async function signOut() {
    await client.auth.signOut();
    _state.session = null;
    window.history.replaceState({}, document.title, _cleanUrl);
    _notify({ session: null });
  }

  async function getSession() {
    const { data: { session } } = await client.auth.getSession();
    return session;
  }

  function onAuthStateChange(callback) {
    _listeners.push(callback);
    if (_state.ready) callback({ session: _state.session });
  }

  function _notify(state) {
    _listeners.forEach(fn => { try { fn(state); } catch (e) {} });
  }

  client.auth.onAuthStateChange(async (event, session) => {
    _state.session = session;
    _notify({ session });
  });

  // ─── Init: handle OAuth redirect hash, then restore session ───
  (async function init() {
    const hash = window.location.hash;
    if (hash && hash.includes('access_token=')) {
      const p = new URLSearchParams(hash.substring(1));
      const at = p.get('access_token');
      const rt = p.get('refresh_token');
      if (at && rt) {
        const { data, error } = await client.auth.setSession({ access_token: at, refresh_token: rt });
        if (!error && data.session) _state.session = data.session;
      }
      window.history.replaceState({}, document.title, _cleanUrl);
    }
    if (!_state.session) {
      _state.session = await getSession();
    }
    _state.ready = true;
    _notify({ session: _state.session });
  })();

  window.SupabaseAuth = { signInWithGoogle, signOut, getSession, onAuthStateChange, _state, _client: client };
})();
