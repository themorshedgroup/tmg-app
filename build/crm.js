const {
  useState,
  useEffect,
  useMemo
} = React;

// ─── Design tokens (TMG Brand) ───────────────────────────────────
const C = {
  bg: '#FCFBF8',
  surface: '#FFFFFF',
  surfaceHover: '#F3EBDA',
  border: '#E4DFD4',
  navy: '#001A4A',
  navyHover: '#0A2552',
  gold: '#AD832F',
  goldSoft: '#C9A45A',
  textPrimary: '#001A4A',
  textSecondary: '#6B6B6B',
  textMuted: '#9B9380',
  red: '#C0392B',
  green: '#1E6B40',
  amber: '#B07A00',
  fontSans: "-apple-system, BlinkMacSystemFont, 'Jost', 'Helvetica Neue', Arial, sans-serif",
  fontDisplay: "'Cormorant Garamond', Georgia, serif",
  mono: "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace"
};

// CRM shares the org's single Zoho proxy function (zoho-crm) — it adds the
// read-only list_modules / get_fields actions used by the schema explorer.
const CRM_ENDPOINT = 'https://ipqoqhsnjubopybujetn.supabase.co/functions/v1/zoho-crm';
const SUPABASE_ANON = 'sb_publishable_Jg-roLg8M-BZJ7dBfjEeig_HIdniPaV';
function authToken() {
  return window.SupabaseAuth?._state?.session?.access_token || SUPABASE_ANON;
}
async function callZoho(payload) {
  const res = await fetch(CRM_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + authToken(),
      'apikey': SUPABASE_ANON
    },
    body: JSON.stringify(payload)
  });
  const data = await res.json().catch(() => ({}));
  return {
    ok: res.ok,
    status: res.status,
    data
  };
}

// ─── Dev sample schema (so the layout is reviewable on localhost ──
//      without a live Zoho connection). Live site uses real Zoho.
const DEV_MODULES = [{
  api_name: 'Contacts',
  plural_label: 'Contacts',
  singular_label: 'Contact',
  generated_type: 'default',
  creatable: true,
  editable: true,
  deletable: true,
  viewable: true
}, {
  api_name: 'Leads',
  plural_label: 'Leads',
  singular_label: 'Lead',
  generated_type: 'default',
  creatable: true,
  editable: false,
  deletable: false,
  viewable: true
}, {
  api_name: 'Deals',
  plural_label: 'Deals',
  singular_label: 'Deal',
  generated_type: 'default',
  creatable: true,
  editable: true,
  deletable: false,
  viewable: true
}, {
  api_name: 'Accounts',
  plural_label: 'Accounts',
  singular_label: 'Account',
  generated_type: 'default',
  creatable: true,
  editable: true,
  deletable: true,
  viewable: true
}, {
  api_name: 'Properties',
  plural_label: 'Properties',
  singular_label: 'Property',
  generated_type: 'custom',
  creatable: true,
  editable: true,
  deletable: true,
  viewable: true
}];
const DEV_FIELDS = {
  Contacts: [{
    api_name: 'First_Name',
    field_label: 'First Name',
    data_type: 'text',
    length: 40,
    required: false,
    read_only: false,
    custom_field: false,
    picklist_values: null,
    lookup_module: null
  }, {
    api_name: 'Last_Name',
    field_label: 'Last Name',
    data_type: 'text',
    length: 80,
    required: true,
    read_only: false,
    custom_field: false,
    picklist_values: null,
    lookup_module: null
  }, {
    api_name: 'Email',
    field_label: 'Email',
    data_type: 'email',
    length: 100,
    required: false,
    read_only: false,
    custom_field: false,
    picklist_values: null,
    lookup_module: null
  }, {
    api_name: 'Phone',
    field_label: 'Phone',
    data_type: 'phone',
    length: 50,
    required: false,
    read_only: false,
    custom_field: false,
    picklist_values: null,
    lookup_module: null
  }, {
    api_name: 'Lead_Source',
    field_label: 'Lead Source',
    data_type: 'picklist',
    length: null,
    required: false,
    read_only: false,
    custom_field: false,
    picklist_values: ['Referral', 'Website', 'Open House', 'Cold Call', 'Past Client'],
    lookup_module: null
  }, {
    api_name: 'Account_Name',
    field_label: 'Account Name',
    data_type: 'lookup',
    length: null,
    required: false,
    read_only: false,
    custom_field: false,
    picklist_values: null,
    lookup_module: 'Accounts'
  }, {
    api_name: 'Owner',
    field_label: 'Contact Owner',
    data_type: 'ownerlookup',
    length: null,
    required: true,
    read_only: true,
    custom_field: false,
    picklist_values: null,
    lookup_module: null
  }],
  Leads: [{
    api_name: 'Last_Name',
    field_label: 'Last Name',
    data_type: 'text',
    length: 80,
    required: true,
    read_only: false,
    custom_field: false,
    picklist_values: null,
    lookup_module: null
  }, {
    api_name: 'Lead_Status',
    field_label: 'Lead Status',
    data_type: 'picklist',
    length: null,
    required: false,
    read_only: false,
    custom_field: false,
    picklist_values: ['New', 'Contacted', 'Nurturing', 'Qualified', 'Lost'],
    lookup_module: null
  }],
  Deals: [],
  Accounts: [],
  Properties: []
};
function isDev() {
  return !!window.TMG_DEV;
}

