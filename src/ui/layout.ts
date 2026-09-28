import type { Html, Interpolation } from "./html.ts";
import { html, raw } from "./html.ts";

const css = `
:root {
  color-scheme: light dark;
  --bg: #f7f7f8; --panel: #fff; --text: #1b1c1f; --muted: #6b6f76;
  --border: #e3e4e8; --accent: #3b5bdb; --accent-text: #fff;
  --ok: #2f9e44; --warn: #e8a317; --bad: #e03131; --none: #d9dbe0;
  --partial: #a6abb5; --ok-bg: #e6f6ea; --bad-bg: #fdecec; --warn-bg: #fff6e0;
  --radius: 10px;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #111214; --panel: #1a1b1e; --text: #e6e7ea; --muted: #9a9ea6;
    --border: #2c2e33; --accent: #7c93f5; --accent-text: #111214;
    --ok: #40c057; --warn: #f0b429; --bad: #ff6b6b; --none: #2c2e33;
    --partial: #5c616b; --ok-bg: #16301d; --bad-bg: #3a1a1a; --warn-bg: #3a2f12;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0; background: var(--bg); color: var(--text);
  font: 15px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
}
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
header.top {
  display: flex; align-items: center; gap: 1.5rem; padding: .75rem 1.5rem;
  background: var(--panel); border-bottom: 1px solid var(--border);
}
header.top .brand { font-weight: 700; color: var(--text); letter-spacing: .02em; }
header.top nav { display: flex; gap: 1rem; flex: 1; }
header.top nav a { color: var(--muted); }
header.top nav a[aria-current] { color: var(--text); font-weight: 600; }
main { max-width: 1040px; margin: 0 auto; padding: 1.5rem; }
h1 { font-size: 1.5rem; margin: 0 0 .25rem; }
h2 { font-size: 1.1rem; margin: 2rem 0 .75rem; }
.muted { color: var(--muted); }
.small { font-size: .85rem; }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .85em; word-break: break-all; }
.panel {
  background: var(--panel); border: 1px solid var(--border);
  border-radius: var(--radius); padding: 1rem 1.25rem;
}
.row { display: flex; gap: .75rem; align-items: center; flex-wrap: wrap; }
.spread { justify-content: space-between; }
.stack > * + * { margin-top: 1rem; }
table { width: 100%; border-collapse: collapse; }
th, td { text-align: left; padding: .55rem .6rem; border-bottom: 1px solid var(--border); vertical-align: middle; }
th { font-size: .75rem; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); font-weight: 600; }
tr:last-child td { border-bottom: 0; }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
.table-wrap { overflow-x: auto; }
.dot { display: inline-block; width: .6rem; height: .6rem; border-radius: 50%; background: var(--none); margin-right: .4rem; }
.dot.up { background: var(--ok); } .dot.down { background: var(--bad); }
.dot.unknown { background: var(--partial); } .dot.paused { background: var(--none); outline: 1px solid var(--partial); }
.badge {
  display: inline-block; padding: .05rem .5rem; border-radius: 999px; font-size: .75rem;
  font-weight: 600; border: 1px solid var(--border); color: var(--muted); white-space: nowrap;
}
.badge.up { background: var(--ok-bg); color: var(--ok); border-color: transparent; }
.badge.down { background: var(--bad-bg); color: var(--bad); border-color: transparent; }
.badge.warn { background: var(--warn-bg); color: var(--warn); border-color: transparent; }
button, .button {
  font: inherit; font-size: .9rem; cursor: pointer; display: inline-block;
  padding: .4rem .85rem; border-radius: 8px; border: 1px solid var(--border);
  background: var(--panel); color: var(--text); text-decoration: none; line-height: 1.4;
}
button:hover, .button:hover { border-color: var(--muted); text-decoration: none; }
button.primary, .button.primary { background: var(--accent); color: var(--accent-text); border-color: var(--accent); }
button.danger { color: var(--bad); }
form.inline { display: inline; margin: 0; }
label { display: block; font-weight: 600; font-size: .85rem; margin-bottom: .25rem; }
label.check { display: flex; gap: .5rem; align-items: center; font-weight: 400; font-size: .95rem; }
input[type=text], input[type=url], input[type=number], input[type=password], select {
  font: inherit; width: 100%; padding: .45rem .6rem; border-radius: 8px;
  border: 1px solid var(--border); background: var(--bg); color: var(--text);
}
input:focus, select:focus, button:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.hint { font-weight: 400; color: var(--muted); font-size: .8rem; margin-top: .2rem; }
.grid { display: grid; gap: 1rem; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); }
.field { margin-bottom: 0; }
fieldset { border: 1px solid var(--border); border-radius: 8px; padding: .75rem 1rem; margin: 0; }
legend { font-weight: 600; font-size: .85rem; padding: 0 .25rem; }
.flash { padding: .7rem 1rem; border-radius: 8px; margin-bottom: 1rem; border: 1px solid var(--border); background: var(--panel); }
.flash.ok { background: var(--ok-bg); border-color: transparent; }
.flash.error { background: var(--bad-bg); border-color: transparent; white-space: pre-wrap; }
.flash.warn { background: var(--warn-bg); border-color: transparent; }
.stats { display: flex; gap: 1.5rem; flex-wrap: wrap; }
.stat b { display: block; font-size: 1.4rem; font-variant-numeric: tabular-nums; }
svg.bars { width: 100%; height: 28px; display: block; }
.bar-ok { fill: var(--ok); } .bar-warn { fill: var(--warn); } .bar-bad { fill: var(--bad); }
.bar-partial { fill: var(--partial); } .bar-none { fill: var(--none); }
svg.spark { display: block; overflow: visible; }
svg.spark.fluid { width: 100%; }
svg.spark * { vector-effect: non-scaling-stroke; }
.spark-line { fill: none; stroke: var(--accent); stroke-width: 1.5; stroke-linejoin: round; stroke-linecap: round; }
.spark-empty { stroke: var(--border); stroke-dasharray: 3 3; }
.spark-fail { fill: var(--bad); }
.legend { display: flex; gap: 1rem; font-size: .8rem; color: var(--muted); flex-wrap: wrap; }
.legend i { display: inline-block; width: .7rem; height: .7rem; border-radius: 2px; margin-right: .3rem; vertical-align: -1px; }
.banner { padding: 1.1rem 1.25rem; border-radius: var(--radius); font-weight: 600; font-size: 1.1rem; }
.banner.operational { background: var(--ok-bg); color: var(--ok); }
.banner.partial_outage { background: var(--warn-bg); color: var(--warn); }
.banner.major_outage { background: var(--bad-bg); color: var(--bad); }
.status-monitor + .status-monitor { border-top: 1px solid var(--border); padding-top: 1rem; margin-top: 1rem; }
.axis { display: flex; justify-content: space-between; font-size: .75rem; color: var(--muted); margin-top: .25rem; }
.empty { text-align: center; padding: 2rem 1rem; color: var(--muted); }
details > summary { cursor: pointer; }
.login { max-width: 380px; margin: 12vh auto; }
footer { text-align: center; color: var(--muted); font-size: .8rem; padding: 2rem 1rem; }
`;

