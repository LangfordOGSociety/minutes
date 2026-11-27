/**
 * /embed/upcoming : the next meetings as a compact list, for other sites'
 * iframes. Like /embed/<slug> it may be framed (EMBED_ORIGINS, serve.ts),
 * has no sign-in or actions, and reads only the public meetings API.
 *
 *   ?source=Langford   one municipality (as /api/meetings sources list it)
 *   ?body=Council      one body
 *   ?limit=5           how many (1 to 20)
 *   ?theme=light|dark  else follows the visitor's setting
 *   ?title=0           hide the "Upcoming meetings" heading
 *
 * Links open the meeting's own page in a new tab. Refreshes itself every
 * minute. __TZ__ is filled at startup. Same String.raw rules as the other pages.
 */
import { BASE_CSS, BASE_JS, PUBLIC_CSS, PUBLIC_JS } from "./common.js";

export const EMBED_LIST_PAGE = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Upcoming meetings</title>
<link rel="icon" href="data:,">
<style>
${BASE_CSS}
${PUBLIC_CSS}
:root[data-theme="light"] { --bg: #f6f5f2; --panel: #ffffff; --ink: #1d1c1a; --muted: #6b6862; --line: #e4e1da;
  --accent: #2f5bd3; --accent-ink: #ffffff; --ok: #1f7a4d; --warn: #a35a00; --live: #c2185b; color-scheme: light; }
:root[data-theme="dark"] { --bg: #141413; --panel: #1d1d1b; --ink: #ecebe7; --muted: #9a978f; --line: #2e2d2a;
  --accent: #7c9cff; --accent-ink: #0d0d0c; --ok: #5cc28f; --warn: #e0a24a; --live: #ff6fa8; color-scheme: dark; }
body { padding: 12px; }
h1 { font-size: 15px; margin: 0 0 10px; }
.foot { margin-top: 10px; font-size: 12px; color: var(--muted); }
.mcard .p { display: none; }
</style>
</head>
<body>
<h1 id="h">Upcoming meetings</h1>
<div class="list" id="list"><div class="empty">Loading...</div></div>
<div class="foot"><a href="/" target="_blank" rel="noopener">All meetings on minutes</a></div>
<script>
"use strict";
var TZ = __TZ__;
${BASE_JS}
${PUBLIC_JS}
var Q = new URLSearchParams(location.search);
var theme = Q.get("theme");
if (theme === "light" || theme === "dark") document.documentElement.setAttribute("data-theme", theme);
if (Q.get("title") === "0") document.getElementById("h").hidden = true;
var limit = Math.min(Math.max(parseInt(Q.get("limit") || "5", 10) || 5, 1), 20);
var qs = "scope=upcoming&limit=" + limit;
if (Q.get("source")) qs += "&source=" + encodeURIComponent(Q.get("source").slice(0, 100));
if (Q.get("body")) qs += "&body=" + encodeURIComponent(Q.get("body").slice(0, 100));
function load() {
  var box = document.getElementById("list");
  api("GET", "/api/meetings?" + qs).then(function (d) {
    if (!d.meetings.length) { fill(box, el("div", { "class": "empty", text: "No upcoming meetings listed." })); return; }
    fill.apply(null, [box].concat(d.meetings.map(function (m) {
      var c = meetingCard(m);
      c.setAttribute("target", "_blank"); c.setAttribute("rel", "noopener");
      return c;
    })));
  }, function () { fill(box, el("div", { "class": "empty", text: "Can't reach the server." })); });
}
load();
setInterval(function () { if (!document.hidden) load(); }, 60000);
</script>
</body>
</html>
`;