// ─── Small UI helpers ────────────────────────────────────────────
function Spinner({
  size = 20,
  color = C.gold
}) {
  return /*#__PURE__*/React.createElement("i", {
    className: "ti ti-loader-2",
    style: {
      fontSize: size,
      color,
      display: 'inline-block',
      animation: 'tmg-spin 0.8s linear infinite'
    }
  });
}
function TypePill({
  type
}) {
  const map = {
    text: C.textSecondary,
    textarea: C.textSecondary,
    email: '#2563EB',
    phone: '#0891B2',
    picklist: C.gold,
    multiselectpicklist: C.gold,
    lookup: '#7C3AED',
    ownerlookup: '#7C3AED',
    date: C.green,
    datetime: C.green,
    integer: C.amber,
    double: C.amber,
    currency: C.amber,
    boolean: C.red
  };
  const col = map[type] || C.textMuted;
  return /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: C.mono,
      fontSize: '0.66rem',
      fontWeight: 600,
      color: col,
      background: col + '14',
      border: '1px solid ' + col + '33',
      padding: '2px 7px',
      borderRadius: 6,
      whiteSpace: 'nowrap'
    }
  }, type);
}

// ─── Module permissions ──────────────────────────────────────────
//  Zoho's settings/modules metadata returns creatable/editable/deletable/
//  viewable per module. These reflect the connected Zoho account's PROFILE
//  permission — NOT the OAuth scope (a separate gate). Green = allowed.

// Compact pencil + trash for the modules rail (at-a-glance edit/delete).
function RailPerm({
  m
}) {
  return /*#__PURE__*/React.createElement("span", {
    style: {
      display: 'inline-flex',
      gap: 5,
      alignItems: 'center'
    }
  }, /*#__PURE__*/React.createElement("i", {
    className: "ti ti-pencil",
    title: m.editable ? 'Editable' : 'Not editable',
    style: {
      fontSize: 12.5,
      color: m.editable ? C.green : C.border
    }
  }), /*#__PURE__*/React.createElement("i", {
    className: "ti ti-trash",
    title: m.deletable ? 'Deletable' : 'Not deletable',
    style: {
      fontSize: 12.5,
      color: m.deletable ? C.green : C.border
    }
  }));
}

// Full labeled row for the active module header.
function PermPills({
  m
}) {
  const caps = [{
    on: m.viewable,
    icon: 'ti-eye',
    label: 'View'
  }, {
    on: m.creatable,
    icon: 'ti-plus',
    label: 'Create'
  }, {
    on: m.editable,
    icon: 'ti-pencil',
    label: 'Edit'
  }, {
    on: m.deletable,
    icon: 'ti-trash',
    label: 'Delete'
  }];
  return /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 12
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 8,
      flexWrap: 'wrap'
    }
  }, caps.map(c => /*#__PURE__*/React.createElement("span", {
    key: c.label,
    title: (c.on ? 'Allowed' : 'Not allowed') + ' — ' + c.label,
    style: {
      display: 'inline-flex',
      alignItems: 'center',
      gap: 5,
      fontSize: '0.72rem',
      fontWeight: 600,
      padding: '4px 11px',
      borderRadius: 20,
      color: c.on ? C.green : C.textMuted,
      background: c.on ? C.green + '12' : '#F1EFEA',
      border: '1px solid ' + (c.on ? C.green + '33' : C.border),
      opacity: c.on ? 1 : 0.75
    }
  }, /*#__PURE__*/React.createElement("i", {
    className: 'ti ' + (c.on ? c.icon : 'ti-lock'),
    style: {
      fontSize: 13.5
    }
  }), c.label))), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: '0.68rem',
      color: C.textMuted,
      marginTop: 7,
      lineHeight: 1.4
    }
  }, "Reflects the connected Zoho account's profile permissions (not the API scope)."));
}

