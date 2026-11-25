/**
 * /login and /account: sign in, change password (forced after a one-time
 * password from `minutes user add|passwd`), sign out.
 *
 * Same rules as webui.ts: a String.raw template, so the script must not use
 * backticks or dollar-brace; server data only via textContent.
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
section[hidden] { display: none; }
h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); margin: 0 0 8px; font-weight: 600; }
label { display: block; font-size: 13px; font-weight: 600; margin: 12px 0 4px; }
input { width: 100%; padding: 9px 10px; border: 1px solid var(--line); border-radius: 7px; background: var(--bg); color: var(--ink); font: inherit; }
input:focus { outline: 2px solid var(--accent); outline-offset: -1px; }
button { font: inherit; border-radius: 7px; border: 1px solid var(--line); background: var(--panel); color: var(--ink); padding: 8px 12px; cursor: pointer; }
button.primary { background: var(--accent); color: var(--accent-ink); border-color: var(--accent); font-weight: 600; width: 100%; margin-top: 16px; padding: 10px 14px; }
.msg { font-size: 13px; margin-top: 10px; min-height: 1em; }
.msg.err { color: var(--bad); } .msg.ok { color: var(--ok); }
.hint { color: var(--muted); font-size: 13px; }
.row { display: flex; gap: 10px; align-items: center; justify-content: space-between; flex-wrap: wrap; }
a { color: var(--accent); }
code { font-size: 12px; }
</style>
</head>
<body>
<main>
  <h1><a href="/">minutes</a></h1>
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
    <p class="hint" id="setup" hidden>No accounts yet. On the server, run <code>minutes user add --admin you@example.com</code>; it prints a one-time password.</p>
  </section>
  <section id="account" hidden>
    <div class="row">
      <div><h2>Signed in</h2><div id="who"></div></div>
      <button type="button" id="logout">Sign out</button>
    </div>
    <p class="msg err" id="denied" hidden>This account can't open that page.</p>
    <p><a href="/" id="home">Continue</a></p>
  </section>
  <section id="change" hidden style="margin-top: 16px">
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
var lastPassword = "";

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
function show(id, on) { document.getElementById(id).hidden = !on; }
function msg(id, cls, text) { var m = document.getElementById(id); m.className = "msg" + (cls ? " " + cls : ""); m.textContent = text; }

function render(user, setupNeeded) {
  var onAccount = location.pathname === "/account";
  show("signin", !user);
  show("setup", !user && !!setupNeeded);
  show("account", !!user);
  show("change", !!user && (user.mustChangePassword || onAccount));
  if (!user) { document.getElementById("email").focus(); return; }
  document.getElementById("who").textContent = (user.name ? user.name + " · " : "") + user.email + " (" + user.role + ")";
  show("denied", params.get("denied") === "1");
  document.getElementById("home").href = next;
  show("changehint", user.mustChangePassword);
  // Right after signing in with a one-time password we already have it.
  show("current", !(user.mustChangePassword && lastPassword));
  document.querySelector("label[for=current]").hidden = user.mustChangePassword && !!lastPassword;
  document.getElementById("current").required = !(user.mustChangePassword && lastPassword);
  if (!user.mustChangePassword && !onAccount) location.replace(next);
}

document.getElementById("loginform").addEventListener("submit", function (ev) {
  ev.preventDefault();
  var f = ev.target;
  msg("loginmsg", "", "Signing in...");
  api("POST", "/api/login", { email: f.email.value, password: f.password.value }).then(function (d) {
    lastPassword = f.password.value;
    f.reset(); msg("loginmsg", "", "");
    render(d.user, false);
  }, function (e) { msg("loginmsg", "err", e.message); });
});

document.getElementById("changeform").addEventListener("submit", function (ev) {
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

document.getElementById("logout").addEventListener("click", function () {
  api("POST", "/api/logout").then(function () { location.replace("/login"); });
});

api("GET", "/api/me").then(function (d) { render(d.user, d.setupNeeded); },
  function () { render(null, false); });
</script>
</body>
</html>
`;
