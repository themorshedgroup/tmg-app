// Compiles each page's JSX ahead of time.
//
// Before: every page shipped its JSX inline as <script type="text/babel">, plus
// Babel itself (584KB), and the browser translated ~1.65MB of code on EVERY
// visit -- about 2.3s of dead time on index.html alone.
//
// Now: the JSX for each page lives in src/<page>.jsx (edit that), and this
// script compiles it to build/<page>.js, which the page loads with `defer`.
// `defer` matters: type="text/babel" ran after parsing, so the code may assume
// the DOM exists. defer preserves that timing; a plain <script src> would not.
//
// Run:  node tools/build/build-jsx.mjs          (compile; fails if stale)
//       node tools/build/build-jsx.mjs --check  (verify only, no writes)
//
// The pre-commit hook runs this automatically. See CLAUDE.md.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Babel from "@babel/standalone";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CHECK = process.argv.includes("--check");

// page html -> logical name used for src/<name>.jsx and build/<name>.js
export const PAGES = {
  "index.html": "index",
  "crm.html": "crm",
  "crm-tasks.html": "crm-tasks",
  "chat.html": "chat",
  "timeoff.html": "timeoff",
  "tasks.html": "tasks",
  "sffu/index.html": "sffu",
};

const BABEL_TAG = /\s*<script src="https:\/\/unpkg\.com\/@babel\/standalone@[^"]*"><\/script>\n?/;
const INLINE = /<script[^>]*type="text\/babel"[^>]*>([\s\S]*?)<\/script>/;

function compile(jsx, name) {
  return Babel.transform(jsx, {
    presets: ["react"],
    filename: `${name}.jsx`,
    compact: false,
    comments: true,
  }).code;
}

function relPrefix(htmlPath) {
  // sffu/index.html must reach ../build/sffu.js
  return htmlPath.includes("/") ? "../" : "";
}

let changed = 0, stale = [];

for (const [html, name] of Object.entries(PAGES)) {
  const htmlPath = join(ROOT, html);
  if (!existsSync(htmlPath)) { console.warn(`skip (missing): ${html}`); continue; }

  const srcPath = join(ROOT, "src", `${name}.jsx`);
  const outPath = join(ROOT, "build", `${name}.js`);
  let page = readFileSync(htmlPath, "utf8");

  // First run for a page: lift the inline JSX out into src/ and repoint the html.
  const inline = page.match(INLINE);
  if (inline) {
    if (CHECK) { stale.push(`${html} still has inline JSX`); continue; }
    mkdirSync(dirname(srcPath), { recursive: true });
    writeFileSync(srcPath, inline[1].replace(/^\n/, ""));
    const tag =
      `  <!-- Compiled ahead of time from src/${name}.jsx -- DO NOT paste JSX back in here.\n` +
      `       Edit src/${name}.jsx; the pre-commit hook rebuilds build/${name}.js. -->\n` +
      `  <script defer src="${relPrefix(html)}build/${name}.js"></script>`;
    page = page.replace(INLINE, tag).replace(BABEL_TAG, "\n");
    writeFileSync(htmlPath, page);
    console.log(`lifted  ${html} -> src/${name}.jsx`);
  }

  if (!existsSync(srcPath)) { console.warn(`skip (no source): src/${name}.jsx`); continue; }

  const jsx = readFileSync(srcPath, "utf8");
  const code = compile(jsx, name);
  const prev = existsSync(outPath) ? readFileSync(outPath, "utf8") : null;
  if (prev !== code) {
    if (CHECK) { stale.push(`build/${name}.js is out of date`); continue; }
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, code);
    changed++;
    console.log(`built   src/${name}.jsx -> build/${name}.js (${Math.round(code.length / 1024)}KB)`);
  }
}

if (CHECK && stale.length) {
  console.error("Build is stale:\n  " + stale.join("\n  ") + "\n\nRun: node tools/build/build-jsx.mjs");
  process.exit(1);
}
console.log(CHECK ? "build is up to date" : `done (${changed} file(s) written)`);