// ─── Live OAuth-scope probe ──────────────────────────────────────
//  The pills above show the Zoho PROFILE gate. This tests the OTHER gate:
//  whether the connection's OAuth token scope actually permits update/
//  delete. It calls the zoho-crm `probe_scopes` action, which sends a
//  harmless update + delete for a fake record id ("1") — no data touched.
function ScopeFlag({
  label,
  v
}) {
  let icon = 'ti-help-circle',
    color = C.amber,
    text = 'Couldn’t determine';
  if (v && v.determinate !== false && v.allowed !== null) {
    if (v.allowed) {
      icon = 'ti-circle-check';
      color = C.green;
      text = 'Allowed';
    } else {
      icon = 'ti-ban';
      color = C.red;
      text = 'Blocked — scope missing';
    }
  }
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      fontSize: '0.8rem'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      width: 54,
      color: C.textSecondary,
      fontWeight: 600
    }
  }, label), /*#__PURE__*/React.createElement("i", {
    className: 'ti ' + icon,
    style: {
      fontSize: 16,
      color
    }
  }), /*#__PURE__*/React.createElement("span", {
    style: {
      color,
      fontWeight: 600
    }
  }, text));
}
function ScopeProbe({
  module
}) {
  const [phase, setPhase] = useState('idle'); // idle | loading | done | needs_deploy | error
  const [res, setRes] = useState(null);
  const [msg, setMsg] = useState('');
  async function run() {
    setPhase('loading');
    setMsg('');
    if (isDev()) {
      await new Promise(r => setTimeout(r, 700));
      // Dev demo: token can edit but not delete (shows both outcomes).
      setRes({
        update: {
          allowed: true,
          determinate: true
        },
        delete: {
          allowed: false,
          determinate: true
        }
      });
      setPhase('done');
      return;
    }
    const {
      ok,
      data
    } = await callZoho({
      action: 'probe_scopes',
      module
    });
    if (!ok && /unknown action/i.test(data?.error || '')) {
      setPhase('needs_deploy');
      return;
    }
    if (!ok) {
      setMsg(data?.error || 'Probe failed.');
      setPhase('error');
      return;
    }
    setRes(data);
    setPhase('done');
  }
  const btn = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 7,
    fontFamily: C.fontSans,
    fontSize: '0.76rem',
    fontWeight: 600,
    color: C.navy,
    background: C.surface,
    border: '1px solid ' + C.border,
    borderRadius: 9,
    padding: '7px 13px',
    cursor: 'pointer'
  };
  return /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 14,
      paddingTop: 14,
      borderTop: '1px dashed ' + C.border
    }
  }, (phase === 'idle' || phase === 'error' || phase === 'needs_deploy') && /*#__PURE__*/React.createElement("button", {
    onClick: run,
    style: btn
  }, /*#__PURE__*/React.createElement("i", {
    className: "ti ti-shield-bolt",
    style: {
      fontSize: 15,
      color: C.gold
    }
  }), "Test live write access (OAuth scope)"), phase === 'loading' && /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 9,
      fontSize: '0.8rem',
      color: C.textSecondary
    }
  }, /*#__PURE__*/React.createElement(Spinner, {
    size: 16
  }), " Testing\u2026 sending a harmless request (fake record id, nothing changes)."), phase === 'needs_deploy' && /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 10,
      fontSize: '0.74rem',
      color: C.amber,
      lineHeight: 1.5
    }
  }, "The deployed ", /*#__PURE__*/React.createElement("b", null, "zoho-crm"), " function doesn\u2019t have this check yet. Re-deploy the updated function in Supabase to enable it."), phase === 'error' && /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 10,
      fontSize: '0.74rem',
      color: C.red,
      lineHeight: 1.5
    }
  }, msg), phase === 'done' && res && /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: '0.64rem',
      fontWeight: 600,
      letterSpacing: '.12em',
      textTransform: 'uppercase',
      color: C.textMuted,
      marginBottom: 8
    }
  }, "OAuth token scope \xB7 live test"), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: 7
    }
  }, /*#__PURE__*/React.createElement(ScopeFlag, {
    label: "Edit",
    v: res.update
  }), /*#__PURE__*/React.createElement(ScopeFlag, {
    label: "Delete",
    v: res.delete
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 10,
      marginTop: 10
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: '0.68rem',
      color: C.textMuted,
      lineHeight: 1.4
    }
  }, "Sent a no-op request with a fake record id \u2014 no records were created, changed, or deleted."), /*#__PURE__*/React.createElement("button", {
    onClick: run,
    style: {
      ...btn,
      padding: '4px 9px',
      fontSize: '0.7rem',
      flexShrink: 0
    }
  }, "Re-test"))));
}

