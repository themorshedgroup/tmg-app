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
  // /guide/<slug> deep-links aren't real pages (served via 404.html) and usually aren't
  // allowed OAuth redirect URLs, which blocks sign-in. Send OAuth back to the site root
  // for those — the app restores the guide from its sessionStorage deep-link stash.
  const _cleanUrl = window.location.origin + (/^\/guide(\/|$)/i.test(window.location.pathname) ? '/' : window.location.pathname);
  const _listeners = [];

  async function signInWithGoogle() {
    try {
      const { data, error } = await client.auth.signInWithOAuth({
        provider: 'google',
        options: {
          // Plain Google sign-in. (The Calendar scope / offline access was removed —
          // it's part of the parked Google Calendar feature whose backend isn't set up,
          // and requesting that unconfigured sensitive scope broke the OAuth return.)
          // Always show the account chooser so users with a personal + TMG Google
          // account pick the right one (avoids the 403 org_internal block when Google
          // silently defaults to a non-org account).
          queryParams: { prompt: 'select_account' },
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

  // Connect Google Calendar + Tasks (read + write) — deliberately SEPARATE from login.
  // Re-runs Google OAuth requesting the calendar + tasks scopes with offline
  // access, so Google issues a refresh token; init() below captures it and the app
  // stores it once (see connectGoogleCalendar in index.html). Full `calendar` scope
  // (not the narrower `calendar.events`) is required because the app also calls
  // calendarList.list to check connection status and list the user's calendars —
  // `calendar.events` only covers reading/writing events on a calendar you already
  // know the id of, NOT enumerating calendars, so calendarList.list always failed
  // with "insufficient authentication scopes" even on a perfectly fresh token.
  // `tasks` covers pushing TMG tasks into Google Tasks (Settings → Google Task
  // auto-sync). Normal sign-in (signInWithGoogle, above) is left untouched.
  // NOTE: anyone who connected before this scope changed must hit "Reconnect" once.
  async function connectCalendar() {
    try {
      // Mark that the NEXT OAuth redirect is a deliberate calendar-connect, so init()
      // knows to persist the returned Google refresh token. Without this flag, a plain
      // login's refresh token (scoped to email/profile only) would also be stored and
      // would CLOBBER the calendar+tasks grant — every subsequent calendar call then
      // fails with "insufficient authentication scopes". (This is exactly what happened
      // when a user reconnected, then later logged out and back in.)
      try { sessionStorage.setItem('tmg_calendar_connect', '1'); } catch (e) {}
      // Also remember to reopen the Profile panel once the OAuth redirect lands back —
      // otherwise the page reload drops the user on the default Chat tab, which reads as
      // the app randomly bouncing them away mid-connect. Read once and cleared by index.html.
      try { sessionStorage.setItem('tmg_calendar_connect_return', '1'); } catch (e) {}
      const { data, error } = await client.auth.signInWithOAuth({
        provider: 'google',
        options: {
          scopes: 'https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/tasks',
          // select_account alongside consent — same 403 org_internal issue as plain sign-in
          // (see signInWithGoogle above): without it, Google silently uses the browser's
          // default Google session, which may not be the @themorshedgroup.com account.
          queryParams: { access_type: 'offline', prompt: 'select_account consent' },
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
      // Capture the Google refresh token — but ONLY if this redirect came from the
      // deliberate "Connect Calendar" flow (which requested calendar+tasks scopes).
      // A plain login also returns a refresh token, but one scoped to email/profile
      // only; storing THAT would overwrite the calendar grant and break every calendar
      // call with "insufficient authentication scopes". The flag is set in
      // connectCalendar() right before its redirect.
      const prt = p.get('provider_refresh_token');
      let fromConnect = false;
      try { fromConnect = sessionStorage.getItem('tmg_calendar_connect') === '1'; sessionStorage.removeItem('tmg_calendar_connect'); } catch (e) {}
      if (prt && fromConnect) { try { window.SupabaseAuth._googleRefresh = prt; } catch (e) {} }
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
