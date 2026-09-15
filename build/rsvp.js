// One-click RSVP landing page, opened from a link inside the Team Calendar
// Summary email (see supabase/functions/tmg-calendar-summary). Same-origin as
// index.html so it shares the already-logged-in Supabase session — no signed
// token in the URL, just ?event=<google_event_id>&r=yes|no|maybe. Writes
// directly to tmg_event_rsvps under RLS (a user may only write their own row).
(function () {
  const {
    useState,
    useEffect
  } = React;
  const LABELS = {
    yes: 'Yes',
    no: 'No',
    maybe: 'Maybe'
  };
  const COLORS = {
    yes: '#1B7F4D',
    no: '#B3261E',
    maybe: '#AD832F'
  };
  function RsvpApp() {
    const [status, setStatus] = useState('loading'); // loading | need-login | saving | done | error
    const [error, setError] = useState('');
    const [response, setResponse] = useState(null);
    useEffect(() => {
      const params = new URLSearchParams(window.location.search);
      const eventId = params.get('event');
      const r = params.get('r');
      if (!eventId || !LABELS[r]) {
        setStatus('error');
        setError('This RSVP link is missing information. Please use the button from the email again.');
        return;
      }
      setResponse(r);
      let handled = false;
      window.SupabaseAuth.onAuthStateChange(async ({
        session
      }) => {
        if (handled) return;
        if (!session || !session.user) {
          setStatus('need-login');
          return;
        }
        handled = true;
        setStatus('saving');
        const c = window.SupabaseAuth._client;
        const {
          error: err
        } = await c.from('tmg_event_rsvps').upsert({
          google_event_id: eventId,
          profile_id: session.user.id,
          response: r,
          responded_at: new Date().toISOString()
        }, {
          onConflict: 'google_event_id,profile_id'
        });
        if (err) {
          setStatus('error');
          setError(err.message);
          return;
        }
        setStatus('done');
      });
    }, []);
    const shell = children => /*#__PURE__*/React.createElement("div", {
      style: {
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: '#EDECE7',
        fontFamily: "'Jost', 'Helvetica Neue', Arial, sans-serif",
        padding: 20
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        width: '100%',
        maxWidth: 380,
        background: '#fff',
        borderRadius: 14,
        border: '1px solid #E4DFD4',
        padding: '32px 28px',
        textAlign: 'center'
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 10,
        fontWeight: 600,
        letterSpacing: '0.22em',
        textTransform: 'uppercase',
        color: '#001A4A',
        marginBottom: 20
      }
    }, "The Morshed Group"), children));
    if (status === 'loading' || status === 'saving') {
      return shell( /*#__PURE__*/React.createElement("div", {
        style: {
          color: '#5f6368',
          fontSize: 14
        }
      }, status === 'saving' ? 'Recording your RSVP…' : 'Loading…'));
    }
    if (status === 'need-login') {
      return shell( /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
        style: {
          color: '#001A4A',
          fontSize: 15,
          marginBottom: 16
        }
      }, "Log in to record your RSVP."), /*#__PURE__*/React.createElement("button", {
        onClick: () => window.SupabaseAuth.signInWithGoogle(),
        style: {
          background: '#001A4A',
          color: '#fff',
          border: 'none',
          borderRadius: 8,
          padding: '10px 20px',
          fontFamily: 'inherit',
          fontSize: 13,
          fontWeight: 600,
          cursor: 'pointer'
        }
      }, "Log in with Google")));
    }
    if (status === 'error') {
      return shell( /*#__PURE__*/React.createElement("div", {
        style: {
          color: '#B3261E',
          fontSize: 14
        }
      }, error));
    }
    // done
    return shell( /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 15,
        color: '#001A4A',
        marginBottom: 6
      }
    }, "RSVP recorded"), /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 22,
        fontWeight: 600,
        color: COLORS[response]
      }
    }, LABELS[response]), /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 12,
        color: '#8A8578',
        marginTop: 16
      }
    }, "You can change your response any time by tapping another button in the email.")));
  }
  ReactDOM.createRoot(document.getElementById('root')).render( /*#__PURE__*/React.createElement(RsvpApp, null));
})();