// ─── Field row ───────────────────────────────────────────────────
function FieldRow({
  f
}) {
  const [copied, setCopied] = useState(false);
  function copy() {
    try {
      navigator.clipboard.writeText(f.api_name);
      setCopied(true);
      setTimeout(() => setCopied(false), 1100);
    } catch (e) {}
  }
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'grid',
      gridTemplateColumns: '1.4fr 1.4fr 1fr',
      gap: 12,
      alignItems: 'start',
      padding: '13px 16px',
      borderBottom: '1px solid ' + C.border
    }
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: '0.86rem',
      fontWeight: 500,
      color: C.textPrimary,
      display: 'flex',
      alignItems: 'center',
      gap: 7
    }
  }, f.field_label, f.required && /*#__PURE__*/React.createElement("span", {
    title: "Required",
    style: {
      color: C.red,
      fontSize: '0.9rem',
      lineHeight: 1
    }
  }, "*")), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 6,
      marginTop: 5,
      flexWrap: 'wrap'
    }
  }, f.custom_field && /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: '0.6rem',
      fontWeight: 600,
      letterSpacing: '.04em',
      textTransform: 'uppercase',
      color: C.gold,
      background: C.surfaceHover,
      padding: '1px 6px',
      borderRadius: 5
    }
  }, "Custom"), f.read_only && /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: '0.6rem',
      fontWeight: 600,
      letterSpacing: '.04em',
      textTransform: 'uppercase',
      color: C.textMuted,
      background: '#F1EFEA',
      padding: '1px 6px',
      borderRadius: 5
    }
  }, "Read-only"))), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("button", {
    onClick: copy,
    title: "Copy API name",
    style: {
      fontFamily: C.mono,
      fontSize: '0.76rem',
      color: C.navy,
      background: 'transparent',
      border: 'none',
      cursor: 'pointer',
      padding: 0,
      textAlign: 'left',
      display: 'flex',
      alignItems: 'center',
      gap: 6
    }
  }, f.api_name, /*#__PURE__*/React.createElement("i", {
    className: copied ? 'ti ti-check' : 'ti ti-copy',
    style: {
      fontSize: 13,
      color: copied ? C.green : C.textMuted
    }
  }))), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement(TypePill, {
    type: f.data_type
  }), f.lookup_module && /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: '0.7rem',
      color: C.textSecondary,
      marginTop: 5
    }
  }, "\u2192 ", f.lookup_module), f.length ? /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: '0.7rem',
      color: C.textMuted,
      marginTop: 5
    }
  }, "max ", f.length) : null, Array.isArray(f.picklist_values) && f.picklist_values.length > 0 && /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: '0.7rem',
      color: C.textSecondary,
      marginTop: 5,
      lineHeight: 1.5
    }
  }, f.picklist_values.slice(0, 6).join(', '), f.picklist_values.length > 6 ? ` +${f.picklist_values.length - 6} more` : '')));
}

