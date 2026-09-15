/* Page shell.

   There is no client-side JavaScript anywhere in this app, by choice. Every
   interaction is a link or a form POST. On a phone with two bars in a parking
   lot, a page that renders is worth more than one that animates, and a tool
   you dial 40 prospects from cannot have a state that only exists in memory. */
import { html, raw } from "../html.js";

const NAV = [
  { href: "/today",    label: "Today",    icon: "▶", key: "today" },
  { href: "/pipeline", label: "Pipeline", icon: "≡", key: "pipeline" },
  { href: "/numbers",  label: "Numbers",  icon: "▦", key: "numbers" },
  { href: "/activity", label: "Activity", icon: "↻", key: "activity" },
];

export function layout({ title, operator, active = "", body, flash = null }) {
  return raw(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="dark">
<meta name="robots" content="noindex, nofollow">
<title>${escapeTitle(title)} · Frontline Ops</title>
<link rel="stylesheet" href="/static/app.css">
</head>
<body>
${header({ operator }).value}
${nav(active).value}
<main class="wrap" id="main">
${flashBanner(flash).value}
${body.value ?? body}
</main>
</body>
</html>`);
}

function escapeTitle(text) {
  return String(text ?? "").replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

function header({ operator }) {
  return html`
<header class="topbar">
  <div class="topbar-inner">
    <a href="/today" class="wordmark grad-text">Frontline Ops</a>
    <div class="whoami">
      <span>${operator}</span>
      <form method="POST" action="/logout">
        <button type="submit" class="linkbtn">Sign out</button>
      </form>
    </div>
  </div>
</header>`;
}

function nav(active) {
  return html`
<nav class="nav">
  ${NAV.map((item) => html`
    <a href="${item.href}" class="${item.key === active ? "active" : ""}">
      <span class="ico" aria-hidden="true">${item.icon}</span>
      <span>${item.label}</span>
    </a>`)}
</nav>`;
}

/* Flash messages arrive as ?ok=... / ?err=... on the redirect after a POST.
   Saves failing loudly is a stated requirement -- a silent failure during a
   call block means a lost prospect. */
function flashBanner(flash) {
  if (!flash) return html``;
  if (flash.error) return html`<div class="alert alert-error" role="alert">${flash.error}</div>`;
  if (flash.ok) return html`<div class="alert alert-ok" role="status">${flash.ok}</div>`;
  return html``;
}

/* Minimal shell for the login screen -- no nav, no session. */
export function bareLayout({ title, body }) {
  return raw(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="dark">
<meta name="robots" content="noindex, nofollow">
<title>${escapeTitle(title)} · Frontline Ops</title>
<link rel="stylesheet" href="/static/app.css">
</head>
<body>
<main>${body.value ?? body}</main>
</body>
</html>`);
}