/** Localise `<time data-local>` and confirm `form[data-confirm]`. */
const script = `
for (const t of document.querySelectorAll("time[data-local]")) {
  const d = new Date(t.dateTime);
  if (!Number.isNaN(d.getTime())) t.textContent = d.toLocaleString();
}
document.addEventListener("submit", (event) => {
  const message = event.target.getAttribute("data-confirm");
  if (message && !confirm(message)) event.preventDefault();
});
`;

// A tagged template containing a closing script tag is compiled with a
// runtime helper (the transpiler rewrites the tag), so the element is built
// from a plain string instead.
const scriptTag = raw(`<script>${script}</script>`);

export type Section = "dashboard" | "channels" | "status";

export interface PageOptions {
  readonly title: string;
  readonly body: Interpolation;
  /** Signed-in pages get the navigation and a sign-out button. */
  readonly section?: Section | null;
  /** Reload the page every N seconds (lists, status). */
  readonly refreshSeconds?: number;
}

const navLink = (
  section: Section,
  current: Section,
  href: string,
  text: string
) =>
  html`<a href="${href}" ${section === current && raw('aria-current="page"')}
    >${text}</a
  >`;

const nav = (current: Section): Html => html`<header class="top">
  <a class="brand" href="/">Kanshi</a>
  <nav>
    ${navLink("dashboard", current, "/", "Monitors")}
    ${navLink("channels", current, "/channels", "Channels")}
    ${navLink("status", current, "/status", "Status page")}
  </nav>
  <form class="inline" method="post" action="/logout">
    <button type="submit">Sign out</button>
  </form>
</header>`;

export const page = (options: PageOptions): Html => html`<!doctype html>
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      ${
        options.refreshSeconds !== undefined &&
        html`<meta http-equiv="refresh" content="${options.refreshSeconds}" />`
      }
      <title>${options.title} · Kanshi</title>
      <style>
        ${raw(css)}
      </style>
    </head>
    <body>
      ${
        options.section !== undefined &&
        options.section !== null &&
        nav(options.section)
      }
      <main>${options.body}</main>
      ${scriptTag}
    </body>
  </html>`;

export type FlashKind = "ok" | "error" | "warn";

export interface Flash {
  readonly kind: FlashKind;
  readonly text: string;
}

export const flashBox = (flash: Flash | null | undefined): Html | null =>
  flash === null || flash === undefined
    ? null
    : html`<div class="flash ${flash.kind}" role="status">${flash.text}</div>`;