// ─── Main app ────────────────────────────────────────────────────
function App({
  user,
  profile
}) {
  const [modules, setModules] = useState(null); // null = loading
  const [modErr, setModErr] = useState('');
  const [active, setActive] = useState(null); // active module api_name
  const [fields, setFields] = useState({}); // cache: api_name -> field[]
  const [fieldErr, setFieldErr] = useState('');
  const [loadingFields, setLoadingFields] = useState(false);
  const [q, setQ] = useState('');

  // Load modules on mount.
  useEffect(() => {
    let alive = true;
    (async () => {
      if (isDev()) {
        await new Promise(r => setTimeout(r, 300));
        if (alive) {
          setModules(DEV_MODULES);
          setActive(DEV_MODULES[0].api_name);
        }
        return;
      }
      const {
        ok,
        data
      } = await callZoho({
        action: 'list_modules'
      });
      if (!alive) return;
      if (!ok) {
        setModErr(data.error || 'Could not reach Zoho.');
        setModules([]);
        return;
      }
      const ms = data.modules || [];
      setModules(ms);
      if (ms.length) setActive(ms[0].api_name);
    })();
    return () => {
      alive = false;
    };
  }, []);

  // Load fields whenever the active module changes (cached).
  useEffect(() => {
    if (!active) return;
    if (fields[active]) return;
    let alive = true;
    setLoadingFields(true);
    setFieldErr('');
    (async () => {
      if (isDev()) {
        await new Promise(r => setTimeout(r, 250));
        if (alive) {
          setFields(p => ({
            ...p,
            [active]: DEV_FIELDS[active] || []
          }));
          setLoadingFields(false);
        }
        return;
      }
      const {
        ok,
        data
      } = await callZoho({
        action: 'get_fields',
        module: active
      });
      if (!alive) return;
      if (!ok) {
        setFieldErr(data.error || 'Could not load fields.');
        setLoadingFields(false);
        return;
      }
      setFields(p => ({
        ...p,
        [active]: data.fields || []
      }));
      setLoadingFields(false);
    })();
    return () => {
      alive = false;
    };
  }, [active]);
  const activeMod = modules && modules.find(m => m.api_name === active);
  const activeFields = active ? fields[active] : null;
  const shownFields = useMemo(() => {
    if (!activeFields) return null;
    const t = q.trim().toLowerCase();
    if (!t) return activeFields;
    return activeFields.filter(f => (f.field_label || '').toLowerCase().includes(t) || (f.api_name || '').toLowerCase().includes(t));
  }, [activeFields, q]);
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      height: '100%',
      background: C.bg
    }
  }, /*#__PURE__*/React.createElement("header", {
    style: {
      flexShrink: 0,
      background: C.navy,
      color: '#fff',
      padding: '0 20px',
      height: 58,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 12
    }
  }, /*#__PURE__*/React.createElement("a", {
    href: "index.html",
    title: "Back to TMG App",
    style: {
      color: 'rgba(255,255,255,.7)',
      textDecoration: 'none',
      display: 'flex',
      alignItems: 'center'
    }
  }, /*#__PURE__*/React.createElement("i", {
    className: "ti ti-arrow-left",
    style: {
      fontSize: 18
    }
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      fontWeight: 600,
      letterSpacing: '.18em',
      fontSize: '0.95rem'
    }
  }, "TMG CRM"), /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: '0.62rem',
      fontWeight: 600,
      letterSpacing: '.1em',
      textTransform: 'uppercase',
      color: C.goldSoft,
      border: '1px solid rgba(201,164,90,.4)',
      padding: '2px 8px',
      borderRadius: 20
    }
  }, "Schema")), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 14
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: '0.78rem',
      color: 'rgba(255,255,255,.7)'
    }
  }, profile?.email || user?.email), /*#__PURE__*/React.createElement("button", {
    onClick: () => window.SupabaseAuth.signOut(),
    style: {
      background: 'transparent',
      border: '1px solid rgba(255,255,255,.2)',
      color: 'rgba(255,255,255,.8)',
      fontSize: '0.72rem',
      padding: '6px 12px',
      borderRadius: 8,
      cursor: 'pointer',
      fontFamily: C.fontSans
    }
  }, "Sign out"))), /*#__PURE__*/React.createElement("div", {
    style: {
      flexShrink: 0,
      background: C.surfaceHover,
      borderBottom: '1px solid ' + C.border,
      padding: '8px 20px',
      fontSize: '0.74rem',
      color: C.textSecondary,
      display: 'flex',
      alignItems: 'center',
      gap: 8
    }
  }, /*#__PURE__*/React.createElement("i", {
    className: "ti ti-shield-check",
    style: {
      color: C.green,
      fontSize: 15
    }
  }), "Reading your Zoho ", /*#__PURE__*/React.createElement("b", {
    style: {
      color: C.textPrimary,
      fontWeight: 600
    }
  }, "\xA0structure only"), " \u2014 no contacts or records are imported.", isDev() && /*#__PURE__*/React.createElement("span", {
    style: {
      marginLeft: 'auto',
      color: C.amber,
      fontWeight: 600
    }
  }, "DEV PREVIEW (sample data)")), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      display: 'flex',
      minHeight: 0
    }
  }, /*#__PURE__*/React.createElement("nav", {
    style: {
      width: 240,
      flexShrink: 0,
      borderRight: '1px solid ' + C.border,
      background: C.surface,
      overflowY: 'auto',
      padding: '12px 0'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: '0.64rem',
      fontWeight: 600,
      letterSpacing: '.16em',
      textTransform: 'uppercase',
      color: C.textMuted,
      padding: '4px 18px 10px'
    }
  }, "Modules"), modules === null && /*#__PURE__*/React.createElement("div", {
    style: {
      padding: '14px 18px'
    }
  }, /*#__PURE__*/React.createElement(Spinner, null)), modules && modules.length === 0 && !modErr && /*#__PURE__*/React.createElement("div", {
    style: {
      padding: '14px 18px',
      fontSize: '0.78rem',
      color: C.textMuted
    }
  }, "No modules returned."), modErr && /*#__PURE__*/React.createElement("div", {
    style: {
      padding: '14px 18px',
      fontSize: '0.76rem',
      color: C.red,
      lineHeight: 1.5
    }
  }, modErr), (modules || []).map(m => {
    const on = m.api_name === active;
    return /*#__PURE__*/React.createElement("button", {
      key: m.api_name,
      onClick: () => setActive(m.api_name),
      style: {
        width: '100%',
        textAlign: 'left',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 8,
        padding: '10px 18px',
        background: on ? C.surfaceHover : 'transparent',
        border: 'none',
        borderLeft: '3px solid ' + (on ? C.gold : 'transparent'),
        cursor: 'pointer',
        fontFamily: C.fontSans
      }
    }, /*#__PURE__*/React.createElement("span", {
      style: {
        fontSize: '0.86rem',
        fontWeight: on ? 600 : 400,
        color: on ? C.navy : C.textSecondary,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap'
      }
    }, m.plural_label || m.api_name), /*#__PURE__*/React.createElement("span", {
      style: {
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        flexShrink: 0
      }
    }, m.generated_type === 'custom' && /*#__PURE__*/React.createElement("span", {
      style: {
        fontSize: '0.56rem',
        fontWeight: 600,
        letterSpacing: '.04em',
        textTransform: 'uppercase',
        color: C.gold
      }
    }, "Custom"), /*#__PURE__*/React.createElement(RailPerm, {
      m: m
    })));
  })), /*#__PURE__*/React.createElement("main", {
    style: {
      flex: 1,
      overflowY: 'auto',
      minWidth: 0
    }
  }, !active && /*#__PURE__*/React.createElement("div", {
    style: {
      padding: 40,
      color: C.textMuted
    }
  }, "Select a module."), active && /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: {
      padding: '20px 24px 14px',
      borderBottom: '1px solid ' + C.border,
      position: 'sticky',
      top: 0,
      background: C.bg,
      zIndex: 1
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'baseline',
      justifyContent: 'space-between',
      gap: 16,
      flexWrap: 'wrap'
    }
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("h1", {
    style: {
      fontFamily: C.fontDisplay,
      fontSize: '1.7rem',
      fontWeight: 600,
      color: C.navy,
      lineHeight: 1.1
    }
  }, activeMod?.plural_label || active), /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: C.mono,
      fontSize: '0.72rem',
      color: C.textMuted,
      marginTop: 3
    }
  }, active, activeFields ? ` · ${activeFields.length} fields` : ''), activeMod && /*#__PURE__*/React.createElement(PermPills, {
    m: activeMod
  }), activeMod && /*#__PURE__*/React.createElement(ScopeProbe, {
    module: active,
    key: active
  })), /*#__PURE__*/React.createElement("input", {
    value: q,
    onChange: e => setQ(e.target.value),
    placeholder: "Filter fields\u2026",
    style: {
      fontFamily: C.fontSans,
      fontSize: '0.82rem',
      padding: '8px 12px',
      border: '1px solid ' + C.border,
      borderRadius: 9,
      background: C.surface,
      color: C.textPrimary,
      width: 200,
      outline: 'none'
    }
  }))), loadingFields && /*#__PURE__*/React.createElement("div", {
    style: {
      padding: 32,
      textAlign: 'center'
    }
  }, /*#__PURE__*/React.createElement(Spinner, {
    size: 26
  })), fieldErr && /*#__PURE__*/React.createElement("div", {
    style: {
      margin: 24,
      padding: 16,
      border: '1px solid ' + C.red + '44',
      background: C.red + '0d',
      borderRadius: 10,
      color: C.red,
      fontSize: '0.82rem',
      lineHeight: 1.5
    }
  }, fieldErr), !loadingFields && !fieldErr && shownFields && (shownFields.length === 0 ? /*#__PURE__*/React.createElement("div", {
    style: {
      padding: 32,
      textAlign: 'center',
      color: C.textMuted,
      fontSize: '0.85rem'
    }
  }, q ? 'No fields match your filter.' : 'This module has no readable fields.') : /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'grid',
      gridTemplateColumns: '1.4fr 1.4fr 1fr',
      gap: 12,
      padding: '10px 16px',
      fontSize: '0.62rem',
      fontWeight: 600,
      letterSpacing: '.12em',
      textTransform: 'uppercase',
      color: C.textMuted,
      borderBottom: '1px solid ' + C.border,
      background: C.surface,
      position: 'sticky',
      top: 82,
      zIndex: 1
    }
  }, /*#__PURE__*/React.createElement("div", null, "Field"), /*#__PURE__*/React.createElement("div", null, "API Name"), /*#__PURE__*/React.createElement("div", null, "Type")), shownFields.map(f => /*#__PURE__*/React.createElement(FieldRow, {
    key: f.api_name,
    f: f
  }))))))));
}

