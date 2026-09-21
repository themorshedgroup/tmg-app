    const { useState, useEffect, useMemo, useRef } = React;

    // ─── Design tokens (TMG brand, same dialect as crm-tasks) ─────────
    const C = {
      bg:'#FCFBF8', surface:'#FFFFFF', surfaceHover:'#F3EBDA', surfaceAlt:'#FAF8F3', border:'#E4DFD4',
      navy:'#001A4A', navyHover:'#0A2552', gold:'#AD832F', goldSoft:'#C9A45A',
      textPrimary:'#001A4A', textSecondary:'#6B6B6B', textMuted:'#9B9380',
      red:'#C0392B', green:'#1E6B40', amber:'#B07A00', blue:'#2563EB',
      fontSans:"-apple-system, BlinkMacSystemFont, 'Jost', 'Helvetica Neue', Arial, sans-serif",
      fontDisplay:"'Cormorant Garamond', Georgia, serif",
    };

    const ENDPOINT = 'https://ipqoqhsnjubopybujetn.supabase.co/functions/v1/zoho-crm';
    const SUPABASE_ANON = 'sb_publishable_Jg-roLg8M-BZJ7dBfjEeig_HIdniPaV';
    function authToken() { return window.SupabaseAuth?._state?.session?.access_token || SUPABASE_ANON; }
    function isDev() { return !!window.TMG_DEV; }

    async function callZoho(payload) {
      const res = await fetch(ENDPOINT, {
        method:'POST',
        headers:{ 'Content-Type':'application/json', 'Authorization':'Bearer ' + authToken(), 'apikey':SUPABASE_ANON },
        body:JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      return { ok:res.ok, status:res.status, data };
    }

    const CLS_FIELD = 'Client_Classification';

    // ─── Small helpers ────────────────────────────────────────────────
    function zohoRecordUrl(module, id) {
      if (!id || !/^\d+$/.test(String(id))) return null;
      return `https://crm.zoho.com/crm/EntityInfo.do?module=${module}&id=${encodeURIComponent(id)}`;
    }
    function ZohoLink({ module, id, children, style, title }) {
      const href = zohoRecordUrl(module, id);
      if (!href) return <span style={style}>{children}</span>;
      return (
        <a href={href} target="_blank" rel="noopener noreferrer" title={title || 'Open in Zoho CRM'}
          style={{ ...style, color:(style && style.color) || C.navy, textDecoration:'none', cursor:'pointer' }}
          onMouseEnter={e => e.currentTarget.style.textDecoration = 'underline'}
          onMouseLeave={e => e.currentTarget.style.textDecoration = 'none'}>
          {children}
        </a>
      );
    }
    function parseISO(d) { const [y,m,dd] = String(d).split('-').map(Number); return new Date(y, (m||1)-1, dd||1); }
    function todayISO() {
      const n = new Date();
      return n.getFullYear() + '-' + String(n.getMonth()+1).padStart(2,'0') + '-' + String(n.getDate()).padStart(2,'0');
    }
    function fmtDate(d) {
      if (!d) return '';
      const dt = parseISO(d);
      if (isNaN(dt)) return String(d);
      return dt.toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' });
    }
    function agoLabel(ms) {
      const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
      if (s < 60) return 'just now';
      const m = Math.round(s / 60);
      if (m < 60) return m + 'm ago';
      const h = Math.round(m / 60);
      if (h < 24) return h + 'h ago';
      return Math.round(h / 24) + 'd ago';
    }
    function Spinner({ size = 14, color }) {
      return <span style={{ display:'inline-block', width:size, height:size, borderRadius:'50%',
        border:'2px solid rgba(201,164,90,.25)', borderTopColor:color || C.goldSoft,
        animation:'cc-spin .7s linear infinite' }} />;
    }

    // ─── Dev fixtures (localhost only, so the page renders with no Zoho) ──
    const DEV_META = {
      spouse:   { api:'Spouse', label:'Spouse' },
      prospect: { api:'Prospect_Form_Type', label:'Prospect Form Type', dataType:'multiselectpicklist',
                  options:['Buyer','Seller','Investor','Renter','Referral Partner'] },
      cls:      { api:CLS_FIELD, label:'Client Classification', dataType:'picklist', options:['A','B','C','EO','D'] },
      taskType: 'Task_Type',
    };
    const DEV_CONTACTS = [
      { id:'101', First_Name:'Molly', Last_Name:'Kinney', Full_Name:'Molly Kinney', Email:'molly@example.com', Mobile:'512-555-0111', Phone:'', Other_Phone:'', Client_Classification:'A', Owner:{ id:'1', name:'Brett Silverman' }, Spouse:{ id:'102', name:'Dean Kinney' }, Prospect_Form_Type:['Buyer'] },
      { id:'102', First_Name:'Dean', Last_Name:'Kinney', Full_Name:'Dean Kinney', Email:'dean@example.com', Mobile:'512-555-0112', Phone:'', Other_Phone:'', Client_Classification:'A', Owner:{ id:'1', name:'Brett Silverman' }, Spouse:{ id:'101', name:'Molly Kinney' }, Prospect_Form_Type:['Buyer'] },
      { id:'103', First_Name:'Rashad', Last_Name:'Rahman', Full_Name:'Rashad Rahman', Email:'', Mobile:'917-239-2145', Phone:'212-555-0190', Other_Phone:'', Client_Classification:'B', Owner:{ id:'1', name:'Brett Silverman' }, Spouse:null, Prospect_Form_Type:['Seller'] },
      { id:'104', First_Name:'Alok', Last_Name:'Mody', Full_Name:'Alok Mody', Email:'alok@example.com', Mobile:'732-841-9409', Phone:'', Other_Phone:'', Client_Classification:'C', Owner:{ id:'2', name:'Tarek Morshed' }, Spouse:null, Prospect_Form_Type:[] },
      { id:'105', First_Name:'Neil', Last_Name:'Patel', Full_Name:'Neil Patel', Email:'neil@example.com', Mobile:'', Phone:'', Other_Phone:'', Client_Classification:'', Owner:{ id:'2', name:'Tarek Morshed' }, Spouse:null, Prospect_Form_Type:['Investor','Buyer'] },
      { id:'106', First_Name:'Wendy', Last_Name:'Sato', Full_Name:'Wendy Sato', Email:'wendy@example.com', Mobile:'646-555-0144', Phone:'', Other_Phone:'', Client_Classification:'A', Owner:{ id:'3', name:'Kyle Baird' }, Spouse:{ id:'107', name:'Carl Sato' }, Prospect_Form_Type:['Renter'] },
      { id:'107', First_Name:'Carl', Last_Name:'Sato', Full_Name:'Carl Sato', Email:'', Mobile:'646-555-0145', Phone:'', Other_Phone:'', Client_Classification:'C', Owner:{ id:'3', name:'Kyle Baird' }, Spouse:{ id:'106', name:'Wendy Sato' }, Prospect_Form_Type:[] },
      { id:'108', First_Name:'Morgan', Last_Name:'Birch', Full_Name:'Morgan Birch', Email:'morgan@example.com', Mobile:'310-555-0177', Phone:'', Other_Phone:'', Client_Classification:'B', Owner:{ id:'3', name:'Kyle Baird' }, Spouse:null, Prospect_Form_Type:['Seller','Investor'] },
    ];
    const DEV_CALLS = {
      '101': { id:'t1', date:'2026-09-25', subject:'C Touch Call: Molly Kinney' },
      '103': { id:'t2', date:'2026-08-14', subject:'B Touch Call: Rashad Rahman' },
      '106': { id:'t3', date:'2026-10-02', subject:'A Touch Call: Wendy Sato' },
    };
    // Raw related-task shapes, so the dev harness runs the same reducer the
    // live page runs on Zoho's own payload.
    const DEV_TASKS = {
      '101': [
        { id:'d1', Subject:'A Touch Call: Molly Kinney', Status:'Completed',   Task_Type:'Call',   Due_Date:'2026-08-04', Closed_Time:'2026-08-05T14:02:00-04:00' },
        { id:'d2', Subject:'Dropped off a pie',          Status:'Completed',   Task_Type:'Pop By', Due_Date:'2026-06-11', Closed_Time:'2026-06-11T18:20:00-04:00' },
        { id:'d3', Subject:'Handwritten note',           Status:'Completed',   Task_Type:'Note',   Due_Date:'2026-03-02', Closed_Time:'' },
        { id:'t1', Subject:'C Touch Call: Molly Kinney', Status:'Not Started', Task_Type:'Call',   Due_Date:'2026-09-25', Closed_Time:'' },
      ],
      '103': [
        { id:'d4', Subject:'B Touch Call: Rashad Rahman', Status:'Completed', Task_Type:'Call',  Due_Date:'2026-05-19', Closed_Time:'2026-05-19T11:00:00-04:00' },
        { id:'d5', Subject:'Lunch at Via Carota',         Status:'Completed', Task_Type:'Lunch', Due_Date:'2026-02-14', Closed_Time:'2026-02-14T13:30:00-05:00' },
      ],
      '106': [
        { id:'d6', Subject:'Emailed the market update', Status:'Completed', Task_Type:'Email', Due_Date:'2026-09-08', Closed_Time:'2026-09-08T09:15:00-04:00' },
      ],
    };

    // ─── Field discovery ──────────────────────────────────────────────
    // Spouse and the prospect form are CUSTOM fields, so their api names
    // differ per org and cannot be hardcoded. Both are found by matching the
    // field LABEL, the same rule the Calls tab's prospect form already uses,
    // so the two pages always agree on which field they mean.
    const PROSPECT_LABEL = /(prospect.*(form|type))|((form|type).*prospect)/i;
    async function discoverFields() {
      if (isDev()) return DEV_META;
      const { ok, data } = await callZoho({ action:'get_fields', module:'Contacts' });
      if (!ok) return null;
      const fields = Array.isArray(data.fields) ? data.fields : [];
      const pick = (f) => f ? {
        api:f.api_name, label:f.field_label, dataType:f.data_type,
        options:Array.isArray(f.picklist_values) ? f.picklist_values.filter(v => v && !/^-?\s*none\s*-?$/i.test(v)) : null,
      } : null;
      const spouse = fields.find(f => f.data_type === 'lookup' && /spouse|partner/i.test(f.field_label || ''));
      // Only an UNAMBIGUOUS match is used. Two fields both labelled like a
      // prospect form means picking one would silently edit the wrong column.
      const prospects = fields.filter(f => PROSPECT_LABEL.test(String(f.field_label || '')));
      // The Tasks module's own "Task Type" is a custom field too, and the Last
      // touches column groups by it. Same label rule /crm-tasks uses and the
      // same fallback, so the two pages always read the same column.
      let taskType = 'Task_Type';
      const tf = await callZoho({ action:'get_fields', module:'Tasks' });
      if (tf.ok) {
        const hit = (Array.isArray(tf.data.fields) ? tf.data.fields : []).find(f => /task\s*type/i.test(f.field_label || ''));
        if (hit && hit.api_name) taskType = hit.api_name;
      }
      return {
        spouse: spouse ? { api:spouse.api_name, label:spouse.field_label } : null,
        prospect: prospects.length === 1 ? pick(prospects[0]) : null,
        cls: pick(fields.find(f => f.api_name === CLS_FIELD)) || { api:CLS_FIELD, label:'Client Classification', dataType:'picklist', options:null },
        taskType,
      };
    }

    // ─── Loading ──────────────────────────────────────────────────────
    const BASE_FIELDS = ['First_Name','Last_Name','Full_Name','Email','Phone','Mobile','Other_Phone',CLS_FIELD,'Owner'];

    // Zoho rejects the WHOLE page request with 400 when any single name in
    // ?fields= is wrong for the module, and the spouse/prospect names are
    // discovered by label match. So a 400 drops the discovered extras and
    // retries once: a bad guess costs those two columns, not the whole table.
    async function fetchContacts(meta, onPage) {
      if (isDev()) { onPage(DEV_CONTACTS, DEV_CONTACTS.length, false); return { ok:true, contacts:DEV_CONTACTS, dropped:false }; }
      const extras = [meta?.spouse?.api, meta?.prospect?.api].filter(Boolean);
      let fields = BASE_FIELDS.concat(extras), dropped = false;
      let page = 1, token = null, more = true, guard = 0;
      const all = [];
      while (more && guard++ < 80) {
        const args = { action:'list_tasks', module:'Contacts', fields, per_page:200 };
        if (token) args.page_token = token; else args.page = page;
        const { ok, status, data } = await callZoho(args);
        if (!ok) {
          if (status === 400 && !dropped && extras.length) { dropped = true; fields = BASE_FIELDS; continue; }
          return { ok:false, error:(data && data.error) || 'Could not load contacts from Zoho.', contacts:all, dropped };
        }
        (data.tasks || []).forEach(c => all.push(c));
        more = !!(data.info && data.info.more_records);
        token = (data.info && data.info.next_page_token) || null;
        onPage(all.slice(), all.length, more);
        // Past page*per_page = 2000 Zoho stops honouring `page` and only
        // continues by page_token. No token at that ceiling means the rest is
        // unreachable, so stop rather than spin on a repeating first page.
        if (more && !token && page >= 10) break;
        page++;
      }
      return { ok:true, contacts:all, dropped };
    }

    // The next scheduled call comes from the Tasks module, not the contact.
    // One bulk pull of every open task beats a per-contact lookup by three
    // orders of magnitude, and it is the same pull /crm-tasks already makes.
    async function fetchNextCalls() {
      if (isDev()) return { ok:true, map:DEV_CALLS };
      const map = {};
      let page = 1, token = null, more = true, guard = 0;
      while (more && guard++ < 80) {
        const args = { action:'list_tasks', module:'Tasks', status_not:'Completed',
          fields:['Subject','Status','Due_Date','Who_Id','Owner'], per_page:200 };
        if (token) args.page_token = token; else args.page = page;
        const { ok, data } = await callZoho(args);
        if (!ok) return { ok:false, map };
        (data.tasks || []).forEach(t => {
          const cid = t.Who_Id && t.Who_Id.id;
          if (!cid || !t.Due_Date) return;
          if (!/call/i.test(t.Subject || '')) return;
          const cur = map[cid];
          if (!cur || t.Due_Date < cur.date) map[cid] = { id:t.id, date:t.Due_Date, subject:t.Subject || '' };
        });
        more = !!(data.info && data.info.more_records);
        token = (data.info && data.info.next_page_token) || null;
        if (more && !token && page >= 10) break;
        page++;
      }
      return { ok:true, map };
    }

    // ─── Last touches ─────────────────────────────────────────────────
    // A "last touch" is the most recent FINISHED task of each type: the last
    // call, the last note, the last pop-by, one line each. That history is
    // only worth pulling for the handful of contacts actually on screen, so
    // it is fetched per batch of 5/10/20, not for the whole database.
    //
    // Zoho's related-records endpoint caps at 50 tasks per contact, so a
    // contact with a very long history can be missing an old, rarely-used
    // type. The recent ones, which are what this page is for, are always in.
    function reduceTouches(list, typeField) {
      const byType = {};
      (Array.isArray(list) ? list : []).forEach(t => {
        if (!/complete/i.test(txt(t.Status))) return;
        const type = txt(t[typeField]).trim() || 'Other';
        // Closed_Time is when it actually happened; Due_Date is the fallback
        // for tasks closed before that field was filled in.
        const when = txt(t.Closed_Time).slice(0, 10) || txt(t.Due_Date);
        if (!when) return;
        const cur = byType[type];
        if (!cur || when > cur.date) byType[type] = { id:t.id, type, date:when, subject:txt(t.Subject) };
      });
      return Object.keys(byType).map(k => byType[k]).sort((a, b) => b.date.localeCompare(a.date));
    }
    async function fetchTouches(ids, typeField) {
      if (!ids || !ids.length) return {};
      const field = typeField || 'Task_Type';
      const out = {};
      if (isDev()) {
        await new Promise(r => setTimeout(r, 250));
        ids.forEach(id => { out[id] = reduceTouches(DEV_TASKS[id] || [], field); });
        return out;
      }
      // One search per contact, six at a time. NOT the Contacts -> Tasks
      // related list: that list comes back with OPEN tasks only, so it can
      // never see a finished call and would report every contact as untouched.
      // /crm-tasks hit exactly this against live data and moved to the search
      // route -- see the note above its lastCompletedCall.
      const B = 6;
      for (let i = 0; i < ids.length; i += B) {
        const res = await Promise.all(ids.slice(i, i + B).map(async cid => {
          try {
            const { ok, data } = await callZoho({ action:'search_tasks', type_field:'Who_Id', type:cid,
              status:'Completed', per_page:200, extra_fields:[field] });
            // null, never [], when Zoho did not answer. "We could not look" and
            // "this contact has never been touched" sit next to a permanent
            // Delete button, so they must not render as the same thing.
            return [cid, ok ? reduceTouches(data.tasks || [], field) : null];
          } catch (e) { return [cid, null]; }
        }));
        res.forEach(pair => { out[pair[0]] = pair[1]; });
      }
      return out;
    }

    // ─── Cache ────────────────────────────────────────────────────────
    // A full sweep is thousands of records and tens of round trips, so it is
    // never paid twice without asking. No expiry: only Refresh re-fetches,
    // matching how /crm-tasks treats its own task cache.
    const CACHE_KEY = 'tmg_contacts_cleanup_v1';
    function loadCache() {
      try {
        const raw = localStorage.getItem(CACHE_KEY);
        if (!raw) return null;
        const p = JSON.parse(raw);
        if (!p || !Array.isArray(p.contacts) || !p.cachedAt) return null;
        return p;
      } catch (e) { return null; }
    }
    function saveCache(payload) {
      try { localStorage.setItem(CACHE_KEY, JSON.stringify({ ...payload, cachedAt:Date.now() })); }
      catch (e) { /* quota: skip caching, the page still works */ }
    }

    // A cleanup pass runs over thousands of contacts across several sittings,
    // so Keep has to survive a reload: a kept contact stays out of the list
    // until it is reset on purpose. Only keeps are stored -- a deleted contact
    // is gone from Zoho and never comes back to be filtered.
    const KEEP_KEY = 'tmg_contacts_cleanup_kept_v1';
    function loadKept() {
      try {
        const raw = localStorage.getItem(KEEP_KEY);
        const ids = raw ? JSON.parse(raw) : null;
        if (!Array.isArray(ids)) return {};
        const m = {};
        ids.forEach(id => { if (id) m[id] = 'kept'; });
        return m;
      } catch (e) { return {}; }
    }
    function saveKept(map) {
      try { localStorage.setItem(KEEP_KEY, JSON.stringify(Object.keys(map).filter(id => map[id] === 'kept'))); }
      catch (e) { /* quota: the pass still works, it just restarts on reload */ }
    }

    // ─── Value helpers ────────────────────────────────────────────────
    const txt = (v) => (v == null ? '' : String(v));
    function clsOf(c) {
      const v = txt(c[CLS_FIELD]).trim();
      return (v && !/^-?\s*none\s*-?$/i.test(v)) ? v : '';
    }
    function spouseOf(c, meta) {
      const v = meta?.spouse ? c[meta.spouse.api] : null;
      return v && v.id ? { id:v.id, name:v.name || '' } : null;
    }
    function prospectOf(c, meta) {
      if (!meta?.prospect) return [];
      const v = c[meta.prospect.api];
      if (Array.isArray(v)) return v.map(x => txt(x && x.display_value ? x.display_value : x)).filter(Boolean);
      const s = txt(v).trim();
      return s && !/^-?\s*none\s*-?$/i.test(s) ? [s] : [];
    }
    function sameVal(a, b) {
      if (Array.isArray(a) || Array.isArray(b)) {
        const x = Array.isArray(a) ? a : (a ? [a] : []), y = Array.isArray(b) ? b : (b ? [b] : []);
        return x.length === y.length && x.every((v, i) => v === y[i]);
      }
      if (a && typeof a === 'object') a = a.id;
      if (b && typeof b === 'object') b = b.id;
      return txt(a) === txt(b);
    }

    // ─── Spouse picker ────────────────────────────────────────────────
    // Zoho lookups need a record id, never a typed name, so the only honest
    // editor for one is a search. The results panel is position:fixed and
    // anchored by rect because the table scrolls horizontally, and an
    // absolutely positioned dropdown inside a scroll box gets clipped.
    function SpousePicker({ value, onChange, selfId }) {
      const [q, setQ] = useState('');
      const [open, setOpen] = useState(false);
      const [busy, setBusy] = useState(false);
      const [hits, setHits] = useState([]);
      const [rect, setRect] = useState(null);
      const boxRef = useRef(null);
      const reqRef = useRef(0);

      useEffect(() => {
        const term = q.trim();
        if (term.length < 2) { setHits([]); setBusy(false); return; }
        const seq = ++reqRef.current;
        setBusy(true);
        const t = setTimeout(async () => {
          if (isDev()) {
            const found = DEV_CONTACTS.filter(c => c.Full_Name.toLowerCase().includes(term.toLowerCase()) && c.id !== selfId)
              .map(c => ({ id:c.id, full_name:c.Full_Name }));
            if (seq === reqRef.current) { setHits(found); setBusy(false); }
            return;
          }
          const { ok, data } = await callZoho({ action:'search_contacts', query:term });
          if (seq !== reqRef.current) return;
          setHits(ok ? (data.contacts || []).filter(c => c.id !== selfId) : []);
          setBusy(false);
        }, 320);
        return () => clearTimeout(t);
      }, [q, selfId]);

      function place() { if (boxRef.current) setRect(boxRef.current.getBoundingClientRect()); }

      if (value) {
        return (
          <div style={{ display:'flex', alignItems:'center', gap:5 }}>
            <span style={{ fontSize:'0.78rem', color:C.textPrimary }}>{value.name || 'Linked'}</span>
            <button type="button" onClick={() => onChange(null)} title="Unlink spouse"
              style={{ border:'none', background:'none', cursor:'pointer', color:C.textMuted, fontSize:13, lineHeight:1, padding:2 }}>
              <i className="ti ti-x" />
            </button>
          </div>
        );
      }
      return (
        <div ref={boxRef} style={{ position:'relative' }}>
          <input value={q} placeholder="Search contact…"
            onChange={e => { setQ(e.target.value); setOpen(true); place(); }}
            onFocus={() => { setOpen(true); place(); }}
            onBlur={() => setTimeout(() => setOpen(false), 180)}
            style={{ ...inp, minWidth:130 }} />
          {open && q.trim().length >= 2 && rect && (
            <div style={{ position:'fixed', top:rect.bottom + 3, left:rect.left, width:Math.max(rect.width, 210),
              background:C.surface, border:'1px solid '+C.border, borderRadius:9, boxShadow:'0 10px 26px rgba(0,26,74,.14)',
              zIndex:80, maxHeight:210, overflowY:'auto' }}>
              {busy && <div style={{ padding:'9px 11px', fontSize:'0.74rem', color:C.textMuted, display:'flex', gap:6, alignItems:'center' }}><Spinner size={11} /> Searching…</div>}
              {!busy && !hits.length && <div style={{ padding:'9px 11px', fontSize:'0.74rem', color:C.textMuted }}>No match</div>}
              {!busy && hits.map(h => (
                <div key={h.id} onMouseDown={() => { onChange({ id:h.id, name:h.full_name }); setQ(''); setOpen(false); }}
                  style={{ padding:'8px 11px', fontSize:'0.78rem', cursor:'pointer', color:C.textPrimary, borderBottom:'1px solid '+C.surfaceAlt }}
                  onMouseEnter={e => e.currentTarget.style.background = C.surfaceAlt}
                  onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
                  {h.full_name}
                </div>
              ))}
            </div>
          )}
        </div>
      );
    }

    // ─── Multi-select picklist (prospect form) ────────────────────────
    function MultiPick({ value, options, onChange }) {
      const list = options && options.length ? options : [];
      if (!list.length) {
        return <input value={(value || []).join(', ')} onChange={e => onChange(e.target.value.split(',').map(s => s.trim()).filter(Boolean))} style={{ ...inp, minWidth:150 }} />;
      }
      return (
        <div style={{ display:'flex', flexWrap:'wrap', gap:4, maxWidth:220 }}>
          {list.map(o => {
            const on = (value || []).includes(o);
            return (
              <button key={o} type="button"
                onClick={() => onChange(on ? value.filter(v => v !== o) : (value || []).concat(o))}
                style={{ fontFamily:C.fontSans, fontSize:'0.66rem', fontWeight:600, padding:'3px 8px', borderRadius:20, cursor:'pointer',
                  border:'1px solid '+(on ? C.navy : C.border), background:on ? C.navy : C.surface, color:on ? '#fff' : C.textSecondary }}>
                {o}
              </button>
            );
          })}
        </div>
      );
    }

    // ─── Shared input styling ─────────────────────────────────────────
    const inp = {
      fontFamily:C.fontSans, fontSize:'0.78rem', color:C.textPrimary, background:C.surface,
      border:'1px solid '+C.border, borderRadius:7, padding:'6px 8px', width:'100%', minWidth:90, outline:'none',
    };
    const btn = {
      fontFamily:C.fontSans, fontSize:'0.74rem', fontWeight:600, borderRadius:8, padding:'7px 12px',
      cursor:'pointer', border:'1px solid '+C.border, background:C.surface, color:C.textSecondary,
      display:'inline-flex', alignItems:'center', gap:6, whiteSpace:'nowrap',
    };
    const th = {
      textAlign:'left', padding:'10px 12px', fontSize:'0.62rem', fontWeight:700, letterSpacing:'.09em',
      textTransform:'uppercase', color:C.textMuted, borderBottom:'1px solid '+C.border,
      background:C.surfaceAlt, position:'sticky', top:0, zIndex:2, whiteSpace:'nowrap',
    };
    const flab = { fontSize:'0.64rem', fontWeight:700, letterSpacing:'.08em', textTransform:'uppercase', color:C.textMuted };
    const td = { padding:'9px 12px', fontSize:'0.8rem', color:C.textSecondary, borderBottom:'1px solid '+C.border, verticalAlign:'middle' };

    // ─── Classification pill ──────────────────────────────────────────
    function ClsPill({ value }) {
      if (!value) return <span style={{ color:C.textMuted }}>—</span>;
      const tone = value === 'A' ? C.green : value === 'B' ? C.gold : value === 'C' ? C.textSecondary : C.blue;
      return <span style={{ fontSize:'0.66rem', fontWeight:700, letterSpacing:'.04em', padding:'2px 9px', borderRadius:20,
        color:tone, background:tone + '14', border:'1px solid ' + tone + '33' }}>{value}</span>;
    }

    // ─── Delete confirmation ──────────────────────────────────────────
    // Deleting a contact in Zoho takes its calls, notes and deal links with
    // it and there is no undo from here, so the name has to be read and the
    // button pressed a second time on purpose.
    function DeleteModal({ contact, busy, error, onCancel, onConfirm }) {
      return (
        <div onClick={busy ? undefined : onCancel}
          style={{ position:'fixed', inset:0, background:'rgba(0,26,74,.42)', zIndex:100, display:'flex', alignItems:'center', justifyContent:'center', padding:20 }}>
          <div onClick={e => e.stopPropagation()}
            style={{ background:C.surface, borderRadius:16, width:'100%', maxWidth:420, padding:'22px 24px', boxShadow:'0 24px 60px rgba(0,26,74,.24)' }}>
            <div style={{ display:'flex', alignItems:'center', gap:9, marginBottom:10 }}>
              <span style={{ width:30, height:30, borderRadius:'50%', background:C.red + '15', display:'flex', alignItems:'center', justifyContent:'center' }}>
                <i className="ti ti-trash" style={{ color:C.red, fontSize:16 }} />
              </span>
              <div style={{ fontFamily:C.fontDisplay, fontSize:'1.3rem', color:C.navy }}>Delete this contact?</div>
            </div>
            <div style={{ fontSize:'0.84rem', color:C.textSecondary, lineHeight:1.6 }}>
              <b style={{ color:C.textPrimary }}>{contact.Full_Name || 'This contact'}</b> will be deleted from Zoho CRM, along with the calls, notes and deal links attached to them. This cannot be undone from here.
            </div>
            {error && <div style={{ marginTop:12, fontSize:'0.78rem', color:C.red }}>{error}</div>}
            <div style={{ display:'flex', justifyContent:'flex-end', gap:8, marginTop:18 }}>
              <button onClick={onCancel} disabled={busy} style={{ ...btn, opacity:busy ? .5 : 1 }}>Keep contact</button>
              <button onClick={onConfirm} disabled={busy}
                style={{ ...btn, background:C.red, borderColor:C.red, color:'#fff', opacity:busy ? .6 : 1 }}>
                {busy ? <><Spinner size={12} color="#fff" /> Deleting…</> : 'Delete permanently'}
              </button>
            </div>
          </div>
        </div>
      );
    }

    // ─── Main app ─────────────────────────────────────────────────────
    function App({ user, profile }) {
      const [meta, setMeta] = useState(null);
      const [contacts, setContacts] = useState([]);
      const [nextCalls, setNextCalls] = useState({});
      const [loading, setLoading] = useState(true);
      const [progress, setProgress] = useState(0);
      const [err, setErr] = useState('');
      const [notice, setNotice] = useState('');
      const [lastUpdated, setLastUpdated] = useState(null);

      const [agent, setAgent] = useState('');
      const [cls, setCls] = useState('');
      const [q, setQ] = useState('');
      // Debounced, because the search term resets the batch and every new
      // batch is a Zoho round trip per contact on screen. Typing six letters
      // must not buy six sweeps. The input itself still tracks `q`, so it
      // stays instant.
      const [qDeb, setQDeb] = useState('');
      useEffect(() => { const t = setTimeout(() => setQDeb(q), 320); return () => clearTimeout(t); }, [q]);
      const [pageSize, setPageSize] = useState(10);

      // The batch is the 5/10/20 contacts on screen right now, and it is
      // frozen on purpose: as each one is kept or deleted its row goes and
      // nothing slides up to take its place, so the batch empties and Next
      // brings the following set. `seen` is everything already handed out, so
      // Next never doubles back over a contact that was skipped.
      const [batchIds, setBatchIds] = useState([]);
      const [seen, setSeen] = useState({});
      const [decided, setDecided] = useState(loadKept);
      const [touches, setTouches] = useState({});
      const [touchBusy, setTouchBusy] = useState(false);
      const [touchErr, setTouchErr] = useState(false);

      const [editId, setEditId] = useState(null);
      const [draft, setDraft] = useState(null);
      const [saving, setSaving] = useState(false);
      const [rowError, setRowError] = useState('');
      const [confirmDel, setConfirmDel] = useState(null);
      const [deleting, setDeleting] = useState(false);
      const [delError, setDelError] = useState('');

      async function load(force) {
        setErr(''); setNotice('');
        setBatchIds([]); setSeen({}); setTouches({});
        if (!force) {
          const cached = loadCache();
          if (cached) {
            setMeta(cached.meta || null);
            setContacts(cached.contacts);
            setNextCalls(cached.nextCalls || {});
            setLastUpdated(cached.cachedAt);
            setLoading(false);
            return;
          }
        }
        setLoading(true); setProgress(0); setContacts([]);
        const m = await discoverFields();
        if (!m) { setErr('Could not read the Contacts field list from Zoho.'); setLoading(false); return; }
        setMeta(m);
        const res = await fetchContacts(m, (rows, n) => { setContacts(rows); setProgress(n); });
        if (!res.ok) { setErr(res.error); setLoading(false); return; }
        if (res.dropped) setNotice('Zoho refused the spouse / prospect form columns, so those two are hidden this round. Everything else loaded.');
        const calls = await fetchNextCalls();
        setNextCalls(calls.map);
        if (!calls.ok) setNotice(n => n || 'Loaded the contacts, but the open-call list came back short, so some “next call” cells may be blank.');
        setContacts(res.contacts);
        setLastUpdated(Date.now());
        setLoading(false);
        saveCache({ meta:res.dropped ? { ...m, spouse:null, prospect:null } : m, contacts:res.contacts, nextCalls:calls.map });
        if (res.dropped) setMeta({ ...m, spouse:null, prospect:null });
      }

      useEffect(() => { load(false); }, []);

      const agents = useMemo(() => {
        const m = {};
        contacts.forEach(c => { const n = (c.Owner && c.Owner.name) || ''; if (n) m[n] = (m[n] || 0) + 1; });
        return Object.keys(m).sort().map(n => ({ name:n, n:m[n] }));
      }, [contacts]);

      const classes = useMemo(() => {
        const fromField = (meta?.cls?.options || []).slice();
        const seen = {};
        contacts.forEach(c => { const v = clsOf(c); if (v) seen[v] = 1; });
        Object.keys(seen).forEach(v => { if (!fromField.includes(v)) fromField.push(v); });
        return fromField;
      }, [contacts, meta]);

      const filtered = useMemo(() => {
        const term = qDeb.trim().toLowerCase();
        return contacts.filter(c => {
          if (agent && ((c.Owner && c.Owner.name) || '') !== agent) return false;
          if (cls === '__none') { if (clsOf(c)) return false; }
          else if (cls && clsOf(c) !== cls) return false;
          if (term) {
            const hay = [c.Full_Name, c.Email, c.Mobile, c.Phone, c.Other_Phone].map(txt).join(' ').toLowerCase();
            if (!hay.includes(term)) return false;
          }
          return true;
        }).sort((a, b) => txt(a.Full_Name).localeCompare(txt(b.Full_Name)));
      }, [contacts, agent, cls, qDeb]);

      // Changing a filter starts the pass over inside the new filter.
      useEffect(() => { setBatchIds([]); setSeen({}); }, [agent, cls, qDeb, pageSize]);

      const byId = useMemo(() => {
        const m = {};
        contacts.forEach(c => { m[c.id] = c; });
        return m;
      }, [contacts]);

      // Hands out the next `n` contacts this filter has not shown yet.
      function takeIds(n) {
        const out = [];
        for (let i = 0; i < filtered.length && out.length < n; i++) {
          const c = filtered[i];
          if (decided[c.id] || seen[c.id]) continue;
          out.push(c.id);
        }
        return out;
      }
      function serve(ids) {
        setBatchIds(ids);
        setSeen(sn => { const n = { ...sn }; ids.forEach(id => { n[id] = 1; }); return n; });
      }
      function nextBatch() { serve(takeIds(pageSize)); }
      const remaining = useMemo(
        () => filtered.reduce((n, c) => n + ((decided[c.id] || seen[c.id]) ? 0 : 1), 0),
        [filtered, decided, seen]
      );

      // Seeds the first batch of a filter. It only ever fires on an EMPTY
      // batchIds, so working through a batch never pulls the next one in
      // behind you.
      useEffect(() => {
        if (loading || batchIds.length || !filtered.length) return;
        const ids = takeIds(pageSize);
        if (ids.length) serve(ids);
        // `decided`/`seen` are in here so Start over refills the table at
        // once instead of parking on an empty batch. Deciding a contact
        // inside a live batch also re-runs this, and leaves on the first
        // line: batchIds still holds that batch, so nothing refills behind
        // the row you just cleared.
      }, [loading, filtered, batchIds.length, pageSize, decided, seen]);

      const batch = useMemo(
        () => batchIds.map(id => byId[id]).filter(c => c && !decided[c.id]),
        [batchIds, byId, decided]
      );

      // Last touches are pulled for the batch on screen, one round trip.
      useEffect(() => {
        if (!batchIds.length) { setTouches({}); setTouchErr(false); setTouchBusy(false); return; }
        let dead = false;
        setTouchBusy(true); setTouchErr(false);
        fetchTouches(batchIds, meta && meta.taskType).then(got => {
          if (dead) return;
          if (got) setTouches(got); else { setTouchErr(true); setTouches({}); }
          setTouchBusy(false);
        }).catch(() => {
          // fetch REJECTS on a dropped connection or a sleeping laptop, which
          // is routine in an hour-long pass. Without this the column spins for
          // ever and the "unavailable" fallback is unreachable.
          if (dead) return;
          setTouchErr(true); setTouches({}); setTouchBusy(false);
        });
        return () => { dead = true; };
      }, [batchIds, meta]);

      useEffect(() => { saveKept(decided); }, [decided]);

      function keepContact(c) {
        if (editId === c.id) cancelEdit();
        setDecided(d => ({ ...d, [c.id]:'kept' }));
      }
      function resetKept() {
        setDecided({});
        try { localStorage.removeItem(KEEP_KEY); } catch (e) {}
        setBatchIds([]); setSeen({});
      }

      function beginEdit(c) {
        setRowError('');
        setEditId(c.id);
        setDraft({
          First_Name: txt(c.First_Name), Last_Name: txt(c.Last_Name),
          Mobile: txt(c.Mobile), Phone: txt(c.Phone), Email: txt(c.Email),
          cls: clsOf(c), spouse: spouseOf(c, meta), prospect: prospectOf(c, meta),
        });
      }
      function cancelEdit() { setEditId(null); setDraft(null); setRowError(''); }

      async function saveEdit(c) {
        const record = {};
        if (draft.First_Name !== txt(c.First_Name)) record.First_Name = draft.First_Name || null;
        if (draft.Last_Name !== txt(c.Last_Name)) record.Last_Name = draft.Last_Name || null;
        if (draft.Mobile !== txt(c.Mobile)) record.Mobile = draft.Mobile || null;
        if (draft.Phone !== txt(c.Phone)) record.Phone = draft.Phone || null;
        if (draft.Email !== txt(c.Email)) record.Email = draft.Email || null;
        if (draft.cls !== clsOf(c)) record[CLS_FIELD] = draft.cls || null;
        if (meta?.spouse && !sameVal(draft.spouse, spouseOf(c, meta))) {
          // Written one way only. The partner's own Spouse field is squared up
          // by the hourly org-wide spouse sync, not from here.
          record[meta.spouse.api] = draft.spouse ? { id:draft.spouse.id } : null;
        }
        if (meta?.prospect && !sameVal(draft.prospect, prospectOf(c, meta))) {
          record[meta.prospect.api] = meta.prospect.dataType === 'multiselectpicklist'
            ? (draft.prospect || [])
            : ((draft.prospect && draft.prospect[0]) || null);
        }
        if (!Object.keys(record).length) { cancelEdit(); return; }

        setSaving(true); setRowError('');
        let ok = true, error = '';
        if (isDev()) { await new Promise(r => setTimeout(r, 300)); }
        else {
          const res = await callZoho({ action:'update_record', module:'Contacts', id:c.id, record });
          ok = res.ok && res.data && res.data.ok;
          error = (res.data && res.data.error) || 'Zoho refused the update.';
        }
        setSaving(false);
        if (!ok) { setRowError(error); return; }

        const patch = { ...record };
        if (meta?.spouse && (meta.spouse.api in record)) patch[meta.spouse.api] = draft.spouse ? { id:draft.spouse.id, name:draft.spouse.name } : null;
        const merged = contacts.map(x => {
          if (x.id !== c.id) return x;
          const next = { ...x, ...patch };
          next.Full_Name = [next.First_Name, next.Last_Name].map(txt).filter(Boolean).join(' ').trim() || x.Full_Name;
          return next;
        });
        setContacts(merged);
        saveCache({ meta, contacts:merged, nextCalls });
        cancelEdit();
      }

      async function doDelete() {
        const c = confirmDel;
        setDeleting(true); setDelError('');
        let ok = true, error = '';
        if (isDev()) { await new Promise(r => setTimeout(r, 300)); }
        else {
          const res = await callZoho({ action:'delete_record', module:'Contacts', id:c.id });
          ok = res.ok && res.data && res.data.ok;
          error = (res.data && res.data.error) || 'Zoho refused the delete.';
        }
        setDeleting(false);
        if (!ok) { setDelError(error); return; }
        const merged = contacts.filter(x => x.id !== c.id);
        setContacts(merged);
        saveCache({ meta, contacts:merged, nextCalls });
        setConfirmDel(null);
        if (editId === c.id) cancelEdit();
      }

      const today = todayISO();
      const keptCount = useMemo(() => Object.keys(decided).filter(id => decided[id] === 'kept').length, [decided]);

      return (
        <div style={{ height:'100%', display:'flex', flexDirection:'column', background:C.bg, fontFamily:C.fontSans }}>
          <style>{`@keyframes cc-spin { to { transform: rotate(360deg); } }`}</style>

          {/* Header -- same bar as /crm-tasks */}
          <header style={{ flexShrink:0, background:C.navy, color:'#fff', padding:'0 20px', height:58, display:'flex', alignItems:'center', justifyContent:'space-between' }}>
            <div style={{ display:'flex', alignItems:'center', gap:12 }}>
              <a href="index.html" title="Back to TMG App" style={{ color:'rgba(255,255,255,.7)', textDecoration:'none', display:'flex', alignItems:'center' }}><i className="ti ti-arrow-left" style={{ fontSize:18 }} /></a>
              <div style={{ fontWeight:600, letterSpacing:'.18em', fontSize:'0.95rem' }}>TMG CRM</div>
              <span style={{ fontSize:'0.62rem', fontWeight:600, letterSpacing:'.1em', textTransform:'uppercase', color:C.goldSoft, border:'1px solid rgba(201,164,90,.4)', padding:'2px 8px', borderRadius:20 }}>Contacts</span>
            </div>
            <div style={{ display:'flex', alignItems:'center', gap:14 }}>
              <a href="crm-tasks.html" style={{ fontSize:'0.74rem', color:'rgba(255,255,255,.65)', textDecoration:'none', display:'flex', alignItems:'center', gap:5 }}><i className="ti ti-checkbox" style={{ fontSize:14 }} />Tasks</a>
              <a href="crm.html" style={{ fontSize:'0.74rem', color:'rgba(255,255,255,.65)', textDecoration:'none', display:'flex', alignItems:'center', gap:5 }}><i className="ti ti-table" style={{ fontSize:14 }} />Schema</a>
              <span style={{ fontSize:'0.78rem', color:'rgba(255,255,255,.7)' }}>{(profile && profile.email) || (user && user.email)}</span>
              <button onClick={() => window.SupabaseAuth.signOut()} style={{ background:'transparent', border:'1px solid rgba(255,255,255,.2)', color:'rgba(255,255,255,.8)', fontSize:'0.72rem', padding:'6px 12px', borderRadius:8, cursor:'pointer', fontFamily:C.fontSans }}>Sign out</button>
            </div>
          </header>

          {/* Title + filters */}
          <div style={{ flexShrink:0, padding:'14px 22px 12px', borderBottom:'1px solid '+C.border, background:C.surface }}>
            <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', gap:12, flexWrap:'wrap' }}>
              <div>
                <div style={{ fontFamily:C.fontDisplay, fontSize:'1.5rem', color:C.navy, lineHeight:1.1 }}>Contacts Cleanup</div>
                <div style={{ fontSize:'0.74rem', color:C.textMuted, marginTop:3 }}>
                  Edits save straight to Zoho. Keep or delete a contact and it leaves the list.
                  {lastUpdated ? <> Loaded {agoLabel(lastUpdated)}.</> : null}
                </div>
              </div>
              <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                {keptCount > 0 && (
                  <button onClick={resetKept} title="Put the contacts you kept back into the list"
                    style={{ ...btn, color:C.textMuted }}><i className="ti ti-arrow-back-up" /> {keptCount} kept</button>
                )}
                <button onClick={() => load(true)} disabled={loading} style={{ ...btn, opacity:loading ? .5 : 1 }}>
                  {loading ? <><Spinner size={12} /> Loading…</> : <><i className="ti ti-refresh" /> Refresh</>}
                </button>
              </div>
            </div>

            {/* Filters */}
            <div style={{ display:'flex', alignItems:'center', gap:10, marginTop:14, flexWrap:'wrap' }}>
              <label style={flab}># of Contacts</label>
              <select value={pageSize} onChange={e => setPageSize(Number(e.target.value))} style={{ ...inp, width:'auto', minWidth:66, cursor:'pointer' }}>
                <option value={5}>5</option>
                <option value={10}>10</option>
                <option value={20}>20</option>
              </select>

              <label style={{ ...flab, marginLeft:4 }}>Agent</label>
              <select value={agent} onChange={e => setAgent(e.target.value)} style={{ ...inp, width:'auto', minWidth:190, cursor:'pointer' }}>
                <option value="">All agents ({contacts.length})</option>
                {agents.map(a => <option key={a.name} value={a.name}>{a.name} ({a.n})</option>)}
              </select>

              <label style={{ ...flab, marginLeft:4 }}>Classification</label>
              <select value={cls} onChange={e => setCls(e.target.value)} style={{ ...inp, width:'auto', minWidth:150, cursor:'pointer' }}>
                <option value="">All classifications</option>
                {classes.map(v => <option key={v} value={v}>{v}</option>)}
                <option value="__none">No classification</option>
              </select>

              <div style={{ position:'relative', marginLeft:'auto' }}>
                <i className="ti ti-search" style={{ position:'absolute', left:9, top:'50%', transform:'translateY(-50%)', fontSize:14, color:C.textMuted }} />
                <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search name, email or number"
                  style={{ ...inp, width:250, paddingLeft:28 }} />
              </div>
            </div>
          </div>

          {/* Status strip */}
          {(err || notice || loading) && (
            <div style={{ padding:'9px 22px', fontSize:'0.76rem', background: err ? C.red+'0F' : C.surfaceAlt,
              color: err ? C.red : C.textSecondary, borderBottom:'1px solid '+C.border, display:'flex', alignItems:'center', gap:8 }}>
              {loading && <Spinner size={12} />}
              {err || notice || (progress ? `Loading contacts from Zoho… ${progress} so far` : 'Loading contacts from Zoho…')}
            </div>
          )}

          {/* Table */}
          <main style={{ flex:1, overflow:'auto' }}>
            {!loading && !filtered.length && !batch.length ? (
              <div style={{ padding:60, textAlign:'center', color:C.textMuted, fontSize:'0.88rem' }}>
                {contacts.length ? 'No contacts match these filters.' : 'No contacts loaded.'}
              </div>
            ) : (
              <>
                {batch.length > 0 && (
                  <table style={{ width:'100%', borderCollapse:'collapse', background:C.surface }}>
                    <thead>
                      <tr>
                        <th style={th}>Name</th>
                        <th style={th}>Last touches</th>
                        <th style={th}>Class</th>
                        <th style={th}>Mobile</th>
                        <th style={th}>Phone</th>
                        <th style={th}>Email</th>
                        <th style={th}>Linked spouse</th>
                        {meta?.prospect && <th style={th}>{meta.prospect.label}</th>}
                        <th style={th}>Next call</th>
                        <th style={{ ...th, position:'sticky', right:0, zIndex:3, textAlign:'right' }}>Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {batch.map(c => {
                        const editing = editId === c.id;
                        const sp = spouseOf(c, meta);
                        const call = nextCalls[c.id];
                        const overdue = call && call.date < today;
                        const touch = touches[c.id];
                        // touch == null covers both "Zoho did not answer for
                        // this one" and "not fetched yet". Either way its
                        // history is unknown, and an unknown history is not a
                        // safe thing to delete on.
                        const unknown = touchErr || touch == null;
                        return (
                          <tr key={c.id} style={{ background: editing ? C.surfaceAlt : 'transparent' }}>
                            <td style={{ ...td, minWidth:170 }}>
                              {editing ? (
                                <div style={{ display:'flex', gap:5 }}>
                                  <input value={draft.First_Name} placeholder="First" onChange={e => setDraft(d => ({ ...d, First_Name:e.target.value }))} style={inp} />
                                  <input value={draft.Last_Name} placeholder="Last" onChange={e => setDraft(d => ({ ...d, Last_Name:e.target.value }))} style={inp} />
                                </div>
                              ) : (
                                <ZohoLink module="Contacts" id={c.id} style={{ fontWeight:600, fontSize:'0.82rem', color:C.navy }}>
                                  {c.Full_Name || '(no name)'}
                                </ZohoLink>
                              )}
                            </td>
                            <td style={{ ...td, minWidth:180 }}>
                              {touchBusy ? <Spinner size={11} />
                                : unknown ? <span title="Zoho did not answer for this contact. Refresh before deciding."
                                    style={{ color:C.amber, fontSize:'0.72rem', fontWeight:600 }}>unavailable</span>
                                : touch.length ? (
                                  <div style={{ display:'flex', flexDirection:'column', gap:2 }}>
                                    {touch.map(t => (
                                      <div key={t.type} style={{ display:'flex', alignItems:'baseline', gap:7, whiteSpace:'nowrap' }}>
                                        <span style={{ fontSize:'0.6rem', fontWeight:700, letterSpacing:'.05em', textTransform:'uppercase', color:C.textMuted, minWidth:52 }}>{t.type}</span>
                                        <ZohoLink module="Tasks" id={t.id} title={t.subject} style={{ fontSize:'0.76rem', color:C.textSecondary }}>{fmtDate(t.date)}</ZohoLink>
                                      </div>
                                    ))}
                                  </div>
                                ) : <span style={{ color:C.textMuted }}>no touches</span>}
                            </td>
                            <td style={td}>
                              {editing ? (
                                <select value={draft.cls} onChange={e => setDraft(d => ({ ...d, cls:e.target.value }))} style={{ ...inp, minWidth:80, cursor:'pointer' }}>
                                  <option value="">—</option>
                                  {classes.map(v => <option key={v} value={v}>{v}</option>)}
                                </select>
                              ) : <ClsPill value={clsOf(c)} />}
                            </td>
                            <td style={{ ...td, whiteSpace:'nowrap' }}>
                              {editing ? <input value={draft.Mobile} onChange={e => setDraft(d => ({ ...d, Mobile:e.target.value }))} style={inp} />
                                : (txt(c.Mobile) || <span style={{ color:C.textMuted }}>—</span>)}
                            </td>
                            <td style={{ ...td, whiteSpace:'nowrap' }}>
                              {editing ? <input value={draft.Phone} onChange={e => setDraft(d => ({ ...d, Phone:e.target.value }))} style={inp} />
                                : (txt(c.Phone) || <span style={{ color:C.textMuted }}>—</span>)}
                            </td>
                            <td style={{ ...td, minWidth:150 }}>
                              {editing ? <input value={draft.Email} onChange={e => setDraft(d => ({ ...d, Email:e.target.value }))} style={inp} />
                                : (txt(c.Email) || <span style={{ color:C.textMuted }}>—</span>)}
                            </td>
                            <td style={{ ...td, minWidth:150 }}>
                              {editing ? (
                                meta?.spouse
                                  ? <SpousePicker value={draft.spouse} selfId={c.id} onChange={v => setDraft(d => ({ ...d, spouse:v }))} />
                                  : <span style={{ color:C.textMuted, fontSize:'0.74rem' }}>no spouse field</span>
                              ) : (sp
                                  ? <ZohoLink module="Contacts" id={sp.id} style={{ fontSize:'0.8rem', color:C.navy }}>{sp.name || 'Linked'}</ZohoLink>
                                  : <span style={{ color:C.textMuted }}>—</span>)}
                            </td>
                            {meta?.prospect && (
                              <td style={{ ...td, minWidth:160 }}>
                                {editing ? (
                                  meta.prospect.dataType === 'multiselectpicklist'
                                    ? <MultiPick value={draft.prospect} options={meta.prospect.options} onChange={v => setDraft(d => ({ ...d, prospect:v }))} />
                                    : (
                                      <select value={(draft.prospect && draft.prospect[0]) || ''} onChange={e => setDraft(d => ({ ...d, prospect:e.target.value ? [e.target.value] : [] }))} style={{ ...inp, cursor:'pointer' }}>
                                        <option value="">—</option>
                                        {(meta.prospect.options || []).map(o => <option key={o} value={o}>{o}</option>)}
                                      </select>
                                    )
                                ) : (
                                  prospectOf(c, meta).length
                                    ? <div style={{ display:'flex', flexWrap:'wrap', gap:4 }}>
                                        {prospectOf(c, meta).map(pv => (
                                          <span key={pv} style={{ fontSize:'0.66rem', fontWeight:600, padding:'2px 8px', borderRadius:20,
                                            background:C.surfaceAlt, border:'1px solid '+C.border, color:C.textSecondary }}>{pv}</span>
                                        ))}
                                      </div>
                                    : <span style={{ color:C.textMuted }}>—</span>
                                )}
                              </td>
                            )}
                            <td style={{ ...td, whiteSpace:'nowrap' }}>
                              {call ? (
                                <ZohoLink module="Tasks" id={call.id} title={call.subject}
                                  style={{ fontSize:'0.8rem', color: overdue ? C.red : C.textPrimary, fontWeight: overdue ? 600 : 400 }}>
                                  {fmtDate(call.date)}{overdue ? ' (overdue)' : ''}
                                </ZohoLink>
                              ) : <span style={{ color:C.textMuted }}>none</span>}
                            </td>
                            <td style={{ ...td, position:'sticky', right:0, background: editing ? C.surfaceAlt : C.surface,
                              borderLeft:'1px solid '+C.border, textAlign:'right', whiteSpace:'nowrap' }}>
                              {editing ? (
                                <div style={{ display:'inline-flex', alignItems:'center', gap:6 }}>
                                  {rowError && <span style={{ fontSize:'0.7rem', color:C.red, maxWidth:160, whiteSpace:'normal', textAlign:'left' }}>{rowError}</span>}
                                  <button onClick={cancelEdit} disabled={saving} style={{ ...btn, padding:'6px 10px', opacity:saving ? .5 : 1 }}>Cancel</button>
                                  <button onClick={() => saveEdit(c)} disabled={saving}
                                    style={{ ...btn, padding:'6px 10px', background:C.navy, borderColor:C.navy, color:'#fff', opacity:saving ? .6 : 1 }}>
                                    {saving ? <><Spinner size={11} color="#fff" /> Saving…</> : 'Save'}
                                  </button>
                                </div>
                              ) : (
                                <div style={{ display:'inline-flex', alignItems:'center', gap:4 }}>
                                  <button onClick={() => beginEdit(c)} title="Edit this contact"
                                    style={{ ...btn, padding:'6px 9px' }}><i className="ti ti-pencil" /> Edit</button>
                                  <button onClick={() => keepContact(c)} title="Keep this contact and take it off the list"
                                    style={{ ...btn, padding:'6px 9px', color:C.green, borderColor:C.green+'55' }}><i className="ti ti-check" /> Keep</button>
                                  <button onClick={() => { setDelError(''); setConfirmDel(c); }} disabled={unknown}
                                    title={unknown ? 'This contact\u2019s task history did not load, so there is nothing to judge it on. Refresh, then delete.' : 'Delete this contact from Zoho'}
                                    style={{ ...btn, padding:'6px 9px', color:C.red, borderColor:C.red+'55',
                                      opacity:unknown ? .38 : 1, cursor:unknown ? 'default' : 'pointer' }}><i className="ti ti-trash" /> Delete</button>
                                </div>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}

                {/* Batch control -- Next only matters once the batch is clear */}
                {!loading && (
                  <div style={{ padding:'20px 22px 30px', textAlign:'center' }}>
                    {batch.length === 0 ? (
                      remaining > 0 ? (
                        <>
                          <div style={{ fontSize:'0.84rem', color:C.textSecondary, marginBottom:11 }}>
                            That batch is clear. {remaining} contact{remaining === 1 ? '' : 's'} left in this filter.
                          </div>
                          <button onClick={nextBatch}
                            style={{ ...btn, background:C.navy, borderColor:C.navy, color:'#fff', padding:'10px 20px', fontSize:'0.8rem' }}>
                            Next {pageSize} contacts <i className="ti ti-arrow-right" />
                          </button>
                        </>
                      ) : (
                        <div style={{ fontSize:'0.84rem', color:C.textSecondary, display:'flex', alignItems:'center', justifyContent:'center', gap:9, flexWrap:'wrap' }}>
                          <span><i className="ti ti-circle-check" style={{ color:C.green, marginRight:6 }} />You have been through every contact in this filter.</span>
                          {keptCount > 0 && <button onClick={resetKept} style={btn}><i className="ti ti-arrow-back-up" /> Start over ({keptCount} kept)</button>}
                        </div>
                      )
                    ) : (
                      <button onClick={nextBatch} disabled={remaining === 0}
                        style={{ ...btn, opacity:remaining === 0 ? .45 : 1, cursor:remaining === 0 ? 'default' : 'pointer' }}>
                        Skip to next {pageSize} <i className="ti ti-arrow-right" />
                      </button>
                    )}
                  </div>
                )}
              </>
            )}
          </main>

          {/* Footer count */}
          <footer style={{ padding:'9px 22px', borderTop:'1px solid '+C.border, background:C.surface,
            fontSize:'0.74rem', color:C.textMuted, display:'flex', justifyContent:'space-between', gap:10 }}>
            <span>{batch.length} on screen · {remaining} left in this filter{keptCount ? ' · ' + keptCount + ' kept' : ''}</span>
            <span>{pageSize} at a time · {agent || 'All agents'} · {cls === '__none' ? 'No classification' : (cls || 'All classifications')}</span>
          </footer>

          {confirmDel && (
            <DeleteModal contact={confirmDel} busy={deleting} error={delError}
              onCancel={() => { if (!deleting) { setConfirmDel(null); setDelError(''); } }}
              onConfirm={doDelete} />
          )}
        </div>
      );
    }

    // ─── Boot (same auth gate as crm-tasks) ───────────────────────────
    (function () {
      const root = ReactDOM.createRoot(document.getElementById('root'));
      const AUTHORIZED_DOMAIN = 'themorshedgroup.com';
      function _showScreen(id) {
        ['login-screen','denied-screen','pending-screen'].forEach(function(s){ var el=document.getElementById(s); if(el) el.hidden=(s!==id); });
        document.getElementById('auth-overlay').style.display='block';
      }
      function showSignin()  { _showScreen('login-screen'); }
      function showRejected(){ _showScreen('denied-screen'); }
      function showPending() { _showScreen('pending-screen'); }
      function hideOverlay() { document.getElementById('auth-overlay').style.display='none'; }

      if (window.TMG_DEV) {
        root.render(<App user={window.SupabaseAuth._state.session?.user} profile={{ email:'symon@morshedgroup.com', first_name:'Symon', access:'admin', status:'active' }} />);
        hideOverlay();
        return;
      }

      async function fetchProfile(userId) {
        try {
          const c = window.SupabaseAuth._client;
          const { data } = await c.from('profiles').select('*').eq('id', userId).maybeSingle();
          return data || null;
        } catch (e) { return null; }
      }

      window.SupabaseAuth.onAuthStateChange(async function({ session }) {
        if (!session) { showSignin(); return; }
        const email = (session.user.email || '').toLowerCase();
        if (!email.endsWith('@' + AUTHORIZED_DOMAIN)) { showRejected(); return; }
        const profile = await fetchProfile(session.user.id);
        if (profile && profile.status === 'pending') { showPending(); return; }
        if (profile && profile.status && profile.status !== 'active') { showRejected(); return; }
        root.render(<App user={session.user} profile={profile} />);
        hideOverlay();
      });
    })();
