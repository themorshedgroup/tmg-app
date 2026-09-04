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
| `src/crm.jsx`, `src/crm-tasks.jsx`, `src/chat.jsx`, `src/timeoff.jsx`, `src/sffu.jsx` | their HTML files |

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
