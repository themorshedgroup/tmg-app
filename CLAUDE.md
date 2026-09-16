# TMG App — working notes for Claude sessions

Several sessions share this working tree and push independently. Read this
before editing.

## The pages are compiled now — do NOT paste JSX into the HTML

Each page's React/JSX lives in `src/<page>.jsx`. The HTML file loads a
compiled `build/<page>.js`. Editing the HTML's markup, styles or inline
`<script>` blocks is still fine — but **the app code is in `src/`.**

| Edit this | Not this |
|---|---|
| `src/index.jsx` | the old inline `<script type="text/babel">` in `index.html` |
| `src/tasks.jsx` | `tasks.html` |
| `src/crm.jsx`, `src/crm-tasks.jsx`, `src/timeoff.jsx`, `src/sffu.jsx` | their HTML files |

Why: the browser used to translate ~1.65MB of JSX on *every* page load —
about 2.3 seconds of dead time on `index.html` before anything appeared.
Compiling ahead of time removed that, and dropped `index.html` from 713KB
to 88KB.

## The build runs itself

A pre-commit hook (`.githooks/pre-commit`) rebuilds and stages `build/*.js`
on every commit, so the deployed code can never drift from `src/`. Nothing
to remember.

If you cloned fresh, or the hook complains about missing deps:

    npm install --prefix tools/build
    git config core.hooksPath .githooks

To build by hand, or check for staleness without writing:

    node tools/build/build-jsx.mjs
    node tools/build/build-jsx.mjs --check

## Deployment

`main` is served by GitHub Pages at **app.themorshedgroup.com** — a push is a
deploy, and the repo is **public**. Never commit secrets, and never embed
data in a page that should be login-gated (it would be readable straight from
GitHub regardless of the in-app login).

The deploy token lacks the `workflow` scope, so pushes that add or edit
anything under `.github/workflows/` are rejected by GitHub.

## Third-party libraries

Pin every CDN version — a floating `@babel` URL broke login once. The heavy
Office libraries (xlsx, mammoth, jszip, docx, pptxgenjs, ~1.9MB) load on
first use via `ensureLib()`, not on page load; their pinned URLs live in the
`window.CDN` map near the top of `index.html`.

## Every new record carries the person who made it

A record created from the app belongs to whoever was signed in, never to the
API connection. Zoho files an `Owner`-less record under the connection's own
user, so a create path that forgets this silently puts everyone's work under
one person's name — which is how goals, KPIs and parties each ended up
attributed to the wrong person, one forgotten call site at a time.

So: **any new create path sets the author before it ships.**

| Where | How |
|---|---|
| Zoho CRM (`zoho-crm`) | `ownerForCaller(...)` → put its `owner` on the record, return its `warning` to the UI |
| Zoho Projects (`zoho-projects`) | `resolveZohoOwnerIds(...)` → `person_responsible`. Zoho's own "created by" always shows the connection — per-user OAuth would be the only fix, and we don't have it |
| Our own tables | `created_by: user?.id` (or `added_by_id` / `author_id`, matching the table) |

And the warning is shown, never swallowed: a record saved under the wrong name
looks identical to one saved correctly, so silence means it repeats for months.