// ─── Mount + auth gate (mirrors index.html) ──────────────────────
(function mount() {
  const root = ReactDOM.createRoot(document.getElementById('root'));
  const AUTHORIZED_DOMAIN = 'themorshedgroup.com';
  function _showScreen(id) {
    ['login-screen', 'denied-screen', 'pending-screen'].forEach(function (s) {
      var el = document.getElementById(s);
      if (el) el.hidden = s !== id;
    });
    document.getElementById('auth-overlay').style.display = 'block';
  }
  function showSignin() {
    _showScreen('login-screen');
  }
  function showRejected() {
    _showScreen('denied-screen');
  }
  function showPending() {
    _showScreen('pending-screen');
  }
  function hideOverlay() {
    document.getElementById('auth-overlay').style.display = 'none';
  }
  if (window.TMG_DEV) {
    root.render( /*#__PURE__*/React.createElement(App, {
      user: window.SupabaseAuth._state.session?.user,
      profile: {
        email: 'symon@morshedgroup.com',
        first_name: 'Symon',
        access: 'admin',
        status: 'active'
      }
    }));
    hideOverlay();
    return;
  }
  async function fetchProfile(userId) {
    try {
      const c = window.SupabaseAuth._client;
      const {
        data
      } = await c.from('profiles').select('*').eq('id', userId).maybeSingle();
      return data || null;
    } catch (e) {
      return null;
    }
  }
  window.SupabaseAuth.onAuthStateChange(async function ({
    session
  }) {
    if (!session) {
      showSignin();
      return;
    }
    const email = (session.user.email || '').toLowerCase();
    if (!email.endsWith('@' + AUTHORIZED_DOMAIN)) {
      showRejected();
      return;
    }
    const profile = await fetchProfile(session.user.id);
    // Same gate semantics as index.html: existing-but-not-active is blocked; missing profile fails open.
    if (profile && profile.status === 'pending') {
      showPending();
      return;
    }
    if (profile && profile.status && profile.status !== 'active') {
      showRejected();
      return;
    }
    root.render( /*#__PURE__*/React.createElement(App, {
      user: session.user,
      profile: profile
    }));
    hideOverlay();
  });
})();