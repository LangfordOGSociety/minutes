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
h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); margin: 0 0 8px; font-weight: 600; }
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
    <div class="row">
      <div><h2>Signed in</h2><div id="who"></div></div>
      <button type="button" id="logout">Sign out</button>
    </div>
    <p class="msg err" id="denied" hidden>This account can't open that page.</p>
    <p><a href="/" id="home">Continue</a></p>
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
var PANES = ["signin", "signup", "forgot", "account", "verify", "change"];
function only(ids) { PANES.forEach(function (p) { show(p, ids.indexOf(p) >= 0); }); }

function signedOut(pane) {
  only([pane]);
  show("tosignup", signupOpen);
  show("toforgot", signupOpen);
  if (pane === "signin") $("email").focus();
}

function render(user, setupNeeded) {
  var onAccount = location.pathname === "/account";
  if (!user) {
    show("setup", !!setupNeeded);
    signedOut(location.hash === "#signup" && signupOpen ? "signup" : location.hash === "#forgot" && signupOpen ? "forgot" : "signin");
    return;
  }
  var panes = ["account"];
  if (!user.verified && !user.mustChangePassword && signupOpen) panes.push("verify");
  if (user.mustChangePassword || onAccount) panes.push("change");
  only(panes);
  $("who").textContent = (user.name ? user.name + " · " : "") + user.email + " (" + user.role + (user.verified ? "" : ", email not confirmed") + ")";
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

$("logout").addEventListener("click", function () {
  api("POST", "/api/logout").then(function () { location.replace("/login"); });
});

api("GET", "/api/me").then(function (d) { signupOpen = !!d.signup; render(d.user, d.setupNeeded); },
  function () { render(null, false); });
</script>
</body>
</html>
`;
