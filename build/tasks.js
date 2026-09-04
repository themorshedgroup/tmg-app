const {
  useState,
  useEffect,
  useRef,
  useMemo,
  useCallback
} = React;

// Standalone Tasks app (served at /tasks). Boots straight into the Tasks screen.
const TASKS_STANDALONE = true;
const TASKS_EMBED = (() => {
  try {
    return window.self !== window.top;
  } catch (e) {
    return false;
  }
})();
// Embedded (inside the main app's iframe popout) → no top bar, so popouts fill from the top.
const POPOUT_TOP = TASKS_EMBED ? '0px' : 'calc(60px + env(safe-area-inset-top))';
const TASKS_HASH = (typeof location !== 'undefined' ? location.hash : '').replace('#', '').toLowerCase();

// ─── Deep-link routes ────────────────────────────────────────────────
// Every view has a URL: #tasks, #task/<id>, #ctc, #ctc/<id>[/<tab>],
// #projects, #project/<id>[/<tab>], #rocks, #rock/<id>[/<tab>].
// Detail routes always contain a '/', which App's parseRoute can never
// match; the list tokens are claimed here first (see isDeepRoute below).
const ROUTE_KIND_BY_SEG = {
  ctc: 'ctc_file',
  project: 'project',
  rock: 'rock'
};
const ROUTE_SEG_BY_KIND = {
  ctc_file: 'ctc',
  project: 'project',
  rock: 'rock'
};
const ROUTE_SURFACE_BY_SEG = {
  ctc: 'ctc',
  project: 'projects',
  rock: 'rocks'
};
const ROUTE_LIST = {
  tasks: 'my',
  ctc: 'ctc',
  projects: 'projects',
  rocks: 'rocks'
};
const ROUTE_LIST_SEG = {
  my: 'tasks',
  ctc: 'ctc',
  projects: 'projects',
  rocks: 'rocks'
};
const ROUTE_DTABS = ['overview', 'list', 'board', 'timeline'];
const ROUTE_ID_RE = /^[0-9a-f-]{36}$/i;

// hash -> route, or null when it isn't ours (a tab token, #calendar,
// #decisions, the OAuth #access_token=... hash, or empty).
function parseTaskRoute(hash) {
  const h = (hash || '').replace(/^#\/?/, '').trim().toLowerCase();
  if (!h || h.indexOf('=') !== -1) return null;
  const s = h.split('/').filter(Boolean);
  if (s.length === 1) return ROUTE_LIST[s[0]] ? {
    type: 'list',
    surface: ROUTE_LIST[s[0]]
  } : null;
  if (!ROUTE_ID_RE.test(s[1])) return null;
  if (s[0] === 'task') return {
    type: 'task',
    id: s[1]
  };
  const kind = ROUTE_KIND_BY_SEG[s[0]];
  if (!kind) return null;
  const tab = s[2] && ROUTE_DTABS.indexOf(s[2]) !== -1 ? s[2] : 'overview';
  return {
    type: 'record',
    kind,
    surface: ROUTE_SURFACE_BY_SEG[s[0]],
    id: s[1],
    tab
  };
}
// True for any hash this router owns — App must not rewrite these.
function isDeepRoute(hash) {
  return !!parseTaskRoute(hash);
}
// Handoff from the router (TasksScreen) to ProjectsSurface for the sub-tab
// of a routed record. A module-level holder, not props/state: the target
// ProjectsSurface may not be mounted yet when the route is read, and its
// own reset effect runs a render later and would clobber a tab set here.
const PENDING_ROUTE = {
  kind: null,
  id: null,
  tab: null
};
// Permalink URL for a route hash. Keeps location.search so the ?v= cache
// buster survives — a link without it can serve a recipient a stale
// tasks.html that predates the route it points at.
function permalinkFor(hash) {
  const q = (location.search || '').replace(/[?&]embed=1\b/, '').replace(/^&/, '?');
  return location.origin + location.pathname + q + '#' + hash;
}
// Responsive helper: true when the popout/page is wide enough for a two-pane master-detail.
function useWide(bp) {
  const b = bp || 700;
  const [w, setW] = useState(typeof window !== 'undefined' && window.innerWidth >= b);
  useEffect(() => {
    const f = () => setW(window.innerWidth >= b);
    window.addEventListener('resize', f);
    return () => window.removeEventListener('resize', f);
  }, []);
  return w;
}

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
  navBg: '#001A4A',
  fontSans: "-apple-system, BlinkMacSystemFont, 'Jost', 'Helvetica Neue', Arial, sans-serif",
  fontDisplay: "'Cormorant Garamond', Georgia, serif"
};

// ─── Markdown rendering for AI responses (tables, bold, lists, etc.) ──
// AI text arrives as markdown; chat/thread bubbles must render it, not
// dump raw `**`/`|` syntax. marked → HTML, DOMPurify → sanitized (AI
// text is untrusted input), links forced to open in a new tab.
if (window.DOMPurify && !window.DOMPurify._tmgLinkHook) {
  window.DOMPurify.addHook('afterSanitizeAttributes', node => {
    if (node.tagName === 'A') {
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer');
    }
  });
  window.DOMPurify._tmgLinkHook = true;
}
if (window.marked) window.marked.setOptions({
  breaks: true,
  gfm: true
});
function mdToSafeHtml(text) {
  if (!window.marked || !window.DOMPurify) return null; // CDN failed to load — fall back to plain text
  try {
    return window.DOMPurify.sanitize(window.marked.parse(text || ''));
  } catch (e) {
    return null;
  }
}

// The AI can hand back a downloadable Word/Excel/PowerPoint file, or a generated image, by
// wrapping content in a fenced ```tmg-doc / tmg-sheet / tmg-slides / tmg-image``` block (see
// SYSTEM_PROMPT). Split those out of the raw text so they render as a card instead of a
// plain code block.
const TMG_FILE_BLOCK_RE = /```tmg-(doc|sheet|slides|image)(?:\s+filename="([^"\n]*)")?[ \t]*\n([\s\S]*?)```/g;
function splitGeneratedBlocks(text) {
  const segments = [];
  let last = 0,
    m;
  TMG_FILE_BLOCK_RE.lastIndex = 0;
  const t = text || '';
  while (m = TMG_FILE_BLOCK_RE.exec(t)) {
    if (m.index > last) segments.push({
      type: 'md',
      text: t.slice(last, m.index)
    });
    segments.push({
      type: m[1],
      filename: m[2] || null,
      body: m[3]
    });
    last = m.index + m[0].length;
  }
  if (last < t.length) segments.push({
    type: 'md',
    text: t.slice(last)
  });
  return segments.length ? segments : [{
    type: 'md',
    text: t
  }];
}

// Finds a Markdown pipe-table in plain text (the AI's normal way of showing tabular data
// when it *doesn't* use the ```tmg-sheet``` fence) and returns its rows — header row first,
// separator row dropped — or null if there isn't one. Used by FallbackFileActions below.
function findMdTable(text) {
  const lines = (text || '').split(/\r?\n/);
  for (let i = 0; i < lines.length - 1; i++) {
    const head = lines[i].trim(),
      sep = lines[i + 1].trim();
    if (!/^\|.*\|$/.test(head)) continue;
    if (!/^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?$/.test(sep)) continue;
    const rows = [head];
    let j = i + 2;
    while (j < lines.length && /^\|.*\|$/.test(lines[j].trim())) {
      rows.push(lines[j].trim());
      j++;
    }
    return rows;
  }
  return null;
}
function csvCell(v) {
  const s = String(v == null ? '' : v).replace(/\r?\n/g, ' ').trim();
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function mdRowsToCsv(rows) {
  return rows.map(l => l.replace(/^\|/, '').replace(/\|$/, '').split('|').map(csvCell).join(',')).join('\n');
}

// Renders AI markdown safely; falls back to plain text if parsing fails
// or the CDN scripts didn't load, so a formatting bug never blanks a message.
function MarkdownContent({
  text
}) {
  const segments = useMemo(() => splitGeneratedBlocks(text), [text]);
  if (segments.length === 1 && segments[0].type === 'md') {
    const html = mdToSafeHtml(segments[0].text);
    return /*#__PURE__*/React.createElement(React.Fragment, null, html == null ? /*#__PURE__*/React.createElement("span", {
      style: {
        whiteSpace: 'pre-wrap'
      }
    }, text) : /*#__PURE__*/React.createElement("div", {
      className: "md-body",
      dangerouslySetInnerHTML: {
        __html: html
      }
    }), /*#__PURE__*/React.createElement(FallbackFileActions, {
      text: segments[0].text
    }));
  }
  return /*#__PURE__*/React.createElement(React.Fragment, null, segments.map((seg, i) => {
    if (seg.type === 'md') {
      if (!seg.text.trim()) return null;
      const html = mdToSafeHtml(seg.text);
      return html == null ? /*#__PURE__*/React.createElement("span", {
        key: i,
        style: {
          whiteSpace: 'pre-wrap'
        }
      }, seg.text) : /*#__PURE__*/React.createElement("div", {
        key: i,
        className: "md-body",
        dangerouslySetInnerHTML: {
          __html: html
        }
      });
    }
    if (seg.type === 'image') return /*#__PURE__*/React.createElement(GeneratedImageCard, {
      key: i,
      prompt: seg.body
    });
    return /*#__PURE__*/React.createElement(GeneratedFileCard, {
      key: i,
      kind: seg.type,
      filename: seg.filename,
      body: seg.body
    });
  }));
}

// A card offering to download an AI-generated Word/Excel/PowerPoint file. The actual
// file (docx/xlsx/pptx) is only built on click, from the plain-text/CSV/slide body
// the model produced — nothing binary is ever sent over the wire.
const GEN_FILE_META = {
  doc: {
    icon: 'ti-file-type-doc',
    label: 'Word document',
    ext: '.docx'
  },
  sheet: {
    icon: 'ti-file-type-xls',
    label: 'Excel spreadsheet',
    ext: '.xlsx'
  },
  slides: {
    icon: 'ti-file-type-ppt',
    label: 'PowerPoint presentation',
    ext: '.pptx'
  }
};
function GeneratedFileCard({
  kind,
  filename,
  body
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const meta = GEN_FILE_META[kind] || GEN_FILE_META.doc;
  const name = (filename || 'Generated' + meta.ext).replace(/\.[a-z0-9]+$/i, '') + meta.ext;
  const download = async () => {
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      const blob = kind === 'doc' ? await genDocxBlob(body) : kind === 'sheet' ? genXlsxBlob(body) : await genPptxBlob(body);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => {
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }, 400);
    } catch (e) {
      setErr(e.message || String(e));
    } finally {
      setBusy(false);
    }
  };
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: 4,
      margin: '6px 0'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 10,
      padding: '11px 13px',
      borderRadius: 12,
      border: `1px solid ${C.border}`,
      background: C.surfaceHover
    }
  }, /*#__PURE__*/React.createElement("i", {
    className: `ti ${meta.icon}`,
    style: {
      fontSize: 22,
      color: C.gold,
      flexShrink: 0
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      minWidth: 0
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: '0.84rem',
      fontWeight: 600,
      color: C.textPrimary,
      whiteSpace: 'nowrap',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      fontFamily: C.fontSans
    }
  }, name), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: '0.7rem',
      color: C.textSecondary,
      fontFamily: C.fontSans
    }
  }, meta.label)), /*#__PURE__*/React.createElement("button", {
    onClick: download,
    disabled: busy,
    style: {
      padding: '7px 12px',
      borderRadius: 9,
      border: 'none',
      background: C.navy,
      color: '#fff',
      fontSize: '0.76rem',
      fontWeight: 600,
      cursor: 'pointer',
      fontFamily: C.fontSans,
      opacity: busy ? 0.6 : 1,
      flexShrink: 0
    }
  }, busy ? '…' : 'Download')), err ? /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: '0.7rem',
      color: C.red,
      fontFamily: C.fontSans,
      padding: '0 2px'
    }
  }, err) : null);
}

// Safety net for replies that clearly deserve a real file but where the model didn't use
// the ```tmg-doc/tmg-sheet``` fence (it isn't 100% reliable at remembering custom syntax
// mid-conversation) — e.g. it just prints a Markdown table instead. Rather than leaving the
// user with plain, un-actionable text, any substantial assistant reply gets a manual
// "Download as Word" action, and any reply containing a Markdown table also gets "Download
// as Excel" — built straight from what's already on screen, no extra AI call needed.
function FallbackFileActions({
  text
}) {
  const tableRows = useMemo(() => findMdTable(text), [text]);
  const worthIt = (text || '').trim().length > 160 || !!tableRows;
  const [busy, setBusy] = useState(null);
  const [err, setErr] = useState(null);
  if (!worthIt) return null;
  const go = async kind => {
    if (busy) return;
    setBusy(kind);
    setErr(null);
    try {
      const blob = kind === 'sheet' ? genXlsxBlob(mdRowsToCsv(tableRows)) : await genDocxBlob(text);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = kind === 'sheet' ? 'TMG-Table.xlsx' : 'TMG-Notes.docx';
      document.body.appendChild(a);
      a.click();
      setTimeout(() => {
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }, 400);
    } catch (e) {
      setErr(e.message || String(e));
    } finally {
      setBusy(null);
    }
  };
  const btnStyle = {
    padding: '5px 10px',
    borderRadius: 8,
    border: `1px solid ${C.border}`,
    background: 'transparent',
    color: C.textSecondary,
    fontSize: '0.68rem',
    fontWeight: 600,
    cursor: 'pointer',
    fontFamily: C.fontSans
  };
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexWrap: 'wrap',
      alignItems: 'center',
      gap: 6,
      marginTop: 6
    }
  }, /*#__PURE__*/React.createElement("button", {
    onClick: () => go('doc'),
    disabled: !!busy,
    style: {
      ...btnStyle,
      opacity: busy ? 0.6 : 1
    }
  }, busy === 'doc' ? '…' : 'Download as Word'), tableRows ? /*#__PURE__*/React.createElement("button", {
    onClick: () => go('sheet'),
    disabled: !!busy,
    style: {
      ...btnStyle,
      opacity: busy ? 0.6 : 1
    }
  }, busy === 'sheet' ? '…' : 'Download as Excel') : null, err ? /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: '0.68rem',
      color: C.red,
      fontFamily: C.fontSans
    }
  }, err) : null);
}

// A card offering to generate a real AI image via OpenAI (gpt-image-1.5). Generation
// is NEVER automatic — it costs real money per click, so it only runs when the user
// taps "Generate image", and the result is cached in this component's own state (not
// re-generated on re-render; a fresh reload of the conversation will show the button
// again rather than silently re-spending).
function GeneratedImageCard({
  prompt
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [url, setUrl] = useState(null);
  const generate = async () => {
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      setUrl(await callGenerateImage(prompt, 'medium'));
    } catch (e) {
      setErr(e.message || String(e));
    } finally {
      setBusy(false);
    }
  };
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: 8,
      margin: '6px 0'
    }
  }, url ? /*#__PURE__*/React.createElement("a", {
    href: url,
    download: "generated-image.png",
    style: {
      display: 'block'
    }
  }, /*#__PURE__*/React.createElement("img", {
    src: url,
    alt: prompt,
    style: {
      maxWidth: 280,
      maxHeight: 280,
      borderRadius: 12,
      display: 'block',
      border: `1px solid ${C.border}`
    }
  })) : /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 10,
      padding: '11px 13px',
      borderRadius: 12,
      border: `1px solid ${C.border}`,
      background: C.surfaceHover
    }
  }, /*#__PURE__*/React.createElement("i", {
    className: "ti ti-photo-plus",
    style: {
      fontSize: 22,
      color: C.gold,
      flexShrink: 0
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      minWidth: 0
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: '0.84rem',
      fontWeight: 600,
      color: C.textPrimary,
      fontFamily: C.fontSans
    }
  }, "AI-generated image"), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: '0.7rem',
      color: C.textSecondary,
      fontFamily: C.fontSans,
      whiteSpace: 'nowrap',
      overflow: 'hidden',
      textOverflow: 'ellipsis'
    }
  }, prompt)), /*#__PURE__*/React.createElement("button", {
    onClick: generate,
    disabled: busy,
    style: {
      padding: '7px 12px',
      borderRadius: 9,
      border: 'none',
      background: C.navy,
      color: '#fff',
      fontSize: '0.76rem',
      fontWeight: 600,
      cursor: 'pointer',
      fontFamily: C.fontSans,
      opacity: busy ? 0.6 : 1,
      flexShrink: 0
    }
  }, busy ? 'Generating…' : 'Generate image')), err ? /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: '0.7rem',
      color: C.red,
      fontFamily: C.fontSans,
      padding: '0 2px'
    }
  }, err) : null);
}

// ─── AI backend ──────────────────────────────────────────────────
const AI_ENDPOINT = 'https://ipqoqhsnjubopybujetn.supabase.co/functions/v1/ai-chat';
const SUPABASE_ANON = 'sb_publishable_Jg-roLg8M-BZJ7dBfjEeig_HIdniPaV';
const SYSTEM_PROMPT = "You are the TMG assistant, an AI helper for The Morshed Group, a real estate team. " + "Be warm, concise, and conversational — talk like a helpful colleague, not a report. " + "Help with general questions, drafting, and day-to-day tasks.\n\n" + "You can hand back an actual downloadable Word document, Excel spreadsheet, or PowerPoint " + "presentation. Only do this when the user clearly wants a file (e.g. \"make me a doc/deck/sheet\", " + "\"write this up as a Word doc\", \"put this in a spreadsheet\") — not for normal chat answers. " + "When you do, write a short one-line intro, then EXACTLY ONE fenced code block using one of these " + "language tags (include filename=\"...\" with a sensible name and the right extension), then an " + "optional short one-line outro:\n" + "- ```tmg-doc filename=\"Name.docx\"``` — content is Markdown: \"# \" for a heading, \"## \" for a " + "subheading, \"- \" for a bullet, **bold** for bold, blank lines between paragraphs.\n" + "- ```tmg-sheet filename=\"Name.xlsx\"``` — content is CSV. For more than one sheet, put a line " + "\"### Sheet: <name>\" before each sheet's CSV rows.\n" + "- ```tmg-slides filename=\"Name.pptx\"``` — content is one slide per block, separated by a line " + "containing only \"---\". Each slide's first line is its title; remaining lines starting with " + "\"- \" are bullets.\n\n" + "You can also offer to generate an actual AI image (a real picture, e.g. \"generate an image of a " + "modern living room\") using: ```tmg-image``` where the content is a single clear, detailed image-" + "generation prompt (no filename attribute needed). Only offer this when the user wants a picture " + "generated, not for anything else — generating an image costs real money per use, so never use it " + "speculatively or more than once per request.\n\n" + "Never mix these with your normal answer in the same block, and never use any of these tags unless " + "the user actually wants a file or image.";
function authToken() {
  return window.SupabaseAuth?._state?.session?.access_token || SUPABASE_ANON;
}

// Sends the running conversation to the ai-chat Edge Function and returns the reply text.
// `feature` tags the call for per-feature cost attribution (defaults to this tab).
async function callAI(messages, sysOverride, feature = 'tasks') {
  const res = await fetch(AI_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + authToken(),
      'apikey': SUPABASE_ANON
    },
    body: JSON.stringify({
      messages,
      system: sysOverride || SYSTEM_PROMPT,
      max_tokens: 4096,
      feature
    })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    throw new Error(data.error || 'Request failed (' + res.status + ')');
  }
  return data.text || '';
}

// ─── AI image generation (OpenAI, via edge function) ─────────────
const IMAGE_ENDPOINT = 'https://ipqoqhsnjubopybujetn.supabase.co/functions/v1/generate-image';
// Returns a data: URL (base64) for the generated image. Real per-call cost — only
// invoked when the user explicitly clicks "Generate image" (see GeneratedImageCard).
async function callGenerateImage(prompt, quality = 'medium') {
  const res = await fetch(IMAGE_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + authToken(),
      'apikey': SUPABASE_ANON
    },
    body: JSON.stringify({
      prompt,
      quality
    })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) throw new Error(data.error || 'Request failed (' + res.status + ')');
  if (!data.b64) throw new Error('No image returned.');
  return 'data:image/png;base64,' + data.b64;
}

// ─── Google Calendar (read-only) via edge function ──────────────
const CAL_ENDPOINT = 'https://ipqoqhsnjubopybujetn.supabase.co/functions/v1/google-calendar';
const CAL_IS_DEV = typeof window !== 'undefined' && (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1' || window.location.protocol === 'file:');
// Mirrors the same constant in timeoff.html — the shared "TMG" team calendar (confirmed by
// Symon). The two Google-provided holiday calendars are read-only and qualify for the
// "Holiday" lane category.
const TEAM_CALENDAR_ID = 'c_u17la9j1annqi72em9qs3e8v44@group.calendar.google.com';
const TEAM_LANE_CAL_IDS = [TEAM_CALENDAR_ID, 'ph#holiday@group.v.calendar.google.com', 'us#holiday@group.v.calendar.google.com'];
async function callCalendar(payload) {
  // Preview/localhost has no real Google connection — serve mock data so the
  // calendar and its settings can be verified visually.
  if (CAL_IS_DEV) return {
    ok: true,
    status: 200,
    data: devCalendarMock(payload)
  };
  const res = await fetch(CAL_ENDPOINT, {
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
// List events. Pass calendarIds to pull from several calendars at once; omit for the
// primary calendar only (back-compatible with the pre-multi-calendar edge function).
async function fetchGoogleEvents(timeMin, timeMax, calendarIds) {
  const payload = {
    action: 'list',
    timeMin,
    timeMax
  };
  if (Array.isArray(calendarIds) && calendarIds.length) payload.calendarIds = calendarIds;
  const {
    ok,
    data
  } = await callCalendar(payload);
  if (!ok) {
    const err = new Error(data.error || 'calendar_error');
    err.code = data.error;
    err.detail = data.detail || '';
    throw err;
  }
  return data.events || [];
}
// Team Calendar events via the shared SERVICE ACCOUNT — so the OOO/team ribbon shows
// for everyone regardless of whether they've connected their own Google Calendar.
// Best-effort: returns [] if the team calendar isn't configured or on any error.
async function fetchTeamEvents(timeMin, timeMax) {
  try {
    const {
      ok,
      data
    } = await callCalendar({
      action: 'team-events-list',
      timeMin,
      timeMax
    });
    if (!ok) return [];
    return Array.isArray(data.events) ? data.events : [];
  } catch (e) {
    return [];
  }
}
// Lists the calendars on the connected Google account ({ id, summary, color, primary }).
// Returns [] if the account isn't connected or the edge function predates this action.
async function fetchCalendarList() {
  const {
    ok,
    data
  } = await callCalendar({
    action: 'calendars'
  });
  if (!ok) return [];
  return Array.isArray(data.calendars) ? data.calendars : [];
}
function connectGoogleCalendar(refreshToken) {
  callCalendar({
    action: 'connect',
    refresh_token: refreshToken
  }).catch(() => {});
}
// Create (mode 'create') or update (mode 'edit') an event; returns the new id.
async function saveGoogleEvent({
  mode,
  calendarId,
  eventId,
  event
}) {
  const {
    ok,
    data
  } = await callCalendar({
    action: mode === 'edit' ? 'update' : 'create',
    calendarId,
    eventId,
    event
  });
  if (!ok) {
    const err = new Error(data.error || 'save_failed');
    err.code = data.error;
    throw err;
  }
  return data.id || null;
}
async function deleteGoogleEvent(calendarId, eventId) {
  const {
    ok,
    data
  } = await callCalendar({
    action: 'delete',
    calendarId,
    eventId
  });
  if (!ok) {
    const err = new Error(data.error || 'delete_failed');
    err.code = data.error;
    throw err;
  }
  return true;
}
// Mock Google Calendar responses for localhost/preview only.
function devCalendarMock(payload) {
  if (payload.action === 'connect') return {
    ok: true
  };
  if (payload.action === 'create') return {
    ok: true,
    id: 'dev-' + Math.random().toString(36).slice(2)
  };
  if (payload.action === 'update') return {
    ok: true,
    id: payload.eventId
  };
  if (payload.action === 'delete') return {
    ok: true
  };
  if (payload.action === 'calendars') return {
    calendars: [{
      id: 'primary',
      summary: 'Hidenori Symon',
      primary: true,
      color: '#D50000',
      accessRole: 'owner',
      canWrite: true
    }, {
      id: 'c_u17la9j1annqi72em9qs3e8v44@group.calendar.google.com',
      summary: 'TMG',
      color: '#F6BF26',
      accessRole: 'writer',
      canWrite: true
    }, {
      id: 'ph#holiday@group.v.calendar.google.com',
      summary: 'Holidays in Philippines',
      color: '#3F51B5',
      accessRole: 'reader',
      canWrite: false
    }, {
      id: 'us#holiday@group.v.calendar.google.com',
      summary: 'Holidays in United States',
      color: '#0B8043',
      accessRole: 'reader',
      canWrite: false
    }]
  };
  if (payload.action === 'list') {
    const ids = Array.isArray(payload.calendarIds) && payload.calendarIds.length ? payload.calendarIds : ['primary'];
    const colorOf = {
      'primary': '#D50000',
      'c_u17la9j1annqi72em9qs3e8v44@group.calendar.google.com': '#F6BF26',
      'ph#holiday@group.v.calendar.google.com': '#3F51B5',
      'us#holiday@group.v.calendar.google.com': '#0B8043'
    };
    const base = payload.timeMin ? new Date(payload.timeMin) : new Date();
    const day0 = new Date(base);
    day0.setHours(0, 0, 0, 0);
    const iso = (d, h, m) => {
      const x = new Date(d);
      x.setHours(h, m || 0, 0, 0);
      return x.toISOString();
    };
    const evs = [];
    for (let i = 0; i < 14; i++) {
      const d = new Date(day0);
      d.setDate(d.getDate() + i);
      if (ids.includes('primary') && i % 2 === 0) evs.push({
        id: 'p' + i,
        title: 'Buyer call',
        start: iso(d, 9),
        end: iso(d, 9, 30),
        allDay: false,
        calendarId: 'primary',
        color: colorOf['primary'],
        colorId: null
      });
      if (ids.includes('c_u17la9j1annqi72em9qs3e8v44@group.calendar.google.com') && i % 3 === 0) evs.push({
        id: 't' + i,
        title: 'TMG standup',
        start: iso(d, 14),
        end: iso(d, 15),
        allDay: false,
        calendarId: 'c_u17la9j1annqi72em9qs3e8v44@group.calendar.google.com',
        color: colorOf['c_u17la9j1annqi72em9qs3e8v44@group.calendar.google.com'],
        colorId: '5'
      });
    }
    // ── Dev-only fixtures for the Team All-Day Lane (mirrors the Buyer call/TMG standup
    // fixtures above) — so the lane is visible on localhost without a live Google connection.
    const isoDate = d => {
      const p2 = n => String(n).padStart(2, '0');
      return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate());
    };
    const addD = (d, n) => {
      const x = new Date(d);
      x.setDate(x.getDate() + n);
      return x;
    };
    if (ids.includes('c_u17la9j1annqi72em9qs3e8v44@group.calendar.google.com')) {
      evs.push({
        id: 'ooo-multi',
        title: 'OOO - Kyle Baird',
        start: isoDate(addD(day0, -3)),
        end: isoDate(addD(day0, 11)),
        allDay: true,
        calendarId: 'c_u17la9j1annqi72em9qs3e8v44@group.calendar.google.com',
        color: null,
        colorId: null
      });
      ['Maria Cruz', 'John Reyes', 'Ana Lopez'].forEach((name, idx) => {
        evs.push({
          id: 'ooo-' + idx,
          title: 'OOO - ' + name,
          start: isoDate(addD(day0, 2)),
          end: isoDate(addD(day0, 3)),
          allDay: true,
          calendarId: 'c_u17la9j1annqi72em9qs3e8v44@group.calendar.google.com',
          color: null,
          colorId: null
        });
      });
    }
    if (ids.includes('us#holiday@group.v.calendar.google.com')) evs.push({
      id: 'hol1',
      title: 'Independence Day',
      start: isoDate(addD(day0, 1)),
      end: isoDate(addD(day0, 2)),
      allDay: true,
      calendarId: 'us#holiday@group.v.calendar.google.com',
      color: null,
      colorId: null
    });
    return {
      events: evs
    };
  }
  // Dev-only fixtures for the My Tasks mailbox (localhost/preview has no real
  // Gmail connection) — same demo thread set as tmg-toolbar-email-prototype_1.html
  // so the mailbox looks right without a live edge function.
  if (payload.action === 'gmail_threads') {
    return {
      threads: DEV_GMAIL_THREADS.map(t => ({
        id: t.id,
        permalink: 'https://mail.google.com/mail/u/0/#all/' + t.id,
        from: t.from,
        subject: t.subject,
        snippet: t.snippet,
        date: t.date,
        messageId: t.msgs[t.msgs.length - 1].id,
        messageCount: t.msgs.length
      }))
    };
  }
  if (payload.action === 'gmail_thread') {
    const t = DEV_GMAIL_THREADS.find(x => x.id === payload.threadId);
    if (!t) return {
      error: 'Thread not found.'
    };
    return {
      thread: {
        id: t.id,
        subject: t.subject,
        permalink: 'https://mail.google.com/mail/u/0/#all/' + t.id,
        messages: t.msgs
      }
    };
  }
  return {
    error: 'Unknown action.'
  };
}
// Dev-only Gmail fixtures — content mirrors the prototype's demo threads so the
// mailbox reads realistically on localhost/preview.
const DEV_GMAIL_THREADS = [{
  id: 'devA',
  from: 'Escrow Officer <escrow@firsttitle.example>',
  subject: 'RE: 888 Test Avenue — title order & prelim',
  date: 'Aug 3, 2026',
  snippet: 'Attaching the preliminary title report. Please review Schedule B exceptions before we proceed to binding…',
  msgs: [{
    id: 'devA-1',
    from: 'Symon Yongco <symon@themorshedgroup.com>',
    to: 'Escrow Officer <escrow@firsttitle.example>',
    date: 'Aug 2, 2026',
    subject: 'RE: 888 Test Avenue — title order & prelim',
    bodyText: 'Please open the title order for 888 Test Avenue. Buyer is financing, so we’ll need the prelim before the binding date on the 12th.',
    snippet: ''
  }, {
    id: 'devA-2',
    from: 'Escrow Officer <escrow@firsttitle.example>',
    to: 'Symon Yongco, Kyle Baird',
    date: 'Aug 3, 2026',
    subject: 'RE: 888 Test Avenue — title order & prelim',
    bodyText: 'Attaching the preliminary title report. Please review Schedule B exceptions before we proceed to binding. Two easements to confirm; the rest is standard.',
    snippet: ''
  }]
}, {
  id: 'devB',
  from: 'Kyle Baird <kyle@themorshedgroup.com>',
  subject: 'Lender appraisal timing',
  date: 'Aug 4, 2026',
  snippet: 'Confirmed the appraiser is scheduled for the 6th. Flagging in case it affects the inspection window…',
  msgs: [{
    id: 'devB-1',
    from: 'Kyle Baird <kyle@themorshedgroup.com>',
    to: 'Symon Yongco',
    date: 'Aug 4, 2026',
    subject: 'Lender appraisal timing',
    bodyText: 'Confirmed the appraiser is scheduled for the 6th. Flagging in case it affects the inspection window.',
    snippet: ''
  }]
}, {
  id: 'devC',
  from: 'Buyer’s Agent <agent@buyerbrokerage.example>',
  subject: 'Inspection window — 888 Test Avenue',
  date: 'Aug 1, 2026',
  snippet: 'Buyer would like to schedule the inspection early next week. Are Tue/Wed open?…',
  msgs: [{
    id: 'devC-1',
    from: 'Buyer’s Agent <agent@buyerbrokerage.example>',
    to: 'Symon Yongco',
    date: 'Aug 1, 2026',
    subject: 'Inspection window — 888 Test Avenue',
    bodyText: 'Buyer would like to schedule the inspection early next week. Are Tue or Wed open?',
    snippet: ''
  }]
}];
function greeting() {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
}

// Generates a short conversation title via the edge function; falls back to the first message.
async function generateTitle(firstUserText) {
  const fallback = (firstUserText || 'New chat').replace(/\s+/g, ' ').trim().slice(0, 40);
  try {
    const res = await fetch(AI_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + authToken(),
        'apikey': SUPABASE_ANON
      },
      body: JSON.stringify({
        messages: [{
          role: 'user',
          content: 'Conversation starts with: "' + firstUserText + '"\n\nReply with ONLY a 3-6 word title for it, no quotes, no punctuation at the end.'
        }],
        system: 'You write short, specific chat titles. Reply with only the title text.',
        max_tokens: 24,
        feature: 'tasks'
      })
    });
    const data = await res.json().catch(() => ({}));
    const t = (data.text || '').replace(/^["'\s]+|["'\s.]+$/g, '').trim();
    return t || fallback;
  } catch (e) {
    return fallback;
  }
}

// ─── Conversations DB (Supabase on prod; no-op/in-memory on localhost) ──
const ConvDB = {
  client() {
    return window.SupabaseAuth?._client || null;
  },
  userId() {
    return window.SupabaseAuth?._state?.session?.user?.id || null;
  },
  async loadConversations() {
    if (!this.client()) return [];
    const {
      data,
      error
    } = await this.client().from('ai_conversations').select('*').order('pinned', {
      ascending: false
    }).order('updated_at', {
      ascending: false
    });
    if (error) {
      console.error('[ConvDB] load:', error.message);
      return [];
    }
    return (data || []).map(r => ({
      id: r.id,
      type: r.type,
      workRequest: r.work_request,
      title: r.title || 'New chat',
      pinned: !!r.pinned,
      archived: !!r.archived,
      updatedAt: r.updated_at
    }));
  },
  async createConversation({
    type,
    workRequest,
    title
  }) {
    if (!this.client()) {
      return {
        id: 'local-' + Date.now(),
        type,
        workRequest: workRequest || null,
        title: title || 'New chat',
        pinned: false,
        archived: false
      };
    }
    const {
      data,
      error
    } = await this.client().from('ai_conversations').insert({
      user_id: this.userId(),
      type: type || 'ai',
      work_request: workRequest || null,
      title: title || null
    }).select().single();
    if (error) {
      console.error('[ConvDB] create:', error.message);
      throw error;
    }
    return {
      id: data.id,
      type: data.type,
      workRequest: data.work_request,
      title: data.title || 'New chat',
      pinned: false,
      archived: false
    };
  },
  async updateConversation(id, fields) {
    if (!this.client() || String(id).startsWith('local-')) return;
    const mapped = {
      updated_at: new Date().toISOString()
    };
    if (fields.title !== undefined) mapped.title = fields.title;
    if (fields.pinned !== undefined) mapped.pinned = fields.pinned;
    if (fields.archived !== undefined) mapped.archived = fields.archived;
    const {
      error
    } = await this.client().from('ai_conversations').update(mapped).eq('id', id);
    if (error) console.error('[ConvDB] update:', error.message);
  },
  async touchConversation(id) {
    if (!this.client() || String(id).startsWith('local-')) return;
    await this.client().from('ai_conversations').update({
      updated_at: new Date().toISOString()
    }).eq('id', id);
  },
  async deleteConversation(id) {
    if (!this.client() || String(id).startsWith('local-')) return;
    const {
      error
    } = await this.client().from('ai_conversations').delete().eq('id', id);
    if (error) console.error('[ConvDB] delete:', error.message);
  },
  async loadMessages(convId) {
    if (!this.client() || String(convId).startsWith('local-')) return [];
    const {
      data,
      error
    } = await this.client().from('ai_messages').select('*').eq('conversation_id', convId).order('created_at', {
      ascending: true
    });
    if (error) {
      console.error('[ConvDB] loadMessages:', error.message);
      return [];
    }
    const rows = data || [];
    const out = [];
    for (const r of rows) {
      const atts = Array.isArray(r.attachments) ? r.attachments : [];
      for (const a of atts) {
        if (a.path) a.url = await this.signedUrl(a.path);
      }
      out.push({
        role: r.role,
        content: r.content || '',
        attachments: atts
      });
    }
    return out;
  },
  async insertMessage(convId, role, content, attachments) {
    if (!this.client() || String(convId).startsWith('local-')) return;
    // Strip transient fields (url/objectURL/textContent) before persisting.
    const slim = (attachments || []).map(a => ({
      kind: a.kind,
      name: a.name,
      mediaType: a.mediaType,
      path: a.path,
      size: a.size,
      ...(a.kind === 'text' ? {
        textContent: a.textContent
      } : {})
    }));
    const {
      error
    } = await this.client().from('ai_messages').insert({
      conversation_id: convId,
      role,
      content,
      attachments: slim.length ? slim : null
    });
    if (error) console.error('[ConvDB] insertMessage:', error.message);
  },
  async uploadAttachment(file, convId) {
    if (!this.client()) return null;
    const safe = (file.name || 'file').replace(/[^\w.\-]+/g, '_').slice(-80);
    const path = `${this.userId()}/${convId || 'tmp'}/${crypto.randomUUID()}-${safe}`;
    const {
      error
    } = await this.client().storage.from('chat-attachments').upload(path, file, {
      contentType: file.type || 'application/octet-stream',
      upsert: false
    });
    if (error) {
      console.error('[ConvDB] upload:', error.message);
      throw error;
    }
    return path;
  },
  async signedUrl(path) {
    if (!this.client() || !path) return null;
    const {
      data,
      error
    } = await this.client().storage.from('chat-attachments').createSignedUrl(path, 7200);
    if (error) {
      console.error('[ConvDB] signedUrl:', error.message);
      return null;
    }
    return data?.signedUrl || null;
  }
};

// ─── Profiles / access ───────────────────────────────────────────
// Per-tool access: which configurable roles can open each tool/app.
// Admins are always on. Operations is a configurable role like the others.
// Editable in Admin → Tab Access, persisted in app_access (see app-access.sql).
const ACCESS_APPS = [{
  id: 'chat',
  label: 'AI Chat',
  icon: 'ti-sparkles'
}, {
  id: 'teamchat',
  label: 'Team Chat',
  icon: 'ti-message'
}, {
  id: 'calls',
  label: 'Calls',
  icon: 'ti-phone'
}, {
  id: 'kpis',
  label: 'KPIs',
  icon: 'ti-chart-bar'
}, {
  id: 'deals',
  label: 'Deals',
  icon: 'ti-currency-dollar'
}, {
  id: 'drives',
  label: 'Shared Drives',
  icon: 'ti-folders'
}, {
  id: 'directory',
  label: 'Company Directory',
  icon: 'ti-users'
}, {
  id: 'sffu',
  label: 'SFFU',
  icon: 'ti-messages'
}];
const ACCESS_ROLES = [{
  id: 'operations',
  label: 'Operations'
}, {
  id: 'agent',
  label: 'Sales Agent'
}, {
  id: 'tc',
  label: 'Transaction Coordinator'
}];
// Operations defaults to ON for every tool (preserving its old all-access),
// but is now editable per-tool like Sales Agent / Transaction Coordinator.
const DEFAULT_ACCESS = {
  chat: ['operations', 'agent', 'tc'],
  teamchat: ['operations', 'agent', 'tc'],
  calls: ['operations', 'agent'],
  kpis: ['operations', 'agent'],
  deals: ['operations', 'agent'],
  drives: ['operations', 'agent', 'tc'],
  directory: ['operations', 'agent', 'tc'],
  sffu: ['operations', 'tc']
};
// Fill any missing/invalid apps with defaults; keep only configurable roles.
function normalizeAccess(cfg) {
  const valid = r => r === 'operations' || r === 'agent' || r === 'tc';
  // A config saved before Operations was configurable lists no 'operations'
  // anywhere → backfill it ON for every tool (preserve its old always-on access).
  const legacy = cfg && !ACCESS_APPS.some(a => Array.isArray(cfg[a.id]) && cfg[a.id].includes('operations'));
  const out = {};
  ACCESS_APPS.forEach(a => {
    let v = (cfg && Array.isArray(cfg[a.id]) ? cfg[a.id] : DEFAULT_ACCESS[a.id]) || [];
    v = v.filter(valid);
    if (legacy && !v.includes('operations')) v = ['operations', ...v];
    out[a.id] = v;
  });
  return out;
}
const ProfileDB = {
  client() {
    return window.SupabaseAuth?._client || null;
  },
  uid() {
    return window.SupabaseAuth?._state?.session?.user?.id || null;
  },
  // Returns the user's profile; auto-creates a pending one on first sign-in. Fail-open (null) on error.
  async ensureProfile(user) {
    if (!this.client()) return null;
    try {
      const {
        data,
        error
      } = await this.client().from('profiles').select('*').eq('id', user.id).maybeSingle();
      if (error) {
        console.error('[ProfileDB] load:', error.message);
        return null;
      }
      if (data) return data;
      const full = (user.user_metadata?.full_name || '').trim();
      const parts = full.split(' ');
      const first = parts.shift() || null;
      const last = parts.join(' ') || null;
      const {
        data: ins,
        error: e2
      } = await this.client().from('profiles').insert({
        id: user.id,
        email: user.email,
        first_name: first,
        last_name: last,
        avatar_url: user.user_metadata?.avatar_url || null
      }).select().single();
      if (e2) {
        console.error('[ProfileDB] create:', e2.message);
        return null;
      }
      return ins;
    } catch (e) {
      console.error('[ProfileDB] ensure:', e);
      return null;
    }
  },
  async loadAll() {
    if (!this.client()) return [];
    const {
      data,
      error
    } = await this.client().from('profiles').select('*').order('created_at', {
      ascending: true
    });
    if (error) {
      console.error('[ProfileDB] loadAll:', error.message);
      return [];
    }
    return data || [];
  },
  async updateMine(fields) {
    if (!this.client()) return;
    const m = {
      first_name: fields.first_name || null,
      last_name: fields.last_name || null,
      phone: fields.phone || null
    };
    ['country', 'timezone', 'dob', 'pets'].forEach(k => {
      if (fields[k] !== undefined) m[k] = fields[k] || null;
    });
    const {
      error
    } = await this.client().from('profiles').update(m).eq('id', this.uid());
    if (error) {
      console.error('[ProfileDB] updateMine:', error.message);
      throw error;
    }
  },
  // Presence/status (own profile). touchPresence = the "I'm online" heartbeat.
  async touchPresence() {
    if (!this.client()) return;
    try {
      await this.client().from('profiles').update({
        last_seen_at: new Date().toISOString()
      }).eq('id', this.uid());
    } catch (e) {}
  },
  async setPresence(fields) {
    // { away?, status_text?, status_emoji? }
    if (!this.client()) return;
    const {
      error
    } = await this.client().from('profiles').update(fields).eq('id', this.uid());
    if (error) console.error('[ProfileDB] setPresence:', error.message);
  },
  // Per-user calendar display prefs (calendars shown + rail timezones). Syncs across the user's
  // devices. Requires the profiles.calendar_prefs jsonb column (calendar-prefs.sql).
  async setCalendarPrefs(prefs) {
    if (!this.client()) return;
    const {
      error
    } = await this.client().from('profiles').update({
      calendar_prefs: prefs
    }).eq('id', this.uid());
    if (error) console.error('[ProfileDB] setCalendarPrefs:', error.message);
  },
  async adminUpdate(id, fields) {
    if (!this.client()) return;
    const mapped = {};
    ['employee_id', 'title', 'reports_to', 'assigned_tc', 'access', 'status', 'hire_date'].forEach(k => {
      if (fields[k] !== undefined) mapped[k] = fields[k] || null;
    });
    const {
      error
    } = await this.client().from('profiles').update(mapped).eq('id', id);
    if (error) {
      console.error('[ProfileDB] adminUpdate:', error.message);
      throw error;
    }
  }
};

// Maps a UI message to Claude API content (string, or blocks when it has attachments).
function toApiContent(msg) {
  const atts = msg.attachments || [];
  if (!atts.length) return msg.content || '';
  const blocks = [];
  for (const a of atts) {
    if (a.kind === 'image' && a.url) blocks.push({
      type: 'image',
      source: {
        type: 'url',
        url: a.url
      }
    });else if (a.kind === 'pdf' && a.url) blocks.push({
      type: 'document',
      source: {
        type: 'url',
        url: a.url
      }
    });else if (a.kind === 'text') blocks.push({
      type: 'text',
      text: 'Attached file "' + a.name + '":\n' + (a.textContent || '')
    });
  }
  if (msg.content) blocks.push({
    type: 'text',
    text: msg.content
  });
  return blocks.length ? blocks : msg.content || '';
}

// Icon for a non-image/pdf attachment badge, based on filename extension.
function attFileIcon(name) {
  if (/\.(xlsx|xls|csv)$/i.test(name || '')) return 'ti-file-type-xls';
  if (/\.docx?$/i.test(name || '')) return 'ti-file-type-doc';
  if (/\.pptx?$/i.test(name || '')) return 'ti-file-type-ppt';
  return 'ti-file-text';
}

// ─── Office file reading (attachments) ────────────────────────────
// Word/PowerPoint/Excel are parsed client-side into plain text and sent through
// the same 'text' attachment path CSV/txt already use — no backend changes needed.
async function readXlsxAsText(file) {
  const XLSX = window.XLSX;
  if (!XLSX) throw new Error('Spreadsheet reader failed to load — check your connection and try again.');
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, {
    type: 'array'
  });
  return wb.SheetNames.map(name => '### Sheet: ' + name + '\n' + XLSX.utils.sheet_to_csv(wb.Sheets[name])).join('\n\n');
}
async function readDocxAsText(file) {
  const mammoth = window.mammoth;
  if (!mammoth) throw new Error('Word reader failed to load — check your connection and try again.');
  const buf = await file.arrayBuffer();
  const result = await mammoth.extractRawText({
    arrayBuffer: buf
  });
  return result.value || '';
}
async function readPptxAsText(file) {
  const JSZip = window.JSZip;
  if (!JSZip) throw new Error('Presentation reader failed to load — check your connection and try again.');
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  const slideFiles = Object.keys(zip.files).filter(p => /^ppt\/slides\/slide\d+\.xml$/.test(p)).sort((a, b) => parseInt(a.match(/(\d+)/)[1], 10) - parseInt(b.match(/(\d+)/)[1], 10));
  const parser = new DOMParser();
  const slides = [];
  for (let i = 0; i < slideFiles.length; i++) {
    const xml = await zip.files[slideFiles[i]].async('text');
    const doc = parser.parseFromString(xml, 'application/xml');
    const texts = Array.from(doc.getElementsByTagName('a:t')).map(n => n.textContent || '').filter(Boolean);
    slides.push('Slide ' + (i + 1) + ':\n' + texts.join('\n'));
  }
  return slides.join('\n\n');
}
// Generates a downloadable file from a ```tmg-doc/tmg-sheet/tmg-slides``` block the AI produced.
function mdInlineRuns(line) {
  const {
    TextRun
  } = window.docx;
  return line.split(/(\*\*[^*]+\*\*)/g).filter(Boolean).map(p => {
    const m = /^\*\*([^*]+)\*\*$/.exec(p);
    return m ? new TextRun({
      text: m[1],
      bold: true
    }) : new TextRun(p);
  });
}
async function genDocxBlob(body) {
  const d = window.docx;
  if (!d) throw new Error('Word writer failed to load — check your connection and try again.');
  const {
    Document,
    Packer,
    Paragraph,
    HeadingLevel
  } = d;
  const children = (body || '').split('\n').map(raw => {
    const l = raw.replace(/\r$/, '');
    if (/^#\s+/.test(l)) return new Paragraph({
      text: l.replace(/^#\s+/, ''),
      heading: HeadingLevel.HEADING_1
    });
    if (/^##\s+/.test(l)) return new Paragraph({
      text: l.replace(/^##\s+/, ''),
      heading: HeadingLevel.HEADING_2
    });
    if (/^-\s+/.test(l)) return new Paragraph({
      text: l.replace(/^-\s+/, ''),
      bullet: {
        level: 0
      }
    });
    if (!l.trim()) return new Paragraph({
      text: ''
    });
    return new Paragraph({
      children: mdInlineRuns(l)
    });
  });
  const doc = new Document({
    sections: [{
      children
    }]
  });
  return Packer.toBlob(doc);
}
function genXlsxBlob(body) {
  const XLSX = window.XLSX;
  if (!XLSX) throw new Error('Spreadsheet writer failed to load — check your connection and try again.');
  const wb = XLSX.utils.book_new();
  const re = /^### Sheet: (.+)$/gm;
  const marks = [];
  let m;
  while (m = re.exec(body || '')) marks.push({
    name: m[1].trim(),
    markStart: m.index,
    bodyStart: m.index + m[0].length
  });
  if (!marks.length) {
    const sub = XLSX.read(body || '', {
      type: 'string'
    });
    XLSX.utils.book_append_sheet(wb, sub.Sheets[sub.SheetNames[0]], 'Sheet1');
  } else {
    marks.forEach((mk, i) => {
      const end = i + 1 < marks.length ? marks[i + 1].markStart : body.length;
      const chunk = body.slice(mk.bodyStart, end).trim();
      const sub = XLSX.read(chunk || ' ', {
        type: 'string'
      });
      XLSX.utils.book_append_sheet(wb, sub.Sheets[sub.SheetNames[0]], (mk.name || 'Sheet').slice(0, 31));
    });
  }
  const arr = XLSX.write(wb, {
    type: 'array',
    bookType: 'xlsx'
  });
  return new Blob([arr], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  });
}
async function genPptxBlob(body) {
  const PptxGenJS = window.PptxGenJS;
  if (!PptxGenJS) throw new Error('Presentation writer failed to load — check your connection and try again.');
  const pptx = new PptxGenJS();
  const slides = (body || '').split(/^---\s*$/m).map(s => s.trim()).filter(Boolean);
  slides.forEach(raw => {
    const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);
    const title = (lines[0] || '').replace(/^#+\s*/, '').replace(/^Slide\s*\d+:?\s*/i, '');
    const bullets = lines.slice(1).map(l => l.replace(/^[-*]\s*/, '')).filter(Boolean);
    const slide = pptx.addSlide();
    slide.addText(title, {
      x: 0.5,
      y: 0.3,
      w: 9,
      h: 1,
      fontSize: 28,
      bold: true,
      color: '001A4A'
    });
    if (bullets.length) slide.addText(bullets.map(b => ({
      text: b,
      options: {
        bullet: true,
        breakLine: true
      }
    })), {
      x: 0.5,
      y: 1.3,
      w: 9,
      h: 4.5,
      fontSize: 16,
      color: '333333'
    });
  });
  return pptx.write({
    outputType: 'blob'
  });
}
const WORK_REQUESTS = [{
  key: 'kpis',
  label: 'Enter KPIs',
  short: 'KPIs'
}, {
  key: 'listing_presentation',
  label: 'Request Listing Presentation',
  short: 'Listing'
}];

// The AI instruction (the "command") that powers a Task pill. Stored INSIDE the
// pill's config so it's editable in the pill builder — this is just the default.
// The AI ends every reply with one ACTION block; the app reads it to create the task.
const TASK_PILL_INSTRUCTION = `You are the TMG task assistant. Turn what the user tells you into ONE task on the team's shared task board. Have a short, natural conversation — ask only for what's missing and important, never interrogate. The user's message may begin with "To Do:" — treat that as a prefix and use the rest as the task.

Before creating a task you need at least a TITLE and a DUE DATE. If there's no due date yet, ask for one. Everything else is optional.

Fields you can capture into the payload:
- title (short)
- dueDate ("YYYY-MM-DD"); dueTime ("HH:MM", 24-hour) only if a time was given
- priority: "low" | "medium" | "high"  (default "medium")
- status: "todo" | "in_progress" | "stuck" | "done"  (default "todo")
- project (a short name)
- assignees: array of the people's names who will do it
- assigners: array of the people's names who asked for it
- description: a concise 1–2 sentence summary of the task (this becomes the task's Description)
- context: any extra background/notes
- workingUrl, emailLink: links, only if mentioned
- decisionQuestion, decisionOptions (array of strings), decisionMaker (a name): only if this task is about making a decision

## How to reply
End EVERY reply with exactly ONE action block on its own final line, with nothing after it:
ACTION:{"type":"ADD","payload":{ ...the fields you have... }}

Rules:
- Use "ADD" only once you have at least a title AND a dueDate — that creates the task immediately. Then confirm in one short sentence, e.g. Done — added "<title>", due <date>.
- If the user's first message already has a title and a due date, create the task in your FIRST reply — do not ask follow-up questions.
- If you still need something (like the due date), ask your question and end with: ACTION:{"type":"NONE","payload":{}}
- Resolve relative dates ("Friday", "tomorrow", "next week") to an absolute YYYY-MM-DD using today's date given in the conversation.
- Keep the conversational part brief and friendly.`;

// ─── Enter KPI (Work Mode) ───────────────────────────────────────
// Phase A: every flow only PREVIEWS what would be sent — no network call.
const KPI_LIVE = true;
const KPI_OPTIONS = ['Touch Call', 'Follow Up Call', 'Notes', 'Hotzone Action/s', 'Pop-by', 'Lunch'];
const OTHER_KPI_OPTIONS = ['—']; // placeholder — real Zoho "Other KPI" picklist TBD (Phase B)
const MAX_KPI_PERSONS = 25;
const kpiTodayStr = () => {
  const t = new Date();
  return t.getFullYear() + '-' + String(t.getMonth() + 1).padStart(2, '0') + '-' + String(t.getDate()).padStart(2, '0');
};
const ZOHO_ENDPOINT = 'https://ipqoqhsnjubopybujetn.supabase.co/functions/v1/zoho-crm';
async function callZoho(payload) {
  const res = await fetch(ZOHO_ENDPOINT, {
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
// Zoho PROJECTS — a separate connection/edge function from the CRM one
// above (different Zoho product, different portal-scoped OAuth). Only
// used for CTC Files linked to a Zoho Projects project (plan: hidden-
// wiggling-lamport). Same call shape as callZoho, different endpoint.
const ZOHO_PROJECTS_ENDPOINT = 'https://ipqoqhsnjubopybujetn.supabase.co/functions/v1/zoho-projects';
const CTC_EMAILS_ENDPOINT = 'https://ipqoqhsnjubopybujetn.supabase.co/functions/v1/ctc-emails';
// Every write in the CTC Emails feature goes through the edge function on
// the service-role key — the tables are SELECT-only for the browser, so a
// direct client write would be silently filtered out rather than fail.
async function callCtcEmails(payload) {
  const res = await fetch(CTC_EMAILS_ENDPOINT, {
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
async function callZohoProjects(payload) {
  const res = await fetch(ZOHO_PROJECTS_ENDPOINT, {
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
async function searchZohoContacts(query) {
  const {
    ok,
    data
  } = await callZoho({
    action: 'search_contacts',
    query
  });
  if (!ok) throw new Error(data.error || 'Contact search failed');
  return data.contacts || [];
}
// Fuzzy-match a typed name against Zoho Contacts → ranked candidates [{id, full_name, email, score}].
async function matchZohoContacts(name) {
  const {
    ok,
    data
  } = await callZoho({
    action: 'match_contacts',
    name
  });
  if (!ok) throw new Error(data.error || 'Contact match failed');
  return data.matches || [];
}
// Create a new Zoho Contact → { id, full_name }.
async function createZohoContact(firstName, lastName) {
  const {
    ok,
    data
  } = await callZoho({
    action: 'create_contact',
    first_name: firstName,
    last_name: lastName
  });
  if (!ok) throw new Error(data.error || 'Could not create contact');
  return data;
}
// Valid picklist options for the "Other KPI" fields — Zoho rejects any other value.
const ALLOWED_OTHER_KPIS = ['Agent Recruiting for Tarek', 'Agent Training for Tarek', 'EO Work for Brad', 'Networking Event for Brett', 'Generate Clients/Relationships', 'Open House', 'Pre-Hotzone Action', 'Professional Development'];
async function createAgentKpi(payload) {
  // Maps the app payload onto the REAL Agent_KPIs module fields (verified against Zoho 2026-06-20).
  // Owner isn't set here — the edge function resolves payload.owner_email to a Zoho user id
  // and sets it server-side (Owner is a Zoho user lookup, not a plain string).
  // Field names must match what BOTH entry paths actually produce (KpiInlineForm.review and
  // the AI ACTION block): kpi_date / ctc_hours / others[].kpi. Reading payload.date or
  // payload.ctc here silently yields undefined — the date then falls back to today and CTC
  // is dropped, while formatKpiPreview (which reads the right keys) still shows the user
  // correct values. That mismatch is why this went unnoticed.
  const record = {
    KPI_Date: payload.kpi_date || kpiTodayStr()
  };
  if (payload.ctc_hours != null && payload.ctc_hours !== '') record.CTC_Hours_2 = Number(payload.ctc_hours);

  // Zoho only has Person_1..10 slots — cap at 10.
  const persons = (payload.persons || []).slice(0, 10);
  for (let i = 0; i < persons.length; i++) {
    const p = persons[i],
      n = i + 1;
    // Applicable KPIs is a MULTI-SELECT picklist → send an array of the exact option strings.
    if ((p.kpis || []).length) record['Person_' + n + '_Applicable_KPIs'] = p.kpis;
    if ((p.kpis || []).some(k => /hotzone/i.test(k)) && p.hotzone_count) {
      record['Number_of_Hotzone_Actions_' + n] = Number(p.hotzone_count);
    }
    // Person_N_Name is a Contacts LOOKUP — use the contact resolved in the summary step.
    if (p.contact_id) record['Person_' + n + '_Name'] = {
      id: p.contact_id
    };
  }

  // Other KPIs: 3 slots, and the value must be one of the allowed picklist options.
  (payload.others || []).slice(0, 3).forEach((o, i) => {
    if (!ALLOWED_OTHER_KPIS.includes(o.kpi)) return;
    const n = i + 1;
    record['Other_KPI_' + n] = o.kpi;
    if (o.count) record['Other_KPI_' + n + '_Count'] = Number(o.count);
  });
  const {
    ok,
    data
  } = await callZoho({
    action: 'create_agent_kpi',
    record,
    owner_email: payload.owner_email || null
  });
  if (!ok) throw new Error(data.error || 'Failed to create Agent KPI');
  return data;
}

// Note-flow instruction: the AI parses a pasted KPI note and ends every reply with one ACTION block
// (mirrors TASK_PILL_INSTRUCTION). A person may have MULTIPLE KPIs; names stay free text (Phase A).
const KPI_NOTE_INSTRUCTION = `You are the TMG KPI assistant. The agent pastes a short note describing one day of real-estate prospecting activity. Turn it into ONE normalized KPI submission. Keep replies short and friendly — never interrogate.

FORMAT the agents are taught to use:
- The note STARTS with a date.
- Each person is separated by a double slash "//". Everything between two "//" belongs to ONE person.
- Inside a person's chunk: the person's name plus one or more activities, in any order.
  Example: 6/18 // Sam Smith lunch call // John Doe hotzone // Jane Cruz pop-by notes
  -> date 2026-06-18; Sam Smith = [Lunch, Touch Call]; John Doe = [Hotzone Action/s]; Jane Cruz = [Pop-by, Notes].
If the note has no slashes, do your best to split people and activities sensibly.

Map each activity to one or more of these six KPI types (a person CAN have several):
"Touch Call", "Follow Up Call", "Notes", "Hotzone Action/s", "Pop-by", "Lunch".
Hints: "call"/"called" -> "Touch Call" (use "Follow Up Call" only if they say follow-up); "note"/"left a note" -> "Notes"; "popped by"/"drop by" -> "Pop-by"; "lunch" -> "Lunch"; "hotzone"/"door-knock" -> "Hotzone Action/s".

Also capture: kpi_date ("YYYY-MM-DD"; resolve a relative leading date like "today"/"yesterday"; default to today if none); ctc_hours (a number) only if CTC / call-time hours are mentioned; "others" = activities that fit none of the six, as {kpi, count}. Names are FREE TEXT — record them exactly as written; do NOT match them to any contact list (that happens later). Up to 25 people.

HOTZONE RULE: if a person has "Hotzone Action/s" but no number is given, you MUST ask how many before submitting (one short question), ending with ACTION:{"type":"NONE","payload":{}}.

## How to reply
End EVERY reply with exactly ONE action block on its own final line, with nothing after it:
ACTION:{"type":"KPI","payload":{ ...the fields you have... }}

The payload shape MUST be:
{ "kpi_date":"YYYY-MM-DD", "ctc_hours": <number or null>,
  "persons":[ { "name":"...", "kpis":["<one or more of the six>"], "hotzone_count": <number, only when "Hotzone Action/s" is in kpis> } ],
  "others":[ { "kpi":"...", "count": <number> } ] }

Rules:
- Use "KPI" only once you have kpi_date AND at least one person with a name and >=1 KPI, AND every hotzone person has a count. That readies it for confirmation; then say one short sentence, e.g. Ready - KPIs for 3 people on 2026-06-18.
- If the first message already has everything, submit in your FIRST reply — no questions.
- If something is missing or ambiguous (a hotzone count, follow-up vs touch call), ask ONE short question and end with: ACTION:{"type":"NONE","payload":{}}
- Resolve relative dates using today's date given below. Do NOT use markdown formatting.`;

// Plain-text KPI summary for the saved chat message (chat renders raw text — no markdown).
function formatKpiPreview(p) {
  const L = [];
  L.push('KPI ENTRY');
  L.push('Owner: ' + (p.owner || '—'));
  L.push('Date: ' + (p.kpi_date || '—'));
  L.push('CTC Hours: ' + (p.ctc_hours == null || p.ctc_hours === '' ? '—' : p.ctc_hours));
  L.push('');
  const persons = p.persons || [];
  L.push('People (' + persons.length + '):');
  persons.forEach(function (x, i) {
    const parts = (x.kpis || []).map(function (k) {
      return k === 'Hotzone Action/s' ? 'Hotzone Action/s (' + (x.hotzone_count || 0) + ')' : k;
    });
    L.push('  ' + (i + 1) + '. ' + (x.name || '—') + ' — ' + (parts.length ? parts.join(', ') : '—'));
  });
  if (p.others && p.others.length) {
    L.push('');
    L.push('Other KPIs:');
    p.others.forEach(function (o) {
      L.push('  • ' + o.kpi + ': ' + o.count);
    });
  }
  return L.join('\n');
}

// ─── Work Mode pills ─────────────────────────────────────────────
// Default pills shown when the work_pills table is empty/unreadable (preserves prior behavior).
const FALLBACK_PILLS = [{
  id: 'fb-task',
  label: 'Add To Do',
  icon: 'ti-checklist',
  colorLight: '#001A4A',
  colorDark: 'rgba(255,255,255,0.6)',
  type: 'task',
  config: {
    instruction: TASK_PILL_INSTRUCTION,
    seed: 'To Do: '
  },
  enabled: true
}, {
  id: 'fb-kpis',
  label: 'Enter KPI',
  icon: 'ti-chart-bar',
  colorLight: '#AD832F',
  colorDark: '#C9A45A',
  type: 'prompt',
  config: {
    kpi: true,
    prompt: 'Enter KPI'
  },
  enabled: true
}, {
  id: 'fb-listing',
  label: 'Listing Presentation',
  icon: 'ti-presentation',
  colorLight: '#AD832F',
  colorDark: '#C9A45A',
  type: 'prompt',
  config: {
    prompt: 'Listing Presentation'
  },
  enabled: true
}, {
  id: 'fb-showing',
  label: 'Add Showing',
  icon: 'ti-home',
  colorLight: '#001A4A',
  colorDark: 'rgba(255,255,255,0.6)',
  type: 'prompt',
  config: {
    prompt: 'Add Showing'
  },
  enabled: true
}, {
  id: 'fb-comm',
  label: 'Commission Log',
  icon: 'ti-currency-dollar',
  colorLight: '#0F6E56',
  colorDark: '#5DCAA5',
  type: 'prompt',
  config: {
    prompt: 'Commission Log'
  },
  enabled: true
}, {
  id: 'fb-score',
  label: 'Team Scorecard',
  icon: 'ti-users',
  colorLight: '#AD832F',
  colorDark: '#C9A45A',
  type: 'prompt',
  config: {
    prompt: 'Team Scorecard'
  },
  enabled: true
}, {
  id: 'fb-eod',
  label: 'EOD Report',
  icon: 'ti-file-text',
  colorLight: '#AD832F',
  colorDark: '#C9A45A',
  type: 'prompt',
  config: {
    prompt: 'EOD Report'
  },
  enabled: true
}, {
  id: 'fb-weekly',
  label: 'Weekly Summary',
  icon: 'ti-calendar-stats',
  colorLight: '#001A4A',
  colorDark: 'rgba(255,255,255,0.6)',
  type: 'prompt',
  config: {
    prompt: 'Weekly Summary'
  },
  enabled: true
}];

// Curated icon set for the pill builder's icon picker (all verified Tabler names).
const PILL_ICONS = ['ti-chart-bar', 'ti-presentation', 'ti-home', 'ti-currency-dollar', 'ti-users', 'ti-file-text', 'ti-calendar-stats', 'ti-sparkles', 'ti-clipboard', 'ti-clipboard-list', 'ti-mail', 'ti-phone', 'ti-map-pin', 'ti-building', 'ti-key', 'ti-calendar', 'ti-checklist', 'ti-notes', 'ti-report', 'ti-target', 'ti-trophy', 'ti-coin', 'ti-briefcase', 'ti-message'];

// Color presets (light/dark pair) for pills.
const PILL_COLORS = [{
  l: '#AD832F',
  d: '#C9A45A'
},
// gold
{
  l: '#001A4A',
  d: 'rgba(255,255,255,0.6)'
},
// navy
{
  l: '#0F6E56',
  d: '#5DCAA5'
},
// green
{
  l: '#9A3B3B',
  d: '#E58A8A'
},
// red
{
  l: '#5A3FA0',
  d: '#B79CEB'
} // purple
];

// Make a safe template key from a label/question.
function slugKey(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 24);
}

// Fill {key} placeholders from collected values; fall back to "Label: value" lines.
function composeFromTemplate(template, values, items) {
  if (template && template.trim()) {
    return template.replace(/\{(\w+)\}/g, (m, k) => values[k] !== undefined && values[k] !== '' ? values[k] : '');
  }
  return (items || []).map(it => (it.label || it.question || it.key) + ': ' + (values[it.key] || '')).join('\n');
}

// Supabase helper for work_pills (mirrors ConvDB/ProfileDB: fail-open reads, throwing writes).
const PillDB = {
  client() {
    return window.SupabaseAuth?._client || null;
  },
  uid() {
    return window.SupabaseAuth?._state?.session?.user?.id || null;
  },
  _map(r) {
    return {
      id: r.id,
      label: r.label,
      icon: r.icon,
      colorLight: r.color_light,
      colorDark: r.color_dark,
      type: r.type,
      config: r.config || {},
      enabled: r.enabled,
      sortOrder: r.sort_order,
      roles: r.roles || []
    };
  },
  async list() {
    if (!this.client()) return null;
    const {
      data,
      error
    } = await this.client().from('work_pills').select('*').order('sort_order', {
      ascending: true
    }).order('created_at', {
      ascending: true
    });
    if (error) {
      console.error('[PillDB] list:', error.message);
      return null;
    }
    return (data || []).map(this._map);
  },
  async create(p) {
    if (!this.client()) return;
    const {
      error
    } = await this.client().from('work_pills').insert({
      label: p.label,
      icon: p.icon,
      color_light: p.colorLight,
      color_dark: p.colorDark,
      type: p.type,
      config: p.config || {},
      enabled: p.enabled !== false,
      sort_order: p.sortOrder || 0,
      roles: p.roles || [],
      created_by: this.uid()
    });
    if (error) {
      console.error('[PillDB] create:', error.message);
      throw error;
    }
  },
  async update(id, f) {
    if (!this.client()) return;
    const m = {};
    if (f.label !== undefined) m.label = f.label;
    if (f.icon !== undefined) m.icon = f.icon;
    if (f.colorLight !== undefined) m.color_light = f.colorLight;
    if (f.colorDark !== undefined) m.color_dark = f.colorDark;
    if (f.type !== undefined) m.type = f.type;
    if (f.config !== undefined) m.config = f.config;
    if (f.enabled !== undefined) m.enabled = f.enabled;
    if (f.sortOrder !== undefined) m.sort_order = f.sortOrder;
    if (f.roles !== undefined) m.roles = f.roles;
    const {
      error
    } = await this.client().from('work_pills').update(m).eq('id', id);
    if (error) {
      console.error('[PillDB] update:', error.message);
      throw error;
    }
  },
  async remove(id) {
    if (!this.client()) return;
    const {
      error
    } = await this.client().from('work_pills').delete().eq('id', id);
    if (error) {
      console.error('[PillDB] remove:', error.message);
      throw error;
    }
  },
  async reorder(ids) {
    if (!this.client()) return;
    for (let i = 0; i < ids.length; i++) {
      const {
        error
      } = await this.client().from('work_pills').update({
        sort_order: i
      }).eq('id', ids[i]);
      if (error) {
        console.error('[PillDB] reorder:', error.message);
        throw error;
      }
    }
  }
};

// ─── AI Chat Tab ─────────────────────────────────────────────────

// ─── Settings Tab (placeholder for now) ──────────────────────────
// ─── Location (countries + IANA time zones) + pets data ───
const COUNTRIES = [{
  "c": "AF",
  "n": "Afghanistan"
}, {
  "c": "AX",
  "n": "Åland Islands"
}, {
  "c": "AL",
  "n": "Albania"
}, {
  "c": "DZ",
  "n": "Algeria"
}, {
  "c": "AS",
  "n": "American Samoa"
}, {
  "c": "AD",
  "n": "Andorra"
}, {
  "c": "AO",
  "n": "Angola"
}, {
  "c": "AI",
  "n": "Anguilla"
}, {
  "c": "AQ",
  "n": "Antarctica"
}, {
  "c": "AG",
  "n": "Antigua and Barbuda"
}, {
  "c": "AR",
  "n": "Argentina"
}, {
  "c": "AM",
  "n": "Armenia"
}, {
  "c": "AW",
  "n": "Aruba"
}, {
  "c": "AU",
  "n": "Australia"
}, {
  "c": "AT",
  "n": "Austria"
}, {
  "c": "AZ",
  "n": "Azerbaijan"
}, {
  "c": "BS",
  "n": "Bahamas"
}, {
  "c": "BH",
  "n": "Bahrain"
}, {
  "c": "BD",
  "n": "Bangladesh"
}, {
  "c": "BB",
  "n": "Barbados"
}, {
  "c": "BY",
  "n": "Belarus"
}, {
  "c": "BE",
  "n": "Belgium"
}, {
  "c": "BZ",
  "n": "Belize"
}, {
  "c": "BJ",
  "n": "Benin"
}, {
  "c": "BM",
  "n": "Bermuda"
}, {
  "c": "BT",
  "n": "Bhutan"
}, {
  "c": "BO",
  "n": "Bolivia"
}, {
  "c": "BA",
  "n": "Bosnia and Herzegovina"
}, {
  "c": "BW",
  "n": "Botswana"
}, {
  "c": "BR",
  "n": "Brazil"
}, {
  "c": "IO",
  "n": "British Indian Ocean Territory"
}, {
  "c": "BN",
  "n": "Brunei"
}, {
  "c": "BG",
  "n": "Bulgaria"
}, {
  "c": "BF",
  "n": "Burkina Faso"
}, {
  "c": "BI",
  "n": "Burundi"
}, {
  "c": "CV",
  "n": "Cabo Verde"
}, {
  "c": "KH",
  "n": "Cambodia"
}, {
  "c": "CM",
  "n": "Cameroon"
}, {
  "c": "CA",
  "n": "Canada"
}, {
  "c": "BQ",
  "n": "Caribbean Netherlands"
}, {
  "c": "KY",
  "n": "Cayman Islands"
}, {
  "c": "CF",
  "n": "Central African Republic"
}, {
  "c": "TD",
  "n": "Chad"
}, {
  "c": "CL",
  "n": "Chile"
}, {
  "c": "CN",
  "n": "China"
}, {
  "c": "CX",
  "n": "Christmas Island"
}, {
  "c": "CC",
  "n": "Cocos Islands"
}, {
  "c": "CO",
  "n": "Colombia"
}, {
  "c": "KM",
  "n": "Comoros"
}, {
  "c": "CK",
  "n": "Cook Islands"
}, {
  "c": "CR",
  "n": "Costa Rica"
}, {
  "c": "HR",
  "n": "Croatia"
}, {
  "c": "CU",
  "n": "Cuba"
}, {
  "c": "CW",
  "n": "Curaçao"
}, {
  "c": "CY",
  "n": "Cyprus"
}, {
  "c": "CZ",
  "n": "Czechia"
}, {
  "c": "CD",
  "n": "Democratic Republic of the Congo"
}, {
  "c": "DK",
  "n": "Denmark"
}, {
  "c": "DJ",
  "n": "Djibouti"
}, {
  "c": "DM",
  "n": "Dominica"
}, {
  "c": "DO",
  "n": "Dominican Republic"
}, {
  "c": "EC",
  "n": "Ecuador"
}, {
  "c": "EG",
  "n": "Egypt"
}, {
  "c": "SV",
  "n": "El Salvador"
}, {
  "c": "GQ",
  "n": "Equatorial Guinea"
}, {
  "c": "ER",
  "n": "Eritrea"
}, {
  "c": "EE",
  "n": "Estonia"
}, {
  "c": "SZ",
  "n": "Eswatini"
}, {
  "c": "ET",
  "n": "Ethiopia"
}, {
  "c": "FK",
  "n": "Falkland Islands"
}, {
  "c": "FO",
  "n": "Faroe Islands"
}, {
  "c": "FJ",
  "n": "Fiji"
}, {
  "c": "FI",
  "n": "Finland"
}, {
  "c": "FR",
  "n": "France"
}, {
  "c": "GF",
  "n": "French Guiana"
}, {
  "c": "PF",
  "n": "French Polynesia"
}, {
  "c": "TF",
  "n": "French Southern Territories"
}, {
  "c": "GA",
  "n": "Gabon"
}, {
  "c": "GM",
  "n": "Gambia"
}, {
  "c": "GE",
  "n": "Georgia"
}, {
  "c": "DE",
  "n": "Germany"
}, {
  "c": "GH",
  "n": "Ghana"
}, {
  "c": "GI",
  "n": "Gibraltar"
}, {
  "c": "GR",
  "n": "Greece"
}, {
  "c": "GL",
  "n": "Greenland"
}, {
  "c": "GD",
  "n": "Grenada"
}, {
  "c": "GP",
  "n": "Guadeloupe"
}, {
  "c": "GU",
  "n": "Guam"
}, {
  "c": "GT",
  "n": "Guatemala"
}, {
  "c": "GG",
  "n": "Guernsey"
}, {
  "c": "GN",
  "n": "Guinea"
}, {
  "c": "GW",
  "n": "Guinea-Bissau"
}, {
  "c": "GY",
  "n": "Guyana"
}, {
  "c": "HT",
  "n": "Haiti"
}, {
  "c": "VA",
  "n": "Holy See"
}, {
  "c": "HN",
  "n": "Honduras"
}, {
  "c": "HK",
  "n": "Hong Kong"
}, {
  "c": "HU",
  "n": "Hungary"
}, {
  "c": "IS",
  "n": "Iceland"
}, {
  "c": "IN",
  "n": "India"
}, {
  "c": "ID",
  "n": "Indonesia"
}, {
  "c": "IR",
  "n": "Iran"
}, {
  "c": "IQ",
  "n": "Iraq"
}, {
  "c": "IE",
  "n": "Ireland"
}, {
  "c": "IM",
  "n": "Isle of Man"
}, {
  "c": "IL",
  "n": "Israel"
}, {
  "c": "IT",
  "n": "Italy"
}, {
  "c": "CI",
  "n": "Ivory Coast"
}, {
  "c": "JM",
  "n": "Jamaica"
}, {
  "c": "JP",
  "n": "Japan"
}, {
  "c": "JE",
  "n": "Jersey"
}, {
  "c": "JO",
  "n": "Jordan"
}, {
  "c": "KZ",
  "n": "Kazakhstan"
}, {
  "c": "KE",
  "n": "Kenya"
}, {
  "c": "KI",
  "n": "Kiribati"
}, {
  "c": "KW",
  "n": "Kuwait"
}, {
  "c": "KG",
  "n": "Kyrgyzstan"
}, {
  "c": "LA",
  "n": "Laos"
}, {
  "c": "LV",
  "n": "Latvia"
}, {
  "c": "LB",
  "n": "Lebanon"
}, {
  "c": "LS",
  "n": "Lesotho"
}, {
  "c": "LR",
  "n": "Liberia"
}, {
  "c": "LY",
  "n": "Libya"
}, {
  "c": "LI",
  "n": "Liechtenstein"
}, {
  "c": "LT",
  "n": "Lithuania"
}, {
  "c": "LU",
  "n": "Luxembourg"
}, {
  "c": "MO",
  "n": "Macao"
}, {
  "c": "MG",
  "n": "Madagascar"
}, {
  "c": "MW",
  "n": "Malawi"
}, {
  "c": "MY",
  "n": "Malaysia"
}, {
  "c": "MV",
  "n": "Maldives"
}, {
  "c": "ML",
  "n": "Mali"
}, {
  "c": "MT",
  "n": "Malta"
}, {
  "c": "MH",
  "n": "Marshall Islands"
}, {
  "c": "MQ",
  "n": "Martinique"
}, {
  "c": "MR",
  "n": "Mauritania"
}, {
  "c": "MU",
  "n": "Mauritius"
}, {
  "c": "YT",
  "n": "Mayotte"
}, {
  "c": "MX",
  "n": "Mexico"
}, {
  "c": "FM",
  "n": "Micronesia"
}, {
  "c": "MD",
  "n": "Moldova"
}, {
  "c": "MC",
  "n": "Monaco"
}, {
  "c": "MN",
  "n": "Mongolia"
}, {
  "c": "ME",
  "n": "Montenegro"
}, {
  "c": "MS",
  "n": "Montserrat"
}, {
  "c": "MA",
  "n": "Morocco"
}, {
  "c": "MZ",
  "n": "Mozambique"
}, {
  "c": "MM",
  "n": "Myanmar"
}, {
  "c": "NA",
  "n": "Namibia"
}, {
  "c": "NR",
  "n": "Nauru"
}, {
  "c": "NP",
  "n": "Nepal"
}, {
  "c": "NL",
  "n": "Netherlands"
}, {
  "c": "NC",
  "n": "New Caledonia"
}, {
  "c": "NZ",
  "n": "New Zealand"
}, {
  "c": "NI",
  "n": "Nicaragua"
}, {
  "c": "NE",
  "n": "Niger"
}, {
  "c": "NG",
  "n": "Nigeria"
}, {
  "c": "NU",
  "n": "Niue"
}, {
  "c": "NF",
  "n": "Norfolk Island"
}, {
  "c": "KP",
  "n": "North Korea"
}, {
  "c": "MK",
  "n": "North Macedonia"
}, {
  "c": "MP",
  "n": "Northern Mariana Islands"
}, {
  "c": "NO",
  "n": "Norway"
}, {
  "c": "OM",
  "n": "Oman"
}, {
  "c": "PK",
  "n": "Pakistan"
}, {
  "c": "PW",
  "n": "Palau"
}, {
  "c": "PS",
  "n": "Palestine"
}, {
  "c": "PA",
  "n": "Panama"
}, {
  "c": "PG",
  "n": "Papua New Guinea"
}, {
  "c": "PY",
  "n": "Paraguay"
}, {
  "c": "PE",
  "n": "Peru"
}, {
  "c": "PH",
  "n": "Philippines"
}, {
  "c": "PN",
  "n": "Pitcairn"
}, {
  "c": "PL",
  "n": "Poland"
}, {
  "c": "PT",
  "n": "Portugal"
}, {
  "c": "PR",
  "n": "Puerto Rico"
}, {
  "c": "QA",
  "n": "Qatar"
}, {
  "c": "CG",
  "n": "Republic of the Congo"
}, {
  "c": "RE",
  "n": "Réunion"
}, {
  "c": "RO",
  "n": "Romania"
}, {
  "c": "RU",
  "n": "Russia"
}, {
  "c": "RW",
  "n": "Rwanda"
}, {
  "c": "BL",
  "n": "Saint Barthélemy"
}, {
  "c": "SH",
  "n": "Saint Helena, Ascension and Tristan da Cunha"
}, {
  "c": "KN",
  "n": "Saint Kitts and Nevis"
}, {
  "c": "LC",
  "n": "Saint Lucia"
}, {
  "c": "MF",
  "n": "Saint Martin"
}, {
  "c": "PM",
  "n": "Saint Pierre and Miquelon"
}, {
  "c": "VC",
  "n": "Saint Vincent and the Grenadines"
}, {
  "c": "WS",
  "n": "Samoa"
}, {
  "c": "SM",
  "n": "San Marino"
}, {
  "c": "ST",
  "n": "Sao Tome and Principe"
}, {
  "c": "SA",
  "n": "Saudi Arabia"
}, {
  "c": "SN",
  "n": "Senegal"
}, {
  "c": "RS",
  "n": "Serbia"
}, {
  "c": "SC",
  "n": "Seychelles"
}, {
  "c": "SL",
  "n": "Sierra Leone"
}, {
  "c": "SG",
  "n": "Singapore"
}, {
  "c": "SX",
  "n": "Sint Maarten"
}, {
  "c": "SK",
  "n": "Slovakia"
}, {
  "c": "SI",
  "n": "Slovenia"
}, {
  "c": "SB",
  "n": "Solomon Islands"
}, {
  "c": "SO",
  "n": "Somalia"
}, {
  "c": "ZA",
  "n": "South Africa"
}, {
  "c": "GS",
  "n": "South Georgia and the South Sandwich Islands"
}, {
  "c": "KR",
  "n": "South Korea"
}, {
  "c": "SS",
  "n": "South Sudan"
}, {
  "c": "ES",
  "n": "Spain"
}, {
  "c": "LK",
  "n": "Sri Lanka"
}, {
  "c": "SD",
  "n": "Sudan"
}, {
  "c": "SR",
  "n": "Suriname"
}, {
  "c": "SJ",
  "n": "Svalbard and Jan Mayen"
}, {
  "c": "SE",
  "n": "Sweden"
}, {
  "c": "CH",
  "n": "Switzerland"
}, {
  "c": "SY",
  "n": "Syria"
}, {
  "c": "TW",
  "n": "Taiwan"
}, {
  "c": "TJ",
  "n": "Tajikistan"
}, {
  "c": "TZ",
  "n": "Tanzania"
}, {
  "c": "TH",
  "n": "Thailand"
}, {
  "c": "TL",
  "n": "Timor-Leste"
}, {
  "c": "TG",
  "n": "Togo"
}, {
  "c": "TK",
  "n": "Tokelau"
}, {
  "c": "TO",
  "n": "Tonga"
}, {
  "c": "TT",
  "n": "Trinidad and Tobago"
}, {
  "c": "TN",
  "n": "Tunisia"
}, {
  "c": "TR",
  "n": "Türkiye"
}, {
  "c": "TM",
  "n": "Turkmenistan"
}, {
  "c": "TC",
  "n": "Turks and Caicos Islands"
}, {
  "c": "TV",
  "n": "Tuvalu"
}, {
  "c": "UG",
  "n": "Uganda"
}, {
  "c": "UA",
  "n": "Ukraine"
}, {
  "c": "AE",
  "n": "United Arab Emirates"
}, {
  "c": "GB",
  "n": "United Kingdom"
}, {
  "c": "UM",
  "n": "United States Minor Outlying Islands"
}, {
  "c": "US",
  "n": "United States of America"
}, {
  "c": "UY",
  "n": "Uruguay"
}, {
  "c": "UZ",
  "n": "Uzbekistan"
}, {
  "c": "VU",
  "n": "Vanuatu"
}, {
  "c": "VE",
  "n": "Venezuela"
}, {
  "c": "VN",
  "n": "Vietnam"
}, {
  "c": "VG",
  "n": "Virgin Islands (UK)"
}, {
  "c": "VI",
  "n": "Virgin Islands (US)"
}, {
  "c": "WF",
  "n": "Wallis and Futuna"
}, {
  "c": "EH",
  "n": "Western Sahara"
}, {
  "c": "YE",
  "n": "Yemen"
}, {
  "c": "ZM",
  "n": "Zambia"
}, {
  "c": "ZW",
  "n": "Zimbabwe"
}];
const COUNTRY_TZ = {
  "AD": ["Europe/Andorra"],
  "AE": ["Asia/Dubai"],
  "AF": ["Asia/Kabul"],
  "AG": ["America/Puerto_Rico"],
  "AI": ["America/Puerto_Rico"],
  "AL": ["Europe/Tirane"],
  "AM": ["Asia/Yerevan"],
  "AO": ["Africa/Lagos"],
  "AQ": ["Antarctica/Casey", "Antarctica/Davis", "Antarctica/Mawson", "Antarctica/Palmer", "Antarctica/Rothera", "Antarctica/Troll", "Antarctica/Vostok", "Asia/Riyadh", "Asia/Singapore", "Pacific/Auckland", "Pacific/Port_Moresby"],
  "AR": ["America/Argentina/Buenos_Aires", "America/Argentina/Catamarca", "America/Argentina/Cordoba", "America/Argentina/Jujuy", "America/Argentina/La_Rioja", "America/Argentina/Mendoza", "America/Argentina/Rio_Gallegos", "America/Argentina/Salta", "America/Argentina/San_Juan", "America/Argentina/San_Luis", "America/Argentina/Tucuman", "America/Argentina/Ushuaia"],
  "AS": ["Pacific/Pago_Pago"],
  "AT": ["Europe/Vienna"],
  "AU": ["Antarctica/Macquarie", "Asia/Tokyo", "Australia/Adelaide", "Australia/Brisbane", "Australia/Broken_Hill", "Australia/Darwin", "Australia/Eucla", "Australia/Hobart", "Australia/Lindeman", "Australia/Lord_Howe", "Australia/Melbourne", "Australia/Perth", "Australia/Sydney"],
  "AW": ["America/Puerto_Rico"],
  "AX": ["Europe/Helsinki"],
  "AZ": ["Asia/Baku"],
  "BA": ["Europe/Belgrade"],
  "BB": ["America/Barbados"],
  "BD": ["Asia/Dhaka"],
  "BE": ["Europe/Brussels"],
  "BF": ["Africa/Abidjan"],
  "BG": ["Europe/Sofia"],
  "BH": ["Asia/Qatar"],
  "BI": ["Africa/Maputo"],
  "BJ": ["Africa/Lagos"],
  "BL": ["America/Puerto_Rico"],
  "BM": ["Atlantic/Bermuda"],
  "BN": ["Asia/Kuching"],
  "BO": ["America/La_Paz"],
  "BQ": ["America/Puerto_Rico"],
  "BR": ["America/Araguaina", "America/Bahia", "America/Belem", "America/Boa_Vista", "America/Campo_Grande", "America/Cuiaba", "America/Eirunepe", "America/Fortaleza", "America/Maceio", "America/Manaus", "America/Noronha", "America/Porto_Velho", "America/Recife", "America/Rio_Branco", "America/Santarem", "America/Sao_Paulo"],
  "BS": ["America/Toronto"],
  "BT": ["Asia/Thimphu"],
  "BW": ["Africa/Maputo"],
  "BY": ["Europe/Minsk"],
  "BZ": ["America/Belize"],
  "CA": ["America/Cambridge_Bay", "America/Dawson", "America/Dawson_Creek", "America/Edmonton", "America/Fort_Nelson", "America/Glace_Bay", "America/Goose_Bay", "America/Halifax", "America/Inuvik", "America/Iqaluit", "America/Moncton", "America/Panama", "America/Phoenix", "America/Puerto_Rico", "America/Rankin_Inlet", "America/Regina", "America/Resolute", "America/St_Johns", "America/Swift_Current", "America/Toronto", "America/Vancouver", "America/Whitehorse", "America/Winnipeg"],
  "CC": ["Asia/Yangon"],
  "CD": ["Africa/Lagos", "Africa/Maputo"],
  "CF": ["Africa/Lagos"],
  "CG": ["Africa/Lagos"],
  "CH": ["Europe/Zurich"],
  "CI": ["Africa/Abidjan"],
  "CK": ["Pacific/Rarotonga"],
  "CL": ["America/Coyhaique", "America/Punta_Arenas", "America/Santiago", "Pacific/Easter"],
  "CM": ["Africa/Lagos"],
  "CN": ["Asia/Shanghai", "Asia/Urumqi"],
  "CO": ["America/Bogota"],
  "CR": ["America/Costa_Rica"],
  "CU": ["America/Havana"],
  "CV": ["Atlantic/Cape_Verde"],
  "CW": ["America/Puerto_Rico"],
  "CX": ["Asia/Bangkok"],
  "CY": ["Asia/Famagusta", "Asia/Nicosia"],
  "CZ": ["Europe/Prague"],
  "DE": ["Europe/Berlin", "Europe/Zurich"],
  "DJ": ["Africa/Nairobi"],
  "DK": ["Europe/Berlin"],
  "DM": ["America/Puerto_Rico"],
  "DO": ["America/Santo_Domingo"],
  "DZ": ["Africa/Algiers"],
  "EC": ["America/Guayaquil", "Pacific/Galapagos"],
  "EE": ["Europe/Tallinn"],
  "EG": ["Africa/Cairo"],
  "EH": ["Africa/El_Aaiun"],
  "ER": ["Africa/Nairobi"],
  "ES": ["Africa/Ceuta", "Atlantic/Canary", "Europe/Madrid"],
  "ET": ["Africa/Nairobi"],
  "FI": ["Europe/Helsinki"],
  "FJ": ["Pacific/Fiji"],
  "FK": ["Atlantic/Stanley"],
  "FM": ["Pacific/Guadalcanal", "Pacific/Kosrae", "Pacific/Port_Moresby"],
  "FO": ["Atlantic/Faroe"],
  "FR": ["Europe/Paris"],
  "GA": ["Africa/Lagos"],
  "GB": ["Europe/London"],
  "GD": ["America/Puerto_Rico"],
  "GE": ["Asia/Tbilisi"],
  "GF": ["America/Cayenne"],
  "GG": ["Europe/London"],
  "GH": ["Africa/Abidjan"],
  "GI": ["Europe/Gibraltar"],
  "GL": ["America/Danmarkshavn", "America/Nuuk", "America/Scoresbysund", "America/Thule"],
  "GM": ["Africa/Abidjan"],
  "GN": ["Africa/Abidjan"],
  "GP": ["America/Puerto_Rico"],
  "GQ": ["Africa/Lagos"],
  "GR": ["Europe/Athens"],
  "GS": ["Atlantic/South_Georgia"],
  "GT": ["America/Guatemala"],
  "GU": ["Pacific/Guam"],
  "GW": ["Africa/Bissau"],
  "GY": ["America/Guyana"],
  "HK": ["Asia/Hong_Kong"],
  "HN": ["America/Tegucigalpa"],
  "HR": ["Europe/Belgrade"],
  "HT": ["America/Port-au-Prince"],
  "HU": ["Europe/Budapest"],
  "ID": ["Asia/Jakarta", "Asia/Jayapura", "Asia/Makassar", "Asia/Pontianak"],
  "IE": ["Europe/Dublin"],
  "IL": ["Asia/Jerusalem"],
  "IM": ["Europe/London"],
  "IN": ["Asia/Kolkata"],
  "IO": ["Indian/Chagos"],
  "IQ": ["Asia/Baghdad"],
  "IR": ["Asia/Tehran"],
  "IS": ["Africa/Abidjan"],
  "IT": ["Europe/Rome"],
  "JE": ["Europe/London"],
  "JM": ["America/Jamaica"],
  "JO": ["Asia/Amman"],
  "JP": ["Asia/Tokyo"],
  "KE": ["Africa/Nairobi"],
  "KG": ["Asia/Bishkek"],
  "KH": ["Asia/Bangkok"],
  "KI": ["Pacific/Kanton", "Pacific/Kiritimati", "Pacific/Tarawa"],
  "KM": ["Africa/Nairobi"],
  "KN": ["America/Puerto_Rico"],
  "KP": ["Asia/Pyongyang"],
  "KR": ["Asia/Seoul"],
  "KW": ["Asia/Riyadh"],
  "KY": ["America/Panama"],
  "KZ": ["Asia/Almaty", "Asia/Aqtau", "Asia/Aqtobe", "Asia/Atyrau", "Asia/Oral", "Asia/Qostanay", "Asia/Qyzylorda"],
  "LA": ["Asia/Bangkok"],
  "LB": ["Asia/Beirut"],
  "LC": ["America/Puerto_Rico"],
  "LI": ["Europe/Zurich"],
  "LK": ["Asia/Colombo"],
  "LR": ["Africa/Monrovia"],
  "LS": ["Africa/Johannesburg"],
  "LT": ["Europe/Vilnius"],
  "LU": ["Europe/Brussels"],
  "LV": ["Europe/Riga"],
  "LY": ["Africa/Tripoli"],
  "MA": ["Africa/Casablanca"],
  "MC": ["Europe/Paris"],
  "MD": ["Europe/Chisinau"],
  "ME": ["Europe/Belgrade"],
  "MF": ["America/Puerto_Rico"],
  "MG": ["Africa/Nairobi"],
  "MH": ["Pacific/Kwajalein", "Pacific/Tarawa"],
  "MK": ["Europe/Belgrade"],
  "ML": ["Africa/Abidjan"],
  "MM": ["Asia/Yangon"],
  "MN": ["Asia/Hovd", "Asia/Ulaanbaatar"],
  "MO": ["Asia/Macau"],
  "MP": ["Pacific/Guam"],
  "MQ": ["America/Martinique"],
  "MR": ["Africa/Abidjan"],
  "MS": ["America/Puerto_Rico"],
  "MT": ["Europe/Malta"],
  "MU": ["Indian/Mauritius"],
  "MV": ["Indian/Maldives"],
  "MW": ["Africa/Maputo"],
  "MX": ["America/Bahia_Banderas", "America/Cancun", "America/Chihuahua", "America/Ciudad_Juarez", "America/Hermosillo", "America/Matamoros", "America/Mazatlan", "America/Merida", "America/Mexico_City", "America/Monterrey", "America/Ojinaga", "America/Tijuana"],
  "MY": ["Asia/Kuching", "Asia/Singapore"],
  "MZ": ["Africa/Maputo"],
  "NA": ["Africa/Windhoek"],
  "NC": ["Pacific/Noumea"],
  "NE": ["Africa/Lagos"],
  "NF": ["Pacific/Norfolk"],
  "NG": ["Africa/Lagos"],
  "NI": ["America/Managua"],
  "NL": ["Europe/Brussels"],
  "NO": ["Europe/Berlin"],
  "NP": ["Asia/Kathmandu"],
  "NR": ["Pacific/Nauru"],
  "NU": ["Pacific/Niue"],
  "NZ": ["Pacific/Auckland", "Pacific/Chatham"],
  "OM": ["Asia/Dubai"],
  "PA": ["America/Panama"],
  "PE": ["America/Lima"],
  "PF": ["Pacific/Gambier", "Pacific/Marquesas", "Pacific/Tahiti"],
  "PG": ["Pacific/Bougainville", "Pacific/Port_Moresby"],
  "PH": ["Asia/Manila"],
  "PK": ["Asia/Karachi"],
  "PL": ["Europe/Warsaw"],
  "PM": ["America/Miquelon"],
  "PN": ["Pacific/Pitcairn"],
  "PR": ["America/Puerto_Rico"],
  "PS": ["Asia/Gaza", "Asia/Hebron"],
  "PT": ["Atlantic/Azores", "Atlantic/Madeira", "Europe/Lisbon"],
  "PW": ["Pacific/Palau"],
  "PY": ["America/Asuncion"],
  "QA": ["Asia/Qatar"],
  "RE": ["Asia/Dubai"],
  "RO": ["Europe/Bucharest"],
  "RS": ["Europe/Belgrade"],
  "RU": ["Asia/Anadyr", "Asia/Barnaul", "Asia/Chita", "Asia/Irkutsk", "Asia/Kamchatka", "Asia/Khandyga", "Asia/Krasnoyarsk", "Asia/Magadan", "Asia/Novokuznetsk", "Asia/Novosibirsk", "Asia/Omsk", "Asia/Sakhalin", "Asia/Srednekolymsk", "Asia/Tomsk", "Asia/Ust-Nera", "Asia/Vladivostok", "Asia/Yakutsk", "Asia/Yekaterinburg", "Europe/Astrakhan", "Europe/Kaliningrad", "Europe/Kirov", "Europe/Moscow", "Europe/Samara", "Europe/Saratov", "Europe/Simferopol", "Europe/Ulyanovsk", "Europe/Volgograd"],
  "RW": ["Africa/Maputo"],
  "SA": ["Asia/Riyadh"],
  "SB": ["Pacific/Guadalcanal"],
  "SC": ["Asia/Dubai"],
  "SD": ["Africa/Khartoum"],
  "SE": ["Europe/Berlin"],
  "SG": ["Asia/Singapore"],
  "SH": ["Africa/Abidjan"],
  "SI": ["Europe/Belgrade"],
  "SJ": ["Europe/Berlin"],
  "SK": ["Europe/Prague"],
  "SL": ["Africa/Abidjan"],
  "SM": ["Europe/Rome"],
  "SN": ["Africa/Abidjan"],
  "SO": ["Africa/Nairobi"],
  "SR": ["America/Paramaribo"],
  "SS": ["Africa/Juba"],
  "ST": ["Africa/Sao_Tome"],
  "SV": ["America/El_Salvador"],
  "SX": ["America/Puerto_Rico"],
  "SY": ["Asia/Damascus"],
  "SZ": ["Africa/Johannesburg"],
  "TC": ["America/Grand_Turk"],
  "TD": ["Africa/Ndjamena"],
  "TF": ["Asia/Dubai", "Indian/Maldives"],
  "TG": ["Africa/Abidjan"],
  "TH": ["Asia/Bangkok"],
  "TJ": ["Asia/Dushanbe"],
  "TK": ["Pacific/Fakaofo"],
  "TL": ["Asia/Dili"],
  "TM": ["Asia/Ashgabat"],
  "TN": ["Africa/Tunis"],
  "TO": ["Pacific/Tongatapu"],
  "TR": ["Europe/Istanbul"],
  "TT": ["America/Puerto_Rico"],
  "TV": ["Pacific/Tarawa"],
  "TW": ["Asia/Taipei"],
  "TZ": ["Africa/Nairobi"],
  "UA": ["Europe/Kyiv", "Europe/Simferopol"],
  "UG": ["Africa/Nairobi"],
  "UM": ["Pacific/Pago_Pago", "Pacific/Tarawa"],
  "US": ["America/Adak", "America/Anchorage", "America/Boise", "America/Chicago", "America/Denver", "America/Detroit", "America/Indiana/Indianapolis", "America/Indiana/Knox", "America/Indiana/Marengo", "America/Indiana/Petersburg", "America/Indiana/Tell_City", "America/Indiana/Vevay", "America/Indiana/Vincennes", "America/Indiana/Winamac", "America/Juneau", "America/Kentucky/Louisville", "America/Kentucky/Monticello", "America/Los_Angeles", "America/Menominee", "America/Metlakatla", "America/New_York", "America/Nome", "America/North_Dakota/Beulah", "America/North_Dakota/Center", "America/North_Dakota/New_Salem", "America/Phoenix", "America/Sitka", "America/Yakutat", "Pacific/Honolulu"],
  "UY": ["America/Montevideo"],
  "UZ": ["Asia/Samarkand", "Asia/Tashkent"],
  "VA": ["Europe/Rome"],
  "VC": ["America/Puerto_Rico"],
  "VE": ["America/Caracas"],
  "VG": ["America/Puerto_Rico"],
  "VI": ["America/Puerto_Rico"],
  "VN": ["Asia/Bangkok", "Asia/Ho_Chi_Minh"],
  "VU": ["Pacific/Efate"],
  "WF": ["Pacific/Tarawa"],
  "WS": ["Pacific/Apia"],
  "YE": ["Asia/Riyadh"],
  "YT": ["Africa/Nairobi"],
  "ZA": ["Africa/Johannesburg"],
  "ZM": ["Africa/Maputo"],
  "ZW": ["Africa/Maputo"]
};
const tzCity = z => (z || '').split('/').pop().replace(/_/g, ' ');
// Curated zones for the calendar's dual-zone time rail (label · IANA tz).
const CAL_TZ_OPTIONS = [{
  label: 'PH — Manila',
  tz: 'Asia/Manila'
}, {
  label: 'TX — Texas · Central',
  tz: 'America/Chicago'
}, {
  label: 'CA — Pacific',
  tz: 'America/Los_Angeles'
}, {
  label: 'CO — Mountain',
  tz: 'America/Denver'
}, {
  label: 'NY — Eastern',
  tz: 'America/New_York'
}, {
  label: 'UK — London',
  tz: 'Europe/London'
}, {
  label: 'UAE — Dubai',
  tz: 'Asia/Dubai'
}, {
  label: 'IN — Kolkata',
  tz: 'Asia/Kolkata'
}, {
  label: 'SG — Singapore',
  tz: 'Asia/Singapore'
}, {
  label: 'JP — Tokyo',
  tz: 'Asia/Tokyo'
}, {
  label: 'AU — Sydney',
  tz: 'Australia/Sydney'
}];
const tzLabel = tz => {
  const o = CAL_TZ_OPTIONS.find(x => x.tz === tz);
  return o ? o.label : tzCity(tz);
};
const tzShort = tz => tzLabel(tz).split(' — ')[0];
const localTimeIn = z => {
  try {
    return new Date().toLocaleTimeString('en-US', {
      timeZone: z,
      hour: 'numeric',
      minute: '2-digit'
    });
  } catch (e) {
    return '';
  }
};
const PETS = [{
  k: 'dog',
  label: 'Dog',
  e: '🐶'
}, {
  k: 'cat',
  label: 'Cat',
  e: '🐱'
}, {
  k: 'bird',
  label: 'Bird',
  e: '🐦'
}, {
  k: 'fish',
  label: 'Fish',
  e: '🐠'
}, {
  k: 'rabbit',
  label: 'Rabbit',
  e: '🐰'
}, {
  k: 'hamster',
  label: 'Hamster',
  e: '🐹'
}, {
  k: 'turtle',
  label: 'Turtle',
  e: '🐢'
}, {
  k: 'reptile',
  label: 'Reptile',
  e: '🦎'
}, {
  k: 'horse',
  label: 'Horse',
  e: '🐴'
}];
const petLabel = k => {
  const p = PETS.find(x => x.k === k);
  return p ? p.e + ' ' + p.label : k;
};
const ACCESS_LABEL = {
  admin: 'Admin',
  operations: 'Operations',
  agent: 'Sales Agent',
  tc: 'Transaction Coordinator',
  pending: 'Pending'
};
const STATUS_LABEL = {
  active: 'Active',
  pending: 'Pending',
  disabled: 'Disabled'
};
// Access is a LIST of roles (Postgres text[]). Helpers are backward-compatible with old single-string values.
const toRoles = a => (Array.isArray(a) ? a : a ? [a] : []).filter(r => r && r !== 'pending');
const hasAdmin = a => toRoles(a).some(r => r === 'admin' || r === 'operations');
const accessLabel = a => {
  const r = toRoles(a);
  return r.length ? r.map(x => ACCESS_LABEL[x] || x).join(' · ') : 'Pending';
};
// Apps this user may open. null = everything (admins, or no role set).
// Otherwise a Set of app ids; 'more' + 'settings' are always available separately.
function allowedAppSet(a, cfg) {
  const roles = toRoles(a);
  if (!roles.length) return null; // no roles → all (fallback)
  if (roles.some(r => r === 'admin')) return null; // admins → all (operations is configurable)
  const set = new Set();
  ACCESS_APPS.forEach(app => {
    const appRoles = cfg && Array.isArray(cfg[app.id]) ? cfg[app.id] : DEFAULT_ACCESS[app.id] || [];
    if (roles.some(r => appRoles.includes(r))) set.add(app.id);
  });
  return set;
}

// Reads/writes the single-row app_access config (admins write; everyone reads).
const AccessDB = {
  client() {
    return window.SupabaseAuth?._client || null;
  },
  async load() {
    if (!this.client()) return null;
    const {
      data,
      error
    } = await this.client().from('app_access').select('config').eq('id', 1).maybeSingle();
    if (error) {
      console.error('[AccessDB] load:', error.message);
      return null;
    }
    return data && data.config || null;
  },
  async save(config) {
    if (!this.client()) return;
    const {
      error
    } = await this.client().from('app_access').upsert({
      id: 1,
      config,
      updated_at: new Date().toISOString()
    });
    if (error) {
      console.error('[AccessDB] save:', error.message);
      throw error;
    }
  }
};

// ─── Tasks ───────────────────────────────────────────────────────
const TASK_STATUS = [{
  id: 'todo',
  label: 'To Do',
  color: '#AD832F',
  bg: '#F3EBDA',
  border: '#E8D9BC'
},
// gold
{
  id: 'in_progress',
  label: 'In Progress',
  color: '#185FA5',
  bg: '#EEF3FB',
  border: '#B8D4F0'
},
// blue
{
  id: 'stuck',
  label: 'Stuck',
  color: '#9B1C1C',
  bg: '#FEE2E2',
  border: '#FBBCBC'
},
// red
{
  id: 'done',
  label: 'Completed',
  color: '#0F6E56',
  bg: '#E6F2EC',
  border: '#A0D9C4'
} // green
];
const TASK_PRIORITY = [{
  id: 'low',
  label: 'Low',
  color: '#CA9A04'
},
// yellow
{
  id: 'medium',
  label: 'Medium',
  color: '#E07B00'
},
// orange
{
  id: 'high',
  label: 'High',
  color: '#DC2626'
} // red
];
const TASK_RECUR = [{
  id: 'none',
  label: 'Does not repeat'
}, {
  id: 'daily',
  label: 'Daily'
}, {
  id: 'weekly',
  label: 'Weekly'
}, {
  id: 'monthly',
  label: 'Monthly'
}, {
  id: 'custom',
  label: 'Custom…'
}];
// Which fields carry over when a recurring task spawns its next instance.
const RECUR_COPY_FIELDS = [{
  id: 'description',
  label: 'Description'
}, {
  id: 'context',
  label: 'Context'
}, {
  id: 'priority',
  label: 'Priority'
}, {
  id: 'project',
  label: 'Project'
}, {
  id: 'people',
  label: 'Assignees & assigners'
}, {
  id: 'decision',
  label: 'Decision (question + options)'
}, {
  id: 'links',
  label: 'Working URL & email'
}];
const RECUR_COPY_DEFAULT = RECUR_COPY_FIELDS.map(f => f.id);
const statusLabel = s => (TASK_STATUS.find(x => x.id === s) || {}).label || s;
const statusColor = s => (TASK_STATUS.find(x => x.id === s) || {}).color || '#6B6B6B';
const statusBg = s => (TASK_STATUS.find(x => x.id === s) || {}).bg || '#EEEEEE';
const statusBorder = s => (TASK_STATUS.find(x => x.id === s) || {}).border || '#E4DFD4';
const priorityLabel = p => (TASK_PRIORITY.find(x => x.id === p) || {}).label || p;
const priorityColor = p => (TASK_PRIORITY.find(x => x.id === p) || {}).color || '#9B9380';
const recurLabel = r => (TASK_RECUR.find(x => x.id === r) || {}).label || 'Does not repeat';
const recurDesc = t => {
  if (!t || !t.recurrence || t.recurrence === 'none') return 'Does not repeat';
  if (t.recurrence === 'custom') {
    const n = t.recur_interval || 1;
    const u = t.recur_unit || 'week';
    return 'Every ' + n + ' ' + u + (n > 1 ? 's' : '');
  }
  return recurLabel(t.recurrence);
};
const PROJECT_STATUS = [{
  id: 'on_track',
  label: 'On track',
  color: '#0F6E56',
  bg: '#E6F2EC',
  bgD: 'rgba(15,110,86,.14)'
}, {
  id: 'at_risk',
  label: 'At risk',
  color: '#AD832F',
  bg: '#F3EBDA',
  bgD: 'rgba(173,131,47,.14)'
}, {
  id: 'blocked',
  label: 'Blocked',
  color: '#9B1C1C',
  bg: '#FEE2E2',
  bgD: 'rgba(155,28,28,.16)'
}];
const projStatusMeta = s => PROJECT_STATUS.find(x => x.id === s) || PROJECT_STATUS[0];

// Labels for the 3 record_types that share the ProjectsSurface/ProjectForm
// machinery. group_tag is repurposed per kind: Side (buyer/seller) for CTC
// files, Quarter (e.g. "Q3 2026") for Rocks — same field, different meaning,
// same "computed, not a new table" principle as everything else here.
const KIND_LABEL = {
  project: {
    plural: 'Projects',
    singular: 'Project',
    article: 'project',
    groupLabel: 'Group',
    groupPlaceholder: 'e.g. Q3 Rocks',
    namePlaceholder: 'e.g. AI Feature Rollout'
  },
  ctc_file: {
    plural: 'CTC Files',
    singular: 'CTC File',
    article: 'file',
    groupLabel: 'Side',
    groupPlaceholder: 'e.g. Buyer, Seller, Landlord',
    namePlaceholder: 'e.g. 5999 Ranch Rd 165'
  },
  rock: {
    plural: 'Rocks',
    singular: 'Rock',
    article: 'rock',
    groupLabel: 'Quarter',
    groupPlaceholder: 'e.g. Q3 2026',
    namePlaceholder: 'e.g. Close $12M in new brokerage volume'
  }
};
const kindLabel = kind => KIND_LABEL[kind] || KIND_LABEL.project;
// Which project kinds may link to a Zoho Projects project (plan: hidden-
// wiggling-lamport, extended 2026-08-14 to cover regular Projects like
// "Accountability", not just CTC files). Rocks stay excluded — a quarterly
// goal isn't shaped like a Zoho project the way a CTC file or a standing
// "Accountability"/role project is.
const ZOHO_SYNCABLE_KINDS = ['ctc_file', 'project'];
const TaskDB = {
  client() {
    return window.SupabaseAuth?._client || null;
  },
  async loadAll() {
    const c = this.client();
    if (!c) return {
      tasks: [],
      peopleByTask: {},
      projById: {},
      labelsByTask: {}
    };
    const [tRes, pRes, prRes, lRes] = await Promise.all([c.from('tasks').select('*').order('created_at', {
      ascending: false
    }), c.from('task_people').select('task_id,user_id,role'), c.from('projects').select('id,name,archived'), c.from('task_labels').select('task_id,user_id,label')]);
    const peopleByTask = {};
    (pRes.data || []).forEach(p => {
      (peopleByTask[p.task_id] = peopleByTask[p.task_id] || []).push(p);
    });
    const labelsByTask = {};
    (lRes.data || []).forEach(l => {
      (labelsByTask[l.task_id] = labelsByTask[l.task_id] || []).push(l);
    });
    // Archived projects (e.g. the App Masterplan roadmap) never surface in the
    // regular Tasks list — they're a separate admin-only surface (RoadmapDB).
    const archivedIds = new Set((prRes.data || []).filter(p => p.archived).map(p => p.id));
    const projById = {};
    (prRes.data || []).forEach(p => {
      if (!p.archived) projById[p.id] = p.name;
    });
    const tasks = (tRes.data || []).filter(t => !t.project_id || !archivedIds.has(t.project_id));
    return {
      tasks,
      peopleByTask,
      projById,
      labelsByTask
    };
  },
  // For permalinks (tasks.html#task/<id>) — a task can belong to any
  // project/CTC file/rock, so this fetches it directly rather than
  // requiring it be pre-loaded into whichever surface is currently open.
  async getById(id) {
    const c = this.client();
    if (!c || !id) return null;
    const {
      data
    } = await c.from('tasks').select('*').eq('id', id).single();
    return data || null;
  },
  async loadPeopleFor(id) {
    const c = this.client();
    if (!c) return [];
    const {
      data
    } = await c.from('task_people').select('task_id,user_id,role').eq('task_id', id);
    return data || [];
  },
  async findOrCreateProject(name, user) {
    const c = this.client();
    if (!c || !name || !name.trim()) return null;
    const nm = name.trim();
    const {
      data: ex
    } = await c.from('projects').select('id').ilike('name', nm).limit(1).maybeSingle();
    if (ex) return ex.id;
    const {
      data,
      error
    } = await c.from('projects').insert({
      name: nm,
      created_by: user?.id || null
    }).select('id').single();
    if (error) {
      console.error('[TaskDB] project:', error.message);
      return null;
    }
    return data.id;
  },
  async create(fields, people, user) {
    const c = this.client();
    if (!c) return null;
    const base = {
      title: fields.title,
      due_at: fields.due_at || null,
      project_id: fields.project_id || null,
      priority: fields.priority || 'medium',
      status: fields.status || 'todo',
      description: fields.description || null,
      context: fields.context || null,
      working_url: fields.working_url || null,
      email_link: fields.email_link || null,
      decision_question: fields.decision_question || null,
      recurrence: fields.recurrence || 'none',
      parent_task_id: fields.parent_task_id || null,
      created_by: user?.id || null
    };
    const wd = {
      weekly_priority: fields.weekly_priority || null,
      weekly_rank: fields.weekly_rank || null,
      daily_priority: fields.daily_priority || null,
      daily_rank: fields.daily_rank || null,
      decision_due_at: fields.decision_due_at || null,
      decision_due_has_time: fields.decision_due_has_time || null,
      recur_interval: fields.recur_interval || null,
      recur_unit: fields.recur_unit || null,
      recur_copy_fields: fields.recur_copy_fields || null
    };
    let res = await c.from('tasks').insert({
      ...base,
      ...wd
    }).select().single();
    if (res.error && /column|schema cache|PGRST204|42703/i.test((res.error.message || '') + (res.error.code || ''))) res = await c.from('tasks').insert(base).select().single();
    const {
      data,
      error
    } = res;
    if (error) {
      console.error('[TaskDB] create:', error.message);
      throw error;
    }
    await this.setPeople(data.id, people || {});
    await this.addActivity(data.id, 'system', fields.parent_task_id ? 'Subtask created' : 'Task created', user);
    this.syncToGoogleTasks(data, user);
    this.syncToZohoProjects(data, null, user);
    return data;
  },
  // Push to the caller's Google Tasks list if they've enabled auto-sync
  // (profiles.calendar_prefs.autoSyncTasks). Fire-and-forget, fails silently —
  // same fail-open pattern as the rest of the Google Calendar integration.
  async syncToGoogleTasks(task, user) {
    const c = this.client();
    if (!c || !user) return;
    try {
      const {
        data: prof
      } = await c.from('profiles').select('calendar_prefs').eq('id', user.id).single();
      if (!prof?.calendar_prefs?.autoSyncTasks) return;
      await callCalendar({
        action: 'create-task',
        task: {
          title: task.title,
          notes: task.description || undefined,
          due: task.due_at || undefined
        }
      });
    } catch (e) {}
  },
  // Push a task's synced fields (plan §2.1: title/description/due_at/
  // priority/status only) to its linked Zoho Projects project — but ONLY
  // when that project is a CTC file with sync explicitly turned on
  // (project.zoho_sync_enabled) and already linked to a real Zoho
  // project. Fire-and-forget like syncToGoogleTasks, called from BOTH
  // create and update (unlike the Google precedent, which is create-only —
  // Zoho Projects sync must be genuinely two-way). Failures are logged to
  // the task's own activity feed instead of vanishing silently, since this
  // touches live CTC files.
  async syncToZohoProjects(task, oldTask, user) {
    const c = this.client();
    if (!c || !task.project_id) return;
    try {
      const {
        data: proj
      } = await c.from('projects').select('record_type,zoho_sync_enabled,zoho_project_id,zoho_tasklist_id').eq('id', task.project_id).single();
      if (!proj || !ZOHO_SYNCABLE_KINDS.includes(proj.record_type) || !proj.zoho_sync_enabled || !proj.zoho_project_id) return;
      if (!task.zoho_task_id) {
        if (!proj.zoho_tasklist_id) {
          await this.addActivity(task.id, 'system', 'Zoho Projects sync skipped — this CTC file has no default tasklist configured yet.', user);
          return;
        }
        const {
          ok,
          data
        } = await callZohoProjects({
          action: 'create_task',
          project_id: proj.zoho_project_id,
          tasklist_id: proj.zoho_tasklist_id,
          title: task.title,
          description: task.description || null,
          due_at: task.due_at || null,
          priority: task.priority
        });
        if (!ok || !data?.task?.id) {
          await this.addActivity(task.id, 'system', 'Zoho Projects sync failed — will retry on next poll.', user);
          return;
        }
        await c.from('tasks').update({
          zoho_task_id: data.task.id,
          zoho_last_synced_at: new Date().toISOString(),
          zoho_last_modified_time: data.task.last_modified_time || null
        }).eq('id', task.id);
        return;
      }

      // Update — only send fields that actually changed (oldTask is null on
      // create, so this always sends everything the first time an existing
      // pre-sync task gets its zoho_task_id attached below).
      const changed = k => !oldTask || (oldTask[k] || null) !== (task[k] || null);
      const payload = {
        action: 'update_task',
        project_id: proj.zoho_project_id,
        task_id: task.zoho_task_id
      };
      let any = false;
      if (changed('title')) {
        payload.title = task.title;
        any = true;
      }
      if (changed('description')) {
        payload.description = task.description || null;
        any = true;
      }
      if (changed('due_at')) {
        payload.due_at = task.due_at || null;
        any = true;
      }
      if (changed('priority')) {
        payload.priority = task.priority;
        any = true;
      }
      if (changed('status')) {
        payload.status = task.status;
        any = true;
      }
      if (!any) return;
      const {
        ok,
        data
      } = await callZohoProjects(payload);
      if (!ok) {
        await this.addActivity(task.id, 'system', 'Zoho Projects sync failed — will retry on next poll.', user);
        return;
      }
      await c.from('tasks').update({
        zoho_last_synced_at: new Date().toISOString()
      }).eq('id', task.id);
    } catch (e) {/* fire-and-forget — a poll cycle will reconcile eventually */}
  },
  async update(id, oldTask, fields, user) {
    const c = this.client();
    if (!c) return;
    const patch = {
      ...fields,
      updated_at: new Date().toISOString()
    };
    if (fields.status === 'done' && oldTask.status !== 'done') patch.completed_at = new Date().toISOString();
    let {
      error
    } = await c.from('tasks').update(patch).eq('id', id);
    if (error && /column|schema cache|PGRST204|42703/i.test((error.message || '') + (error.code || ''))) {
      const p2 = {
        ...patch
      };
      delete p2.weekly_priority;
      delete p2.weekly_rank;
      delete p2.daily_priority;
      delete p2.daily_rank;
      delete p2.decision_due_at;
      delete p2.decision_due_has_time;
      delete p2.recur_interval;
      delete p2.recur_unit;
      delete p2.recur_copy_fields;
      delete p2.is_milestone;
      ({
        error
      } = await c.from('tasks').update(p2).eq('id', id));
    }
    if (error) {
      console.error('[TaskDB] update:', error.message);
      throw error;
    }
    const FL = {
      title: 'Title',
      due_at: 'Due date',
      project_id: 'Project',
      priority: 'Priority',
      status: 'Status',
      description: 'Description',
      context: 'Context',
      working_url: 'Working URL',
      email_link: 'Email link',
      decision_question: 'Decision question',
      decision_due_at: 'Decision due date',
      recurrence: 'Recurrence'
    };
    for (const k of Object.keys(fields)) {
      if (k === 'weekly_priority' || k === 'weekly_rank' || k === 'daily_priority' || k === 'daily_rank' || k === 'decision_due_has_time' || k === 'recur_interval' || k === 'recur_unit' || k === 'recur_copy_fields') continue;
      if ((oldTask[k] || null) === (fields[k] || null)) continue;
      let msg;
      if (k === 'status') msg = 'Status: ' + statusLabel(oldTask.status) + ' → ' + statusLabel(fields.status);else if (k === 'priority') msg = 'Priority: ' + priorityLabel(oldTask.priority) + ' → ' + priorityLabel(fields.priority);else if (k === 'recurrence') msg = 'Recurrence: ' + recurLabel(fields.recurrence);else if (k === 'is_milestone') msg = fields.is_milestone ? 'Marked as milestone' : 'Unmarked as milestone';else msg = (FL[k] || k) + ' updated';
      await this.addActivity(id, 'system', msg, user, k);
    }
    // Recurrence rule: completing a repeating task spawns the next occurrence.
    if (fields.status === 'done' && oldTask.status !== 'done' && oldTask.recurrence && oldTask.recurrence !== 'none') {
      await this.spawnRecurrence({
        ...oldTask,
        ...fields,
        id
      }, user);
    }
    this.syncToZohoProjects({
      ...oldTask,
      ...fields,
      id
    }, oldTask, user);
  },
  // Hard delete — clears child rows first (task_people/labels/activity/
  // decision options/assist/email links/links) since most of this schema
  // predates tracked migrations and cascade isn't guaranteed everywhere.
  // Refuses if the task still has subtasks rather than silently cascading
  // a whole subtree the user didn't ask to remove.
  async delete(id) {
    const c = this.client();
    if (!c) return {
      error: 'Not connected.'
    };
    const {
      data: subtasks
    } = await c.from('tasks').select('id').eq('parent_task_id', id).limit(1);
    if (subtasks && subtasks.length) return {
      error: 'This task has subtasks — delete those first.'
    };
    await Promise.all([c.from('task_people').delete().eq('task_id', id), c.from('task_labels').delete().eq('task_id', id), c.from('task_activity').delete().eq('task_id', id), c.from('task_decision_options').delete().eq('task_id', id), c.from('task_assist').delete().eq('task_id', id), c.from('task_email_links').delete().eq('task_id', id)]);
    await c.from('task_links').delete().or('predecessor_id.eq.' + id + ',successor_id.eq.' + id);
    const {
      error
    } = await c.from('tasks').delete().eq('id', id);
    if (error) {
      console.error('[TaskDB] delete:', error.message);
      return {
        error: error.message
      };
    }
    return {
      error: null
    };
  },
  // Spawn the next instance of a recurring task (due date advanced by the interval).
  async spawnRecurrence(task, user) {
    const c = this.client();
    if (!c) return;
    let nextDue = null;
    if (task.due_at) {
      const d = new Date(task.due_at);
      if (!isNaN(d)) {
        if (task.recurrence === 'daily') d.setDate(d.getDate() + 1);else if (task.recurrence === 'weekly') d.setDate(d.getDate() + 7);else if (task.recurrence === 'monthly') d.setMonth(d.getMonth() + 1);else if (task.recurrence === 'custom') {
          const n = task.recur_interval || 1;
          const u = task.recur_unit || 'week';
          if (u === 'day') d.setDate(d.getDate() + n);else if (u === 'week') d.setDate(d.getDate() + n * 7);else d.setMonth(d.getMonth() + n);
        }
        nextDue = d.toISOString();
      }
    }
    // Which fields carry over (null = legacy default: copy everything).
    const copy = Array.isArray(task.recur_copy_fields) && task.recur_copy_fields.length ? task.recur_copy_fields : RECUR_COPY_DEFAULT;
    const has = k => copy.indexOf(k) !== -1;
    const base = {
      title: task.title,
      due_at: nextDue,
      status: 'todo',
      recurrence: task.recurrence,
      recur_interval: task.recur_interval || null,
      recur_unit: task.recur_unit || null,
      recur_copy_fields: task.recur_copy_fields || null,
      project_id: has('project') ? task.project_id || null : null,
      priority: has('priority') ? task.priority || 'medium' : 'medium',
      description: has('description') ? task.description || null : null,
      context: has('context') ? task.context || null : null,
      working_url: has('links') ? task.working_url || null : null,
      email_link: has('links') ? task.email_link || null : null,
      decision_question: has('decision') ? task.decision_question || null : null,
      created_by: user?.id || null
    };
    let res = await c.from('tasks').insert(base).select().single();
    if (res.error && /column|schema cache|PGRST204|42703/i.test((res.error.message || '') + (res.error.code || ''))) {
      const b2 = {
        ...base
      };
      delete b2.recur_interval;
      delete b2.recur_unit;
      delete b2.recur_copy_fields;
      res = await c.from('tasks').insert(b2).select().single();
    }
    const {
      data,
      error
    } = res;
    if (error) {
      console.error('[TaskDB] spawnRecurrence:', error.message);
      return;
    }
    if (has('people')) {
      const {
        data: ppl
      } = await c.from('task_people').select('user_id,role').eq('task_id', task.id);
      if (ppl && ppl.length) await c.from('task_people').insert(ppl.map(p => ({
        task_id: data.id,
        user_id: p.user_id,
        role: p.role
      })));
    }
    if (has('decision')) {
      const {
        data: opts
      } = await c.from('task_decision_options').select('body,is_chosen,sort').eq('task_id', task.id);
      if (opts && opts.length) await c.from('task_decision_options').insert(opts.map(o => ({
        task_id: data.id,
        body: o.body,
        is_chosen: false,
        sort: o.sort
      })));
    }
    await this.addActivity(task.id, 'system', 'Recurring task completed — next instance created', user);
    await this.addActivity(data.id, 'system', 'Created from a recurring task', user);
    return data;
  },
  async setPeople(taskId, people) {
    // { assignee:[ids], assigner:[ids], decision_maker:[ids] }
    const c = this.client();
    if (!c) return;
    await c.from('task_people').delete().eq('task_id', taskId).in('role', ['assignee', 'assigner', 'decision_maker']);
    const rows = [];
    (people.assignee || []).forEach(uid => rows.push({
      task_id: taskId,
      user_id: uid,
      role: 'assignee'
    }));
    (people.assigner || []).forEach(uid => rows.push({
      task_id: taskId,
      user_id: uid,
      role: 'assigner'
    }));
    (people.decision_maker || []).forEach(uid => rows.push({
      task_id: taskId,
      user_id: uid,
      role: 'decision_maker'
    }));
    if (rows.length) {
      const {
        error
      } = await c.from('task_people').insert(rows);
      if (error) console.error('[TaskDB] setPeople:', error.message);
    }
  },
  // Per-user labels (each person keeps their own on a shared task).
  async loadLabels(taskId) {
    const c = this.client();
    if (!c) return [];
    const {
      data
    } = await c.from('task_labels').select('id,user_id,label,color').eq('task_id', taskId);
    return data || [];
  },
  async setLabels(taskId, userId, labels) {
    // labels = [string] — replaces THIS user's labels only
    const c = this.client();
    if (!c) return;
    await c.from('task_labels').delete().eq('task_id', taskId).eq('user_id', userId);
    const rows = (labels || []).map(l => (l || '').trim()).filter(Boolean).map(l => ({
      task_id: taskId,
      user_id: userId,
      label: l
    }));
    if (rows.length) {
      const {
        error
      } = await c.from('task_labels').insert(rows);
      if (error) console.error('[TaskDB] setLabels:', error.message);
    }
  },
  // Decision options (Option A / B / C … with one optionally marked chosen).
  async loadDecisionOptions(taskId) {
    const c = this.client();
    if (!c) return [];
    const {
      data
    } = await c.from('task_decision_options').select('*').eq('task_id', taskId).order('sort', {
      ascending: true
    });
    return data || [];
  },
  async setDecisionOptions(taskId, options) {
    // options = [{ body, is_chosen }]
    const c = this.client();
    if (!c) return;
    await c.from('task_decision_options').delete().eq('task_id', taskId);
    const rows = (options || []).map((o, i) => ({
      task_id: taskId,
      body: (o.body || '').trim(),
      is_chosen: !!o.is_chosen,
      sort: i
    })).filter(r => r.body);
    if (rows.length) {
      const {
        error
      } = await c.from('task_decision_options').insert(rows);
      if (error) console.error('[TaskDB] setDecisionOptions:', error.message);
    }
  },
  // Subtasks (tasks with a parent — also shown in the main list, with a "↳ parent" caption).
  async loadSubtasks(parentId) {
    const c = this.client();
    if (!c) return [];
    const {
      data
    } = await c.from('tasks').select('*').eq('parent_task_id', parentId).order('created_at', {
      ascending: true
    });
    return data || [];
  },
  async createSubtask(parentId, title, user) {
    return this.create({
      title: title.trim(),
      status: 'todo',
      priority: 'medium',
      parent_task_id: parentId
    }, {}, user);
  },
  // Predecessor / Successor links. predecessor_id must come before successor_id.
  async loadLinks(taskId) {
    const c = this.client();
    if (!c) return {
      predecessors: [],
      successors: []
    };
    const {
      data,
      error
    } = await c.from('task_links').select('id,predecessor_id,successor_id').or('predecessor_id.eq.' + taskId + ',successor_id.eq.' + taskId);
    if (error) {
      console.error('[TaskDB] loadLinks:', error.message);
      return {
        predecessors: [],
        successors: []
      };
    }
    const rows = data || [];
    return {
      predecessors: rows.filter(r => r.successor_id === taskId),
      // tasks that must come before this one
      successors: rows.filter(r => r.predecessor_id === taskId) // tasks that come after this one
    };
  },
  async addLink(predecessorId, successorId) {
    const c = this.client();
    if (!c) return;
    const {
      error
    } = await c.from('task_links').insert({
      predecessor_id: predecessorId,
      successor_id: successorId
    });
    if (error && !/duplicate|unique/i.test(error.message || '')) console.error('[TaskDB] addLink:', error.message);
  },
  async removeLink(id) {
    const c = this.client();
    if (!c) return;
    await c.from('task_links').delete().eq('id', id);
  },
  // Label management — a user's distinct label names across all their tasks.
  async myLabelNames(userId) {
    const c = this.client();
    if (!c) return [];
    const {
      data
    } = await c.from('task_labels').select('label').eq('user_id', userId);
    return Array.from(new Set((data || []).map(r => r.label))).sort((a, b) => a.localeCompare(b));
  },
  async renameLabel(userId, oldLabel, newLabel) {
    const c = this.client();
    if (!c || !newLabel.trim()) return;
    const {
      error
    } = await c.from('task_labels').update({
      label: newLabel.trim()
    }).eq('user_id', userId).eq('label', oldLabel);
    if (error) console.error('[TaskDB] renameLabel:', error.message);
  },
  async deleteLabel(userId, label) {
    const c = this.client();
    if (!c) return;
    const {
      error
    } = await c.from('task_labels').delete().eq('user_id', userId).eq('label', label);
    if (error) console.error('[TaskDB] deleteLabel:', error.message);
  },
  // Projects
  async loadProjects() {
    const c = this.client();
    if (!c) return [];
    const {
      data
    } = await c.from('projects').select('id,name').eq('archived', false).order('name', {
      ascending: true
    });
    return data || [];
  },
  async loadActivity(taskId) {
    const c = this.client();
    if (!c) return [];
    const {
      data,
      error
    } = await c.from('task_activity').select('*').eq('task_id', taskId).order('created_at', {
      ascending: true
    });
    if (error) {
      console.error('[TaskDB] activity:', error.message);
      return [];
    }
    return data || [];
  },
  async addActivity(taskId, kind, content, user, field) {
    const c = this.client();
    if (!c) return null;
    const {
      data,
      error
    } = await c.from('task_activity').insert({
      task_id: taskId,
      kind,
      content,
      field: field || null,
      author_id: user?.id || null,
      author_name: user?.user_metadata?.full_name || user?.email || null
    }).select().single();
    if (error) {
      console.error('[TaskDB] addActivity:', error.message);
      return null;
    }
    return data;
  },
  // Task Thread — private-but-synced AI Assist (owner-only). Log updates stay in task_activity.
  async loadAssist(taskId, user) {
    const c = this.client();
    if (!c || !user) return [];
    const {
      data,
      error
    } = await c.from('task_assist').select('*').eq('task_id', taskId).eq('user_id', user.id).order('created_at', {
      ascending: true
    });
    if (error) {
      console.error('[TaskDB] loadAssist:', error.message);
      return [];
    }
    return data || [];
  },
  async addAssist(taskId, role, content, user) {
    const c = this.client();
    if (!c || !user) return null;
    const {
      data,
      error
    } = await c.from('task_assist').insert({
      task_id: taskId,
      user_id: user.id,
      role,
      content
    }).select().single();
    if (error) {
      console.error('[TaskDB] addAssist:', error.message);
      return null;
    }
    return data;
  },
  async updateAssistContent(id, content) {
    const c = this.client();
    if (!c) return;
    await c.from('task_assist').update({
      content
    }).eq('id', id);
  },
  async publishAssist(rowItem, taskId, user) {
    const c = this.client();
    if (!c) return;
    const act = await this.addActivity(taskId, 'ai', rowItem.content, user);
    await c.from('task_assist').update({
      published: true,
      published_activity_id: act?.id || null
    }).eq('id', rowItem.id);
    return act;
  },
  async unpublishAssist(rowItem) {
    const c = this.client();
    if (!c) return;
    if (rowItem.published_activity_id) await c.from('task_activity').delete().eq('id', rowItem.published_activity_id);
    await c.from('task_assist').update({
      published: false,
      published_activity_id: null
    }).eq('id', rowItem.id);
  },
  // Write the AI thread summary into context WITHOUT logging an activity (avoids feed noise).
  async setThreadSummary(taskId, text) {
    const c = this.client();
    if (!c) return;
    await c.from('tasks').update({
      context: text,
      updated_at: new Date().toISOString()
    }).eq('id', taskId);
  },
  async updateActivityContent(id, content) {
    const c = this.client();
    if (!c) return;
    await c.from('task_activity').update({
      content
    }).eq('id', id);
  }
};

// ─── TaskEmailDB — linked Gmail threads (task_email_links table) ────
// Separate from `tasks.email_link` (the older single-URL text field, still
// used by TaskForm/TaskDetail) — this is the richer one-task-to-many-threads
// model from TMG-Toolbar-and-Email-Brief_1.md §2.1. A read-only mirror of
// Gmail: removing a row here only clears the link, never touches the email
// itself [brief §2.6].
const TaskEmailDB = {
  client() {
    return window.SupabaseAuth?._client || null;
  },
  // { [taskId]: [link, ...] } for every task at once — one query for the whole
  // list view's subject-icon pass, instead of N queries per row.
  async loadAllByTask() {
    const c = this.client();
    if (!c) return {};
    const {
      data
    } = await c.from('task_email_links').select('*').order('created_at', {
      ascending: true
    });
    const byTask = {};
    (data || []).forEach(l => {
      (byTask[l.task_id] = byTask[l.task_id] || []).push(l);
    });
    return byTask;
  },
  async listForTask(taskId) {
    const c = this.client();
    if (!c || !taskId) return [];
    const {
      data
    } = await c.from('task_email_links').select('*').eq('task_id', taskId).order('created_at', {
      ascending: true
    });
    return data || [];
  },
  // thread = { id, permalink, from, subject, snippet, date, messageId } from a
  // gmail_threads/gmail_thread row (see callCalendar). Upsert-by-nature via the
  // table's (task_id, thread_id) unique constraint — re-attaching an
  // already-linked thread is a no-op, not a duplicate [brief §2.2].
  async attach(taskId, thread, user, autoLinked) {
    const c = this.client();
    if (!c || !taskId || !thread?.id) return null;
    const {
      data,
      error
    } = await c.from('task_email_links').insert({
      task_id: taskId,
      thread_id: thread.id,
      message_id: thread.messageId || null,
      permalink: thread.permalink || 'https://mail.google.com/mail/u/0/#all/' + thread.id,
      from_addr: thread.from || null,
      subject: thread.subject || null,
      snippet: thread.snippet || null,
      email_date: thread.date ? new Date(thread.date).toISOString() : null,
      auto_linked: !!autoLinked,
      created_by: user?.id || null
    }).select().single();
    if (error) {
      // Unique-violation = already linked to this task — treat as success (matches
      // "attach is idempotent" — see comment above).
      if (/duplicate key|unique/i.test(error.message || '')) return (await this.listForTask(taskId)).find(l => l.thread_id === thread.id) || null;
      console.error('[TaskEmailDB] attach:', error.message);
      return null;
    }
    return data;
  },
  async remove(linkId) {
    const c = this.client();
    if (!c || !linkId) return;
    await c.from('task_email_links').delete().eq('id', linkId);
  }
};

// ─── ProjectDB — the Tasks → Projects / CTC Files surfaces ──────────
// Projects live in the same `projects` table (record_type tells them apart).
// Milestones are NOT stored here: a milestone is a task with is_milestone=true
// whose project_id points at the project, so progress / next-milestone are
// computed from tasks. See projects-view.sql + task-milestone-flag.sql.
const ProjectDB = {
  client() {
    return window.SupabaseAuth?._client || null;
  },
  async loadFull(recordType) {
    const c = this.client();
    if (!c) return [];
    const [pRes, tRes, pplRes] = await Promise.all([c.from('projects').select('*').eq('archived', false).order('created_at', {
      ascending: false
    }), c.from('tasks').select('*'),
    // full rows — a task opened from inside a project needs every field TaskDetail/TaskForm can show, not just the summary columns
    c.from('task_people').select('task_id,user_id,role')]);
    const projects = (pRes.data || []).filter(p => (p.record_type || 'project') === recordType);
    const peopleByTask = {};
    (pplRes.data || []).forEach(p => {
      (peopleByTask[p.task_id] = peopleByTask[p.task_id] || []).push(p);
    });
    const tasksByProj = {};
    (tRes.data || []).forEach(t => {
      if (t.project_id) (tasksByProj[t.project_id] = tasksByProj[t.project_id] || []).push({
        ...t,
        _people: peopleByTask[t.id] || []
      });
    });
    const dueCmp = (a, b) => {
      if (!a.due_at && !b.due_at) return 0;
      if (!a.due_at) return 1;
      if (!b.due_at) return -1;
      return new Date(a.due_at) - new Date(b.due_at);
    };
    return projects.map(p => {
      // _projectName: TaskForm reads this to pre-fill the Project field when
      // editing a task opened from inside its own container — without it the
      // field shows blank and saving would detach the task (project_id: null).
      const ts = (tasksByProj[p.id] || []).map(t => ({
        ...t,
        _projectName: p.name
      }));
      const milestones = ts.filter(t => t.is_milestone).slice().sort(dueCmp);
      const doneMs = milestones.filter(m => m.status === 'done').length;
      const totalMs = milestones.length;
      const nextMs = milestones.find(m => m.status !== 'done') || null;
      const openTasks = ts.filter(t => t.status !== 'done').slice().sort(dueCmp);
      const collaborators = Array.from(new Set(ts.flatMap(t => (peopleByTask[t.id] || []).filter(x => x.role === 'assignee').map(x => x.user_id))));
      return {
        ...p,
        _tasks: ts,
        _milestones: milestones,
        _doneMs: doneMs,
        _totalMs: totalMs,
        _nextMs: nextMs,
        _progress: totalMs ? Math.round(doneMs / totalMs * 100) : 0,
        _openTasks: openTasks,
        _taskCount: ts.length,
        _collaborators: collaborators
      };
    });
  },
  async create(fields, user) {
    const c = this.client();
    if (!c) return null;
    const base = {
      name: fields.name,
      record_type: fields.record_type || 'project',
      status: fields.status || 'on_track',
      outcome: fields.outcome || null,
      group_tag: fields.group_tag || null,
      owner_id: fields.owner_id || null,
      started_at: fields.started_at || null,
      target_date: fields.target_date || null,
      created_by: user?.id || null
    };
    let res = await c.from('projects').insert(base).select().single();
    if (res.error && /column|schema cache|PGRST204|42703/i.test((res.error.message || '') + (res.error.code || ''))) {
      res = await c.from('projects').insert({
        name: base.name,
        created_by: base.created_by
      }).select().single();
    }
    if (res.error) {
      console.error('[ProjectDB] create:', res.error.message);
      throw res.error;
    }
    return res.data;
  },
  async update(id, patch) {
    const c = this.client();
    if (!c) return;
    let {
      error
    } = await c.from('projects').update(patch).eq('id', id);
    if (error && /column|schema cache|PGRST204|42703/i.test((error.message || '') + (error.code || ''))) {
      const p2 = {
        ...patch
      };
      ['record_type', 'status', 'outcome', 'group_tag', 'owner_id', 'started_at', 'target_date'].forEach(k => delete p2[k]);
      if (Object.keys(p2).length) ({
        error
      } = await c.from('projects').update(p2).eq('id', id));
    }
    if (error) console.error('[ProjectDB] update:', error.message);else this.syncToZoho(id, patch);
  },
  // Push project-level edits to a linked Zoho Projects project — name and
  // dates only (plan §2.1). TMG's on_track/at_risk/blocked status is
  // DELIBERATELY never sent — the two vocabularies don't map cleanly and a
  // TC's own judgment call on project health shouldn't get silently
  // relabeled by Zoho's Active/On Hold/Completed states.
  async syncToZoho(id, patch) {
    const only = ['name', 'started_at', 'target_date'].filter(k => k in patch);
    if (!only.length) return;
    const c = this.client();
    if (!c) return;
    try {
      const {
        data: proj
      } = await c.from('projects').select('record_type,zoho_sync_enabled,zoho_project_id').eq('id', id).single();
      if (!proj || !ZOHO_SYNCABLE_KINDS.includes(proj.record_type) || !proj.zoho_sync_enabled || !proj.zoho_project_id) return;
      const payload = {
        action: 'update_project',
        project_id: proj.zoho_project_id
      };
      if ('name' in patch) payload.name = patch.name;
      if ('started_at' in patch) payload.start_date = patch.started_at;
      if ('target_date' in patch) payload.end_date = patch.target_date;
      await callZohoProjects(payload);
    } catch (e) {/* fire-and-forget — a poll cycle will reconcile eventually */}
  },
  async archive(id) {
    const c = this.client();
    if (!c) return;
    await c.from('projects').update({
      archived: true
    }).eq('id', id);
  },
  // Lightweight sidebar list — id/name/record_type + a per-item task count
  // (from a minimal tasks query, not the full loadFull() join) for the
  // 3-level sidebar (section -> "All X" -> each named project/file).
  async sidebarList() {
    const c = this.client();
    if (!c) return [];
    const [pRes, tRes] = await Promise.all([c.from('projects').select('id,name,record_type').eq('archived', false).order('name', {
      ascending: true
    }), c.from('tasks').select('project_id')]);
    const counts = {};
    (tRes.data || []).forEach(t => {
      if (t.project_id) counts[t.project_id] = (counts[t.project_id] || 0) + 1;
    });
    return (pRes.data || []).map(p => ({
      id: p.id,
      name: p.name,
      record_type: p.record_type || 'project',
      taskCount: counts[p.id] || 0
    }));
  }
};

// Turn an AI "ADD" payload (from a Task pill's ACTION block) into a real task.
// Names are matched to teammates; unmatched names are skipped (left blank).
async function createTaskFromAI(payload, user) {
  if (!payload) return null;
  const roster = await ProfileDB.loadAll();
  const nameToId = {};
  (roster || []).forEach(p => {
    const full = (((p.first_name || '') + ' ' + (p.last_name || '')).trim() || p.email || '').toLowerCase();
    const first = (p.first_name || '').toLowerCase();
    if (full) nameToId[full] = p.id;
    if (first && !nameToId[first]) nameToId[first] = p.id;
  });
  const matchIds = arr => (Array.isArray(arr) ? arr : arr ? [arr] : []).map(n => nameToId[(n || '').toLowerCase().trim()]).filter(Boolean);
  let due_at = null;
  if (payload.dueDate && /^\d{4}-\d{2}-\d{2}$/.test(payload.dueDate)) {
    const t = payload.dueTime && /^\d{1,2}:\d{2}$/.test(payload.dueTime) ? payload.dueTime : '09:00';
    const d = new Date(payload.dueDate + 'T' + (t.length === 4 ? '0' + t : t));
    if (!isNaN(d)) due_at = d.toISOString();
  }
  const project_id = payload.project ? await TaskDB.findOrCreateProject(payload.project, user) : null;
  const fields = {
    title: (payload.title || 'Untitled task').trim(),
    due_at,
    project_id,
    priority: ['low', 'medium', 'high'].includes(payload.priority) ? payload.priority : 'medium',
    status: ['todo', 'in_progress', 'stuck', 'done'].includes(payload.status) ? payload.status : 'todo',
    description: payload.description || payload.summary || null,
    context: payload.context || null,
    working_url: payload.workingUrl || null,
    email_link: payload.emailLink || null,
    decision_question: payload.decisionQuestion || null,
    recurrence: 'none'
  };
  const people = {
    assignee: matchIds(payload.assignees),
    assigner: matchIds(payload.assigners),
    decision_maker: matchIds(payload.decisionMakers || payload.decisionMaker)
  };
  const created = await TaskDB.create(fields, people, user);
  if (created && created.id) {
    const opts = (payload.decisionOptions || []).map(o => typeof o === 'string' ? {
      body: o,
      is_chosen: false
    } : {
      body: o && o.body || '',
      is_chosen: !!(o && o.is_chosen)
    });
    if (opts.length) await TaskDB.setDecisionOptions(created.id, opts);
    await TaskDB.addActivity(created.id, 'ai', 'Created from Work Mode (AI)', user);
  }
  return created;
}
const CARD = {
  background: C.surface,
  boxShadow: '0 2px 8px rgba(0,26,74,0.07), 0 1px 2px rgba(0,26,74,0.04)',
  borderRadius: 14,
  padding: 16,
  marginBottom: 14
};

// App-wide rule: Phone values become tel: links, Email values become mailto: links.
// Use contactLink(label, value) wherever a Phone/Email value is displayed.
const telHref = v => 'tel:' + String(v).replace(/[^\d+]/g, '');
const mailHref = v => 'mailto:' + String(v).trim();
function contactLink(label, value) {
  if (!value) return value;
  if (label === 'Phone') return /*#__PURE__*/React.createElement("a", {
    href: telHref(value),
    style: {
      color: 'inherit',
      textDecoration: 'none'
    }
  }, value);
  if (label === 'Email') return /*#__PURE__*/React.createElement("a", {
    href: mailHref(value),
    style: {
      color: 'inherit',
      textDecoration: 'none'
    }
  }, value);
  return value;
}

// Builds a Gmail "compose" link with a ready-to-send welcome email (TMG runs on Google Workspace).
// Used for one-click approval notifications from the Admin console.
function gmailComposeUrl(u) {
  const first = (u.first_name || '').trim();
  const APP_URL = 'https://app.themorshedgroup.com/';
  const subject = "You're in — your TMG App account is ready";
  const body = [first ? 'Hi ' + first + ',' : 'Hi,', '', 'Good news — your TMG App account is now active.', '', 'Open the app and sign in here:', APP_URL, '', 'Tap "Continue with TMG Google" and use your @themorshedgroup.com account.', '', '— The Morshed Group'].join('\n');
  return 'https://mail.google.com/mail/?view=cm&fs=1&to=' + encodeURIComponent(u.email || '') + '&su=' + encodeURIComponent(subject) + '&body=' + encodeURIComponent(body);
}

// Admin-only user-management console (under the More tab). Replaces editing in Supabase.
// Hoisted to a STABLE top-level component so it isn't recreated on every
// AdminUsers re-render. (When it lived inside AdminUsers, any parent
// re-render gave it a new function identity → React remounted it → all the
// field state reset to the saved values, so edits appeared to be "lost".)

// Claude pricing — USD per 1,000,000 tokens, matched by model-id substring.
// Update these when Anthropic changes prices; historical rows re-cost on view.
const PRICING = {
  'claude-3-5-haiku': {
    in: 0.80,
    out: 4.00
  },
  'claude-3-5-sonnet': {
    in: 3.00,
    out: 15.00
  },
  'claude-3-haiku': {
    in: 0.25,
    out: 1.25
  },
  'claude-3-opus': {
    in: 15.00,
    out: 75.00
  },
  'claude-haiku-4': {
    in: 1.00,
    out: 5.00
  },
  'claude-sonnet-4': {
    in: 3.00,
    out: 15.00
  },
  'claude-opus-4': {
    in: 15.00,
    out: 75.00
  },
  // OpenAI image generation is billed per-image, not per-token — this is a rough
  // $/1M-token-equivalent so it slots into the same cost math (see generate-image edge fn).
  'gpt-image-1.5': {
    in: 5.00,
    out: 32.00
  }
};
const priceFor = model => {
  const m = model || '';
  const k = Object.keys(PRICING).find(x => m.includes(x));
  return PRICING[k] || PRICING['claude-3-5-sonnet'];
};
const rowCost = r => {
  const p = priceFor(r.model);
  return (Number(r.input_tokens) || 0) / 1e6 * p.in + (Number(r.output_tokens) || 0) / 1e6 * p.out;
};
const fmtTok = n => {
  n = Number(n) || 0;
  return n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n);
};
const fmtUsd = n => '$' + (Number(n) || 0).toFixed(2);

// Admin-only AI usage + estimated cost per user. Reads the usage_summary RPC.

// ─── Work Mode builder (admin) ───────────────────────────────────

// Task pill: the AI instruction (the "command") lives here, inside the pill's config.

// ─── Work Mode runtime sheets (form / guided steps) ──────────────

// ─── Enter KPI inline cards (render inside the chat thread) ──────
// Multi-select KPI chips for one person. selected = array of KPI_OPTIONS strings.

// The expanding inline form (form path). Starts compact (date, CTC, Person 1); grows via the buttons.

// The review step. Each person is matched against Zoho Contacts here; submit is blocked
// until every person is linked to a contact (picked from suggestions) or a new one is created.

// Wrapper card that hosts the Enter KPI flow inline in the chat thread. flow = { step, payload }.

// Admin screen (admin/operations) — separate from Settings, opened via the More menu.
// Admin: per-tool role access. Left = tool, right = a roles multiselect dropdown.

function SettingsTab({
  historySide,
  setHistorySide,
  dark,
  setDark,
  fontScale,
  setFontScale,
  embedded
}) {
  const sideBtn = (val, label, icon) => {
    const on = historySide === val;
    return /*#__PURE__*/React.createElement("button", {
      onClick: () => setHistorySide(val),
      style: {
        flex: 1,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
        padding: '10px',
        borderRadius: 10,
        cursor: 'pointer',
        border: `1px solid ${on ? C.navy : C.border}`,
        background: on ? C.navy : C.surface,
        color: on ? '#fff' : C.textSecondary,
        fontFamily: C.fontSans,
        fontSize: '0.85rem',
        fontWeight: on ? 600 : 500
      }
    }, /*#__PURE__*/React.createElement("i", {
      className: `ti ${icon}`,
      style: {
        fontSize: 16
      }
    }), label);
  };
  return /*#__PURE__*/React.createElement("div", {
    style: embedded ? {
      padding: '0 16px 16px'
    } : {
      padding: '20px 16px 100px',
      height: '100%',
      overflowY: 'auto'
    }
  }, !embedded && /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: '1.5rem',
      fontWeight: 400,
      fontStyle: 'italic',
      color: C.navy,
      marginBottom: 24,
      fontFamily: C.fontDisplay
    }
  }, "Settings"), /*#__PURE__*/React.createElement("div", {
    style: CARD
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: '0.72rem',
      fontWeight: 600,
      color: C.navy,
      letterSpacing: '0.08em',
      textTransform: 'uppercase',
      fontFamily: C.fontSans,
      marginBottom: 14
    }
  }, "Appearance"), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 10,
      marginBottom: 18
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: '0.85rem',
      color: C.textPrimary,
      fontFamily: C.fontSans
    }
  }, "Dark mode"), /*#__PURE__*/React.createElement("button", {
    onClick: () => setDark(d => !d),
    title: dark ? 'Switch to light mode' : 'Switch to dark mode',
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 6,
      padding: '6px 12px',
      borderRadius: 8,
      border: `1px solid ${C.border}`,
      background: C.surface,
      color: C.textSecondary,
      cursor: 'pointer',
      fontFamily: C.fontSans,
      fontSize: '0.8rem',
      fontWeight: 500,
      flexShrink: 0
    }
  }, /*#__PURE__*/React.createElement("i", {
    className: `ti ${dark ? 'ti-sun' : 'ti-moon'}`,
    style: {
      fontSize: 15
    }
  }), dark ? 'Light' : 'Dark')), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      marginBottom: 9
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: '0.85rem',
      color: C.textPrimary,
      fontFamily: C.fontSans
    }
  }, "Text size"), /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: '0.72rem',
      color: C.textMuted,
      fontFamily: C.fontSans,
      fontWeight: 600
    }
  }, Math.round((fontScale || 1) * 100), "%")), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 11
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 13,
      color: C.textMuted,
      fontFamily: C.fontSans,
      fontWeight: 700,
      flexShrink: 0
    }
  }, "A"), /*#__PURE__*/React.createElement("input", {
    type: "range",
    min: "0.85",
    max: "1.35",
    step: "0.05",
    value: fontScale || 1,
    onChange: e => setFontScale(parseFloat(e.target.value)),
    style: {
      flex: 1,
      accentColor: C.navy,
      cursor: 'pointer'
    }
  }), /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 22,
      color: C.textMuted,
      fontFamily: C.fontSans,
      fontWeight: 700,
      flexShrink: 0
    }
  }, "A")), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: '0.72rem',
      color: C.textMuted,
      marginTop: 9,
      lineHeight: 1.5,
      fontFamily: C.fontSans
    }
  }, "Adjusts the size of everything in the app.", (fontScale || 1) !== 1 && /*#__PURE__*/React.createElement(React.Fragment, null, " \xB7 ", /*#__PURE__*/React.createElement("button", {
    onClick: () => setFontScale(1),
    style: {
      background: 'none',
      border: 'none',
      padding: 0,
      color: C.gold,
      cursor: 'pointer',
      fontFamily: C.fontSans,
      fontSize: '0.72rem',
      fontWeight: 600
    }
  }, "Reset to 100%")))), /*#__PURE__*/React.createElement("div", {
    style: CARD
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: '0.72rem',
      fontWeight: 600,
      color: C.navy,
      letterSpacing: '0.08em',
      textTransform: 'uppercase',
      fontFamily: C.fontSans,
      marginBottom: 6
    }
  }, "Chat History"), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: '0.78rem',
      color: C.textSecondary,
      marginBottom: 12,
      lineHeight: 1.5
    }
  }, "Which side the chat history panel opens from."), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 8
    }
  }, sideBtn('left', 'Left', 'ti-layout-sidebar-left-expand'), sideBtn('right', 'Right', 'ti-layout-sidebar-right-expand'))), /*#__PURE__*/React.createElement("button", {
    onClick: () => window.SupabaseAuth.signOut(),
    style: {
      width: '100%',
      padding: 12,
      background: 'none',
      border: `1px solid ${C.red}`,
      borderRadius: 12,
      color: C.red,
      fontSize: '15px',
      cursor: 'pointer',
      fontWeight: 500,
      fontFamily: C.fontSans
    }
  }, "Sign out"));
}

// ─── Shared Drives (opened from the More menu) ───────────────────
// ─── Company Directory + Profile (opened from the More menu) ─────
// HYBRID source: the directory reads LIVE from the Supabase `profiles`
// table (ProfileDB.loadAll) and merges it OVER this curated seed.
//  • Curated photo / title / badge win for display.
//  • Live data fills the per-person FIELDS (employee ID, reports-to,
//    phone, email, location, timezone, pets) automatically once a
//    person signs up or is set in Manage Users — no code edits needed.
//  • People not yet signed up still show from this seed.
//  • New sign-ups not in the seed are appended (active accounts only).
// The website headshots are the curated `photo`; clear a person's
// `photo` to fall back to their account avatar. See buildRoster() below.
// People permanently excluded from the directory + any future roster,
// even if they sign up later (matched on lowercased full name).
const DIRECTORY_EXCLUDE = ['cassandra clemons', 'cassie clemons'];
const TEAM = [{
  id: 'tarek',
  name: 'Tarek Morshed',
  title: 'Chief Realty Officer',
  photo: 'https://themorshedgroup.com/wp-content/uploads/2023/01/tarek-morshed-headshot.jpg',
  badge: {
    label: 'Principal',
    lightBg: '#001A4A',
    lightFg: '#C9A45A',
    darkBg: '#C9A45A',
    darkFg: '#001A4A'
  },
  employeeId: '',
  reportsTo: '',
  phone: '',
  email: '',
  location: '',
  timezone: '',
  pets: ''
}, {
  id: 'symon',
  name: 'Symon Yongco',
  title: 'Operations Manager',
  photo: 'https://themorshedgroup.com/wp-content/uploads/2025/01/Hidenori-Symon-Yongco-headshot.jpg',
  badge: {
    label: 'Admin',
    lightBg: '#F3EBDA',
    lightFg: '#AD832F',
    darkBg: 'rgba(173,131,47,0.2)',
    darkFg: '#C9A45A'
  },
  employeeId: 'TMG-03',
  reportsTo: '',
  phone: '(512) 643-6688',
  email: 'manager@themorshedgroup.com',
  location: 'Manila, Philippines',
  timezone: 'Asia/Manila',
  pets: '🐶 Dog'
}, {
  id: 'brad',
  name: 'Brad Baker',
  title: 'Real Estate Professional',
  photo: 'https://themorshedgroup.com/wp-content/uploads/2023/01/Brad-Baker-headshot-1.jpg',
  badge: null,
  employeeId: '',
  reportsTo: '',
  phone: '',
  email: '',
  location: '',
  timezone: '',
  pets: ''
}, {
  id: 'brett',
  name: 'Brett Silverman',
  title: 'Commercial Advisor',
  photo: 'https://themorshedgroup.com/wp-content/uploads/2025/09/Brett-Silverman-headshot.jpg',
  badge: null,
  employeeId: '',
  reportsTo: '',
  phone: '',
  email: '',
  location: '',
  timezone: '',
  pets: ''
}, {
  id: 'kyle',
  name: 'Kyle Baird',
  title: 'Real Estate Professional',
  photo: 'https://themorshedgroup.com/wp-content/uploads/2026/02/Kyle-Baird-headshot.jpg',
  badge: null,
  employeeId: '',
  reportsTo: '',
  phone: '',
  email: '',
  location: '',
  timezone: '',
  pets: ''
}, {
  id: 'alexandra',
  name: 'Alexandra Machado',
  title: 'Transaction Coordinator',
  photo: 'https://themorshedgroup.com/wp-content/uploads/2025/04/Alexandra-Machado-headshot.jpg',
  badge: null,
  employeeId: '',
  reportsTo: '',
  phone: '',
  email: '',
  location: '',
  timezone: '',
  pets: ''
}, {
  id: 'luciana',
  name: 'Luciana Pilco',
  title: 'Executive Assistant',
  photo: 'https://themorshedgroup.com/wp-content/uploads/2026/02/Luciana-Pilco-headshot.jpg',
  badge: null,
  employeeId: '',
  reportsTo: '',
  phone: '',
  email: '',
  location: '',
  timezone: '',
  pets: ''
}];

// Avatar with an initials fallback when no photo/account-avatar exists.

// Merge live Supabase profiles OVER the curated TEAM seed (see note above).
function buildRoster(profiles) {
  profiles = profiles || [];
  const fullName = p => ((p.first_name || '') + ' ' + (p.last_name || '')).trim();
  const petsText = v => Array.isArray(v) ? v.map(petLabel).join('  ') : v || '';
  const locationText = p => {
    if (!p) return '';
    const c = COUNTRIES.find(x => x.c === p.country);
    const cn = c ? c.n : p.country || '';
    const city = p.timezone ? tzCity(p.timezone) : '';
    return [city, cn].filter(Boolean).join(', ');
  };
  const byId = {},
    byName = {},
    byEmail = {};
  profiles.forEach(p => {
    byId[p.id] = p;
    const nm = fullName(p).toLowerCase();
    if (nm) byName[nm] = p;
    if (p.email) byEmail[p.email.toLowerCase()] = p;
  });
  const reportsName = id => {
    const m = id ? byId[id] : null;
    return m ? fullName(m) || m.email || '' : '';
  };
  const used = new Set();

  // Curated seed (fixed order), each enriched by its matching live profile.
  const seeded = TEAM.map(s => {
    const live = s.email && byEmail[s.email.toLowerCase()] || byName[s.name.toLowerCase()] || null;
    if (live) used.add(live.id);
    return {
      id: s.id,
      name: s.name,
      title: s.title || live && live.title || '',
      photo: s.photo || live && live.avatar_url || '',
      badge: s.badge,
      employeeId: live && live.employee_id || s.employeeId || '',
      reportsTo: live && reportsName(live.reports_to) || s.reportsTo || '',
      phone: live && live.phone || s.phone || '',
      email: live && live.email || s.email || '',
      location: live && locationText(live) || s.location || '',
      timezone: live && live.timezone || s.timezone || '',
      pets: (live && live.pets && live.pets.length ? petsText(live.pets) : '') || s.pets || ''
    };
  });

  // New sign-ups not already in the curated seed (active accounts only).
  const extras = profiles.filter(p => !used.has(p.id) && p.status === 'active' && (fullName(p) || p.email) && !DIRECTORY_EXCLUDE.includes(fullName(p).trim().toLowerCase())).map(p => ({
    id: p.id,
    name: fullName(p) || p.email,
    title: p.title || '',
    photo: p.avatar_url || '',
    badge: hasAdmin(p.access) ? {
      label: 'Admin',
      lightBg: '#F3EBDA',
      lightFg: '#AD832F',
      darkBg: 'rgba(173,131,47,0.2)',
      darkFg: '#C9A45A'
    } : null,
    employeeId: p.employee_id || '',
    reportsTo: reportsName(p.reports_to),
    phone: p.phone || '',
    email: p.email || '',
    location: locationText(p),
    timezone: p.timezone || '',
    pets: petsText(p.pets)
  })).sort((a, b) => a.name.localeCompare(b.name));
  return seeded.concat(extras);
}

// ─── App Roadmap (admin-only, in More) — quarter-grouped PM table ─────
// Data model (flat, families contiguous): { id, name, status, type,
// dueDate|null, parentId|null, order }. Groups are DERIVED from dueDate
// (quarter/month) — no separate quarter field. Light mode only (per spec).
const RM_STATUS = [{
  id: 'todo',
  label: 'To Do',
  bg: '#F1EFE8',
  text: '#5F5E5A',
  dot: '#888780'
}, {
  id: 'inprogress',
  label: 'In Progress',
  bg: '#E6F1FB',
  text: '#185FA5',
  dot: '#185FA5'
}, {
  id: 'completed',
  label: 'Completed',
  bg: '#E6F2EC',
  text: '#0F6E56',
  dot: '#0F6E56'
}, {
  id: 'stuck',
  label: 'Stuck',
  bg: '#FCEBEB',
  text: '#A32D2D',
  dot: '#A32D2D'
}];
const RM_TYPES = [{
  id: 'mvp',
  label: 'MVP',
  bg: '#001A4A',
  text: '#FFFFFF'
}, {
  id: 'v2',
  label: 'V2',
  bg: '#F3EBDA',
  text: '#AD832F'
}, {
  id: 'future',
  label: 'Future',
  bg: '#F0EBE3',
  text: '#888888'
}];
const rmStatus = id => RM_STATUS.find(s => s.id === id) || RM_STATUS[0];
const rmType = id => RM_TYPES.find(t => t.id === id) || RM_TYPES[0];
const RM_DIFF = [{
  id: 'easy',
  label: 'Easy',
  bg: '#E6F2EC',
  text: '#0F6E56'
}, {
  id: 'normal',
  label: 'Normal',
  bg: '#FAEEDA',
  text: '#BA7517'
}, {
  id: 'hard',
  label: 'Hard',
  bg: '#FCEBEB',
  text: '#A32D2D'
}];
const rmDiff = id => RM_DIFF.find(d => d.id === id) || RM_DIFF[1];
const rmPad = n => String(n).padStart(2, '0');
const RM_MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function rmBucketKey(dateStr, groupBy) {
  const p = dateStr.split('-');
  const y = +p[0],
    mo = +p[1]; // mo 1..12
  if (groupBy === 'month') return y + '-' + rmPad(mo);
  const q = Math.floor((mo - 1) / 3) + 1;
  return y + '-Q' + q;
}
function rmGroupInfo(key, groupBy) {
  if (groupBy === 'month') {
    const p = key.split('-');
    const y = +p[0],
      mo = +p[1];
    return {
      label: RM_MON[mo - 1] + ' ' + y,
      hint: '',
      dropDate: y + '-' + rmPad(mo) + '-01'
    };
  }
  const p = key.split('-Q');
  const y = +p[0],
    q = +p[1];
  const sm = (q - 1) * 3; // 0-based start month
  return {
    label: 'Q' + q + ' ' + y,
    hint: RM_MON[sm] + ' – ' + RM_MON[sm + 2],
    dropDate: y + '-' + rmPad(sm + 1) + '-01'
  };
}
function rmNormalize(rows) {
  const parents = rows.filter(r => !r.parentId);
  const out = [];
  parents.forEach((p, pi) => {
    out.push({
      ...p,
      parentId: null,
      order: pi
    });
    rows.filter(r => r.parentId === p.id).forEach((c, ci) => out.push({
      ...c,
      order: ci
    }));
  });
  // keep any orphaned children as top-level so nothing is silently dropped
  rows.filter(r => r.parentId && !parents.some(p => p.id === r.parentId)).forEach((c, i) => out.push({
    ...c,
    parentId: null,
    order: parents.length + i
  }));
  return out;
}
function rmBlocks(rows) {
  const blocks = [];
  let cur = null;
  rows.forEach(r => {
    if (!r.parentId) {
      cur = {
        pid: r.id,
        items: [r]
      };
      blocks.push(cur);
    } else if (cur && r.parentId === cur.pid) {
      cur.items.push(r);
    } else {
      blocks.push({
        pid: r.id,
        items: [r]
      });
      cur = null;
    }
  });
  return blocks;
}
function rmGroups(rows, groupBy) {
  const parents = rows.filter(r => !r.parentId);
  const fam = p => ({
    parent: p,
    children: rows.filter(r => r.parentId === p.id)
  });
  const families = parents.map(fam);
  if (groupBy === 'none') {
    const sorted = families.slice().sort((a, b) => {
      const da = a.parent.dueDate,
        db = b.parent.dueDate;
      if (!da && !db) return 0;
      if (!da) return 1;
      if (!db) return -1;
      return da < db ? -1 : da > db ? 1 : 0;
    });
    return [{
      key: '__all',
      flat: true,
      families: sorted
    }];
  }
  const map = new Map();
  families.forEach(f => {
    const key = f.parent.dueDate ? rmBucketKey(f.parent.dueDate, groupBy) : '__unscheduled';
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(f);
  });
  const dated = [...map.keys()].filter(k => k !== '__unscheduled').sort();
  const groups = dated.map(k => ({
    key: k,
    info: rmGroupInfo(k, groupBy),
    families: map.get(k)
  }));
  if (map.has('__unscheduled')) groups.push({
    key: '__unscheduled',
    unscheduled: true,
    families: map.get('__unscheduled')
  });
  return groups;
}
function rmGroupProgress(group) {
  let total = 0,
    done = 0;
  group.families.forEach(f => {
    total++;
    if (f.parent.status === 'completed') done++;
    f.children.forEach(c => {
      total++;
      if (c.status === 'completed') done++;
    });
  });
  return total ? Math.round(done / total * 100) : 0;
}
function rmMoveFamily(rows, dragId, targetId, pos, newDue) {
  const blocks = rmBlocks(rows);
  const di = blocks.findIndex(b => b.pid === dragId);
  if (di < 0) return rows;
  const dblock = blocks.splice(di, 1)[0];
  if (newDue !== undefined) dblock.items[0] = {
    ...dblock.items[0],
    dueDate: newDue
  };
  const ti = blocks.findIndex(b => b.pid === targetId);
  if (ti < 0) blocks.push(dblock);else blocks.splice(pos === 'after' ? ti + 1 : ti, 0, dblock);
  return rmNormalize(blocks.reduce((a, b) => a.concat(b.items), []));
}
function rmMoveToGroupEnd(rows, dragId, newDue) {
  const blocks = rmBlocks(rows);
  const di = blocks.findIndex(b => b.pid === dragId);
  if (di < 0) return rows;
  const dblock = blocks.splice(di, 1)[0];
  dblock.items[0] = {
    ...dblock.items[0],
    dueDate: newDue
  };
  blocks.push(dblock);
  return rmNormalize(blocks.reduce((a, b) => a.concat(b.items), []));
}
function rmMigrate(oldArr) {
  const mapS = {
    todo: 'todo',
    in_progress: 'inprogress',
    stuck: 'stuck',
    done: 'completed'
  };
  const mapT = {
    mvp: 'mvp',
    vanity: 'future'
  };
  const rows = [];
  (oldArr || []).forEach(it => {
    const pid = it.id || 'p' + rows.length;
    rows.push({
      id: pid,
      name: it.title || '',
      status: mapS[it.status] || 'todo',
      type: mapT[it.type] || 'mvp',
      dueDate: it.due || null,
      parentId: null,
      order: 0
    });
    (it.subtasks || []).forEach(s => rows.push({
      id: s.id || 'c' + rows.length,
      name: s.title || '',
      status: s.done ? 'completed' : 'todo',
      type: 'mvp',
      dueDate: null,
      parentId: pid,
      order: 0
    }));
  });
  return rmNormalize(rows);
}
function rmSeed() {
  const DEF = [{
    n: 'AI Chat',
    s: 'completed',
    t: 'mvp',
    subs: [['AI Mode (general assistant)', 'completed'], ['Work Mode (guided pills)', 'completed'], ['Prompt pills', 'completed'], ['Form-type pills', 'completed'], ['Guided-steps pills', 'completed'], ['Chat history (pin / archive / rename / delete)', 'completed'], ['Attachments (files / photos / PDF)', 'completed'], ['Auto-grow message box', 'completed'], ['Claude AI proxy + usage tracking', 'completed']]
  }, {
    n: 'Team Chat',
    s: 'todo',
    t: 'future',
    subs: [['Message threads preview', 'inprogress']]
  }, {
    n: 'Calls',
    s: 'todo',
    t: 'future',
    subs: [['Recent calls preview', 'inprogress']]
  }, {
    n: 'KPIs',
    s: 'todo',
    t: 'future',
    subs: [['Sales goals / KPI preview', 'inprogress']]
  }, {
    n: 'Deals',
    s: 'todo',
    t: 'future',
    subs: [['Coming-soon placeholder', 'todo']]
  }, {
    n: 'Shared Drives',
    s: 'completed',
    t: 'mvp',
    subs: [['8 Google Drive folder tiles', 'completed'], ['Admin + Agents folder links', 'completed']]
  }, {
    n: 'Company Directory',
    s: 'completed',
    t: 'mvp',
    subs: [['Live roster (Supabase + curated)', 'completed'], ['Search', 'completed'], ['Role badges', 'completed'], ['Per-person profile pages', 'completed'], ['Clickable phone (tel:) / email (mailto:)', 'completed']]
  }, {
    n: 'Exp Survey',
    s: 'completed',
    t: 'mvp',
    subs: [['Survey QR code', 'completed'], ['Survey link', 'completed']]
  }, {
    n: 'SFFU (Showing Follow-Up)',
    s: 'inprogress',
    t: 'mvp',
    subs: [['Embedded app (iframe)', 'completed'], ['Add property / add showing', 'completed'], ['SMS follow-up engine (Quo)', 'inprogress']]
  }, {
    n: 'Calendar',
    s: 'stuck',
    t: 'mvp',
    subs: [['Week view UI', 'completed'], ['Google Calendar sync', 'stuck']]
  }, {
    n: 'Tasks',
    s: 'completed',
    t: 'mvp',
    subs: [['Statuses + priority', 'completed'], ['Subtasks', 'completed'], ['Recurrence (daily / weekly / monthly)', 'completed'], ['Assignees + labels', 'completed'], ['Decision tasks', 'completed'], ['Activity log', 'completed']]
  }, {
    n: 'Profile & Status',
    s: 'completed',
    t: 'mvp',
    subs: [['Avatar chip + presence dot', 'completed'], ['Status (emoji + text)', 'completed'], ['Set away (green / amber)', 'completed'], ['Profile details + edit', 'completed']]
  }, {
    n: 'Admin',
    s: 'completed',
    t: 'mvp',
    subs: [['Manage Users (roles / access)', 'completed'], ['Tab Access (per-role)', 'completed'], ['Work Mode Builder', 'completed'], ['Usage stats', 'completed']]
  }, {
    n: 'Settings',
    s: 'completed',
    t: 'mvp',
    subs: [['Dark mode', 'completed'], ['Text-size slider', 'completed'], ['Chat history side', 'completed'], ['Sign out', 'completed']]
  }, {
    n: 'Roadmap',
    s: 'inprogress',
    t: 'mvp',
    subs: [['Quarter grouping', 'completed'], ['Month progress tiles', 'completed'], ['Drag to reschedule', 'completed'], ['Subtasks', 'completed']]
  }, {
    n: 'Auth / Account',
    s: 'completed',
    t: 'mvp',
    subs: [['Google SSO', 'completed'], ['Email + OTP / MFA', 'completed'], ['Access gating (pending / active)', 'completed']]
  }];
  let i = 0;
  const dueFor = () => {
    const off = (i * 50 + 23) % 163;
    i++;
    const d = new Date(2026, 0, 1 + off);
    return d.getFullYear() + '-' + rmPad(d.getMonth() + 1) + '-' + rmPad(d.getDate());
  };
  const rows = [];
  DEF.forEach((tab, ti) => {
    const pid = 't' + ti;
    rows.push({
      id: pid,
      name: tab.n,
      status: tab.s,
      type: tab.t,
      dueDate: dueFor(),
      parentId: null,
      order: 0
    });
    (tab.subs || []).forEach((sub, si) => rows.push({
      id: pid + '-' + si,
      name: sub[0],
      status: sub[1],
      type: sub[2] || tab.t,
      dueDate: dueFor(),
      parentId: pid,
      order: 0
    }));
  });
  return rmNormalize(rows);
}

// One-time merge: append dictated features onto existing saved data
// (idempotent — only adds what isn't already there). Bumped via RM_KEY.
function rmEnsureAdditions(rows) {
  let out = rows.slice();
  const topByName = (name, fid) => out.find(r => !r.parentId && (r.name === name || r.id === fid));
  const hasChild = (pid, name) => out.some(r => r.parentId === pid && r.name === name);
  const addChild = (pid, name) => {
    if (pid && !hasChild(pid, name)) out.push({
      id: pid + '-x' + out.length,
      name: name,
      status: 'todo',
      type: 'mvp',
      dueDate: null,
      parentId: pid,
      order: 0
    });
  };
  const ai = topByName('AI Chat', 't0');
  if (ai) addChild(ai.id, 'Projects (Files + Contacts)');
  const tc = topByName('Team Chat', 't1');
  if (tc) {
    ['Direct Messaging', 'Group Chat', 'Assigned Tasks'].forEach(n => addChild(tc.id, n));
  }
  let crm = topByName('CRM', 'crm');
  if (!crm) {
    out.push({
      id: 'crm',
      name: 'CRM',
      status: 'todo',
      type: 'mvp',
      dueDate: null,
      parentId: null,
      order: 0
    });
    crm = out[out.length - 1];
  }
  addChild(crm.id, 'Contacts');
  addChild(crm.id, 'Deals');
  return rmNormalize(out);
}

// ─── Exp Survey (opened from the More menu, under Company Directory) ─
// Contents of the "TMG Experience Survey URL & QR Code" PDF: the survey
// link + a self-contained QR (generated for the same URL; no external call).

// Embeds the standalone SFFU app (same origin + same Supabase login) as a TMG view.
// The header row drives SFFU's actions via postMessage; SFFU keeps its own settings.

// ─── Custom TMG-styled date picker (replaces the unstyleable native <input type="date">) ──
// Value is a 'YYYY-MM-DD' string; calendar expands inline below the field.
function DateField({
  value,
  onChange,
  dark,
  inp,
  bord,
  ink,
  sub,
  placeholder
}) {
  const gold = dark ? '#C9A45A' : '#AD832F';
  const navy = '#001A4A';
  const J = C.fontSans;
  const [open, setOpen] = useState(false);
  const parse = v => {
    if (!v) return null;
    const p = String(v).split('-');
    if (p.length !== 3) return null;
    const d = new Date(+p[0], +p[1] - 1, +p[2]);
    return isNaN(d.getTime()) ? null : d;
  };
  const pad = n => String(n).padStart(2, '0');
  const toISO = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const same = (a, b) => a && b && a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  const selected = parse(value);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const [cursor, setCursor] = useState(() => {
    const b = selected || new Date();
    return new Date(b.getFullYear(), b.getMonth(), 1);
  });
  useEffect(() => {
    if (open) {
      const b = parse(value) || new Date();
      setCursor(new Date(b.getFullYear(), b.getMonth(), 1));
    }
  }, [open]);
  const stepMonth = n => setCursor(c => new Date(c.getFullYear(), c.getMonth() + n, 1));
  const stepYear = n => setCursor(c => new Date(c.getFullYear() + n, c.getMonth(), 1));
  const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
  const gridStart = new Date(first);
  gridStart.setDate(1 - first.getDay());
  const cells = Array.from({
    length: 42
  }, (_, i) => {
    const d = new Date(gridStart);
    d.setDate(gridStart.getDate() + i);
    return d;
  });
  const panelBg = dark ? '#0A1730' : '#FFFFFF';
  const navBtn = {
    width: 24,
    height: 24,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 7,
    border: `1px solid ${bord}`,
    background: dark ? '#06101F' : '#F7F4EE',
    color: gold,
    cursor: 'pointer',
    padding: 0,
    fontSize: 13
  };
  const display = selected ? selected.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  }) : placeholder || 'Select date';
  return /*#__PURE__*/React.createElement("div", {
    style: {
      flex: '1 1 150px',
      minWidth: 0
    }
  }, /*#__PURE__*/React.createElement("div", {
    onClick: () => setOpen(o => !o),
    style: {
      ...inp,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      cursor: 'pointer',
      gap: 8
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      color: selected ? ink : sub,
      fontFamily: J,
      fontSize: '0.86rem',
      whiteSpace: 'nowrap',
      overflow: 'hidden',
      textOverflow: 'ellipsis'
    }
  }, display), /*#__PURE__*/React.createElement("i", {
    className: "ti ti-calendar",
    style: {
      fontSize: 15,
      color: gold,
      flexShrink: 0
    }
  })), open && /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 6,
      background: panelBg,
      border: `1px solid ${bord}`,
      borderRadius: 12,
      padding: 10,
      boxShadow: dark ? '0 10px 30px rgba(0,0,0,0.4)' : '0 10px 30px rgba(0,26,74,0.12)'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      marginBottom: 8
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: C.fontDisplay,
      fontSize: '1.05rem',
      fontWeight: 600,
      fontStyle: 'italic',
      color: dark ? '#EFE9DC' : navy
    }
  }, cursor.toLocaleDateString('en-US', {
    month: 'long',
    year: 'numeric'
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 4
    }
  }, /*#__PURE__*/React.createElement("button", {
    type: "button",
    title: "Previous month",
    onClick: () => stepMonth(-1),
    style: navBtn
  }, /*#__PURE__*/React.createElement("i", {
    className: "ti ti-chevron-left"
  })), /*#__PURE__*/React.createElement("button", {
    type: "button",
    title: "Next month",
    onClick: () => stepMonth(1),
    style: navBtn
  }, /*#__PURE__*/React.createElement("i", {
    className: "ti ti-chevron-right"
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      width: 1,
      height: 16,
      background: bord,
      margin: '0 2px'
    }
  }), /*#__PURE__*/React.createElement("button", {
    type: "button",
    title: "Year ascending",
    onClick: () => stepYear(1),
    style: navBtn
  }, /*#__PURE__*/React.createElement("i", {
    className: "ti ti-chevron-up"
  })), /*#__PURE__*/React.createElement("button", {
    type: "button",
    title: "Year descending",
    onClick: () => stepYear(-1),
    style: navBtn
  }, /*#__PURE__*/React.createElement("i", {
    className: "ti ti-chevron-down"
  })))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'grid',
      gridTemplateColumns: 'repeat(7,1fr)',
      gap: 2,
      marginBottom: 3
    }
  }, ['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((w, i) => /*#__PURE__*/React.createElement("div", {
    key: i,
    style: {
      textAlign: 'center',
      fontFamily: J,
      fontSize: '0.6rem',
      fontWeight: 700,
      letterSpacing: '0.04em',
      color: sub,
      padding: '2px 0'
    }
  }, w))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'grid',
      gridTemplateColumns: 'repeat(7,1fr)',
      gap: 2
    }
  }, cells.map((d, i) => {
    const inMonth = d.getMonth() === cursor.getMonth();
    const isSel = same(d, selected);
    const isToday = same(d, today);
    return /*#__PURE__*/React.createElement("button", {
      type: "button",
      key: i,
      onClick: () => {
        onChange(toISO(d));
        setOpen(false);
      },
      style: {
        height: 32,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontFamily: J,
        fontSize: '0.8rem',
        fontWeight: isSel ? 700 : 500,
        color: isSel ? '#fff' : inMonth ? ink : dark ? 'rgba(255,255,255,.26)' : '#C4BBA9',
        background: isSel ? gold : 'transparent',
        border: isToday && !isSel ? `1.5px solid ${gold}` : '1.5px solid transparent',
        borderRadius: 8,
        cursor: 'pointer',
        padding: 0,
        lineHeight: 1,
        WebkitAppearance: 'none',
        outline: 'none'
      }
    }, d.getDate());
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      marginTop: 9,
      paddingTop: 8,
      borderTop: `1px solid ${bord}`
    }
  }, /*#__PURE__*/React.createElement("button", {
    type: "button",
    onClick: () => {
      onChange('');
      setOpen(false);
    },
    style: {
      fontFamily: J,
      fontSize: '0.72rem',
      fontWeight: 600,
      color: sub,
      background: 'none',
      border: 'none',
      cursor: 'pointer',
      padding: '2px 4px'
    }
  }, "Clear"), /*#__PURE__*/React.createElement("button", {
    type: "button",
    onClick: () => {
      onChange(toISO(today));
      setOpen(false);
    },
    style: {
      fontFamily: J,
      fontSize: '0.72rem',
      fontWeight: 700,
      color: gold,
      background: 'none',
      border: 'none',
      cursor: 'pointer',
      padding: '2px 4px'
    }
  }, "Today"))));
}

// Copy-a-link-to-this-view button. One component for all four sites (task
// detail + CTC file / project / rock detail) so they stay identical.
// prompt() fallback covers Safari and non-secure contexts.
function CopyLinkBtn({
  dark,
  hash,
  title
}) {
  const [copied, setCopied] = useState(false);
  const bord = dark ? '#152545' : '#E4DFD4',
    sub = dark ? 'rgba(255,255,255,0.5)' : '#6B6B6B';
  const go = async () => {
    const url = permalinkFor(hash);
    try {
      await navigator.clipboard.writeText(url);
    } catch (e) {
      window.prompt('Copy this link:', url);
      return;
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };
  return /*#__PURE__*/React.createElement("button", {
    onClick: go,
    title: title || 'Copy a link straight to this view',
    style: {
      fontSize: 12,
      fontWeight: 400,
      letterSpacing: '0.08em',
      textTransform: 'uppercase',
      color: copied ? '#0F6E56' : sub,
      background: dark ? '#0A1730' : '#fff',
      border: `1px solid ${copied ? '#0F6E5655' : bord}`,
      borderRadius: 6,
      padding: '7px 12px',
      cursor: 'pointer',
      fontFamily: C.fontSans,
      flexShrink: 0,
      display: 'flex',
      alignItems: 'center',
      gap: 5
    }
  }, /*#__PURE__*/React.createElement("i", {
    className: `ti ${copied ? 'ti-check' : 'ti-link'}`,
    style: {
      fontSize: 13
    }
  }), copied ? 'Copied' : 'Link');
}

// Multi-select dropdown for team pickers (Assignees / Assigned by) — same
// click-to-open-panel convention as DateField above (no outside-click
// handling anywhere in this codebase, so this doesn't add it either).
function PeopleDropdown({
  dark,
  team,
  arr,
  set,
  placeholder
}) {
  const gold = dark ? '#C9A45A' : '#AD832F';
  const J = C.fontSans;
  const [open, setOpen] = useState(false);
  const bord = dark ? '#152545' : '#E4DFD4',
    ink = dark ? '#fff' : '#001A4A',
    sub = dark ? 'rgba(255,255,255,0.5)' : '#6B6B6B';
  const inp = {
    width: '100%',
    padding: '9px 11px',
    background: dark ? '#06101F' : '#F7F4EE',
    border: `1px solid ${bord}`,
    borderRadius: 6,
    color: ink,
    fontSize: 14,
    outline: 'none',
    fontFamily: J,
    boxSizing: 'border-box'
  };
  const nameOf = id => (team.find(m => m.id === id) || {}).name || '—';
  const display = arr.length ? arr.map(nameOf).join(', ') : placeholder || 'Select…';
  const toggle = id => set(arr.includes(id) ? arr.filter(x => x !== id) : [...arr, id]);
  return /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    onClick: () => setOpen(o => !o),
    style: {
      ...inp,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      cursor: 'pointer',
      gap: 8
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      color: arr.length ? ink : sub,
      fontFamily: J,
      fontSize: '0.86rem',
      whiteSpace: 'nowrap',
      overflow: 'hidden',
      textOverflow: 'ellipsis'
    }
  }, display), /*#__PURE__*/React.createElement("i", {
    className: `ti ti-chevron-${open ? 'up' : 'down'}`,
    style: {
      fontSize: 15,
      color: gold,
      flexShrink: 0
    }
  })), open && /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 6,
      background: dark ? '#0A1730' : '#FFFFFF',
      border: `1px solid ${bord}`,
      borderRadius: 12,
      padding: 6,
      boxShadow: dark ? '0 10px 30px rgba(0,0,0,0.4)' : '0 10px 30px rgba(0,26,74,0.12)',
      maxHeight: 220,
      overflowY: 'auto'
    }
  }, !team.length && /*#__PURE__*/React.createElement("div", {
    style: {
      padding: '8px 6px',
      fontSize: '0.74rem',
      color: sub,
      fontFamily: J
    }
  }, "No teammates loaded."), team.map(m => {
    const on = arr.includes(m.id);
    return /*#__PURE__*/React.createElement("div", {
      key: m.id,
      onClick: () => toggle(m.id),
      style: {
        display: 'flex',
        alignItems: 'center',
        gap: 9,
        padding: '8px 8px',
        borderRadius: 8,
        cursor: 'pointer',
        background: on ? dark ? 'rgba(201,164,90,0.12)' : '#F3EBDA' : 'transparent'
      }
    }, /*#__PURE__*/React.createElement("i", {
      className: `ti ${on ? 'ti-square-check-filled' : 'ti-square'}`,
      style: {
        fontSize: 16,
        color: on ? gold : sub,
        flexShrink: 0
      }
    }), /*#__PURE__*/React.createElement("span", {
      style: {
        fontSize: '0.82rem',
        color: ink,
        fontFamily: J
      }
    }, m.name));
  }), arr.length > 0 && /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      justifyContent: 'flex-end',
      marginTop: 4,
      paddingTop: 6,
      borderTop: `1px solid ${bord}`
    }
  }, /*#__PURE__*/React.createElement("button", {
    type: "button",
    onClick: () => set([]),
    style: {
      fontFamily: J,
      fontSize: '0.72rem',
      fontWeight: 600,
      color: sub,
      background: 'none',
      border: 'none',
      cursor: 'pointer',
      padding: '2px 4px'
    }
  }, "Clear"))));
}

// ─── Tasks module (full screen, opened from the top-bar Tasks chip) ──
function TaskForm({
  dark,
  task,
  team,
  user,
  onSave,
  onCancel
}) {
  const t = task || {};
  const uid = user && user.id;
  const _dd = t.due_at ? new Date(t.due_at) : null;
  const _p2 = n => String(n).padStart(2, '0');
  const _initDate = _dd ? _dd.getFullYear() + '-' + _p2(_dd.getMonth() + 1) + '-' + _p2(_dd.getDate()) : '';
  const _initHM = _dd ? _p2(_dd.getHours()) + ':' + _p2(_dd.getMinutes()) : '';
  const _decd = t.decision_due_at ? new Date(t.decision_due_at) : null;
  const _initDecDate = _decd ? _decd.getFullYear() + '-' + _p2(_decd.getMonth() + 1) + '-' + _p2(_decd.getDate()) : '';
  const _initDecHM = _decd ? _p2(_decd.getHours()) + ':' + _p2(_decd.getMinutes()) : '';
  const [title, setTitle] = useState(t.title || '');
  const [dueDate, setDueDate] = useState(_initDate);
  const [dueTime, setDueTime] = useState(_initHM && _initHM !== '00:00' ? _initHM : '09:00');
  const [hasTime, setHasTime] = useState(!!(_initHM && _initHM !== '00:00'));
  const [repeats, setRepeats] = useState(!!(t.recurrence && t.recurrence !== 'none'));
  const [recurrence, setRecurrence] = useState(t.recurrence && t.recurrence !== 'none' ? t.recurrence : 'weekly');
  const [recurInterval, setRecurInterval] = useState(t.recur_interval != null ? String(t.recur_interval) : '2');
  const [recurUnit, setRecurUnit] = useState(t.recur_unit || 'week');
  const [recurCopy, setRecurCopy] = useState(Array.isArray(t.recur_copy_fields) && t.recur_copy_fields.length ? t.recur_copy_fields : RECUR_COPY_DEFAULT);
  const [project, setProject] = useState(t._projectName || '');
  const [projects, setProjects] = useState([]);
  const [newProjMode, setNewProjMode] = useState(false);
  const [priority, setPriority] = useState(t.priority || 'medium');
  const [status, setStatus] = useState(t.status || 'todo');
  const [myLabels, setMyLabels] = useState([]);
  const [labelInput, setLabelInput] = useState('');
  const [assignees, setAssignees] = useState(t._assignees || []);
  const [assigners, setAssigners] = useState(t._assigners || []);
  const [workingUrl, setWorkingUrl] = useState(t.working_url || '');
  const [emailLink, setEmailLink] = useState(t.email_link || '');
  const [description, setDescription] = useState(t.description || '');
  const [context, setContext] = useState(t.context || '');
  const [decisionMakers, setDecisionMakers] = useState(t._decisionMakers || []);
  const [decisionQuestion, setDecisionQuestion] = useState(t.decision_question || '');
  const [decisionDueDate, setDecisionDueDate] = useState(_initDecDate);
  const [decisionHasTime, setDecisionHasTime] = useState(t.decision_due_has_time != null ? !!t.decision_due_has_time : !!(_initDecHM && _initDecHM !== '00:00'));
  const [decisionDueTime, setDecisionDueTime] = useState(_initDecHM && _initDecHM !== '00:00' ? _initDecHM : '09:00');
  const [decisionOptions, setDecisionOptions] = useState([]);
  const [saving, setSaving] = useState(false);
  // W/D planning — stored per-user, per-task in localStorage for now (wired to the calendar later)
  const [weeklyPriority, setWeeklyPriority] = useState(t.weekly_priority || '');
  const [weeklyRank, setWeeklyRank] = useState(t.weekly_rank != null ? String(t.weekly_rank) : '');
  const [dailyPriority, setDailyPriority] = useState(t.daily_priority || '');
  const [dailyRank, setDailyRank] = useState(t.daily_rank != null ? String(t.daily_rank) : '');
  const [planOpen, setPlanOpen] = useState(!!(t.weekly_priority || t.weekly_rank != null || t.daily_priority || t.daily_rank != null));
  const [decisionOpen, setDecisionOpen] = useState(false);
  useEffect(() => {
    TaskDB.loadProjects().then(rows => setProjects(rows || []));
  }, []);
  useEffect(() => {
    if (!t.id) return;
    TaskDB.loadLabels(t.id).then(rows => setMyLabels((rows || []).filter(r => r.user_id === uid).map(r => r.label)));
    TaskDB.loadDecisionOptions(t.id).then(rows => setDecisionOptions((rows || []).map(r => ({
      body: r.body,
      is_chosen: r.is_chosen
    }))));
    if (t.decision_question) setDecisionOpen(true);
  }, [t.id]);
  const bord = dark ? '#152545' : '#E4DFD4',
    ink = dark ? '#fff' : '#001A4A',
    sub = dark ? 'rgba(255,255,255,0.5)' : '#6B6B6B';
  const gold = dark ? '#C9A45A' : '#AD832F';
  // Label/input values ported from the prototype's .field .fk / .field input.
  const lbl = {
    fontSize: 11,
    color: sub,
    letterSpacing: '0.1em',
    textTransform: 'uppercase',
    fontWeight: 500,
    margin: '0 0 5px',
    fontFamily: C.fontSans
  };
  const inp = {
    width: '100%',
    padding: '9px 11px',
    background: dark ? '#06101F' : '#F7F4EE',
    border: `1px solid ${bord}`,
    borderRadius: 6,
    color: ink,
    fontSize: 14,
    outline: 'none',
    fontFamily: C.fontSans,
    boxSizing: 'border-box'
  };
  const toggle = (arr, set, id) => set(arr.includes(id) ? arr.filter(x => x !== id) : [...arr, id]);
  const chips = (arr, set) => /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexWrap: 'wrap',
      gap: 6
    }
  }, team.map(m => {
    const on = arr.includes(m.id);
    return /*#__PURE__*/React.createElement("button", {
      key: m.id,
      type: "button",
      onClick: () => toggle(arr, set, m.id),
      style: {
        padding: '6px 10px',
        borderRadius: 16,
        border: `1px solid ${on ? C.navy : bord}`,
        background: on ? C.navy : dark ? '#06101F' : '#fff',
        color: on ? '#fff' : sub,
        fontSize: '0.76rem',
        cursor: 'pointer',
        fontFamily: C.fontSans
      }
    }, m.name);
  }), !team.length && /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: '0.74rem',
      color: sub
    }
  }, "No teammates loaded."));
  const sel = (val, set, opts) => {
    const cur = opts.find(o => o.id === val) || {};
    return /*#__PURE__*/React.createElement("select", {
      value: val,
      onChange: e => set(e.target.value),
      style: {
        ...inp,
        ...(cur.bg ? {
          background: cur.bg,
          color: cur.color,
          fontWeight: 600
        } : {})
      }
    }, opts.map(o => /*#__PURE__*/React.createElement("option", {
      key: o.id,
      value: o.id,
      style: o.bg ? {
        background: o.bg,
        color: o.color,
        fontWeight: 600
      } : undefined
    }, o.label)));
  };
  const field = (label, node) => /*#__PURE__*/React.createElement("div", {
    style: {
      marginBottom: 16
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: lbl
  }, label), node);
  const addLabel = () => {
    const v = labelInput.trim();
    if (!v) return;
    setMyLabels(l => l.includes(v) ? l : [...l, v]);
    setLabelInput('');
  };
  const removeLabel = v => setMyLabels(l => l.filter(x => x !== v));
  const addOpt = () => setDecisionOptions(o => [...o, {
    body: '',
    is_chosen: false
  }]);
  const updateOpt = (i, v) => setDecisionOptions(o => o.map((x, j) => j === i ? {
    ...x,
    body: v
  } : x));
  const removeOpt = i => setDecisionOptions(o => o.filter((_, j) => j !== i));
  const setChosen = i => setDecisionOptions(o => o.map((x, j) => ({
    ...x,
    is_chosen: j === i ? !x.is_chosen : false
  })));
  const mondayOpts = (() => {
    const opts = [{
      id: '',
      label: '— Pick a week —'
    }];
    const d = new Date();
    const o = (d.getDay() + 6) % 7;
    d.setDate(d.getDate() - o);
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - 7);
    for (let i = 0; i < 18; i++) {
      const iso = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
      opts.push({
        id: iso,
        label: 'Wk of ' + d.toLocaleDateString('en-US', {
          month: 'short',
          day: 'numeric'
        })
      });
      d.setDate(d.getDate() + 7);
    }
    return opts;
  })();
  const RANKS = [{
    id: '',
    label: '—'
  }, {
    id: '1',
    label: 'Rank 1'
  }, {
    id: '2',
    label: 'Rank 2'
  }, {
    id: '3',
    label: 'Rank 3'
  }];
  const REPEAT_OPTS = TASK_RECUR.filter(r => r.id !== 'none');
  async function save() {
    if (!title.trim()) return;
    setSaving(true);
    try {
      const due = dueDate ? dueDate + 'T' + (hasTime && dueTime ? dueTime : '00:00') : '';
      const decisionDue = decisionDueDate ? decisionDueDate + 'T' + (decisionHasTime && decisionDueTime ? decisionDueTime : '00:00') : '';
      await onSave({
        title: title.trim(),
        due,
        recurrence: repeats ? recurrence : 'none',
        recurInterval: repeats && recurrence === 'custom' ? parseInt(recurInterval, 10) || 1 : null,
        recurUnit: repeats && recurrence === 'custom' ? recurUnit : null,
        recurCopy: repeats ? recurCopy : null,
        project,
        priority,
        status,
        assignees,
        assigners,
        working_url: workingUrl.trim(),
        email_link: emailLink.trim(),
        description,
        context,
        labels: myLabels,
        decisionMakers,
        decisionQuestion: decisionQuestion.trim(),
        decisionDue,
        decisionHasTime,
        decisionOptions: decisionOptions.filter(o => (o.body || '').trim()),
        planning: {
          wp: weeklyPriority,
          wr: weeklyRank,
          dp: dailyPriority,
          dr: dailyRank
        }
      });
    } finally {
      setSaving(false);
    }
  }
  const sectionHeader = (open, setOpen, icon, label) => /*#__PURE__*/React.createElement("button", {
    type: "button",
    onClick: () => setOpen(v => !v),
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 7,
      width: '100%',
      textAlign: 'left',
      background: dark ? '#06101F' : '#F7F4EE',
      border: `1px solid ${bord}`,
      borderRadius: 10,
      padding: '10px 12px',
      cursor: 'pointer'
    }
  }, /*#__PURE__*/React.createElement("i", {
    className: `ti ${icon}`,
    style: {
      fontSize: 15,
      color: gold
    }
  }), /*#__PURE__*/React.createElement("span", {
    style: {
      flex: 1,
      fontSize: '0.64rem',
      fontWeight: 700,
      letterSpacing: '0.12em',
      textTransform: 'uppercase',
      color: gold,
      fontFamily: C.fontSans
    }
  }, label), /*#__PURE__*/React.createElement("i", {
    className: `ti ti-chevron-${open ? 'up' : 'down'}`,
    style: {
      fontSize: 15,
      color: sub
    }
  }));
  return /*#__PURE__*/React.createElement("div", {
    style: {
      padding: '14px 16px 40px'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      marginBottom: 13
    }
  }, sectionHeader(planOpen, setPlanOpen, 'ti-target', 'W/D Planning'), planOpen && /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 10
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 10
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1.5
    }
  }, field('Weekly priority', sel(weeklyPriority, setWeeklyPriority, mondayOpts))), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1
    }
  }, field('Weekly rank', sel(weeklyRank, setWeeklyRank, RANKS)))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 10
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1.5
    }
  }, field('Daily priority', /*#__PURE__*/React.createElement(DateField, {
    value: dailyPriority,
    onChange: setDailyPriority,
    dark: dark,
    inp: inp,
    bord: bord,
    ink: ink,
    sub: sub,
    placeholder: "Select date"
  }))), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1
    }
  }, field('Daily rank', sel(dailyRank, setDailyRank, RANKS)))))), field('Title', /*#__PURE__*/React.createElement("input", {
    value: title,
    onChange: e => setTitle(e.target.value),
    placeholder: "What needs doing?",
    style: inp
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      marginBottom: 13
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: lbl
  }, "Due date"), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 12,
      flexWrap: 'wrap'
    }
  }, /*#__PURE__*/React.createElement(DateField, {
    value: dueDate,
    onChange: setDueDate,
    dark: dark,
    inp: inp,
    bord: bord,
    ink: ink,
    sub: sub,
    placeholder: "Select date"
  }), /*#__PURE__*/React.createElement("label", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 5,
      cursor: 'pointer',
      fontSize: '0.78rem',
      color: ink,
      fontFamily: C.fontSans
    }
  }, /*#__PURE__*/React.createElement("input", {
    type: "checkbox",
    checked: hasTime,
    onChange: e => setHasTime(e.target.checked),
    style: {
      accentColor: C.navy,
      width: 15,
      height: 15
    }
  }), "Time"), /*#__PURE__*/React.createElement("label", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 5,
      cursor: 'pointer',
      fontSize: '0.78rem',
      color: ink,
      fontFamily: C.fontSans
    }
  }, /*#__PURE__*/React.createElement("input", {
    type: "checkbox",
    checked: repeats,
    onChange: e => setRepeats(e.target.checked),
    style: {
      accentColor: C.navy,
      width: 15,
      height: 15
    }
  }), "Repeat")), hasTime && /*#__PURE__*/React.createElement("input", {
    type: "time",
    value: dueTime,
    onChange: e => setDueTime(e.target.value),
    style: {
      ...inp,
      marginTop: 8
    }
  }), repeats && /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 8
    }
  }, sel(recurrence, setRecurrence, REPEAT_OPTS), recurrence === 'custom' && /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      marginTop: 8
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: '0.78rem',
      color: sub,
      fontFamily: C.fontSans
    }
  }, "Every"), /*#__PURE__*/React.createElement("input", {
    type: "number",
    min: "1",
    value: recurInterval,
    onChange: e => setRecurInterval(e.target.value),
    style: {
      ...inp,
      width: 64,
      padding: '8px 9px'
    }
  }), /*#__PURE__*/React.createElement("select", {
    value: recurUnit,
    onChange: e => setRecurUnit(e.target.value),
    style: {
      ...inp,
      flex: 1
    }
  }, /*#__PURE__*/React.createElement("option", {
    value: "day"
  }, "day(s)"), /*#__PURE__*/React.createElement("option", {
    value: "week"
  }, "week(s)"), /*#__PURE__*/React.createElement("option", {
    value: "month"
  }, "month(s)"))), /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 10
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      ...lbl,
      marginBottom: 6
    }
  }, "Copy to next instance"), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexWrap: 'wrap',
      gap: 6
    }
  }, RECUR_COPY_FIELDS.map(f => {
    const on = recurCopy.includes(f.id);
    return /*#__PURE__*/React.createElement("button", {
      key: f.id,
      type: "button",
      onClick: () => setRecurCopy(c => c.includes(f.id) ? c.filter(x => x !== f.id) : [...c, f.id]),
      style: {
        padding: '5px 9px',
        borderRadius: 14,
        border: `1px solid ${on ? C.navy : bord}`,
        background: on ? C.navy : dark ? '#06101F' : '#fff',
        color: on ? '#fff' : sub,
        fontSize: '0.72rem',
        cursor: 'pointer',
        fontFamily: C.fontSans
      }
    }, on ? '✓ ' : '', f.label);
  }))), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: '0.66rem',
      color: sub,
      lineHeight: 1.5,
      marginTop: 8,
      fontFamily: C.fontSans
    }
  }, "When marked Completed, the next one is created automatically \u2014 due date moved forward, only the checked fields carried over."))), field('Assignees', /*#__PURE__*/React.createElement(PeopleDropdown, {
    dark: dark,
    team: team,
    arr: assignees,
    set: setAssignees,
    placeholder: "Select assignees\u2026"
  })), field('Assigned by', /*#__PURE__*/React.createElement(PeopleDropdown, {
    dark: dark,
    team: team,
    arr: assigners,
    set: setAssigners,
    placeholder: "Select who assigned this\u2026"
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 10
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1
    }
  }, field('Status', sel(status, setStatus, TASK_STATUS))), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1
    }
  }, field('Priority', sel(priority, setPriority, TASK_PRIORITY)))), field('Project', /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("select", {
    value: newProjMode ? '__new__' : project || '',
    onChange: e => {
      const v = e.target.value;
      if (v === '__new__') {
        setNewProjMode(true);
        setProject('');
      } else {
        setNewProjMode(false);
        setProject(v);
      }
    },
    style: inp
  }, /*#__PURE__*/React.createElement("option", {
    value: ""
  }, "(No project)"), projects.map(p => /*#__PURE__*/React.createElement("option", {
    key: p.id,
    value: p.name
  }, p.name)), project && !newProjMode && !projects.some(p => p.name === project) && /*#__PURE__*/React.createElement("option", {
    value: project
  }, project), /*#__PURE__*/React.createElement("option", {
    value: "__new__"
  }, "\uFF0B New project\u2026")), newProjMode && /*#__PURE__*/React.createElement("input", {
    autoFocus: true,
    value: project,
    onChange: e => setProject(e.target.value),
    placeholder: "New project name",
    style: {
      ...inp,
      marginTop: 8
    }
  }))), field('Your labels', /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 8
    }
  }, /*#__PURE__*/React.createElement("input", {
    value: labelInput,
    onChange: e => setLabelInput(e.target.value),
    onKeyDown: e => {
      if (e.key === 'Enter') {
        e.preventDefault();
        addLabel();
      }
    },
    placeholder: "Add a label\u2026",
    style: inp
  }), /*#__PURE__*/React.createElement("button", {
    type: "button",
    onClick: addLabel,
    style: {
      padding: '0 14px',
      background: dark ? '#06101F' : '#fff',
      border: `1px solid ${bord}`,
      borderRadius: 9,
      color: ink,
      fontSize: '0.8rem',
      cursor: 'pointer',
      fontFamily: C.fontSans,
      flexShrink: 0
    }
  }, "Add")), myLabels.length > 0 && /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexWrap: 'wrap',
      gap: 6,
      marginTop: 8
    }
  }, myLabels.map(l => /*#__PURE__*/React.createElement("span", {
    key: l,
    style: {
      display: 'inline-flex',
      alignItems: 'center',
      gap: 5,
      padding: '4px 7px 4px 10px',
      borderRadius: 16,
      background: dark ? 'rgba(201,164,90,0.15)' : '#F3EBDA',
      color: gold,
      fontSize: '0.74rem',
      fontWeight: 500,
      fontFamily: C.fontSans
    }
  }, l, /*#__PURE__*/React.createElement("i", {
    className: "ti ti-x",
    onClick: () => removeLabel(l),
    style: {
      fontSize: 12,
      cursor: 'pointer'
    }
  })))))), field('Description', /*#__PURE__*/React.createElement("textarea", {
    value: description,
    onChange: e => setDescription(e.target.value),
    rows: 3,
    placeholder: "Initial description (auto-filled when generated from AI mode later)",
    style: {
      ...inp,
      minHeight: 80,
      resize: 'vertical',
      lineHeight: 1.6
    }
  })), field('Context', /*#__PURE__*/React.createElement("textarea", {
    value: context,
    onChange: e => setContext(e.target.value),
    rows: 2,
    placeholder: "Ongoing updates / notes",
    style: {
      ...inp,
      resize: 'vertical',
      lineHeight: 1.5
    }
  })), field('Working URL', /*#__PURE__*/React.createElement("input", {
    value: workingUrl,
    onChange: e => setWorkingUrl(e.target.value),
    placeholder: "https://\u2026",
    style: inp
  })), field('Email link', /*#__PURE__*/React.createElement("input", {
    value: emailLink,
    onChange: e => setEmailLink(e.target.value),
    placeholder: "https://\u2026 (link to the email)",
    style: inp
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 4,
      marginBottom: 4
    }
  }, sectionHeader(decisionOpen, setDecisionOpen, 'ti-gavel', 'Decision'), decisionOpen && /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 10
    }
  }, field('Decision maker(s)', chips(decisionMakers, setDecisionMakers)), /*#__PURE__*/React.createElement("div", {
    style: {
      marginBottom: 13
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: lbl
  }, "Decision due date"), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 12,
      flexWrap: 'wrap'
    }
  }, /*#__PURE__*/React.createElement(DateField, {
    value: decisionDueDate,
    onChange: setDecisionDueDate,
    dark: dark,
    inp: inp,
    bord: bord,
    ink: ink,
    sub: sub,
    placeholder: "Select date"
  }), /*#__PURE__*/React.createElement("label", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 5,
      cursor: 'pointer',
      fontSize: '0.78rem',
      color: ink,
      fontFamily: C.fontSans
    }
  }, /*#__PURE__*/React.createElement("input", {
    type: "checkbox",
    checked: decisionHasTime,
    onChange: e => setDecisionHasTime(e.target.checked),
    style: {
      accentColor: C.navy,
      width: 15,
      height: 15
    }
  }), "Time")), decisionHasTime && /*#__PURE__*/React.createElement("input", {
    type: "time",
    value: decisionDueTime,
    onChange: e => setDecisionDueTime(e.target.value),
    style: {
      ...inp,
      marginTop: 8
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: '0.66rem',
      color: sub,
      lineHeight: 1.5,
      marginTop: 5,
      fontFamily: C.fontSans
    }
  }, "If set, this shows on the decision-maker's in-app calendar (not Google Calendar).")), field('Question', /*#__PURE__*/React.createElement("input", {
    value: decisionQuestion,
    onChange: e => setDecisionQuestion(e.target.value),
    placeholder: "What needs to be decided?",
    style: inp
  })), field('Options', /*#__PURE__*/React.createElement("div", null, decisionOptions.map((o, i) => /*#__PURE__*/React.createElement("div", {
    key: i,
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      marginBottom: 6
    }
  }, /*#__PURE__*/React.createElement("i", {
    className: o.is_chosen ? 'ti ti-circle-check-filled' : 'ti ti-circle',
    onClick: () => setChosen(i),
    title: "Mark as chosen",
    style: {
      fontSize: 19,
      cursor: 'pointer',
      color: o.is_chosen ? dark ? '#3FB36B' : '#1E6B40' : sub,
      flexShrink: 0
    }
  }), /*#__PURE__*/React.createElement("input", {
    value: o.body,
    onChange: e => updateOpt(i, e.target.value),
    placeholder: 'Option ' + String.fromCharCode(65 + i),
    style: inp
  }), /*#__PURE__*/React.createElement("i", {
    className: "ti ti-trash",
    onClick: () => removeOpt(i),
    style: {
      fontSize: 15,
      cursor: 'pointer',
      color: sub,
      flexShrink: 0
    }
  }))), /*#__PURE__*/React.createElement("button", {
    type: "button",
    onClick: addOpt,
    style: {
      marginTop: 2,
      display: 'inline-flex',
      alignItems: 'center',
      gap: 5,
      padding: '7px 12px',
      background: 'none',
      border: `1px dashed ${bord}`,
      borderRadius: 9,
      color: sub,
      fontSize: '0.78rem',
      cursor: 'pointer',
      fontFamily: C.fontSans
    }
  }, /*#__PURE__*/React.createElement("i", {
    className: "ti ti-plus",
    style: {
      fontSize: 13
    }
  }), "Add option"))))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 8,
      marginTop: 16
    }
  }, /*#__PURE__*/React.createElement("button", {
    onClick: save,
    disabled: saving || !title.trim(),
    style: {
      flex: 1,
      padding: '11px 16px',
      background: C.navy,
      color: '#fff',
      border: 'none',
      borderRadius: 22,
      fontSize: 13,
      fontWeight: 500,
      letterSpacing: '0.02em',
      cursor: 'pointer',
      fontFamily: C.fontSans,
      opacity: !title.trim() ? 0.5 : 1
    }
  }, saving ? 'Saving…' : task ? 'Save changes' : 'Create task'), /*#__PURE__*/React.createElement("button", {
    onClick: onCancel,
    style: {
      flex: 1,
      padding: '11px 16px',
      background: 'none',
      color: sub,
      border: `1px solid ${bord}`,
      borderRadius: 22,
      fontSize: 13,
      cursor: 'pointer',
      fontFamily: C.fontSans
    }
  }, "Cancel")));
}
function TaskDetail({
  dark,
  task,
  people,
  team,
  user,
  allTasks,
  onEdit,
  onDelete,
  onStatus,
  onOpenSubtask,
  emailLinks,
  onEmailChanged,
  initialTab,
  onTabSettled
}) {
  const [deleting, setDeleting] = useState(false);
  async function handleDelete() {
    if (deleting) return;
    if (!window.confirm('Delete "' + task.title + '"? This can\'t be undone.')) return;
    setDeleting(true);
    const {
      error
    } = await TaskDB.delete(task.id);
    setDeleting(false);
    if (error) {
      window.alert(error);
      return;
    }
    onDelete && onDelete();
  }
  const [detTab, setDetTab] = useState('details'); // 'details' | 'thread' | 'email'
  const emLinks = emailLinks || [];
  // Opened from the mailbox or a subject email icon — land on Email, not Details.
  useEffect(() => {
    if (initialTab) {
      setDetTab(initialTab);
      onTabSettled && onTabSettled();
    }
  }, [initialTab]);
  // Full message bodies for the primary linked thread — fetched lazily, only
  // once the Email tab is actually opened (not on every task-drawer open).
  const [emailThread, setEmailThread] = useState(null);
  const [emailBusy, setEmailBusy] = useState(false);
  const [emailErr, setEmailErr] = useState(null);
  const [expandedMsg, setExpandedMsg] = useState(null); // message id — only the latest is expanded by default
  const primaryLink = emLinks[0] || null;
  useEffect(() => {
    if (detTab !== 'email' || !primaryLink) {
      setEmailThread(null);
      return;
    }
    let cancelled = false;
    setEmailBusy(true);
    setEmailErr(null);
    callCalendar({
      action: 'gmail_thread',
      threadId: primaryLink.thread_id
    }).then(({
      ok,
      data
    }) => {
      if (cancelled) return;
      setEmailBusy(false);
      if (!ok) {
        setEmailErr(data?.error || 'Could not load this thread.');
        return;
      }
      setEmailThread(data.thread);
      const msgs = data.thread?.messages || [];
      setExpandedMsg(msgs.length ? msgs[msgs.length - 1].id : null);
    });
    return () => {
      cancelled = true;
    };
  }, [detTab, primaryLink && primaryLink.thread_id]);
  const [activity, setActivity] = useState([]);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [decisionOpts, setDecisionOpts] = useState([]);
  const [labelRows, setLabelRows] = useState([]);
  const [subs, setSubs] = useState([]);
  const [subTitle, setSubTitle] = useState('');
  const [addingSub, setAddingSub] = useState(false);
  // Dependencies (predecessor/successor)
  const [links, setLinks] = useState({
    predecessors: [],
    successors: []
  });
  const [linkPick, setLinkPick] = useState('');
  const [linkDir, setLinkDir] = useState('pred'); // 'pred' = picked comes before this; 'succ' = after
  // Thread
  const [summary, setSummary] = useState(task.context || '');
  const [mode, setMode] = useState('log'); // 'log' | 'assist'
  const [aiBusy, setAiBusy] = useState(false);
  const [sumBusy, setSumBusy] = useState(false);
  const [assist, setAssist] = useState([]);
  const [editId, setEditId] = useState(null);
  const [editText, setEditText] = useState('');
  const [decDraft, setDecDraft] = useState(null); // { question, options:[{text,checked}] }
  const [decBusy, setDecBusy] = useState(false);
  useEffect(() => {
    TaskDB.loadActivity(task.id).then(setActivity);
    TaskDB.loadDecisionOptions(task.id).then(setDecisionOpts);
    TaskDB.loadLabels(task.id).then(setLabelRows);
    TaskDB.loadSubtasks(task.id).then(setSubs);
    TaskDB.loadLinks(task.id).then(setLinks);
    TaskDB.loadAssist(task.id, user).then(setAssist);
    setSummary(task.context || '');
  }, [task.id]);
  const bord = dark ? '#152545' : '#E4DFD4',
    ink = dark ? '#fff' : '#001A4A',
    sub = dark ? 'rgba(255,255,255,0.5)' : '#6B6B6B';
  const gold = dark ? '#C9A45A' : '#AD832F';
  const nameOf = id => (team.find(m => m.id === id) || {}).name || '—';
  const ppl = role => (people || []).filter(p => p.role === role).map(p => nameOf(p.user_id)).join(', ') || '—';
  const fmt = d => d ? new Date(d).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  }) : '—';
  // Field-row/section-header/caption values ported from the prototype's
  // .field/.field .fk/.pblock .bh — these constants propagate through
  // every Details/Dependencies/Decision/Subtasks row below.
  const row = (k, v) => /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'grid',
      gridTemplateColumns: '120px 1fr',
      alignItems: 'center',
      gap: 8,
      padding: '11px 0',
      borderBottom: `1px solid ${bord}`,
      fontSize: 14
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 11,
      letterSpacing: '0.1em',
      textTransform: 'uppercase',
      color: sub,
      fontFamily: C.fontSans
    }
  }, k), /*#__PURE__*/React.createElement("span", {
    style: {
      color: ink,
      fontWeight: 500,
      fontFamily: C.fontSans,
      display: 'flex',
      alignItems: 'center',
      gap: 7
    }
  }, v));
  const kindTag = {
    system: {
      t: 'CHANGE',
      c: '#6B6B6B'
    },
    update: {
      t: 'UPDATE',
      c: '#2A6FD4'
    },
    ai: {
      t: 'AI',
      c: '#AD832F'
    }
  };
  const secHead = (icon, txt) => /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 7,
      marginBottom: 10
    }
  }, /*#__PURE__*/React.createElement("i", {
    className: `ti ${icon}`,
    style: {
      fontSize: 14,
      color: gold
    }
  }), /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 11,
      fontWeight: 600,
      letterSpacing: '0.14em',
      textTransform: 'uppercase',
      color: gold,
      fontFamily: C.fontSans
    }
  }, txt));
  const tinp = {
    padding: '8px 10px',
    background: dark ? '#06101F' : '#F7F4EE',
    border: `1px solid ${bord}`,
    borderRadius: 6,
    color: ink,
    fontSize: '0.82rem',
    outline: 'none',
    fontFamily: C.fontSans,
    boxSizing: 'border-box'
  };
  const cap = {
    fontSize: 11,
    color: sub,
    letterSpacing: '0.1em',
    textTransform: 'uppercase',
    fontWeight: 500,
    marginBottom: 4,
    fontFamily: C.fontSans
  };
  const hasDecision = decisionOpts.length > 0 || !!task.decision_question || ppl('decision_maker') !== '—' || !!task.decision_due_at;
  async function addSub() {
    if (!subTitle.trim() || addingSub) return;
    setAddingSub(true);
    try {
      await TaskDB.createSubtask(task.id, subTitle.trim(), user);
      setSubTitle('');
      setSubs(await TaskDB.loadSubtasks(task.id));
    } finally {
      setAddingSub(false);
    }
  }
  // ── Dependencies
  const titleOf = id => ((allTasks || []).find(t => t.id === id) || {}).title || '(task)';
  async function addDep() {
    if (!linkPick) return;
    if (linkDir === 'pred') await TaskDB.addLink(linkPick, task.id);else await TaskDB.addLink(task.id, linkPick);
    setLinkPick('');
    setLinks(await TaskDB.loadLinks(task.id));
  }
  async function removeDep(id) {
    await TaskDB.removeLink(id);
    setLinks(await TaskDB.loadLinks(task.id));
  }
  // ── Thread: summary (built from the shared activity feed, not the private AI Assist)
  async function refreshSummary(actList) {
    const list = actList || activity;
    if (!list.length || sumBusy) return;
    setSumBusy(true);
    try {
      const log = list.map(a => '[' + (a.kind || 'log').toUpperCase() + '] ' + a.content).join('\n');
      const text = await callAI([{
        role: 'user',
        content: 'Task: "' + task.title + '" (status: ' + statusLabel(task.status) + ')\n\nThread:\n' + log + '\n\nWrite a concise 2–3 sentence summary of where this stands and what is next. Plain text only.'
      }], 'You summarise a task thread in 2–3 plain sentences. Current status, key updates, next step. No bullets, no headers.');
      setSummary(text);
      await TaskDB.setThreadSummary(task.id, text);
    } catch (e) {/* silent — summary is best-effort */} finally {
      setSumBusy(false);
    }
  }
  // ── Thread: Log update (shared) — auto-refreshes the summary
  async function addNote() {
    if (!note.trim() || busy) return;
    setBusy(true);
    try {
      await TaskDB.addActivity(task.id, 'update', note.trim(), user);
      setNote('');
      const a = await TaskDB.loadActivity(task.id);
      setActivity(a);
      refreshSummary(a);
    } finally {
      setBusy(false);
    }
  }
  // ── Thread: AI Assist (private but synced) — Q&A NOT added to the shared feed
  async function sendAssist() {
    if (!note.trim() || aiBusy) return;
    const txt = note.trim();
    setAiBusy(true);
    setNote('');
    const uMsg = await TaskDB.addAssist(task.id, 'user', txt, user);
    setAssist(a => uMsg ? [...a, uMsg] : a);
    try {
      const sys = 'You are assisting with ONE task. Be concise and practical. If asked to draft something (email, message), produce it ready to use.\nTask: "' + task.title + '" | Status: ' + statusLabel(task.status) + '\nContext: ' + (summary || 'none') + '\nDecision: ' + (task.decision_question || 'none');
      const hist = [...assist, uMsg].filter(Boolean).slice(-10).map(m => ({
        role: m.role === 'ai' ? 'assistant' : 'user',
        content: m.content
      }));
      const reply = await callAI(hist, sys);
      const aMsg = await TaskDB.addAssist(task.id, 'ai', reply, user);
      setAssist(a => aMsg ? [...a, aMsg] : a);
    } catch (e) {
      const aMsg = await TaskDB.addAssist(task.id, 'ai', 'Error: ' + e.message, user);
      setAssist(a => aMsg ? [...a, aMsg] : a);
    } finally {
      setAiBusy(false);
    }
  }
  async function saveAssistEdit(id) {
    const item = assist.find(x => x.id === id);
    await TaskDB.updateAssistContent(id, editText);
    if (item && item.published && item.published_activity_id) {
      await TaskDB.updateActivityContent(item.published_activity_id, editText);
      setActivity(await TaskDB.loadActivity(task.id));
    }
    setEditId(null);
    setEditText('');
    setAssist(await TaskDB.loadAssist(task.id, user));
  }
  async function togglePublish(item) {
    if (item.published) await TaskDB.unpublishAssist(item);else await TaskDB.publishAssist(item, task.id, user);
    setAssist(await TaskDB.loadAssist(task.id, user));
    setActivity(await TaskDB.loadActivity(task.id));
  }
  // ── Thread: improve the decision from the thread
  async function improveDecision() {
    if (decBusy) return;
    setDecBusy(true);
    try {
      const log = activity.map(a => a.content).join('\n');
      const reply = await callAI([{
        role: 'user',
        content: 'Task: "' + task.title + '"\nContext: ' + (summary || 'none') + '\nCurrent decision question: ' + (task.decision_question || 'none') + '\nThread:\n' + log + '\n\nSuggest a concise decision question and 2–3 clear options reflecting the current state. Reply ONLY valid JSON: {"question":"...","options":["...","..."]}'
      }], 'You propose a decision question and options from a task thread. Reply only valid JSON, no preamble.');
      let parsed = null;
      try {
        parsed = JSON.parse((reply.match(/\{[\s\S]*\}/) || [reply])[0]);
      } catch (e) {}
      if (parsed && parsed.question) setDecDraft({
        question: parsed.question,
        options: (parsed.options || []).map(o => ({
          text: String(o),
          checked: true
        }))
      });
    } catch (e) {/* silent */} finally {
      setDecBusy(false);
    }
  }
  async function acceptDecision() {
    if (!decDraft) return;
    await TaskDB.update(task.id, task, {
      decision_question: decDraft.question
    }, user);
    await TaskDB.setDecisionOptions(task.id, decDraft.options.filter(o => o.checked).map(o => ({
      body: o.text,
      is_chosen: false
    })));
    setDecDraft(null);
    setDecisionOpts(await TaskDB.loadDecisionOptions(task.id));
    setActivity(await TaskDB.loadActivity(task.id));
  }
  const depRow = (linkId, otherId) => /*#__PURE__*/React.createElement("div", {
    key: linkId,
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      padding: '7px 10px',
      background: dark ? '#06101F' : '#fff',
      border: `1px solid ${bord}`,
      borderRadius: 9,
      marginBottom: 6
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      flex: 1,
      minWidth: 0,
      fontSize: '0.8rem',
      color: ink,
      fontFamily: C.fontSans,
      whiteSpace: 'nowrap',
      overflow: 'hidden',
      textOverflow: 'ellipsis'
    }
  }, titleOf(otherId)), /*#__PURE__*/React.createElement("i", {
    className: "ti ti-x",
    onClick: () => removeDep(linkId),
    style: {
      fontSize: 14,
      color: sub,
      cursor: 'pointer',
      flexShrink: 0
    }
  }));
  return /*#__PURE__*/React.createElement("div", {
    style: {
      padding: '22px 24px 60px'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'flex-start',
      gap: 12,
      marginBottom: 14
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      fontSize: 22,
      fontWeight: 500,
      color: ink,
      fontFamily: C.fontSans,
      lineHeight: 1.3,
      display: 'flex',
      alignItems: 'center',
      gap: 9
    }
  }, task.title, emLinks.length > 0 && /*#__PURE__*/React.createElement("i", {
    className: "ti ti-mail",
    title: "Has a linked email \u2014 view on the Email tab",
    onClick: () => setDetTab('email'),
    style: {
      fontSize: 17,
      color: dark ? '#7FA8DD' : '#185FA5',
      cursor: 'pointer',
      flexShrink: 0
    }
  })), /*#__PURE__*/React.createElement(CopyLinkBtn, {
    dark: dark,
    hash: 'task/' + task.id,
    title: "Copy a link straight to this task"
  }), /*#__PURE__*/React.createElement("button", {
    onClick: onEdit,
    style: {
      fontSize: 12,
      fontWeight: 400,
      letterSpacing: '0.08em',
      textTransform: 'uppercase',
      color: sub,
      background: dark ? '#0A1730' : '#fff',
      border: `1px solid ${bord}`,
      borderRadius: 6,
      padding: '7px 12px',
      cursor: 'pointer',
      fontFamily: C.fontSans,
      flexShrink: 0
    }
  }, "Edit"), /*#__PURE__*/React.createElement("button", {
    onClick: handleDelete,
    disabled: deleting,
    style: {
      fontSize: 12,
      fontWeight: 400,
      letterSpacing: '0.08em',
      textTransform: 'uppercase',
      color: '#C0392B',
      background: dark ? '#0A1730' : '#fff',
      border: '1px solid #C0392B55',
      borderRadius: 6,
      padding: '7px 12px',
      cursor: deleting ? 'default' : 'pointer',
      opacity: deleting ? 0.6 : 1,
      fontFamily: C.fontSans,
      flexShrink: 0
    }
  }, deleting ? 'Deleting…' : 'Delete')), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'grid',
      gridTemplateColumns: 'repeat(4, 1fr)',
      gap: 6,
      marginBottom: 22
    }
  }, TASK_STATUS.map(s => {
    const on = task.status === s.id;
    return /*#__PURE__*/React.createElement("button", {
      key: s.id,
      onClick: async () => {
        await onStatus(s.id);
        setActivity(await TaskDB.loadActivity(task.id));
      },
      style: {
        padding: '8px 4px',
        borderRadius: 6,
        border: `1px solid ${on ? s.border || s.color : bord}`,
        background: on ? dark ? s.color + '26' : s.bg : dark ? '#0A1730' : '#fff',
        color: on ? s.color : sub,
        fontSize: 12,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
        cursor: 'pointer',
        fontFamily: C.fontSans
      }
    }, /*#__PURE__*/React.createElement("span", {
      style: {
        width: 7,
        height: 7,
        borderRadius: '50%',
        background: on ? s.color : sub,
        flexShrink: 0
      }
    }), s.label);
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 6,
      marginBottom: 14
    }
  }, [['details', 'Details'], ['thread', 'Thread'], ['email', 'Email']].map(([id, label]) => {
    const cnt = id === 'thread' ? activity.length + emLinks.length : id === 'email' ? emLinks.length : 0;
    if (id === 'email' && !emLinks.length) return null;
    return /*#__PURE__*/React.createElement("button", {
      key: id,
      onClick: () => setDetTab(id),
      style: {
        flex: 1,
        padding: '7px 8px',
        borderRadius: 6,
        border: `1px solid ${detTab === id ? C.navy : bord}`,
        background: detTab === id ? C.navy : dark ? '#0A1730' : '#fff',
        color: detTab === id ? '#fff' : sub,
        fontSize: 12,
        fontWeight: 500,
        cursor: 'pointer',
        fontFamily: C.fontSans
      }
    }, label, cnt ? ' · ' + cnt : '');
  })), detTab === 'details' ? /*#__PURE__*/React.createElement(React.Fragment, null, labelRows.length > 0 && /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexWrap: 'wrap',
      gap: 6,
      marginBottom: 12
    }
  }, labelRows.map(r => {
    const mine = r.user_id === (user && user.id);
    return /*#__PURE__*/React.createElement("span", {
      key: r.id,
      style: {
        padding: '3px 9px',
        borderRadius: 16,
        fontSize: '0.7rem',
        fontWeight: 500,
        fontFamily: C.fontSans,
        background: mine ? dark ? 'rgba(201,164,90,0.15)' : '#F3EBDA' : dark ? 'rgba(255,255,255,0.06)' : '#F0EEEA',
        color: mine ? gold : sub
      }
    }, r.label);
  })), row('Due', fmt(task.due_at)), task.recurrence && task.recurrence !== 'none' ? row('Repeat', recurDesc(task)) : null, row('Project', task._projectName || '—'), row('Assignees', ppl('assignee')), row('Assigned by', ppl('assigner')), task.working_url ? row('Working URL', /*#__PURE__*/React.createElement("a", {
    href: task.working_url,
    target: "_blank",
    rel: "noopener noreferrer",
    style: {
      color: C.gold
    }
  }, "Open \u2197")) : null, emLinks.length > 0 ? row('Email link', /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("span", {
    onClick: () => setDetTab('email'),
    style: {
      color: '#185FA5',
      cursor: 'pointer',
      display: 'flex',
      alignItems: 'center',
      gap: 6,
      fontWeight: 500
    }
  }, /*#__PURE__*/React.createElement("i", {
    className: "ti ti-mail",
    style: {
      fontSize: 13
    }
  }), (emLinks[0].subject || '(no subject)').slice(0, 40), emLinks.length > 1 ? ' +' + (emLinks.length - 1) + ' more' : ''), /*#__PURE__*/React.createElement("i", {
    className: "ti ti-x",
    title: "Remove link",
    onClick: async () => {
      await TaskEmailDB.remove(emLinks[0].id);
      onEmailChanged && (await onEmailChanged());
    },
    style: {
      fontSize: 13,
      color: sub,
      cursor: 'pointer',
      marginLeft: 6
    }
  }))) : task.email_link ? row('Email link', /*#__PURE__*/React.createElement("a", {
    href: task.email_link,
    target: "_blank",
    rel: "noopener noreferrer",
    style: {
      color: C.gold
    }
  }, "Open \u2197")) : null, task.description ? /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 12
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: cap
  }, "Description"), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: '0.84rem',
      color: ink,
      lineHeight: 1.5,
      whiteSpace: 'pre-wrap',
      fontFamily: C.fontSans
    }
  }, task.description)) : null, /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 16,
      paddingTop: 14,
      borderTop: `1px solid ${bord}`
    }
  }, secHead('ti-arrows-split-2', 'Dependencies'), links.predecessors.length > 0 && /*#__PURE__*/React.createElement("div", {
    style: {
      marginBottom: 8
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: cap
  }, "Must come before this"), links.predecessors.map(l => depRow(l.id, l.predecessor_id))), links.successors.length > 0 && /*#__PURE__*/React.createElement("div", {
    style: {
      marginBottom: 8
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: cap
  }, "Comes after this"), links.successors.map(l => depRow(l.id, l.successor_id))), !links.predecessors.length && !links.successors.length && /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: '0.78rem',
      color: sub,
      fontFamily: C.fontSans,
      marginBottom: 8
    }
  }, "No dependencies."), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 6,
      flexWrap: 'wrap'
    }
  }, /*#__PURE__*/React.createElement("select", {
    value: linkDir,
    onChange: e => setLinkDir(e.target.value),
    style: {
      ...tinp,
      flex: '1 1 130px'
    }
  }, /*#__PURE__*/React.createElement("option", {
    value: "pred"
  }, "Predecessor (before)"), /*#__PURE__*/React.createElement("option", {
    value: "succ"
  }, "Successor (after)")), /*#__PURE__*/React.createElement("select", {
    value: linkPick,
    onChange: e => setLinkPick(e.target.value),
    style: {
      ...tinp,
      flex: '2 1 150px'
    }
  }, /*#__PURE__*/React.createElement("option", {
    value: ""
  }, "Pick a task\u2026"), (allTasks || []).filter(t => t.id !== task.id).map(t => /*#__PURE__*/React.createElement("option", {
    key: t.id,
    value: t.id
  }, t.title))), /*#__PURE__*/React.createElement("button", {
    onClick: addDep,
    disabled: !linkPick,
    style: {
      padding: '8px 13px',
      background: C.navy,
      color: '#fff',
      border: 'none',
      borderRadius: 9,
      fontSize: '0.8rem',
      fontWeight: 600,
      cursor: 'pointer',
      fontFamily: C.fontSans,
      opacity: !linkPick ? 0.5 : 1
    }
  }, "Link"))), hasDecision && /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 16,
      paddingTop: 14,
      borderTop: `1px solid ${bord}`
    }
  }, secHead('ti-gavel', 'Decision'), ppl('decision_maker') !== '—' ? row('Maker(s)', ppl('decision_maker')) : null, task.decision_due_at ? row('Decision due', task.decision_due_has_time ? fmt(task.decision_due_at) : new Date(task.decision_due_at).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric'
  })) : null, task.decision_question ? /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: '0.86rem',
      color: ink,
      fontWeight: 600,
      margin: '10px 0 8px',
      fontFamily: C.fontSans,
      lineHeight: 1.4
    }
  }, task.decision_question) : null, decisionOpts.map(o => /*#__PURE__*/React.createElement("div", {
    key: o.id,
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      padding: '7px 0',
      borderBottom: `1px solid ${bord}`
    }
  }, /*#__PURE__*/React.createElement("i", {
    className: o.is_chosen ? 'ti ti-circle-check-filled' : 'ti ti-circle',
    style: {
      fontSize: 17,
      color: o.is_chosen ? dark ? '#3FB36B' : '#1E6B40' : sub,
      flexShrink: 0
    }
  }), /*#__PURE__*/React.createElement("span", {
    style: {
      flex: 1,
      minWidth: 0,
      fontSize: '0.84rem',
      color: o.is_chosen ? ink : sub,
      fontWeight: o.is_chosen ? 600 : 400,
      fontFamily: C.fontSans
    }
  }, o.body), o.is_chosen && /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: '0.56rem',
      fontWeight: 700,
      letterSpacing: '0.08em',
      color: dark ? '#3FB36B' : '#1E6B40',
      fontFamily: C.fontSans,
      flexShrink: 0
    }
  }, "CHOSEN")))), /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 16,
      paddingTop: 14,
      borderTop: `1px solid ${bord}`
    }
  }, secHead('ti-subtask', subs.length ? 'Subtasks · ' + subs.length : 'Subtasks'), subs.map(s => /*#__PURE__*/React.createElement("div", {
    key: s.id,
    onClick: () => onOpenSubtask && onOpenSubtask(s),
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 10,
      padding: '8px 0',
      borderBottom: `1px solid ${bord}`,
      cursor: 'pointer'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      width: 6,
      height: 6,
      borderRadius: '50%',
      flexShrink: 0,
      background: priorityColor(s.priority)
    }
  }), /*#__PURE__*/React.createElement("span", {
    style: {
      flex: 1,
      minWidth: 0,
      fontSize: 14,
      color: s.status === 'done' ? sub : ink,
      fontFamily: C.fontSans,
      whiteSpace: 'nowrap',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      textDecoration: s.status === 'done' ? 'line-through' : 'none'
    }
  }, s.title), /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 11,
      fontWeight: 500,
      padding: '3px 9px',
      borderRadius: 20,
      background: statusBg(s.status),
      color: statusColor(s.status),
      border: `1px solid ${statusColor(s.status)}55`,
      fontFamily: C.fontSans,
      flexShrink: 0
    }
  }, statusLabel(s.status)))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 8,
      marginTop: 10
    }
  }, /*#__PURE__*/React.createElement("input", {
    value: subTitle,
    onChange: e => setSubTitle(e.target.value),
    onKeyDown: e => {
      if (e.key === 'Enter') addSub();
    },
    placeholder: "Add a subtask\u2026",
    style: {
      ...tinp,
      flex: 1,
      padding: '9px 11px'
    }
  }), /*#__PURE__*/React.createElement("button", {
    onClick: addSub,
    disabled: !subTitle.trim() || addingSub,
    style: {
      padding: '9px 13px',
      background: dark ? '#0A1730' : '#fff',
      border: `1px solid ${bord}`,
      borderRadius: 6,
      color: ink,
      fontSize: 13,
      fontWeight: 500,
      cursor: 'pointer',
      fontFamily: C.fontSans,
      opacity: !subTitle.trim() ? 0.5 : 1
    }
  }, "Add")))) : detTab === 'thread' ? /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    style: {
      background: dark ? '#0A1E44' : '#F3EBDA',
      border: `1px solid ${bord}`,
      borderRadius: 10,
      padding: '10px 12px',
      marginBottom: 14
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      marginBottom: 6
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: '0.6rem',
      fontWeight: 700,
      letterSpacing: '0.12em',
      textTransform: 'uppercase',
      color: gold,
      fontFamily: C.fontSans
    }
  }, "Current Summary"), /*#__PURE__*/React.createElement("button", {
    onClick: () => refreshSummary(),
    disabled: sumBusy,
    style: {
      fontSize: '0.68rem',
      fontWeight: 600,
      color: gold,
      background: 'none',
      border: `1px solid ${bord}`,
      borderRadius: 7,
      padding: '3px 9px',
      cursor: 'pointer',
      fontFamily: C.fontSans
    }
  }, sumBusy ? '…' : '↻ Refresh')), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: '0.82rem',
      color: summary ? ink : sub,
      lineHeight: 1.5,
      whiteSpace: 'pre-wrap',
      fontFamily: C.fontSans,
      fontStyle: summary ? 'normal' : 'italic'
    }
  }, summary || 'No summary yet — add an update and it’ll generate.')), /*#__PURE__*/React.createElement("button", {
    onClick: improveDecision,
    disabled: decBusy,
    style: {
      width: '100%',
      padding: '9px',
      background: dark ? '#06101F' : '#fff',
      border: `1px dashed ${gold}`,
      borderRadius: 9,
      color: gold,
      fontSize: '0.78rem',
      fontWeight: 600,
      cursor: 'pointer',
      fontFamily: C.fontSans,
      marginBottom: 12
    }
  }, decBusy ? 'Thinking…' : '✨ Improve decision from thread'), decDraft && /*#__PURE__*/React.createElement("div", {
    style: {
      border: `1px solid ${bord}`,
      borderRadius: 10,
      padding: '10px 12px',
      marginBottom: 14,
      background: dark ? '#06101F' : '#fff'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: cap
  }, "Suggested decision \u2014 edit, then save"), /*#__PURE__*/React.createElement("input", {
    value: decDraft.question,
    onChange: e => setDecDraft(d => ({
      ...d,
      question: e.target.value
    })),
    style: {
      ...tinp,
      width: '100%',
      fontWeight: 600
    }
  }), decDraft.options.map((o, i) => /*#__PURE__*/React.createElement("div", {
    key: i,
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      marginTop: 6
    }
  }, /*#__PURE__*/React.createElement("input", {
    type: "checkbox",
    checked: o.checked,
    onChange: () => setDecDraft(d => ({
      ...d,
      options: d.options.map((x, j) => j === i ? {
        ...x,
        checked: !x.checked
      } : x)
    })),
    style: {
      accentColor: C.navy,
      width: 15,
      height: 15,
      flexShrink: 0
    }
  }), /*#__PURE__*/React.createElement("input", {
    value: o.text,
    onChange: e => setDecDraft(d => ({
      ...d,
      options: d.options.map((x, j) => j === i ? {
        ...x,
        text: e.target.value
      } : x)
    })),
    style: {
      ...tinp,
      flex: 1
    }
  }))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 8,
      marginTop: 10
    }
  }, /*#__PURE__*/React.createElement("button", {
    onClick: acceptDecision,
    style: {
      padding: '7px 13px',
      background: C.navy,
      color: '#fff',
      border: 'none',
      borderRadius: 9,
      fontSize: '0.78rem',
      fontWeight: 600,
      cursor: 'pointer',
      fontFamily: C.fontSans
    }
  }, "Save to decision"), /*#__PURE__*/React.createElement("button", {
    onClick: () => setDecDraft(null),
    style: {
      padding: '7px 13px',
      background: 'none',
      color: sub,
      border: `1px solid ${bord}`,
      borderRadius: 9,
      fontSize: '0.78rem',
      fontWeight: 600,
      cursor: 'pointer',
      fontFamily: C.fontSans
    }
  }, "Cancel"))), secHead('ti-message-2', 'Thread'), activity.length === 0 && emLinks.length === 0 && /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: '0.78rem',
      color: sub,
      fontFamily: C.fontSans
    }
  }, "No activity yet."), [...activity.map(a => ({
    _t: a.created_at,
    _k: 'activity',
    a
  })), ...emLinks.map(l => ({
    _t: l.email_date || l.created_at,
    _k: 'email',
    l
  }))].sort((x, y) => new Date(x._t || 0) - new Date(y._t || 0)).map((item, i) => {
    if (item._k === 'email') {
      const l = item.l;
      return /*#__PURE__*/React.createElement("div", {
        key: 'em-' + l.id,
        style: {
          border: `1px solid ${bord}`,
          borderLeft: '3px solid #185FA5',
          borderRadius: 8,
          background: dark ? '#0A1730' : '#fff',
          padding: '12px 14px',
          margin: '8px 0'
        }
      }, /*#__PURE__*/React.createElement("div", {
        style: {
          display: 'flex',
          alignItems: 'center',
          gap: 9
        }
      }, /*#__PURE__*/React.createElement("svg", {
        viewBox: "0 0 48 48",
        style: {
          width: 18,
          height: 18
        }
      }, /*#__PURE__*/React.createElement("path", {
        fill: "#4285F4",
        d: "M44 8v2L24 24 44 8z"
      }), /*#__PURE__*/React.createElement("path", {
        fill: "#34A853",
        d: "M4 10v28a2 2 0 002 2h6V16z"
      }), /*#__PURE__*/React.createElement("path", {
        fill: "#FBBC05",
        d: "M44 10v28a2 2 0 01-2 2h-6V16z"
      }), /*#__PURE__*/React.createElement("path", {
        fill: "#C5221F",
        d: "M4 8l20 14L44 8"
      })), /*#__PURE__*/React.createElement("span", {
        style: {
          fontSize: 13,
          fontWeight: 500,
          fontFamily: C.fontSans,
          color: ink
        }
      }, l.from_addr), /*#__PURE__*/React.createElement("span", {
        style: {
          fontSize: 11,
          color: sub,
          marginLeft: 'auto',
          fontFamily: C.fontSans
        }
      }, fmt(l.email_date || l.created_at))), /*#__PURE__*/React.createElement("div", {
        style: {
          fontSize: 14,
          color: ink,
          margin: '7px 0 3px',
          fontWeight: 500,
          fontFamily: C.fontSans
        }
      }, l.subject), /*#__PURE__*/React.createElement("div", {
        style: {
          fontSize: 13,
          color: sub,
          fontFamily: C.fontSans
        }
      }, l.snippet), /*#__PURE__*/React.createElement("div", {
        style: {
          display: 'flex',
          gap: 14,
          marginTop: 9
        }
      }, /*#__PURE__*/React.createElement("a", {
        onClick: () => setDetTab('email'),
        style: {
          fontSize: 12,
          color: gold,
          display: 'inline-flex',
          alignItems: 'center',
          gap: 5,
          cursor: 'pointer',
          fontFamily: C.fontSans
        }
      }, /*#__PURE__*/React.createElement("i", {
        className: "ti ti-mail",
        style: {
          fontSize: 13
        }
      }), "View email"), /*#__PURE__*/React.createElement("a", {
        href: l.permalink,
        target: "_blank",
        rel: "noopener noreferrer",
        style: {
          fontSize: 12,
          color: gold,
          fontFamily: C.fontSans
        }
      }, "\u2197 Open in Gmail"), l.auto_linked && /*#__PURE__*/React.createElement("span", {
        style: {
          fontSize: 11,
          color: '#0F6E56',
          background: '#E6F2EC',
          border: '1px solid #A0D9C4',
          borderRadius: 4,
          padding: '1px 7px',
          fontFamily: C.fontSans
        }
      }, "\u25C6 Auto-linked")));
    }
    const a = item.a,
      tag = kindTag[a.kind] || kindTag.update;
    return /*#__PURE__*/React.createElement("div", {
      key: a.id,
      style: {
        display: 'flex',
        gap: 8,
        padding: '8px 0',
        borderBottom: `1px solid ${bord}`
      }
    }, /*#__PURE__*/React.createElement("span", {
      style: {
        flexShrink: 0,
        fontSize: '0.52rem',
        fontWeight: 700,
        letterSpacing: '0.06em',
        color: tag.c,
        background: tag.c + '1A',
        borderRadius: 6,
        padding: '2px 6px',
        height: 'fit-content',
        fontFamily: C.fontSans
      }
    }, tag.t), /*#__PURE__*/React.createElement("div", {
      style: {
        flex: 1,
        minWidth: 0
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: '0.8rem',
        color: ink,
        fontFamily: C.fontSans,
        lineHeight: 1.4,
        whiteSpace: 'pre-wrap'
      }
    }, a.content), /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: '0.64rem',
        color: sub,
        marginTop: 2,
        fontFamily: C.fontSans
      }
    }, a.author_name || 'System', " \xB7 ", fmt(a.created_at))));
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 14
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 6,
      marginBottom: 8
    }
  }, [['log', '📝 Log'], ['assist', '✨ AI Assist']].map(([id, label]) => /*#__PURE__*/React.createElement("button", {
    key: id,
    onClick: () => setMode(id),
    style: {
      flex: 1,
      padding: '6px 8px',
      borderRadius: 8,
      border: `1px solid ${mode === id ? C.navy : bord}`,
      background: mode === id ? C.navy : dark ? '#06101F' : '#fff',
      color: mode === id ? '#fff' : sub,
      fontSize: '0.72rem',
      fontWeight: 600,
      cursor: 'pointer',
      fontFamily: C.fontSans
    }
  }, label))), mode === 'assist' && /*#__PURE__*/React.createElement("div", {
    style: {
      border: `1px solid ${bord}`,
      borderRadius: 10,
      padding: '8px 10px',
      marginBottom: 8,
      background: dark ? '#06101F' : '#FCFBF8'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      ...cap,
      marginBottom: 6
    }
  }, "AI Assist \xB7 private to you"), assist.length === 0 && /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: '0.76rem',
      color: sub,
      fontFamily: C.fontSans
    }
  }, "Ask anything about this task \u2014 drafts, next steps, summaries. Only you see this."), assist.map(m => /*#__PURE__*/React.createElement("div", {
    key: m.id,
    style: {
      marginBottom: 8
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: '0.58rem',
      fontWeight: 700,
      letterSpacing: '0.06em',
      color: m.role === 'ai' ? gold : sub,
      fontFamily: C.fontSans,
      marginBottom: 2
    }
  }, m.role === 'ai' ? 'AI' : 'YOU'), editId === m.id ? /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("textarea", {
    value: editText,
    onChange: e => setEditText(e.target.value),
    rows: 3,
    style: {
      ...tinp,
      width: '100%',
      resize: 'vertical'
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 8,
      marginTop: 4
    }
  }, /*#__PURE__*/React.createElement("button", {
    onClick: () => saveAssistEdit(m.id),
    style: {
      fontSize: '0.7rem',
      fontWeight: 600,
      color: '#fff',
      background: C.navy,
      border: 'none',
      borderRadius: 7,
      padding: '4px 10px',
      cursor: 'pointer',
      fontFamily: C.fontSans
    }
  }, "Save"), /*#__PURE__*/React.createElement("button", {
    onClick: () => {
      setEditId(null);
      setEditText('');
    },
    style: {
      fontSize: '0.7rem',
      fontWeight: 600,
      color: sub,
      background: 'none',
      border: `1px solid ${bord}`,
      borderRadius: 7,
      padding: '4px 10px',
      cursor: 'pointer',
      fontFamily: C.fontSans
    }
  }, "Cancel"))) : /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: '0.8rem',
      color: ink,
      lineHeight: 1.45,
      whiteSpace: 'pre-wrap',
      fontFamily: C.fontSans
    }
  }, m.role === 'ai' ? /*#__PURE__*/React.createElement(MarkdownContent, {
    text: m.content
  }) : m.content), m.role === 'ai' && /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 12,
      marginTop: 4
    }
  }, /*#__PURE__*/React.createElement("span", {
    onClick: () => {
      setEditId(m.id);
      setEditText(m.content);
    },
    style: {
      fontSize: '0.68rem',
      color: gold,
      cursor: 'pointer',
      fontFamily: C.fontSans
    }
  }, "Edit"), /*#__PURE__*/React.createElement("label", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 4,
      fontSize: '0.68rem',
      color: sub,
      cursor: 'pointer',
      fontFamily: C.fontSans
    }
  }, /*#__PURE__*/React.createElement("input", {
    type: "checkbox",
    checked: !!m.published,
    onChange: () => togglePublish(m),
    style: {
      accentColor: C.navy,
      width: 13,
      height: 13
    }
  }), "Publish to thread"))))), aiBusy && /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: '0.76rem',
      color: sub,
      fontStyle: 'italic',
      fontFamily: C.fontSans
    }
  }, "AI is thinking\u2026")), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 8
    }
  }, /*#__PURE__*/React.createElement("input", {
    value: note,
    onChange: e => setNote(e.target.value),
    onKeyDown: e => {
      if (e.key === 'Enter') {
        mode === 'assist' ? sendAssist() : addNote();
      }
    },
    placeholder: mode === 'assist' ? 'Ask AI about this task…' : 'Add an update…',
    style: {
      ...tinp,
      flex: 1,
      padding: '9px 11px',
      fontSize: '0.84rem'
    }
  }), /*#__PURE__*/React.createElement("button", {
    onClick: () => mode === 'assist' ? sendAssist() : addNote(),
    disabled: !note.trim() || busy || aiBusy,
    style: {
      padding: '9px 14px',
      background: C.navy,
      color: '#fff',
      border: 'none',
      borderRadius: 9,
      fontSize: '0.82rem',
      fontWeight: 600,
      cursor: 'pointer',
      fontFamily: C.fontSans,
      opacity: !note.trim() ? 0.5 : 1
    }
  }, mode === 'assist' ? 'Ask' : 'Post')))) : /*#__PURE__*/React.createElement(React.Fragment, null, !primaryLink ? /*#__PURE__*/React.createElement("div", {
    style: {
      color: sub,
      fontFamily: C.serif,
      fontStyle: 'italic',
      fontSize: 16
    }
  }, "No email linked. Attach a thread from the mailbox to see the full conversation here.") : emailBusy ? /*#__PURE__*/React.createElement("div", {
    style: {
      color: sub,
      fontSize: '0.82rem',
      fontFamily: C.fontSans
    }
  }, "Loading\u2026") : emailErr ? /*#__PURE__*/React.createElement("div", {
    style: {
      color: sub,
      fontSize: '0.82rem',
      fontFamily: C.fontSans
    }
  }, emailErr) : emailThread ? /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 10,
      paddingBottom: 12,
      borderBottom: `1px solid ${bord}`,
      marginBottom: 4
    }
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 16,
      fontWeight: 500,
      color: ink,
      fontFamily: C.fontSans
    }
  }, emailThread.subject), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 12,
      color: sub,
      fontFamily: C.fontSans
    }
  }, emailThread.messages.length, " message", emailThread.messages.length > 1 ? 's' : '', " \xB7 linked to this task")), /*#__PURE__*/React.createElement("a", {
    href: emailThread.permalink,
    target: "_blank",
    rel: "noopener noreferrer",
    style: {
      fontSize: 12,
      color: gold,
      marginLeft: 'auto',
      fontFamily: C.fontSans,
      flexShrink: 0
    }
  }, "Open in Gmail \u2197")), emailThread.messages.map((m, i) => {
    const open = expandedMsg === m.id;
    const last = i === emailThread.messages.length - 1;
    return /*#__PURE__*/React.createElement("div", {
      key: m.id,
      style: {
        borderBottom: `1px solid ${bord}`,
        padding: '13px 0'
      }
    }, /*#__PURE__*/React.createElement("div", {
      onClick: () => setExpandedMsg(open ? null : m.id),
      style: {
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        cursor: 'pointer'
      }
    }, /*#__PURE__*/React.createElement("span", {
      style: {
        width: 30,
        height: 30,
        borderRadius: '50%',
        background: 'linear-gradient(135deg,#c9a45a,#8a6a24)',
        color: '#fff',
        fontSize: 11,
        display: 'grid',
        placeItems: 'center',
        flexShrink: 0
      }
    }, (m.from || '?').trim().charAt(0).toUpperCase()), /*#__PURE__*/React.createElement("div", {
      style: {
        minWidth: 0
      }
    }, /*#__PURE__*/React.createElement("span", {
      style: {
        fontSize: 13,
        fontWeight: 500,
        color: ink,
        fontFamily: C.fontSans
      }
    }, m.from), ' ', /*#__PURE__*/React.createElement("span", {
      style: {
        fontSize: 11,
        color: sub,
        fontFamily: C.fontSans
      }
    }, m.to)), /*#__PURE__*/React.createElement("span", {
      style: {
        fontSize: 11,
        color: sub,
        marginLeft: 'auto',
        flexShrink: 0,
        fontFamily: C.fontSans
      }
    }, m.date)), open && /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: '0.84rem',
        color: ink,
        lineHeight: 1.65,
        padding: '10px 0 0 40px',
        fontFamily: C.fontSans,
        whiteSpace: 'pre-wrap'
      }
    }, m.bodyText || m.snippet, last && /*#__PURE__*/React.createElement("div", {
      style: {
        display: 'flex',
        gap: 9,
        marginTop: 14
      }
    }, /*#__PURE__*/React.createElement("a", {
      href: emailThread.permalink,
      target: "_blank",
      rel: "noopener noreferrer",
      title: "Opens this thread in Gmail",
      style: {
        height: 32,
        padding: '0 13px',
        border: `1px solid ${bord}`,
        borderRadius: 6,
        fontSize: 12,
        letterSpacing: '0.05em',
        textTransform: 'uppercase',
        color: sub,
        display: 'inline-flex',
        alignItems: 'center',
        gap: 7,
        fontFamily: C.fontSans,
        textDecoration: 'none'
      }
    }, "\u21A9 Reply"), /*#__PURE__*/React.createElement("a", {
      href: emailThread.permalink,
      target: "_blank",
      rel: "noopener noreferrer",
      title: "Opens this thread in Gmail",
      style: {
        height: 32,
        padding: '0 13px',
        border: `1px solid ${bord}`,
        borderRadius: 6,
        fontSize: 12,
        letterSpacing: '0.05em',
        textTransform: 'uppercase',
        color: sub,
        display: 'inline-flex',
        alignItems: 'center',
        gap: 7,
        fontFamily: C.fontSans,
        textDecoration: 'none'
      }
    }, "\u21A9 Reply all"), /*#__PURE__*/React.createElement("button", {
      onClick: async () => {
        await TaskDB.createSubtask(task.id, (m.subject || emailThread.subject || 'Follow up').slice(0, 120), user);
        setSubs(await TaskDB.loadSubtasks(task.id));
      },
      style: {
        height: 32,
        padding: '0 13px',
        border: `1px solid ${bord}`,
        borderRadius: 6,
        fontSize: 12,
        letterSpacing: '0.05em',
        textTransform: 'uppercase',
        color: sub,
        display: 'inline-flex',
        alignItems: 'center',
        gap: 7,
        cursor: 'pointer',
        background: 'none',
        fontFamily: C.fontSans
      }
    }, "\u270E Turn into subtask"))));
  }), emLinks.length > 1 && /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 14,
      fontSize: 12,
      color: sub,
      fontFamily: C.fontSans
    }
  }, "+", emLinks.length - 1, " more linked thread(s)"), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 12,
      color: sub,
      marginTop: 14,
      fontFamily: C.fontSans
    }
  }, "Read-only mirror of Gmail. Replies open Gmail with the thread pre-loaded, so the task keeps the record without becoming a second inbox.")) : null));
}

// Manage your own labels (rename / delete across all your tasks).
// User-level label palette (names sync to tasks via task_labels; colors are
// a personal display preference kept in localStorage). Tasks can be shared,
// so each teammate manages their own labels/colors.
const LABEL_COLORS = ['#E24B4A', '#E0A93B', '#378ADD', '#7F77DD', '#1D9E75', '#E07B00', '#D4537E', '#6B7280', '#2BA8A0', '#9B5DE5', '#3BB0C9', '#7FB800'];
const labelKey = uid => 'tmg-labels-' + (uid || 'anon');
function LabelManager({
  dark,
  user,
  onClose
}) {
  const J = C.fontSans;
  const uid = user && user.id;
  const [items, setItems] = useState(null); // [{ name, color, _orig }]
  const [origNames, setOrigNames] = useState([]);
  const [saving, setSaving] = useState(false);
  const ink = dark ? '#fff' : '#001A4A',
    sub = dark ? 'rgba(255,255,255,0.5)' : '#6B6B6B',
    bord = dark ? '#152545' : '#E4DFD4';
  const fieldBg = dark ? '#06101F' : '#FFFFFF',
    rowBg = dark ? '#0A1730' : '#F7F4EE';
  useEffect(() => {
    (async () => {
      let saved = [];
      try {
        saved = JSON.parse(localStorage.getItem(labelKey(uid)) || '[]') || [];
      } catch (e) {}
      const names = await TaskDB.myLabelNames(uid);
      const have = {};
      saved.forEach(s => {
        have[s.name] = true;
      });
      const merged = saved.map(s => ({
        name: s.name,
        color: s.color || LABEL_COLORS[1],
        _orig: s.name
      }));
      names.forEach(n => {
        if (!have[n]) merged.push({
          name: n,
          color: LABEL_COLORS[1],
          _orig: n
        });
      });
      setItems(merged);
      setOrigNames(names);
    })();
  }, []);
  const update = (i, patch) => setItems(its => its.map((x, j) => j === i ? {
    ...x,
    ...patch
  } : x));
  const add = () => setItems(its => [...(its || []), {
    name: '',
    color: LABEL_COLORS[0],
    _orig: null
  }]);
  const remove = i => setItems(its => its.filter((_, j) => j !== i));
  async function save() {
    setSaving(true);
    const clean = (items || []).map(x => ({
      name: (x.name || '').trim(),
      color: x.color,
      _orig: x._orig
    })).filter(x => x.name);
    const seen = {},
      final = [];
    clean.forEach(x => {
      const k = x.name.toLowerCase();
      if (!seen[k]) {
        seen[k] = 1;
        final.push(x);
      }
    });
    try {
      for (const x of final) {
        if (x._orig && x._orig !== x.name && origNames.indexOf(x._orig) !== -1) await TaskDB.renameLabel(uid, x._orig, x.name);
      }
      const keep = new Set(final.map(x => x.name)),
        keepOrig = new Set(final.map(x => x._orig).filter(Boolean));
      for (const n of origNames) {
        if (!keep.has(n) && !keepOrig.has(n)) await TaskDB.deleteLabel(uid, n);
      }
    } catch (e) {
      console.error('[LabelManager] sync:', e);
    }
    try {
      localStorage.setItem(labelKey(uid), JSON.stringify(final.map(x => ({
        name: x.name,
        color: x.color
      }))));
    } catch (e) {}
    setSaving(false);
    onClose();
  }
  return /*#__PURE__*/React.createElement("div", {
    style: {
      padding: '12px 14px 24px',
      fontFamily: J
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: '0.72rem',
      color: sub,
      lineHeight: 1.5,
      marginBottom: 12
    }
  }, "Your personal labels \u2014 names sync across your tasks, colors are just yours. Each teammate manages their own."), items === null ? /*#__PURE__*/React.createElement("div", {
    style: {
      color: sub,
      fontSize: '0.82rem',
      padding: 8
    }
  }, "Loading\u2026") : /*#__PURE__*/React.createElement(React.Fragment, null, items.length === 0 && /*#__PURE__*/React.createElement("div", {
    style: {
      color: sub,
      fontSize: '0.8rem',
      padding: '6px 2px 12px'
    }
  }, "No labels yet \u2014 tap \u201CAdd label\u201D to create one."), items.map((it, i) => /*#__PURE__*/React.createElement("div", {
    key: i,
    style: {
      background: rowBg,
      border: `1px solid ${bord}`,
      borderRadius: 12,
      padding: 10,
      marginBottom: 9
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 9
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      width: 26,
      height: 26,
      borderRadius: 8,
      flexShrink: 0,
      background: it.color
    }
  }), /*#__PURE__*/React.createElement("input", {
    value: it.name,
    onChange: e => update(i, {
      name: e.target.value
    }),
    placeholder: "Label name",
    style: {
      flex: 1,
      minWidth: 0,
      padding: '8px 11px',
      background: fieldBg,
      border: `1px solid ${bord}`,
      borderRadius: 9,
      color: ink,
      fontSize: '0.86rem',
      outline: 'none',
      fontFamily: J
    }
  }), /*#__PURE__*/React.createElement("i", {
    className: "ti ti-x",
    onClick: () => remove(i),
    title: "Remove",
    style: {
      fontSize: 16,
      cursor: 'pointer',
      color: sub,
      flexShrink: 0
    }
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexWrap: 'wrap',
      gap: 7,
      marginTop: 9
    }
  }, LABEL_COLORS.map(c => {
    const on = it.color === c;
    return /*#__PURE__*/React.createElement("button", {
      key: c,
      onClick: () => update(i, {
        color: c
      }),
      "aria-label": "Pick color",
      style: {
        width: 26,
        height: 26,
        borderRadius: 8,
        cursor: 'pointer',
        background: c,
        border: on ? `2px solid ${ink}` : '2px solid transparent',
        padding: 0
      }
    });
  })))), /*#__PURE__*/React.createElement("button", {
    onClick: add,
    style: {
      width: '100%',
      padding: 10,
      borderRadius: 10,
      border: `1px dashed ${bord}`,
      background: 'none',
      color: sub,
      cursor: 'pointer',
      fontFamily: J,
      fontSize: '0.8rem',
      fontWeight: 600,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 6,
      marginBottom: 14
    }
  }, /*#__PURE__*/React.createElement("i", {
    className: "ti ti-plus",
    style: {
      fontSize: 14
    }
  }), "Add label"), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 8
    }
  }, /*#__PURE__*/React.createElement("button", {
    onClick: onClose,
    style: {
      flex: 1,
      padding: 11,
      borderRadius: 11,
      border: `1px solid ${bord}`,
      background: 'none',
      color: sub,
      cursor: 'pointer',
      fontFamily: J,
      fontSize: '0.85rem',
      fontWeight: 600
    }
  }, "Cancel"), /*#__PURE__*/React.createElement("button", {
    onClick: save,
    disabled: saving,
    style: {
      flex: 1,
      padding: 11,
      borderRadius: 11,
      border: 'none',
      background: C.navy,
      color: '#fff',
      cursor: saving ? 'default' : 'pointer',
      fontFamily: J,
      fontSize: '0.85rem',
      fontWeight: 600
    }
  }, saving ? 'Saving…' : 'Save changes'))));
}

// ─── CTC Emails tab ──────────────────────────────────────────────────
// One consolidated list of mail received by Sales Agents and Transaction
// Coordinators. Claude SUGGESTS which CTC file each belongs to plus a
// one-line update for that file's Overview; a human approves or rejects.
// Nothing is ever filed automatically.
//
// Reads come straight from ctc_emails (SELECT-only RLS for active users).
// Every write goes through callCtcEmails — see the note on that helper.
function CtcEmailsTab({
  dark,
  user,
  files,
  onFiled
}) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('open'); // 'open' | 'all' | 'filed'
  const [busyId, setBusyId] = useState(null);
  const [err, setErr] = useState('');
  const [triaging, setTriaging] = useState(false);
  const bord = dark ? '#152545' : '#E4DFD4',
    ink = dark ? '#fff' : '#001A4A',
    sub = dark ? 'rgba(255,255,255,0.5)' : '#6B6B6B';
  const gold = dark ? '#C9A45A' : '#AD832F',
    teal = '#0F6E56';
  const nameOfFile = id => (files.find(f => f.id === id) || {}).name || '';
  async function load() {
    const c = window.SupabaseAuth?._client;
    if (!c) {
      setLoading(false);
      return;
    }
    const q = c.from('ctc_emails').select('*').order('email_date', {
      ascending: false
    }).limit(200);
    const {
      data,
      error
    } = await q;
    if (error) setErr(error.message);
    setRows(data || []);
    setLoading(false);
  }
  useEffect(() => {
    load();
  }, []);
  async function act(payload, id) {
    setBusyId(id);
    setErr('');
    const {
      ok,
      data
    } = await callCtcEmails(payload);
    setBusyId(null);
    if (!ok) {
      setErr(data.error || 'That did not go through.');
      return false;
    }
    await load();
    if (onFiled) onFiled();
    return true;
  }
  async function runTriage() {
    setTriaging(true);
    setErr('');
    const {
      ok,
      data
    } = await callCtcEmails({
      action: 'triage',
      limit: 20
    });
    setTriaging(false);
    if (!ok) {
      setErr(data.error || 'Triage failed.');
      return;
    }
    load();
  }
  const shown = rows.filter(r => filter === 'all' ? true : filter === 'filed' ? r.status === 'approved' : r.status === 'new' || r.status === 'suggested');
  const fmt = d => d ? new Date(d).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  }) : '';
  const chip = (id, label, n) => /*#__PURE__*/React.createElement("div", {
    key: id,
    onClick: () => setFilter(id),
    style: {
      padding: '6px 12px',
      borderRadius: 16,
      fontSize: 12,
      cursor: 'pointer',
      fontFamily: C.fontSans,
      border: `1px solid ${filter === id ? C.navy : bord}`,
      background: filter === id ? C.navy : 'transparent',
      color: filter === id ? '#fff' : sub
    }
  }, label, n != null ? ' · ' + n : '');
  return /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      minHeight: 0,
      overflowY: 'auto',
      padding: '14px 20px 30px'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      flexWrap: 'wrap',
      marginBottom: 12
    }
  }, chip('open', 'Needs filing', rows.filter(r => r.status === 'new' || r.status === 'suggested').length), chip('filed', 'Filed', rows.filter(r => r.status === 'approved').length), chip('all', 'All', rows.length), /*#__PURE__*/React.createElement("button", {
    onClick: runTriage,
    disabled: triaging,
    style: {
      marginLeft: 'auto',
      padding: '7px 12px',
      borderRadius: 6,
      border: `1px solid ${bord}`,
      background: dark ? '#0A1730' : '#fff',
      color: gold,
      fontSize: 12,
      cursor: triaging ? 'default' : 'pointer',
      fontFamily: C.fontSans,
      display: 'flex',
      alignItems: 'center',
      gap: 6
    }
  }, /*#__PURE__*/React.createElement("i", {
    className: triaging ? 'ti ti-loader-2' : 'ti ti-sparkles',
    style: {
      fontSize: 13,
      animation: triaging ? 'spin 1s linear infinite' : 'none'
    }
  }), triaging ? 'Reading…' : 'Suggest matches')), err && /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 12.5,
      color: '#9B1C1C',
      marginBottom: 10,
      fontFamily: C.fontSans
    }
  }, err), loading ? /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 13,
      color: sub,
      fontFamily: C.fontSans
    }
  }, "Loading emails\u2026") : !rows.length ? /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 13,
      color: sub,
      fontFamily: C.fontSans,
      lineHeight: 1.6,
      maxWidth: 620
    }
  }, "No emails collected yet. Mail is pulled from Sales Agent and Transaction Coordinator mailboxes every 15 minutes \u2014 but only for people an admin has switched on ", /*#__PURE__*/React.createElement("em", null, "and"), " who have connected their own Google account in the app. Nobody's mailbox is read without both.") : !shown.length ? /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 13,
      color: sub,
      fontFamily: C.fontSans
    }
  }, "Nothing here.") : shown.map(r => {
    const suggested = r.suggested_project_id ? nameOfFile(r.suggested_project_id) : '';
    const filed = r.status === 'approved';
    const busy = busyId === r.id;
    return /*#__PURE__*/React.createElement("div", {
      key: r.id,
      style: {
        border: `1px solid ${bord}`,
        borderRadius: 10,
        padding: 13,
        marginBottom: 9,
        background: dark ? '#0A1730' : '#fff'
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        display: 'flex',
        alignItems: 'baseline',
        gap: 8,
        flexWrap: 'wrap'
      }
    }, /*#__PURE__*/React.createElement("span", {
      style: {
        fontSize: 14,
        fontWeight: 500,
        color: ink,
        fontFamily: C.fontSans
      }
    }, r.subject || '(no subject)'), /*#__PURE__*/React.createElement("span", {
      style: {
        fontSize: 11.5,
        color: sub,
        fontFamily: C.fontSans,
        marginLeft: 'auto'
      }
    }, fmt(r.email_date))), /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 12.5,
        color: sub,
        fontFamily: C.fontSans,
        marginTop: 3
      }
    }, r.from_name || r.from_addr, r.from_name && r.from_addr ? ' · ' + r.from_addr : '', " \u2192 ", r.mailbox_email), r.snippet && /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 12.5,
        color: ink,
        opacity: 0.8,
        fontFamily: C.fontSans,
        marginTop: 6,
        lineHeight: 1.5
      }
    }, r.snippet), filed ? /*#__PURE__*/React.createElement("div", {
      style: {
        marginTop: 9,
        fontSize: 12.5,
        color: teal,
        fontFamily: C.fontSans,
        display: 'flex',
        alignItems: 'center',
        gap: 6
      }
    }, /*#__PURE__*/React.createElement("i", {
      className: "ti ti-check",
      style: {
        fontSize: 13
      }
    }), "Filed to ", nameOfFile(r.linked_project_id) || 'a file') : r.status === 'rejected' ? /*#__PURE__*/React.createElement("div", {
      style: {
        marginTop: 9,
        fontSize: 12.5,
        color: sub,
        fontFamily: C.fontSans
      }
    }, "Dismissed.") : r.status === 'no_match' ? /*#__PURE__*/React.createElement("div", {
      style: {
        marginTop: 9,
        fontSize: 12.5,
        color: sub,
        fontFamily: C.fontSans
      }
    }, "No matching CTC file suggested.") : suggested ? /*#__PURE__*/React.createElement("div", {
      style: {
        marginTop: 10,
        padding: 10,
        borderRadius: 8,
        background: dark ? 'rgba(201,164,90,0.10)' : '#F7F4EE',
        border: `1px solid ${bord}`
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 11,
        letterSpacing: '0.1em',
        textTransform: 'uppercase',
        color: gold,
        fontWeight: 600,
        fontFamily: C.fontSans,
        marginBottom: 5
      }
    }, "Suggested \xB7 ", suggested, r.suggested_confidence != null ? ' · ' + Math.round(Number(r.suggested_confidence) * 100) + '%' : ''), r.suggested_note && /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 12.5,
        color: ink,
        fontFamily: C.fontSans,
        lineHeight: 1.5
      }
    }, r.suggested_note), /*#__PURE__*/React.createElement("div", {
      style: {
        display: 'flex',
        gap: 8,
        marginTop: 9
      }
    }, /*#__PURE__*/React.createElement("button", {
      disabled: busy,
      onClick: () => act({
        action: 'approve',
        email_id: r.id
      }, r.id),
      style: {
        padding: '6px 12px',
        borderRadius: 6,
        border: 'none',
        background: C.navy,
        color: '#fff',
        fontSize: 12,
        cursor: busy ? 'default' : 'pointer',
        fontFamily: C.fontSans,
        opacity: busy ? 0.6 : 1
      }
    }, busy ? 'Filing…' : 'File it'), /*#__PURE__*/React.createElement("button", {
      disabled: busy,
      onClick: () => act({
        action: 'reject',
        email_id: r.id
      }, r.id),
      style: {
        padding: '6px 12px',
        borderRadius: 6,
        border: `1px solid ${bord}`,
        background: 'none',
        color: sub,
        fontSize: 12,
        cursor: busy ? 'default' : 'pointer',
        fontFamily: C.fontSans
      }
    }, "Dismiss"), r.permalink && /*#__PURE__*/React.createElement("a", {
      href: r.permalink,
      target: "_blank",
      rel: "noreferrer",
      style: {
        padding: '6px 12px',
        borderRadius: 6,
        border: `1px solid ${bord}`,
        color: sub,
        fontSize: 12,
        textDecoration: 'none',
        fontFamily: C.fontSans
      }
    }, "Open in Gmail"))) : /*#__PURE__*/React.createElement("div", {
      style: {
        marginTop: 9,
        display: 'flex',
        gap: 8,
        alignItems: 'center'
      }
    }, /*#__PURE__*/React.createElement("span", {
      style: {
        fontSize: 12.5,
        color: sub,
        fontFamily: C.fontSans
      }
    }, "Not looked at yet."), r.permalink && /*#__PURE__*/React.createElement("a", {
      href: r.permalink,
      target: "_blank",
      rel: "noreferrer",
      style: {
        fontSize: 12,
        color: gold,
        textDecoration: 'none',
        fontFamily: C.fontSans
      }
    }, "Open in Gmail")));
  }));
}

// ─── Link to Zoho Projects (CTC files only) ─────────────────────────
// Picks a real Zoho Projects project to tie this CTC file to (plan:
// hidden-wiggling-lamport §3.7). Field/task sync only turns on once
// zoho_sync_enabled is written — this modal is the one place that flips it.
function ZohoLinkModal({
  dark,
  project,
  onClose,
  onLinked
}) {
  const [state, setState] = useState('loading'); // 'loading' | 'not_configured' | 'error' | 'list' | 'linking'
  const [projects, setProjects] = useState([]);
  const [query, setQuery] = useState('');
  const [errMsg, setErrMsg] = useState('');
  const ink = dark ? '#fff' : '#001A4A';
  const sub = dark ? 'rgba(255,255,255,0.5)' : '#6B6B6B';
  const bord = dark ? '#152545' : '#E4DFD4';
  useEffect(() => {
    let on = true;
    (async () => {
      const {
        ok,
        data
      } = await callZohoProjects({
        action: 'list_projects'
      });
      if (!on) return;
      if (!ok) {
        if (/not configured/i.test(data.error || '')) setState('not_configured');else {
          setErrMsg(data.error || 'Could not reach Zoho Projects.');
          setState('error');
        }
        return;
      }
      setProjects(data.projects || []);
      setState('list');
    })();
    return () => {
      on = false;
    };
  }, []);
  async function link(zp) {
    setState('linking');
    try {
      const tl = await callZohoProjects({
        action: 'list_tasklists',
        project_id: zp.id
      });
      let tasklistId = tl.ok && tl.data.tasklists && tl.data.tasklists[0] ? tl.data.tasklists[0].id : null;
      if (!tasklistId) {
        const created = await callZohoProjects({
          action: 'create_tasklist',
          project_id: zp.id,
          name: 'TMG Tasks'
        });
        if (created.ok) tasklistId = created.data.id;
      }
      await ProjectDB.update(project.id, {
        zoho_project_id: zp.id,
        zoho_tasklist_id: tasklistId || null,
        zoho_sync_enabled: true
      });
      onLinked();
    } catch (e) {
      setErrMsg('Link failed: ' + (e && e.message ? e.message : e));
      setState('list');
    }
  }
  const filtered = query.trim() ? projects.filter(p => (p.name || '').toLowerCase().includes(query.trim().toLowerCase())) : projects;
  return /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    onClick: onClose,
    style: {
      position: 'fixed',
      inset: 0,
      zIndex: 80,
      background: 'rgba(0,0,0,0.5)'
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'fixed',
      left: 0,
      right: 0,
      bottom: 0,
      zIndex: 81,
      maxHeight: '80%',
      background: dark ? '#0A1730' : '#FFFFFF',
      borderTopLeftRadius: 20,
      borderTopRightRadius: 20,
      display: 'flex',
      flexDirection: 'column',
      overflow: 'hidden'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      padding: '14px 16px',
      borderBottom: `1px solid ${bord}`
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: C.fontSans,
      fontSize: 15,
      fontWeight: 600,
      color: ink
    }
  }, "Link to Zoho Projects"), /*#__PURE__*/React.createElement("button", {
    onClick: onClose,
    style: {
      background: 'none',
      border: 'none',
      cursor: 'pointer',
      color: sub,
      fontSize: 18,
      display: 'flex'
    }
  }, /*#__PURE__*/React.createElement("i", {
    className: "ti ti-x"
  }))), /*#__PURE__*/React.createElement("div", {
    style: {
      padding: 16,
      overflowY: 'auto'
    }
  }, state === 'loading' && /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: C.fontSans,
      fontSize: 13.5,
      color: sub
    }
  }, "Loading your Zoho Projects\u2026"), state === 'not_configured' && /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: C.fontSans,
      fontSize: 13.5,
      color: sub,
      lineHeight: 1.6
    }
  }, "Zoho Projects isn't connected yet \u2014 an admin needs to set up the connection first (one-time setup, done outside the app). Ask Symon."), state === 'error' && /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: C.fontSans,
      fontSize: 13.5,
      color: '#9B1C1C'
    }
  }, errMsg), state === 'linking' && /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: C.fontSans,
      fontSize: 13.5,
      color: sub
    }
  }, "Linking\u2026"), state === 'list' && /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("input", {
    autoFocus: true,
    value: query,
    onChange: e => setQuery(e.target.value),
    placeholder: "Search Zoho projects\u2026",
    style: {
      width: '100%',
      padding: '10px 12px',
      border: `1px solid ${bord}`,
      borderRadius: 8,
      background: dark ? '#06101F' : '#fff',
      color: ink,
      fontSize: 14,
      outline: 'none',
      fontFamily: C.fontSans,
      marginBottom: 10,
      boxSizing: 'border-box'
    }
  }), errMsg && /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: C.fontSans,
      fontSize: 12.5,
      color: '#9B1C1C',
      marginBottom: 8
    }
  }, errMsg), filtered.length === 0 && /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: C.fontSans,
      fontSize: 13,
      color: sub
    }
  }, "No matching Zoho projects."), filtered.map(zp => /*#__PURE__*/React.createElement("div", {
    key: zp.id,
    onClick: () => link(zp),
    style: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      padding: '11px 4px',
      borderBottom: `1px solid ${bord}`,
      cursor: 'pointer',
      fontFamily: C.fontSans,
      fontSize: 13.5,
      color: ink
    }
  }, zp.name, /*#__PURE__*/React.createElement("i", {
    className: "ti ti-link",
    style: {
      fontSize: 14,
      color: C.gold
    }
  })))))));
}

// ══════════════════════════════════════════════════════════════════════
// ProjectsSurface — the Tasks → Projects (and → CTC Files) views.
// Self-contained: list + detail + create/edit form, mobile + desktop.
// `titleNode(fontSize)` renders the shared My Tasks/CTC Files/Projects switcher.
// ══════════════════════════════════════════════════════════════════════
function ProjectsSurface({
  kind,
  dark,
  user,
  team,
  titleNode,
  hideSidebar,
  openId,
  onOpenIdConsumed
}) {
  const isCtc = kind === 'ctc_file';
  const zohoSyncable = ZOHO_SYNCABLE_KINDS.includes(kind); // ctc_file + project (e.g. "Accountability") — not rock
  const KL = kindLabel(kind);
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [pview, setPview] = useState('list'); // 'list' | 'detail' | 'form'
  const [current, setCurrent] = useState(null); // selected project row
  const storeKey = {
    project: 'tmg-projects',
    ctc_file: 'tmg-ctc',
    rock: 'tmg-rocks'
  }[kind] || 'tmg-projects';
  const gKey = storeKey + '-group';
  const sKey = storeKey + '-sort';
  const [group, setGroup] = useState(() => localStorage.getItem(gKey) || 'none');
  const [sort, setSort] = useState(() => localStorage.getItem(sKey) || 'target');
  const [search, setSearch] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [groupOpen, setGroupOpen] = useState(false);
  const [sortOpen, setSortOpen] = useState(false);
  const [addTask, setAddTask] = useState('');
  const [addMs, setAddMs] = useState('');
  // Container detail: Overview/List/Board tabs, and the task opened from
  // any of them (fixes tasks-inside-a-project being unopenable — they now
  // reuse the exact same TaskDetail/TaskForm as everywhere else).
  const [dtab, setDtab] = useState('overview'); // 'overview' | 'list' | 'board'
  const [openTask, setOpenTask] = useState(null);
  const [taskEditing, setTaskEditing] = useState(false);
  const [zohoLinkOpen, setZohoLinkOpen] = useState(false); // ctc_file only — see ZohoLinkModal
  const [ctcTab, setCtcTab] = useState('files'); // ctc_file only: 'files' | 'emails'
  // Approved email-derived updates for the open record (see CtcEmailsTab).
  const [updates, setUpdates] = useState([]);
  useEffect(() => {
    let on = true;
    if (!current || !current.id) {
      setUpdates([]);
      return;
    }
    const c = window.SupabaseAuth?._client;
    if (!c) return;
    c.from('project_updates').select('id,body,source,created_at').eq('project_id', current.id).order('created_at', {
      ascending: false
    }).limit(50).then(({
      data
    }) => {
      if (on) setUpdates(data || []);
    });
    return () => {
      on = false;
    };
  }, [current && current.id]);
  // Reset on record change — but honour a routed sub-tab (#ctc/<id>/board).
  // PENDING_ROUTE is consumed here rather than read in the router, because
  // this effect runs a render AFTER setCurrent and would otherwise clobber
  // any tab the route set.
  useEffect(() => {
    const routed = current && PENDING_ROUTE.id === current.id ? PENDING_ROUTE.tab : null;
    setDtab(routed && ROUTE_DTABS.indexOf(routed) !== -1 ? routed : 'overview');
    if (routed) {
      PENDING_ROUTE.kind = null;
      PENDING_ROUTE.id = null;
      PENDING_ROUTE.tab = null;
    }
    setOpenTask(null);
    setTaskEditing(false);
  }, [current && current.id]);
  // Record-level URL, so the address bar stays copy-pasteable inside a
  // project too. Same rules as the router's writer: replaceState only,
  // coalesced, never inside the iframe, never over the OAuth hash.
  useEffect(() => {
    if (TASKS_EMBED) return; // embed: URL is invisible, history is shared
    if (location.hash.indexOf('=') !== -1) return;
    const seg = ROUTE_SEG_BY_KIND[kind];
    if (!seg) return;
    // This surface owns its whole hash — list and record alike.
    const hash = pview === 'detail' && current ? seg + '/' + current.id + (dtab && dtab !== 'overview' ? '/' + dtab : '') : ROUTE_LIST_SEG[ROUTE_SURFACE_BY_SEG[seg]];
    const t = setTimeout(() => {
      try {
        if (location.hash.replace(/^#\/?/, '') !== hash) history.replaceState(null, '', '#' + hash);
      } catch (e) {}
    }, 120);
    return () => clearTimeout(t);
  }, [current && current.id, dtab, pview]);
  const wide = useWide(700);
  useEffect(() => {
    localStorage.setItem(gKey, group);
  }, [group]);
  useEffect(() => {
    localStorage.setItem(sKey, sort);
  }, [sort]);
  const bord = dark ? '#152545' : '#E4DFD4',
    ink = dark ? '#fff' : '#001A4A',
    sub = dark ? 'rgba(255,255,255,0.5)' : '#6B6B6B',
    gold = dark ? '#C9A45A' : '#AD832F',
    bg = dark ? '#000D26' : '#FCFBF8',
    card = dark ? '#0A1730' : '#fff';
  const lateColor = dark ? '#E07A7A' : '#9B1C1C',
    teal = dark ? '#7FC6AF' : '#0F6E56',
    blue = dark ? '#8FB6DC' : '#185FA5',
    dotIdle = dark ? 'rgba(255,255,255,.24)' : '#C4B9A8';
  async function reload() {
    setLoading(true);
    const r = await ProjectDB.loadFull(kind);
    setRows(r);
    setLoading(false);
    return r;
  }
  useEffect(() => {
    setPview('list');
    setCurrent(null);
    reload();
  }, [kind]);

  // Sidebar-initiated navigation: jump straight to a specific project/file
  // ('new' opens the create form instead). Waits for `rows` if they haven't
  // loaded yet (e.g. right after a `kind` switch triggered the reload above).
  useEffect(() => {
    if (openId == null) return;
    if (openId === 'new') {
      setCurrent(null);
      setPview('form');
    } else if (loading) return; // rows not in yet — wait for the load to finish
    else {
      const r = rows.find(x => x.id === openId);
      if (r) {
        setCurrent(r);
        setPview('detail');
      }
      // Miss (archived, deleted, not visible, or the wrong surface for this
      // id): fall through and CONSUME it anyway. Returning early here left
      // openItemId pinned to a dead id — the effect never retried, and
      // re-clicking that sidebar row was a no-op state write, so the row
      // looked broken until reload.
      else {
        setPview('list');
        PENDING_ROUTE.id = null;
        PENDING_ROUTE.tab = null;
      }
    }
    if (onOpenIdConsumed) onOpenIdConsumed();
  }, [openId, rows, loading]);

  // Reload this container's data and re-select both `current` and (if given)
  // the task being viewed, so edits/status-changes reflect immediately.
  async function refreshContainer(focusTaskId) {
    const fresh = await reload();
    const proj = current && fresh.find(x => x.id === current.id);
    if (proj) {
      setCurrent(proj);
      if (focusTaskId) setOpenTask(proj._tasks.find(x => x.id === focusTaskId) || null);
    }
  }
  async function onTaskStatus(task, status) {
    await TaskDB.update(task.id, task, {
      status
    }, user);
    await refreshContainer(task.id);
  }
  async function toggleTaskDone(t) {
    await onTaskStatus(t, t.status === 'done' ? 'todo' : 'done');
  }
  async function onBoardDrop(taskId, status) {
    const t = (current && current._tasks || []).find(x => x.id === taskId);
    if (t && t.status !== status) await onTaskStatus(t, status);
  }
  // Same field mapping as TasksScreen's handleSave — task creation/edit is
  // identical whether opened from My Tasks or from inside a container.
  // form.project stays a free-text name (findOrCreateProject), pre-filled to
  // this container's own name by TaskForm/TaskDetail when opened from here.
  async function onTaskSave(form) {
    const due_at = form.due ? new Date(form.due).toISOString() : null;
    const decision_due_at = form.decisionDue ? new Date(form.decisionDue).toISOString() : null;
    const project_id = form.project ? await TaskDB.findOrCreateProject(form.project, user) : null;
    const pl = form.planning || {};
    const fields = {
      title: form.title,
      due_at,
      project_id,
      priority: form.priority,
      status: form.status,
      description: form.description || null,
      context: form.context || null,
      working_url: form.working_url || null,
      email_link: form.email_link || null,
      decision_question: form.decisionQuestion || null,
      decision_due_at,
      decision_due_has_time: !!(form.decisionDue && form.decisionHasTime),
      recurrence: form.recurrence || 'none',
      recur_interval: form.recurInterval || null,
      recur_unit: form.recurUnit || null,
      recur_copy_fields: form.recurCopy || null,
      weekly_priority: pl.wp || null,
      weekly_rank: pl.wr ? parseInt(pl.wr, 10) : null,
      daily_priority: pl.dp || null,
      daily_rank: pl.dr ? parseInt(pl.dr, 10) : null
    };
    const people = {
      assignee: form.assignees,
      assigner: form.assigners,
      decision_maker: form.decisionMakers || []
    };
    let taskId;
    if (openTask && openTask.id) {
      await TaskDB.update(openTask.id, openTask, fields, user);
      await TaskDB.setPeople(openTask.id, people);
      taskId = openTask.id;
    } else {
      const created = await TaskDB.create(fields, people, user);
      taskId = created && created.id;
    }
    if (taskId) {
      await TaskDB.setLabels(taskId, user && user.id, form.labels || []);
      await TaskDB.setDecisionOptions(taskId, form.decisionOptions || []);
    }
    setTaskEditing(false);
    await refreshContainer(taskId);
  }
  const nameOf = id => (team.find(m => m.id === id) || {}).name || '';
  const initialsOf = id => {
    const n = nameOf(id);
    return n ? n.trim().split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase() : '?';
  };
  const today0 = (() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  })();
  const fmtD = d => d ? new Date(d).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric'
  }) : '—';
  const isOverdue = d => d && new Date(d) < today0;
  const daysTo = d => d ? Math.round((new Date(d) - today0) / 86400000) : '—';

  // ── CTC-only: "attention" flag + hero color, derived from real open-task
  // status (stuck / overdue) rather than a stored field — mirrors the
  // reference's blocked/overdue/clear/dates-missing states. ──
  const attentionOf = p => {
    const stuck = p._openTasks.filter(t => t.status === 'stuck').length;
    if (stuck) return {
      text: stuck + (stuck === 1 ? ' task blocked' : ' tasks blocked'),
      tone: 'red'
    };
    const overdue = p._openTasks.filter(t => t.due_at && new Date(t.due_at) < today0).length;
    if (overdue) return {
      text: overdue + (overdue === 1 ? ' task overdue' : ' tasks overdue'),
      tone: 'red'
    };
    if (p._taskCount === 0) return {
      text: 'No tasks yet',
      tone: 'sub'
    };
    const anyDates = p._tasks.some(t => t.due_at);
    if (!anyDates) return {
      text: 'Dates missing',
      tone: 'sub'
    };
    return {
      text: 'Clear',
      tone: 'sub'
    };
  };
  const heroColor = p => {
    const a = attentionOf(p);
    return a.tone === 'red' ? lateColor : a.text === 'Clear' ? teal : blue;
  };

  // ── shared header chips (mirror the My Tasks chip system) ──
  const chipStyle = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    fontSize: 12,
    letterSpacing: '0.08em',
    textTransform: 'uppercase',
    fontWeight: 400,
    padding: '7px 12px',
    border: `1px solid ${bord}`,
    borderRadius: 6,
    background: card,
    color: sub,
    whiteSpace: 'nowrap',
    cursor: 'pointer',
    fontFamily: C.fontSans
  };
  const ddStyle = {
    position: 'absolute',
    zIndex: 60,
    top: '100%',
    right: 0,
    background: card,
    border: `1px solid ${bord}`,
    borderRadius: 8,
    boxShadow: '0 12px 32px rgba(0,26,74,0.16)',
    padding: 6,
    minWidth: 190,
    marginTop: 4
  };
  // .menu button ported: 8px/10px padding, 13.5px font, checkmark suffix
  const ddItem = (label, active, onClick, key) => /*#__PURE__*/React.createElement("div", {
    key: key || label,
    onClick: onClick,
    style: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 10,
      padding: '8px 10px',
      fontSize: 13.5,
      color: active ? gold : ink,
      fontWeight: active ? 500 : 400,
      borderRadius: 5,
      cursor: 'pointer',
      fontFamily: C.fontSans
    }
  }, label, active && '✓');
  const GROUP_OPTS = [['none', 'None'], ['status', 'Status'], ['group', 'Group'], ['owner', 'Owner']];
  const SORT_OPTS = [['target', 'Target date'], ['name', 'Name'], ['progress', 'Progress'], ['created', 'Recently added']];
  // .btn.on ported: border-color gold-soft, color navy, background gold-pale
  // — shown whenever the chip's selection differs from its default.
  const chipOn = {
    borderColor: dark ? 'rgba(201,164,90,.4)' : '#C9A45A',
    color: ink,
    background: dark ? 'rgba(201,164,90,.14)' : '#F3EBDA'
  };
  const groupChip = /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'relative'
    }
  }, /*#__PURE__*/React.createElement("div", {
    onClick: () => {
      setGroupOpen(o => !o);
      setSortOpen(false);
    },
    style: group !== 'none' ? {
      ...chipStyle,
      ...chipOn
    } : chipStyle
  }, "Group: ", /*#__PURE__*/React.createElement("span", {
    style: {
      color: gold,
      fontWeight: 600
    }
  }, (GROUP_OPTS.find(([id]) => id === group) || [])[1]), " ", /*#__PURE__*/React.createElement("i", {
    className: "ti ti-chevron-down",
    style: {
      fontSize: 9,
      color: sub
    }
  })), groupOpen && /*#__PURE__*/React.createElement("div", {
    style: ddStyle,
    onClick: e => e.stopPropagation()
  }, GROUP_OPTS.map(([id, label]) => ddItem(label, group === id, () => {
    setGroup(id);
    setGroupOpen(false);
  }, id))));
  const sortChip = /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'relative'
    }
  }, /*#__PURE__*/React.createElement("div", {
    onClick: () => {
      setSortOpen(o => !o);
      setGroupOpen(false);
    },
    style: sort !== 'target' ? {
      ...chipStyle,
      ...chipOn
    } : chipStyle
  }, "Sort: ", /*#__PURE__*/React.createElement("span", {
    style: {
      color: gold,
      fontWeight: 600
    }
  }, (SORT_OPTS.find(([id]) => id === sort) || [])[1]), " ", /*#__PURE__*/React.createElement("i", {
    className: "ti ti-chevron-down",
    style: {
      fontSize: 9,
      color: sub
    }
  })), sortOpen && /*#__PURE__*/React.createElement("div", {
    style: ddStyle,
    onClick: e => e.stopPropagation()
  }, SORT_OPTS.map(([id, label]) => ddItem(label, sort === id, () => {
    setSort(id);
    setSortOpen(false);
  }, id))));
  const searchChip = searchOpen ? /*#__PURE__*/React.createElement("input", {
    autoFocus: true,
    value: search,
    onChange: e => setSearch(e.target.value),
    onBlur: () => {
      if (!search) setSearchOpen(false);
    },
    placeholder: "Search\u2026",
    style: {
      ...chipStyle,
      cursor: 'text',
      width: 130,
      textTransform: 'none',
      letterSpacing: 'normal',
      fontSize: '0.78rem',
      outline: 'none'
    }
  }) : /*#__PURE__*/React.createElement("div", {
    onClick: () => setSearchOpen(true),
    style: {
      ...chipStyle,
      width: 34,
      height: 34,
      padding: 0,
      justifyContent: 'center'
    }
  }, /*#__PURE__*/React.createElement("i", {
    className: "ti ti-search",
    style: {
      fontSize: 13
    }
  }));
  const newBtn = /*#__PURE__*/React.createElement("button", {
    onClick: () => {
      setCurrent(null);
      setPview('form');
    },
    "aria-label": 'New ' + KL.article,
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 6,
      background: C.navy,
      color: '#fff',
      border: 'none',
      borderRadius: 22,
      padding: '8px 16px',
      fontSize: 13,
      fontWeight: 500,
      letterSpacing: '0.02em',
      cursor: 'pointer',
      fontFamily: C.fontSans,
      flexShrink: 0
    }
  }, /*#__PURE__*/React.createElement("i", {
    className: "ti ti-plus",
    style: {
      fontSize: 14
    }
  }), "New");
  const avatar = (id, sz) => {
    const s = sz || 16;
    return /*#__PURE__*/React.createElement("span", {
      style: {
        width: s,
        height: s,
        borderRadius: '50%',
        background: C.navy,
        color: '#fff',
        fontSize: s * 0.42,
        display: 'grid',
        placeItems: 'center',
        fontWeight: 600,
        flexShrink: 0
      }
    }, initialsOf(id));
  };
  // Matches the prototype's .pill/.stat treatment (e.g. container header's <span class="pill st-done" style="font-size:11px">)
  const statusBadge = s => {
    const m = projStatusMeta(s);
    return /*#__PURE__*/React.createElement("span", {
      style: {
        fontSize: 11,
        fontWeight: 600,
        letterSpacing: '0.08em',
        textTransform: 'uppercase',
        padding: '3px 9px',
        borderRadius: 20,
        border: `1px solid ${m.color}55`,
        background: dark ? m.bgD : m.bg,
        color: m.color,
        fontFamily: C.fontSans
      }
    }, m.label);
  };

  // ── filtering / grouping / sorting ──
  const filtered = search.trim() ? rows.filter(p => (p.name || '').toLowerCase().includes(search.trim().toLowerCase())) : rows;
  const sortRows = arr => arr.slice().sort((a, b) => {
    if (sort === 'name') return (a.name || '').localeCompare(b.name || '');
    if (sort === 'progress') return b._progress - a._progress;
    if (sort === 'created') return new Date(b.created_at || 0) - new Date(a.created_at || 0);
    if (!a.target_date && !b.target_date) return 0;
    if (!a.target_date) return 1;
    if (!b.target_date) return -1;
    return new Date(a.target_date) - new Date(b.target_date);
  });
  function grouped() {
    if (group === 'none') return [[null, sortRows(filtered)]];
    const map = {};
    filtered.forEach(p => {
      let key;
      if (group === 'status') key = projStatusMeta(p.status).label;else if (group === 'group') key = p.group_tag || 'No group';else key = nameOf(p.owner_id) || 'Unassigned';
      (map[key] = map[key] || []).push(p);
    });
    return Object.keys(map).sort((a, b) => a.localeCompare(b)).map(k => [k, sortRows(map[k])]);
  }
  const groupHeadRow = (label, count, color) => /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 10,
      margin: '16px 0 8px'
    }
  }, color && /*#__PURE__*/React.createElement("span", {
    style: {
      width: 8,
      height: 8,
      borderRadius: '50%',
      background: color,
      flexShrink: 0
    }
  }), /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: '0.62rem',
      fontWeight: 700,
      letterSpacing: '0.14em',
      textTransform: 'uppercase',
      color: sub,
      fontFamily: C.fontSans
    }
  }, label), /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: '0.66rem',
      color: gold,
      fontFamily: C.fontSans
    }
  }, count), /*#__PURE__*/React.createElement("span", {
    style: {
      flex: 1,
      height: 1,
      background: bord
    }
  }));

  // ── milestone dot (list + spine) ──
  const mDot = (state, sz) => {
    const s = sz || 5;
    const base = {
      width: s,
      height: s,
      borderRadius: '50%',
      flexShrink: 0
    };
    if (state === 'done') return {
      ...base,
      background: teal
    };
    if (state === 'next') return {
      ...base,
      background: gold,
      boxShadow: `0 0 0 3px ${dark ? 'rgba(201,164,90,.2)' : 'rgba(173,131,47,.16)'}`
    };
    return {
      ...base,
      background: dotIdle
    };
  };
  const msState = (p, m) => m.status === 'done' ? 'done' : p._nextMs && p._nextMs.id === m.id ? 'next' : 'future';

  // ── CTC-only: horizontal milestone-chain rail node (replaces the % complete
  // column — reference: "the number that matters is days to the next binding date") ──
  const msRailNode = (p, m) => {
    const st = msState(p, m);
    return /*#__PURE__*/React.createElement("div", {
      key: m.id,
      style: {
        width: 76,
        flexShrink: 0,
        textAlign: 'center'
      }
    }, /*#__PURE__*/React.createElement("span", {
      style: {
        ...mDot(st, 8),
        display: 'block',
        margin: '4px auto 6px'
      }
    }), /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: '0.56rem',
        letterSpacing: '0.05em',
        textTransform: 'uppercase',
        color: st === 'next' ? gold : sub,
        fontWeight: 500,
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        fontFamily: C.fontSans
      }
    }, m.title), /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: '0.58rem',
        color: st === 'done' ? teal : st === 'next' ? ink : sub,
        marginTop: 2,
        fontFamily: C.fontSans
      }
    }, m.status === 'done' ? 'Done' : fmtD(m.due_at)));
  };

  // ── mobile project card ──
  const projCard = p => /*#__PURE__*/React.createElement("div", {
    key: p.id,
    onClick: () => {
      setCurrent(p);
      setPview('detail');
      setAddTask('');
      setAddMs('');
    },
    style: {
      background: card,
      border: `1px solid ${bord}`,
      borderRadius: 6,
      padding: 14,
      marginBottom: 11,
      cursor: 'pointer'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      marginBottom: 9
    }
  }, statusBadge(p.status), p.group_tag && /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 11,
      letterSpacing: '0.14em',
      color: sub,
      fontWeight: 500,
      textTransform: 'uppercase',
      fontFamily: C.fontSans
    }
  }, p.group_tag)), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 16,
      fontWeight: 500,
      color: ink,
      lineHeight: 1.3,
      marginBottom: p.outcome ? 5 : 10,
      fontFamily: C.fontSans
    }
  }, p.name), p.outcome && /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 12,
      color: sub,
      fontWeight: 300,
      lineHeight: 1.5,
      marginBottom: 12,
      fontFamily: C.fontSans
    }
  }, p.outcome), p._milestones.slice(0, 4).map(m => {
    const st = msState(p, m);
    return /*#__PURE__*/React.createElement("div", {
      key: m.id,
      style: {
        display: 'flex',
        alignItems: 'center',
        gap: 9,
        padding: '6px 0',
        fontSize: 12,
        color: st === 'next' ? ink : sub,
        fontWeight: st === 'next' ? 400 : 300,
        fontFamily: C.fontSans
      }
    }, /*#__PURE__*/React.createElement("span", {
      style: mDot(st)
    }), /*#__PURE__*/React.createElement("span", {
      style: {
        flex: 1,
        minWidth: 0,
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis'
      }
    }, m.title), /*#__PURE__*/React.createElement("span", {
      style: {
        fontSize: 10,
        color: st === 'done' ? teal : st === 'next' ? ink : sub
      }
    }, m.status === 'done' ? 'Done' : fmtD(m.due_at)));
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      height: 8,
      background: bord,
      borderRadius: 20,
      margin: '12px 0 10px',
      overflow: 'hidden'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      height: '100%',
      width: p._progress + '%',
      background: `linear-gradient(90deg, ${dark ? '#C9A45A' : '#C9A45A'}, ${dark ? '#AD832F' : '#AD832F'})`,
      borderRadius: 20
    }
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      fontSize: 10.5,
      color: sub,
      fontFamily: C.fontSans
    }
  }, /*#__PURE__*/React.createElement("span", null, p._doneMs, " of ", p._totalMs, " milestones"), p.owner_id ? avatar(p.owner_id, 18) : null));

  // ── desktop project row — padding/border ported from the prototype's
  // shared .row (viewAllProjects() reuses the exact same task-list row class) ──
  const projRow = p => /*#__PURE__*/React.createElement("div", {
    key: p.id,
    onClick: () => {
      setCurrent(p);
      setPview('detail');
      setAddTask('');
      setAddMs('');
    },
    style: {
      display: 'flex',
      alignItems: 'center',
      padding: '11px 12px',
      borderBottom: `1px solid ${bord}`,
      gap: 12,
      cursor: 'pointer'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: 250,
      flexShrink: 0
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      fontSize: 13,
      fontWeight: 500,
      color: ink,
      fontFamily: C.fontSans
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      width: 7,
      height: 7,
      borderRadius: '50%',
      background: projStatusMeta(p.status).color,
      flexShrink: 0
    }
  }), /*#__PURE__*/React.createElement("span", {
    style: {
      minWidth: 0,
      whiteSpace: 'nowrap',
      overflow: 'hidden',
      textOverflow: 'ellipsis'
    }
  }, p.name)), p.outcome && /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 11,
      color: sub,
      fontWeight: 300,
      marginTop: 3,
      whiteSpace: 'nowrap',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      fontFamily: C.fontSans
    }
  }, p.outcome)), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      minWidth: 0,
      fontSize: 11.5,
      color: ink,
      fontFamily: C.fontSans
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 9,
      letterSpacing: '0.14em',
      textTransform: 'uppercase',
      color: sub,
      fontWeight: 600,
      marginBottom: 3
    }
  }, projStatusMeta(p.status).label), /*#__PURE__*/React.createElement("span", {
    style: {
      whiteSpace: 'nowrap',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      display: 'block'
    }
  }, p._nextMs ? p._nextMs.title + (p._nextMs.due_at ? ' · ' + fmtD(p._nextMs.due_at) : '') : '—')), /*#__PURE__*/React.createElement("div", {
    style: {
      width: 150,
      flexShrink: 0
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      height: 8,
      background: bord,
      borderRadius: 20,
      marginBottom: 6,
      overflow: 'hidden'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      height: '100%',
      width: p._progress + '%',
      background: `linear-gradient(90deg, #C9A45A, #AD832F)`,
      borderRadius: 20
    }
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 10,
      color: sub,
      fontFamily: C.fontSans
    }
  }, p._doneMs, " of ", p._totalMs, " milestones")), /*#__PURE__*/React.createElement("div", {
    style: {
      width: 110,
      flexShrink: 0,
      display: 'flex',
      alignItems: 'center',
      gap: 6,
      fontSize: 10.5,
      color: sub,
      fontFamily: C.fontSans
    }
  }, p.owner_id ? /*#__PURE__*/React.createElement(React.Fragment, null, avatar(p.owner_id, 16), nameOf(p.owner_id).split(' ')[0]) : '—'), /*#__PURE__*/React.createElement("div", {
    style: {
      width: 96,
      flexShrink: 0,
      textAlign: 'right',
      fontSize: 10.5,
      color: isOverdue(p.target_date) ? lateColor : sub,
      fontWeight: isOverdue(p.target_date) ? 500 : 400,
      fontFamily: C.fontSans
    }
  }, fmtD(p.target_date)));

  // ── mobile CTC file card — address-forward, hero "days to next binding
  // date" block, horizontal milestone rail. Deliberately NOT the project
  // card: a transaction is an address and a chain of dates, not an outcome. ──
  const ctcCard = p => {
    const att = attentionOf(p);
    const hc = heroColor(p);
    const heroBg = hc === teal ? dark ? 'rgba(15,110,86,.12)' : '#E6F5F0' : hc === lateColor ? dark ? 'rgba(155,28,28,.12)' : '#FBF0F0' : dark ? 'rgba(24,95,165,.12)' : '#EEF3FB';
    return /*#__PURE__*/React.createElement("div", {
      key: p.id,
      onClick: () => {
        setCurrent(p);
        setPview('detail');
        setAddTask('');
        setAddMs('');
      },
      style: {
        background: card,
        border: `1px solid ${bord}`,
        borderLeft: `2.5px solid ${hc}`,
        borderRadius: 6,
        padding: 14,
        marginBottom: 11,
        cursor: 'pointer'
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: '0.95rem',
        fontWeight: 600,
        color: ink,
        lineHeight: 1.25,
        marginBottom: 8,
        fontFamily: C.fontSans
      }
    }, p.name), (p.group_tag || p.owner_id) && /*#__PURE__*/React.createElement("div", {
      style: {
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        marginBottom: 12
      }
    }, p.group_tag && /*#__PURE__*/React.createElement("span", {
      style: {
        fontSize: '0.58rem',
        letterSpacing: '0.08em',
        textTransform: 'uppercase',
        padding: '3px 7px',
        borderRadius: 3,
        background: dark ? 'rgba(255,255,255,.08)' : '#F7F4EE',
        color: sub,
        fontWeight: 500,
        fontFamily: C.fontSans
      }
    }, p.group_tag), p.owner_id && /*#__PURE__*/React.createElement("span", {
      style: {
        display: 'flex',
        alignItems: 'center',
        gap: 5,
        fontSize: '0.7rem',
        color: sub,
        fontFamily: C.fontSans
      }
    }, avatar(p.owner_id, 16), nameOf(p.owner_id))), p._nextMs && /*#__PURE__*/React.createElement("div", {
      style: {
        borderRadius: 5,
        padding: '9px 11px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        marginBottom: 12,
        background: heroBg,
        border: `1px solid ${bord}`
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        minWidth: 0
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: '0.56rem',
        letterSpacing: '0.1em',
        textTransform: 'uppercase',
        color: sub,
        fontWeight: 500,
        marginBottom: 3,
        fontFamily: C.fontSans
      }
    }, "Next binding date"), /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: '0.76rem',
        fontWeight: 500,
        color: ink,
        fontFamily: C.fontSans,
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis'
      }
    }, p._nextMs.title)), /*#__PURE__*/React.createElement("div", {
      style: {
        flexShrink: 0,
        textAlign: 'right',
        marginLeft: 10
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        fontFamily: "'Cormorant Garamond', serif",
        fontStyle: 'italic',
        fontSize: '1.5rem',
        lineHeight: 1,
        color: hc
      }
    }, daysTo(p._nextMs.due_at)), /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: '0.5rem',
        fontFamily: C.fontSans,
        letterSpacing: '0.1em',
        textTransform: 'uppercase',
        color: sub,
        marginTop: 3
      }
    }, "days"))), p._milestones.length > 0 && /*#__PURE__*/React.createElement("div", {
      style: {
        display: 'flex',
        overflowX: 'auto',
        gap: 8,
        marginBottom: 12,
        paddingBottom: 2
      }
    }, p._milestones.map(m => msRailNode(p, m))), /*#__PURE__*/React.createElement("div", {
      style: {
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        paddingTop: 10,
        borderTop: `1px solid ${bord}`,
        fontSize: '0.7rem',
        fontFamily: C.fontSans
      }
    }, /*#__PURE__*/React.createElement("span", {
      style: {
        color: att.tone === 'red' ? lateColor : sub,
        fontWeight: att.tone === 'red' ? 600 : 400
      }
    }, att.text), /*#__PURE__*/React.createElement("span", {
      style: {
        color: sub
      }
    }, p._doneMs, " of ", p._totalMs, " milestones")));
  };

  // ── desktop CTC file row — hairline row, no card shell. Milestone rail
  // replaces the % complete column; the number that matters is days to the
  // next binding date, not overall progress. ──
  const ctcRow = p => {
    const att = attentionOf(p);
    return /*#__PURE__*/React.createElement("div", {
      key: p.id,
      onClick: () => {
        setCurrent(p);
        setPview('detail');
        setAddTask('');
        setAddMs('');
      },
      style: {
        display: 'flex',
        alignItems: 'center',
        padding: '10px 18px',
        borderBottom: `1px solid ${bord}`,
        gap: 12,
        cursor: 'pointer'
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        width: 224,
        flexShrink: 0
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: '0.82rem',
        fontWeight: 500,
        color: ink,
        marginBottom: p.group_tag ? 4 : 0,
        fontFamily: C.fontSans,
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis'
      }
    }, p.name), p.group_tag && /*#__PURE__*/React.createElement("span", {
      style: {
        fontSize: '0.58rem',
        letterSpacing: '0.08em',
        textTransform: 'uppercase',
        padding: '2px 6px',
        borderRadius: 3,
        background: dark ? 'rgba(255,255,255,.08)' : '#F7F4EE',
        color: sub,
        fontWeight: 500,
        fontFamily: C.fontSans
      }
    }, p.group_tag)), /*#__PURE__*/React.createElement("div", {
      style: {
        width: 146,
        flexShrink: 0,
        display: 'flex',
        alignItems: 'center',
        gap: 8
      }
    }, p._nextMs ? /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
      style: {
        fontFamily: "'Cormorant Garamond', serif",
        fontStyle: 'italic',
        fontSize: '1.3rem',
        lineHeight: 1,
        color: heroColor(p)
      }
    }, daysTo(p._nextMs.due_at)), /*#__PURE__*/React.createElement("div", {
      style: {
        minWidth: 0
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: '0.56rem',
        letterSpacing: '0.1em',
        textTransform: 'uppercase',
        color: sub,
        fontWeight: 600,
        marginBottom: 2,
        fontFamily: C.fontSans
      }
    }, "Days"), /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: '0.68rem',
        color: ink,
        fontFamily: C.fontSans,
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis'
      }
    }, p._nextMs.title))) : /*#__PURE__*/React.createElement("span", {
      style: {
        fontSize: '0.72rem',
        color: sub,
        fontFamily: C.fontSans
      }
    }, "No dates set")), /*#__PURE__*/React.createElement("div", {
      style: {
        flex: 1,
        minWidth: 0,
        display: 'flex',
        alignItems: 'flex-start',
        gap: 8,
        overflow: 'hidden'
      }
    }, p._milestones.map(m => msRailNode(p, m))), /*#__PURE__*/React.createElement("div", {
      style: {
        width: 96,
        flexShrink: 0,
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        fontSize: '0.72rem',
        color: sub,
        fontFamily: C.fontSans
      }
    }, p.owner_id ? /*#__PURE__*/React.createElement(React.Fragment, null, avatar(p.owner_id, 16), nameOf(p.owner_id).split(' ')[0]) : '—'), /*#__PURE__*/React.createElement("div", {
      style: {
        width: 96,
        flexShrink: 0,
        textAlign: 'right',
        fontSize: '0.68rem',
        fontWeight: att.tone === 'red' ? 600 : 400,
        color: att.tone === 'red' ? lateColor : sub,
        fontFamily: C.fontSans
      }
    }, att.text));
  };

  // ── list body ──
  const listBody = (rowFn, wideList) => {
    if (loading) return /*#__PURE__*/React.createElement("div", {
      style: {
        color: sub,
        fontSize: '0.82rem',
        padding: 20,
        fontFamily: C.fontSans
      }
    }, "Loading\u2026");
    if (!filtered.length) return /*#__PURE__*/React.createElement("div", {
      style: {
        color: sub,
        fontSize: '0.82rem',
        padding: 24,
        textAlign: 'center',
        fontFamily: C.fontSans
      }
    }, "No ", KL.plural.toLowerCase(), " yet. Tap ", /*#__PURE__*/React.createElement("b", null, "New"), " to add one.");
    return grouped().map(([label, items], gi) => /*#__PURE__*/React.createElement("div", {
      key: label || gi
    }, label && groupHeadRow(label, items.length, group === 'status' ? projStatusMeta((items[0] || {}).status).color : gold), items.map(rowFn)));
  };

  // ── DETAIL ──
  async function quickAdd(title, milestone) {
    if (!title.trim() || !current) return;
    await TaskDB.create({
      title: title.trim(),
      status: 'todo',
      priority: 'medium',
      project_id: current.id,
      is_milestone: !!milestone
    }, {}, user);
    const fresh = await reload();
    const updated = fresh.find(p => p.id === current.id);
    if (updated) setCurrent(updated);
  }
  const spineItem = (p, m, last) => {
    const st = msState(p, m);
    return /*#__PURE__*/React.createElement("div", {
      key: m.id,
      style: {
        display: 'flex',
        gap: 12,
        padding: '0 0 14px',
        position: 'relative'
      }
    }, !last && /*#__PURE__*/React.createElement("span", {
      style: {
        position: 'absolute',
        left: 4.5,
        top: 12,
        bottom: -2,
        width: 1,
        background: dark ? 'rgba(255,255,255,.12)' : '#E0D8CC'
      }
    }), /*#__PURE__*/React.createElement("span", {
      style: {
        ...mDot(st, 10),
        border: st === 'future' ? `1.5px solid ${dotIdle}` : 'none',
        background: st === 'future' ? card : mDot(st, 10).background,
        marginTop: 3,
        zIndex: 1
      }
    }), /*#__PURE__*/React.createElement("div", {
      style: {
        flex: 1,
        minWidth: 0
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: '0.8rem',
        color: st === 'next' ? ink : sub,
        fontWeight: st === 'next' ? 500 : 300,
        fontFamily: C.fontSans
      }
    }, m.title), /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: '0.66rem',
        color: st === 'next' ? gold : sub,
        marginTop: 3,
        fontFamily: C.fontSans
      }
    }, m.status === 'done' ? 'Completed ' + fmtD(m.completed_at || m.updated_at) : m.due_at ? 'Due ' + fmtD(m.due_at) : 'No date')));
  };
  const detailTaskRow = t => /*#__PURE__*/React.createElement("div", {
    key: t.id,
    onClick: () => setOpenTask(t),
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 10,
      padding: '9px 0',
      borderBottom: `1px solid ${bord}`,
      cursor: 'pointer'
    }
  }, /*#__PURE__*/React.createElement("div", {
    onClick: e => {
      e.stopPropagation();
      toggleTaskDone(t);
    },
    title: t.status === 'done' ? 'Mark not done' : 'Mark done',
    style: {
      width: 16,
      height: 16,
      borderRadius: '50%',
      border: `1.6px solid ${t.status === 'done' ? statusColor('done') : dark ? 'rgba(255,255,255,.28)' : '#C9C4B5'}`,
      background: t.status === 'done' ? statusColor('done') : 'transparent',
      flexShrink: 0,
      display: 'grid',
      placeItems: 'center',
      cursor: 'pointer'
    }
  }, t.status === 'done' && /*#__PURE__*/React.createElement("i", {
    className: "ti ti-check",
    style: {
      fontSize: 10,
      color: '#fff'
    }
  })), /*#__PURE__*/React.createElement("span", {
    style: {
      width: 6,
      height: 6,
      borderRadius: '50%',
      background: priorityColor(t.priority),
      flexShrink: 0
    },
    title: priorityLabel(t.priority)
  }), t.is_milestone && /*#__PURE__*/React.createElement("span", {
    style: {
      color: gold,
      fontSize: '0.6rem',
      fontWeight: 600,
      border: `1px solid ${dark ? 'rgba(201,164,90,.35)' : '#E8D9BC'}`,
      background: dark ? 'rgba(201,164,90,.14)' : '#F3EBDA',
      borderRadius: 4,
      padding: '1px 6px',
      letterSpacing: '0.04em',
      flexShrink: 0,
      whiteSpace: 'nowrap',
      fontFamily: C.fontSans
    }
  }, "\u25C6 Milestone"), /*#__PURE__*/React.createElement("span", {
    style: {
      flex: 1,
      minWidth: 0,
      fontSize: '0.8rem',
      color: ink,
      fontFamily: C.fontSans,
      whiteSpace: 'nowrap',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      textDecoration: t.status === 'done' ? 'line-through' : 'none'
    }
  }, t.title), /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: '0.62rem',
      fontWeight: 600,
      padding: '2px 8px',
      borderRadius: 20,
      background: statusBg(t.status),
      color: statusColor(t.status),
      fontFamily: C.fontSans,
      whiteSpace: 'nowrap',
      flexShrink: 0
    }
  }, statusLabel(t.status)), /*#__PURE__*/React.createElement("span", {
    style: {
      width: 60,
      textAlign: 'right',
      fontSize: '0.68rem',
      color: isOverdue(t.due_at) && t.status !== 'done' ? lateColor : sub,
      fontWeight: isOverdue(t.due_at) && t.status !== 'done' ? 600 : 400,
      flexShrink: 0,
      fontFamily: C.fontSans
    }
  }, fmtD(t.due_at)));
  // Matches the prototype's .quickadd (padding 10px 12px, 6px radius).
  const addInputs = /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 12,
      display: 'flex',
      flexDirection: 'column',
      gap: 8
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 8
    }
  }, /*#__PURE__*/React.createElement("input", {
    value: addMs,
    onChange: e => setAddMs(e.target.value),
    onKeyDown: e => {
      if (e.key === 'Enter') {
        quickAdd(addMs, true);
        setAddMs('');
      }
    },
    placeholder: "Add a milestone\u2026",
    style: {
      flex: 1,
      padding: '10px 12px',
      background: dark ? '#06101F' : '#fff',
      border: `1px solid ${bord}`,
      borderRadius: 6,
      color: ink,
      fontSize: 14,
      outline: 'none',
      fontFamily: C.fontSans
    }
  }), /*#__PURE__*/React.createElement("button", {
    onClick: () => {
      quickAdd(addMs, true);
      setAddMs('');
    },
    disabled: !addMs.trim(),
    style: {
      padding: '8px 12px',
      background: dark ? '#06101F' : '#fff',
      border: `1px solid ${bord}`,
      borderRadius: 6,
      color: gold,
      fontSize: 12,
      fontWeight: 500,
      cursor: 'pointer',
      fontFamily: C.fontSans,
      opacity: addMs.trim() ? 1 : 0.5,
      display: 'flex',
      alignItems: 'center',
      gap: 5
    }
  }, /*#__PURE__*/React.createElement("i", {
    className: "ti ti-flag-3",
    style: {
      fontSize: 12
    }
  }), "Milestone")), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 8
    }
  }, /*#__PURE__*/React.createElement("input", {
    value: addTask,
    onChange: e => setAddTask(e.target.value),
    onKeyDown: e => {
      if (e.key === 'Enter') {
        quickAdd(addTask, false);
        setAddTask('');
      }
    },
    placeholder: "Add a task\u2026",
    style: {
      flex: 1,
      padding: '10px 12px',
      background: dark ? '#06101F' : '#fff',
      border: `1px solid ${bord}`,
      borderRadius: 6,
      color: ink,
      fontSize: 14,
      outline: 'none',
      fontFamily: C.fontSans
    }
  }), /*#__PURE__*/React.createElement("button", {
    onClick: () => {
      quickAdd(addTask, false);
      setAddTask('');
    },
    disabled: !addTask.trim(),
    style: {
      padding: '8px 13px',
      background: C.navy,
      color: '#fff',
      border: 'none',
      borderRadius: 6,
      fontSize: 12,
      fontWeight: 500,
      cursor: 'pointer',
      fontFamily: C.fontSans,
      opacity: addTask.trim() ? 1 : 0.5
    }
  }, "Add task")));
  // Relative-time label for "Last synced" (no existing helper in this
  // file covers this — fmtD is absolute-date-only).
  const timeAgo = iso => {
    if (!iso) return null;
    const ms = Date.now() - new Date(iso).getTime();
    if (ms < 60000) return 'just now';
    const mins = Math.round(ms / 60000);
    if (mins < 60) return mins + 'm ago';
    const hrs = Math.round(mins / 60);
    if (hrs < 24) return hrs + 'h ago';
    return Math.round(hrs / 24) + 'd ago';
  };
  const [syncingNow, setSyncingNow] = useState(false);
  async function syncNow(p) {
    setSyncingNow(true);
    try {
      await callZohoProjects({
        action: 'sync_now',
        project_id: p.id
      });
      await refreshContainer();
    } finally {
      setSyncingNow(false);
    }
  }
  const detailFields = p => {
    const fld = (k, v) => /*#__PURE__*/React.createElement("div", {
      style: {
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        padding: '12px 0',
        borderBottom: `1px solid ${bord}`,
        fontSize: 13.5,
        fontFamily: C.fontSans,
        gap: 10
      }
    }, /*#__PURE__*/React.createElement("span", {
      style: {
        color: sub,
        letterSpacing: '0.1em',
        textTransform: 'uppercase',
        fontSize: 11,
        flexShrink: 0
      }
    }, k), /*#__PURE__*/React.createElement("span", {
      style: {
        color: ink,
        fontWeight: 500,
        display: 'flex',
        alignItems: 'center',
        gap: 7,
        textAlign: 'right'
      }
    }, v));
    return /*#__PURE__*/React.createElement(React.Fragment, null, fld('Owner', p.owner_id ? /*#__PURE__*/React.createElement(React.Fragment, null, avatar(p.owner_id, 16), nameOf(p.owner_id)) : '—'), fld('Type', KL.singular), fld(KL.groupLabel, p.group_tag || '—'), fld('Status', /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("span", {
      style: {
        width: 7,
        height: 7,
        borderRadius: '50%',
        background: projStatusMeta(p.status).color
      }
    }), projStatusMeta(p.status).label)), fld('Started', p.started_at ? fmtD(p.started_at) : '—'), fld('Target', /*#__PURE__*/React.createElement("span", {
      style: {
        color: isOverdue(p.target_date) ? lateColor : ink
      }
    }, fmtD(p.target_date))), fld('Tasks', p._taskCount - p._openTasks.length + ' / ' + p._taskCount), fld('Collaborators', p._collaborators.length ? /*#__PURE__*/React.createElement("span", {
      style: {
        display: 'flex'
      }
    }, p._collaborators.slice(0, 5).map((id, i) => /*#__PURE__*/React.createElement("span", {
      key: id,
      style: {
        marginLeft: i ? -5 : 0
      }
    }, avatar(id, 18)))) : '—'), zohoSyncable && p.zoho_project_id && /*#__PURE__*/React.createElement(React.Fragment, null, fld('Zoho Project', /*#__PURE__*/React.createElement("span", {
      style: {
        display: 'flex',
        alignItems: 'center',
        gap: 5
      }
    }, /*#__PURE__*/React.createElement("i", {
      className: "ti ti-link",
      style: {
        fontSize: 12,
        color: gold
      }
    }), "Linked")), fld('Last synced', /*#__PURE__*/React.createElement("span", {
      style: {
        display: 'flex',
        alignItems: 'center',
        gap: 8
      }
    }, p.zoho_last_synced_at ? timeAgo(p.zoho_last_synced_at) : 'Never', /*#__PURE__*/React.createElement("i", {
      onClick: () => !syncingNow && syncNow(p),
      className: syncingNow ? 'ti ti-loader-2' : 'ti ti-refresh',
      title: "Sync now",
      style: {
        fontSize: 14,
        color: gold,
        cursor: syncingNow ? 'default' : 'pointer',
        animation: syncingNow ? 'spin 1s linear infinite' : 'none'
      }
    })))));
  };
  // A task opened from inside this container's List/Board/Overview —
  // reuses the exact same TaskDetail/TaskForm as My Tasks, so nothing about
  // the task (Decisions, labels, dependencies, the AI thread, etc.) is a
  // stripped-down copy. allTasks is scoped to this container's own tasks
  // (subtask/dependency lookups that cross into another project won't
  // resolve here — a known, minor limitation of viewing a task this way).
  const taskDetailOverlay = () => /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 10,
      padding: '14px 20px',
      borderBottom: `1px solid ${bord}`,
      flexShrink: 0,
      background: dark ? '#0A1730' : '#fff'
    }
  }, /*#__PURE__*/React.createElement("i", {
    className: "ti ti-chevron-left",
    onClick: () => {
      setOpenTask(null);
      setTaskEditing(false);
    },
    style: {
      fontSize: 16,
      cursor: 'pointer',
      color: sub,
      flexShrink: 0
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      minWidth: 0,
      fontSize: 11,
      letterSpacing: '0.14em',
      textTransform: 'uppercase',
      color: sub,
      fontFamily: C.fontSans,
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap'
    }
  }, current && current.name || KL.plural, " / ", taskEditing ? 'Edit task' : 'Task')), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      minHeight: 0,
      overflowY: 'auto'
    }
  }, taskEditing ? /*#__PURE__*/React.createElement(TaskForm, {
    dark: dark,
    task: openTask,
    team: team,
    user: user,
    onSave: onTaskSave,
    onCancel: () => setTaskEditing(false)
  }) : /*#__PURE__*/React.createElement(TaskDetail, {
    dark: dark,
    task: openTask,
    people: openTask._people || [],
    team: team,
    user: user,
    allTasks: current && current._tasks || [],
    onEdit: () => setTaskEditing(true),
    onDelete: async () => {
      const fresh = await reload();
      const proj = current && fresh.find(x => x.id === current.id);
      setCurrent(proj || null);
      setOpenTask(null);
      setTaskEditing(false);
    },
    onStatus: s => onTaskStatus(openTask, s),
    onOpenSubtask: child => setOpenTask(child)
  })));

  // Matches the prototype's .vtabs/.vtab exactly.
  const dtabBar = /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 2,
      padding: wide ? '16px 34px 0' : '0 14px',
      borderBottom: `1px solid ${bord}`,
      flexShrink: 0
    }
  }, [['overview', 'Overview'], ['list', 'List'], ['board', 'Board'], ['timeline', 'Timeline']].map(([id, label]) => /*#__PURE__*/React.createElement("div", {
    key: id,
    onClick: () => setDtab(id),
    style: {
      padding: '10px 16px',
      fontSize: 13,
      color: dtab === id ? ink : sub,
      fontWeight: dtab === id ? 500 : 400,
      borderBottom: `2px solid ${dtab === id ? gold : 'transparent'}`,
      cursor: 'pointer',
      fontFamily: C.fontSans,
      marginBottom: -1
    }
  }, label)));
  // Synced Zoho Projects tasks carry a tasklist (e.g. "Pre-List", "Clear to
  // Close") — group by that instead of status when any task here has one,
  // since a flat status-grouped dump of 100+ synced tasks isn't readable.
  // Plain (non-synced) task lists keep the original status grouping.
  const listTab = p => {
    const tasklistNames = p._tasks.some(t => t.zoho_tasklist_name);
    if (tasklistNames) {
      const groups = {};
      p._tasks.forEach(t => {
        const key = t.zoho_tasklist_name || 'Other tasks';
        (groups[key] = groups[key] || []).push(t);
      });
      const earliest = arr => Math.min(...arr.map(t => t.created_at ? new Date(t.created_at).getTime() : Date.now()));
      const order = Object.keys(groups).sort((a, b) => earliest(groups[a]) - earliest(groups[b]));
      return /*#__PURE__*/React.createElement("div", {
        style: {
          padding: wide ? '14px 20px 24px' : '12px 14px 24px',
          flex: 1,
          minWidth: 0,
          overflowY: 'auto'
        }
      }, order.map(key => /*#__PURE__*/React.createElement("div", {
        key: key,
        style: {
          marginBottom: 16
        }
      }, /*#__PURE__*/React.createElement("div", {
        style: {
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          marginBottom: 7
        }
      }, /*#__PURE__*/React.createElement("span", {
        style: {
          fontSize: '0.64rem',
          fontWeight: 700,
          letterSpacing: '0.1em',
          textTransform: 'uppercase',
          color: sub,
          fontFamily: C.fontSans
        }
      }, key, " \xB7 ", groups[key].length)), groups[key].map(detailTaskRow))), addInputs);
    }
    return /*#__PURE__*/React.createElement("div", {
      style: {
        padding: wide ? '14px 20px 24px' : '12px 14px 24px',
        flex: 1,
        minWidth: 0,
        overflowY: 'auto'
      }
    }, p._tasks.length === 0 ? /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: '0.8rem',
        color: sub,
        fontFamily: C.fontSans
      }
    }, "No tasks yet.") : TASK_STATUS.map(col => {
      const items = p._tasks.filter(t => t.status === col.id);
      if (!items.length) return null;
      return /*#__PURE__*/React.createElement("div", {
        key: col.id,
        style: {
          marginBottom: 16
        }
      }, /*#__PURE__*/React.createElement("div", {
        style: {
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          marginBottom: 7
        }
      }, /*#__PURE__*/React.createElement("span", {
        style: {
          width: 8,
          height: 8,
          borderRadius: '50%',
          background: col.color
        }
      }), /*#__PURE__*/React.createElement("span", {
        style: {
          fontSize: '0.64rem',
          fontWeight: 700,
          letterSpacing: '0.1em',
          textTransform: 'uppercase',
          color: sub,
          fontFamily: C.fontSans
        }
      }, col.label, " \xB7 ", items.length)), items.map(detailTaskRow));
    }), addInputs);
  };
  const boardTab = p => /*#__PURE__*/React.createElement(TaskBoard, {
    items: p._tasks,
    dark: dark,
    onOpen: setOpenTask,
    onDrop: onBoardDrop,
    showSource: false
  });
  const timelineTab = p => /*#__PURE__*/React.createElement(TaskTimeline, {
    items: p._tasks,
    dark: dark,
    onOpen: setOpenTask
  });
  const detailView = () => {
    const p = current;
    if (!p) return null;
    if (openTask && !wide) return taskDetailOverlay(); // mobile: no room for a drawer, full swap like before
    const spine = /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 11,
        letterSpacing: '0.14em',
        textTransform: 'uppercase',
        color: sub,
        fontWeight: 600,
        margin: '22px 0 8px'
      }
    }, "Milestones"), p._milestones.length === 0 && /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: '0.76rem',
        color: sub,
        fontFamily: C.fontSans,
        marginBottom: 6
      }
    }, "No milestones yet. Add one below, or flag any task as a milestone."), /*#__PURE__*/React.createElement("div", {
      style: {
        paddingLeft: 2
      }
    }, p._milestones.map((m, i) => spineItem(p, m, i === p._milestones.length - 1))));
    // The Open-tasks list used to live here; it's gone from the Overview
    // (the List/Board tabs are the place for tasks, and on a synced CTC
    // file it was a 100-row wall). addInputs STAYS — it carries the "Add a
    // milestone" and "Add a task" inputs, which are the only way to add
    // either from this screen.
    const tasksBlock = /*#__PURE__*/React.createElement(React.Fragment, null, updates.length > 0 && /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 11,
        letterSpacing: '0.14em',
        textTransform: 'uppercase',
        color: sub,
        fontWeight: 600,
        margin: '22px 0 8px'
      }
    }, "Updates \xB7 ", updates.length), /*#__PURE__*/React.createElement("div", {
      style: {
        borderTop: `1px solid ${bord}`
      }
    }, updates.map(u => /*#__PURE__*/React.createElement("div", {
      key: u.id,
      style: {
        padding: '10px 0',
        borderBottom: `1px solid ${bord}`
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 13.5,
        color: ink,
        fontFamily: C.fontSans,
        lineHeight: 1.55
      }
    }, u.body), /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 11,
        color: sub,
        fontFamily: C.fontSans,
        marginTop: 3
      }
    }, u.source === 'email' ? 'From email' : u.source, " \xB7 ", fmtD(u.created_at)))))), addInputs);
    const header = /*#__PURE__*/React.createElement("div", {
      style: {
        padding: wide ? '26px 34px 0' : '12px 14px',
        flexShrink: 0
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        fontSize: 11,
        letterSpacing: '0.16em',
        textTransform: 'uppercase',
        color: sub,
        fontWeight: 500,
        marginBottom: 10,
        fontFamily: C.fontSans,
        cursor: 'pointer'
      },
      onClick: () => {
        setPview('list');
        setCurrent(null);
      }
    }, /*#__PURE__*/React.createElement("i", {
      className: "ti ti-chevron-left",
      style: {
        fontSize: 14,
        color: gold
      }
    }), KL.plural), /*#__PURE__*/React.createElement("div", {
      style: {
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'space-between',
        gap: 16,
        flexWrap: 'wrap',
        marginBottom: 6
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        flexWrap: 'wrap'
      }
    }, /*#__PURE__*/React.createElement("span", {
      style: {
        fontSize: wide ? 27 : '1.05rem',
        fontWeight: wide ? 500 : 600,
        color: ink,
        fontFamily: C.fontSans,
        lineHeight: 1.2
      }
    }, p.name), statusBadge(p.status)), /*#__PURE__*/React.createElement("div", {
      style: {
        display: 'flex',
        gap: 8
      }
    }, /*#__PURE__*/React.createElement(CopyLinkBtn, {
      dark: dark,
      hash: (ROUTE_SEG_BY_KIND[p.record_type || kind] || 'project') + '/' + p.id + (dtab && dtab !== 'overview' ? '/' + dtab : ''),
      title: 'Copy a link straight to this ' + KL.singular.toLowerCase()
    }), zohoSyncable && (p.zoho_project_id ? /*#__PURE__*/React.createElement("span", {
      style: {
        fontSize: 12,
        letterSpacing: '0.04em',
        padding: '7px 12px',
        borderRadius: 6,
        fontWeight: 500,
        border: `1px solid ${teal}55`,
        color: teal,
        background: dark ? 'rgba(15,110,86,.14)' : '#E6F2EC',
        fontFamily: C.fontSans,
        display: 'flex',
        alignItems: 'center',
        gap: 6
      }
    }, /*#__PURE__*/React.createElement("i", {
      className: "ti ti-check",
      style: {
        fontSize: 13
      }
    }), "Synced with Zoho") : /*#__PURE__*/React.createElement("button", {
      onClick: () => setZohoLinkOpen(true),
      style: {
        fontSize: 12,
        letterSpacing: '0.04em',
        padding: '7px 12px',
        borderRadius: 6,
        fontWeight: 400,
        border: `1px solid ${bord}`,
        color: sub,
        background: 'none',
        cursor: 'pointer',
        fontFamily: C.fontSans,
        display: 'flex',
        alignItems: 'center',
        gap: 6
      }
    }, /*#__PURE__*/React.createElement("i", {
      className: "ti ti-link",
      style: {
        fontSize: 13
      }
    }), "Link to Zoho Projects")), /*#__PURE__*/React.createElement("button", {
      onClick: () => setPview('form'),
      style: {
        fontSize: 12,
        letterSpacing: '0.08em',
        textTransform: 'uppercase',
        padding: '7px 12px',
        borderRadius: 6,
        fontWeight: 400,
        border: `1px solid ${bord}`,
        color: sub,
        background: 'none',
        cursor: 'pointer',
        fontFamily: C.fontSans
      }
    }, "Edit"))), p.outcome && /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 13.5,
        color: sub,
        marginBottom: 6,
        fontFamily: C.fontSans
      }
    }, p.outcome));
    const mainCol = /*#__PURE__*/React.createElement("div", {
      style: {
        padding: wide ? '18px 34px' : '14px',
        flex: 1,
        minWidth: 0
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        height: 8,
        background: bord,
        borderRadius: 20,
        maxWidth: 560,
        marginBottom: 8,
        overflow: 'hidden'
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        height: '100%',
        width: p._progress + '%',
        background: `linear-gradient(90deg, #C9A45A, #AD832F)`,
        borderRadius: 20
      }
    })), /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 12,
        letterSpacing: '0.08em',
        textTransform: 'uppercase',
        color: sub,
        marginBottom: 18,
        fontFamily: C.fontSans
      }
    }, p._doneMs, " of ", p._totalMs, " milestones \xB7 ", p._progress, "% done"), spine, tasksBlock);
    return wide ? /*#__PURE__*/React.createElement(React.Fragment, null, header, dtabBar, dtab === 'overview' ? /*#__PURE__*/React.createElement("div", {
      style: {
        display: 'flex',
        flex: 1,
        minHeight: 0
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        flex: 1,
        minWidth: 0,
        overflowY: 'auto'
      }
    }, mainCol), /*#__PURE__*/React.createElement("div", {
      style: {
        width: 260,
        flexShrink: 0,
        borderLeft: `1px solid ${bord}`,
        padding: '16px 18px',
        overflowY: 'auto'
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 11,
        letterSpacing: '0.14em',
        textTransform: 'uppercase',
        color: sub,
        fontWeight: 600,
        marginBottom: 6,
        fontFamily: C.fontSans
      }
    }, "Details"), detailFields(p))) : dtab === 'list' ? listTab(p) : dtab === 'board' ? boardTab(p) : timelineTab(p), openTask && /*#__PURE__*/React.createElement(TaskDrawer, {
      dark: dark,
      onClose: () => {
        setOpenTask(null);
        setTaskEditing(false);
      }
    }, taskDetailOverlay())) : /*#__PURE__*/React.createElement(React.Fragment, null, header, dtabBar, dtab === 'overview' ? /*#__PURE__*/React.createElement("div", {
      style: {
        flex: 1,
        minHeight: 0,
        overflowY: 'auto'
      }
    }, mainCol, /*#__PURE__*/React.createElement("div", {
      style: {
        padding: '0 14px 24px'
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 11,
        letterSpacing: '0.14em',
        textTransform: 'uppercase',
        color: sub,
        fontWeight: 600,
        margin: '8px 0 6px',
        fontFamily: C.fontSans
      }
    }, "Details"), detailFields(p))) : dtab === 'list' ? listTab(p) : dtab === 'board' ? boardTab(p) : timelineTab(p));
  };

  // ── FORM (create / edit) ──
  const formView = () => /*#__PURE__*/React.createElement(ProjectForm, {
    kind: kind,
    dark: dark,
    team: team,
    user: user,
    project: current,
    onCancel: () => setPview(current ? 'detail' : 'list'),
    onSaved: async savedId => {
      const fresh = await reload();
      const sel = fresh.find(p => p.id === savedId);
      setCurrent(sel || null);
      setPview(sel ? 'detail' : 'list');
    },
    onArchived: async () => {
      await reload();
      setCurrent(null);
      setPview('list');
    }
  });

  // ── list header ──
  const listHeader = /*#__PURE__*/React.createElement("div", {
    style: {
      padding: wide ? '26px 34px 0' : '12px 14px 0',
      flexShrink: 0
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: wide ? 'flex-start' : 'flex-end',
      justifyContent: 'space-between',
      gap: 16,
      marginBottom: 6,
      flexWrap: 'wrap'
    }
  }, titleNode ? titleNode(wide ? undefined : 15) : /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: wide ? 27 : 15,
      fontWeight: wide ? 500 : 600,
      color: ink,
      fontFamily: C.fontSans
    }
  }, KL.plural), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: wide ? 8 : 5,
      flexWrap: 'wrap'
    }
  }, groupChip, sortChip, searchChip, newBtn)));
  // Desktop column header — distinct per surface: CTC is property/deadline/
  // rail/agent/attention, Projects is name+outcome/next milestone/progress/owner/target.
  const theadRow = /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      padding: '0 34px 8px',
      fontSize: 10.5,
      letterSpacing: '0.14em',
      textTransform: 'uppercase',
      fontWeight: 500,
      color: sub,
      borderBottom: `1px solid ${bord}`,
      gap: 12,
      fontFamily: C.fontSans
    }
  }, isCtc ? /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("span", {
    style: {
      width: 224,
      flexShrink: 0
    }
  }, "Property"), /*#__PURE__*/React.createElement("span", {
    style: {
      width: 146,
      flexShrink: 0
    }
  }, "Next binding date"), /*#__PURE__*/React.createElement("span", {
    style: {
      flex: 1
    }
  }, "Milestone chain"), /*#__PURE__*/React.createElement("span", {
    style: {
      width: 96,
      flexShrink: 0
    }
  }, "Agent"), /*#__PURE__*/React.createElement("span", {
    style: {
      width: 96,
      flexShrink: 0,
      textAlign: 'right'
    }
  }, "Attention")) : /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("span", {
    style: {
      width: 250,
      flexShrink: 0
    }
  }, KL.singular, " & outcome"), /*#__PURE__*/React.createElement("span", {
    style: {
      flex: 1
    }
  }, "Next milestone"), /*#__PURE__*/React.createElement("span", {
    style: {
      width: 150,
      flexShrink: 0
    }
  }, "Progress"), /*#__PURE__*/React.createElement("span", {
    style: {
      width: 110,
      flexShrink: 0
    }
  }, "Owner"), /*#__PURE__*/React.createElement("span", {
    style: {
      width: 96,
      flexShrink: 0,
      textAlign: 'right'
    }
  }, "Target")));
  const wideRowFn = isCtc ? ctcRow : projRow;

  // CTC Files carries a second tab beside the file list: the consolidated
  // Emails inbox. Intercepted here rather than threaded through both the
  // wide and narrow list layouts below, which it replaces wholesale.
  const ctcTabBar = isCtc && pview === 'list' ? /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 2,
      padding: wide ? '0 34px' : '0 14px',
      borderBottom: `1px solid ${bord}`,
      flexShrink: 0
    }
  }, [['files', KL.plural], ['emails', 'Emails']].map(([id, label]) => /*#__PURE__*/React.createElement("div", {
    key: id,
    onClick: () => setCtcTab(id),
    style: {
      padding: '10px 16px',
      fontSize: 13,
      color: ctcTab === id ? ink : sub,
      fontWeight: ctcTab === id ? 500 : 400,
      borderBottom: `2px solid ${ctcTab === id ? gold : 'transparent'}`,
      cursor: 'pointer',
      fontFamily: C.fontSans,
      marginBottom: -1
    }
  }, label))) : null;
  if (isCtc && pview === 'list' && ctcTab === 'emails') {
    return /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
      style: {
        padding: wide ? '26px 34px 0' : '12px 14px 0',
        flexShrink: 0
      }
    }, titleNode ? titleNode(wide ? 27 : '1.05rem') : null), ctcTabBar, /*#__PURE__*/React.createElement(CtcEmailsTab, {
      dark: dark,
      user: user,
      files: rows,
      onFiled: reload
    }));
  }
  return /*#__PURE__*/React.createElement(React.Fragment, null, pview === 'form' ? formView() : pview === 'detail' ? detailView() : wide && !hideSidebar ? /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flex: 1,
      minHeight: 0
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: 216,
      flexShrink: 0,
      borderRight: `1px solid ${bord}`,
      padding: '18px 0',
      background: dark ? '#08132A' : '#FCFBF8',
      overflowY: 'auto'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: '0.62rem',
      fontWeight: 700,
      letterSpacing: '0.16em',
      textTransform: 'uppercase',
      color: sub,
      padding: '0 18px',
      marginBottom: 8,
      fontFamily: C.fontSans
    }
  }, KL.plural), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 10,
      padding: '8px 18px',
      fontSize: '0.82rem',
      fontWeight: 500,
      color: ink,
      background: dark ? 'rgba(255,255,255,0.06)' : '#F7F4EE',
      boxShadow: `inset 2px 0 0 ${gold}`,
      fontFamily: C.fontSans
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      width: 6,
      height: 6,
      borderRadius: '50%',
      background: gold,
      flexShrink: 0
    }
  }), 'All ' + KL.plural.toLowerCase(), /*#__PURE__*/React.createElement("span", {
    style: {
      marginLeft: 'auto',
      fontSize: '0.7rem',
      color: sub
    }
  }, rows.length))), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      minWidth: 0,
      display: 'flex',
      flexDirection: 'column',
      minHeight: 0
    }
  }, listHeader, ctcTabBar, theadRow, /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      minHeight: 0,
      overflowY: 'auto',
      padding: '4px 18px 24px'
    }
  }, listBody(wideRowFn, true)))) : wide ? /*#__PURE__*/React.createElement(React.Fragment, null, listHeader, ctcTabBar, theadRow, /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      minHeight: 0,
      overflowY: 'auto',
      padding: '4px 34px 24px'
    }
  }, listBody(wideRowFn, true))) : /*#__PURE__*/React.createElement(React.Fragment, null, listHeader, ctcTabBar, /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      minHeight: 0,
      overflowY: 'auto',
      padding: '12px 14px 24px'
    }
  }, listBody(isCtc ? ctcCard : projCard, false))), zohoLinkOpen && current && /*#__PURE__*/React.createElement(ZohoLinkModal, {
    dark: dark,
    project: current,
    onClose: () => setZohoLinkOpen(false),
    onLinked: async () => {
      setZohoLinkOpen(false);
      await refreshContainer();
    }
  }));
}

// Create / edit a project (or CTC file). record_type is fixed by `kind`.
function ProjectForm({
  kind,
  dark,
  team,
  user,
  project,
  onCancel,
  onSaved,
  onArchived
}) {
  const p = project || {};
  const [name, setName] = useState(p.name || '');
  const [status, setStatus] = useState(p.status || 'on_track');
  const [outcome, setOutcome] = useState(p.outcome || '');
  const [groupTag, setGroupTag] = useState(p.group_tag || '');
  const [ownerId, setOwnerId] = useState(p.owner_id || '');
  const [startedAt, setStartedAt] = useState(p.started_at || '');
  const [targetDate, setTargetDate] = useState(p.target_date || '');
  const [saving, setSaving] = useState(false);
  const KL = kindLabel(kind);
  const bord = dark ? '#152545' : '#E4DFD4',
    ink = dark ? '#fff' : '#001A4A',
    sub = dark ? 'rgba(255,255,255,0.5)' : '#6B6B6B';
  const lbl = {
    fontSize: 11,
    color: sub,
    letterSpacing: '0.1em',
    textTransform: 'uppercase',
    fontWeight: 500,
    margin: '0 0 5px',
    fontFamily: C.fontSans
  };
  const inp = {
    width: '100%',
    padding: '9px 11px',
    background: dark ? '#06101F' : '#F7F4EE',
    border: `1px solid ${bord}`,
    borderRadius: 6,
    color: ink,
    fontSize: 14,
    outline: 'none',
    fontFamily: C.fontSans,
    boxSizing: 'border-box'
  };
  const field = (label, node) => /*#__PURE__*/React.createElement("div", {
    style: {
      marginBottom: 16
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: lbl
  }, label), node);
  async function save() {
    if (!name.trim() || saving) return;
    setSaving(true);
    try {
      const fields = {
        name: name.trim(),
        record_type: kind,
        status,
        outcome: outcome.trim() || null,
        group_tag: groupTag.trim() || null,
        owner_id: ownerId || null,
        started_at: startedAt || null,
        target_date: targetDate || null
      };
      let id = p.id;
      if (id) await ProjectDB.update(id, fields);else {
        const created = await ProjectDB.create(fields, user);
        id = created && created.id;
      }
      onSaved(id);
    } finally {
      setSaving(false);
    }
  }
  return /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      minHeight: 0,
      overflowY: 'auto'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      padding: '12px 16px',
      borderBottom: `1px solid ${bord}`,
      flexShrink: 0
    }
  }, /*#__PURE__*/React.createElement("i", {
    className: "ti ti-chevron-left",
    onClick: onCancel,
    style: {
      fontSize: 16,
      cursor: 'pointer',
      color: sub
    }
  }), /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: C.fontSans,
      fontSize: 13,
      fontWeight: 600,
      color: ink
    }
  }, p.id ? 'Edit' : 'New', " ", KL.article)), /*#__PURE__*/React.createElement("div", {
    style: {
      padding: '16px 16px 40px',
      maxWidth: 640
    }
  }, field(KL.singular + ' name', /*#__PURE__*/React.createElement("input", {
    value: name,
    onChange: e => setName(e.target.value),
    placeholder: KL.namePlaceholder,
    style: inp
  })), field('Outcome', /*#__PURE__*/React.createElement("textarea", {
    value: outcome,
    onChange: e => setOutcome(e.target.value),
    rows: 2,
    placeholder: "One sentence \u2014 what this is trying to achieve",
    style: {
      ...inp,
      resize: 'vertical',
      lineHeight: 1.5
    }
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 10
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1
    }
  }, field('Status', /*#__PURE__*/React.createElement("select", {
    value: status,
    onChange: e => setStatus(e.target.value),
    style: inp
  }, PROJECT_STATUS.map(s => /*#__PURE__*/React.createElement("option", {
    key: s.id,
    value: s.id
  }, s.label))))), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1
    }
  }, field(KL.groupLabel, /*#__PURE__*/React.createElement("input", {
    value: groupTag,
    onChange: e => setGroupTag(e.target.value),
    placeholder: KL.groupPlaceholder,
    style: inp
  })))), field('Owner', /*#__PURE__*/React.createElement("select", {
    value: ownerId,
    onChange: e => setOwnerId(e.target.value),
    style: inp
  }, /*#__PURE__*/React.createElement("option", {
    value: ""
  }, "(No owner)"), team.map(m => /*#__PURE__*/React.createElement("option", {
    key: m.id,
    value: m.id
  }, m.name)))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 10
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1
    }
  }, field('Started', /*#__PURE__*/React.createElement("input", {
    type: "date",
    value: startedAt || '',
    onChange: e => setStartedAt(e.target.value),
    style: inp
  }))), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1
    }
  }, field('Target', /*#__PURE__*/React.createElement("input", {
    type: "date",
    value: targetDate || '',
    onChange: e => setTargetDate(e.target.value),
    style: inp
  })))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 8,
      marginTop: 6
    }
  }, /*#__PURE__*/React.createElement("button", {
    onClick: save,
    disabled: saving || !name.trim(),
    style: {
      flex: 1,
      padding: '11px 16px',
      background: C.navy,
      color: '#fff',
      border: 'none',
      borderRadius: 22,
      fontSize: 13,
      fontWeight: 500,
      letterSpacing: '0.02em',
      cursor: 'pointer',
      fontFamily: C.fontSans,
      opacity: !name.trim() ? 0.5 : 1
    }
  }, saving ? 'Saving…' : p.id ? 'Save changes' : 'Create ' + KL.article), /*#__PURE__*/React.createElement("button", {
    onClick: onCancel,
    style: {
      flex: 1,
      padding: '11px 16px',
      background: 'none',
      color: sub,
      border: `1px solid ${bord}`,
      borderRadius: 22,
      fontSize: 13,
      cursor: 'pointer',
      fontFamily: C.fontSans
    }
  }, "Cancel")), p.id && /*#__PURE__*/React.createElement("button", {
    onClick: async () => {
      if (!window.confirm('Archive this ' + KL.article + '? It will be hidden from the list.')) return;
      await ProjectDB.archive(p.id);
      onArchived();
    },
    style: {
      width: '100%',
      marginTop: 8,
      padding: '9px',
      background: 'none',
      color: '#C0392B',
      border: `1px solid #C0392B55`,
      borderRadius: 8,
      fontSize: '0.82rem',
      cursor: 'pointer',
      fontFamily: C.fontSans
    }
  }, /*#__PURE__*/React.createElement("i", {
    className: "ti ti-archive",
    style: {
      marginRight: 6,
      fontSize: 13
    }
  }), "Archive ", KL.article)));
}

// Reusable Kanban board — takes an arbitrary task array + callbacks so it
// works both for My Tasks' own list and for a Project/CTC File/Rock's tasks
// (ProjectsSurface). Real HTML5 drag-and-drop between status columns; drop
// calls onDrop(taskId, newStatus) so the caller decides how to persist it.
function TaskBoard({
  items,
  dark,
  onOpen,
  onContextMenu,
  onDrop,
  showSource,
  linksByTask
}) {
  const bord = dark ? '#152545' : '#E4DFD4',
    ink = dark ? '#fff' : '#001A4A',
    sub = dark ? 'rgba(255,255,255,0.5)' : '#6B6B6B',
    gold = dark ? '#C9A45A' : '#AD832F';
  const [dragId, setDragId] = useState(null);
  const [overCol, setOverCol] = useState(null);
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'grid',
      gridTemplateColumns: 'repeat(4, minmax(220px, 1fr))',
      gap: 14,
      padding: '18px 34px',
      overflowX: 'auto',
      flex: 1,
      minHeight: 0,
      alignContent: 'start'
    }
  }, TASK_STATUS.map(col => {
    const colItems = items.filter(t => t.status === col.id);
    return /*#__PURE__*/React.createElement("div", {
      key: col.id,
      onDragOver: e => {
        e.preventDefault();
        setOverCol(col.id);
      },
      onDragLeave: () => setOverCol(o => o === col.id ? null : o),
      onDrop: e => {
        e.preventDefault();
        setOverCol(null);
        if (dragId != null && onDrop) onDrop(dragId, col.id);
        setDragId(null);
      },
      style: {
        background: overCol === col.id ? dark ? 'rgba(201,164,90,.1)' : '#F3EBDA' : dark ? 'rgba(255,255,255,.03)' : 'rgba(255,255,255,.55)',
        border: `1px solid ${overCol === col.id ? 'rgba(201,164,90,.5)' : bord}`,
        borderRadius: 8,
        padding: 10,
        minHeight: 200,
        transition: 'background .12s'
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '4px 6px 12px'
      }
    }, /*#__PURE__*/React.createElement("span", {
      style: {
        width: 9,
        height: 9,
        borderRadius: '50%',
        background: col.color,
        flexShrink: 0
      }
    }), /*#__PURE__*/React.createElement("span", {
      style: {
        fontSize: 11,
        letterSpacing: '0.12em',
        textTransform: 'uppercase',
        fontWeight: 600,
        color: ink,
        fontFamily: C.fontSans
      }
    }, col.label), /*#__PURE__*/React.createElement("span", {
      style: {
        fontSize: 11,
        color: sub,
        marginLeft: 'auto'
      }
    }, colItems.length)), colItems.map(t => /*#__PURE__*/React.createElement("div", {
      key: t.id,
      draggable: true,
      onDragStart: e => {
        setDragId(t.id);
        e.dataTransfer.effectAllowed = 'move';
      },
      onDragEnd: () => setDragId(null),
      onClick: () => onOpen(t),
      onContextMenu: e => onContextMenu && onContextMenu(e, t),
      style: {
        background: dark ? '#0A1730' : '#fff',
        border: `1px solid ${bord}`,
        borderRadius: 6,
        padding: '11px 12px',
        marginBottom: 9,
        boxShadow: '0 1px 2px rgba(0,13,38,.06)',
        cursor: 'grab',
        opacity: dragId === t.id ? 0.4 : 1
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        display: 'flex',
        alignItems: 'flex-start',
        gap: 6,
        marginBottom: 9
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        flex: 1,
        minWidth: 0,
        fontSize: 14,
        color: ink,
        fontFamily: C.fontSans,
        lineHeight: 1.35
      }
    }, t.title), (linksByTask && linksByTask[t.id] || []).length > 0 && /*#__PURE__*/React.createElement("i", {
      className: "ti ti-mail",
      style: {
        fontSize: 12,
        color: '#185FA5',
        flexShrink: 0
      }
    }), t.is_milestone && /*#__PURE__*/React.createElement("i", {
      className: "ti ti-flag-3-filled",
      style: {
        fontSize: 12,
        color: gold,
        flexShrink: 0
      }
    })), /*#__PURE__*/React.createElement("div", {
      style: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 6,
        flexWrap: 'wrap'
      }
    }, showSource && t._projectName ? /*#__PURE__*/React.createElement("span", {
      style: {
        fontSize: 11,
        color: sub,
        fontFamily: C.fontSans,
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis'
      }
    }, t._projectName) : /*#__PURE__*/React.createElement("span", null), t.due_at && /*#__PURE__*/React.createElement("span", {
      style: {
        fontSize: 12,
        color: sub
      }
    }, new Date(t.due_at).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric'
    }))))), !colItems.length && /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: '0.7rem',
        color: sub,
        padding: '8px 4px',
        fontFamily: C.fontSans
      }
    }, "No tasks."));
  }));
}

// Timeline (Gantt-lite) — a month-grid of colored bars, one row per dated
// task. The window is computed from the data (earliest of today/first due
// date, spanning at least 3 months, extended to cover the latest due date)
// rather than a fixed range, since real due dates won't sit in any one
// hardcoded window. Undated tasks are left out (shown nowhere useful on a
// date axis) rather than parked at a misleading midpoint.
function TaskTimeline({
  items,
  dark,
  onOpen
}) {
  const bord = dark ? '#152545' : '#E4DFD4',
    ink = dark ? '#fff' : '#001A4A',
    sub = dark ? 'rgba(255,255,255,0.5)' : '#6B6B6B';
  const dated = items.filter(t => t.due_at).slice().sort((a, b) => new Date(a.due_at) - new Date(b.due_at));
  if (!dated.length) return /*#__PURE__*/React.createElement("div", {
    style: {
      padding: 24,
      color: sub,
      fontSize: '0.82rem',
      fontFamily: C.fontSans,
      textAlign: 'center'
    }
  }, "No dated tasks to place on a timeline.");
  const today = new Date();
  const dueDates = dated.map(t => new Date(t.due_at));
  const start = new Date(Math.min(today, ...dueDates));
  start.setDate(1);
  start.setHours(0, 0, 0, 0);
  const latest = new Date(Math.max(today, ...dueDates));
  const monthsSpan = Math.max(3, (latest.getFullYear() - start.getFullYear()) * 12 + (latest.getMonth() - start.getMonth()) + 1);
  const months = Array.from({
    length: monthsSpan
  }, (_, i) => new Date(start.getFullYear(), start.getMonth() + i, 1));
  const end = new Date(start.getFullYear(), start.getMonth() + monthsSpan, 1);
  const totalMs = end - start;
  return /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      minHeight: 0,
      overflow: 'auto',
      padding: '14px 18px 24px'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      border: `1px solid ${bord}`,
      borderRadius: 8,
      overflow: 'hidden',
      minWidth: 640
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      background: dark ? '#08132A' : '#FCFBF8',
      borderBottom: `1px solid ${bord}`
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: 200,
      flexShrink: 0,
      padding: '9px 14px',
      fontSize: '0.6rem',
      letterSpacing: '0.14em',
      textTransform: 'uppercase',
      color: sub,
      fontWeight: 600,
      fontFamily: C.fontSans
    }
  }, "Task"), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      display: 'flex'
    }
  }, months.map((m, i) => /*#__PURE__*/React.createElement("div", {
    key: i,
    style: {
      flex: 1,
      padding: '9px 10px',
      fontSize: '0.6rem',
      letterSpacing: '0.12em',
      textTransform: 'uppercase',
      color: sub,
      fontWeight: 600,
      borderLeft: i ? `1px solid ${bord}` : 'none',
      fontFamily: C.fontSans
    }
  }, m.toLocaleDateString('en-US', {
    month: 'short'
  }))))), dated.map(t => {
    const due = new Date(t.due_at);
    const widthMs = 14 * 86400000;
    const leftMs = Math.max(0, due - start - widthMs);
    const leftPct = leftMs / totalMs * 100;
    const rightMs = Math.min(totalMs, due - start);
    const widthPct = Math.max((rightMs - leftMs) / totalMs * 100, 3);
    return /*#__PURE__*/React.createElement("div", {
      key: t.id,
      style: {
        display: 'flex',
        alignItems: 'center',
        borderBottom: `1px solid ${bord}`
      }
    }, /*#__PURE__*/React.createElement("div", {
      onClick: () => onOpen && onOpen(t),
      style: {
        width: 200,
        flexShrink: 0,
        padding: '10px 14px',
        fontSize: '0.76rem',
        color: ink,
        fontFamily: C.fontSans,
        cursor: onOpen ? 'pointer' : 'default',
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        minWidth: 0
      }
    }, t.is_milestone && /*#__PURE__*/React.createElement("i", {
      className: "ti ti-flag-3-filled",
      style: {
        fontSize: 11,
        color: '#AD832F',
        flexShrink: 0
      }
    }), /*#__PURE__*/React.createElement("span", {
      style: {
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap'
      }
    }, t.title)), /*#__PURE__*/React.createElement("div", {
      style: {
        flex: 1,
        position: 'relative',
        height: 38
      }
    }, /*#__PURE__*/React.createElement("div", {
      onClick: () => onOpen && onOpen(t),
      style: {
        position: 'absolute',
        top: 8,
        left: leftPct + '%',
        width: widthPct + '%',
        height: 22,
        borderRadius: 5,
        background: statusColor(t.status),
        display: 'flex',
        alignItems: 'center',
        padding: '0 8px',
        color: '#fff',
        fontSize: '0.62rem',
        fontFamily: C.fontSans,
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        cursor: onOpen ? 'pointer' : 'default'
      }
    }, statusLabel(t.status))));
  })));
}

// Task detail slide-over — a right-side drawer over a dimmed scrim, so the
// list underneath stays visible (and mounted) instead of being replaced.
// Desktop-only by design: on a narrow/mobile viewport there's no "list you'd
// lose" — the standalone page's existing full-screen push nav stays as-is
// there. Escape closes it, matching the rest of the app's overlay patterns.
function TaskDrawer({
  dark,
  onClose,
  children,
  width
}) {
  useEffect(() => {
    const onKey = e => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  return /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    onClick: onClose,
    style: {
      position: 'fixed',
      inset: 0,
      background: 'rgba(0,13,38,0.32)',
      zIndex: 90
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'fixed',
      top: 0,
      right: 0,
      bottom: 0,
      width: width || 'min(560px, 94vw)',
      background: dark ? '#000D26' : '#FCFBF8',
      boxShadow: '-14px 0 44px rgba(0,13,38,.22)',
      zIndex: 91,
      display: 'flex',
      flexDirection: 'column'
    }
  }, children));
}

// ── My Tasks email mailbox pop-out [brief §2.2] ──────────────────────
// Mailbox-first: browse Gmail here, attach a thread to a task from a
// thread row. Stays open after an attach so several threads can be
// linked in a row. Ported from tmg-toolbar-email-prototype_1.html's
// .mailbox/.mbsearch/.mbtabs/.thread/.attach/.linked/.picker.
function TaskMailbox({
  dark,
  user,
  tasks,
  linksByTask,
  onAttached,
  onOpenTask,
  onClose,
  onCreateTask
}) {
  const [tab, setTab] = useState('inbox'); // 'inbox' | 'attached' | 'sent'
  const [query, setQuery] = useState('');
  const [threads, setThreads] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);
  const [pickerFor, setPickerFor] = useState(null); // threadId with its picker open

  const sub = dark ? 'rgba(255,255,255,0.55)' : '#54607A';
  const ink = dark ? '#fff' : '#12203D';
  const bord = dark ? '#152545' : '#E4DFD4';
  const card = dark ? '#0A1730' : '#fff';
  const gold = '#AD832F';

  // threadId -> [{taskId, title}] — every task this thread is already linked to.
  const linkedTasksFor = threadId => {
    const out = [];
    Object.keys(linksByTask || {}).forEach(taskId => {
      if ((linksByTask[taskId] || []).some(l => l.thread_id === threadId)) {
        const t = tasks.find(x => x.id === taskId);
        if (t) out.push(t);
      }
    });
    return out;
  };
  async function load() {
    setLoading(true);
    setErr(null);
    const q = tab === 'sent' ? ('in:sent ' + query).trim() : query.trim();
    const {
      ok,
      data
    } = await callCalendar({
      action: 'gmail_threads',
      q: q || undefined,
      maxResults: 30
    });
    setLoading(false);
    if (!ok) {
      setErr(data?.error === 'needs_connect' ? 'needs_connect' : data?.error || 'Could not load mail.');
      setThreads([]);
      return;
    }
    setThreads(data.threads || []);
  }
  // One effect for both triggers (not two) — switching tabs while a search is
  // already typed would otherwise fire two overlapping loads on mount/tab-change.
  useEffect(() => {
    const id = setTimeout(load, query ? 350 : 0);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, query]);
  const visible = tab === 'attached' ? threads.filter(t => linkedTasksFor(t.id).length) : threads;
  async function doAttach(threadId, taskId) {
    const th = threads.find(t => t.id === threadId);
    if (!th) return;
    setPickerFor(null);
    const link = await TaskEmailDB.attach(taskId, th, user, false);
    if (link) onAttached(taskId, link);
  }
  // "Create task from this email" [brief §2.5 auto-link] — the new task's
  // email-link is written automatically and marked Auto-linked.
  async function doCreateTask(threadId) {
    const th = threads.find(t => t.id === threadId);
    if (!th) return;
    setPickerFor(null);
    await onCreateTask(th);
  }
  const tabBtn = (id, label) => /*#__PURE__*/React.createElement("div", {
    key: id,
    onClick: () => setTab(id),
    style: {
      fontSize: 12,
      letterSpacing: '0.06em',
      textTransform: 'uppercase',
      color: tab === id ? ink : sub,
      padding: '8px 0',
      borderBottom: `2px solid ${tab === id ? gold : 'transparent'}`,
      marginBottom: -1,
      fontWeight: tab === id ? 500 : 400,
      cursor: 'pointer',
      fontFamily: C.fontSans
    }
  }, label);
  return /*#__PURE__*/React.createElement(TaskDrawer, {
    dark: dark,
    onClose: onClose,
    width: "min(460px, 96vw)"
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      background: card,
      borderBottom: `1px solid ${bord}`,
      padding: '14px 18px',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      flexShrink: 0
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 10
    }
  }, /*#__PURE__*/React.createElement("svg", {
    viewBox: "0 0 48 48",
    style: {
      width: 22,
      height: 22
    }
  }, /*#__PURE__*/React.createElement("path", {
    fill: "#4285F4",
    d: "M44 8v2L24 24 44 8z"
  }), /*#__PURE__*/React.createElement("path", {
    fill: "#34A853",
    d: "M4 10v28a2 2 0 002 2h6V16z"
  }), /*#__PURE__*/React.createElement("path", {
    fill: "#FBBC05",
    d: "M44 10v28a2 2 0 01-2 2h-6V16z"
  }), /*#__PURE__*/React.createElement("path", {
    fill: "#C5221F",
    d: "M4 8l20 14L44 8"
  }), /*#__PURE__*/React.createElement("path", {
    fill: "#EA4335",
    d: "M4 8a2 2 0 012-2h2l16 11L40 6h2a2 2 0 012 2z"
  })), /*#__PURE__*/React.createElement("h3", {
    style: {
      fontSize: 14,
      letterSpacing: '0.14em',
      textTransform: 'uppercase',
      color: '#001A4A',
      fontFamily: C.fontSans,
      fontWeight: 500
    }
  }, "Mailbox")), /*#__PURE__*/React.createElement("i", {
    className: "ti ti-x",
    onClick: onClose,
    "aria-label": "Close",
    style: {
      fontSize: 16,
      cursor: 'pointer',
      color: sub
    }
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      border: `1px solid ${bord}`,
      borderRadius: 22,
      background: card,
      padding: '9px 14px',
      margin: '14px 16px',
      flexShrink: 0
    }
  }, /*#__PURE__*/React.createElement("i", {
    className: "ti ti-search",
    style: {
      fontSize: 13,
      color: sub
    }
  }), /*#__PURE__*/React.createElement("input", {
    value: query,
    onChange: e => setQuery(e.target.value),
    placeholder: "Search mail \u2014 sender, subject\u2026",
    style: {
      border: 'none',
      outline: 'none',
      flex: 1,
      fontSize: '0.85rem',
      background: 'transparent',
      color: ink,
      fontFamily: C.fontSans
    }
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 16,
      padding: '0 18px',
      borderBottom: `1px solid ${bord}`,
      flexShrink: 0
    }
  }, tabBtn('inbox', 'Inbox'), tabBtn('attached', 'Attached'), tabBtn('sent', 'Sent')), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      overflowY: 'auto',
      WebkitOverflowScrolling: 'touch'
    }
  }, loading ? /*#__PURE__*/React.createElement("div", {
    style: {
      padding: 24,
      textAlign: 'center',
      color: sub,
      fontSize: '0.82rem',
      fontFamily: C.fontSans
    }
  }, "Loading\u2026") : err === 'needs_connect' ? /*#__PURE__*/React.createElement("div", {
    style: {
      padding: 24,
      textAlign: 'center',
      fontFamily: C.fontSans
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      color: sub,
      fontSize: '0.82rem',
      marginBottom: 10
    }
  }, "Connect Google to read mail here."), /*#__PURE__*/React.createElement("button", {
    onClick: () => window.SupabaseAuth.connectCalendar(),
    style: {
      background: '#001A4A',
      color: '#fff',
      border: 'none',
      borderRadius: 22,
      padding: '8px 16px',
      fontSize: 13,
      fontWeight: 500,
      cursor: 'pointer',
      fontFamily: C.fontSans
    }
  }, "Connect Google")) : err ? /*#__PURE__*/React.createElement("div", {
    style: {
      padding: 24,
      textAlign: 'center',
      color: sub,
      fontSize: '0.82rem',
      fontFamily: C.fontSans
    }
  }, err) : visible.length === 0 ? /*#__PURE__*/React.createElement("div", {
    style: {
      padding: 24,
      textAlign: 'center',
      color: sub,
      fontSize: '0.82rem',
      fontFamily: C.fontSans
    }
  }, "No mail here.") : visible.map(th => {
    const linked = linkedTasksFor(th.id);
    return /*#__PURE__*/React.createElement("div", {
      key: th.id,
      style: {
        padding: '13px 18px',
        borderBottom: `1px solid ${dark ? '#152037' : '#efeee7'}`,
        position: 'relative',
        fontFamily: C.fontSans
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        display: 'flex',
        alignItems: 'center',
        gap: 9
      }
    }, /*#__PURE__*/React.createElement("span", {
      style: {
        width: 30,
        height: 30,
        borderRadius: '50%',
        background: 'linear-gradient(135deg,#3a4a72,#1a2748)',
        color: '#fff',
        fontSize: 11,
        display: 'grid',
        placeItems: 'center',
        flexShrink: 0
      }
    }, (th.from || '?').trim().charAt(0).toUpperCase()), /*#__PURE__*/React.createElement("span", {
      style: {
        fontSize: 13,
        fontWeight: 500,
        color: ink,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap'
      }
    }, th.from), /*#__PURE__*/React.createElement("span", {
      style: {
        fontSize: 11,
        color: sub,
        marginLeft: 'auto',
        flexShrink: 0
      }
    }, th.date)), /*#__PURE__*/React.createElement("div", {
      onClick: () => linked[0] && onOpenTask(linked[0], th.id),
      style: {
        fontSize: 13.5,
        color: '#001A4A',
        margin: '6px 0 2px',
        fontWeight: 500,
        cursor: linked[0] ? 'pointer' : 'default'
      }
    }, th.subject), /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 12.5,
        color: sub,
        overflow: 'hidden',
        display: '-webkit-box',
        WebkitLineClamp: 2,
        WebkitBoxOrient: 'vertical'
      }
    }, th.snippet), /*#__PURE__*/React.createElement("div", {
      style: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        marginTop: 9
      }
    }, linked.length ? /*#__PURE__*/React.createElement("span", {
      style: {
        fontSize: 11,
        color: '#0F6E56',
        background: '#E6F2EC',
        border: '1px solid #A0D9C4',
        borderRadius: 20,
        padding: '4px 10px',
        display: 'inline-flex',
        gap: 6,
        alignItems: 'center',
        cursor: 'pointer'
      },
      onClick: () => onOpenTask(linked[0], th.id)
    }, "\u2713 Linked to \"", linked[0].title, "\"", linked.length > 1 ? ' +' + (linked.length - 1) : '') : /*#__PURE__*/React.createElement("button", {
      onClick: () => setPickerFor(p => p === th.id ? null : th.id),
      style: {
        fontSize: 11,
        letterSpacing: '0.05em',
        textTransform: 'uppercase',
        color: gold,
        border: '1px solid #E8D9BC',
        background: '#F3EBDA',
        borderRadius: 20,
        padding: '4px 11px',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        cursor: 'pointer',
        fontFamily: C.fontSans
      }
    }, /*#__PURE__*/React.createElement("i", {
      className: "ti ti-link",
      style: {
        fontSize: 12
      }
    }), "Attach to task"), /*#__PURE__*/React.createElement("a", {
      href: th.permalink,
      target: "_blank",
      rel: "noopener noreferrer",
      style: {
        fontSize: 11,
        color: gold,
        fontFamily: C.fontSans
      }
    }, "Open in Gmail \u2197")), pickerFor === th.id && /*#__PURE__*/React.createElement("div", {
      style: {
        position: 'absolute',
        right: 16,
        bottom: 44,
        background: card,
        border: `1px solid ${bord}`,
        borderRadius: 8,
        boxShadow: '0 12px 32px rgba(0,26,74,0.16)',
        padding: 6,
        minWidth: 240,
        zIndex: 30
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 10,
        letterSpacing: '0.14em',
        textTransform: 'uppercase',
        color: sub,
        padding: '7px 9px 4px'
      }
    }, "Attach to which task?"), /*#__PURE__*/React.createElement("button", {
      onClick: () => doCreateTask(th.id),
      style: {
        display: 'flex',
        width: '100%',
        alignItems: 'center',
        gap: 8,
        padding: '8px 9px',
        borderRadius: 5,
        fontSize: 13,
        textAlign: 'left',
        color: gold,
        fontWeight: 500,
        fontFamily: C.fontSans,
        borderBottom: `1px solid ${bord}`,
        marginBottom: 4
      }
    }, /*#__PURE__*/React.createElement("i", {
      className: "ti ti-plus",
      style: {
        fontSize: 13
      }
    }), "New task from this email"), tasks.filter(t => t.status !== 'done').map(t => /*#__PURE__*/React.createElement("button", {
      key: t.id,
      onClick: () => doAttach(th.id, t.id),
      style: {
        display: 'flex',
        width: '100%',
        alignItems: 'center',
        gap: 8,
        padding: '8px 9px',
        borderRadius: 5,
        fontSize: 13,
        textAlign: 'left',
        color: ink,
        fontFamily: C.fontSans
      }
    }, /*#__PURE__*/React.createElement("span", {
      style: {
        width: 6,
        height: 6,
        borderRadius: '50%',
        background: statusColor(t.status),
        flexShrink: 0
      }
    }), t.title))));
  })));
}
function TasksScreen({
  dark,
  user,
  onClose,
  initialTask
}) {
  const [data, setData] = useState({
    tasks: [],
    peopleByTask: {},
    projById: {},
    labelsByTask: {}
  });
  const [team, setTeam] = useState([]);
  const [loading, setLoading] = useState(true);
  // { [taskId]: [link, ...] } — every task's linked Gmail threads [brief §2.1].
  const [linksByTask, setLinksByTask] = useState({});
  const [mailboxOpen, setMailboxOpen] = useState(false);
  // Set right before opening a task from the mailbox or a subject email icon,
  // so TaskDetail lands straight on its Email tab instead of Details [brief §2.3].
  const [emailTabFocus, setEmailTabFocus] = useState(null);
  const [view, setView] = useState('list'); // list | detail | form | labels
  const [current, setCurrent] = useState(null);
  const [sortBy, setSortBy] = useState(() => localStorage.getItem('tmg-tasks-group') || 'status'); // status | due | label | none  (primary: sets grouping)
  const [thenBy, setThenBy] = useState(() => localStorage.getItem('tmg-tasks-sort') || 'due'); // secondary: orders rows within each group
  useEffect(() => {
    localStorage.setItem('tmg-tasks-group', sortBy);
  }, [sortBy]);
  useEffect(() => {
    localStorage.setItem('tmg-tasks-sort', thenBy);
  }, [thenBy]);
  const [labelColors, setLabelColors] = useState({});
  const [vis, setVis] = useState(false);
  const wide = useWide(700); // tablet/desktop → two-pane master-detail
  const embed = TASKS_EMBED; // inside the main app's iframe → fill edge-to-edge (iframe is the panel chrome)
  // ── Standalone-only redesign state (My Tasks: list/kanban, columns, search, milestones) ──
  // Never read by the embedded popout — that surface renders the original branch untouched.
  const [viewMode, setViewMode] = useState(() => localStorage.getItem('tmg-tasks-view') || 'list'); // 'list' | 'kanban' (desktop only)
  const [cols, setCols] = useState(() => {
    try {
      const s = JSON.parse(localStorage.getItem('tmg-cols-tasks') || 'null');
      return Array.isArray(s) && s.length ? s : ['source', 'status', 'due'];
    } catch (e) {
      return ['source', 'status', 'due'];
    }
  });
  useEffect(() => {
    localStorage.setItem('tmg-tasks-view', viewMode);
  }, [viewMode]);
  useEffect(() => {
    localStorage.setItem('tmg-cols-tasks', JSON.stringify(cols));
  }, [cols]);
  const [search, setSearch] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [quickAddVal, setQuickAddVal] = useState('');
  const [groupOpen, setGroupOpen] = useState(false);
  const [sortOpen, setSortOpen] = useState(false);
  const [colsOpen, setColsOpen] = useState(false);
  // Option B toolbar (desktop My Tasks) — Display popover ported from
  // tmg-toolbar-email-prototype_1.html. dispOpen is the popover itself;
  // dispSub is which of its rows has an open submenu (only one at a time,
  // matching the prototype's single openSub value), not the old per-chip
  // groupOpen/sortOpen/colsOpen above (still used by the untouched mobile row).
  const [dispOpen, setDispOpen] = useState(false);
  const [dispSub, setDispSub] = useState(null); // 'layout' | 'group' | 'sort' | 'cols' | null
  const [completedOpen, setCompletedOpen] = useState(false);
  const [ctxMenu, setCtxMenu] = useState(null); // { x, y, task }
  // Surface switcher (standalone only): My Tasks | CTC Files | Projects.
  const [surface, setSurface] = useState(() => localStorage.getItem('tmg-tasks-surface') || 'my');
  const [surfaceMenuOpen, setSurfaceMenuOpen] = useState(false);
  const [navItems, setNavItems] = useState([]); // sidebar: every project/CTC file, for the per-item rows
  const [openItemId, setOpenItemId] = useState(null); // sidebar-initiated: jump straight to this project/file ('new' = open the create form)
  // A surface set by a URL is a visit, not a preference — opening someone
  // else's #rock/<id> link must not permanently change your default view.
  const routeFromUrl = useRef(false);
  useEffect(() => {
    if (routeFromUrl.current) {
      routeFromUrl.current = false;
      return;
    }
    localStorage.setItem('tmg-tasks-surface', surface);
  }, [surface]);
  useEffect(() => {
    ProjectDB.sidebarList().then(setNavItems);
  }, [surface]);
  useEffect(() => {
    const r = requestAnimationFrame(() => setVis(true));
    return () => cancelAnimationFrame(r);
  }, []);
  useEffect(() => {
    if (initialTask) {
      setCurrent(initialTask);
      setView('detail');
    }
  }, [initialTask]);
  const bg = dark ? '#000D26' : '#FCFBF8',
    bord = dark ? '#152545' : '#E4DFD4',
    ink = dark ? '#fff' : '#001A4A',
    sub = dark ? 'rgba(255,255,255,0.5)' : '#6B6B6B',
    gold = dark ? '#C9A45A' : '#AD832F';
  const enrich = (t, projById) => ({
    ...t,
    _projectName: t.project_id ? projById[t.project_id] || '' : ''
  });
  const withMetaFrom = (t, d) => {
    const ppl = d.peopleByTask[t.id] || [];
    return {
      ...enrich(t, d.projById),
      _assignees: ppl.filter(p => p.role === 'assignee').map(p => p.user_id),
      _assigners: ppl.filter(p => p.role === 'assigner').map(p => p.user_id),
      _decisionMakers: ppl.filter(p => p.role === 'decision_maker').map(p => p.user_id)
    };
  };
  const withMeta = t => withMetaFrom(t, data);
  async function reload() {
    setLoading(true);
    const [d, tm, links] = await Promise.all([TaskDB.loadAll(), ProfileDB.loadAll(), TaskEmailDB.loadAllByTask()]);
    const enriched = {
      ...d,
      tasks: d.tasks.map(t => enrich(t, d.projById))
    }; // _projectName for the source chip (My Tasks list/kanban/mobile rows)
    setData(enriched);
    setTeam((tm || []).map(p => ({
      id: p.id,
      name: ((p.first_name || '') + ' ' + (p.last_name || '')).trim() || p.email || 'User'
    })));
    setLinksByTask(links || {});
    setLoading(false);
    return enriched;
  }
  // A thread was attached from the mailbox — refresh just the link map (cheap)
  // instead of a full reload, so the mailbox's "Linked to X" state updates
  // immediately without re-fetching every task.
  async function onEmailAttached() {
    setLinksByTask(await TaskEmailDB.loadAllByTask());
  }
  // "Create task from this email" [brief §2.5] — new task, auto-linked thread,
  // then jump straight into it on the Email tab.
  async function onCreateTaskFromEmail(thread) {
    const created = await TaskDB.create({
      title: (thread.subject || 'New task').slice(0, 200)
    }, {}, user);
    if (!created) return;
    await TaskEmailDB.attach(created.id, thread, user, true);
    await reload();
    setMailboxOpen(false);
    setEmailTabFocus(thread.id);
    setCurrent(created);
    setView('detail');
  }
  useEffect(() => {
    reload();
  }, []);
  // ── Deep-link router ──────────────────────────────────────────────
  // One reader, one writer, for every view: #tasks, #task/<id>, #ctc,
  // #ctc/<id>[/<tab>], #projects, #project/<id>[/<tab>], #rocks,
  // #rock/<id>[/<tab>].
  //
  // Deliberately NOT keyed on data.tasks: an effect that re-reads the hash
  // after every reload() yanks the user back to the linked record on every
  // save/status change. It runs once on mount, then only on hashchange.
  const routeApplied = useRef(false);
  useEffect(() => {
    const applyRoute = async hash => {
      const r = parseTaskRoute(hash);
      if (!r) return;
      routeFromUrl.current = true; // don't persist a route-driven surface switch
      if (r.type === 'list') {
        setSurface(r.surface);
        setView('list');
        setCurrent(null);
        return;
      }
      if (r.type === 'record') {
        // ProjectsSurface picks the tab up via this module-level handoff —
        // its own reset effect would otherwise clobber a tab set here.
        PENDING_ROUTE.kind = r.kind;
        PENDING_ROUTE.id = r.id;
        PENDING_ROUTE.tab = r.tab;
        setSurface(r.surface);
        setOpenItemId(r.id);
        return;
      }
      // A task lives under any surface, but only the My Tasks surface can
      // render a task detail — force it, or the link silently no-ops for
      // anyone whose last surface was CTC/Projects/Rocks.
      const found = (data.tasks || []).find(t => t.id === r.id) || (await TaskDB.getById(r.id));
      if (found) {
        setSurface('my');
        setCurrent(found);
        setView('detail');
      }
    };
    // Consume a deep link stashed before the OAuth round-trip (see the
    // head snippet) — Google redirects back with no fragment at all.
    let initial = location.hash;
    try {
      const raw = sessionStorage.getItem('tmg-tasks-deeplink');
      sessionStorage.removeItem('tmg-tasks-deeplink');
      if (raw && !parseTaskRoute(initial)) {
        const st = JSON.parse(raw);
        if (st && st.h && Date.now() - (st.t || 0) < 60000) initial = st.h;
      }
    } catch (e) {}
    if (!routeApplied.current) {
      routeApplied.current = true;
      applyRoute(initial);
    }
    const onHash = () => applyRoute(location.hash);
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  // Writer — keeps the address bar copy-pasteable. replaceState only: it
  // fires no hashchange, so App's hash reader (which blanks the popouts)
  // never sees our writes, and Back keeps exactly today's meaning. Skipped
  // inside the iframe, where the URL is invisible and history is shared.
  useEffect(() => {
    if (TASKS_EMBED) return;
    if (location.hash.indexOf('=') !== -1) return; // never touch the OAuth hash
    // Only the My Tasks surface is written here. Every other surface is
    // owned end-to-end by its ProjectsSurface (list AND record), so the
    // two writers can never race over the same hash.
    if (surface !== 'my') return;
    const hash = view === 'detail' && current ? 'task/' + current.id : 'tasks';
    const t = setTimeout(() => {
      // coalesce: Safari throws past ~100 replaceState/10s
      try {
        if (location.hash.replace(/^#\/?/, '') !== hash) history.replaceState(null, '', '#' + hash);
      } catch (e) {}
    }, 120);
    return () => clearTimeout(t);
  }, [surface, view, current && current.id]);
  useEffect(() => {
    if (view === 'list') {
      try {
        const p = JSON.parse(localStorage.getItem(labelKey(user && user.id)) || '[]') || [];
        const m = {};
        p.forEach(x => {
          m[x.name] = x.color;
        });
        setLabelColors(m);
      } catch (e) {}
    }
  }, [view]);
  async function handleSave(form) {
    const due_at = form.due ? new Date(form.due).toISOString() : null;
    const decision_due_at = form.decisionDue ? new Date(form.decisionDue).toISOString() : null;
    const project_id = form.project ? await TaskDB.findOrCreateProject(form.project, user) : null;
    const pl = form.planning || {};
    const fields = {
      title: form.title,
      due_at,
      project_id,
      priority: form.priority,
      status: form.status,
      description: form.description || null,
      context: form.context || null,
      working_url: form.working_url || null,
      email_link: form.email_link || null,
      decision_question: form.decisionQuestion || null,
      decision_due_at,
      decision_due_has_time: !!(form.decisionDue && form.decisionHasTime),
      recurrence: form.recurrence || 'none',
      recur_interval: form.recurInterval || null,
      recur_unit: form.recurUnit || null,
      recur_copy_fields: form.recurCopy || null,
      weekly_priority: pl.wp || null,
      weekly_rank: pl.wr ? parseInt(pl.wr, 10) : null,
      daily_priority: pl.dp || null,
      daily_rank: pl.dr ? parseInt(pl.dr, 10) : null
    };
    const people = {
      assignee: form.assignees,
      assigner: form.assigners,
      decision_maker: form.decisionMakers || []
    };
    let taskId;
    if (current && current.id) {
      await TaskDB.update(current.id, current, fields, user);
      await TaskDB.setPeople(current.id, people);
      taskId = current.id;
    } else {
      const created = await TaskDB.create(fields, people, user);
      taskId = created && created.id;
    }
    if (taskId) {
      await TaskDB.setLabels(taskId, user && user.id, form.labels || []);
      await TaskDB.setDecisionOptions(taskId, form.decisionOptions || []);
    }
    await reload();
    setView('list');
    setCurrent(null);
  }
  async function changeStatus(task, status) {
    await TaskDB.update(task.id, task, {
      status
    }, user);
    const d = await reload();
    const fresh = (d.tasks || []).find(x => x.id === task.id);
    setCurrent(fresh || {
      ...task,
      status
    }); // subtasks aren't in the top-level list — fall back to optimistic
  }
  // Row-level done/undone toggle — a separate hit target from opening the
  // drawer (rows call this with stopPropagation), same status path as the
  // drawer's own status buttons and the Kanban board's drag-and-drop.
  async function toggleDone(t) {
    await changeStatus(t, t.status === 'done' ? 'todo' : 'done');
  }
  // Quick-add: type + Enter creates a plain To Do/Medium task and keeps focus,
  // same pattern as the quick-add already on every Project/CTC File/Rock list.
  async function quickAddMyTask() {
    const title = quickAddVal.trim();
    if (!title) return;
    await TaskDB.create({
      title,
      status: 'todo',
      priority: 'medium'
    }, {}, user);
    setQuickAddVal('');
    await reload();
  }
  const quickAddRow = /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 8,
      padding: '12px 0 0'
    }
  }, /*#__PURE__*/React.createElement("input", {
    value: quickAddVal,
    onChange: e => setQuickAddVal(e.target.value),
    onKeyDown: e => {
      if (e.key === 'Enter') quickAddMyTask();
    },
    placeholder: "\uFF0B Add a task and press Enter\u2026",
    style: {
      flex: 1,
      padding: '10px 12px',
      background: dark ? '#0A1730' : '#fff',
      border: `1px solid ${bord}`,
      borderRadius: 6,
      color: ink,
      fontSize: 14,
      outline: 'none',
      fontFamily: C.fontSans
    }
  }));
  const back = () => {
    if (view === 'form') setView(current ? 'detail' : 'list');else {
      setView('list');
      setCurrent(null);
    }
  };
  const titleText = view === 'form' ? current ? 'Edit task' : 'New task' : view === 'detail' ? 'Task' : view === 'labels' ? 'Manage labels' : 'Tasks';
  const myLabelsFor = id => (data.labelsByTask[id] || []).filter(l => l.user_id === (user && user.id)).map(l => l.label);
  const groupHead = (color, text) => /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 6,
      marginBottom: 7
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      width: 8,
      height: 8,
      borderRadius: '50%',
      background: color
    }
  }), /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: '0.64rem',
      fontWeight: 700,
      letterSpacing: '0.1em',
      textTransform: 'uppercase',
      color: sub,
      fontFamily: C.fontSans
    }
  }, text));
  const taskRow = (t, showStatus) => {
    const assignees = (data.peopleByTask[t.id] || []).filter(p => p.role === 'assignee').map(p => (team.find(m => m.id === p.user_id) || {}).name).filter(Boolean);
    const myLabels = myLabelsFor(t.id);
    return /*#__PURE__*/React.createElement("div", {
      key: t.id,
      onClick: () => {
        setCurrent(t);
        setView('detail');
      },
      style: {
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '11px 12px',
        background: wide && current && current.id === t.id ? dark ? '#0A1E44' : '#F3EBDA' : dark ? '#0A1730' : '#fff',
        border: `1px solid ${wide && current && current.id === t.id ? gold : bord}`,
        borderLeft: `2.5px solid ${statusColor(t.status)}`,
        borderRadius: 12,
        marginBottom: 8,
        cursor: 'pointer',
        opacity: t.status === 'done' ? 0.75 : 1
      }
    }, /*#__PURE__*/React.createElement("span", {
      style: {
        width: 6,
        height: 6,
        borderRadius: '50%',
        flexShrink: 0,
        background: priorityColor(t.priority)
      },
      title: priorityLabel(t.priority)
    }), /*#__PURE__*/React.createElement("div", {
      style: {
        flex: 1,
        minWidth: 0
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: '0.86rem',
        fontWeight: 600,
        color: ink,
        fontFamily: C.fontSans,
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis'
      }
    }, t.title), /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: '0.68rem',
        color: sub,
        marginTop: 2,
        fontFamily: C.fontSans,
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis'
      }
    }, [t.due_at ? new Date(t.due_at).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric'
    }) : null, assignees.join(', ')].filter(Boolean).join(' · ') || '—'), t.parent_task_id && (() => {
      const par = data.tasks.find(x => x.id === t.parent_task_id);
      return par ? /*#__PURE__*/React.createElement("div", {
        style: {
          display: 'flex',
          alignItems: 'center',
          gap: 3,
          fontSize: '0.62rem',
          color: dark ? '#C9A45A' : '#AD832F',
          marginTop: 3,
          fontFamily: C.fontSans,
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis'
        }
      }, /*#__PURE__*/React.createElement("i", {
        className: "ti ti-subtask",
        style: {
          fontSize: 11,
          flexShrink: 0
        }
      }), par.title) : null;
    })(), myLabels.length > 0 && /*#__PURE__*/React.createElement("div", {
      style: {
        display: 'flex',
        flexWrap: 'wrap',
        gap: 4,
        marginTop: 5
      }
    }, myLabels.map(l => {
      const lc = labelColors[l];
      return /*#__PURE__*/React.createElement("span", {
        key: l,
        style: {
          padding: '1px 6px',
          borderRadius: 10,
          background: lc ? lc + '26' : dark ? 'rgba(201,164,90,0.15)' : '#F3EBDA',
          color: lc || (dark ? '#C9A45A' : '#AD832F'),
          fontSize: '0.58rem',
          fontWeight: 600,
          fontFamily: C.fontSans
        }
      }, l);
    }))), showStatus && /*#__PURE__*/React.createElement("span", {
      style: {
        fontSize: '0.56rem',
        fontWeight: 700,
        padding: '2px 7px',
        borderRadius: 12,
        background: statusBg(t.status),
        color: statusColor(t.status),
        fontFamily: C.fontSans,
        flexShrink: 0
      }
    }, statusLabel(t.status)), /*#__PURE__*/React.createElement("i", {
      className: "ti ti-chevron-right",
      style: {
        fontSize: 16,
        color: sub,
        flexShrink: 0
      }
    }));
  };
  const sortTabs = /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 6,
      marginBottom: 12
    }
  }, [['status', 'Status'], ['due', 'Due date'], ['label', 'Label']].map(([id, label]) => /*#__PURE__*/React.createElement("button", {
    key: id,
    onClick: () => setSortBy(id),
    style: {
      flex: 1,
      padding: '6px 8px',
      borderRadius: 8,
      border: `1px solid ${sortBy === id ? C.navy : bord}`,
      background: sortBy === id ? C.navy : dark ? '#0A1730' : '#fff',
      color: sortBy === id ? '#fff' : sub,
      fontSize: '0.7rem',
      fontWeight: 600,
      cursor: 'pointer',
      fontFamily: C.fontSans
    }
  }, label)));
  const renderList = () => {
    // Secondary sort applied WITHIN each group (or as a tie-breaker in the flat due list).
    const PRI = {
      high: 0,
      medium: 1,
      low: 2
    };
    const dueCmp = (a, b) => {
      if (!a.due_at && !b.due_at) return 0;
      if (!a.due_at) return 1;
      if (!b.due_at) return -1;
      return new Date(a.due_at) - new Date(b.due_at);
    };
    const byThen = (a, b) => {
      if (thenBy === 'priority') return (PRI[a.priority] ?? 1) - (PRI[b.priority] ?? 1);
      if (thenBy === 'title') return (a.title || '').localeCompare(b.title || '');
      if (thenBy === 'created') return new Date(b.created_at || 0) - new Date(a.created_at || 0); // newest first
      return dueCmp(a, b); // 'due' (soonest first, undated last)
    };
    if (sortBy === 'due') {
      const sorted = [...data.tasks].sort((a, b) => dueCmp(a, b) || byThen(a, b));
      return /*#__PURE__*/React.createElement("div", null, groupHead(dark ? '#C9A45A' : '#AD832F', 'By due date · ' + sorted.length), sorted.map(t => taskRow(t, true)));
    }
    if (sortBy === 'label') {
      const groups = {};
      const unlabeled = [];
      data.tasks.forEach(t => {
        const ls = myLabelsFor(t.id);
        if (!ls.length) unlabeled.push(t);else ls.forEach(l => {
          (groups[l] = groups[l] || []).push(t);
        });
      });
      const names = Object.keys(groups).sort((a, b) => a.localeCompare(b));
      return /*#__PURE__*/React.createElement(React.Fragment, null, names.map(n => /*#__PURE__*/React.createElement("div", {
        key: n,
        style: {
          marginBottom: 16
        }
      }, groupHead(dark ? '#C9A45A' : '#AD832F', n + ' · ' + groups[n].length), groups[n].slice().sort(byThen).map(t => taskRow(t, true)))), unlabeled.length > 0 && /*#__PURE__*/React.createElement("div", {
        style: {
          marginBottom: 16
        }
      }, groupHead(sub, 'Unlabeled · ' + unlabeled.length), unlabeled.slice().sort(byThen).map(t => taskRow(t, true))));
    }
    return TASK_STATUS.map(col => {
      const items = data.tasks.filter(t => t.status === col.id).sort(byThen);
      if (!items.length) return null;
      return /*#__PURE__*/React.createElement("div", {
        key: col.id,
        style: {
          marginBottom: 16
        }
      }, groupHead(col.color, col.label + ' · ' + items.length), items.map(t => taskRow(t, false)));
    });
  };
  // ── Shared header controls (reused by both layouts) ──
  const searchBtn = /*#__PURE__*/React.createElement("i", {
    className: "ti ti-search",
    title: "Search (coming soon)",
    "aria-label": "Search",
    style: {
      fontSize: 15,
      color: dark ? 'rgba(255,255,255,0.35)' : '#B4B2A9',
      cursor: 'default',
      flexShrink: 0
    }
  });
  const labelsBtn = /*#__PURE__*/React.createElement("i", {
    className: "ti ti-tag",
    onClick: () => setView('labels'),
    title: "Manage labels",
    style: {
      fontSize: 16,
      cursor: 'pointer',
      color: gold,
      flexShrink: 0
    }
  });
  const sortSelect = /*#__PURE__*/React.createElement("select", {
    value: sortBy,
    onChange: e => setSortBy(e.target.value),
    title: "Group tasks by",
    style: {
      fontFamily: C.fontSans,
      fontSize: '0.66rem',
      fontWeight: 600,
      color: gold,
      background: dark ? '#0A1730' : '#fff',
      border: `1px solid ${bord}`,
      borderRadius: 8,
      padding: '4px 4px 4px 7px',
      cursor: 'pointer',
      outline: 'none',
      maxWidth: '100%'
    }
  }, /*#__PURE__*/React.createElement("option", {
    value: "status"
  }, "Status"), /*#__PURE__*/React.createElement("option", {
    value: "due"
  }, "Due date"), /*#__PURE__*/React.createElement("option", {
    value: "label"
  }, "Label"));
  const thenBySelect = /*#__PURE__*/React.createElement("select", {
    value: thenBy,
    onChange: e => setThenBy(e.target.value),
    title: "Then sort within each group",
    style: {
      fontFamily: C.fontSans,
      fontSize: '0.66rem',
      fontWeight: 600,
      color: gold,
      background: dark ? '#0A1730' : '#fff',
      border: `1px solid ${bord}`,
      borderRadius: 8,
      padding: '4px 4px 4px 7px',
      cursor: 'pointer',
      outline: 'none',
      maxWidth: '100%'
    }
  }, /*#__PURE__*/React.createElement("option", {
    value: "due"
  }, "\u21B3 Due date"), /*#__PURE__*/React.createElement("option", {
    value: "priority"
  }, "\u21B3 Priority"), /*#__PURE__*/React.createElement("option", {
    value: "title"
  }, "\u21B3 Title"), /*#__PURE__*/React.createElement("option", {
    value: "created"
  }, "\u21B3 Recently added"));
  const newBtn = /*#__PURE__*/React.createElement("button", {
    onClick: () => {
      setCurrent(null);
      setView('form');
    },
    "aria-label": "New task",
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 6,
      background: C.navy,
      color: '#fff',
      border: 'none',
      borderRadius: 22,
      padding: '8px 16px',
      fontSize: 13,
      fontWeight: 500,
      letterSpacing: '0.02em',
      cursor: 'pointer',
      fontFamily: C.fontSans,
      flexShrink: 0
    }
  }, /*#__PURE__*/React.createElement("i", {
    className: "ti ti-plus",
    style: {
      fontSize: 14
    }
  }), "New");
  const listInner = compact => /*#__PURE__*/React.createElement("div", {
    style: {
      padding: compact ? '10px 10px 24px' : '12px 14px 24px'
    }
  }, loading ? /*#__PURE__*/React.createElement("div", {
    style: {
      color: sub,
      fontSize: '0.82rem',
      padding: 12
    }
  }, "Loading\u2026") : data.tasks.length === 0 ? /*#__PURE__*/React.createElement("div", {
    style: {
      color: sub,
      fontSize: '0.82rem',
      padding: 24,
      textAlign: 'center'
    }
  }, "No tasks yet. Tap ", /*#__PURE__*/React.createElement("b", null, "New"), " to add one.") : /*#__PURE__*/React.createElement(React.Fragment, null, renderList()));
  const detailPane = view === 'form' ? /*#__PURE__*/React.createElement(TaskForm, {
    dark: dark,
    task: current ? withMeta(current) : null,
    team: team,
    user: user,
    onSave: handleSave,
    onCancel: () => setView(current ? 'detail' : 'list')
  }) : view === 'detail' && current ? /*#__PURE__*/React.createElement(TaskDetail, {
    dark: dark,
    task: withMeta(current),
    people: data.peopleByTask[current.id] || [],
    team: team,
    user: user,
    allTasks: data.tasks,
    onEdit: () => setView('form'),
    onDelete: async () => {
      await reload();
      setView('list');
      setCurrent(null);
    },
    onStatus: s => changeStatus(current, s),
    onOpenSubtask: child => {
      setCurrent(child);
      setView('detail');
    },
    emailLinks: linksByTask[current.id] || [],
    onEmailChanged: onEmailAttached,
    initialTab: emailTabFocus ? 'email' : undefined,
    onTabSettled: () => setEmailTabFocus(null)
  }) : view === 'labels' ? /*#__PURE__*/React.createElement(LabelManager, {
    dark: dark,
    user: user,
    onClose: () => setView('list')
  }) : null;
  // ── Container chrome: embed → fill the iframe (it provides the panel chrome);
  // standalone → a real full-bleed page under the top bar, NOT a floating popout
  // panel. This is the Menu → More → Tasks page; the header icon's popout is a
  // separate, untouched surface (the embed branch below). ──
  const containerStyle = embed ? {
    position: 'fixed',
    inset: 0,
    display: 'flex',
    flexDirection: 'column',
    background: bg,
    overflow: 'hidden',
    opacity: vis ? 1 : 0,
    transition: 'opacity 150ms ease'
  } : {
    position: 'fixed',
    top: POPOUT_TOP,
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 60,
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
    background: bg,
    opacity: vis ? 1 : 0,
    transition: 'opacity 150ms ease'
  };

  // ══════════════════════════════════════════════════════════════════════
  // STANDALONE-ONLY REDESIGN — "My Tasks" (per CLAUDE_CODE_INSTRUCTIONS.md /
  // TASK-ECOSYSTEM.md §6). Everything below only renders when !embed — the
  // embedded popout above (wide/narrow branches) is untouched on purpose.
  // ══════════════════════════════════════════════════════════════════════
  const now0 = new Date();
  const startOfToday = new Date(now0.getFullYear(), now0.getMonth(), now0.getDate());
  const endOfToday = new Date(startOfToday.getTime() + 86400000);
  const openTasksList = data.tasks.filter(t => t.status !== 'done');
  const dueTodayCount = openTasksList.filter(t => t.due_at && new Date(t.due_at) >= startOfToday && new Date(t.due_at) < endOfToday).length;
  const overdueCount = openTasksList.filter(t => t.due_at && new Date(t.due_at) < startOfToday).length;
  const openCount = openTasksList.length;
  const lateColor = dark ? '#E07A7A' : '#9B1C1C';
  async function toggleMilestone(t) {
    await TaskDB.update(t.id, t, {
      is_milestone: !t.is_milestone
    }, user);
    await reload();
  }
  const GROUP_OPTS = [['status', 'Status'], ['assignee', 'Assignee'], ['priority', 'Priority'], ['due', 'Due date'], ['project', 'Project / File'], ['label', 'Label'], ['none', 'None']];
  // Display popover's Group-by submenu offers exactly the brief's 5 options
  // [MUST-MATCH] — 'project'/'label' stay valid, resolvable values (an
  // existing user could already be grouped that way) but aren't offered
  // going forward, so GROUP_OPTS above is untouched for that lookup.
  const DISPLAY_GROUP_IDS = ['status', 'assignee', 'priority', 'due', 'none'];
  // viewMode's internal value is 'kanban' (pre-existing), displayed as "Board".
  const LAYOUT_LABELS = {
    list: 'List',
    kanban: 'Board',
    timeline: 'Timeline'
  };
  const SORT_OPTS = [['created', 'Date created'], ['due', 'Due date'], ['priority', 'Priority'], ['title', 'Alphabetical']];
  // Priority isn't in this list — it's a fixed column, always shown (see deskRow
  // and its header row), not opt-in via the column picker.
  const COLUMN_DEFS = [{
    id: 'source',
    label: 'Source'
  }, {
    id: 'status',
    label: 'Status'
  }, {
    id: 'due',
    label: 'Due'
  }, {
    id: 'assignee',
    label: 'Assignee'
  }, {
    id: 'labels',
    label: 'Labels'
  }, {
    id: 'created',
    label: 'Created'
  }, {
    id: 'modified',
    label: 'Last modified'
  }];
  const filteredTasks = search.trim() ? data.tasks.filter(t => (t.title || '').toLowerCase().includes(search.trim().toLowerCase())) : data.tasks;
  const chipStyle = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    fontSize: 12,
    letterSpacing: '0.08em',
    textTransform: 'uppercase',
    fontWeight: 400,
    padding: '7px 12px',
    border: `1px solid ${bord}`,
    borderRadius: 6,
    background: dark ? '#0A1730' : '#fff',
    color: sub,
    whiteSpace: 'nowrap',
    cursor: 'pointer',
    fontFamily: C.fontSans
  };
  const ddStyle = {
    position: 'absolute',
    zIndex: 60,
    top: '100%',
    right: 0,
    background: dark ? '#0A1730' : '#fff',
    border: `1px solid ${bord}`,
    borderRadius: 8,
    boxShadow: '0 12px 32px rgba(0,26,74,0.16)',
    padding: 6,
    minWidth: 190,
    marginTop: 4
  };
  const ddItem = (label, active, onClick, key) => /*#__PURE__*/React.createElement("div", {
    key: key || label,
    onClick: onClick,
    style: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 10,
      padding: '8px 10px',
      fontSize: 13.5,
      color: active ? gold : ink,
      fontWeight: active ? 500 : 400,
      borderRadius: 5,
      cursor: 'pointer',
      fontFamily: C.fontSans
    }
  }, label, active && '✓');
  // .btn.on ported: border-color gold-soft, color navy, background gold-pale
  // — shown whenever the chip's selection differs from its default.
  const chipOn = {
    borderColor: dark ? 'rgba(201,164,90,.4)' : '#C9A45A',
    color: ink,
    background: dark ? 'rgba(201,164,90,.14)' : '#F3EBDA'
  };
  const groupChip = /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'relative'
    }
  }, /*#__PURE__*/React.createElement("div", {
    onClick: () => {
      setGroupOpen(o => !o);
      setSortOpen(false);
      setColsOpen(false);
    },
    style: sortBy !== 'status' ? {
      ...chipStyle,
      ...chipOn
    } : chipStyle
  }, "Group: ", /*#__PURE__*/React.createElement("span", {
    style: {
      color: gold,
      fontWeight: 600
    }
  }, (GROUP_OPTS.find(([id]) => id === sortBy) || [])[1]), " ", /*#__PURE__*/React.createElement("i", {
    className: "ti ti-chevron-down",
    style: {
      fontSize: 9,
      color: sub
    }
  })), groupOpen && /*#__PURE__*/React.createElement("div", {
    style: ddStyle,
    onClick: e => e.stopPropagation()
  }, GROUP_OPTS.map(([id, label]) => ddItem(label, sortBy === id, () => {
    setSortBy(id);
    setGroupOpen(false);
  }, id))));
  const sortChip = /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'relative'
    }
  }, /*#__PURE__*/React.createElement("div", {
    onClick: () => {
      setSortOpen(o => !o);
      setGroupOpen(false);
      setColsOpen(false);
    },
    style: thenBy !== 'due' ? {
      ...chipStyle,
      ...chipOn
    } : chipStyle
  }, "Sort: ", /*#__PURE__*/React.createElement("span", {
    style: {
      color: gold,
      fontWeight: 600
    }
  }, (SORT_OPTS.find(([id]) => id === thenBy) || [])[1]), " ", /*#__PURE__*/React.createElement("i", {
    className: "ti ti-chevron-down",
    style: {
      fontSize: 9,
      color: sub
    }
  })), sortOpen && /*#__PURE__*/React.createElement("div", {
    style: ddStyle,
    onClick: e => e.stopPropagation()
  }, SORT_OPTS.map(([id, label]) => ddItem(label, thenBy === id, () => {
    setThenBy(id);
    setSortOpen(false);
  }, id))));
  const searchChip = searchOpen ? /*#__PURE__*/React.createElement("input", {
    autoFocus: true,
    value: search,
    onChange: e => setSearch(e.target.value),
    onBlur: () => {
      if (!search) setSearchOpen(false);
    },
    placeholder: "Search tasks\u2026",
    style: {
      ...chipStyle,
      cursor: 'text',
      width: 130,
      textTransform: 'none',
      letterSpacing: 'normal',
      fontSize: '0.78rem',
      outline: 'none'
    }
  }) : /*#__PURE__*/React.createElement("div", {
    onClick: () => setSearchOpen(true),
    style: {
      ...chipStyle,
      width: 34,
      height: 34,
      padding: 0,
      justifyContent: 'center'
    }
  }, /*#__PURE__*/React.createElement("i", {
    className: "ti ti-search",
    style: {
      fontSize: 13
    }
  }));
  // colsChip (the old standalone "choose columns" icon) was removed — that
  // picker now lives inside the Display popover's Columns row below; desktop
  // no longer has a separate columns icon in the toolbar [acceptance 1.3].

  // ══════════════════════════════════════════════════════════════════════
  // Option B toolbar (desktop My Tasks) — ported literally from
  // tmg-toolbar-email-prototype_1.html §.tbar/.iconbtn/.btn/.menu/.submenu.
  // Toolbar shows exactly: Search, Email, Display, + New [acceptance 1.3].
  // ══════════════════════════════════════════════════════════════════════
  const iconBtnStyle = {
    width: 34,
    height: 34,
    border: `1px solid ${bord}`,
    background: dark ? '#0A1730' : '#fff',
    borderRadius: 6,
    display: 'grid',
    placeItems: 'center',
    color: sub,
    position: 'relative',
    flexShrink: 0
  };
  const linkedEmailCount = Object.keys(linksByTask).filter(id => (linksByTask[id] || []).length).length;
  const emailIconBtn = /*#__PURE__*/React.createElement("div", {
    title: "Email \u2014 open mailbox",
    onClick: () => setMailboxOpen(true),
    style: {
      ...iconBtnStyle,
      cursor: 'pointer'
    }
  }, /*#__PURE__*/React.createElement("i", {
    className: "ti ti-mail",
    style: {
      fontSize: 15
    }
  }), linkedEmailCount > 0 && /*#__PURE__*/React.createElement("span", {
    style: {
      position: 'absolute',
      top: -6,
      right: -6,
      background: gold,
      color: '#fff',
      fontSize: 9,
      minWidth: 16,
      height: 16,
      borderRadius: 8,
      display: 'grid',
      placeItems: 'center',
      padding: '0 3px'
    }
  }, linkedEmailCount));
  const dispMenuStyle = {
    position: 'absolute',
    top: 42,
    right: 0,
    background: dark ? '#0A1730' : '#fff',
    border: `1px solid ${bord}`,
    borderRadius: 8,
    boxShadow: '0 8px 28px rgba(0,13,38,.16)',
    padding: 8,
    minWidth: 250,
    zIndex: 30,
    fontFamily: C.fontSans
  };
  const dispSubStyle = {
    position: 'absolute',
    top: 0,
    right: '100%',
    marginRight: 2,
    background: dark ? '#0A1730' : '#fff',
    border: `1px solid ${bord}`,
    borderRadius: 8,
    boxShadow: '0 8px 28px rgba(0,13,38,.16)',
    padding: 6,
    minWidth: 170,
    zIndex: 31
  };
  const dispMenuLabel = text => /*#__PURE__*/React.createElement("div", {
    key: 'ml-' + text,
    style: {
      fontSize: 10,
      letterSpacing: '0.14em',
      textTransform: 'uppercase',
      color: sub,
      padding: '8px 8px 4px'
    }
  }, text);
  const dispDiv = /*#__PURE__*/React.createElement("div", {
    style: {
      height: 1,
      background: bord,
      margin: '6px 2px'
    }
  });
  const dispSubBtn = (label, selected, onClick, key) => /*#__PURE__*/React.createElement("button", {
    key: key || label,
    onClick: onClick,
    style: {
      display: 'flex',
      width: '100%',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 10,
      padding: '7px 9px',
      borderRadius: 5,
      fontSize: 13,
      textAlign: 'left',
      color: selected ? gold : ink,
      fontWeight: selected ? 500 : 400,
      fontFamily: C.fontSans
    }
  }, label, selected && '✓');
  // A clickable Display row (Layout/Group by/Sort by) that opens a submenu flying
  // out to the left [MUST-MATCH: click, not hover — hover-only fails on touch/keyboard].
  const dispRow = (label, valueText, subKey, submenuContent) => /*#__PURE__*/React.createElement("div", {
    key: subKey,
    onClick: e => {
      e.stopPropagation();
      setDispSub(s => s === subKey ? null : subKey);
    },
    style: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      padding: 8,
      borderRadius: 5,
      fontSize: 13.5,
      position: 'relative',
      cursor: 'pointer',
      color: ink,
      fontFamily: C.fontSans
    }
  }, /*#__PURE__*/React.createElement("span", null, label), /*#__PURE__*/React.createElement("span", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 5,
      color: gold,
      fontWeight: 500,
      fontSize: 12.5
    }
  }, valueText, " \u25B8"), dispSub === subKey && /*#__PURE__*/React.createElement("div", {
    style: dispSubStyle,
    onClick: e => e.stopPropagation()
  }, submenuContent));
  // A static (non-clickable) row — Filter and Labels are stubs for v1 [brief §1.2].
  const dispStaticRow = (label, valueText) => /*#__PURE__*/React.createElement("div", {
    key: label,
    style: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      padding: 8,
      borderRadius: 5,
      fontSize: 13.5,
      color: ink,
      fontFamily: C.fontSans
    }
  }, /*#__PURE__*/React.createElement("span", null, label), /*#__PURE__*/React.createElement("span", {
    style: {
      color: gold,
      fontWeight: 500,
      fontSize: 12.5
    }
  }, valueText));
  const dispActive = sortBy !== 'status' || thenBy !== 'due' || viewMode !== 'list';
  const displayBtn = /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'relative'
    }
  }, /*#__PURE__*/React.createElement("div", {
    onClick: e => {
      e.stopPropagation();
      setDispOpen(o => !o);
      setDispSub(null);
    },
    style: {
      height: 34,
      padding: '0 12px',
      border: `1px solid ${dispActive ? dark ? 'rgba(201,164,90,.4)' : '#C9A45A' : bord}`,
      borderRadius: 6,
      fontSize: 12,
      letterSpacing: '0.06em',
      textTransform: 'uppercase',
      display: 'inline-flex',
      alignItems: 'center',
      gap: 7,
      cursor: 'pointer',
      fontFamily: C.fontSans,
      background: dispActive ? dark ? 'rgba(201,164,90,.14)' : '#F3EBDA' : dark ? '#0A1730' : '#fff',
      color: dispActive ? ink : sub
    }
  }, /*#__PURE__*/React.createElement("i", {
    className: "ti ti-adjustments-horizontal",
    style: {
      fontSize: 14
    }
  }), "Display \u25BE"), dispOpen && /*#__PURE__*/React.createElement("div", {
    style: dispMenuStyle,
    onClick: e => e.stopPropagation()
  }, dispMenuLabel('View'), dispRow('Layout', LAYOUT_LABELS[viewMode], 'layout', ['list', 'kanban', 'timeline'].map(m => dispSubBtn(LAYOUT_LABELS[m], viewMode === m, () => {
    setViewMode(m);
    setDispOpen(false);
    setDispSub(null);
  }, m))), dispDiv, dispMenuLabel('Organize'), dispRow('Group by', (GROUP_OPTS.find(([id]) => id === sortBy) || [])[1], 'group', GROUP_OPTS.filter(([id]) => DISPLAY_GROUP_IDS.includes(id)).map(([id, label]) => dispSubBtn(label, sortBy === id, () => {
    setSortBy(id);
    setDispOpen(false);
    setDispSub(null);
  }, id))), dispRow('Sort by', (SORT_OPTS.find(([id]) => id === thenBy) || [])[1], 'sort', SORT_OPTS.map(([id, label]) => dispSubBtn(label, thenBy === id, () => {
    setThenBy(id);
    setDispOpen(false);
    setDispSub(null);
  }, id))), dispDiv, dispStaticRow('Filter', 'None'), dispStaticRow('Labels', 'Show'), dispDiv, dispRow('Columns', 'Choose', 'cols', COLUMN_DEFS.map(c => dispSubBtn(c.label, cols.includes(c.id), () => setCols(cs => cs.includes(c.id) ? cs.filter(x => x !== c.id) : [...cs, c.id]), c.id)))));
  useEffect(() => {
    if (!dispOpen) return;
    const onKey = e => {
      if (e.key === 'Escape') {
        setDispOpen(false);
        setDispSub(null);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [dispOpen]);
  const dispScrim = dispOpen && /*#__PURE__*/React.createElement("div", {
    onClick: () => {
      setDispOpen(false);
      setDispSub(null);
    },
    style: {
      position: 'fixed',
      inset: 0,
      zIndex: 29
    }
  });
  // View tabs — moved under the title, left-aligned [brief §1.1]. Plain text, no
  // icons: the prototype's .vtabs/.vtab in THIS file has none (unlike the earlier
  // container-detail vtabs elsewhere, which do).
  const viewTabsRow = /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 2,
      borderBottom: `1px solid ${bord}`,
      marginTop: 14
    }
  }, ['list', 'kanban', 'timeline'].map(id => /*#__PURE__*/React.createElement("div", {
    key: id,
    onClick: () => setViewMode(id),
    style: {
      padding: '9px 15px',
      fontSize: 13,
      color: viewMode === id ? ink : sub,
      borderBottom: `2px solid ${viewMode === id ? gold : 'transparent'}`,
      marginBottom: -1,
      fontWeight: viewMode === id ? 500 : 400,
      cursor: 'pointer',
      fontFamily: C.fontSans
    }
  }, LAYOUT_LABELS[id])));

  // Milestone flag — a tap toggles it; right-click opens the same action as a
  // context menu (Symon: "right click... mark as milestone, or maybe an
  // attach itself... that's it").
  const milestoneFlag = (t, size) => /*#__PURE__*/React.createElement("i", {
    className: t.is_milestone ? 'ti ti-flag-3-filled' : 'ti ti-flag-3',
    onClick: e => {
      e.stopPropagation();
      toggleMilestone(t);
    },
    title: t.is_milestone ? 'Unmark as milestone' : 'Mark as milestone',
    style: {
      fontSize: size || 15,
      color: t.is_milestone ? gold : dark ? 'rgba(255,255,255,0.22)' : '#D8D2C6',
      flexShrink: 0,
      cursor: 'pointer'
    }
  });
  const sourceChip = t => t._projectName ? /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: '0.6rem',
      fontWeight: 500,
      padding: '2.5px 7px',
      borderRadius: 4,
      background: dark ? 'rgba(173,131,47,.14)' : '#FAF4E8',
      border: `1px solid ${dark ? 'rgba(173,131,47,.3)' : '#E7D8B4'}`,
      color: dark ? '#C9A45A' : '#8C6A24',
      fontFamily: C.fontSans,
      whiteSpace: 'nowrap'
    }
  }, "\u25B2 ", t._projectName) : null;
  // Row-level done/undone checkbox — a separate hit target from opening the
  // drawer, matching Asana/Monday's row anatomy (checkbox toggles, row body opens).
  const doneCheck = (t, sz) => {
    const s = sz || 17;
    return /*#__PURE__*/React.createElement("div", {
      onClick: e => {
        e.stopPropagation();
        toggleDone(t);
      },
      title: t.status === 'done' ? 'Mark not done' : 'Mark done',
      style: {
        width: s,
        height: s,
        borderRadius: '50%',
        border: `1.6px solid ${t.status === 'done' ? statusColor('done') : dark ? 'rgba(255,255,255,.28)' : '#C9C4B5'}`,
        background: t.status === 'done' ? statusColor('done') : 'transparent',
        flexShrink: 0,
        display: 'grid',
        placeItems: 'center',
        cursor: 'pointer'
      }
    }, t.status === 'done' && /*#__PURE__*/React.createElement("i", {
      className: "ti ti-check",
      style: {
        fontSize: s * 0.62,
        color: '#fff'
      }
    }));
  };
  // Tinted-background status pill — used everywhere a task's status needs to
  // be legible in a row, not just implied by a border color or bare dot.
  const statusPillEl = (t, sz) => /*#__PURE__*/React.createElement("span", {
    style: {
      display: 'inline-flex',
      alignItems: 'center',
      gap: 6,
      fontSize: sz || 12,
      fontWeight: 400,
      padding: '3px 9px',
      borderRadius: 20,
      border: `1px solid ${statusColor(t.status)}55`,
      background: statusBg(t.status),
      color: statusColor(t.status),
      fontFamily: C.fontSans,
      whiteSpace: 'nowrap',
      flexShrink: 0
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      width: 6,
      height: 6,
      borderRadius: '50%',
      background: statusColor(t.status),
      flexShrink: 0
    }
  }), statusLabel(t.status));
  const milestoneBadge = /*#__PURE__*/React.createElement("span", {
    style: {
      color: gold,
      fontSize: '0.62rem',
      fontWeight: 600,
      border: `1px solid ${dark ? 'rgba(201,164,90,.35)' : '#E8D9BC'}`,
      background: dark ? 'rgba(201,164,90,.14)' : '#F3EBDA',
      borderRadius: 4,
      padding: '1px 6px',
      letterSpacing: '0.04em',
      flexShrink: 0,
      whiteSpace: 'nowrap',
      fontFamily: C.fontSans
    }
  }, "\u25C6 Milestone");
  const openCtx = (e, t) => {
    e.preventDefault();
    setCtxMenu({
      x: e.clientX,
      y: e.clientY,
      task: t
    });
  };
  // Subject email icon — appears wherever a task's title is shown once it has
  // a linked thread; clicking opens straight to the Email tab [brief §2.3].
  const emailIconMini = t => (linksByTask[t.id] || []).length > 0 ? /*#__PURE__*/React.createElement("i", {
    className: "ti ti-mail",
    title: "Has a linked email",
    onClick: e => {
      e.stopPropagation();
      setEmailTabFocus((linksByTask[t.id] || [])[0].thread_id);
      setCurrent(t);
      setView('detail');
    },
    style: {
      fontSize: 14,
      color: '#185FA5',
      flexShrink: 0,
      cursor: 'pointer'
    }
  }) : null;

  // Surface switcher dropdown (My Tasks / CTC Files / Projects / Rocks) — the
  // clickable page title. Shared across all surfaces; passed into ProjectsSurface.
  // surfaceKind maps a surface id to the record_type ProjectsSurface loads —
  // Rocks are just projects with record_type='rock' ("same under the hood").
  const SURFACE_OPTS = [['my', 'My Tasks'], ['ctc', 'CTC Files'], ['projects', 'Projects'], ['rocks', 'Rocks']];
  const surfaceLabel = {
    my: 'My Tasks',
    ctc: 'CTC Files',
    projects: 'Projects',
    rocks: 'Rocks'
  };
  const surfaceKind = {
    ctc: 'ctc_file',
    projects: 'project',
    rocks: 'rock'
  };
  const surfaceTitle = fontSize => /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'relative'
    }
  }, /*#__PURE__*/React.createElement("div", {
    onClick: () => setSurfaceMenuOpen(o => !o),
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 6,
      cursor: 'pointer'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: C.fontSans,
      fontSize: fontSize || 17,
      fontWeight: 600,
      color: ink,
      letterSpacing: '-0.01em'
    }
  }, surfaceLabel[surface]), /*#__PURE__*/React.createElement("i", {
    className: "ti ti-chevron-down",
    style: {
      fontSize: 11,
      color: gold
    }
  })), surfaceMenuOpen && /*#__PURE__*/React.createElement("div", {
    onClick: e => e.stopPropagation(),
    style: {
      position: 'absolute',
      zIndex: 62,
      top: '100%',
      left: 0,
      background: dark ? '#0A1730' : '#fff',
      border: `1px solid ${bord}`,
      borderRadius: 8,
      boxShadow: '0 12px 32px rgba(0,26,74,0.18)',
      padding: 6,
      minWidth: 168,
      marginTop: 6
    }
  }, SURFACE_OPTS.map(([id, label]) => /*#__PURE__*/React.createElement("div", {
    key: id,
    onClick: () => {
      setSurface(id);
      setSurfaceMenuOpen(false);
    },
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      padding: '8px 10px',
      fontSize: '0.82rem',
      color: surface === id ? ink : sub,
      fontWeight: surface === id ? 600 : 400,
      borderRadius: 5,
      background: surface === id ? dark ? 'rgba(255,255,255,0.06)' : '#F7F4EE' : 'none',
      cursor: 'pointer',
      fontFamily: C.fontSans
    }
  }, /*#__PURE__*/React.createElement("i", {
    className: "ti ti-check",
    style: {
      fontSize: 12,
      color: gold,
      visibility: surface === id ? 'visible' : 'hidden',
      flexShrink: 0
    }
  }), label))));

  // Plain (non-dropdown) title used on desktop, where the sidebar below is
  // the actual switcher — the mobile dropdown would be a redundant control.
  const plainSurfaceTitle = fontSize => /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: C.fontSans,
      fontSize: fontSize || 27,
      fontWeight: 500,
      color: ink,
      letterSpacing: '0.01em'
    }
  }, surfaceLabel[surface]);

  // Persistent desktop sidebar (My Tasks / CTC Files / Projects) — the
  // primary surface switcher on wide screens. Stays visible across list,
  // detail, and form views for whichever surface is active.
  // Sidebar values ported literally from the reference prototype's CSS
  // (.sidebar/.side-group/.nav-item/.nav-item .ct/.side-add), not
  // re-derived from the app's own pre-existing size scale.
  const sbSectionHead = (label, first) => /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 11,
      fontWeight: 500,
      letterSpacing: '0.16em',
      textTransform: 'uppercase',
      color: sub,
      padding: '0 20px 8px',
      fontFamily: C.fontSans
    }
  }, label);
  const sbCount = n => /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 12,
      color: sub,
      background: dark ? '#08132A' : '#FCFBF8',
      border: `1px solid ${bord}`,
      borderRadius: 20,
      padding: '1px 8px',
      marginLeft: 8,
      flexShrink: 0,
      fontFamily: C.fontSans
    }
  }, n);
  const sbRow = (id, label, count) => /*#__PURE__*/React.createElement("div", {
    key: id,
    onClick: () => setSurface(id),
    style: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      padding: '8px 20px',
      fontSize: 14.5,
      color: ink,
      fontWeight: surface === id ? 500 : 400,
      borderLeft: `2.5px solid ${surface === id ? gold : 'transparent'}`,
      background: surface === id ? `linear-gradient(90deg, ${dark ? 'rgba(201,164,90,.1)' : 'rgba(173,131,47,.08)'}, transparent)` : 'transparent',
      cursor: 'pointer',
      fontFamily: C.fontSans
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      display: 'flex',
      alignItems: 'center',
      minWidth: 0
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      width: 7,
      height: 7,
      borderRadius: '50%',
      background: gold,
      marginRight: 9,
      flexShrink: 0
    }
  }), /*#__PURE__*/React.createElement("span", {
    style: {
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap'
    }
  }, label)), sbCount(count));
  // Individual project/file row (3rd sidebar level) — jumps straight into
  // that item's detail via openItemId, consumed by ProjectsSurface.
  const surfaceForRecordType = {
    ctc_file: 'ctc',
    project: 'projects',
    rock: 'rocks'
  };
  const sbItemRow = item => /*#__PURE__*/React.createElement("div", {
    key: item.id,
    onClick: () => {
      setSurface(surfaceForRecordType[item.record_type] || 'projects');
      setOpenItemId(item.id);
    },
    style: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      padding: '8px 20px',
      fontSize: 14.5,
      color: ink,
      borderLeft: '2.5px solid transparent',
      cursor: 'pointer',
      fontFamily: C.fontSans
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      marginLeft: 16,
      color: sub,
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
      minWidth: 0
    }
  }, item.name), sbCount(item.taskCount));
  const sbAddRow = (label, onClick) => /*#__PURE__*/React.createElement("div", {
    onClick: onClick,
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 7,
      padding: '6px 20px',
      color: sub,
      fontSize: 13,
      cursor: 'pointer',
      fontFamily: C.fontSans
    }
  }, /*#__PURE__*/React.createElement("i", {
    className: "ti ti-plus",
    style: {
      fontSize: 12
    }
  }), label);
  const ctcNavItems = navItems.filter(i => i.record_type === 'ctc_file');
  const projNavItems = navItems.filter(i => i.record_type === 'project');
  const rockNavItems = navItems.filter(i => i.record_type === 'rock');
  const sbGroup = children => /*#__PURE__*/React.createElement("div", {
    style: {
      marginBottom: 20
    }
  }, children);
  const navSidebar = /*#__PURE__*/React.createElement("div", {
    style: {
      width: 230,
      flexShrink: 0,
      borderRight: `1px solid ${bord}`,
      padding: '18px 0',
      background: dark ? '#08132A' : '#FCFBF8',
      overflowY: 'auto'
    }
  }, sbGroup( /*#__PURE__*/React.createElement(React.Fragment, null, sbSectionHead('Tasks', true), sbRow('my', 'My Tasks', data.tasks.length))), sbGroup( /*#__PURE__*/React.createElement(React.Fragment, null, sbSectionHead('Company'), sbRow('rocks', 'Rocks', rockNavItems.length), rockNavItems.map(sbItemRow), sbAddRow('New rock', () => {
    setSurface('rocks');
    setOpenItemId('new');
  }))), sbGroup( /*#__PURE__*/React.createElement(React.Fragment, null, sbSectionHead('CTC Files'), sbRow('ctc', 'All files', ctcNavItems.length), ctcNavItems.map(sbItemRow), sbAddRow('New file', () => {
    setSurface('ctc');
    setOpenItemId('new');
  }))), sbGroup( /*#__PURE__*/React.createElement(React.Fragment, null, sbSectionHead('Projects'), sbRow('projects', 'All projects', projNavItems.length), projNavItems.map(sbItemRow), sbAddRow('New project', () => {
    setSurface('projects');
    setOpenItemId('new');
  }))));

  // Mobile/narrow row
  const taskRowNew = t => {
    const myLabels = myLabelsFor(t.id);
    const late = t.due_at && t.status !== 'done' && new Date(t.due_at) < startOfToday;
    return /*#__PURE__*/React.createElement("div", {
      key: t.id,
      onClick: () => {
        setCurrent(t);
        setView('detail');
      },
      onContextMenu: e => openCtx(e, t),
      style: {
        display: 'flex',
        alignItems: 'flex-start',
        gap: 10,
        padding: '11px 12px',
        background: dark ? '#0A1730' : '#fff',
        border: `1px solid ${bord}`,
        borderLeft: `2.5px solid ${statusColor(t.status)}`,
        borderRadius: 12,
        marginBottom: 8,
        cursor: 'pointer',
        opacity: t.status === 'done' ? 0.72 : 1
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        marginTop: 1
      }
    }, doneCheck(t, 17)), /*#__PURE__*/React.createElement("div", {
      style: {
        flex: 1,
        minWidth: 0
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        display: 'flex',
        alignItems: 'center',
        gap: 7,
        flexWrap: 'wrap'
      }
    }, t.is_milestone && milestoneBadge, /*#__PURE__*/React.createElement("span", {
      style: {
        fontSize: '0.86rem',
        fontWeight: 600,
        color: ink,
        fontFamily: C.fontSans,
        textDecoration: t.status === 'done' ? 'line-through' : 'none'
      }
    }, t.title), emailIconMini(t)), /*#__PURE__*/React.createElement("div", {
      style: {
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        flexWrap: 'wrap',
        marginTop: 5
      }
    }, statusPillEl(t), /*#__PURE__*/React.createElement("span", {
      style: {
        width: 6,
        height: 6,
        borderRadius: '50%',
        flexShrink: 0,
        background: priorityColor(t.priority)
      },
      title: priorityLabel(t.priority)
    }), sourceChip(t), t.due_at && /*#__PURE__*/React.createElement("span", {
      style: {
        fontSize: '0.68rem',
        color: late ? lateColor : sub,
        fontWeight: late ? 600 : 400,
        fontFamily: C.fontSans
      }
    }, new Date(t.due_at).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric'
    }))), myLabels.length > 0 && /*#__PURE__*/React.createElement("div", {
      style: {
        display: 'flex',
        flexWrap: 'wrap',
        gap: 4,
        marginTop: 5
      }
    }, myLabels.map(l => {
      const lc = labelColors[l];
      return /*#__PURE__*/React.createElement("span", {
        key: l,
        style: {
          padding: '1px 6px',
          borderRadius: 10,
          background: lc ? lc + '26' : dark ? 'rgba(201,164,90,0.15)' : '#F3EBDA',
          color: lc || (dark ? '#C9A45A' : '#AD832F'),
          fontSize: '0.58rem',
          fontWeight: 600,
          fontFamily: C.fontSans
        }
      }, l);
    }))), milestoneFlag(t, 16));
  };

  // Desktop table row — respects the column picker
  const deskRow = t => {
    const assignees = (data.peopleByTask[t.id] || []).filter(p => p.role === 'assignee').map(p => (team.find(m => m.id === p.user_id) || {}).name).filter(Boolean);
    const myLabels = myLabelsFor(t.id);
    const late = t.due_at && t.status !== 'done' && new Date(t.due_at) < startOfToday;
    return /*#__PURE__*/React.createElement("div", {
      key: t.id,
      onClick: () => {
        setCurrent(t);
        setView('detail');
      },
      onContextMenu: e => openCtx(e, t),
      style: {
        display: 'flex',
        alignItems: 'center',
        padding: '11px 12px',
        borderBottom: `1px solid ${bord}`,
        gap: 12,
        cursor: 'pointer'
      }
    }, doneCheck(t, 17), milestoneFlag(t, 14), /*#__PURE__*/React.createElement("div", {
      style: {
        flex: 1,
        minWidth: 0,
        display: 'flex',
        alignItems: 'center',
        gap: 8
      }
    }, t.is_milestone && milestoneBadge, /*#__PURE__*/React.createElement("span", {
      style: {
        minWidth: 0,
        fontSize: 14.5,
        color: ink,
        fontFamily: C.fontSans,
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        textDecoration: t.status === 'done' ? 'line-through' : 'none'
      }
    }, t.title), emailIconMini(t)), cols.includes('source') && /*#__PURE__*/React.createElement("div", {
      style: {
        width: 150,
        flexShrink: 0,
        fontSize: 13,
        color: sub,
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis'
      }
    }, t._projectName || '—'), cols.includes('status') && /*#__PURE__*/React.createElement("div", {
      style: {
        width: 130,
        flexShrink: 0
      }
    }, statusPillEl(t)), /*#__PURE__*/React.createElement("div", {
      style: {
        width: 90,
        flexShrink: 0,
        fontSize: 11,
        letterSpacing: '0.04em',
        textTransform: 'uppercase',
        color: t.priority === 'high' ? lateColor : t.priority === 'medium' ? gold : sub
      }
    }, priorityLabel(t.priority)), cols.includes('due') && /*#__PURE__*/React.createElement("div", {
      style: {
        width: 96,
        flexShrink: 0,
        textAlign: 'right',
        fontSize: 13,
        color: late ? lateColor : sub,
        fontWeight: late ? 500 : 400
      }
    }, t.due_at ? new Date(t.due_at).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric'
    }) : '—'), cols.includes('assignee') && /*#__PURE__*/React.createElement("div", {
      style: {
        width: 110,
        flexShrink: 0,
        fontSize: '0.7rem',
        color: sub,
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis'
      }
    }, assignees.join(', ') || '—'), cols.includes('labels') && /*#__PURE__*/React.createElement("div", {
      style: {
        width: 120,
        flexShrink: 0,
        display: 'flex',
        flexWrap: 'wrap',
        gap: 3
      }
    }, myLabels.length ? myLabels.map(l => /*#__PURE__*/React.createElement("span", {
      key: l,
      style: {
        fontSize: '0.58rem',
        color: gold,
        background: dark ? 'rgba(201,164,90,0.15)' : '#F3EBDA',
        padding: '1px 5px',
        borderRadius: 8
      }
    }, l)) : /*#__PURE__*/React.createElement("span", {
      style: {
        color: sub,
        fontSize: '0.7rem'
      }
    }, "\u2014")), cols.includes('created') && /*#__PURE__*/React.createElement("div", {
      style: {
        width: 88,
        flexShrink: 0,
        textAlign: 'right',
        fontSize: '0.68rem',
        color: sub
      }
    }, t.created_at ? new Date(t.created_at).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric'
    }) : '—'), cols.includes('modified') && /*#__PURE__*/React.createElement("div", {
      style: {
        width: 88,
        flexShrink: 0,
        textAlign: 'right',
        fontSize: '0.68rem',
        color: sub
      }
    }, t.updated_at ? new Date(t.updated_at).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric'
    }) : '—'));
  };

  // Grouping/sorting shared by both row styles above. Completed tasks always
  // collapse to their own section at the bottom, regardless of Group mode.
  function renderGroupedList(rowFn) {
    const PRI = {
      high: 0,
      medium: 1,
      low: 2
    };
    const dueCmp = (a, b) => {
      if (!a.due_at && !b.due_at) return 0;
      if (!a.due_at) return 1;
      if (!b.due_at) return -1;
      return new Date(a.due_at) - new Date(b.due_at);
    };
    const byThen = (a, b) => {
      if (thenBy === 'priority') return (PRI[a.priority] ?? 1) - (PRI[b.priority] ?? 1);
      if (thenBy === 'title') return (a.title || '').localeCompare(b.title || '');
      if (thenBy === 'created') return new Date(b.created_at || 0) - new Date(a.created_at || 0);
      return dueCmp(a, b);
    };
    const active = filteredTasks.filter(t => t.status !== 'done');
    const completed = filteredTasks.filter(t => t.status === 'done').sort(byThen);
    let body;
    if (sortBy === 'none') {
      body = /*#__PURE__*/React.createElement("div", null, active.slice().sort(byThen).map(rowFn));
    } else if (sortBy === 'due') {
      const sorted = active.slice().sort((a, b) => dueCmp(a, b) || byThen(a, b));
      body = /*#__PURE__*/React.createElement("div", null, groupHead(dark ? '#C9A45A' : '#AD832F', 'By due date · ' + sorted.length), sorted.map(rowFn));
    } else if (sortBy === 'label') {
      const groups = {};
      const unlabeled = [];
      active.forEach(t => {
        const ls = myLabelsFor(t.id);
        if (!ls.length) unlabeled.push(t);else ls.forEach(l => {
          (groups[l] = groups[l] || []).push(t);
        });
      });
      const names = Object.keys(groups).sort((a, b) => a.localeCompare(b));
      body = /*#__PURE__*/React.createElement(React.Fragment, null, names.map(n => /*#__PURE__*/React.createElement("div", {
        key: n,
        style: {
          marginBottom: 16
        }
      }, groupHead(dark ? '#C9A45A' : '#AD832F', n + ' · ' + groups[n].length), groups[n].slice().sort(byThen).map(rowFn))), unlabeled.length > 0 && /*#__PURE__*/React.createElement("div", {
        style: {
          marginBottom: 16
        }
      }, groupHead(sub, 'Unlabeled · ' + unlabeled.length), unlabeled.slice().sort(byThen).map(rowFn)));
    } else if (sortBy === 'assignee') {
      const groups = {};
      const unassigned = [];
      active.forEach(t => {
        const names = (data.peopleByTask[t.id] || []).filter(p => p.role === 'assignee').map(p => (team.find(m => m.id === p.user_id) || {}).name).filter(Boolean);
        if (!names.length) unassigned.push(t);else names.forEach(n => {
          (groups[n] = groups[n] || []).push(t);
        });
      });
      const names = Object.keys(groups).sort((a, b) => a.localeCompare(b));
      body = /*#__PURE__*/React.createElement(React.Fragment, null, names.map(n => /*#__PURE__*/React.createElement("div", {
        key: n,
        style: {
          marginBottom: 16
        }
      }, groupHead(dark ? '#C9A45A' : '#AD832F', n + ' · ' + groups[n].length), groups[n].slice().sort(byThen).map(rowFn))), unassigned.length > 0 && /*#__PURE__*/React.createElement("div", {
        style: {
          marginBottom: 16
        }
      }, groupHead(sub, 'Unassigned · ' + unassigned.length), unassigned.slice().sort(byThen).map(rowFn)));
    } else if (sortBy === 'priority') {
      body = TASK_PRIORITY.slice().sort((a, b) => PRI[a.id] - PRI[b.id]).map(p => {
        const items = active.filter(t => t.priority === p.id).sort(byThen);
        if (!items.length) return null;
        return /*#__PURE__*/React.createElement("div", {
          key: p.id,
          style: {
            marginBottom: 16
          }
        }, groupHead(p.color, priorityLabel(p.id) + ' priority · ' + items.length), items.map(rowFn));
      });
    } else if (sortBy === 'project') {
      const groups = {};
      active.forEach(t => {
        const n = t._projectName || 'No project';
        (groups[n] = groups[n] || []).push(t);
      });
      const names = Object.keys(groups).sort((a, b) => (a === 'No project') - (b === 'No project') || a.localeCompare(b));
      body = names.map(n => /*#__PURE__*/React.createElement("div", {
        key: n,
        style: {
          marginBottom: 16
        }
      }, groupHead(n === 'No project' ? sub : dark ? '#C9A45A' : '#AD832F', n + ' · ' + groups[n].length), groups[n].slice().sort(byThen).map(rowFn)));
    } else {
      body = TASK_STATUS.filter(col => col.id !== 'done').map(col => {
        const items = active.filter(t => t.status === col.id).sort(byThen);
        if (!items.length) return null;
        return /*#__PURE__*/React.createElement("div", {
          key: col.id,
          style: {
            marginBottom: 16
          }
        }, groupHead(col.color, col.label + ' · ' + items.length), items.map(rowFn));
      });
    }
    return /*#__PURE__*/React.createElement(React.Fragment, null, body, /*#__PURE__*/React.createElement("div", {
      style: {
        marginTop: completed.length ? 16 : 0
      }
    }, completed.length > 0 && /*#__PURE__*/React.createElement("button", {
      onClick: () => setCompletedOpen(o => !o),
      style: {
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        width: '100%',
        background: 'none',
        border: 'none',
        padding: '6px 0',
        cursor: 'pointer',
        fontFamily: C.fontSans
      }
    }, /*#__PURE__*/React.createElement("i", {
      className: 'ti ti-chevron-' + (completedOpen ? 'down' : 'right'),
      style: {
        fontSize: 13,
        color: sub
      }
    }), /*#__PURE__*/React.createElement("span", {
      style: {
        fontSize: '0.64rem',
        fontWeight: 700,
        letterSpacing: '0.1em',
        textTransform: 'uppercase',
        color: sub
      }
    }, "Completed \xB7 ", completed.length)), completedOpen && completed.map(rowFn)));
  }

  // Kanban board — the shared TaskBoard component, wired to My Tasks' own
  // list + status persistence. Real drag-and-drop (see TaskBoard above).
  async function boardDrop(taskId, status) {
    const t = data.tasks.find(x => x.id === taskId);
    if (t && t.status !== status) await changeStatus(t, status);
  }
  return /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    onClick: e => e.stopPropagation(),
    style: containerStyle
  }, embed ? ( /* ══════ EMBEDDED POPOUT — unchanged, out of scope for the My Tasks redesign ══════ */
  wide ? /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flex: 1,
      minHeight: 0
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: 212,
      flexShrink: 0,
      borderRight: `1px solid ${bord}`,
      background: dark ? '#08132A' : '#FCFBF8',
      display: 'flex',
      flexDirection: 'column',
      minHeight: 0
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      padding: '10px 12px',
      borderBottom: `1px solid ${bord}`,
      flexShrink: 0
    }
  }, /*#__PURE__*/React.createElement("i", {
    className: "ti ti-checklist",
    style: {
      fontSize: 15,
      color: gold,
      flexShrink: 0
    }
  }), /*#__PURE__*/React.createElement("span", {
    style: {
      flex: 1,
      fontFamily: C.fontSans,
      fontSize: 12.5,
      fontWeight: 600,
      color: ink
    }
  }, "Tasks"), searchBtn, labelsBtn), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      padding: '7px 10px',
      borderBottom: `1px solid ${bord}`,
      flexShrink: 0
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      minWidth: 0
    }
  }, sortSelect), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      minWidth: 0
    }
  }, thenBySelect), newBtn), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      minHeight: 0,
      overflowY: 'auto',
      WebkitOverflowScrolling: 'touch'
    }
  }, listInner(true))), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      minWidth: 0,
      display: 'flex',
      flexDirection: 'column',
      minHeight: 0
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      minHeight: 0,
      overflowY: 'auto',
      WebkitOverflowScrolling: 'touch'
    }
  }, detailPane || /*#__PURE__*/React.createElement("div", {
    style: {
      height: '100%',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '40px 24px',
      textAlign: 'center',
      color: sub,
      fontFamily: C.fontSans
    }
  }, /*#__PURE__*/React.createElement("i", {
    className: "ti ti-list-check",
    style: {
      fontSize: 30,
      color: dark ? '#22324A' : '#D4D0CC',
      marginBottom: 12
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: '0.86rem'
    }
  }, "Select a task to see its details"))))) : /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 8,
      padding: '9px 12px',
      borderBottom: `1px solid ${bord}`,
      flexShrink: 0
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      minWidth: 0
    }
  }, view === 'list' ? /*#__PURE__*/React.createElement("i", {
    className: "ti ti-checklist",
    style: {
      fontSize: 15,
      color: gold
    }
  }) : /*#__PURE__*/React.createElement("i", {
    className: "ti ti-chevron-left",
    onClick: back,
    "aria-label": "Back",
    style: {
      fontSize: 16,
      cursor: 'pointer',
      color: sub
    }
  }), /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: C.fontSans,
      fontSize: 12.5,
      fontWeight: 600,
      letterSpacing: '0.03em',
      color: ink,
      whiteSpace: 'nowrap',
      overflow: 'hidden',
      textOverflow: 'ellipsis'
    }
  }, titleText)), view === 'list' ? /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 9,
      flexShrink: 0,
      flexWrap: 'wrap',
      justifyContent: 'flex-end'
    }
  }, searchBtn, sortSelect, thenBySelect, labelsBtn, newBtn) : !embed && /*#__PURE__*/React.createElement("i", {
    className: "ti ti-x",
    onClick: onClose,
    "aria-label": "Close",
    style: {
      fontSize: 15,
      cursor: 'pointer',
      color: dark ? 'rgba(255,255,255,0.4)' : '#B4B2A9',
      flexShrink: 0
    }
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      minHeight: 0,
      overflowY: 'auto',
      WebkitOverflowScrolling: 'touch'
    }
  }, detailPane || listInner(false)))) : ( /* ══════ STANDALONE /tasks — My Tasks / CTC Files / Projects ══════ */
  wide ?
  /*#__PURE__*/
  /* ── Desktop: persistent left sidebar (My Tasks / CTC Files / Projects) — this
     IS the surface switcher on desktop; the title dropdown is mobile-only. ── */
  React.createElement("div", {
    style: {
      display: 'flex',
      flex: 1,
      minHeight: 0
    }
  }, navSidebar, /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      minWidth: 0,
      display: 'flex',
      flexDirection: 'column',
      minHeight: 0
    }
  }, surface !== 'my' ? /*#__PURE__*/React.createElement(ProjectsSurface, {
    kind: surfaceKind[surface] || 'project',
    dark: dark,
    user: user,
    team: team,
    titleNode: plainSurfaceTitle,
    hideSidebar: true,
    openId: openItemId,
    onOpenIdConsumed: () => setOpenItemId(null)
  }) : /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    style: {
      padding: '26px 34px 0',
      flexShrink: 0
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'flex-start',
      justifyContent: 'space-between',
      gap: 16,
      flexWrap: 'wrap'
    }
  }, /*#__PURE__*/React.createElement("div", null, plainSurfaceTitle(), /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: C.fontSans,
      fontSize: 13.5,
      color: sub,
      marginTop: 3
    }
  }, dueTodayCount, " due today \xB7 ", overdueCount, " overdue \xB7 ", openCount, " open")), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 8,
      alignItems: 'center',
      position: 'relative'
    }
  }, searchChip, emailIconBtn, displayBtn, newBtn, dispScrim)), viewTabsRow), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      minHeight: 0,
      overflowY: 'auto',
      WebkitOverflowScrolling: 'touch',
      display: 'flex',
      flexDirection: 'column',
      padding: '14px 34px 0'
    }
  }, loading ? /*#__PURE__*/React.createElement("div", {
    style: {
      color: sub,
      fontSize: '0.82rem',
      padding: 20,
      fontFamily: C.fontSans
    }
  }, "Loading\u2026") : data.tasks.length === 0 ? /*#__PURE__*/React.createElement("div", {
    style: {
      color: sub,
      fontSize: '0.82rem',
      padding: 24,
      textAlign: 'center',
      fontFamily: C.fontSans
    }
  }, "No tasks yet. Tap ", /*#__PURE__*/React.createElement("b", null, "New"), " to add one.") : viewMode === 'kanban' ? /*#__PURE__*/React.createElement(TaskBoard, {
    items: filteredTasks,
    dark: dark,
    onOpen: t => {
      setCurrent(t);
      setView('detail');
    },
    onContextMenu: openCtx,
    onDrop: boardDrop,
    showSource: true,
    linksByTask: linksByTask
  }) : viewMode === 'timeline' ? /*#__PURE__*/React.createElement(TaskTimeline, {
    items: filteredTasks,
    dark: dark,
    onOpen: t => {
      setCurrent(t);
      setView('detail');
    }
  }) : /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      padding: '0 12px 8px',
      fontSize: 10.5,
      letterSpacing: '0.14em',
      textTransform: 'uppercase',
      fontWeight: 500,
      color: sub,
      borderBottom: `1px solid ${bord}`,
      gap: 12,
      fontFamily: C.fontSans
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      width: 14,
      flexShrink: 0
    }
  }), /*#__PURE__*/React.createElement("span", {
    style: {
      flex: 1
    }
  }, "Task"), cols.includes('source') && /*#__PURE__*/React.createElement("span", {
    style: {
      width: 150,
      flexShrink: 0
    }
  }, "Source"), cols.includes('status') && /*#__PURE__*/React.createElement("span", {
    style: {
      width: 130,
      flexShrink: 0
    }
  }, "Status"), /*#__PURE__*/React.createElement("span", {
    style: {
      width: 90,
      flexShrink: 0
    }
  }, "Priority"), cols.includes('due') && /*#__PURE__*/React.createElement("span", {
    style: {
      width: 96,
      flexShrink: 0,
      textAlign: 'right'
    }
  }, "Due"), cols.includes('assignee') && /*#__PURE__*/React.createElement("span", {
    style: {
      width: 110,
      flexShrink: 0
    }
  }, "Assignee"), cols.includes('labels') && /*#__PURE__*/React.createElement("span", {
    style: {
      width: 120,
      flexShrink: 0
    }
  }, "Labels"), cols.includes('created') && /*#__PURE__*/React.createElement("span", {
    style: {
      width: 88,
      flexShrink: 0,
      textAlign: 'right'
    }
  }, "Created"), cols.includes('modified') && /*#__PURE__*/React.createElement("span", {
    style: {
      width: 88,
      flexShrink: 0,
      textAlign: 'right'
    }
  }, "Modified")), /*#__PURE__*/React.createElement("div", {
    style: {
      padding: '4px 0 24px'
    }
  }, renderGroupedList(deskRow)), quickAddRow)), view !== 'list' && /*#__PURE__*/React.createElement(TaskDrawer, {
    dark: dark,
    onClose: back
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 10,
      padding: '14px 20px',
      borderBottom: `1px solid ${bord}`,
      flexShrink: 0,
      background: dark ? '#0A1730' : '#fff'
    }
  }, /*#__PURE__*/React.createElement("i", {
    className: "ti ti-chevron-left",
    onClick: back,
    "aria-label": "Back",
    style: {
      fontSize: 16,
      cursor: 'pointer',
      color: sub,
      flexShrink: 0
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      minWidth: 0,
      fontSize: 11,
      letterSpacing: '0.14em',
      textTransform: 'uppercase',
      color: sub,
      fontFamily: C.fontSans,
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap'
    }
  }, current && current._projectName || 'My Tasks', " / ", titleText), /*#__PURE__*/React.createElement("i", {
    className: "ti ti-x",
    onClick: back,
    "aria-label": "Close",
    style: {
      fontSize: 15,
      cursor: 'pointer',
      color: sub,
      flexShrink: 0
    }
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      minHeight: 0,
      overflowY: 'auto',
      WebkitOverflowScrolling: 'touch'
    }
  }, detailPane)), mailboxOpen && /*#__PURE__*/React.createElement(TaskMailbox, {
    dark: dark,
    user: user,
    tasks: data.tasks,
    linksByTask: linksByTask,
    onAttached: onEmailAttached,
    onCreateTask: onCreateTaskFromEmail,
    onOpenTask: (t, threadId) => {
      setMailboxOpen(false);
      setEmailTabFocus(threadId);
      setCurrent(t);
      setView('detail');
    },
    onClose: () => setMailboxOpen(false)
  })))) : ( /* ── Mobile: single column, no sidebar — title dropdown switches surfaces ── */
  surface !== 'my' ? /*#__PURE__*/React.createElement(ProjectsSurface, {
    kind: surfaceKind[surface] || 'project',
    dark: dark,
    user: user,
    team: team,
    titleNode: surfaceTitle,
    openId: openItemId,
    onOpenIdConsumed: () => setOpenItemId(null)
  }) : view !== 'list' ? /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      padding: '9px 12px',
      borderBottom: `1px solid ${bord}`,
      flexShrink: 0
    }
  }, /*#__PURE__*/React.createElement("i", {
    className: "ti ti-chevron-left",
    onClick: back,
    "aria-label": "Back",
    style: {
      fontSize: 16,
      cursor: 'pointer',
      color: sub
    }
  }), /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: C.fontSans,
      fontSize: 12.5,
      fontWeight: 600,
      letterSpacing: '0.03em',
      color: ink
    }
  }, titleText)), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      minHeight: 0,
      overflowY: 'auto',
      WebkitOverflowScrolling: 'touch'
    }
  }, detailPane)) : /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    style: {
      padding: '12px 14px 0',
      borderBottom: `1px solid ${bord}`,
      flexShrink: 0
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'flex-end',
      justifyContent: 'space-between',
      gap: 12,
      marginBottom: 8,
      flexWrap: 'wrap'
    }
  }, surfaceTitle(15), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 5,
      flexWrap: 'wrap'
    }
  }, groupChip, sortChip, searchChip, labelsBtn, newBtn)), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      padding: '2px 0 10px'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'baseline',
      gap: 6,
      paddingRight: 14,
      marginRight: 14,
      borderRight: `1px solid ${bord}`
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 15,
      fontWeight: 600,
      color: ink,
      fontFamily: C.fontSans
    }
  }, dueTodayCount), /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 10,
      color: sub,
      fontFamily: C.fontSans
    }
  }, "due today")), overdueCount > 0 && /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'baseline',
      gap: 6,
      paddingRight: 14,
      marginRight: 14,
      borderRight: `1px solid ${bord}`
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 15,
      fontWeight: 600,
      color: lateColor,
      fontFamily: C.fontSans
    }
  }, overdueCount), /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 10,
      color: lateColor,
      fontFamily: C.fontSans
    }
  }, "overdue")), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'baseline',
      gap: 6
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 15,
      fontWeight: 600,
      color: ink,
      fontFamily: C.fontSans
    }
  }, openCount), /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 10,
      color: sub,
      fontFamily: C.fontSans
    }
  }, "open")))), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      minHeight: 0,
      overflowY: 'auto',
      WebkitOverflowScrolling: 'touch',
      display: 'flex',
      flexDirection: 'column'
    }
  }, loading ? /*#__PURE__*/React.createElement("div", {
    style: {
      color: sub,
      fontSize: '0.82rem',
      padding: 20,
      fontFamily: C.fontSans
    }
  }, "Loading\u2026") : data.tasks.length === 0 ? /*#__PURE__*/React.createElement("div", {
    style: {
      color: sub,
      fontSize: '0.82rem',
      padding: 24,
      textAlign: 'center',
      fontFamily: C.fontSans
    }
  }, "No tasks yet. Tap ", /*#__PURE__*/React.createElement("b", null, "New"), " to add one.") : /*#__PURE__*/React.createElement("div", {
    style: {
      padding: '10px 14px 24px'
    }
  }, renderGroupedList(taskRowNew), quickAddRow)))))), ctxMenu && /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    onClick: () => setCtxMenu(null),
    onContextMenu: e => {
      e.preventDefault();
      setCtxMenu(null);
    },
    style: {
      position: 'fixed',
      inset: 0,
      zIndex: 70
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'fixed',
      left: ctxMenu.x,
      top: ctxMenu.y,
      zIndex: 71,
      background: dark ? '#0A1730' : '#fff',
      border: `1px solid ${bord}`,
      borderRadius: 9,
      boxShadow: '0 8px 24px rgba(0,26,74,0.18)',
      padding: 5,
      minWidth: 180
    }
  }, /*#__PURE__*/React.createElement("button", {
    onClick: () => {
      toggleMilestone(ctxMenu.task);
      setCtxMenu(null);
    },
    style: {
      width: '100%',
      textAlign: 'left',
      padding: '8px 10px',
      background: 'none',
      border: 'none',
      borderRadius: 6,
      color: ink,
      fontSize: '0.82rem',
      cursor: 'pointer',
      fontFamily: C.fontSans,
      display: 'flex',
      alignItems: 'center',
      gap: 8
    }
  }, /*#__PURE__*/React.createElement("i", {
    className: ctxMenu.task.is_milestone ? 'ti ti-flag-3-filled' : 'ti ti-flag-3',
    style: {
      color: gold,
      fontSize: 14,
      flexShrink: 0
    }
  }), ctxMenu.task.is_milestone ? 'Unmark as milestone' : 'Mark as milestone'))));
}

// ─── Projects (opened from the More menu) ────────────────────────

// ─── Placeholder (not-yet-built tabs) ────────────────────────────

// ─── Chat (Team Chat) Tab — preview mockup ───────────────────────
const TCHAT_PHOTOS = {
  tarek: 'https://themorshedgroup.com/wp-content/uploads/2023/01/tarek-morshed-headshot.jpg',
  symon: 'https://themorshedgroup.com/wp-content/uploads/2025/01/Hidenori-Symon-Yongco-headshot.jpg',
  brad: 'https://themorshedgroup.com/wp-content/uploads/2023/01/Brad-Baker-headshot-1.jpg',
  brett: 'https://themorshedgroup.com/wp-content/uploads/2025/09/Brett-Silverman-headshot.jpg',
  kyle: 'https://themorshedgroup.com/wp-content/uploads/2026/02/Kyle-Baird-headshot.jpg',
  alex: 'https://themorshedgroup.com/wp-content/uploads/2025/04/Alexandra-Machado-headshot.jpg',
  luciana: 'https://themorshedgroup.com/wp-content/uploads/2026/02/Luciana-Pilco-headshot.jpg'
};

// ─── Calls Tab — preview mockup ──────────────────────────────────

// ─── KPIs Tab — preview mockup ───────────────────────────────────

// ─── Bottom Nav ──────────────────────────────────────────────────
const TABS = [{
  id: 'chat',
  label: 'AI',
  icon: 'ti-sparkles'
}, {
  id: 'teamchat',
  label: 'Chat',
  icon: 'ti-message'
}, {
  id: 'calls',
  label: 'Calls',
  icon: 'ti-phone'
}, {
  id: 'kpis',
  label: 'KPIs',
  icon: 'ti-chart-bar'
}, {
  id: 'deals',
  label: 'Deals',
  icon: 'ti-currency-dollar'
}, {
  id: 'more',
  label: 'More',
  icon: 'ti-dots'
}];

// Fixed bottom zone: pill-shaped input bar (AI tab only) + floating pill nav (always).

// ─── Top Bar ─────────────────────────────────────────────────────
function TopBar({
  dark,
  onToggleDark,
  onCalendar,
  calendarOpen,
  onTasks,
  tasksOpen,
  onDecisions,
  decisionsOpen,
  avatar,
  name,
  dotColor,
  onProfile
}) {
  // Gold-tinted rounded-square chip; same tint + gold icon in light and dark.
  const iconBtn = (onClick, iconClass, title, active) => /*#__PURE__*/React.createElement("button", {
    onClick: onClick,
    title: title,
    "aria-label": title,
    style: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      width: 32,
      height: 32,
      borderRadius: 9,
      cursor: 'pointer',
      padding: 0,
      background: active ? 'rgba(201,164,90,0.30)' : 'rgba(201,164,90,0.16)',
      border: 'none',
      boxShadow: active ? '0 0 0 2px #C9A45A' : 'none',
      color: '#C9A45A',
      fontSize: 16,
      lineHeight: 1,
      transition: 'background 0.15s, box-shadow 0.15s'
    }
  }, /*#__PURE__*/React.createElement("i", {
    className: iconClass
  }));
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      padding: '12px 16px',
      paddingTop: 'calc(12px + env(safe-area-inset-top))',
      background: dark ? '#0A1730' : '#001A4A',
      backdropFilter: 'blur(20px) saturate(180%)',
      WebkitBackdropFilter: 'blur(20px) saturate(180%)',
      borderBottom: '1px solid rgba(255,255,255,0.08)',
      flexShrink: 0
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 9
    }
  }, /*#__PURE__*/React.createElement("a", {
    href: "index.html",
    title: "Back to TMG App",
    style: {
      color: 'rgba(255,255,255,.7)',
      textDecoration: 'none',
      display: 'flex',
      alignItems: 'center',
      marginRight: 3
    }
  }, /*#__PURE__*/React.createElement("i", {
    className: "ti ti-arrow-left",
    style: {
      fontSize: 18
    }
  })), /*#__PURE__*/React.createElement("img", {
    src: "m-monogram.png",
    alt: "",
    style: {
      height: 22,
      width: 'auto',
      display: 'block'
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      height: 22,
      fontSize: '14.4px',
      lineHeight: '22px',
      fontWeight: 600,
      color: C.gold,
      letterSpacing: '0.18em',
      textTransform: 'uppercase',
      fontFamily: "'Jost', sans-serif",
      whiteSpace: 'nowrap'
    }
  }, "TMG APP")), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 10
    }
  }, iconBtn(onTasks, 'ti ti-checklist', 'Tasks', tasksOpen), /*#__PURE__*/React.createElement("button", {
    onClick: onDecisions,
    title: "Decisions",
    "aria-label": "Decisions",
    style: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      width: 32,
      height: 32,
      borderRadius: 9,
      cursor: 'pointer',
      padding: 0,
      background: decisionsOpen ? 'rgba(201,164,90,0.30)' : 'rgba(201,164,90,0.16)',
      border: 'none',
      boxShadow: decisionsOpen ? '0 0 0 2px #C9A45A' : 'none',
      color: '#C9A45A',
      transition: 'background 0.15s, box-shadow 0.15s'
    }
  }, /*#__PURE__*/React.createElement("svg", {
    width: "17",
    height: "17",
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "2.2",
    strokeLinecap: "round",
    strokeLinejoin: "round"
  }, /*#__PURE__*/React.createElement("path", {
    d: "M12 4v6"
  }), /*#__PURE__*/React.createElement("path", {
    d: "M9 7l3-3 3 3"
  }), /*#__PURE__*/React.createElement("path", {
    d: "M4 13l-2 2 2 2"
  }), /*#__PURE__*/React.createElement("path", {
    d: "M2 15h7"
  }), /*#__PURE__*/React.createElement("path", {
    d: "M20 13l2 2-2 2"
  }), /*#__PURE__*/React.createElement("path", {
    d: "M22 15h-7"
  }))), iconBtn(onCalendar, 'ti ti-calendar', 'Calendar', calendarOpen), /*#__PURE__*/React.createElement("button", {
    onClick: onProfile,
    "aria-label": "Your profile",
    style: {
      position: 'relative',
      width: 32,
      height: 32,
      borderRadius: 9,
      border: 'none',
      padding: 0,
      cursor: 'pointer',
      background: 'rgba(201,164,90,0.16)',
      flexShrink: 0
    }
  }, avatar ? /*#__PURE__*/React.createElement("img", {
    src: avatar,
    alt: "",
    style: {
      width: 32,
      height: 32,
      borderRadius: 9,
      objectFit: 'cover',
      display: 'block'
    }
  }) : /*#__PURE__*/React.createElement("span", {
    style: {
      display: 'flex',
      width: 32,
      height: 32,
      borderRadius: 9,
      alignItems: 'center',
      justifyContent: 'center',
      color: C.goldSoft,
      fontFamily: C.fontSans,
      fontWeight: 600,
      fontSize: 13
    }
  }, (name || '?').trim().charAt(0).toUpperCase()), /*#__PURE__*/React.createElement("span", {
    style: {
      position: 'absolute',
      right: -2,
      bottom: -2,
      width: 11,
      height: 11,
      borderRadius: '50%',
      background: dotColor,
      border: `2px solid ${dark ? '#0A1730' : '#001A4A'}`
    }
  }))));
}

// ─── Profile / status panel (right slide-out) ───────────────────
// One cohesive TMG-branded card: accent bar · merged identity header
// (no role badge) · status controls · Details · Edit. Appearance /
// Chat History / Sign out stay BELOW the card (Settings-embedded).
function ProfilePanel({
  dark,
  user,
  profile,
  name,
  avatar,
  away,
  statusText,
  statusEmoji,
  onToggleAway,
  onOpenStatus,
  onClose,
  historySide,
  setHistorySide,
  setDark,
  fontScale,
  setFontScale
}) {
  const J = "'Jost', sans-serif";
  const [me, setMe] = useState(profile || null);
  const [allUsers, setAllUsers] = useState([]);
  const [editing, setEditing] = useState(false);
  const [first, setFirst] = useState(profile && profile.first_name || '');
  const [last, setLast] = useState(profile && profile.last_name || '');
  const [phone, setPhone] = useState(profile && profile.phone || '');
  const [country, setCountry] = useState(profile && profile.country || '');
  const [timezone, setTimezone] = useState(profile && profile.timezone || '');
  const [dob, setDob] = useState(profile && profile.dob || '');
  const [pets, setPets] = useState(profile && profile.pets || []);
  const [saving, setSaving] = useState(false);
  const [gcalState, setGcalState] = useState('checking'); // checking | connected | disconnected
  useEffect(() => {
    ProfileDB.loadAll().then(setAllUsers);
  }, []);
  // Ported from index.html's ProfilePanel — was missing here entirely, so the
  // Connect Google Calendar & Tasks card (and its connection status) never
  // showed on this standalone page's own profile panel.
  useEffect(() => {
    let c = false;
    callCalendar({
      action: 'calendars'
    }).then(({
      ok,
      data
    }) => {
      if (!c) setGcalState(ok && Array.isArray(data.calendars) && data.calendars.length ? 'connected' : 'disconnected');
    }).catch(() => {
      if (!c) setGcalState('disconnected');
    });
    return () => {
      c = true;
    };
  }, []);
  const email = me && me.email || user && user.email || '';
  const roleLine = me && me.title || '';
  const managerName = id => {
    if (!id) return '';
    const m = allUsers.find(u => u.id === id);
    return m ? ((m.first_name || '') + ' ' + (m.last_name || '')).trim() || m.email : '';
  };
  const locationText = () => {
    if (!me) return '';
    const c = COUNTRIES.find(x => x.c === me.country);
    const cn = c ? c.n : me.country || '';
    const city = me.timezone ? tzCity(me.timezone) : '';
    return [city, cn].filter(Boolean).join(', ');
  };
  async function saveMine() {
    setSaving(true);
    try {
      await ProfileDB.updateMine({
        first_name: first,
        last_name: last,
        phone,
        country,
        timezone,
        dob: dob || null,
        pets
      });
      setMe(prev => ({
        ...(prev || {}),
        first_name: first,
        last_name: last,
        phone,
        country,
        timezone,
        dob: dob || null,
        pets
      }));
      setEditing(false);
    } catch (e) {
      alert('Could not save: ' + (e.message || e));
    } finally {
      setSaving(false);
    }
  }

  // ── spec palette ──
  const panelBg = dark ? '#070F1E' : '#FCFBF8';
  const panelBorder = dark ? '#152545' : '#EDE7DC';
  const ink = dark ? '#fff' : '#001A4A';
  const keyMuted = dark ? 'rgba(255,255,255,0.4)' : '#9A958A';
  const valMuted = dark ? 'rgba(255,255,255,0.4)' : '#B4B2A9';
  const rowBorder = dark ? '#0D1E3A' : '#F0EBE3';
  const gold = dark ? '#C9A45A' : '#AD832F';
  const ruleCol = dark ? '#152545' : '#EDE7DC';
  const ctrlBg = dark ? '#0A1730' : '#FFFFFF';
  const ctrlBorder = dark ? '#152545' : '#E0D8CC';
  const awayBorder = dark ? '#152545' : '#EDE7DC';
  const slideBg = dark ? '#04091B' : '#F2EEE6';
  const accentBar = dark ? 'linear-gradient(90deg, #AD832F, #C9A45A)' : 'linear-gradient(90deg, #001A4A, #AD832F)';
  const presence = away ? '#E0A93B' : dark ? '#5DCAA5' : '#3DAF7E';
  const presenceTxt = away ? 'AWAY' : 'ACTIVE';
  const inputStyle = {
    width: '100%',
    padding: '10px 12px',
    background: ctrlBg,
    border: `1px solid ${ctrlBorder}`,
    borderRadius: 10,
    color: ink,
    fontSize: 13,
    outline: 'none',
    fontFamily: J
  };
  const detailRow = (label, value, opts) => {
    opts = opts || {};
    return /*#__PURE__*/React.createElement("div", {
      key: label,
      style: {
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        padding: '10px 0',
        borderBottom: opts.last ? 'none' : `1px solid ${rowBorder}`
      }
    }, /*#__PURE__*/React.createElement("span", {
      style: {
        fontFamily: J,
        fontSize: 10,
        color: keyMuted,
        flexShrink: 0
      }
    }, label), /*#__PURE__*/React.createElement("span", {
      style: {
        fontFamily: J,
        fontSize: opts.small ? 8.5 : 10,
        fontWeight: 600,
        color: opts.muted ? valMuted : ink,
        textAlign: 'right',
        marginLeft: 12,
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis'
      }
    }, value));
  };
  const mgr = managerName(me && me.reports_to);
  const loc = locationText();
  const petStr = me && me.pets && me.pets.length ? me.pets.map(petLabel).join('   ') : '';
  return /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    onClick: onClose,
    style: {
      position: 'fixed',
      inset: 0,
      zIndex: 70,
      background: 'rgba(0,0,0,0.4)'
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'fixed',
      top: 0,
      right: 0,
      bottom: 0,
      width: '88%',
      maxWidth: 390,
      zIndex: 71,
      background: slideBg,
      boxShadow: '-12px 0 30px rgba(0,0,0,0.28)',
      display: 'flex',
      flexDirection: 'column',
      overflowY: 'auto',
      WebkitOverflowScrolling: 'touch',
      overscrollBehavior: 'contain',
      transform: 'translateZ(0)'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      padding: 'calc(14px + env(safe-area-inset-top)) 16px 0'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      borderRadius: 18,
      overflow: 'hidden',
      border: `1px solid ${panelBorder}`,
      boxShadow: '0 12px 40px rgba(0,26,74,0.12)',
      background: panelBg
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      height: 4,
      background: accentBar
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'flex-start',
      gap: 13,
      padding: '18px 18px 16px'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'relative',
      flexShrink: 0
    }
  }, avatar ? /*#__PURE__*/React.createElement("img", {
    src: avatar,
    alt: "",
    style: {
      width: 58,
      height: 58,
      borderRadius: '50%',
      objectFit: 'cover'
    }
  }) : /*#__PURE__*/React.createElement("div", {
    style: {
      width: 58,
      height: 58,
      borderRadius: '50%',
      background: C.navy,
      color: C.goldSoft,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      fontFamily: J,
      fontWeight: 600,
      fontSize: 22
    }
  }, (name || '?').trim().charAt(0).toUpperCase()), /*#__PURE__*/React.createElement("span", {
    style: {
      position: 'absolute',
      right: 2,
      bottom: 2,
      width: 14,
      height: 14,
      borderRadius: '50%',
      background: presence,
      border: `2.5px solid ${panelBg}`
    }
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      minWidth: 0
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: J,
      fontSize: 16,
      fontWeight: 600,
      color: ink,
      whiteSpace: 'nowrap',
      overflow: 'hidden',
      textOverflow: 'ellipsis'
    }
  }, name), roleLine && /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: J,
      fontSize: 10,
      color: keyMuted,
      marginTop: 2,
      whiteSpace: 'nowrap',
      overflow: 'hidden',
      textOverflow: 'ellipsis'
    }
  }, roleLine), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 4,
      marginTop: 6
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      width: 6,
      height: 6,
      borderRadius: '50%',
      background: presence
    }
  }), /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: J,
      fontSize: 8,
      letterSpacing: '0.08em',
      fontWeight: 500,
      color: presence
    }
  }, presenceTxt))), /*#__PURE__*/React.createElement("button", {
    onClick: onClose,
    "aria-label": "Close",
    style: {
      flexShrink: 0,
      background: 'none',
      border: 'none',
      cursor: 'pointer',
      color: valMuted,
      fontSize: 17,
      display: 'flex'
    }
  }, /*#__PURE__*/React.createElement("i", {
    className: "ti ti-x"
  }))), !editing ? /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    style: {
      padding: '0 14px 12px'
    }
  }, /*#__PURE__*/React.createElement("button", {
    onClick: onOpenStatus,
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 9,
      width: '100%',
      textAlign: 'left',
      borderRadius: 11,
      border: `1px solid ${ctrlBorder}`,
      background: ctrlBg,
      padding: '10px 12px',
      marginBottom: 8,
      cursor: 'pointer',
      fontFamily: J,
      fontSize: 10,
      color: statusText || statusEmoji ? ink : keyMuted
    }
  }, /*#__PURE__*/React.createElement("i", {
    className: "ti ti-mood-smile",
    style: {
      fontSize: 15,
      color: gold
    }
  }), statusText ? (statusEmoji ? statusEmoji + ' ' : '') + statusText : "What's your status?"), /*#__PURE__*/React.createElement("button", {
    onClick: onToggleAway,
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 9,
      width: '100%',
      textAlign: 'left',
      borderRadius: 11,
      border: `1px solid ${awayBorder}`,
      background: ctrlBg,
      padding: '9px 12px',
      cursor: 'pointer',
      fontFamily: J,
      fontSize: 10,
      fontWeight: 500,
      color: ink
    }
  }, /*#__PURE__*/React.createElement("i", {
    className: "ti ti-clock-pause",
    style: {
      fontSize: 15,
      color: away ? '#E0A93B' : gold
    }
  }), away ? 'Set yourself as active' : 'Set yourself as away')), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 6,
      padding: '6px 18px 8px'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: J,
      fontSize: 7,
      letterSpacing: '0.18em',
      fontWeight: 600,
      textTransform: 'uppercase',
      color: gold
    }
  }, "Details"), /*#__PURE__*/React.createElement("span", {
    style: {
      flex: 1,
      height: 1,
      background: ruleCol
    }
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      padding: '0 18px'
    }
  }, detailRow('Employee ID', me && me.employee_id || '—', {
    muted: !(me && me.employee_id)
  }), detailRow('Title', roleLine || '—', {
    muted: !roleLine
  }), detailRow('Reports to', mgr || '—', {
    muted: !mgr
  }), detailRow('Phone', me && me.phone ? contactLink('Phone', me.phone) : '—', {
    muted: !(me && me.phone)
  }), detailRow('Email', email ? contactLink('Email', email) : '—', {
    small: true,
    muted: !email
  }), detailRow('Location', loc || '—', {
    muted: !loc
  }), detailRow('Local time', me && me.timezone ? localTimeIn(me.timezone) : '—', {
    muted: !(me && me.timezone)
  }), detailRow('Pets', petStr || '—', {
    last: true,
    muted: !petStr
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      padding: '14px 18px 18px'
    }
  }, /*#__PURE__*/React.createElement("button", {
    onClick: () => {
      setFirst(me && me.first_name || '');
      setLast(me && me.last_name || '');
      setPhone(me && me.phone || '');
      setCountry(me && me.country || '');
      setTimezone(me && me.timezone || '');
      setDob(me && me.dob || '');
      setPets(me && me.pets || []);
      setEditing(true);
    },
    style: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 7,
      width: '100%',
      padding: 13,
      borderRadius: 11,
      border: 'none',
      cursor: 'pointer',
      fontFamily: J,
      fontSize: 11,
      fontWeight: 600,
      letterSpacing: '0.06em',
      background: dark ? '#AD832F' : '#001A4A',
      color: '#fff'
    }
  }, /*#__PURE__*/React.createElement("i", {
    className: "ti ti-pencil",
    style: {
      fontSize: 14
    }
  }), "Edit my info"))) : /*#__PURE__*/React.createElement("div", {
    style: {
      padding: '4px 18px 18px',
      display: 'flex',
      flexDirection: 'column',
      gap: 8
    }
  }, /*#__PURE__*/React.createElement("input", {
    placeholder: "First name",
    value: first,
    onChange: e => setFirst(e.target.value),
    style: inputStyle
  }), /*#__PURE__*/React.createElement("input", {
    placeholder: "Last name",
    value: last,
    onChange: e => setLast(e.target.value),
    style: inputStyle
  }), /*#__PURE__*/React.createElement("input", {
    placeholder: "Phone",
    value: phone,
    onChange: e => setPhone(e.target.value),
    style: inputStyle
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: J,
      fontSize: 10,
      color: keyMuted,
      marginTop: 2
    }
  }, "Location"), /*#__PURE__*/React.createElement("select", {
    value: country,
    onChange: e => {
      setCountry(e.target.value);
      setTimezone('');
    },
    style: inputStyle
  }, /*#__PURE__*/React.createElement("option", {
    value: ""
  }, "Country\u2026"), COUNTRIES.map(c => /*#__PURE__*/React.createElement("option", {
    key: c.c,
    value: c.c
  }, c.n))), country && (COUNTRY_TZ[country] || []).length > 0 && /*#__PURE__*/React.createElement("select", {
    value: timezone,
    onChange: e => setTimezone(e.target.value),
    style: inputStyle
  }, /*#__PURE__*/React.createElement("option", {
    value: ""
  }, "City / time zone\u2026"), (COUNTRY_TZ[country] || []).map(z => /*#__PURE__*/React.createElement("option", {
    key: z,
    value: z
  }, tzCity(z)))), timezone && /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: J,
      fontSize: 10,
      color: keyMuted
    }
  }, "Local time: ", /*#__PURE__*/React.createElement("b", {
    style: {
      color: ink
    }
  }, localTimeIn(timezone))), /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: J,
      fontSize: 10,
      color: keyMuted,
      marginTop: 2
    }
  }, "Date of birth ", /*#__PURE__*/React.createElement("span", {
    style: {
      opacity: 0.7
    }
  }, "(optional)")), /*#__PURE__*/React.createElement("input", {
    type: "date",
    value: dob || '',
    onChange: e => setDob(e.target.value),
    style: inputStyle
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: J,
      fontSize: 10,
      color: keyMuted,
      marginTop: 2
    }
  }, "Pets"), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexWrap: 'wrap',
      gap: 6
    }
  }, PETS.map(p => {
    const on = pets.includes(p.k);
    return /*#__PURE__*/React.createElement("button", {
      key: p.k,
      type: "button",
      onClick: () => setPets(on ? pets.filter(x => x !== p.k) : [...pets, p.k]),
      style: {
        padding: '7px 11px',
        borderRadius: 20,
        border: `1px solid ${on ? C.navy : ctrlBorder}`,
        background: on ? C.navy : ctrlBg,
        color: on ? '#fff' : keyMuted,
        fontSize: 12,
        cursor: 'pointer',
        fontFamily: J
      }
    }, p.e, " ", p.label);
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 8,
      marginTop: 4
    }
  }, /*#__PURE__*/React.createElement("button", {
    onClick: saveMine,
    disabled: saving,
    style: {
      flex: 1,
      padding: 11,
      background: dark ? '#AD832F' : C.navy,
      color: '#fff',
      border: 'none',
      borderRadius: 11,
      fontSize: 13,
      fontWeight: 600,
      cursor: 'pointer',
      fontFamily: J
    }
  }, saving ? 'Saving…' : 'Save'), /*#__PURE__*/React.createElement("button", {
    onClick: () => setEditing(false),
    style: {
      flex: 1,
      padding: 11,
      background: 'none',
      color: keyMuted,
      border: `1px solid ${ctrlBorder}`,
      borderRadius: 11,
      fontSize: 13,
      cursor: 'pointer',
      fontFamily: J
    }
  }, "Cancel")), /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: J,
      fontSize: 9,
      color: keyMuted,
      lineHeight: 1.4
    }
  }, "Employee ID, title, reports-to, and access are set by an admin.")))), /*#__PURE__*/React.createElement("div", {
    style: {
      background: ctrlBg,
      border: dark ? `1px solid ${panelBorder}` : 'none',
      boxShadow: dark ? 'none' : '0 2px 8px rgba(0,26,74,0.07), 0 1px 2px rgba(0,26,74,0.04)',
      borderRadius: 14,
      padding: 16,
      margin: '14px 16px 0'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      marginBottom: 10
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: J,
      fontSize: '0.72rem',
      fontWeight: 600,
      letterSpacing: '0.08em',
      textTransform: 'uppercase',
      color: ink
    }
  }, "Google Email, Calendar & Tasks"), /*#__PURE__*/React.createElement("span", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 4,
      marginLeft: 'auto',
      fontFamily: J,
      fontSize: 8,
      fontWeight: 600,
      letterSpacing: '0.04em',
      color: gcalState === 'connected' ? presence : keyMuted
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      width: 5,
      height: 5,
      borderRadius: '50%',
      background: gcalState === 'connected' ? presence : valMuted
    }
  }), gcalState === 'checking' ? '…' : gcalState === 'connected' ? 'CONNECTED' : 'NOT CONNECTED')), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: 5,
      marginBottom: 12
    }
  }, ['Gmail is read to update CTC files or connect it to tasks', 'Google Calendar is shown in the Calendar tab', 'TMG App tasks are synced to your Google Tasks'].map((line, i) => /*#__PURE__*/React.createElement("div", {
    key: i,
    style: {
      display: 'flex',
      gap: 6,
      fontFamily: J,
      fontSize: 10,
      color: keyMuted,
      lineHeight: 1.5
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      color: gold,
      flexShrink: 0
    }
  }, "\u2022"), /*#__PURE__*/React.createElement("span", null, line)))), /*#__PURE__*/React.createElement("button", {
    onClick: () => {
      try {
        window.SupabaseAuth.connectCalendar();
      } catch (e) {}
    },
    style: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 7,
      width: '100%',
      padding: 12,
      borderRadius: 11,
      border: `1px solid ${ctrlBorder}`,
      cursor: 'pointer',
      fontFamily: J,
      fontSize: 11,
      fontWeight: 600,
      letterSpacing: '0.04em',
      background: dark ? '#0A1730' : '#FCFBF8',
      color: ink
    }
  }, /*#__PURE__*/React.createElement("i", {
    className: "ti ti-brand-google",
    style: {
      fontSize: 14,
      color: gold
    }
  }), gcalState === 'connected' ? 'Reconnect Google Calendar & Tasks' : 'Connect Google Calendar & Tasks')), /*#__PURE__*/React.createElement("div", {
    style: {
      paddingTop: 14
    }
  }, /*#__PURE__*/React.createElement(SettingsTab, {
    embedded: true,
    historySide: historySide,
    setHistorySide: setHistorySide,
    dark: dark,
    setDark: setDark,
    fontScale: fontScale,
    setFontScale: setFontScale
  }))));
}

// ─── Set-status sheet ────────────────────────────────────────────
function StatusModal({
  dark,
  initialText,
  initialEmoji,
  onSave,
  onClose
}) {
  const J = "'Jost', sans-serif";
  const [text, setText] = useState(initialText || '');
  const [emoji, setEmoji] = useState(initialEmoji || '');
  const ink = dark ? '#fff' : '#001A4A';
  const sub = dark ? 'rgba(255,255,255,0.5)' : '#6B6B6B';
  const bord = dark ? '#152545' : '#E4DFD4';
  const accent = dark ? '#7A9AFF' : '#2A4FA4';
  const SUGGEST = [{
    e: '📅',
    t: 'In a meeting'
  }, {
    e: '🍔',
    t: 'Out at lunch'
  }, {
    e: '🚌',
    t: 'Commuting'
  }, {
    e: '🏡',
    t: 'Working remotely'
  }, {
    e: '🤒',
    t: 'Out sick'
  }, {
    e: '🏖️',
    t: 'On vacation'
  }];
  return /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    onClick: onClose,
    style: {
      position: 'fixed',
      inset: 0,
      zIndex: 80,
      background: 'rgba(0,0,0,0.5)'
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'fixed',
      left: 0,
      right: 0,
      bottom: 0,
      zIndex: 81,
      maxHeight: '88%',
      background: dark ? '#0A1730' : '#FFFFFF',
      borderTopLeftRadius: 20,
      borderTopRightRadius: 20,
      display: 'flex',
      flexDirection: 'column',
      overflow: 'hidden'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      padding: '14px 16px'
    }
  }, /*#__PURE__*/React.createElement("button", {
    onClick: onClose,
    style: {
      background: 'none',
      border: 'none',
      cursor: 'pointer',
      fontFamily: J,
      fontSize: 15,
      color: accent
    }
  }, "Cancel"), /*#__PURE__*/React.createElement("button", {
    onClick: () => onSave(text.trim(), emoji),
    style: {
      background: 'none',
      border: 'none',
      cursor: 'pointer',
      fontFamily: J,
      fontSize: 15,
      fontWeight: 600,
      color: accent
    }
  }, "Done")), /*#__PURE__*/React.createElement("div", {
    style: {
      padding: '0 16px 24px',
      overflowY: 'auto'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: J,
      fontSize: 22,
      fontWeight: 600,
      color: ink,
      marginBottom: 6
    }
  }, "Set your status"), /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: J,
      fontSize: 13,
      color: sub,
      lineHeight: 1.5,
      marginBottom: 16
    }
  }, "Let your team know what you're up to."), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 6,
      border: `1px solid ${bord}`,
      borderRadius: 12,
      padding: '4px 8px 4px 4px',
      marginBottom: 18
    }
  }, /*#__PURE__*/React.createElement("input", {
    value: emoji,
    onChange: e => setEmoji(e.target.value.slice(0, 4)),
    placeholder: "\uD83D\uDE42",
    style: {
      width: 44,
      height: 40,
      textAlign: 'center',
      fontSize: 20,
      border: 'none',
      outline: 'none',
      background: 'transparent'
    }
  }), /*#__PURE__*/React.createElement("input", {
    value: text,
    onChange: e => setText(e.target.value),
    placeholder: "What's your status?",
    style: {
      flex: 1,
      minWidth: 0,
      border: 'none',
      outline: 'none',
      background: 'transparent',
      fontFamily: J,
      fontSize: 15,
      color: ink
    }
  }), (text || emoji) && /*#__PURE__*/React.createElement("button", {
    onClick: () => {
      setText('');
      setEmoji('');
    },
    "aria-label": "Clear",
    style: {
      background: 'none',
      border: 'none',
      cursor: 'pointer',
      color: sub,
      fontSize: 18,
      display: 'flex'
    }
  }, /*#__PURE__*/React.createElement("i", {
    className: "ti ti-x"
  }))), /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: J,
      fontSize: 12,
      color: sub,
      letterSpacing: '0.04em',
      marginBottom: 4
    }
  }, "Suggestions"), SUGGEST.map((s, i) => /*#__PURE__*/React.createElement("button", {
    key: i,
    onClick: () => {
      setEmoji(s.e);
      setText(s.t);
    },
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 13,
      width: '100%',
      textAlign: 'left',
      padding: '12px 4px',
      background: 'none',
      border: 'none',
      borderTop: i ? `1px solid ${dark ? '#152545' : '#F0EBE3'}` : 'none',
      cursor: 'pointer',
      fontFamily: J,
      fontSize: 15,
      color: ink
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 20,
      width: 24,
      textAlign: 'center'
    }
  }, s.e), s.t)))));
}

// ─── Deals Tab ───────────────────────────────────────────────────

// ─── Calendar Popover ────────────────────────────────────────────
// Calendar popout v2 — TOP-anchored (top:0 of the conversation area; grows DOWNWARD,
// NOT a bottom slide-up). Nav bar (Today / ‹› / date / 3 PRIOs / chips / Day-Week-Month),
// a collapsible Task strip, a TZ-aligned date strip, and Day/Week/Month grids.
function CalendarPopover({
  dark,
  zoneH,
  onOpenTask,
  onClose
}) {
  const J = "'Jost', sans-serif";
  const p2 = n => String(n).padStart(2, '0');
  const isoOf = d => d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate());
  const mondayOf = d => {
    const x = new Date(d);
    const off = (x.getDay() + 6) % 7;
    x.setDate(x.getDate() - off);
    x.setHours(0, 0, 0, 0);
    return x;
  };
  const addDays = (d, n) => {
    const x = new Date(d);
    x.setDate(x.getDate() + n);
    return x;
  };
  const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  const todayD = new Date();
  const [view, setView] = useState('day'); // day | week | month
  const [anchor, setAnchor] = useState(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  });
  const [tasksOpen, setTasksOpen] = useState(false);
  const [vis, setVis] = useState(false);
  const [gevents, setGevents] = useState([]);
  const [tasks, setTasks] = useState([]);
  const [peopleByTask, setPeopleByTask] = useState({});
  const [roster, setRoster] = useState({});
  const [decOpen, setDecOpen] = useState(false);
  const [decData, setDecData] = useState({}); // taskId -> { options, comments, loaded }
  const [decDraft, setDecDraft] = useState({}); // taskId -> comment draft
  const [gcal, setGcal] = useState('loading'); // loading | ready | needs_connect | error
  const scrollRef = useRef(null);
  const dateInputRef = useRef(null);
  const user = window.SupabaseAuth && window.SupabaseAuth._state && window.SupabaseAuth._state.session && window.SupabaseAuth._state.session.user || null;
  useEffect(() => {
    const r = requestAnimationFrame(() => setVis(true));
    return () => cancelAnimationFrame(r);
  }, []);

  // ── Display settings (per-user, this device): which calendars show + the two rail zones ──
  const [showSettings, setShowSettings] = useState(false);
  const [calList, setCalList] = useState([]); // [{ id, summary, color, primary }]
  const CAL_PREFS_DEFAULT = {
    primaryTz: 'America/Chicago',
    secondaryTz: 'Asia/Manila',
    secondaryTzEnabled: false,
    hidden: [],
    autoSyncTasks: false
  };
  const calPrefsKey = 'tmg-cal-prefs' + (user ? '-' + user.id : '');
  const [calPrefs, setCalPrefs] = useState(() => {
    try {
      const raw = localStorage.getItem(calPrefsKey);
      if (raw) return {
        ...CAL_PREFS_DEFAULT,
        ...JSON.parse(raw)
      };
    } catch (e) {}
    return {
      ...CAL_PREFS_DEFAULT
    };
  });
  // Persist: state + localStorage (instant, this device) + Supabase profiles.calendar_prefs (syncs across devices).
  const savePrefs = patch => {
    const next = {
      ...calPrefs,
      ...patch
    };
    setCalPrefs(next);
    try {
      localStorage.setItem(calPrefsKey, JSON.stringify(next));
    } catch (e) {}
    ProfileDB.setCalendarPrefs(next);
  };
  const primaryTz = calPrefs.primaryTz || 'America/Chicago';
  const secondaryTz = calPrefs.secondaryTz || 'Asia/Manila';
  const showSecondaryTz = !!calPrefs.secondaryTzEnabled;
  const isHidden = id => (calPrefs.hidden || []).includes(id);
  // Load the connected account's calendar list once (empty until the edge fn supports it / connected).
  useEffect(() => {
    let c = false;
    fetchCalendarList().then(list => {
      if (!c) setCalList(list || []);
    }).catch(() => {});
    return () => {
      c = true;
    };
  }, []);

  // ── Event create / edit / delete ──
  const [editing, setEditing] = useState(null); // null | { mode:'create'|'edit', ...form }
  const [savingEvent, setSavingEvent] = useState(false);
  const [eventErr, setEventErr] = useState('');
  const [confirmDel, setConfirmDel] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  // Calendars the user can write to (owner/writer). If the edge fn didn't report accessRole, fall back to all.
  const writableCals = (() => {
    const flagged = calList.filter(c => c.canWrite === true);
    if (flagged.length) return flagged;
    if (calList.some(c => typeof c.canWrite === 'boolean')) return calList.filter(c => c.primary && c.canWrite === true);
    return calList;
  })();
  const isWritable = id => writableCals.some(c => c.id === id);
  const K = dark ? {
    pop: '#070F1E',
    bd: '#152545',
    bd2: '#0D1E3A',
    shadow: '0 6px 22px rgba(0,0,0,.5)',
    navBg: '#040C1C',
    date: '#fff',
    tBtnTx: '#5AA0E6',
    tBtnBg: '#0C1830',
    tBtnBd: '#22324A',
    npBg: '#0C1830',
    npBd: '#22324A',
    npIc: 'rgba(255,255,255,.4)',
    sep: '#22324A',
    gold: '#C9A45A',
    circBd: 'rgba(255,255,255,.3)',
    doneBg: '#0F6E56',
    doneName: 'rgba(255,255,255,.35)',
    prioName: '#9FC0F0',
    reg: 'rgba(255,255,255,.55)',
    chipBd: '#22324A',
    chipBg: '#0C1830',
    chipIc: 'rgba(255,255,255,.4)',
    goldBd: '#3A2E14',
    goldBg: '#1E1808',
    segBg: '#0C1830',
    segTx: 'rgba(255,255,255,.4)',
    segABg: '#152545',
    segATx: '#fff',
    taskBg: '#0A1730',
    cellBd: '#0D1E3A',
    muted: 'rgba(255,255,255,.25)',
    rowBd: '#0D1E3A',
    dueOver: '#E07A7A',
    dueToday: '#C9A45A',
    dueUp: 'rgba(255,255,255,.35)',
    tzBg: '#040C1C',
    tx: '#5AA0E6',
    ph: '#C9A45A',
    dayLetter: 'rgba(255,255,255,.4)',
    weekend: 'rgba(255,255,255,.25)',
    dot: '#C9A45A',
    todBg: '#0A1E44',
    circBg: '#152545',
    circTx: '#fff',
    slot: '#0D1E3A',
    gline: '#0D1E3A',
    evNavyBd: '#3F6FA8',
    evNavyBg: '#1A2A3A',
    evGoldBd: '#C9A45A',
    evGoldBg: '#2A1F0A',
    evTitle: '#fff',
    evTime: 'rgba(255,255,255,.5)',
    weekTodayCol: 'rgba(201,164,90,.06)',
    weekendCell: '#0A1322',
    cellBg: '#070F1E',
    monthBd: '#152545',
    todCellBg: '#0A1E44',
    todCellBd: '#3A2E14',
    dotEvent: '#C9A45A',
    dotTask: '#3F6FA8'
  } : {
    pop: '#fff',
    bd: '#EDE7DC',
    bd2: '#EDE7DC',
    shadow: '0 6px 22px rgba(0,26,74,.1)',
    navBg: '#fff',
    date: '#001A4A',
    tBtnTx: '#185FA5',
    tBtnBg: '#EEF3FB',
    tBtnBd: '#C5D8F0',
    npBg: '#FCFBF8',
    npBd: '#E4DFD4',
    npIc: '#6B6B6B',
    sep: '#E4DFD4',
    gold: '#AD832F',
    circBd: '#C4B9A8',
    doneBg: '#0F6E56',
    doneName: '#B4B2A9',
    prioName: '#001A4A',
    reg: '#6B7280',
    chipBd: '#E4DFD4',
    chipBg: '#FCFBF8',
    chipIc: '#6B6B6B',
    goldBd: '#E8D9BC',
    goldBg: '#F3EBDA',
    segBg: '#F0EBE3',
    segTx: '#888',
    segABg: '#001A4A',
    segATx: '#fff',
    taskBg: '#FDFAF5',
    cellBd: '#F0EBE3',
    muted: '#B4B2A9',
    rowBd: '#F5F2EE',
    dueOver: '#9B1C1C',
    dueToday: '#AD832F',
    dueUp: '#B4B2A9',
    tzBg: '#FCFBF8',
    tx: '#185FA5',
    ph: '#AD832F',
    dayLetter: '#B4B2A9',
    weekend: '#D4D0CC',
    dot: '#AD832F',
    todBg: '#F3EBDA',
    circBg: '#001A4A',
    circTx: '#fff',
    slot: '#F0EBE3',
    gline: '#F5F2EE',
    evNavyBd: '#001A4A',
    evNavyBg: '#EEF2F8',
    evGoldBd: '#AD832F',
    evGoldBg: '#FDF8F0',
    evTitle: '#001A4A',
    evTime: '#6B6B6B',
    weekTodayCol: '#FBF8F2',
    weekendCell: '#FAFAF8',
    cellBg: '#fff',
    monthBd: '#F0EBE3',
    todCellBg: '#F3EBDA',
    todCellBd: '#E8D9BC',
    dotEvent: '#AD832F',
    dotTask: '#001A4A'
  };

  // ── data ──
  useEffect(() => {
    let cancelled = false;
    setGcal('loading');
    let tMin, tMax;
    if (view === 'month') {
      tMin = mondayOf(new Date(anchor.getFullYear(), anchor.getMonth(), 1));
      tMax = addDays(tMin, 42);
    } else if (view === 'week') {
      tMin = mondayOf(anchor);
      tMax = addDays(tMin, 7);
    } else {
      tMin = new Date(anchor);
      tMin.setHours(0, 0, 0, 0);
      tMax = addDays(tMin, 1);
    }
    // Two independent feeds: the caller's PERSONAL calendars (needs their Google connect)
    // and the shared Team Calendar via the service account (always works). Merge them so the
    // team OOO ribbon shows even when the personal connection is down — dedupe by id in case
    // the personal feed also returned the team calendar.
    const personalP = fetchGoogleEvents(tMin.toISOString(), tMax.toISOString(), calList.map(c => c.id)).then(list => ({
      ok: true,
      list: list || []
    })).catch(err => ({
      ok: false,
      code: err && err.code
    }));
    const teamP = fetchTeamEvents(tMin.toISOString(), tMax.toISOString());
    Promise.all([personalP, teamP]).then(([p, team]) => {
      if (cancelled) return;
      const teamIds = new Set((team || []).map(e => e.id));
      const personalList = (p.ok ? p.list : []).filter(e => !teamIds.has(e.id));
      setGevents(personalList.concat(team || []));
      // Ribbon shows regardless; gcal state still reflects the PERSONAL connection so the
      // day/week grid can prompt a connect when that's what's missing.
      setGcal(p.ok ? 'ready' : p.code === 'needs_connect' ? 'needs_connect' : 'error');
    });
    return () => {
      cancelled = true;
    };
  }, [view, anchor, calList, reloadKey]);
  useEffect(() => {
    let c = false;
    TaskDB.loadAll().then(d => {
      if (!c && d) {
        setTasks(d.tasks || []);
        setPeopleByTask(d.peopleByTask || {});
      }
    }).catch(() => {});
    ProfileDB.loadAll().then(ps => {
      if (!c && ps) {
        const m = {};
        ps.forEach(p => {
          m[p.id] = ((p.first_name || '') + ' ' + (p.last_name || '')).trim() || p.email || 'User';
        });
        setRoster(m);
        // Adopt this user's synced calendar prefs (cross-device) over the local cache, if present.
        const mine = user && ps.find(p => p.id === user.id);
        if (mine && mine.calendar_prefs && typeof mine.calendar_prefs === 'object') {
          const cp = {
            ...CAL_PREFS_DEFAULT,
            ...mine.calendar_prefs
          };
          setCalPrefs(cp);
          try {
            localStorage.setItem(calPrefsKey, JSON.stringify(cp));
          } catch (e) {}
        }
      }
    }).catch(() => {});
    return () => {
      c = true;
    };
  }, []);

  // ── timezone helpers (TX=Austin/America-Chicago, PH=Manila/Asia-Manila, live) ──
  const tzOffMin = (date, tz) => {
    const f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
    const m = {};
    f.formatToParts(date).forEach(p => m[p.type] = p.value);
    return (Date.UTC(+m.year, +m.month - 1, +m.day, +m.hour, +m.minute, +m.second) - date.getTime()) / 60000;
  };
  // The instant at wall-clock hour `h` on date `d` in zone `tz` (rail anchors to the PRIMARY zone).
  const tzInstant = (d, h, tz) => {
    const off = tzOffMin(new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), h)), tz);
    return new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), h) - off * 60000);
  };
  const fmtHour = (inst, tz) => new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour: 'numeric',
    hour12: true
  }).format(inst);
  const fmtClock = (inst, tz) => new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  }).format(inst);
  // Wall-clock hour (as a float, e.g. 9.5) of `inst` in zone `tz` — used to position events.
  const tzFloat = (inst, tz) => {
    const f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    });
    const m = {};
    f.formatToParts(inst).forEach(p => m[p.type] = p.value);
    return +m.hour % 24 + +m.minute / 60;
  };
  // 'YYYY-MM-DD' / 'HH:mm' of an instant as read in zone `tz` (for prefilling the event form's date/time inputs).
  const dateInTz = (inst, tz) => {
    const m = {};
    new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).formatToParts(inst).forEach(p => m[p.type] = p.value);
    return m.year + '-' + m.month + '-' + m.day;
  };
  const timeInTz = (inst, tz) => {
    const m = {};
    new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    }).formatToParts(inst).forEach(p => m[p.type] = p.value);
    return (m.hour === '24' ? '00' : m.hour) + ':' + m.minute;
  };
  const rruleToSimple = rec => {
    const r = (rec || []).find(x => /^RRULE:/.test(x)) || '';
    if (/FREQ=DAILY/.test(r)) return 'daily';
    if (/FREQ=WEEKLY/.test(r)) return 'weekly';
    if (/FREQ=MONTHLY/.test(r)) return 'monthly';
    return 'none';
  };
  const setF = patch => setEditing(prev => ({
    ...prev,
    ...patch
  }));
  // Open the form to create a new event (defaults: the focused day, next round hour).
  const openCreate = day => {
    const d = day || anchor;
    let h = sameDay(d, todayD) ? Math.floor(tzFloat(new Date(), primaryTz)) + 1 : 9;
    if (h > 22 || h < 6) h = 9;
    const hh = String(h).padStart(2, '0');
    const eh = String((h + 1) % 24).padStart(2, '0');
    setEventErr('');
    setConfirmDel(false);
    setEditing({
      mode: 'create',
      eventId: null,
      calendarId: (writableCals[0] || {}).id || 'primary',
      title: '',
      allDay: false,
      date: isoOf(d),
      endDate: isoOf(d),
      start: hh + ':00',
      end: eh + ':00',
      location: '',
      notes: '',
      guests: '',
      repeat: 'none',
      readOnly: false,
      recurring: false
    });
  };
  // Open the form to edit/delete an existing event (the raw gevents object).
  const openEdit = ev => {
    if (!ev) return;
    const s = ev.start ? new Date(ev.start) : new Date();
    const e = ev.end ? new Date(ev.end) : s;
    const allDay = !!ev.allDay;
    const writable = ev.calendarId ? isWritable(ev.calendarId) : true;
    setEventErr('');
    setConfirmDel(false);
    setEditing({
      mode: 'edit',
      eventId: ev.id,
      calendarId: ev.calendarId || 'primary',
      title: ev.title === '(no title)' ? '' : ev.title || '',
      allDay,
      date: allDay ? (ev.start || '').slice(0, 10) : dateInTz(s, primaryTz),
      // Google all-day end is exclusive → show the inclusive last day.
      endDate: allDay ? isoOf(addDays(new Date((ev.end || ev.start || '').slice(0, 10) + 'T00:00:00'), -1)) : dateInTz(e, primaryTz),
      start: allDay ? '09:00' : timeInTz(s, primaryTz),
      end: allDay ? '10:00' : timeInTz(e, primaryTz),
      location: ev.location || '',
      notes: ev.description || '',
      guests: (ev.attendees || []).join(', '),
      repeat: rruleToSimple(ev.recurrence),
      recurring: !!(ev.recurrence || ev.recurringEventId),
      readOnly: !writable
    });
  };
  // Build the Google event resource from the form. Times are sent with the primary zone so Google reads them right.
  const buildEventBody = f => {
    const edit = f.mode === 'edit';
    const ev = {
      summary: (f.title || '').trim() || '(no title)'
    };
    // On edit, send '' / [] to actively CLEAR — a PATCH leaves omitted keys unchanged. On create, omit empties.
    const loc = (f.location || '').trim();
    const desc = (f.notes || '').trim();
    if (loc || edit) ev.location = loc;
    if (desc || edit) ev.description = desc;
    if (f.allDay) {
      const endIncl = f.endDate && f.endDate >= f.date ? f.endDate : f.date;
      ev.start = {
        date: f.date
      };
      ev.end = {
        date: isoOf(addDays(new Date(endIncl + 'T00:00:00'), 1))
      }; // end date is exclusive
    } else {
      const endDate = f.endDate && f.endDate >= f.date ? f.endDate : f.date;
      ev.start = {
        dateTime: f.date + 'T' + f.start + ':00',
        timeZone: primaryTz
      };
      ev.end = {
        dateTime: endDate + 'T' + f.end + ':00',
        timeZone: primaryTz
      };
    }
    const guests = (f.guests || '').split(/[,;\s]+/).map(s => s.replace(/[<>]/g, '').trim()).filter(s => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s));
    if (guests.length || edit) ev.attendees = guests.map(email => ({
      email
    })); // [] removes all guests on edit
    // Only manage recurrence for non-recurring events. (Changing an existing series' rule is done in Google.)
    if (!f.recurring) {
      if (f.repeat && f.repeat !== 'none') ev.recurrence = ['RRULE:FREQ=' + (f.repeat === 'daily' ? 'DAILY' : f.repeat === 'weekly' ? 'WEEKLY' : 'MONTHLY')];else if (edit) ev.recurrence = [];
    }
    return ev;
  };
  const submitEvent = async () => {
    const f = editing;
    if (!f || f.readOnly) return;
    if (!f.allDay) {
      if (!/^\d{2}:\d{2}$/.test(f.start || '') || !/^\d{2}:\d{2}$/.test(f.end || '')) {
        setEventErr('Please set a start and end time.');
        return;
      }
      const effEnd = f.endDate && f.endDate >= f.date ? f.endDate : f.date; // matches buildEventBody's clamp
      if (effEnd === f.date) {
        const sMin = +f.start.slice(0, 2) * 60 + +f.start.slice(3, 5);
        const eMin = +f.end.slice(0, 2) * 60 + +f.end.slice(3, 5);
        if (eMin <= sMin) {
          setEventErr('End time must be after the start time.');
          return;
        }
      }
    }
    setSavingEvent(true);
    setEventErr('');
    try {
      await saveGoogleEvent({
        mode: f.mode,
        calendarId: f.calendarId,
        eventId: f.eventId,
        event: buildEventBody(f)
      });
      setEditing(null);
      setReloadKey(k => k + 1);
    } catch (err) {
      const code = err && err.code,
        msg = err && err.message;
      setEventErr(code === 'needs_connect' ? 'Reconnect your Google account in Settings, then try again.' : msg && msg !== 'save_failed' ? msg : 'Could not save — please try again.');
    } finally {
      setSavingEvent(false);
    }
  };
  const removeEvent = async () => {
    const f = editing;
    if (!f || f.mode !== 'edit') return;
    setSavingEvent(true);
    setEventErr('');
    try {
      await deleteGoogleEvent(f.calendarId, f.eventId);
      setEditing(null);
      setConfirmDel(false);
      setReloadKey(k => k + 1);
    } catch (err) {
      setEventErr('Could not delete — please try again.');
      setConfirmDel(false);
    } finally {
      setSavingEvent(false);
    }
  };

  // ── task + event helpers ──
  const dueMs = t => t.due_at ? new Date(t.due_at).getTime() : Infinity;
  const topTasks = n => (tasks || []).filter(t => t.status !== 'done').sort((a, b) => dueMs(a) - dueMs(b)).slice(0, n);
  const allTasksSorted = () => (tasks || []).slice().sort((a, b) => (a.status === 'done' ? 1 : 0) - (b.status === 'done' ? 1 : 0) || dueMs(a) - dueMs(b));
  // Top tasks = the W/D priorities: daily rank in Day view, weekly rank in Week view (1/2/3).
  const prioTasks = () => {
    if (view === 'week') {
      const wk = isoOf(mondayOf(anchor));
      return (tasks || []).filter(t => t.weekly_priority && String(t.weekly_priority).slice(0, 10) === wk && t.weekly_rank).sort((a, b) => a.weekly_rank - b.weekly_rank).slice(0, 3);
    }
    const dy = isoOf(anchor);
    return (tasks || []).filter(t => t.daily_priority && String(t.daily_priority).slice(0, 10) === dy && t.daily_rank).sort((a, b) => a.daily_rank - b.daily_rank).slice(0, 3);
  };
  const dueInfo = t => {
    if (!t.due_at) return {
      label: '',
      color: K.dueUp
    };
    const d = new Date(t.due_at);
    const t0 = new Date(todayD);
    t0.setHours(0, 0, 0, 0);
    const d0 = new Date(d);
    d0.setHours(0, 0, 0, 0);
    if (d0.getTime() === t0.getTime()) return {
      label: 'Today',
      color: K.dueToday
    };
    if (d0 < t0) return {
      label: d.toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric'
      }),
      color: K.dueOver
    };
    return {
      label: d.toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric'
      }),
      color: K.dueUp
    };
  };
  const calColor = id => {
    const c = calList.find(x => x.id === id);
    return c && c.color || null;
  };
  // Event block fill/border — tinted from the calendar's own color when known, else the gold/navy default.
  const evBg = e => e.color && e.color[0] === '#' && e.color.length === 7 ? e.color + (dark ? '2E' : '1A') : e.gold ? K.evGoldBg : K.evNavyBg;
  const evBd = e => e.color && e.color[0] === '#' ? e.color : e.gold ? K.evGoldBd : K.evNavyBd;
  const visEvents = () => (gevents || []).filter(e => !e.calendarId || !isHidden(e.calendarId));
  const dayEvents = day => visEvents().filter(e => e.start && !e.allDay && sameDay(new Date(e.start), day)).map(e => ({
    title: e.title || '(busy)',
    start: new Date(e.start),
    end: e.end ? new Date(e.end) : null,
    color: e.color || calColor(e.calendarId),
    gold: e.colorId === '5' || e.colorId === '6',
    raw: e
  }));
  const hasEvents = day => visEvents().some(e => e.start && (e.allDay ? (e.start || '').slice(0, 10) === isoOf(day) : sameDay(new Date(e.start), day)));
  // Side-by-side column layout for time-overlapping events (incl. the same event from two
  // calendars) so they sit next to each other instead of stacking on top of one another.
  // Returns { [index]: { col, n } } — col = which column, n = columns in that overlap cluster.
  const layoutDayEvents = evs => {
    const endMs = e => e.end ? Math.max(e.end.getTime(), e.start.getTime() + 18e5) : e.start.getTime() + 27e5; // ≥30m, default 45m
    const items = evs.map((e, i) => ({
      i,
      s: e.start.getTime(),
      en: endMs(e)
    })).sort((a, b) => a.s - b.s || a.en - b.en);
    const out = {};
    let cluster = [],
      clusterEnd = -Infinity;
    const flush = () => {
      if (!cluster.length) return;
      const cols = []; // cols[c] = last end time placed in column c
      cluster.forEach(it => {
        let c = 0;
        for (; c < cols.length; c++) {
          if (it.s >= cols[c]) break;
        }
        cols[c] = it.en;
        it.col = c;
      });
      cluster.forEach(it => {
        out[it.i] = {
          col: it.col,
          n: cols.length
        };
      });
      cluster = [];
      clusterEnd = -Infinity;
    };
    items.forEach(it => {
      if (cluster.length && it.s >= clusterEnd) flush();
      cluster.push(it);
      clusterEnd = Math.max(clusterEnd, it.en);
    });
    flush();
    return out;
  };
  const monthHasEvent = day => hasEvents(day);
  const monthHasTask = day => (tasks || []).some(t => t.due_at && sameDay(new Date(t.due_at), day));

  // ── decisions (a decision = any task carrying decision data) ──
  const nameOf = id => roster[id] || '—';
  const roleNames = (tid, role) => (peopleByTask[tid] || []).filter(p => p.role === role).map(p => nameOf(p.user_id)).filter(n => n && n !== '—').join(', ');
  const decisionTasks = () => (tasks || []).filter(t => t.decision_question || t.decision_due_at || (peopleByTask[t.id] || []).some(p => p.role === 'decision_maker'));
  const decDueInfo = t => {
    if (!t.decision_due_at) return null;
    const d = new Date(t.decision_due_at);
    const t0 = new Date(todayD);
    t0.setHours(0, 0, 0, 0);
    const d0 = new Date(d);
    d0.setHours(0, 0, 0, 0);
    const f = t.decision_due_has_time ? d.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit'
    }) : d.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric'
    });
    if (d0.getTime() === t0.getTime()) return {
      label: t.decision_due_has_time ? f : 'Today',
      color: K.dueToday
    };
    if (d0 < t0) return {
      label: f,
      color: K.dueOver
    };
    return {
      label: f,
      color: K.dueUp
    };
  };
  useEffect(() => {
    if (!decOpen) return;
    let c = false;
    decisionTasks().forEach(t => {
      if (decData[t.id] && decData[t.id].loaded) return;
      Promise.all([TaskDB.loadDecisionOptions(t.id), TaskDB.loadActivity(t.id)]).then(([opts, act]) => {
        if (!c) setDecData(prev => ({
          ...prev,
          [t.id]: {
            options: opts || [],
            comments: (act || []).filter(a => a.kind === 'update'),
            loaded: true
          }
        }));
      }).catch(() => {});
    });
    return () => {
      c = true;
    };
  }, [decOpen, tasks, peopleByTask]);
  const chooseOption = async (taskId, idx) => {
    const d = decData[taskId];
    if (!d) return;
    const opts = d.options.map((o, i) => ({
      ...o,
      is_chosen: i === idx ? !o.is_chosen : false
    }));
    setDecData(prev => ({
      ...prev,
      [taskId]: {
        ...prev[taskId],
        options: opts
      }
    }));
    try {
      await TaskDB.setDecisionOptions(taskId, opts.map(o => ({
        body: o.body,
        is_chosen: o.is_chosen
      })));
    } catch (e) {}
  };
  const addComment = async taskId => {
    const text = (decDraft[taskId] || '').trim();
    if (!text || !user) return;
    setDecDraft(prev => ({
      ...prev,
      [taskId]: ''
    }));
    try {
      await TaskDB.addActivity(taskId, 'update', text, user);
      const act = await TaskDB.loadActivity(taskId);
      setDecData(prev => ({
        ...prev,
        [taskId]: {
          ...(prev[taskId] || {}),
          comments: (act || []).filter(a => a.kind === 'update')
        }
      }));
    } catch (e) {}
  };
  const goToday = () => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    setAnchor(d);
  };
  const step = dir => setAnchor(a => view === 'month' ? new Date(a.getFullYear(), a.getMonth() + dir, 1) : addDays(a, dir * (view === 'week' ? 7 : 1)));
  const dateLabel = () => {
    if (view === 'day') return anchor.toLocaleDateString('en-US', {
      weekday: 'long',
      month: 'short',
      day: 'numeric'
    });
    if (view === 'week') {
      const s = mondayOf(anchor),
        e = addDays(s, 6);
      return s.toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric'
      }) + ' – ' + e.toLocaleDateString('en-US', {
        day: 'numeric'
      }) + ', ' + e.getFullYear();
    }
    return anchor.toLocaleDateString('en-US', {
      month: 'long',
      year: 'numeric'
    });
  };
  const stripDays = [];
  {
    const s = mondayOf(anchor);
    for (let i = 0; i < 7; i++) stripDays.push(addDays(s, i));
  }
  const GUTTER_W = 56; // the TZ rail width shared by taskStrip/dateStrip/dayGrid/weekGrid/team-lane
  const HOURS = [];
  for (let h = 0; h < 24; h++) HOURS.push(h);
  const SL = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
  const DL2 = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];
  useEffect(() => {
    if (scrollRef.current && view !== 'month') scrollRef.current.scrollTop = 7 * (view === 'week' ? 44 : 48);
  }, [view, anchor]);
  const circle = (t, sz) => {
    const done = t.status === 'done';
    const sc = statusColor(t.status);
    return /*#__PURE__*/React.createElement("div", {
      style: {
        width: sz,
        height: sz,
        borderRadius: '50%',
        flexShrink: 0,
        border: `1.5px solid ${done ? K.doneBg : sc}`,
        background: done ? K.doneBg : t.status === 'in_progress' ? dark ? 'rgba(24,95,165,0.20)' : '#EEF3FB' : 'transparent',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center'
      }
    }, done && /*#__PURE__*/React.createElement("i", {
      className: "ti ti-check",
      style: {
        fontSize: sz - 5,
        color: '#fff'
      }
    }));
  };
  const navChip = (icon, gold, onClick) => /*#__PURE__*/React.createElement("button", {
    onClick: onClick,
    style: {
      width: 22,
      height: 22,
      flexShrink: 0,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: 6,
      border: `0.5px solid ${gold ? K.goldBd : K.chipBd}`,
      background: gold ? K.goldBg : K.chipBg,
      cursor: 'pointer',
      padding: 0
    }
  }, /*#__PURE__*/React.createElement("i", {
    className: 'ti ' + icon,
    style: {
      fontSize: 11,
      color: gold ? K.gold : K.chipIc
    }
  }));
  const sep = /*#__PURE__*/React.createElement("div", {
    style: {
      width: 1,
      height: 15,
      background: K.sep,
      flexShrink: 0
    }
  });
  const connectBar = /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 8,
      padding: '5px 12px',
      borderBottom: `0.5px solid ${K.bd2}`,
      flexShrink: 0
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: J,
      fontSize: 9,
      color: K.muted
    }
  }, "Google Calendar not connected"), /*#__PURE__*/React.createElement("button", {
    onClick: () => {
      try {
        window.SupabaseAuth.connectCalendar();
      } catch (e) {}
    },
    style: {
      fontFamily: J,
      fontSize: 9,
      fontWeight: 600,
      padding: '3px 9px',
      borderRadius: 6,
      border: 'none',
      background: K.gold,
      color: '#fff',
      cursor: 'pointer'
    }
  }, "Connect"));

  // ── Section 1: nav bar (horizontally scrollable so nothing clips on phone width) ──
  const navBar = /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 5,
      padding: '7px 10px',
      borderBottom: `0.5px solid ${K.bd2}`,
      background: K.navBg,
      flexShrink: 0,
      overflowX: 'auto'
    }
  }, /*#__PURE__*/React.createElement("button", {
    onClick: goToday,
    style: {
      flexShrink: 0,
      fontFamily: J,
      fontSize: 9,
      fontWeight: 600,
      color: K.tBtnTx,
      background: K.tBtnBg,
      border: `0.5px solid ${K.tBtnBd}`,
      borderRadius: 6,
      padding: '3px 8px',
      cursor: 'pointer'
    }
  }, "Today"), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexShrink: 0
    }
  }, /*#__PURE__*/React.createElement("button", {
    onClick: () => step(-1),
    style: {
      width: 20,
      height: 20,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: K.npBg,
      border: `0.5px solid ${K.npBd}`,
      borderRight: 'none',
      borderRadius: '4px 0 0 4px',
      cursor: 'pointer',
      padding: 0
    }
  }, /*#__PURE__*/React.createElement("i", {
    className: "ti ti-chevron-left",
    style: {
      fontSize: 11,
      color: K.npIc
    }
  })), /*#__PURE__*/React.createElement("button", {
    onClick: () => step(1),
    style: {
      width: 20,
      height: 20,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: K.npBg,
      border: `0.5px solid ${K.npBd}`,
      borderRadius: '0 4px 4px 0',
      cursor: 'pointer',
      padding: 0
    }
  }, /*#__PURE__*/React.createElement("i", {
    className: "ti ti-chevron-right",
    style: {
      fontSize: 11,
      color: K.npIc
    }
  }))), /*#__PURE__*/React.createElement("span", {
    onClick: () => {
      const el = dateInputRef.current;
      if (!el) return;
      if (el.showPicker) el.showPicker();else el.focus();
    },
    style: {
      flexShrink: 0,
      fontFamily: J,
      fontSize: 11,
      fontWeight: 600,
      color: K.date,
      cursor: 'pointer',
      whiteSpace: 'nowrap'
    }
  }, dateLabel()), /*#__PURE__*/React.createElement("input", {
    ref: dateInputRef,
    type: "date",
    value: isoOf(anchor),
    onChange: e => {
      if (!e.target.value) return;
      const [y, m, d] = e.target.value.split('-').map(Number);
      setAnchor(new Date(y, m - 1, d));
    },
    style: {
      position: 'absolute',
      width: 1,
      height: 1,
      opacity: 0,
      pointerEvents: 'none'
    }
  }), sep, navChip('ti-search', false, () => {}), navChip('ti-settings-2', true, () => setShowSettings(true)), navChip('ti-plus', true, () => openCreate()), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      background: K.segBg,
      borderRadius: 6,
      padding: 2,
      gap: 1,
      flexShrink: 0
    }
  }, ['day', 'week', 'month'].map(v => /*#__PURE__*/React.createElement("button", {
    key: v,
    onClick: () => setView(v),
    style: {
      fontFamily: J,
      fontSize: 7.5,
      fontWeight: 600,
      padding: '3px 6px',
      borderRadius: 4,
      border: 'none',
      cursor: 'pointer',
      textTransform: 'capitalize',
      background: v === view ? K.segABg : 'transparent',
      color: v === view ? K.segATx : K.segTx
    }
  }, v))));

  // ── Section 2: task strip (Day + Week only) ──
  const prios = prioTasks();
  const prioIds = {};
  prios.forEach(t => {
    prioIds[t.id] = true;
  });
  const expandedTasks = prios.concat(allTasksSorted().filter(t => !prioIds[t.id]));
  const taskColor = t => t.status === 'done' ? K.doneName : prioIds[t.id] ? K.prioName : K.reg;
  const taskWeight = t => prioIds[t.id] && t.status !== 'done' ? 700 : 500;
  const taskStrip = /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    onClick: () => setTasksOpen(o => !o),
    style: {
      display: 'flex',
      background: tasksOpen ? K.navBg : K.taskBg,
      borderBottom: `0.5px solid ${K.bd2}`,
      cursor: 'pointer',
      flexShrink: 0
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: GUTTER_W,
      flexShrink: 0,
      background: K.tzBg,
      borderRight: `0.5px solid ${K.bd2}`,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: J,
      fontSize: 7,
      fontWeight: 700,
      letterSpacing: '0.1em',
      textTransform: 'uppercase',
      color: K.gold
    }
  }, "tasks")), tasksOpen ? /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      display: 'flex',
      alignItems: 'center',
      padding: '7px 10px'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: J,
      fontSize: 9,
      fontStyle: 'italic',
      color: K.muted
    }
  }, "All tasks")) : prios.length > 0 ? [0, 1, 2].map(i => {
    const t = prios[i];
    return /*#__PURE__*/React.createElement("div", {
      key: i,
      onClick: t ? e => {
        e.stopPropagation();
        onOpenTask && onOpenTask(t);
      } : undefined,
      style: {
        flex: 1,
        minWidth: 0,
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '7px 10px',
        borderRight: i < 2 ? `0.5px solid ${K.cellBd}` : 'none'
      }
    }, t && circle(t, 13), t && /*#__PURE__*/React.createElement("span", {
      style: {
        fontFamily: J,
        fontSize: 9,
        fontWeight: taskWeight(t),
        color: taskColor(t),
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        textDecoration: t.status === 'done' ? 'line-through' : 'none'
      }
    }, t.title));
  }) : /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      display: 'flex',
      alignItems: 'center',
      padding: '7px 10px'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: J,
      fontSize: 9,
      fontStyle: 'italic',
      color: K.muted
    }
  }, "No priorities set \u2014 tap for all tasks")), /*#__PURE__*/React.createElement("div", {
    style: {
      width: 32,
      flexShrink: 0,
      borderLeft: `0.5px solid ${K.cellBd}`,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center'
    }
  }, /*#__PURE__*/React.createElement("i", {
    className: 'ti ' + (tasksOpen ? 'ti-chevron-up' : 'ti-chevron-down'),
    style: {
      fontSize: 12,
      color: tasksOpen ? K.gold : K.muted
    }
  }))), tasksOpen && /*#__PURE__*/React.createElement("div", {
    style: {
      flexShrink: 0,
      maxHeight: 200,
      overflowY: 'auto',
      borderBottom: `0.5px solid ${K.bd2}`
    }
  }, expandedTasks.map((t, i, arr) => {
    const di = dueInfo(t);
    const isP = prioIds[t.id];
    return /*#__PURE__*/React.createElement("div", {
      key: t.id,
      onClick: () => onOpenTask && onOpenTask(t),
      style: {
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '7px 12px 7px 65px',
        borderLeft: `3px solid ${isP ? K.prioName : 'transparent'}`,
        borderBottom: i < arr.length - 1 ? `0.5px solid ${K.rowBd}` : 'none',
        cursor: 'pointer'
      }
    }, circle(t, 13), /*#__PURE__*/React.createElement("span", {
      style: {
        flex: 1,
        minWidth: 0,
        fontFamily: J,
        fontSize: 9.5,
        fontWeight: taskWeight(t),
        color: taskColor(t),
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        textDecoration: t.status === 'done' ? 'line-through' : 'none'
      }
    }, t.title), di.label && /*#__PURE__*/React.createElement("span", {
      style: {
        flexShrink: 0,
        fontFamily: J,
        fontSize: 8,
        fontWeight: 600,
        color: di.color
      }
    }, di.label));
  }), expandedTasks.length === 0 && /*#__PURE__*/React.createElement("div", {
    style: {
      padding: '10px 12px 10px 68px',
      fontFamily: J,
      fontSize: 9,
      color: K.muted
    }
  }, "No tasks yet.")));

  // ── Section 3: date strip (Day + Week) ──
  // ── Decisions strip (Day + Week) — its own prominent feed, beside Tasks ──
  const decs = decisionTasks();
  const decIcon = /*#__PURE__*/React.createElement("svg", {
    width: "13",
    height: "13",
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "2.2",
    strokeLinecap: "round",
    strokeLinejoin: "round"
  }, /*#__PURE__*/React.createElement("path", {
    d: "M12 4v6"
  }), /*#__PURE__*/React.createElement("path", {
    d: "M9 7l3-3 3 3"
  }), /*#__PURE__*/React.createElement("path", {
    d: "M4 13l-2 2 2 2"
  }), /*#__PURE__*/React.createElement("path", {
    d: "M2 15h7"
  }), /*#__PURE__*/React.createElement("path", {
    d: "M20 13l2 2-2 2"
  }), /*#__PURE__*/React.createElement("path", {
    d: "M22 15h-7"
  }));
  const statusPill = st => /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: J,
      fontSize: 7,
      fontWeight: 700,
      padding: '2px 6px',
      borderRadius: 10,
      background: statusBg(st),
      color: statusColor(st),
      flexShrink: 0
    }
  }, statusLabel(st));
  const decCard = t => {
    const d = decData[t.id] || {};
    const dd = decDueInfo(t);
    const maker = roleNames(t.id, 'decision_maker');
    const asg = roleNames(t.id, 'assignee');
    const extra = t.description || '';
    return /*#__PURE__*/React.createElement("div", {
      key: t.id,
      style: {
        borderBottom: `0.5px solid ${K.rowBd}`,
        padding: '9px 12px'
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        display: 'flex',
        alignItems: 'center',
        gap: 8
      }
    }, /*#__PURE__*/React.createElement("span", {
      onClick: () => onOpenTask && onOpenTask(t),
      style: {
        flex: 1,
        minWidth: 0,
        fontFamily: J,
        fontSize: 11,
        fontWeight: 700,
        color: K.date,
        cursor: 'pointer',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis'
      }
    }, t.title), statusPill(t.status)), /*#__PURE__*/React.createElement("div", {
      style: {
        display: 'flex',
        flexWrap: 'wrap',
        gap: 10,
        marginTop: 5
      }
    }, maker && /*#__PURE__*/React.createElement("span", {
      style: {
        fontFamily: J,
        fontSize: 8.5,
        color: K.reg
      }
    }, /*#__PURE__*/React.createElement("b", {
      style: {
        color: K.gold
      }
    }, "Maker:"), " ", maker), dd && /*#__PURE__*/React.createElement("span", {
      style: {
        fontFamily: J,
        fontSize: 8.5,
        fontWeight: 600,
        color: dd.color
      }
    }, "Decide by ", dd.label), asg && /*#__PURE__*/React.createElement("span", {
      style: {
        fontFamily: J,
        fontSize: 8.5,
        color: K.reg
      }
    }, "Assignee: ", asg)), t.context && /*#__PURE__*/React.createElement("div", {
      style: {
        fontFamily: J,
        fontSize: 8.5,
        color: K.reg,
        lineHeight: 1.5,
        marginTop: 4,
        whiteSpace: 'pre-wrap'
      }
    }, /*#__PURE__*/React.createElement("b", {
      style: {
        color: K.gold
      }
    }, "Context:"), " ", t.context), t.decision_question && /*#__PURE__*/React.createElement("div", {
      style: {
        fontFamily: J,
        fontSize: 10.5,
        fontWeight: 600,
        color: K.date,
        margin: '8px 0 6px',
        lineHeight: 1.4
      }
    }, t.decision_question), (d.options || []).map((o, i) => /*#__PURE__*/React.createElement("div", {
      key: o.id || i,
      onClick: () => chooseOption(t.id, i),
      style: {
        display: 'flex',
        alignItems: 'center',
        gap: 7,
        padding: '5px 8px',
        marginBottom: 4,
        borderRadius: 7,
        cursor: 'pointer',
        background: o.is_chosen ? dark ? 'rgba(15,110,86,.18)' : '#E6F2EC' : dark ? '#0C1830' : '#FAF8F3',
        border: `1px solid ${o.is_chosen ? dark ? '#1E6B4E' : '#9FD3BC' : K.cellBd}`
      }
    }, /*#__PURE__*/React.createElement("i", {
      className: o.is_chosen ? 'ti ti-circle-check-filled' : 'ti ti-circle',
      style: {
        fontSize: 15,
        color: o.is_chosen ? dark ? '#3FB36B' : '#0F6E56' : K.muted,
        flexShrink: 0
      }
    }), /*#__PURE__*/React.createElement("span", {
      style: {
        flex: 1,
        minWidth: 0,
        fontFamily: J,
        fontSize: 9.5,
        fontWeight: o.is_chosen ? 600 : 400,
        color: K.date
      }
    }, o.body), o.is_chosen && /*#__PURE__*/React.createElement("span", {
      style: {
        fontFamily: J,
        fontSize: 6.5,
        fontWeight: 700,
        letterSpacing: '.06em',
        color: dark ? '#3FB36B' : '#0F6E56',
        flexShrink: 0
      }
    }, "CHOSEN"))), extra && /*#__PURE__*/React.createElement("div", {
      style: {
        fontFamily: J,
        fontSize: 8.5,
        color: K.reg,
        lineHeight: 1.5,
        marginTop: 4,
        whiteSpace: 'pre-wrap'
      }
    }, extra), (d.comments || []).slice(-2).map(cm => /*#__PURE__*/React.createElement("div", {
      key: cm.id,
      style: {
        display: 'flex',
        gap: 6,
        marginTop: 6
      }
    }, /*#__PURE__*/React.createElement("span", {
      style: {
        fontFamily: J,
        fontSize: 8,
        fontWeight: 700,
        color: K.gold,
        flexShrink: 0
      }
    }, (cm.author_name || 'User').split(' ')[0], ":"), /*#__PURE__*/React.createElement("span", {
      style: {
        fontFamily: J,
        fontSize: 9,
        color: K.date,
        minWidth: 0
      }
    }, cm.content))), /*#__PURE__*/React.createElement("div", {
      style: {
        display: 'flex',
        gap: 6,
        marginTop: 7
      }
    }, /*#__PURE__*/React.createElement("input", {
      value: decDraft[t.id] || '',
      onChange: e => setDecDraft(prev => ({
        ...prev,
        [t.id]: e.target.value
      })),
      onKeyDown: e => {
        if (e.key === 'Enter') {
          e.preventDefault();
          addComment(t.id);
        }
      },
      placeholder: "Add a comment\u2026",
      style: {
        flex: 1,
        minWidth: 0,
        fontFamily: J,
        fontSize: 9,
        padding: '6px 9px',
        borderRadius: 7,
        border: `1px solid ${K.cellBd}`,
        background: dark ? '#040C1C' : '#FCFBF8',
        color: K.date,
        outline: 'none'
      }
    }), /*#__PURE__*/React.createElement("button", {
      onClick: () => addComment(t.id),
      style: {
        flexShrink: 0,
        fontFamily: J,
        fontSize: 9,
        fontWeight: 600,
        padding: '0 12px',
        borderRadius: 7,
        border: 'none',
        background: K.gold,
        color: '#fff',
        cursor: 'pointer'
      }
    }, "Send")));
  };
  const decStrip = /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    onClick: () => setDecOpen(o => !o),
    style: {
      display: 'flex',
      alignItems: 'center',
      background: decOpen ? K.navBg : K.taskBg,
      borderBottom: `0.5px solid ${K.bd2}`,
      cursor: 'pointer',
      flexShrink: 0
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: 56,
      flexShrink: 0,
      background: K.tzBg,
      borderRight: `0.5px solid ${K.bd2}`,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      color: K.gold,
      padding: '7px 0'
    }
  }, decIcon), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      display: 'flex',
      alignItems: 'center',
      gap: 6,
      padding: '7px 10px'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: J,
      fontSize: 8,
      fontWeight: 700,
      letterSpacing: '0.1em',
      textTransform: 'uppercase',
      color: K.gold
    }
  }, "Decisions"), /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: J,
      fontSize: 9,
      color: K.muted
    }
  }, decs.length ? decs.length + ' open' : 'none')), /*#__PURE__*/React.createElement("div", {
    style: {
      width: 32,
      flexShrink: 0,
      borderLeft: `0.5px solid ${K.cellBd}`,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center'
    }
  }, /*#__PURE__*/React.createElement("i", {
    className: 'ti ' + (decOpen ? 'ti-chevron-up' : 'ti-chevron-down'),
    style: {
      fontSize: 12,
      color: decOpen ? K.gold : K.muted
    }
  }))), decOpen && /*#__PURE__*/React.createElement("div", {
    style: {
      flexShrink: 0,
      maxHeight: 280,
      overflowY: 'auto',
      borderBottom: `0.5px solid ${K.bd2}`
    }
  }, decs.length ? decs.map(decCard) : /*#__PURE__*/React.createElement("div", {
    style: {
      padding: '12px',
      fontFamily: J,
      fontSize: 9,
      color: K.muted,
      textAlign: 'center'
    }
  }, "No decisions yet. Add a decision on any task.")));
  const dateStrip = /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      borderBottom: `0.5px solid ${K.bd2}`,
      flexShrink: 0
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: GUTTER_W,
      flexShrink: 0,
      background: K.tzBg,
      borderRight: `0.5px solid ${K.bd2}`,
      display: 'flex',
      flexDirection: 'column',
      justifyContent: 'center',
      padding: '0 6px'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: J,
      fontSize: 9,
      fontWeight: 700,
      letterSpacing: '0.06em',
      color: K.tx
    }
  }, "TX"), showSecondaryTz && /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: J,
      fontSize: 9,
      fontWeight: 700,
      letterSpacing: '0.06em',
      color: K.ph
    }
  }, "PH")), stripDays.map((d, i) => {
    const wknd = i >= 5,
      isTod = sameDay(d, todayD),
      isSel = sameDay(d, anchor),
      hasEv = hasEvents(d);
    return /*#__PURE__*/React.createElement("div", {
      key: i,
      onClick: () => {
        setAnchor(new Date(d));
        if (view === 'month') setView('day');
      },
      style: {
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 2,
        padding: '4px 1px 5px',
        borderRight: i < 6 ? `0.5px solid ${K.gline}` : 'none',
        cursor: 'pointer',
        background: isTod ? K.todBg : isSel && view === 'day' ? dark ? 'rgba(255,255,255,.05)' : '#F7F4EE' : 'transparent'
      }
    }, /*#__PURE__*/React.createElement("span", {
      style: {
        fontFamily: J,
        fontSize: 6,
        letterSpacing: '0.1em',
        textTransform: 'uppercase',
        fontWeight: 500,
        color: isTod ? K.gold : wknd ? K.weekend : K.dayLetter
      }
    }, SL[i]), /*#__PURE__*/React.createElement("div", {
      style: {
        width: 21,
        height: 21,
        borderRadius: '50%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontFamily: J,
        fontSize: isTod ? 10 : 11,
        fontWeight: 600,
        background: isTod ? K.circBg : 'transparent',
        color: isTod ? K.circTx : wknd ? K.weekend : K.date
      }
    }, d.getDate()), /*#__PURE__*/React.createElement("div", {
      style: {
        width: 3,
        height: 3,
        borderRadius: '50%',
        background: hasEv ? K.dot : 'transparent'
      }
    }));
  }));

  // ── Section 3.5: Team All-Day Lane (Day + Week only) ──
  // Qualifies: all_day === true AND from the designated Team Events source. Deliberately
  // NOT title-based — Sales/Operations Team Huddle are TIMED events on the team calendar
  // and already render as blocks in the time grid; without the all_day gate they'd double up.
  const LANE_CATEGORY_STYLE = {
    ooo: {
      border: '#9B1C1C',
      fill: dark ? 'rgba(155,28,28,.16)' : '#F7EEEE',
      text: dark ? '#E4A0A0' : '#7C3030'
    },
    team: {
      border: '#185FA5',
      fill: dark ? 'rgba(24,95,165,.16)' : '#EAF0F8',
      text: dark ? '#8FB6DC' : '#1B4C82'
    },
    holiday: {
      border: '#0F6E56',
      fill: dark ? 'rgba(15,110,86,.16)' : '#E9F4F0',
      text: dark ? '#7FC6AF' : '#0B5744'
    }
  };
  const LANE_CATEGORY_LABEL = {
    ooo: 'Out of office',
    team: 'Team event',
    holiday: 'Holiday'
  };
  const LANE_BG = dark ? '#0A1730' : '#FCFBF8';
  // TODO: swap for a real `category` field on the event once one exists (see spec §3/§4) —
  // for now this is a calendar-source + title-keyword guess.
  const laneCategoryOf = e => {
    if (e.calendarId === 'ph#holiday@group.v.calendar.google.com' || e.calendarId === 'us#holiday@group.v.calendar.google.com') return 'holiday';
    if (/^ooo\b|out of office/i.test(e.title || '')) return 'ooo';
    return 'team';
  };
  // True (uncapped) start/end Date objects for an all-day event. Google's all-day `end`
  // date is EXCLUSIVE — one day past the last included day — so the true last day is end-1.
  const laneTrueStart = e => new Date((e.start || '').slice(0, 10) + 'T00:00:00');
  const laneTrueEnd = e => addDays(new Date((e.end || e.start || '').slice(0, 10) + 'T00:00:00'), -1);
  const laneQualifies = e => e.allDay && TEAM_LANE_CAL_IDS.includes(e.calendarId);
  const laneRangeStart = view === 'week' ? stripDays[0] : anchor;
  const laneRangeEnd = view === 'week' ? stripDays[6] : anchor;
  const laneEvents = view === 'month' ? [] : visEvents().filter(e => laneQualifies(e) && laneTrueEnd(e) >= laneRangeStart && laneTrueStart(e) <= laneRangeEnd).map(e => ({
    raw: e,
    cat: laneCategoryOf(e),
    trueStart: laneTrueStart(e),
    trueEnd: laneTrueEnd(e)
  }));
  const [laneExpanded, setLaneExpanded] = useState(false);
  useEffect(() => {
    setLaneExpanded(false);
  }, [view, anchor]);
  // Callback ref (not a plain useRef+effect) — the lane's div doesn't exist on first mount
  // (events load async), so a one-time effect would find the node still null and never attach.
  const laneRO = useRef(null);
  const [laneGridW, setLaneGridW] = useState(0);
  const laneGridRef = useCallback(node => {
    if (laneRO.current) {
      laneRO.current.disconnect();
      laneRO.current = null;
    }
    if (!node || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(entries => {
      const w = entries[0] && entries[0].contentRect && entries[0].contentRect.width;
      if (w) setLaneGridW(w);
    });
    ro.observe(node);
    laneRO.current = ro;
  }, []);
  const laneName = e => (e.title || '').replace(/^ooo\s*-\s*/i, '').trim() || e.title || 'Event';
  const laneFmtRange = b => {
    if (sameDay(b.trueStart, b.trueEnd)) return null;
    const df = d => d.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric'
    });
    return b.trueStart.getMonth() === b.trueEnd.getMonth() ? df(b.trueStart) + '–' + b.trueEnd.getDate() : df(b.trueStart) + ' – ' + df(b.trueEnd);
  };
  const laneLabel = (b, dayLabel) => {
    let s = laneName(b.raw) + ' — ' + (LANE_CATEGORY_LABEL[b.cat] || 'Team event');
    const range = laneFmtRange(b);
    if (range) s += ' · ' + range;
    if (dayLabel) s += ' · ' + dayLabel;
    return s;
  };
  const laneInitials = b => laneName(b.raw).split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join('') || '?';
  // Assign rows greedily — first row where a bar doesn't overlap an existing one (by column span).
  const laneAssignRows = bars => {
    const rowEnds = [];
    bars.forEach(b => {
      let r = 0;
      while (r < rowEnds.length && rowEnds[r] >= b.startIdx) r++;
      rowEnds[r] = b.endIdx;
      b.row = r;
    });
    return bars;
  };
  const laneWeekBars = view === 'week' ? laneEvents.map(b => {
    const rawStart = Math.round((b.trueStart - stripDays[0]) / 86400000);
    const rawEnd = Math.round((b.trueEnd - stripDays[0]) / 86400000);
    return {
      ...b,
      startIdx: Math.max(0, rawStart),
      endIdx: Math.min(6, rawEnd),
      clipStart: rawStart < 0,
      clipEnd: rawEnd > 6
    };
  }).sort((a, b) => a.startIdx - b.startIdx || b.endIdx - b.startIdx - (a.endIdx - a.startIdx)) : [];
  const laneDayBars = view === 'day' ? laneEvents.map(b => ({
    ...b,
    startIdx: 0,
    endIdx: 0
  })).sort((a, b) => a.trueStart - b.trueStart) : [];
  const laneBarsRaw = laneAssignRows(view === 'week' ? laneWeekBars : laneDayBars);
  const laneRowCount = laneBarsRaw.length ? Math.max.apply(null, laneBarsRaw.map(b => b.row)) + 1 : 0;
  const laneOverflowCount = laneBarsRaw.filter(b => b.row >= 3).length;
  const laneCapped = !laneExpanded && laneOverflowCount > 0;
  const laneVisibleBars = laneCapped ? laneBarsRaw.filter(b => b.row < 3) : laneBarsRaw;
  const laneShownRows = laneExpanded ? laneRowCount : Math.min(laneRowCount, 3);
  const laneHeight = laneRowCount ? 12 + laneShownRows * 20 + (laneShownRows - 1) * 4 : 0;
  const laneMorePill = extraStyle => /*#__PURE__*/React.createElement("div", {
    onClick: e => {
      e.stopPropagation();
      setLaneExpanded(x => !x);
    },
    style: {
      fontFamily: J,
      fontSize: 10,
      fontWeight: 600,
      color: K.muted,
      background: K.chipBg,
      borderRadius: 20,
      height: 20,
      padding: '0 10px',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      cursor: 'pointer',
      flexShrink: 0,
      whiteSpace: 'nowrap',
      ...extraStyle
    }
  }, "+", laneOverflowCount, " more");
  const laneWeekBarEl = b => {
    const cs = LANE_CATEGORY_STYLE[b.cat] || LANE_CATEGORY_STYLE.team;
    const leftPct = b.startIdx / 7 * 100 + 0.7;
    const widthPct = (b.endIdx - b.startIdx + 1) / 7 * 100 - 1.4;
    const pxW = laneGridW > 0 ? laneGridW * (widthPct / 100) : Infinity;
    const short = pxW < 60;
    const radTL = b.clipStart ? 0 : 4,
      radTR = b.clipEnd ? 0 : 4;
    return /*#__PURE__*/React.createElement("div", {
      key: b.raw.id + b.raw.calendarId,
      onClick: () => openEdit(b.raw),
      style: {
        position: 'absolute',
        top: b.row * 24,
        left: leftPct + '%',
        width: widthPct + '%',
        height: 20,
        borderRadius: `${radTL}px ${radTR}px ${radTR}px ${radTL}px`,
        borderLeft: b.clipStart ? 'none' : `3px solid ${cs.border}`,
        background: cs.fill,
        color: cs.text,
        display: 'flex',
        alignItems: 'center',
        padding: '0 8px',
        fontFamily: J,
        fontSize: 10.5,
        fontWeight: 500,
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        cursor: 'pointer',
        boxSizing: 'border-box'
      }
    }, b.clipStart && /*#__PURE__*/React.createElement("span", {
      style: {
        fontWeight: 700,
        marginRight: 3,
        flexShrink: 0
      }
    }, "\u2039"), /*#__PURE__*/React.createElement("span", {
      style: {
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap'
      }
    }, short ? laneInitials(b) : laneLabel(b, null)), b.clipEnd && /*#__PURE__*/React.createElement("span", {
      style: {
        fontWeight: 700,
        marginLeft: 3,
        flexShrink: 0
      }
    }, "\u203A"));
  };
  const laneDayRowEl = (b, isLast) => {
    const cs = LANE_CATEGORY_STYLE[b.cat] || LANE_CATEGORY_STYLE.team;
    const spanLen = Math.round((b.trueEnd - b.trueStart) / 86400000) + 1;
    const dayIdx = Math.round((anchor - b.trueStart) / 86400000) + 1;
    const dayLabel = spanLen > 1 ? 'Day ' + dayIdx + ' of ' + spanLen : null;
    return /*#__PURE__*/React.createElement("div", {
      key: b.raw.id + b.raw.calendarId,
      style: {
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        height: 20,
        marginBottom: isLast ? 0 : 4
      }
    }, /*#__PURE__*/React.createElement("div", {
      onClick: () => openEdit(b.raw),
      style: {
        flex: 1,
        minWidth: 0,
        height: 20,
        borderRadius: 4,
        borderLeft: `3px solid ${cs.border}`,
        background: cs.fill,
        color: cs.text,
        display: 'flex',
        alignItems: 'center',
        padding: '0 8px',
        fontFamily: J,
        fontSize: 10.5,
        fontWeight: 500,
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        cursor: 'pointer',
        boxSizing: 'border-box'
      }
    }, laneLabel(b, dayLabel)), laneCapped && isLast && laneMorePill({}));
  };
  const teamLane = laneEvents.length > 0 ? /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexShrink: 0,
      background: LANE_BG,
      borderBottom: `1px solid ${K.bd2}`
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: GUTTER_W,
      flexShrink: 0,
      borderRight: `1px solid ${K.bd2}`,
      fontFamily: J,
      fontSize: 9,
      letterSpacing: '0.18em',
      textTransform: 'uppercase',
      fontWeight: 600,
      color: K.muted,
      lineHeight: 1.4,
      padding: '9px 0 0 16px'
    }
  }, "Team", /*#__PURE__*/React.createElement("br", null), "All-day"), /*#__PURE__*/React.createElement("div", {
    ref: laneGridRef,
    style: {
      flex: 1,
      position: 'relative',
      height: laneHeight
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'absolute',
      inset: 0,
      display: 'flex'
    }
  }, (view === 'week' ? stripDays : [anchor]).map((d, i) => /*#__PURE__*/React.createElement("div", {
    key: i,
    style: {
      flex: 1,
      borderLeft: i > 0 ? `1px solid ${K.gline}` : 'none',
      background: sameDay(d, todayD) ? K.weekTodayCol : 'transparent'
    }
  }))), view === 'week' ? /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'absolute',
      top: 6,
      bottom: 6,
      left: 0,
      right: 0
    }
  }, laneVisibleBars.map(laneWeekBarEl), laneCapped && laneMorePill({
    position: 'absolute',
    top: 2 * 24,
    right: 0
  })) : /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'absolute',
      top: 6,
      bottom: 6,
      left: 0,
      right: 0
    }
  }, laneVisibleBars.map((b, i) => laneDayRowEl(b, i === laneVisibleBars.length - 1))))) : null;

  // ── Section 4: Day grid ──
  const dayGrid = /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      minHeight: 0,
      display: 'flex',
      flexDirection: 'column'
    }
  }, gcal === 'needs_connect' && connectBar, /*#__PURE__*/React.createElement("div", {
    ref: scrollRef,
    style: {
      flex: 1,
      minHeight: 0,
      overflowY: 'auto'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      position: 'relative'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: GUTTER_W,
      flexShrink: 0,
      background: K.tzBg,
      borderRight: `0.5px solid ${K.bd2}`
    }
  }, HOURS.map(h => {
    const inst = tzInstant(anchor, h, primaryTz);
    const hot = dayEvents(anchor).some(e => Math.floor(tzFloat(e.start, primaryTz)) === h);
    return /*#__PURE__*/React.createElement("div", {
      key: h,
      style: {
        height: 48,
        borderBottom: `0.5px solid ${K.slot}`,
        padding: '5px 6px 0'
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        fontFamily: J,
        fontSize: 11,
        fontWeight: hot ? 700 : 600,
        color: hot ? K.gold : K.tx
      }
    }, fmtHour(inst, primaryTz)), showSecondaryTz && /*#__PURE__*/React.createElement("div", {
      style: {
        fontFamily: J,
        fontSize: 9,
        fontWeight: hot ? 600 : 400,
        color: K.ph,
        opacity: hot ? 1 : 0.85
      }
    }, fmtHour(inst, secondaryTz)));
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      position: 'relative'
    }
  }, HOURS.map(h => /*#__PURE__*/React.createElement("div", {
    key: h,
    style: {
      height: 48,
      borderBottom: `0.5px solid ${K.gline}`
    }
  })), (() => {
    const dEvs = dayEvents(anchor);
    const lay = layoutDayEvents(dEvs);
    return dEvs.map((e, i) => {
      const top = tzFloat(e.start, primaryTz) * 48;
      const dur = e.end ? Math.max((e.end - e.start) / 3600000, 0.5) : 0.75;
      const p = lay[i] || {
        col: 0,
        n: 1
      };
      return /*#__PURE__*/React.createElement("div", {
        key: i,
        onClick: () => openEdit(e.raw),
        style: {
          position: 'absolute',
          top: top + 1,
          left: `calc(4px + (100% - 8px) * ${p.col} / ${p.n})`,
          width: `calc((100% - 8px) / ${p.n} - 2px)`,
          height: Math.max(dur * 48 - 2, 16),
          background: evBg(e),
          borderLeft: `3px solid ${evBd(e)}`,
          borderRadius: 5,
          padding: '4px 7px',
          overflow: 'hidden',
          cursor: 'pointer',
          boxSizing: 'border-box'
        }
      }, /*#__PURE__*/React.createElement("div", {
        style: {
          fontFamily: J,
          fontSize: 9,
          fontWeight: 600,
          color: K.evTitle,
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis'
        }
      }, e.title), /*#__PURE__*/React.createElement("div", {
        style: {
          fontFamily: J,
          fontSize: 7.5,
          color: K.evTime,
          marginTop: 1
        }
      }, fmtClock(e.start, primaryTz)));
    });
  })()))));

  // ── Section 5: Week grid ──
  const weekGrid = /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      minHeight: 0,
      display: 'flex',
      flexDirection: 'column'
    }
  }, gcal === 'needs_connect' && connectBar, /*#__PURE__*/React.createElement("div", {
    ref: scrollRef,
    style: {
      flex: 1,
      minHeight: 0,
      overflow: 'auto'
    }
  }, HOURS.map(h => {
    const inst = tzInstant(mondayOf(anchor), h, primaryTz);
    return /*#__PURE__*/React.createElement("div", {
      key: h,
      style: {
        display: 'flex'
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        width: GUTTER_W,
        flexShrink: 0,
        background: K.tzBg,
        borderRight: `0.5px solid ${K.bd2}`,
        padding: '4px 6px 0'
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        fontFamily: J,
        fontSize: 11,
        fontWeight: 600,
        color: K.tx
      }
    }, fmtHour(inst, primaryTz)), showSecondaryTz && /*#__PURE__*/React.createElement("div", {
      style: {
        fontFamily: J,
        fontSize: 9,
        fontWeight: 400,
        color: K.ph,
        opacity: 0.85
      }
    }, fmtHour(inst, secondaryTz))), stripDays.map((d, di) => {
      const isTod = sameDay(d, todayD),
        wknd = di >= 5;
      const evs = dayEvents(d).filter(e => Math.floor(tzFloat(e.start, primaryTz)) === h);
      return /*#__PURE__*/React.createElement("div", {
        key: di,
        style: {
          flex: 1,
          minWidth: 0,
          height: 44,
          borderBottom: `0.5px solid ${K.gline}`,
          borderRight: `0.5px solid ${K.gline}`,
          background: isTod ? K.weekTodayCol : wknd ? K.weekendCell : 'transparent',
          padding: '1px 2px',
          overflow: 'hidden'
        }
      }, evs.map((e, ei) => /*#__PURE__*/React.createElement("div", {
        key: ei,
        onClick: () => openEdit(e.raw),
        style: {
          fontFamily: J,
          fontSize: 9.5,
          fontWeight: 600,
          padding: '2px 4px',
          borderRadius: 3,
          marginBottom: 1,
          background: evBg(e),
          borderLeft: `2px solid ${evBd(e)}`,
          color: K.evTitle,
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          cursor: 'pointer'
        }
      }, e.title)));
    }));
  })));

  // ── Section 6: Month grid (auto-height) ──
  const monthGrid = (() => {
    const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
    const gridStart = mondayOf(first);
    const lastDate = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0).getDate();
    const rows = Math.ceil(((first.getDay() + 6) % 7 + lastDate) / 7);
    const cells = [];
    for (let i = 0; i < rows * 7; i++) cells.push(addDays(gridStart, i));
    return /*#__PURE__*/React.createElement("div", {
      style: {
        flex: '0 0 auto',
        padding: '8px 10px 10px',
        overflowY: 'auto'
      }
    }, gcal === 'needs_connect' && /*#__PURE__*/React.createElement("div", {
      style: {
        marginBottom: 8
      }
    }, connectBar), /*#__PURE__*/React.createElement("div", {
      style: {
        display: 'grid',
        gridTemplateColumns: 'repeat(7,1fr)',
        gap: 3,
        marginBottom: 4
      }
    }, SL.map((l, i) => /*#__PURE__*/React.createElement("div", {
      key: i,
      style: {
        textAlign: 'center',
        fontFamily: J,
        fontSize: 7,
        fontWeight: 700,
        letterSpacing: '0.06em',
        textTransform: 'uppercase',
        color: i >= 5 ? K.weekend : K.dayLetter
      }
    }, l))), /*#__PURE__*/React.createElement("div", {
      style: {
        display: 'grid',
        gridTemplateColumns: 'repeat(7,1fr)',
        gap: 3
      }
    }, cells.map((d, i) => {
      const inM = d.getMonth() === anchor.getMonth();
      const wknd = i % 7 >= 5;
      const isTod = sameDay(d, todayD);
      const ev = monthHasEvent(d),
        tk = monthHasTask(d);
      return /*#__PURE__*/React.createElement("div", {
        key: i,
        onClick: () => {
          setAnchor(new Date(d));
          setView('day');
        },
        style: {
          minHeight: 42,
          padding: 3,
          border: `1px solid ${isTod ? K.todCellBd : K.monthBd}`,
          borderRadius: 4,
          background: isTod ? K.todCellBg : wknd ? K.weekendCell : K.cellBg,
          opacity: inM ? 1 : 0.4,
          cursor: 'pointer'
        }
      }, isTod ? /*#__PURE__*/React.createElement("div", {
        style: {
          width: 16,
          height: 16,
          borderRadius: '50%',
          background: K.circBg,
          color: K.circTx,
          fontFamily: J,
          fontSize: 9,
          fontWeight: 700,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center'
        }
      }, d.getDate()) : /*#__PURE__*/React.createElement("div", {
        style: {
          fontFamily: J,
          fontSize: 9,
          fontWeight: 500,
          color: wknd ? K.weekend : K.date
        }
      }, d.getDate()), /*#__PURE__*/React.createElement("div", {
        style: {
          display: 'flex',
          gap: 2,
          marginTop: 2
        }
      }, ev && /*#__PURE__*/React.createElement("div", {
        style: {
          width: 4,
          height: 4,
          borderRadius: '50%',
          background: K.dotEvent
        }
      }), tk && /*#__PURE__*/React.createElement("div", {
        style: {
          width: 4,
          height: 4,
          borderRadius: '50%',
          background: K.dotTask
        }
      })));
    })));
  })();

  // TOP-anchored: top is the top of the conversation area (just under the app top bar);
  // grows DOWNWARD. Day/Week fill to the input bar (bottom = input-bar height); Month is auto.
  // Embedded (inside the app's iframe popout) → fill edge-to-edge like Tasks/Decisions;
  // standalone → the narrow top-right floating panel.
  // ── Calendar Settings sheet (gear button) ──
  const settHead = t => /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: J,
      fontSize: 8.5,
      fontWeight: 700,
      letterSpacing: '0.1em',
      textTransform: 'uppercase',
      color: K.muted,
      padding: '16px 18px 7px'
    }
  }, t);
  const settCard = {
    background: dark ? '#0A1730' : '#fff',
    border: `0.5px solid ${K.bd2}`,
    borderRadius: 12,
    margin: '0 14px',
    overflow: 'hidden'
  };
  const settRow = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    padding: '13px 15px'
  };
  const settPill = {
    fontFamily: J,
    fontSize: 10,
    fontWeight: 600,
    padding: '6px 14px',
    borderRadius: 8,
    border: `0.5px solid ${K.chipBd}`,
    background: K.chipBg,
    color: K.tBtnTx,
    cursor: 'pointer',
    flexShrink: 0
  };
  const toggle = (on, onClick) => /*#__PURE__*/React.createElement("button", {
    onClick: onClick,
    style: {
      width: 42,
      height: 25,
      borderRadius: 13,
      border: 'none',
      cursor: 'pointer',
      background: on ? '#34C759' : dark ? '#39393D' : '#E4DFD4',
      position: 'relative',
      flexShrink: 0,
      transition: 'background 150ms',
      padding: 0
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      position: 'absolute',
      top: 2,
      left: on ? 19 : 2,
      width: 21,
      height: 21,
      borderRadius: '50%',
      background: '#fff',
      boxShadow: '0 1px 3px rgba(0,0,0,.3)',
      transition: 'left 150ms'
    }
  }));
  const tzSelect = (val, onChange) => /*#__PURE__*/React.createElement("select", {
    value: val,
    onChange: e => onChange(e.target.value),
    style: {
      fontFamily: J,
      fontSize: 12,
      fontWeight: 600,
      color: K.date,
      background: 'transparent',
      border: 'none',
      cursor: 'pointer',
      textAlign: 'right',
      maxWidth: 190,
      outline: 'none'
    }
  }, !CAL_TZ_OPTIONS.some(o => o.tz === val) && /*#__PURE__*/React.createElement("option", {
    value: val
  }, tzLabel(val)), CAL_TZ_OPTIONS.map(o => /*#__PURE__*/React.createElement("option", {
    key: o.tz,
    value: o.tz
  }, o.label)));
  const settingsPanel = /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'fixed',
      inset: 0,
      zIndex: 10000,
      background: K.pop,
      display: 'flex',
      flexDirection: 'column'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      padding: '13px 15px',
      borderBottom: `0.5px solid ${K.bd2}`,
      flexShrink: 0,
      background: K.navBg
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      width: 48
    }
  }), /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: J,
      fontSize: 13,
      fontWeight: 700,
      color: K.date
    }
  }, "Calendar Settings"), /*#__PURE__*/React.createElement("button", {
    onClick: () => setShowSettings(false),
    style: {
      fontFamily: J,
      fontSize: 12,
      fontWeight: 700,
      color: K.gold,
      background: 'none',
      border: 'none',
      cursor: 'pointer',
      width: 48,
      textAlign: 'right'
    }
  }, "Done")), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      minHeight: 0,
      overflowY: 'auto',
      paddingBottom: 'calc(24px + env(safe-area-inset-bottom))'
    }
  }, settHead('Google Calendar & Tasks'), /*#__PURE__*/React.createElement("div", {
    style: settCard
  }, /*#__PURE__*/React.createElement("div", {
    style: settRow
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: J,
      fontSize: 12,
      color: K.date
    }
  }, gcal === 'needs_connect' ? 'Not connected' : 'Connected · calendar' + (calPrefs.autoSyncTasks ? ' + tasks sync is on' : ' sync only')), /*#__PURE__*/React.createElement("button", {
    onClick: () => {
      try {
        window.SupabaseAuth.connectCalendar();
      } catch (e) {}
    },
    style: settPill
  }, gcal === 'needs_connect' ? 'Connect' : 'Reconnect')), /*#__PURE__*/React.createElement("div", {
    style: {
      ...settRow,
      borderTop: `0.5px solid ${K.rowBd}`
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: 2,
      minWidth: 0
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: J,
      fontSize: 12,
      color: K.date
    }
  }, "Google Task auto-sync"), /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: J,
      fontSize: 10,
      color: K.muted
    }
  }, "New tasks are automatically added to Google Tasks")), toggle(!!calPrefs.autoSyncTasks, () => savePrefs({
    autoSyncTasks: !calPrefs.autoSyncTasks
  })))), settHead('Calendars to Show'), /*#__PURE__*/React.createElement("div", {
    style: settCard
  }, calList.length === 0 ? /*#__PURE__*/React.createElement("div", {
    style: {
      padding: '14px 15px',
      fontFamily: J,
      fontSize: 11,
      color: K.muted,
      lineHeight: 1.55
    }
  }, gcal === 'needs_connect' ? 'Connect your Google account to choose which calendars appear.' : 'No calendars to choose yet. If you just connected, give it a moment, or tap Reconnect above.') : calList.map((c, i) => {
    const on = !isHidden(c.id);
    return /*#__PURE__*/React.createElement("div", {
      key: c.id,
      style: {
        ...settRow,
        borderTop: i ? `0.5px solid ${K.rowBd}` : 'none'
      }
    }, /*#__PURE__*/React.createElement("span", {
      style: {
        display: 'flex',
        alignItems: 'center',
        gap: 11,
        minWidth: 0
      }
    }, /*#__PURE__*/React.createElement("span", {
      style: {
        width: 15,
        height: 15,
        borderRadius: 4,
        background: c.color || K.muted,
        flexShrink: 0
      }
    }), /*#__PURE__*/React.createElement("span", {
      style: {
        fontFamily: J,
        fontSize: 12,
        color: K.date,
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis'
      }
    }, c.summary, c.primary ? ' · primary' : '')), toggle(on, () => {
      const set = new Set(calPrefs.hidden || []);
      on ? set.add(c.id) : set.delete(c.id);
      savePrefs({
        hidden: Array.from(set)
      });
    }));
  })), settHead('Primary Timezone (shown on top)'), /*#__PURE__*/React.createElement("div", {
    style: settCard
  }, /*#__PURE__*/React.createElement("div", {
    style: settRow
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: J,
      fontSize: 12,
      color: K.date
    }
  }, "Primary"), tzSelect(primaryTz, v => savePrefs({
    primaryTz: v
  })))), settHead('Secondary Timezone (shown below)'), /*#__PURE__*/React.createElement("div", {
    style: settCard
  }, /*#__PURE__*/React.createElement("div", {
    style: settRow
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: J,
      fontSize: 12,
      color: K.date
    }
  }, "Show secondary timezone"), toggle(showSecondaryTz, () => savePrefs({
    secondaryTzEnabled: !showSecondaryTz
  }))), /*#__PURE__*/React.createElement("div", {
    style: {
      ...settRow,
      borderTop: `0.5px solid ${K.rowBd}`
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: J,
      fontSize: 12,
      color: K.date
    }
  }, "Secondary"), tzSelect(secondaryTz, v => savePrefs({
    secondaryTz: v
  })))), /*#__PURE__*/React.createElement("div", {
    style: {
      padding: '11px 18px 0',
      fontFamily: J,
      fontSize: 10.5,
      color: K.muted,
      lineHeight: 1.5
    }
  }, showSecondaryTz ? `The calendar shows ${tzShort(primaryTz)} over ${tzShort(secondaryTz)} on the time rail.` : `The calendar shows ${tzShort(primaryTz)} only. Turn this on to also show ${tzShort(secondaryTz)}.`)));

  // ── Event create / edit / delete form ──
  const fld = {
    width: '100%',
    boxSizing: 'border-box',
    fontFamily: J,
    fontSize: 13,
    color: K.date,
    background: dark ? '#06101F' : '#FCFBF8',
    border: `1px solid ${K.cellBd}`,
    borderRadius: 9,
    padding: '10px 12px',
    outline: 'none'
  };
  const fldLbl = {
    fontFamily: J,
    fontSize: 8.5,
    fontWeight: 700,
    letterSpacing: '0.08em',
    textTransform: 'uppercase',
    color: K.muted,
    margin: '0 0 5px 2px',
    display: 'block'
  };
  const fldWrap = {
    padding: '12px 16px 0'
  };
  const eventForm = editing ? (() => {
    const ed = editing;
    const ro = !!ed.readOnly;
    const calOf = calList.find(c => c.id === ed.calendarId) || {};
    return /*#__PURE__*/React.createElement("div", {
      style: {
        position: 'fixed',
        inset: 0,
        zIndex: 10001,
        background: K.pop,
        display: 'flex',
        flexDirection: 'column'
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '13px 15px',
        borderBottom: `0.5px solid ${K.bd2}`,
        flexShrink: 0,
        background: K.navBg
      }
    }, /*#__PURE__*/React.createElement("button", {
      onClick: () => setEditing(null),
      style: {
        fontFamily: J,
        fontSize: 12,
        color: K.tBtnTx,
        background: 'none',
        border: 'none',
        cursor: 'pointer',
        width: 60,
        textAlign: 'left'
      }
    }, "Cancel"), /*#__PURE__*/React.createElement("span", {
      style: {
        fontFamily: J,
        fontSize: 13,
        fontWeight: 700,
        color: K.date
      }
    }, ed.mode === 'create' ? 'New event' : ro ? 'Event' : 'Edit event'), /*#__PURE__*/React.createElement("button", {
      onClick: submitEvent,
      disabled: savingEvent || ro,
      style: {
        fontFamily: J,
        fontSize: 12,
        fontWeight: 700,
        color: ro ? K.muted : K.gold,
        background: 'none',
        border: 'none',
        cursor: ro ? 'default' : 'pointer',
        width: 60,
        textAlign: 'right',
        opacity: savingEvent ? 0.5 : 1
      }
    }, savingEvent ? '…' : 'Save')), /*#__PURE__*/React.createElement("div", {
      style: {
        flex: 1,
        minHeight: 0,
        overflowY: 'auto',
        paddingBottom: 'calc(28px + env(safe-area-inset-bottom))'
      }
    }, ro && /*#__PURE__*/React.createElement("div", {
      style: {
        margin: '12px 16px 0',
        padding: '9px 12px',
        borderRadius: 9,
        background: dark ? '#2A1F0A' : '#FDF8F0',
        border: `1px solid ${K.evGoldBd}`,
        fontFamily: J,
        fontSize: 10.5,
        color: K.date
      }
    }, "This calendar is read-only \u2014 you can view this event but not change it."), eventErr && /*#__PURE__*/React.createElement("div", {
      style: {
        margin: '12px 16px 0',
        padding: '9px 12px',
        borderRadius: 9,
        background: dark ? '#2A0F0F' : '#FDEDED',
        border: '1px solid #E07A7A',
        fontFamily: J,
        fontSize: 10.5,
        color: dark ? '#E89A9A' : '#9B1C1C'
      }
    }, eventErr), ed.recurring && /*#__PURE__*/React.createElement("div", {
      style: {
        margin: '12px 16px 0',
        fontFamily: J,
        fontSize: 10,
        color: K.muted,
        lineHeight: 1.5,
        padding: '0 2px'
      }
    }, "This is a repeating event \u2014 changes apply to this occurrence."), /*#__PURE__*/React.createElement("div", {
      style: fldWrap
    }, /*#__PURE__*/React.createElement("label", {
      style: fldLbl
    }, "Title"), /*#__PURE__*/React.createElement("input", {
      value: ed.title,
      disabled: ro,
      onChange: e => setF({
        title: e.target.value
      }),
      placeholder: "Add a title",
      autoFocus: ed.mode === 'create',
      style: {
        ...fld,
        fontWeight: 600
      }
    })), /*#__PURE__*/React.createElement("div", {
      style: fldWrap
    }, /*#__PURE__*/React.createElement("label", {
      style: fldLbl
    }, "Calendar"), ed.mode === 'create' ? /*#__PURE__*/React.createElement("select", {
      value: ed.calendarId,
      onChange: e => setF({
        calendarId: e.target.value
      }),
      style: fld
    }, writableCals.map(c => /*#__PURE__*/React.createElement("option", {
      key: c.id,
      value: c.id
    }, c.summary, c.primary ? ' · primary' : '')), !writableCals.length && /*#__PURE__*/React.createElement("option", {
      value: "primary"
    }, "Primary")) : /*#__PURE__*/React.createElement("div", {
      style: {
        ...fld,
        display: 'flex',
        alignItems: 'center',
        gap: 9
      }
    }, /*#__PURE__*/React.createElement("span", {
      style: {
        width: 13,
        height: 13,
        borderRadius: 4,
        background: calColor(ed.calendarId) || K.muted,
        flexShrink: 0
      }
    }), /*#__PURE__*/React.createElement("span", null, calOf.summary || 'Calendar'))), /*#__PURE__*/React.createElement("div", {
      style: {
        ...fldWrap,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between'
      }
    }, /*#__PURE__*/React.createElement("span", {
      style: {
        fontFamily: J,
        fontSize: 12.5,
        color: K.date
      }
    }, "All day"), toggle(ed.allDay, () => {
      if (!ro) setF({
        allDay: !ed.allDay
      });
    })), /*#__PURE__*/React.createElement("div", {
      style: fldWrap
    }, /*#__PURE__*/React.createElement("label", {
      style: fldLbl
    }, "Starts"), /*#__PURE__*/React.createElement("div", {
      style: {
        display: 'flex',
        gap: 8
      }
    }, /*#__PURE__*/React.createElement("input", {
      type: "date",
      value: ed.date,
      disabled: ro,
      onChange: e => setF({
        date: e.target.value,
        endDate: ed.endDate < e.target.value ? e.target.value : ed.endDate
      }),
      style: {
        ...fld,
        flex: 1
      }
    }), !ed.allDay && /*#__PURE__*/React.createElement("input", {
      type: "time",
      value: ed.start,
      disabled: ro,
      onChange: e => setF({
        start: e.target.value
      }),
      style: {
        ...fld,
        width: 120
      }
    }))), /*#__PURE__*/React.createElement("div", {
      style: fldWrap
    }, /*#__PURE__*/React.createElement("label", {
      style: fldLbl
    }, "Ends"), /*#__PURE__*/React.createElement("div", {
      style: {
        display: 'flex',
        gap: 8
      }
    }, /*#__PURE__*/React.createElement("input", {
      type: "date",
      value: ed.endDate,
      disabled: ro,
      min: ed.date,
      onChange: e => setF({
        endDate: e.target.value
      }),
      style: {
        ...fld,
        flex: 1
      }
    }), !ed.allDay && /*#__PURE__*/React.createElement("input", {
      type: "time",
      value: ed.end,
      disabled: ro,
      onChange: e => setF({
        end: e.target.value
      }),
      style: {
        ...fld,
        width: 120
      }
    }))), !ed.allDay && /*#__PURE__*/React.createElement("div", {
      style: {
        padding: '6px 18px 0',
        fontFamily: J,
        fontSize: 10,
        color: K.muted
      }
    }, "Times are in ", tzShort(primaryTz), " (", tzLabel(primaryTz), ")."), /*#__PURE__*/React.createElement("div", {
      style: fldWrap
    }, /*#__PURE__*/React.createElement("label", {
      style: fldLbl
    }, "Location"), /*#__PURE__*/React.createElement("input", {
      value: ed.location,
      disabled: ro,
      onChange: e => setF({
        location: e.target.value
      }),
      placeholder: "Add a location",
      style: fld
    })), /*#__PURE__*/React.createElement("div", {
      style: fldWrap
    }, /*#__PURE__*/React.createElement("label", {
      style: fldLbl
    }, "Notes"), /*#__PURE__*/React.createElement("textarea", {
      value: ed.notes,
      disabled: ro,
      onChange: e => setF({
        notes: e.target.value
      }),
      placeholder: "Add notes",
      style: {
        ...fld,
        minHeight: 70,
        resize: 'vertical'
      }
    })), /*#__PURE__*/React.createElement("div", {
      style: fldWrap
    }, /*#__PURE__*/React.createElement("label", {
      style: fldLbl
    }, "Guests (emails)"), /*#__PURE__*/React.createElement("input", {
      value: ed.guests,
      disabled: ro,
      onChange: e => setF({
        guests: e.target.value
      }),
      placeholder: "name@email.com, another@email.com",
      style: fld
    }), /*#__PURE__*/React.createElement("div", {
      style: {
        fontFamily: J,
        fontSize: 9.5,
        color: K.muted,
        margin: '5px 0 0 2px'
      }
    }, "Separate with commas. Google emails them an invite.")), /*#__PURE__*/React.createElement("div", {
      style: fldWrap
    }, /*#__PURE__*/React.createElement("label", {
      style: fldLbl
    }, "Repeat"), ed.mode === 'edit' && ed.recurring ? /*#__PURE__*/React.createElement("div", {
      style: {
        ...fld,
        color: K.muted
      }
    }, "Repeating event \u2014 manage the series in Google Calendar.") : /*#__PURE__*/React.createElement("select", {
      value: ed.repeat,
      disabled: ro,
      onChange: e => setF({
        repeat: e.target.value
      }),
      style: fld
    }, /*#__PURE__*/React.createElement("option", {
      value: "none"
    }, "Does not repeat"), /*#__PURE__*/React.createElement("option", {
      value: "daily"
    }, "Daily"), /*#__PURE__*/React.createElement("option", {
      value: "weekly"
    }, "Weekly"), /*#__PURE__*/React.createElement("option", {
      value: "monthly"
    }, "Monthly"))), ed.mode === 'edit' && !ro && /*#__PURE__*/React.createElement("div", {
      style: {
        padding: '20px 16px 0'
      }
    }, confirmDel ? /*#__PURE__*/React.createElement("div", {
      style: {
        display: 'flex',
        gap: 8,
        alignItems: 'center'
      }
    }, /*#__PURE__*/React.createElement("span", {
      style: {
        flex: 1,
        fontFamily: J,
        fontSize: 11.5,
        color: K.date
      }
    }, "Delete this event?"), /*#__PURE__*/React.createElement("button", {
      onClick: () => setConfirmDel(false),
      disabled: savingEvent,
      style: {
        fontFamily: J,
        fontSize: 11,
        fontWeight: 600,
        padding: '8px 14px',
        borderRadius: 9,
        border: `0.5px solid ${K.chipBd}`,
        background: K.chipBg,
        color: K.date,
        cursor: 'pointer'
      }
    }, "Keep"), /*#__PURE__*/React.createElement("button", {
      onClick: removeEvent,
      disabled: savingEvent,
      style: {
        fontFamily: J,
        fontSize: 11,
        fontWeight: 700,
        padding: '8px 16px',
        borderRadius: 9,
        border: 'none',
        background: '#C0392B',
        color: '#fff',
        cursor: 'pointer'
      }
    }, savingEvent ? '…' : 'Delete')) : /*#__PURE__*/React.createElement("button", {
      onClick: () => setConfirmDel(true),
      style: {
        width: '100%',
        fontFamily: J,
        fontSize: 12,
        fontWeight: 600,
        padding: '11px',
        borderRadius: 10,
        border: `1px solid ${dark ? '#5A2A2A' : '#E8C9C9'}`,
        background: 'none',
        color: dark ? '#E07A7A' : '#9B1C1C',
        cursor: 'pointer'
      }
    }, "Delete event"))));
  })() : null;
  const calStyle = TASKS_EMBED ? {
    position: 'fixed',
    inset: 0,
    zIndex: 10,
    background: K.pop,
    opacity: vis ? 1 : 0,
    transition: 'opacity 150ms ease',
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden'
  } : {
    position: 'fixed',
    top: POPOUT_TOP,
    right: 10,
    width: 'min(calc(100% - 20px), 560px)',
    bottom: view === 'month' ? 'auto' : zoneH || 0,
    zIndex: 10,
    background: K.pop,
    border: `1px solid ${K.bd}`,
    borderTop: 'none',
    borderRadius: '0 0 14px 14px',
    boxShadow: K.shadow,
    opacity: vis ? 1 : 0,
    transition: 'opacity 150ms ease',
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
    maxHeight: view === 'month' ? 'calc(100vh - 90px - env(safe-area-inset-top))' : 'none'
  };
  return /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    onClick: onClose,
    style: {
      position: 'fixed',
      top: POPOUT_TOP,
      left: 0,
      right: 0,
      bottom: 0,
      zIndex: 9,
      background: dark ? 'rgba(0,0,0,.35)' : 'rgba(0,26,74,.18)'
    }
  }), /*#__PURE__*/React.createElement("div", {
    onClick: e => e.stopPropagation(),
    style: calStyle
  }, navBar, view !== 'month' && taskStrip, view !== 'month' && dateStrip, view !== 'month' && teamLane, view === 'day' && dayGrid, view === 'week' && weekGrid, view === 'month' && monthGrid, showSettings && settingsPanel, eventForm));
}

// ─── Decisions popout (standalone, opened from the top bar beside Tasks; sized like the calendar) ──
function DecisionsPopover({
  dark,
  zoneH,
  onOpenTask,
  onClose
}) {
  const J = "'Jost', sans-serif";
  const todayD = new Date();
  const [tasks, setTasks] = useState([]);
  const [peopleByTask, setPeopleByTask] = useState({});
  const [roster, setRoster] = useState({});
  const [decData, setDecData] = useState({});
  const [decDraft, setDecDraft] = useState({});
  const [vis, setVis] = useState(false);
  const [selId, setSelId] = useState(null); // wide two-pane: which decision is open on the right
  const wide = useWide(700);
  const embed = TASKS_EMBED;
  const user = window.SupabaseAuth && window.SupabaseAuth._state && window.SupabaseAuth._state.session && window.SupabaseAuth._state.session.user || null;
  useEffect(() => {
    const r = requestAnimationFrame(() => setVis(true));
    return () => cancelAnimationFrame(r);
  }, []);
  useEffect(() => {
    let c = false;
    TaskDB.loadAll().then(d => {
      if (!c && d) {
        setTasks(d.tasks || []);
        setPeopleByTask(d.peopleByTask || {});
      }
    }).catch(() => {});
    ProfileDB.loadAll().then(ps => {
      if (!c && ps) {
        const m = {};
        ps.forEach(p => {
          m[p.id] = ((p.first_name || '') + ' ' + (p.last_name || '')).trim() || p.email || 'User';
        });
        setRoster(m);
      }
    }).catch(() => {});
    return () => {
      c = true;
    };
  }, []);
  const K = dark ? {
    pop: '#070F1E',
    bd: '#152545',
    bd2: '#0D1E3A',
    shadow: '0 6px 22px rgba(0,0,0,.5)',
    date: '#fff',
    gold: '#C9A45A',
    reg: 'rgba(255,255,255,.55)',
    muted: 'rgba(255,255,255,.3)',
    cellBd: '#0D1E3A',
    rowBd: '#0D1E3A',
    dueToday: '#C9A45A',
    dueOver: '#E07A7A',
    dueUp: 'rgba(255,255,255,.4)'
  } : {
    pop: '#fff',
    bd: '#EDE7DC',
    bd2: '#EDE7DC',
    shadow: '0 6px 22px rgba(0,26,74,.1)',
    date: '#001A4A',
    gold: '#AD832F',
    reg: '#6B7280',
    muted: '#B4B2A9',
    cellBd: '#F0EBE3',
    rowBd: '#F5F2EE',
    dueToday: '#AD832F',
    dueOver: '#9B1C1C',
    dueUp: '#B4B2A9'
  };
  const nameOf = id => roster[id] || '—';
  const roleNames = (tid, role) => (peopleByTask[tid] || []).filter(p => p.role === role).map(p => nameOf(p.user_id)).filter(n => n && n !== '—').join(', ');
  const decisionTasks = () => (tasks || []).filter(t => t.decision_question || t.decision_due_at || (peopleByTask[t.id] || []).some(p => p.role === 'decision_maker'));
  const decDueInfo = t => {
    if (!t.decision_due_at) return null;
    const d = new Date(t.decision_due_at);
    const t0 = new Date(todayD);
    t0.setHours(0, 0, 0, 0);
    const d0 = new Date(d);
    d0.setHours(0, 0, 0, 0);
    const f = t.decision_due_has_time ? d.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit'
    }) : d.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric'
    });
    if (d0.getTime() === t0.getTime()) return {
      label: t.decision_due_has_time ? f : 'Today',
      color: K.dueToday
    };
    if (d0 < t0) return {
      label: f,
      color: K.dueOver
    };
    return {
      label: f,
      color: K.dueUp
    };
  };
  const decs = decisionTasks();
  // A decision is "resolved" once an option is chosen (or its task is done); else it's "open".
  const isResolved = t => {
    const d = decData[t.id] || {};
    return (d.options || []).some(o => o.is_chosen) || t.status === 'done';
  };
  const isUrgent = t => {
    if (!t.decision_due_at) return false;
    const t0 = new Date(todayD);
    t0.setHours(0, 0, 0, 0);
    const d0 = new Date(t.decision_due_at);
    d0.setHours(0, 0, 0, 0);
    return d0.getTime() <= t0.getTime();
  };
  const accentOf = t => isResolved(t) ? '#0F6E56' : isUrgent(t) ? '#9B1C1C' : '#AD832F';
  const openDecs = decs.filter(t => !isResolved(t));
  const resolvedDecs = decs.filter(t => isResolved(t));
  useEffect(() => {
    if (wide && decs.length && !decs.some(t => t.id === selId)) setSelId((openDecs[0] || decs[0]).id);
  }, [wide, tasks, decData]);
  const selTask = decs.find(t => t.id === selId) || null;
  const secHead = (color, label, count) => /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 7,
      padding: '11px 14px 6px'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      width: 8,
      height: 8,
      borderRadius: '50%',
      background: color,
      flexShrink: 0
    }
  }), /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: J,
      fontSize: 8,
      fontWeight: 700,
      letterSpacing: '0.16em',
      textTransform: 'uppercase',
      color: K.reg
    }
  }, label), /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: J,
      fontSize: 8,
      color: K.muted
    }
  }, "\xB7 ", count), /*#__PURE__*/React.createElement("span", {
    style: {
      flex: 1,
      height: 0.5,
      background: K.bd2
    }
  }));
  useEffect(() => {
    let c = false;
    decs.forEach(t => {
      if (decData[t.id] && decData[t.id].loaded) return;
      Promise.all([TaskDB.loadDecisionOptions(t.id), TaskDB.loadActivity(t.id)]).then(([opts, act]) => {
        if (!c) setDecData(prev => ({
          ...prev,
          [t.id]: {
            options: opts || [],
            comments: (act || []).filter(a => a.kind === 'update'),
            loaded: true
          }
        }));
      }).catch(() => {});
    });
    return () => {
      c = true;
    };
  }, [tasks, peopleByTask]);
  const decRow = t => {
    const sel = selId === t.id;
    return /*#__PURE__*/React.createElement("div", {
      key: t.id,
      onClick: () => setSelId(t.id),
      style: {
        display: 'flex',
        flexDirection: 'column',
        gap: 3,
        padding: '9px 11px',
        margin: '0 8px 6px',
        borderRadius: 9,
        cursor: 'pointer',
        border: `1px solid ${sel ? K.gold : K.cellBd}`,
        borderLeft: `2.5px solid ${accentOf(t)}`,
        background: sel ? dark ? '#0A1E44' : '#F3EBDA' : dark ? '#0B1526' : '#fff',
        opacity: isResolved(t) ? 0.72 : 1
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        display: 'flex',
        alignItems: 'center',
        gap: 6
      }
    }, /*#__PURE__*/React.createElement("span", {
      style: {
        flex: 1,
        minWidth: 0,
        fontFamily: J,
        fontSize: 11,
        fontWeight: 700,
        color: K.date,
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis'
      }
    }, t.title), statusPill(t.status)), t.decision_question && /*#__PURE__*/React.createElement("div", {
      style: {
        fontFamily: J,
        fontSize: 9,
        color: K.reg,
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis'
      }
    }, t.decision_question));
  };
  const chooseOption = async (taskId, idx) => {
    const d = decData[taskId];
    if (!d) return;
    const opts = d.options.map((o, i) => ({
      ...o,
      is_chosen: i === idx ? !o.is_chosen : false
    }));
    setDecData(prev => ({
      ...prev,
      [taskId]: {
        ...prev[taskId],
        options: opts
      }
    }));
    try {
      await TaskDB.setDecisionOptions(taskId, opts.map(o => ({
        body: o.body,
        is_chosen: o.is_chosen
      })));
    } catch (e) {}
  };
  const addComment = async taskId => {
    const text = (decDraft[taskId] || '').trim();
    if (!text || !user) return;
    setDecDraft(prev => ({
      ...prev,
      [taskId]: ''
    }));
    try {
      await TaskDB.addActivity(taskId, 'update', text, user);
      const act = await TaskDB.loadActivity(taskId);
      setDecData(prev => ({
        ...prev,
        [taskId]: {
          ...(prev[taskId] || {}),
          comments: (act || []).filter(a => a.kind === 'update')
        }
      }));
    } catch (e) {}
  };
  const statusPill = st => /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: J,
      fontSize: 7.5,
      fontWeight: 700,
      padding: '2px 7px',
      borderRadius: 10,
      background: statusBg(st),
      color: statusColor(st),
      flexShrink: 0
    }
  }, statusLabel(st));
  const decCard = t => {
    const d = decData[t.id] || {};
    const dd = decDueInfo(t);
    const maker = roleNames(t.id, 'decision_maker');
    const asg = roleNames(t.id, 'assignee');
    const extra = t.description || '';
    return /*#__PURE__*/React.createElement("div", {
      key: t.id,
      style: {
        margin: '0 12px 8px',
        borderRadius: 10,
        border: `1px solid ${K.cellBd}`,
        borderLeft: `2.5px solid ${accentOf(t)}`,
        background: dark ? '#0B1526' : '#fff',
        padding: '11px 13px',
        opacity: isResolved(t) ? 0.78 : 1
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        display: 'flex',
        alignItems: 'center',
        gap: 8
      }
    }, /*#__PURE__*/React.createElement("span", {
      onClick: () => onOpenTask && onOpenTask(t),
      style: {
        flex: 1,
        minWidth: 0,
        fontFamily: J,
        fontSize: 12,
        fontWeight: 700,
        color: K.date,
        cursor: 'pointer',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis'
      }
    }, t.title), statusPill(t.status)), /*#__PURE__*/React.createElement("div", {
      style: {
        display: 'flex',
        flexWrap: 'wrap',
        gap: 10,
        marginTop: 5
      }
    }, maker && /*#__PURE__*/React.createElement("span", {
      style: {
        fontFamily: J,
        fontSize: 9,
        color: K.reg
      }
    }, /*#__PURE__*/React.createElement("b", {
      style: {
        color: K.gold
      }
    }, "Maker:"), " ", maker), dd && /*#__PURE__*/React.createElement("span", {
      style: {
        fontFamily: J,
        fontSize: 9,
        fontWeight: 600,
        color: dd.color
      }
    }, "Decide by ", dd.label), asg && /*#__PURE__*/React.createElement("span", {
      style: {
        fontFamily: J,
        fontSize: 9,
        color: K.reg
      }
    }, "Assignee: ", asg)), t.context && /*#__PURE__*/React.createElement("div", {
      style: {
        fontFamily: J,
        fontSize: 9,
        color: K.reg,
        lineHeight: 1.5,
        marginTop: 4,
        whiteSpace: 'pre-wrap'
      }
    }, /*#__PURE__*/React.createElement("b", {
      style: {
        color: K.gold
      }
    }, "Context:"), " ", t.context), t.decision_question && /*#__PURE__*/React.createElement("div", {
      style: {
        fontFamily: J,
        fontSize: 11,
        fontWeight: 600,
        color: K.date,
        margin: '8px 0 6px',
        lineHeight: 1.4
      }
    }, t.decision_question), (d.options || []).map((o, i) => /*#__PURE__*/React.createElement("div", {
      key: o.id || i,
      onClick: () => chooseOption(t.id, i),
      style: {
        display: 'flex',
        alignItems: 'center',
        gap: 7,
        padding: '6px 9px',
        marginBottom: 4,
        borderRadius: 7,
        cursor: 'pointer',
        background: o.is_chosen ? dark ? 'rgba(15,110,86,.18)' : '#E6F2EC' : dark ? '#0C1830' : '#FAF8F3',
        border: `1px solid ${o.is_chosen ? dark ? '#1E6B4E' : '#9FD3BC' : K.cellBd}`
      }
    }, /*#__PURE__*/React.createElement("i", {
      className: o.is_chosen ? 'ti ti-circle-check-filled' : 'ti ti-circle',
      style: {
        fontSize: 16,
        color: o.is_chosen ? dark ? '#3FB36B' : '#0F6E56' : K.muted,
        flexShrink: 0
      }
    }), /*#__PURE__*/React.createElement("span", {
      style: {
        flex: 1,
        minWidth: 0,
        fontFamily: J,
        fontSize: 10,
        fontWeight: o.is_chosen ? 600 : 400,
        color: K.date
      }
    }, o.body), o.is_chosen && /*#__PURE__*/React.createElement("span", {
      style: {
        fontFamily: J,
        fontSize: 7,
        fontWeight: 700,
        letterSpacing: '.06em',
        color: dark ? '#3FB36B' : '#0F6E56',
        flexShrink: 0
      }
    }, "CHOSEN"))), extra && /*#__PURE__*/React.createElement("div", {
      style: {
        fontFamily: J,
        fontSize: 9,
        color: K.reg,
        lineHeight: 1.5,
        marginTop: 4,
        whiteSpace: 'pre-wrap'
      }
    }, extra), (d.comments || []).slice(-3).map(cm => /*#__PURE__*/React.createElement("div", {
      key: cm.id,
      style: {
        display: 'flex',
        gap: 6,
        marginTop: 6
      }
    }, /*#__PURE__*/React.createElement("span", {
      style: {
        fontFamily: J,
        fontSize: 8.5,
        fontWeight: 700,
        color: K.gold,
        flexShrink: 0
      }
    }, (cm.author_name || 'User').split(' ')[0], ":"), /*#__PURE__*/React.createElement("span", {
      style: {
        fontFamily: J,
        fontSize: 9.5,
        color: K.date,
        minWidth: 0
      }
    }, cm.content))), /*#__PURE__*/React.createElement("div", {
      style: {
        display: 'flex',
        gap: 6,
        marginTop: 8
      }
    }, /*#__PURE__*/React.createElement("input", {
      value: decDraft[t.id] || '',
      onChange: e => setDecDraft(prev => ({
        ...prev,
        [t.id]: e.target.value
      })),
      onKeyDown: e => {
        if (e.key === 'Enter') {
          e.preventDefault();
          addComment(t.id);
        }
      },
      placeholder: "Add a comment\u2026",
      style: {
        flex: 1,
        minWidth: 0,
        fontFamily: J,
        fontSize: 9.5,
        padding: '7px 10px',
        borderRadius: 7,
        border: `1px solid ${K.cellBd}`,
        background: dark ? '#040C1C' : '#FCFBF8',
        color: K.date,
        outline: 'none'
      }
    }), /*#__PURE__*/React.createElement("button", {
      onClick: () => addComment(t.id),
      style: {
        flexShrink: 0,
        fontFamily: J,
        fontSize: 9.5,
        fontWeight: 600,
        padding: '0 13px',
        borderRadius: 7,
        border: 'none',
        background: K.gold,
        color: '#fff',
        cursor: 'pointer'
      }
    }, "Send")));
  };
  const emptyMsg = /*#__PURE__*/React.createElement("div", {
    style: {
      padding: '24px 16px',
      fontFamily: J,
      fontSize: 11,
      color: K.muted,
      textAlign: 'center',
      lineHeight: 1.6
    }
  }, "No decisions yet.", /*#__PURE__*/React.createElement("br", null), "Add a decision question, maker, or due date on any task to see it here.");
  const stackedList = /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      minHeight: 0,
      overflowY: 'auto',
      paddingBottom: 14
    }
  }, !decs.length ? emptyMsg : /*#__PURE__*/React.createElement(React.Fragment, null, openDecs.length > 0 && secHead('#9B1C1C', 'Open', openDecs.length), openDecs.map(decCard), resolvedDecs.length > 0 && secHead('#0F6E56', 'Resolved', resolvedDecs.length), resolvedDecs.map(decCard)));
  const containerStyle = embed ? {
    position: 'fixed',
    inset: 0,
    background: K.pop,
    opacity: vis ? 1 : 0,
    transition: 'opacity 150ms ease',
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden'
  } : {
    position: 'fixed',
    top: POPOUT_TOP,
    right: 10,
    width: wide ? 'min(calc(100% - 20px), 820px)' : 'min(calc(100% - 20px), 560px)',
    bottom: zoneH || 0,
    zIndex: 10,
    background: K.pop,
    border: `1px solid ${K.bd}`,
    borderTop: 'none',
    borderRadius: '0 0 14px 14px',
    boxShadow: K.shadow,
    opacity: vis ? 1 : 0,
    transition: 'opacity 150ms ease',
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden'
  };
  return /*#__PURE__*/React.createElement(React.Fragment, null, !embed && /*#__PURE__*/React.createElement("div", {
    onClick: onClose,
    style: {
      position: 'fixed',
      top: POPOUT_TOP,
      left: 0,
      right: 0,
      bottom: 0,
      zIndex: 9,
      background: dark ? 'rgba(0,0,0,.35)' : 'rgba(0,26,74,.18)'
    }
  }), /*#__PURE__*/React.createElement("div", {
    onClick: e => e.stopPropagation(),
    style: containerStyle
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      padding: '11px 14px',
      borderBottom: `0.5px solid ${K.bd2}`,
      flexShrink: 0
    }
  }, /*#__PURE__*/React.createElement("svg", {
    width: "15",
    height: "15",
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: K.gold,
    strokeWidth: "2.2",
    strokeLinecap: "round",
    strokeLinejoin: "round",
    style: {
      flexShrink: 0
    }
  }, /*#__PURE__*/React.createElement("path", {
    d: "M12 4v6"
  }), /*#__PURE__*/React.createElement("path", {
    d: "M9 7l3-3 3 3"
  }), /*#__PURE__*/React.createElement("path", {
    d: "M4 13l-2 2 2 2"
  }), /*#__PURE__*/React.createElement("path", {
    d: "M2 15h7"
  }), /*#__PURE__*/React.createElement("path", {
    d: "M20 13l2 2-2 2"
  }), /*#__PURE__*/React.createElement("path", {
    d: "M22 15h-7"
  })), /*#__PURE__*/React.createElement("span", {
    style: {
      flex: 1,
      fontFamily: J,
      fontSize: 13,
      fontWeight: 700,
      letterSpacing: '0.08em',
      textTransform: 'uppercase',
      color: K.gold
    }
  }, "Decisions"), openDecs.length > 0 && /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: J,
      fontSize: 8.5,
      fontWeight: 700,
      padding: '2px 8px',
      borderRadius: 10,
      background: dark ? 'rgba(155,28,28,0.28)' : '#FEE2E2',
      color: dark ? '#F4A6A6' : '#9B1C1C',
      flexShrink: 0
    }
  }, openDecs.length, " open"), /*#__PURE__*/React.createElement("i", {
    className: "ti ti-search",
    title: "Search (coming soon)",
    style: {
      fontSize: 15,
      color: K.muted,
      cursor: 'default',
      flexShrink: 0
    }
  }), !embed && /*#__PURE__*/React.createElement("i", {
    className: "ti ti-x",
    onClick: onClose,
    style: {
      fontSize: 17,
      color: K.muted,
      cursor: 'pointer',
      flexShrink: 0
    }
  })), wide ? /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flex: 1,
      minHeight: 0
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: 232,
      flexShrink: 0,
      borderRight: `0.5px solid ${K.bd2}`,
      background: dark ? '#08121F' : '#FCFBF8',
      overflowY: 'auto',
      paddingBottom: 12
    }
  }, !decs.length ? emptyMsg : /*#__PURE__*/React.createElement(React.Fragment, null, openDecs.length > 0 && secHead('#9B1C1C', 'Open', openDecs.length), openDecs.map(decRow), resolvedDecs.length > 0 && secHead('#0F6E56', 'Resolved', resolvedDecs.length), resolvedDecs.map(decRow))), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      minWidth: 0,
      overflowY: 'auto',
      paddingTop: 4
    }
  }, selTask ? decCard(selTask) : /*#__PURE__*/React.createElement("div", {
    style: {
      height: '100%',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '40px 24px',
      textAlign: 'center',
      color: K.muted,
      fontFamily: J
    }
  }, /*#__PURE__*/React.createElement("i", {
    className: "ti ti-gavel",
    style: {
      fontSize: 28,
      color: dark ? '#22324A' : '#D4D0CC',
      marginBottom: 12
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 11
    }
  }, "Select a decision to see its options")))) : stackedList));
}

// ─── Chat History Drawer ─────────────────────────────────────────
// Short timestamp like "11:42p", "Yest", "Mon", "Jun 3".
function shortTime(iso) {
  if (!iso) return '';
  const d = new Date(iso),
    now = new Date();
  if (d.toDateString() === now.toDateString()) {
    let h = d.getHours();
    const m = d.getMinutes();
    const ap = h >= 12 ? 'p' : 'a';
    h = h % 12 || 12;
    return h + ':' + String(m).padStart(2, '0') + ap;
  }
  const yest = new Date(now);
  yest.setDate(now.getDate() - 1);
  if (d.toDateString() === yest.toDateString()) return 'Yest';
  if (Math.floor((now - d) / 86400000) < 7) return d.toLocaleDateString('en-US', {
    weekday: 'short'
  });
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric'
  });
}

// In-flow chat history panel — fills the area between the top bar and the bottom zone.

// ─── Root App ────────────────────────────────────────────────────
// ── Hash routing: each tab / More-page gets a URL (#roadmap, #calls, …) so
// the Back button, refresh, and shareable links work. GitHub-Pages-safe
// (hash only, no server config). Overlays (calendar/tasks/profile) close on
// Back but aren't deep-linked yet. parseRoute maps a hash → {tab, view}.
const ROUTE_TABS = TABS.filter(t => t.id !== 'more').map(t => t.id);
// 'projects' deliberately omitted here (unlike index.html's copy): in this
// file #projects is the Projects list route — one hash, one meaning.
const ROUTE_MORE = ['drives', 'directory', 'expsurvey', 'sffu', 'admin', 'app-masterplan'];
function parseRoute(hash) {
  const h = (hash || '').replace(/^#\/?/, '').trim().toLowerCase();
  if (ROUTE_MORE.indexOf(h) !== -1) return {
    tab: 'more',
    view: h
  };
  if (ROUTE_TABS.indexOf(h) !== -1) return {
    tab: h,
    view: null
  };
  return {
    tab: 'chat',
    view: null
  };
}
function App({
  user,
  profile
}) {
  const [activeTab, setActiveTab] = useState(() => parseRoute(typeof location !== 'undefined' ? location.hash : '').tab);
  const [dark, setDark] = useState(() => localStorage.getItem('tmg-theme') === 'dark');
  const [fontScale, setFontScale] = useState(() => parseFloat(localStorage.getItem('tmg-fontscale')) || 1);
  const [accessCfg, setAccessCfg] = useState(DEFAULT_ACCESS);
  const [showCalendar, setShowCalendar] = useState(TASKS_HASH === 'calendar');
  const [showTasks, setShowTasks] = useState(TASKS_HASH === 'decisions' || TASKS_HASH === 'calendar' ? false : TASKS_STANDALONE);
  const [showDecisions, setShowDecisions] = useState(TASKS_HASH === 'decisions');
  const [tasksFocus, setTasksFocus] = useState(null); // a task to open directly (e.g. from the Projects tab)
  const [showProfile, setShowProfile] = useState(false);
  const [showStatus, setShowStatus] = useState(false);
  const [away, setAway] = useState(!!(profile && profile.away));
  const [statusText, setStatusText] = useState(profile && profile.status_text || '');
  const [statusEmoji, setStatusEmoji] = useState(profile && profile.status_emoji || '');

  // Admin-configurable access: filter the nav + More apps to what this user may see.
  const appSet = profile ? allowedAppSet(profile.access, accessCfg) : null; // null = everything
  const visibleTabs = appSet ? TABS.filter(t => t.id === 'more' || appSet.has(t.id)) : TABS;
  const isAdmin = hasAdmin(profile && profile.access);
  // "More" menu — Settings always; Shared Drives / Company Directory gated; Admin role-gated.
  const moreItems = [].concat(!appSet || appSet.has('drives') ? [{
    id: 'drives',
    label: 'Shared Drives',
    icon: 'ti-folders'
  }] : []).concat(!appSet || appSet.has('directory') ? [{
    id: 'directory',
    label: 'Company Directory',
    icon: 'ti-users'
  }] : []).concat([{
    id: 'projects',
    label: 'Projects',
    icon: 'ti-list-check'
  }]).concat([{
    id: 'expsurvey',
    label: 'Exp Survey',
    icon: 'ti-qrcode'
  }]).concat(!appSet || appSet.has('sffu') ? [{
    id: 'sffu',
    label: 'SFFU',
    icon: 'ti-messages'
  }] : []).concat(isAdmin ? [{
    id: 'admin',
    label: 'Admin',
    icon: 'ti-shield-lock'
  }] : []).concat(isAdmin ? [{
    id: 'app-masterplan',
    label: 'App Masterplan',
    icon: 'ti-sitemap'
  }] : []);
  // Profile / presence — the avatar chip + slide-out panel; Settings now lives there.
  const myAvatar = profile && profile.avatar_url || user && user.user_metadata && user.user_metadata.avatar_url || '';
  const myName = ((profile && profile.first_name || '') + ' ' + (profile && profile.last_name || '')).trim() || user && user.user_metadata && user.user_metadata.full_name || user && user.email || 'Me';
  const dotColor = away ? '#E0A93B' : '#2FBF6B';
  const toggleAway = () => {
    const v = !away;
    setAway(v);
    ProfileDB.setPresence({
      away: v
    });
  };
  const saveStatus = (text, emoji) => {
    setStatusText(text);
    setStatusEmoji(emoji);
    ProfileDB.setPresence({
      status_text: text || null,
      status_emoji: emoji || null
    });
    setShowStatus(false);
  };
  useEffect(() => {
    if (!visibleTabs.some(t => t.id === activeTab)) setActiveTab((visibleTabs[0] || {
      id: 'more'
    }).id);
  }, [profile]);

  // Chat state (lifted so the input lives in the shared bottom zone)
  const [messages, setMessages] = useState([]); // { role:'user'|'assistant', content, error? }
  const [input, setInput] = useState(() => localStorage.getItem('tmg-draft-new') || '');
  const [loading, setLoading] = useState(false);
  const [pendingAttachments, setPendingAttachments] = useState([]); // { id, file, kind, name, mediaType, size, previewUrl, textContent }
  const [mode, setMode] = useState(() => localStorage.getItem('tmg-mode') || 'ai');

  // Conversation persistence + history
  const [conversations, setConversations] = useState([]);
  const [currentConvId, setCurrentConvId] = useState(null);
  const [workRequest, setWorkRequest] = useState(null); // 'kpis' | 'listing_presentation' | null
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [historySide, setHistorySide] = useState(() => localStorage.getItem('tmg-history-side') || 'left');

  // Work Mode pills (admin-configurable)
  const [pills, setPills] = useState(null);
  const [builderOpen, setBuilderOpen] = useState(false);
  const [activePill, setActivePill] = useState(null); // { pill, kind: 'form'|'steps' }
  const [taskInstruction, setTaskInstruction] = useState(null); // armed by the Add To-Do pill → next send creates a task
  const [kpiInstruction, setKpiInstruction] = useState(null); // armed by Enter KPI "paste your notes" → next send parses a KPI note
  const [kpiFlow, setKpiFlow] = useState(null); // inline Enter KPI card: { step:'choice'|'form'|'summary', payload? }

  // "More" menu: which screen (settings | admin) + dropdown open state.
  const [moreView, setMoreView] = useState(() => parseRoute(typeof location !== 'undefined' ? location.hash : '').view || 'directory');
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);

  // ── URL hash <-> nav state ──
  const firstSync = useRef(true);
  useEffect(() => {
    const apply = () => {
      const r = parseRoute(location.hash);
      setActiveTab(r.tab);
      if (r.tab === 'more' && r.view) setMoreView(r.view);
      setMoreMenuOpen(false);
      setDrawerOpen(false);
      setShowProfile(false);
      setShowStatus(false);
      // Recompute which popout should be visible from the FRESH hash (not the
      // stale page-load TASKS_HASH const) — mirrors the initial useState logic
      // below. Previously this just blanked all three with nothing to restore
      // them, so any hashchange/popstate left the standalone page blank.
      const rawHash = (location.hash || '').replace('#', '').toLowerCase();
      setShowCalendar(rawHash === 'calendar');
      setShowDecisions(rawHash === 'decisions');
      setShowTasks(rawHash === 'decisions' || rawHash === 'calendar' ? false : TASKS_STANDALONE);
    };
    window.addEventListener('popstate', apply);
    window.addEventListener('hashchange', apply);
    return () => {
      window.removeEventListener('popstate', apply);
      window.removeEventListener('hashchange', apply);
    };
  }, []);
  useEffect(() => {
    if (location.hash.indexOf('=') !== -1) return; // never clobber the OAuth #access_token=... hash
    if (isDeepRoute(location.hash)) return; // nor any deep-link route (#task/<id>, #ctc/<id>/board, …)
    const token = activeTab === 'more' ? moreView || 'directory' : activeTab;
    if (location.hash.replace(/^#\/?/, '') !== token) {
      try {
        firstSync.current ? history.replaceState(null, '', '#' + token) : history.pushState(null, '', '#' + token);
      } catch (e) {
        location.hash = token;
      }
    }
    firstSync.current = false;
  }, [activeTab, moreView]);
  const zoneRef = useRef(null);
  const fileInputRef = useRef(null);
  const [zoneH, setZoneH] = useState(96);
  const onChat = activeTab === 'chat';
  function openFilePicker() {
    if (fileInputRef.current) fileInputRef.current.click();
  }
  async function onSelectFiles(fileList) {
    const files = Array.from(fileList || []);
    const additions = [];
    for (const file of files) {
      if (file.size > 20 * 1024 * 1024) {
        alert('"' + file.name + '" is over 20 MB and was skipped.');
        continue;
      }
      const type = file.type || '';
      const name = file.name || '';
      let kind = null,
        textContent = null,
        previewUrl = null;
      try {
        if (type.startsWith('image/')) {
          kind = 'image';
          previewUrl = URL.createObjectURL(file);
        } else if (type === 'application/pdf' || /\.pdf$/i.test(name)) {
          kind = 'pdf';
        } else if (/\.(xlsx|xls)$/i.test(name)) {
          kind = 'text';
          textContent = await readXlsxAsText(file);
        } else if (/\.docx$/i.test(name)) {
          kind = 'text';
          textContent = await readDocxAsText(file);
        } else if (/\.pptx$/i.test(name)) {
          kind = 'text';
          textContent = await readPptxAsText(file);
        } else if (/\.(doc|ppt)$/i.test(name)) {
          alert('"' + name + '" is an older Office format the app can\'t read. Please re-save it as .docx or .pptx and try again.');
          continue;
        } else if (type.startsWith('text/') || /\.(txt|csv|md|json|log)$/i.test(name)) {
          kind = 'text';
          textContent = await file.text();
        } else {
          alert('The AI can\'t read "' + name + '" yet (unsupported type).');
          continue;
        }
      } catch (e) {
        alert('Could not read "' + name + '": ' + (e.message || e));
        continue;
      }
      additions.push({
        id: crypto.randomUUID(),
        file,
        kind,
        name,
        mediaType: type,
        size: file.size,
        previewUrl,
        textContent
      });
    }
    if (additions.length) setPendingAttachments(prev => [...prev, ...additions]);
  }
  function removeAttachment(id) {
    setPendingAttachments(prev => prev.filter(a => {
      if (a.id === id && a.previewUrl) {
        try {
          URL.revokeObjectURL(a.previewUrl);
        } catch (e) {}
      }
      return a.id !== id;
    }));
  }
  const refreshConversations = () => ConvDB.loadConversations().then(setConversations);
  useEffect(() => {
    refreshConversations();
  }, []);
  const refreshPills = () => PillDB.list().then(setPills);
  useEffect(() => {
    refreshPills();
  }, []);
  // First-run: materialize the default pills into the DB so they're editable in Admin
  // (incl. the Add To-Do task pill). Guarded so deleting all pills won't respawn them.
  const pillsSeededRef = useRef(false);
  useEffect(() => {
    if (!isAdmin || pills === null || pills.length > 0 || pillsSeededRef.current) return;
    if (localStorage.getItem('tmg-pills-seeded')) return;
    pillsSeededRef.current = true;
    (async () => {
      try {
        for (let i = 0; i < FALLBACK_PILLS.length; i++) await PillDB.create({
          ...FALLBACK_PILLS[i],
          sortOrder: i
        });
        localStorage.setItem('tmg-pills-seeded', '1');
        refreshPills();
      } catch (e) {
        console.warn('[pills] seed:', e);
      }
    })();
  }, [pills, isAdmin]);
  // Effective pills: DB pills when present, else the built-in fallback; only enabled ones show.
  const effectivePills = (pills && pills.length ? pills : FALLBACK_PILLS).filter(p => p.enabled !== false);
  useEffect(() => {
    localStorage.setItem('tmg-history-side', historySide);
  }, [historySide]);

  // Per-conversation draft autosave (device-local). Key 'new' before a conversation exists.
  const draftKey = id => 'tmg-draft-' + (id || 'new');
  function updateInput(val) {
    setInput(val);
    try {
      localStorage.setItem(draftKey(currentConvId), val);
    } catch (e) {}
  }
  useEffect(() => {
    document.body.classList.toggle('dark', dark);
    localStorage.setItem('tmg-theme', dark ? 'dark' : 'light');
  }, [dark]);

  // App-wide text/UI scale (iPhone-style). Applied as page zoom; persisted.
  useEffect(() => {
    localStorage.setItem('tmg-fontscale', String(fontScale));
    document.documentElement.style.zoom = fontScale === 1 ? '' : String(fontScale);
  }, [fontScale]);

  // Load the per-tool role-access config (gates this user's tabs + More apps).
  useEffect(() => {
    AccessDB.load().then(c => {
      if (c) setAccessCfg(normalizeAccess(c));
    });
  }, []);

  // Presence heartbeat: mark "online" now + every minute while the app is open/foreground.
  useEffect(() => {
    ProfileDB.touchPresence();
    const iv = setInterval(() => {
      if (!document.hidden) ProfileDB.touchPresence();
    }, 60000);
    const onVis = () => {
      if (!document.hidden) ProfileDB.touchPresence();
    };
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('focus', onVis);
    return () => {
      clearInterval(iv);
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('focus', onVis);
    };
  }, []);
  useEffect(() => {
    localStorage.setItem('tmg-mode', mode);
  }, [mode]);

  // Keep content padding in sync with the fixed bottom zone height.
  useEffect(() => {
    if (zoneRef.current) setZoneH(zoneRef.current.offsetHeight);
  }, [activeTab, dark, onChat, input, loading, pendingAttachments]);

  // Core send: persists the user message, gets a reply, persists it, auto-titles a new conversation.
  async function runSend(text, opts = {}) {
    const pend = opts.attachments !== undefined ? opts.attachments : pendingAttachments;
    if ((!text || !text.trim()) && (!pend || !pend.length)) return;
    if (loading) return;
    const startType = opts.type || (mode === 'work' ? 'work' : 'ai');
    const startReq = opts.workRequest !== undefined ? opts.workRequest : workRequest;
    const isFirst = !currentConvId;

    // Optimistic user message with local previews; clear the picker immediately.
    const localAtts = (pend || []).map(a => ({
      kind: a.kind,
      name: a.name,
      mediaType: a.mediaType,
      size: a.size,
      url: a.previewUrl,
      textContent: a.textContent
    }));
    const userMsg = {
      role: 'user',
      content: text || '',
      attachments: localAtts
    };
    const next = [...messages, userMsg];
    setMessages(next);
    setPendingAttachments([]);
    setLoading(true);
    let convId = currentConvId;
    try {
      if (!convId) {
        const conv = await ConvDB.createConversation({
          type: startType,
          workRequest: startReq
        });
        convId = conv.id;
        setCurrentConvId(convId);
        refreshConversations();
      }
      // Upload pending files, then resolve signed URLs (needed for Claude + display).
      const uploaded = [];
      for (const a of pend || []) {
        let path = null;
        if (a.file) {
          try {
            path = await ConvDB.uploadAttachment(a.file, convId);
          } catch (e) {}
        }
        const url = path ? await ConvDB.signedUrl(path) : a.previewUrl;
        uploaded.push({
          kind: a.kind,
          name: a.name,
          mediaType: a.mediaType,
          size: a.size,
          path,
          url,
          textContent: a.textContent
        });
      }
      const history = next.map((m, idx) => idx === next.length - 1 ? {
        ...m,
        attachments: uploaded
      } : m);
      setMessages(history);
      await ConvDB.insertMessage(convId, 'user', text || '', uploaded);
      const apiMsgs = history.map(m => ({
        role: m.role,
        content: toApiContent(m)
      }));
      const armed = taskInstruction || kpiInstruction;
      const sys = armed ? armed + '\n\nToday is ' + new Date().toISOString().slice(0, 10) + '.' : undefined;
      const reply = await callAI(apiMsgs, sys);
      // Add To-Do mode: the AI ends with an ACTION block — read it, create the task, hide the JSON.
      let display = reply;
      if (taskInstruction) {
        const mm = reply.match(/ACTION:\s*(\{[\s\S]*\})\s*$/);
        if (mm) {
          display = reply.slice(0, mm.index).trim();
          try {
            const parsed = JSON.parse(mm[1]);
            if (parsed && String(parsed.type).toUpperCase() === 'ADD' && parsed.payload) {
              const created = await createTaskFromAI(parsed.payload, user);
              if (!display) display = created ? 'Done — added “' + (parsed.payload.title || 'task') + '” to your Tasks.' : 'I couldn’t create that — please try again.';
              if (created) setTaskInstruction(null); // task created → leave to-do mode
            }
          } catch (e) {/* keep the stripped conversational text */}
        }
      } else if (kpiInstruction) {
        // Enter KPI "paste your notes": the AI ends with an ACTION block. KPI → open the summary card for
        // confirmation (don't submit yet); NONE → it's asking a follow-up (e.g. a hotzone count). Hide the JSON.
        const mm = reply.match(/ACTION:\s*(\{[\s\S]*\})\s*$/);
        if (mm) {
          display = reply.slice(0, mm.index).trim();
          try {
            const parsed = JSON.parse(mm[1]);
            if (parsed && String(parsed.type).toUpperCase() === 'KPI' && parsed.payload) {
              const payload = {
                ...parsed.payload,
                owner: myName
              }; // owner is app-side, never from the model
              setKpiInstruction(null); // got a full payload → leave note mode; confirm via the card
              setKpiFlow({
                step: 'summary',
                payload
              });
              if (!display) display = 'Here’s what I got — review and confirm below.';
            }
          } catch (e) {/* keep the stripped conversational text */}
        }
      }
      if (!display) display = reply;
      setMessages(prev => [...prev, {
        role: 'assistant',
        content: display
      }]);
      await ConvDB.insertMessage(convId, 'assistant', display);
      if (isFirst) {
        const seed = text || uploaded[0] && uploaded[0].name || 'Shared a file';
        const title = await generateTitle(seed);
        await ConvDB.updateConversation(convId, {
          title
        });
      } else {
        await ConvDB.touchConversation(convId);
      }
    } catch (e) {
      setMessages(prev => [...prev, {
        role: 'assistant',
        content: String(e.message || e),
        error: true
      }]);
    } finally {
      setLoading(false);
      refreshConversations();
    }
  }
  function send() {
    const text = input.trim();
    if (!text && !pendingAttachments.length || loading) return;
    try {
      localStorage.removeItem(draftKey(currentConvId));
    } catch (e) {}
    setInput('');
    runSend(text);
  }
  function newChat() {
    setMessages([]);
    setCurrentConvId(null);
    setWorkRequest(null);
    setTaskInstruction(null);
    setKpiInstruction(null);
    setKpiFlow(null);
    setInput(localStorage.getItem('tmg-draft-new') || '');
  }
  function toggleMode() {
    setMode(m => m === 'work' ? 'ai' : 'work');
    newChat();
  }
  async function selectConversation(id) {
    const conv = conversations.find(c => c.id === id);
    setDrawerOpen(false);
    setCurrentConvId(id);
    setTaskInstruction(null);
    setKpiInstruction(null);
    setKpiFlow(null);
    setInput(localStorage.getItem(draftKey(id)) || '');
    setWorkRequest(conv?.workRequest || null);
    if (conv) setMode(conv.type === 'work' ? 'work' : 'ai');
    setActiveTab('chat');
    const msgs = await ConvDB.loadMessages(id);
    setMessages(msgs);
  }

  // Enter KPI — arm the paste-a-note parser (mirrors the task-pill arm), seeding the input.
  function startKpiNote() {
    setKpiFlow(null);
    setTaskInstruction(null);
    setKpiInstruction(KPI_NOTE_INSTRUCTION);
    setInput('KPI: ');
    setTimeout(() => {
      const el = document.querySelector('.tmg-ai-input');
      if (el) {
        el.focus();
        try {
          const n = el.value.length;
          el.setSelectionRange(n, n);
        } catch (e) {}
      }
    }, 30);
  }

  // Confirm step → finalize. Phase A (KPI_LIVE=false): preview only, no network. Persists the preview message.
  async function submitKpi(rawPayload) {
    // Owner is always the logged-in submitter, set here (the single funnel for both the
    // form and paste-notes flows) so it can't be missed or spoofed by either path.
    const payload = {
      ...rawPayload,
      owner: myName,
      owner_email: profile && profile.email || null
    };
    setKpiFlow(null);
    const preview = formatKpiPreview(payload);
    let content;
    if (KPI_LIVE) {
      try {
        const res = await createAgentKpi(payload);
        content = 'Submitted to Zoho — Agent KPI created' + (res && res.id ? ' (id ' + res.id + ')' : '') + '.\n\n' + preview;
        // Zoho silently reassigns the record when the submitter can't be matched to a Zoho
        // user — say so here rather than letting it be found later in the CRM.
        if (res && res.owner_warning) content += '\n\n⚠️ Owner not set to you: ' + res.owner_warning;
      } catch (e) {
        content = 'Could not submit to Zoho: ' + (e.message || e) + '\n\nHere is what would have been sent:\n\n' + preview;
      }
    } else {
      content = 'Here is your KPI summary (preview — not yet sent to Zoho):\n\n' + preview;
    }
    setMessages(prev => [...prev, {
      role: 'assistant',
      content
    }]);
    // The quick "Add KPIs" form never starts a normal chat, so currentConvId is usually null
    // here — without this, the submitted values (date/CTC/persons/others) existed nowhere but
    // this screen and vanished on navigation, with no way to check them against Zoho later.
    // Create a real conversation on the fly so every submission is durably saved.
    let cid = currentConvId;
    if (!cid) {
      try {
        const conv = await ConvDB.createConversation({
          type: 'kpi',
          workRequest: 'Enter KPI',
          title: 'KPI — ' + (payload.kpi_date || kpiTodayStr())
        });
        cid = conv.id;
        setCurrentConvId(cid);
        refreshConversations();
      } catch (e) {/* best-effort — the confirmation above still shows on screen either way */}
    }
    if (cid) {
      try {
        await ConvDB.insertMessage(cid, 'assistant', content);
        await ConvDB.touchConversation(cid);
      } catch (e) {}
    }
  }

  // Tap a work-mode pill → run its configured behavior.
  function dispatchPill(pill) {
    if (!pill) return;
    if (pill.id === 'fb-kpis' || pill.config && pill.config.kpi) {
      setTaskInstruction(null);
      setKpiInstruction(null);
      setMessages(prev => [...prev, {
        role: 'assistant',
        content: 'Let’s get started 👋 — would you like to fill out a form, or paste your notes?'
      }]);
      setKpiFlow({
        step: 'choice'
      });
      return;
    }
    if (pill.type === 'form') {
      setActivePill({
        pill,
        kind: 'form'
      });
      return;
    }
    if (pill.type === 'steps') {
      setActivePill({
        pill,
        kind: 'steps'
      });
      return;
    }
    setKpiFlow(null);
    setKpiInstruction(null);
    if (pill.type === 'task') {
      setTaskInstruction(pill.config && pill.config.instruction || TASK_PILL_INSTRUCTION);
      let seed = pill.config && pill.config.seed;
      if (!seed || seed === 'Add To Do: ') seed = 'To Do: '; // default + upgrade the old prefill
      setInput(seed);
      setTimeout(() => {
        const el = document.querySelector('.tmg-ai-input');
        if (el) {
          el.focus();
          try {
            const n = el.value.length;
            el.setSelectionRange(n, n);
          } catch (e) {}
        }
      }, 30);
      return;
    }
    const text = pill.config && pill.config.prompt || pill.label; // prompt (default)
    runSend(text, {
      type: 'work'
    });
  }
  function startWorkRequest(key) {
    const req = WORK_REQUESTS.find(w => w.key === key);
    if (!req) return;
    setMode('work');
    setWorkRequest(key);
    setCurrentConvId(null);
    setMessages([]);
    runSend(req.label, {
      type: 'work',
      workRequest: key
    });
  }
  async function pinConversation(id, pinned) {
    await ConvDB.updateConversation(id, {
      pinned
    });
    refreshConversations();
  }
  async function archiveConversation(id, archived) {
    await ConvDB.updateConversation(id, {
      archived
    });
    if (id === currentConvId) newChat();
    refreshConversations();
  }
  async function renameConversation(id) {
    const conv = conversations.find(c => c.id === id);
    const title = window.prompt('Rename conversation', conv?.title || '');
    if (title && title.trim()) {
      await ConvDB.updateConversation(id, {
        title: title.trim()
      });
      refreshConversations();
    }
  }
  async function removeConversation(id) {
    if (!window.confirm('Delete this conversation permanently?')) return;
    await ConvDB.deleteConversation(id);
    try {
      localStorage.removeItem(draftKey(id));
    } catch (e) {}
    if (id === currentConvId) newChat();
    refreshConversations();
  }

  // Embedded in the main app's iframe popout → render ONLY the active task surface,
  // no top bar / bottom nav / chat behind. POPOUT_TOP is 0 so it fills the iframe.
  if (TASKS_EMBED) {
    return /*#__PURE__*/React.createElement("div", {
      style: {
        height: '100%',
        background: dark ? '#000D26' : C.bg,
        color: C.textPrimary
      }
    }, showCalendar && /*#__PURE__*/React.createElement(CalendarPopover, {
      dark: dark,
      zoneH: 0,
      onOpenTask: t => {
        setShowCalendar(false);
        setShowTasks(true);
        setTasksFocus(t);
      },
      onClose: () => {}
    }), showTasks && /*#__PURE__*/React.createElement(TasksScreen, {
      dark: dark,
      user: user,
      initialTask: tasksFocus,
      onClose: () => {}
    }), showDecisions && /*#__PURE__*/React.createElement(DecisionsPopover, {
      dark: dark,
      zoneH: 0,
      onOpenTask: t => {
        setShowDecisions(false);
        setShowTasks(true);
        setTasksFocus(t);
      },
      onClose: () => {}
    }));
  }

  // Standalone /tasks page (e.g. opened from More → Tasks): task-focused — keep the
  // top bar (for switching Tasks/Decisions/Calendar + profile), drop the chat + input bar.
  if (TASKS_STANDALONE) {
    return /*#__PURE__*/React.createElement("div", {
      style: {
        height: '100%',
        background: dark ? '#000D26' : C.bg,
        display: 'flex',
        flexDirection: 'column',
        color: C.textPrimary
      }
    }, /*#__PURE__*/React.createElement(TopBar, {
      dark: dark,
      onToggleDark: () => setDark(d => !d),
      onCalendar: () => {
        setShowCalendar(s => !s);
        setShowTasks(false);
        setShowDecisions(false);
      },
      calendarOpen: showCalendar,
      onTasks: () => {
        setShowTasks(s => !s);
        setShowCalendar(false);
        setShowDecisions(false);
        setTasksFocus(null);
      },
      tasksOpen: showTasks,
      onDecisions: () => {
        setShowDecisions(s => !s);
        setShowCalendar(false);
        setShowTasks(false);
      },
      decisionsOpen: showDecisions,
      avatar: myAvatar,
      name: myName,
      dotColor: dotColor,
      onProfile: () => setShowProfile(true)
    }), showCalendar && /*#__PURE__*/React.createElement(CalendarPopover, {
      dark: dark,
      zoneH: 0,
      onOpenTask: t => {
        setShowCalendar(false);
        setShowTasks(true);
        setTasksFocus(t);
      },
      onClose: () => {
        setShowCalendar(false);
        setShowTasks(true);
      }
    }), showTasks && /*#__PURE__*/React.createElement(TasksScreen, {
      dark: dark,
      user: user,
      initialTask: tasksFocus,
      onClose: () => {
        setTasksFocus(null);
      }
    }), showDecisions && /*#__PURE__*/React.createElement(DecisionsPopover, {
      dark: dark,
      zoneH: 0,
      onOpenTask: t => {
        setShowDecisions(false);
        setShowTasks(true);
        setTasksFocus(t);
      },
      onClose: () => {
        setShowDecisions(false);
        setShowTasks(true);
      }
    }), !showCalendar && !showTasks && !showDecisions && /*#__PURE__*/React.createElement("div", {
      style: {
        flex: 1
      }
    }), showProfile && /*#__PURE__*/React.createElement(ProfilePanel, {
      dark: dark,
      user: user,
      profile: profile,
      name: myName,
      avatar: myAvatar,
      dotColor: dotColor,
      away: away,
      statusText: statusText,
      statusEmoji: statusEmoji,
      onToggleAway: toggleAway,
      onOpenStatus: () => setShowStatus(true),
      onClose: () => setShowProfile(false),
      historySide: historySide,
      setHistorySide: setHistorySide,
      setDark: setDark,
      fontScale: fontScale,
      setFontScale: setFontScale
    }), showStatus && /*#__PURE__*/React.createElement(StatusModal, {
      dark: dark,
      initialText: statusText,
      initialEmoji: statusEmoji,
      onSave: saveStatus,
      onClose: () => setShowStatus(false)
    }));
  }
  return null;
}

// ─── Mount ───────────────────────────────────────────────────────
(function mount() {
  const root = ReactDOM.createRoot(document.getElementById('root'));
  const AUTHORIZED_DOMAIN = 'themorshedgroup.com';
  function _showScreen(id) {
    ['splash-screen', 'login-screen', 'denied-screen', 'pending-screen'].forEach(function (s) {
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
  if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1' || window.location.protocol === 'file:') {
    root.render( /*#__PURE__*/React.createElement(App, {
      user: window.SupabaseAuth._state.session?.user,
      profile: {
        id: 'dev-user-id',
        email: 'symon@morshedgroup.com',
        first_name: 'Symon',
        last_name: 'Yongco',
        title: 'Operations Manager',
        employee_id: 'TMG-001',
        access: 'admin',
        status: 'active',
        avatar_url: ''
      }
    }));
    hideOverlay();
    return;
  }
  window.SupabaseAuth.onAuthStateChange(async function ({
    session
  }) {
    if (!session) {
      showSignin();
      return;
    }
    // Domain gate: only TMG Workspace accounts may enter; others see Access Denied.
    const email = (session.user.email || '').toLowerCase();
    if (!email.endsWith('@' + AUTHORIZED_DOMAIN)) {
      showRejected();
      return;
    }
    const profile = await ProfileDB.ensureProfile(session.user);
    // Gate: a profile that exists but isn't active is blocked. No profile (error/not-yet-set-up) → fail open.
    if (profile && profile.status === 'pending') {
      showPending();
      return;
    }
    if (profile && profile.status && profile.status !== 'active') {
      showRejected();
      return;
    }
    // One-time: persist the Google refresh token captured at sign-in so the calendar can sync.
    const grt = window.SupabaseAuth._googleRefresh;
    if (grt) {
      window.SupabaseAuth._googleRefresh = null;
      connectGoogleCalendar(grt);
    }
    root.render( /*#__PURE__*/React.createElement(App, {
      user: session.user,
      profile: profile
    }));
    hideOverlay();
  });
})();