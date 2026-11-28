/**
 * /login and /account: sign in, sign up (#32, only when the server can send
 * mail), confirm the emailed code, forgot/reset password, change password
 * (forced after a one-time password), sign out.
 *
 * Same rules as the other pages: a String.raw template, so the script must
 * not use backticks or dollar-brace; server data only via textContent; no
 * inline handlers (the CSP allows only this script, by hash).
 */
export const LOGIN_PAGE = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign in · minutes</title>
<link rel="icon" href="data:,">
<style>
:root {
  --bg: #f6f5f2; --panel: #ffffff; --ink: #1d1c1a; --muted: #6b6862; --line: #e4e1da;
  --accent: #2f5bd3; --accent-ink: #ffffff; --ok: #1f7a4d; --bad: #b3261e;
  color-scheme: light;
}
@media (prefers-color-scheme: dark) {
  :root { --bg: #141413; --panel: #1d1d1b; --ink: #ecebe7; --muted: #9a978f; --line: #2e2d2a;
    --accent: #7c9cff; --accent-ink: #0d0d0c; --ok: #5cc28f; --bad: #ff7b72; color-scheme: dark; }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink); font: 15px/1.45 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 380px; margin: 10vh auto 40px; padding: 0 16px; }
h1 { font-size: 18px; margin: 0 0 16px; }
h1 a { color: inherit; text-decoration: none; }
section { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 18px; }
section + section { margin-top: 16px; }
section[hidden], form[hidden], p[hidden], label[hidden], input[hidden] { display: none; }
h2 { font-size: 16px; color: var(--ink); margin: 0 0 8px; font-weight: 650; }
label { display: block; font-size: 13px; font-weight: 600; margin: 12px 0 4px; }
input { width: 100%; padding: 9px 10px; border: 1px solid var(--line); border-radius: 7px; background: var(--bg); color: var(--ink); font: inherit; }
input:focus { outline: 2px solid var(--accent); outline-offset: -1px; }
input.code { font-size: 22px; letter-spacing: .3em; text-align: center; font-variant-numeric: tabular-nums; }
button { font: inherit; border-radius: 7px; border: 1px solid var(--line); background: var(--panel); color: var(--ink); padding: 8px 12px; cursor: pointer; }
button.primary { background: var(--accent); color: var(--accent-ink); border-color: var(--accent); font-weight: 600; width: 100%; margin-top: 16px; padding: 10px 14px; }
button.link { border: 0; background: none; color: var(--accent); padding: 0; text-decoration: underline; }
.msg { font-size: 13px; margin-top: 10px; min-height: 1em; }
.msg.err { color: var(--bad); } .msg.ok { color: var(--ok); }
.hint { color: var(--muted); font-size: 13px; }
.row { display: flex; gap: 10px; align-items: center; justify-content: space-between; flex-wrap: wrap; }
.alt { margin-top: 14px; font-size: 13px; display: flex; gap: 14px; flex-wrap: wrap; }
/* The field people never see; bots fill it. */
.hp { position: absolute; left: -10000px; width: 1px; height: 1px; overflow: hidden; }
a { color: var(--accent); }
code { font-size: 12px; }
select { width: 100%; padding: 9px 10px; border: 1px solid var(--line); border-radius: 7px; background: var(--bg); color: var(--ink); font: inherit; }
label.check { display: flex; gap: 8px; align-items: center; font-weight: 400; }
label.check input { width: auto; }
.tok { border: 1px solid var(--line); border-radius: 8px; padding: 8px 10px; margin-bottom: 8px; overflow-wrap: anywhere; }
.tok.off { opacity: .55; }
.tok .t { font-weight: 600; } .tok .s { color: var(--muted); font-size: 13px; }
.tok button { margin-top: 6px; padding: 4px 10px; font-size: 13px; }
.newtok { border: 1px solid var(--ok); border-radius: 8px; padding: 10px; margin-top: 12px; }
.newtok input { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
main.wide { max-width: 760px; margin-top: 4vh; }
header.site { display: flex; align-items: center; gap: 6px 22px; flex-wrap: wrap; padding: 10px 24px; background: var(--panel); border-bottom: 1px solid var(--line); }
header.site h1 { margin: 0; }
header.site .me { margin-left: auto; color: var(--muted); font-size: 13px; }
nav.site { display: flex; gap: 4px; flex-wrap: wrap; }
nav.site a { color: var(--ink); text-decoration: none; padding: 5px 10px; border-radius: 7px; font-size: 14px; }
nav.site a:hover { background: var(--bg); }
nav.site a[aria-current] { background: var(--bg); font-weight: 600; box-shadow: inset 0 -2px 0 var(--accent); border-radius: 7px 7px 0 0; }
@media (max-width: 900px) { header.site { padding: 8px 16px; } header.site .me { flex-basis: 100%; margin-left: 0; } }
.tabs { display: flex; gap: 4px; margin: 16px 0 12px; border-bottom: 1px solid var(--line); flex-wrap: wrap; }
.tabs[hidden] { display: none; }
.tabs a { padding: 8px 14px; text-decoration: none; color: var(--muted); border-bottom: 2px solid transparent; margin-bottom: -1px; }
.tabs a[aria-current] { color: var(--ink); font-weight: 600; border-bottom-color: var(--accent); }
textarea { width: 100%; font: 12px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; padding: 8px; border: 1px solid var(--line); border-radius: 7px; background: var(--bg); color: var(--ink); resize: vertical; }
pre.snip { background: var(--bg); border: 1px solid var(--line); border-radius: 8px; padding: 10px; font-size: 12px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; }
.opts { display: flex; flex-wrap: wrap; gap: 4px 18px; margin-top: 8px; }
.grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 0 12px; }
@media (max-width: 520px) { .grid2 { grid-template-columns: 1fr; } }
.actions { display: flex; gap: 10px; align-items: center; margin-top: 8px; flex-wrap: wrap; }
.sub { margin-top: 22px; padding-top: 4px; border-top: 1px solid var(--line); }
</style>
</head>
<body>
<header class="site">
  <h1><a href="/">minutes</a></h1>
  <nav class="site" id="sitenav" aria-label="Site"></nav>
  <span class="me" id="me"></span>
</header>
<main id="main">

  <section id="signin" hidden>
    <h2>Sign in</h2>
    <form id="loginform">
      <label for="email">Email</label>
      <input id="email" name="email" type="email" autocomplete="username" required maxlength="254">
      <label for="password">Password</label>
      <input id="password" name="password" type="password" autocomplete="current-password" required maxlength="256">
      <button class="primary" type="submit">Sign in</button>
      <div class="msg" id="loginmsg" role="status"></div>
    </form>
    <div class="alt">
      <button type="button" class="link" id="toforgot" hidden>Forgot password?</button>
      <button type="button" class="link" id="tosignup" hidden>Create an account</button>
    </div>
    <p class="hint" id="setup" hidden>No accounts yet. On the server, run <code>minutes user add --admin you@example.com</code>; it prints a one-time password.</p>
  </section>

  <section id="signup" hidden>
    <h2>Create an account</h2>
    <p class="hint">For API access to recordings and transcripts. Watching needs no account.</p>
    <form id="signupform">
      <label for="su-email">Email</label>
      <input id="su-email" name="email" type="email" autocomplete="email" required maxlength="254">
      <label for="su-name">Name <span class="hint">(optional)</span></label>
      <input id="su-name" name="name" autocomplete="name" maxlength="80">
      <label for="su-password">Password <span class="hint">(at least 10 characters)</span></label>
      <input id="su-password" name="password" type="password" autocomplete="new-password" required minlength="10" maxlength="256">
      <label for="su-confirm">Password again</label>
      <input id="su-confirm" name="confirm" type="password" autocomplete="new-password" required minlength="10" maxlength="256">
      <div class="hp" aria-hidden="true"><label for="su-website">Website</label><input id="su-website" name="website" tabindex="-1" autocomplete="off"></div>
      <button class="primary" type="submit">Create account</button>
      <div class="msg" id="signupmsg" role="status"></div>
    </form>
    <form id="signupcodeform" hidden>
      <p id="signupsent"></p>
      <label for="su-code">Code from the email</label>
      <input id="su-code" name="code" class="code" inputmode="numeric" autocomplete="one-time-code" required pattern="\d{6}" maxlength="6">
      <button class="primary" type="submit">Confirm</button>
      <div class="msg" id="signupcodemsg" role="status"></div>
    </form>
    <div class="alt"><button type="button" class="link" data-to="signin">I have an account</button></div>
  </section>

  <section id="forgot" hidden>
    <h2>Forgot password</h2>
    <form id="forgotform">
      <label for="fg-email">Email</label>
      <input id="fg-email" name="email" type="email" autocomplete="username" required maxlength="254">
      <button class="primary" type="submit">Email me a code</button>
      <div class="msg" id="forgotmsg" role="status"></div>
    </form>
    <form id="resetform" hidden>
      <p class="hint">If there's an account for that address, a code is on its way. It works for 15 minutes.</p>
      <label for="rs-code">Code from the email</label>
      <input id="rs-code" name="code" class="code" inputmode="numeric" autocomplete="one-time-code" required pattern="\d{6}" maxlength="6">
      <label for="rs-new">New password <span class="hint">(at least 10 characters)</span></label>
      <input id="rs-new" name="new" type="password" autocomplete="new-password" required minlength="10" maxlength="256">
      <label for="rs-confirm">New password again</label>
      <input id="rs-confirm" name="confirm" type="password" autocomplete="new-password" required minlength="10" maxlength="256">
      <button class="primary" type="submit">Set new password</button>
      <div class="msg" id="resetmsg" role="status"></div>
    </form>
    <div class="alt"><button type="button" class="link" data-to="signin">Back to sign in</button></div>
  </section>

  <section id="account" hidden>
    <p class="msg err" id="denied" hidden>This account can't open that page. <a href="/" id="home">Go to the meetings</a></p>
  </section>

  <nav class="tabs" id="tabs" aria-label="Account" hidden></nav>

  <section id="p-embed" hidden>
    <h2>Embed a meeting</h2>
    <p class="hint">Put one meeting's video on your own site. Embeds are public: visitors don't need an account or a key.</p>
    <label for="em-m">Meeting</label>
    <select id="em-m"></select>
    <div class="opts">
      <label class="check"><input type="checkbox" id="em-tr"> Transcript</label>
      <label class="check"><input type="checkbox" id="em-ch"> Chapters</label>
      <label class="check"><input type="checkbox" id="em-ti" checked> Title bar</label>
    </div>
    <div class="grid2">
      <div><label for="em-th">Theme</label><select id="em-th"><option value="">Match the visitor</option><option value="light">Light</option><option value="dark">Dark</option></select></div>
      <div><label for="em-t">Start at <small>(1:30)</small></label><input id="em-t" maxlength="12" placeholder="optional"></div>
    </div>
    <label for="em-code">Embed code</label>
    <textarea id="em-code" readonly rows="3"></textarea>
    <div class="actions"><button type="button" id="em-copy">Copy code</button><a id="em-open" target="_blank" rel="noopener">Preview</a></div>
    <div class="hint" id="em-link"></div>

    <h2 class="sub">Embed upcoming meetings</h2>
    <p class="hint">A list of what's next, kept current by itself.</p>
    <div class="grid2">
      <div><label for="up-s">Municipality</label><select id="up-s"><option value="">All</option></select></div>
      <div><label for="up-b">Body</label><select id="up-b"><option value="">All</option></select></div>
      <div><label for="up-n">How many</label><input id="up-n" type="number" min="1" max="20" value="5"></div>
      <div><label for="up-th">Theme</label><select id="up-th"><option value="">Match the visitor</option><option value="light">Light</option><option value="dark">Dark</option></select></div>
    </div>
    <label for="up-code">Embed code</label>
    <textarea id="up-code" readonly rows="3"></textarea>
    <div class="actions"><button type="button" id="up-copy">Copy code</button><a id="up-open" target="_blank" rel="noopener">Preview</a></div>
    <p class="hint">Also available: <code>/oembed?url=</code> for sites that support oEmbed, and the JSON API with a key (API keys tab).</p>
  </section>

  <section id="p-alerts" hidden>
    <h2>Email alerts</h2>
    <p class="hint">Get an email when a word or phrase comes up in a <b>new</b> meeting's transcript, with a link to the moment. Up to 10. You can also make one from a <a href="/search">search</a>.</p>
    <div id="alertlist"></div>
    <form id="alertform">
      <label for="al-q">Watch for</label>
      <input id="al-q" name="query" required maxlength="200" placeholder='e.g. zoning, "public hearing", harbour'>
      <label for="al-body">In</label>
      <select id="al-body" name="body"><option value="">Every meeting</option></select>
      <button class="primary" type="submit">Add alert</button>
      <div class="msg" id="alertmsg" role="status"></div>
    </form>
  </section>

  <section id="tokens" hidden>
    <h2>API tokens</h2>
    <p class="hint">For scripts that download recordings and transcripts. Listing meetings needs no token. See the <a href="/api/docs">API docs</a>.</p>
    <div id="toklist"></div>
    <div class="newtok" id="newtok" hidden>
      <div class="msg ok">Copy this token now. It won't be shown again.</div>
      <input id="newtokval" readonly aria-label="Your new token">
      <button type="button" id="copytok" style="margin-top:8px">Copy</button>
    </div>
    <form id="tokform">
      <label for="tk-label">What is it for?</label>
      <input id="tk-label" name="label" required maxlength="60" placeholder="e.g. my archive script">
      <label for="tk-exp">Expires</label>
      <select id="tk-exp" name="exp"><option value="">Never</option><option value="30">In 30 days</option><option value="90">In 90 days</option><option value="365">In a year</option></select>
      <label class="check"><input type="checkbox" name="dl" checked> Allow file downloads</label>
      <button class="primary" type="submit">Create token</button>
      <div class="msg" id="tokmsg" role="status"></div>
    </form>
    <h2 style="margin-top:20px">Your usage, last 30 days</h2>
    <div class="hint" id="usage">Loading...</div>
    <h2 style="margin-top:20px">Use a key</h2>
    <pre class="snip" id="snip"></pre>
    <p class="hint">Full reference: <a href="/api/docs">API docs</a>.</p>
  </section>

  <section id="verify" hidden>
    <h2>Confirm your email</h2>
    <p class="hint">Enter the code we emailed you. Until then the account can't have API tokens, and it's deleted after 7 days.</p>
    <form id="verifyform">
      <label for="vf-code">Code</label>
      <input id="vf-code" name="code" class="code" inputmode="numeric" autocomplete="one-time-code" required pattern="\d{6}" maxlength="6">
      <button class="primary" type="submit">Confirm</button>
      <div class="msg" id="verifymsg" role="status"></div>
    </form>
    <div class="alt"><button type="button" class="link" id="resend">Send a new code</button></div>
  </section>

  <section id="change" hidden>
    <h2 id="changetitle">Change password</h2>
    <p class="hint" id="changehint" hidden>You signed in with a one-time password. Choose your own to continue.</p>
    <form id="changeform">
      <label for="current">Current password</label>
      <input id="current" name="current" type="password" autocomplete="current-password" required maxlength="256">
      <label for="new">New password <span class="hint">(at least 10 characters)</span></label>
      <input id="new" name="new" type="password" autocomplete="new-password" required minlength="10" maxlength="256">
      <label for="confirm">New password again</label>
      <input id="confirm" name="confirm" type="password" autocomplete="new-password" required minlength="10" maxlength="256">
      <button class="primary" type="submit">Change password</button>
      <div class="msg" id="changemsg" role="status"></div>
    </form>
  </section>
</main>
<script>
"use strict";
var params = new URLSearchParams(location.search);
// Only paths on this site.
var next = params.get("next") || "/";
if (!/^\/(?![\/\\])\S*$/.test(next)) next = "/";
var lastPassword = "", signupOpen = false, signupEmail = "";

function api(method, url, body) {
  var opts = { method: method, headers: {} };
  if (body !== undefined) { opts.headers["Content-Type"] = "application/json"; opts.body = JSON.stringify(body); }
  return fetch(url, opts).then(function (r) {
    return r.json().catch(function () { return {}; }).then(function (d) {
      if (!r.ok) throw new Error((d && d.error) || ("HTTP " + r.status));
      return d;
    });
  });
}
function $(id) { return document.getElementById(id); }
function show(id, on) { $(id).hidden = !on; }
function msg(id, cls, text) { var m = $(id); m.className = "msg" + (cls ? " " + cls : ""); m.textContent = text; }
var PANES = ["signin", "signup", "forgot", "account", "p-alerts", "tokens", "p-embed", "verify", "change"];
function only(ids) { PANES.forEach(function (p) { show(p, ids.indexOf(p) >= 0); }); }

// --- email alerts ---
var alertBodies = false;
function loadAlerts() {
  if (!alertBodies) {
    alertBodies = true;
    api("GET", "/api/meetings?scope=past&limit=1").then(function (d) {
      d.bodies.forEach(function (b) { var o = document.createElement("option"); o.value = b; o.textContent = b; $("al-body").appendChild(o); });
    }, function () {});
  }
  api("GET", "/api/account/alerts").then(function (list) {
    var box = $("alertlist");
    box.replaceChildren();
    if (!list.length) box.appendChild(h("p", "hint", "No alerts yet."));
    list.forEach(function (a) {
      var row = h("div", "tok");
      row.appendChild(h("div", "t", a.query + (a.body ? " (" + a.body + ")" : "")));
      row.appendChild(h("div", "s", "made " + day(a.createdAt) + " · last email " + (a.lastSentAt ? day(a.lastSentAt) : "none yet")));
      var b = h("button", "", "Delete");
      b.addEventListener("click", function () {
        api("DELETE", "/api/account/alerts/" + a.id).then(function () { loadAlerts(); }, function (e) { msg("alertmsg", "err", e.message); });
      });
      row.appendChild(b);
      box.appendChild(row);
    });
  }, function (e) { msg("alertmsg", "err", e.message); });
}
$("alertform").addEventListener("submit", function (ev) {
  ev.preventDefault();
  var f = ev.target;
  msg("alertmsg", "", "Saving...");
  api("POST", "/api/account/alerts", { query: f.query.value, body: f.body.value }).then(function () {
    f.reset(); msg("alertmsg", "ok", "Added."); loadAlerts();
  }, function (e) { msg("alertmsg", "err", e.message); });
});

// --- API tokens (#16) and usage (#18) ---
function h(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; }
function day(iso) { return iso ? new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "never"; }
function size(n) { return n < 1048576 ? Math.round(n / 1024) + " KB" : n < 1073741824 ? (n / 1048576).toFixed(1) + " MB" : (n / 1073741824).toFixed(2) + " GB"; }
function loadTokens() {
  api("GET", "/api/account/tokens").then(function (list) {
    var box = $("toklist");
    box.replaceChildren();
    if (!list.length) box.appendChild(h("p", "hint", "No tokens yet."));
    list.forEach(function (t) {
      var state = t.revokedAt ? "revoked" : !t.active ? "expired" : "";
      var row = h("div", "tok" + (t.active ? "" : " off"));
      row.appendChild(h("div", "t", t.label + (state ? " (" + state + ")" : "")));
      row.appendChild(h("div", "s", "mnt_" + t.prefix + "_... · " + (t.scopes.indexOf("download") >= 0 ? "can download" : "read only") +
        " · made " + day(t.createdAt) + " · last used " + day(t.lastUsedAt) + " · expires " + (t.expiresAt ? day(t.expiresAt) : "never")));
      if (t.active) {
        var b = h("button", "", "Revoke");
        b.addEventListener("click", function () {
          if (!confirm("Revoke " + t.label + "? Anything using it stops working.")) return;
          api("DELETE", "/api/account/tokens/" + t.id).then(function () { loadTokens(); }, function (e) { msg("tokmsg", "err", e.message); });
        });
        row.appendChild(b);
      }
      box.appendChild(row);
    });
  }, function (e) { msg("tokmsg", "err", e.message); });
  api("GET", "/api/account/usage?days=30").then(function (u) {
    var box = $("usage");
    box.replaceChildren();
    var req = 0, bytes = 0;
    u.days.forEach(function (d) { req += d.requests; bytes += d.bytes; });
    box.appendChild(h("div", "", req ? req + " requests, " + size(bytes) + " sent." : "No API requests yet."));
    u.files.slice(0, 5).forEach(function (f) { box.appendChild(h("div", "", f.file + " · " + f.requests + "x · " + size(f.bytes))); });
  }, function () {});
}
$("tokform").addEventListener("submit", function (ev) {
  ev.preventDefault();
  var f = ev.target;
  var body = { label: f.label.value, scopes: f.dl.checked ? ["read", "download"] : ["read"] };
  if (f.exp.value) body.expiresInDays = Number(f.exp.value);
  msg("tokmsg", "", "Creating...");
  api("POST", "/api/account/tokens", body).then(function (d) {
    f.reset(); msg("tokmsg", "", "");
    $("newtokval").value = d.token;
    show("newtok", true);
    $("newtokval").select();
    loadTokens();
  }, function (e) { msg("tokmsg", "err", e.message); });
});
$("copytok").addEventListener("click", function () {
  var v = $("newtokval"), b = $("copytok");
  v.select();
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(v.value).then(function () { b.textContent = "Copied"; }, function () { b.textContent = "Press Ctrl+C"; });
  else b.textContent = "Press Ctrl+C";
});

function signedOut(pane) {
  only([pane]);
  show("tosignup", signupOpen);
  show("toforgot", signupOpen);
  if (pane === "signin") $("email").focus();
}

// --- site header: the same nav as every other page ---
function drawHeader(user) {
  var items = [["Meetings", "/"], ["Search", "/search"], ["Embed & API", "/account#embed"]];
  if (user && user.caps.indexOf("admin.view") >= 0) items.push(["Admin", "/admin"]);
  var nav = $("sitenav"); nav.replaceChildren();
  items.forEach(function (x) {
    var a = h("a", "", x[0]); a.href = x[1];
    if (x[1].indexOf("/account") === 0 && location.pathname === "/account") a.setAttribute("aria-current", "page");
    nav.appendChild(a);
  });
  var me = $("me"); me.replaceChildren();
  if (!user) { if (location.pathname === "/account") return; var si = h("a", "", "Sign in"); si.href = "/login"; me.appendChild(si); return; }
  me.appendChild(document.createTextNode(user.email + " \u00b7 "));
  var ac = h("a", "", "account"); ac.href = "/account"; me.appendChild(ac);
  me.appendChild(document.createTextNode(" \u00b7 "));
  var so = h("a", "", "sign out"); so.href = "#";
  so.addEventListener("click", function (ev) { ev.preventDefault(); api("POST", "/api/logout").then(function () { location.replace("/login"); }); });
  me.appendChild(so);
}

// --- embed builders ---
var embedLoaded = false;
function embedBase() { return location.origin; }
function iframeCode(src, w, hgt, title) {
  return '<iframe src="' + src + '" width="' + w + '" height="' + hgt + '" frameborder="0" allow="fullscreen" allowfullscreen title="' + title.replace(/"/g, "&quot;") + '"></iframe>';
}
function drawMeetingEmbed() {
  var sel = $("em-m");
  if (!sel.value) { $("em-code").value = ""; return; }
  var q = [];
  if ($("em-tr").checked) q.push("transcript=1");
  if ($("em-ch").checked) q.push("chapters=1");
  if (!$("em-ti").checked) q.push("title=0");
  if ($("em-th").value) q.push("theme=" + $("em-th").value);
  var t = $("em-t").value.trim();
  if (t) q.push("t=" + encodeURIComponent(t));
  var src = embedBase() + "/embed/" + encodeURIComponent(sel.value) + (q.length ? "?" + q.join("&") : "");
  var title = sel.options[sel.selectedIndex].getAttribute("data-title") || "Meeting";
  $("em-code").value = iframeCode(src, 640, $("em-tr").checked ? 640 : 360, title);
  $("em-open").href = src;
  $("em-link").textContent = "Meeting page: " + embedBase() + "/m/" + sel.value;
}
function drawUpcomingEmbed() {
  var q = [];
  if ($("up-s").value) q.push("source=" + encodeURIComponent($("up-s").value));
  if ($("up-b").value) q.push("body=" + encodeURIComponent($("up-b").value));
  var n = Math.min(Math.max(parseInt($("up-n").value, 10) || 5, 1), 20);
  q.push("limit=" + n);
  if ($("up-th").value) q.push("theme=" + $("up-th").value);
  var src = embedBase() + "/embed/upcoming?" + q.join("&");
  $("up-code").value = iframeCode(src, 420, 70 + n * 84, "Upcoming meetings");
  $("up-open").href = src;
}
function copyFrom(id, btn) {
  var v = $(id); v.select();
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(v.value).then(function () { btn.textContent = "Copied"; }, function () { btn.textContent = "Press Ctrl+C"; });
  else btn.textContent = "Press Ctrl+C";
}
function loadEmbed() {
  if (embedLoaded) return;
  embedLoaded = true;
  Promise.all([api("GET", "/api/meetings?scope=upcoming&limit=20"), api("GET", "/api/meetings?scope=past&limit=50")]).then(function (r) {
    var sel = $("em-m");
    [["Recent", r[1].meetings], ["Upcoming", r[0].meetings]].forEach(function (g) {
      if (!g[1].length) return;
      var og = document.createElement("optgroup"); og.label = g[0];
      g[1].forEach(function (m) {
        var o = h("option", "", (m.source ? m.source + ": " : "") + m.title + " (" + day(m.start) + ")");
        o.value = m.id; o.setAttribute("data-title", m.title); og.appendChild(o);
      });
      sel.appendChild(og);
    });
    if (!sel.options.length) { var none = h("option", "", "No meetings published yet"); none.value = ""; sel.appendChild(none); }
    (r[1].sources || []).forEach(function (x) { var o = h("option", "", x); o.value = x; $("up-s").appendChild(o); });
    (r[1].bodies || []).forEach(function (x) { var o = h("option", "", x); o.value = x; $("up-b").appendChild(o); });
    drawMeetingEmbed(); drawUpcomingEmbed();
  }, function () {});
}
["em-m", "em-tr", "em-ch", "em-ti", "em-th"].forEach(function (id) { $(id).addEventListener("change", drawMeetingEmbed); });
$("em-t").addEventListener("input", drawMeetingEmbed);
["up-s", "up-b", "up-n", "up-th"].forEach(function (id) { $(id).addEventListener("input", drawUpcomingEmbed); });
$("em-copy").addEventListener("click", function () { copyFrom("em-code", $("em-copy")); });
$("up-copy").addEventListener("click", function () { copyFrom("up-code", $("up-copy")); });
$("snip").textContent = "curl -H \"Authorization: Bearer mnt_YOUR_KEY\" \\\n  " + location.origin + "/api/v1/meetings?scope=upcoming";

// --- account tabs (#keys, #embed, #alerts, #password) ---
var curUser = null, TAB_PANE = { keys: "tokens", embed: "p-embed", alerts: "p-alerts", password: "change" };
function availableTabs(user, onAccount) {
  var t = [];
  if (!onAccount || user.mustChangePassword) return t;
  if (user.caps.indexOf("tokens.own") >= 0) t.push(["keys", "API keys"]);
  t.push(["embed", "Embed"]);
  if (signupOpen && user.caps.indexOf("alerts.own") >= 0) t.push(["alerts", "Alerts"]);
  t.push(["password", "Password"]);
  return t;
}
function showTabs() {
  var user = curUser, onAccount = location.pathname === "/account";
  var tabs = availableTabs(user, onAccount);
  var want = location.hash.slice(1);
  var cur = tabs.filter(function (x) { return x[0] === want; })[0] || tabs[0];
  var panes = params.get("denied") === "1" ? ["account"] : [];   // the header already says who is signed in
  if (user.mustChangePassword) panes.push("change");
  else if (cur) panes.push(TAB_PANE[cur[0]]);
  if (!user.verified && !user.mustChangePassword && signupOpen) panes.push("verify");
  only(panes);
  $("main").className = onAccount ? "wide" : "";
  var nav = $("tabs");
  nav.replaceChildren();
  tabs.forEach(function (x) {
    var a = h("a", "", x[1]); a.href = "#" + x[0];
    if (cur && cur[0] === x[0]) a.setAttribute("aria-current", "page");
    nav.appendChild(a);
  });
  nav.hidden = !tabs.length;
  if (cur && cur[0] === "keys") loadTokens();
  if (cur && cur[0] === "embed") loadEmbed();
  if (cur && cur[0] === "alerts") loadAlerts();
}
// The tab names are also section ids (#embed, #alerts): the browser scrolls to that section and hides the header. Stay at the top.
function toTop() { window.scrollTo(0, 0); setTimeout(function () { window.scrollTo(0, 0); }, 0); }
window.addEventListener("hashchange", function () { if (curUser) { showTabs(); toTop(); } });

function render(user, setupNeeded) {
  var onAccount = location.pathname === "/account";
  drawHeader(user);
  if (!user) {
    curUser = null; $("tabs").hidden = true; $("main").className = "";
    show("setup", !!setupNeeded);
    signedOut(location.hash === "#signup" && signupOpen ? "signup" : location.hash === "#forgot" && signupOpen ? "forgot" : "signin");
    return;
  }
  curUser = user;
  showTabs();
  if (onAccount) toTop();
  show("denied", params.get("denied") === "1");
  $("home").href = next;
  show("changehint", user.mustChangePassword);
  // Right after signing in with a one-time password we already have it.
  var reuse = user.mustChangePassword && !!lastPassword;
  show("current", !reuse);
  document.querySelector("label[for=current]").hidden = reuse;
  $("current").required = !reuse;
  if (!user.mustChangePassword && !onAccount) location.replace(next);
}

[].forEach.call(document.querySelectorAll("[data-to]"), function (b) {
  b.addEventListener("click", function () { history.replaceState(null, "", location.pathname + location.search); signedOut(b.getAttribute("data-to")); });
});
$("tosignup").addEventListener("click", function () { history.replaceState(null, "", "#signup"); signedOut("signup"); $("su-email").focus(); });
$("toforgot").addEventListener("click", function () { history.replaceState(null, "", "#forgot"); $("fg-email").value = $("email").value; signedOut("forgot"); $("fg-email").focus(); });

$("loginform").addEventListener("submit", function (ev) {
  ev.preventDefault();
  var f = ev.target;
  msg("loginmsg", "", "Signing in...");
  api("POST", "/api/login", { email: f.email.value, password: f.password.value }).then(function (d) {
    lastPassword = f.password.value;
    f.reset(); msg("loginmsg", "", "");
    render(d.user, false);
  }, function (e) { msg("loginmsg", "err", e.message); });
});

$("signupform").addEventListener("submit", function (ev) {
  ev.preventDefault();
  var f = ev.target;
  if (f.password.value !== f.confirm.value) { msg("signupmsg", "err", "The two passwords don't match."); return; }
  msg("signupmsg", "", "Creating...");
  api("POST", "/api/signup", { email: f.email.value, name: f.name.value, password: f.password.value, website: f.website.value }).then(function (d) {
    signupEmail = d.email;
    msg("signupmsg", "", "");
    show("signupform", false); show("signupcodeform", true);
    $("signupsent").textContent = "We sent a 6-digit code to " + d.email + ". It works for 24 hours.";
    $("su-code").focus();
  }, function (e) { msg("signupmsg", "err", e.message); });
});
$("signupcodeform").addEventListener("submit", function (ev) {
  ev.preventDefault();
  msg("signupcodemsg", "", "Checking...");
  api("POST", "/api/signup/verify", { email: signupEmail, code: ev.target.code.value }).then(function (d) {
    msg("signupcodemsg", "ok", "Confirmed. You're signed in.");
    render(d.user, false);
  }, function (e) { msg("signupcodemsg", "err", e.message); });
});

$("forgotform").addEventListener("submit", function (ev) {
  ev.preventDefault();
  msg("forgotmsg", "", "Sending...");
  api("POST", "/api/password/forgot", { email: ev.target.email.value }).then(function () {
    msg("forgotmsg", "", "");
    show("forgotform", false); show("resetform", true); $("rs-code").focus();
  }, function (e) { msg("forgotmsg", "err", e.message); });
});
$("resetform").addEventListener("submit", function (ev) {
  ev.preventDefault();
  var f = ev.target;
  if (f["new"].value !== f.confirm.value) { msg("resetmsg", "err", "The two new passwords don't match."); return; }
  msg("resetmsg", "", "Saving...");
  api("POST", "/api/password/reset", { email: $("fg-email").value, code: f.code.value, password: f["new"].value }).then(function () {
    f.reset(); show("resetform", false); show("forgotform", true); msg("forgotmsg", "", "");
    history.replaceState(null, "", location.pathname + location.search);
    signedOut("signin");
    $("email").value = $("fg-email").value;
    msg("loginmsg", "ok", "Password changed. Sign in with the new one.");
    $("password").focus();
  }, function (e) { msg("resetmsg", "err", e.message); });
});

$("verifyform").addEventListener("submit", function (ev) {
  ev.preventDefault();
  msg("verifymsg", "", "Checking...");
  api("POST", "/api/account/verify", { code: ev.target.code.value }).then(function (d) {
    msg("verifymsg", "ok", "Confirmed.");
    render(d.user, false);
  }, function (e) { msg("verifymsg", "err", e.message); });
});
$("resend").addEventListener("click", function () {
  msg("verifymsg", "", "Sending...");
  api("POST", "/api/account/verify/resend", {}).then(function () { msg("verifymsg", "ok", "A new code is on its way."); },
    function (e) { msg("verifymsg", "err", e.message); });
});

$("changeform").addEventListener("submit", function (ev) {
  ev.preventDefault();
  var f = ev.target;
  if (f["new"].value !== f.confirm.value) { msg("changemsg", "err", "The two new passwords don't match."); return; }
  msg("changemsg", "", "Saving...");
  api("POST", "/api/account/password", { current: f.current.value || lastPassword, password: f["new"].value }).then(function (d) {
    lastPassword = ""; f.reset();
    msg("changemsg", "ok", "Password changed. Other sessions were signed out.");
    if (location.pathname !== "/account") location.replace(next); else render(d.user, false);
  }, function (e) { msg("changemsg", "err", e.message); });
});

api("GET", "/api/me").then(function (d) { signupOpen = !!d.signup; render(d.user, d.setupNeeded); },
  function () { render(null, false); });
</script>
</body>
</html>
`;
