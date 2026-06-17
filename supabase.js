// ─── SFFU App — Supabase Auth ─────────────────────────────────────
// Replace these two values after creating your Supabase project:
// 1. Go to supabase.com → your project → Settings → API
// 2. Copy "Project URL" and "anon / public" key below

const SUPABASE_URL      = 'https://ipqoqhsnjubopybujetn.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_Jg-roLg8M-BZJ7dBfjEeig_HIdniPaV';

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
    try {
      const { data, error } = await client.auth.signInWithOAuth({
        provider: 'google',
        options: {
          // Plain Google sign-in. (The Calendar scope / offline access was removed —
          // it's part of the parked Google Calendar feature whose backend isn't set up,
          // and requesting that unconfigured sensitive scope broke the OAuth return.)
          redirectTo: _cleanUrl,
        },
      });
      if (error) {
        console.error('[SA] signIn error:', error.message);
        alert('Sign-in error: ' + error.message);
        return;
      }
      // If Supabase returned a URL but the browser didn't navigate, do it manually.
      if (data && data.url) window.location.href = data.url;
    } catch (e) {
      console.error('[SA] signIn exception:', e);
      alert('Sign-in exception: ' + (e && e.message ? e.message : e));
    }
  }

  // Connect Google Calendar (read + write events) — deliberately SEPARATE from login.
  // Re-runs Google OAuth requesting ONLY the calendar.events scope with offline
  // access, so Google issues a refresh token; init() below captures it and the app
  // stores it once (see connectGoogleCalendar in index.html). calendar.events covers
  // BOTH reading events (current popover) and creating/editing/deleting them (future
  // "Add Event" feature). Normal sign-in (signInWithGoogle, above) is left untouched.
  async function connectCalendar() {
    try {
      const { data, error } = await client.auth.signInWithOAuth({
        provider: 'google',
        options: {
          scopes: 'https://www.googleapis.com/auth/calendar.events',
          queryParams: { access_type: 'offline', prompt: 'consent' },
          redirectTo: _cleanUrl,
        },
      });
      if (error) {
        console.error('[SA] connectCalendar error:', error.message);
        alert('Calendar connect error: ' + error.message);
        return;
      }
      if (data && data.url) window.location.href = data.url;
    } catch (e) {
      console.error('[SA] connectCalendar exception:', e);
      alert('Calendar connect exception: ' + (e && e.message ? e.message : e));
    }
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
      // Capture the Google refresh token (offline access) so the app can persist it once.
      const prt = p.get('provider_refresh_token');
      if (prt) { try { window.SupabaseAuth._googleRefresh = prt; } catch (e) {} }
      window.history.replaceState({}, document.title, _cleanUrl);
    }
    if (!_state.session) {
      _state.session = await getSession();
    }
    _state.ready = true;
    _notify({ session: _state.session });
  })();

  window.SupabaseAuth = { signInWithGoogle, connectCalendar, signOut, getSession, onAuthStateChange, _state, _client: client, _googleRefresh: null };
})();
