/**
 * /alerts/:token/stop : the link in an alert email. It asks before it
 * stops anything (a mail scanner that opens links changes nothing), then
 * stops that one alert; no sign-in needed. The token is in the address, so
 * the page sends no referrer anywhere and loads nothing from elsewhere.
 *
 * Same String.raw rules as the other pages. __TZ__ is replaced at startup.
 */
import { BASE_CSS, BASE_JS, PUBLIC_CSS } from "./common.js";

export const STOP_PAGE = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<meta name="referrer" content="no-referrer">
<title>Stop an alert · minutes</title>
<link rel="icon" href="data:,">
<style>
${BASE_CSS}
${PUBLIC_CSS}
main { max-width: 520px; }
</style>
</head>
<body>
<header><h1><a href="/">minutes</a></h1></header>
<main>
  <section>
    <h2>Email alert</h2>
    <div id="box"><div class="empty">Loading...</div></div>
  </section>
</main>
<script>
"use strict";
var TZ = __TZ__;
${BASE_JS}
var TOKEN = location.pathname.split("/")[2] || "";
var box = document.getElementById("box");
function gone() { fill(box, el("p", { text: "This alert is already stopped, or the link isn't right." }), el("p", {}, el("a", { href: "/search", text: "Search the meetings" }))); }
api("GET", "/api/alerts/" + encodeURIComponent(TOKEN)).then(function (a) {
  var msg = el("p", { "class": "msg" });
  var btn = el("button", { "class": "primary", text: "Stop these emails", on: { click: function () {
    btn.disabled = true;
    api("POST", "/api/alerts/stop", { token: TOKEN }).then(function () {
      fill(box, el("p", { text: "Stopped. You won't get emails when " + a.query + " comes up." }), el("p", {}, el("a", { href: "/account", text: "Your other alerts" }), " · ", el("a", { href: "/", text: "minutes" })));
    }, function (e) { btn.disabled = false; msg.className = "msg err"; msg.textContent = e.message; });
  } } });
  fill(box, el("p", {}, "You get an email when ", el("b", { text: a.query }), a.body ? " (" + a.body + ")" : "", " comes up in a new meeting."), btn, msg);
}, gone);
</script>
</body>
</html>
`;
