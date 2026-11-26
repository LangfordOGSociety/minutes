/**
 * /search : "what did council say about X". Searches the transcripts of
 * every public meeting (search.ts); each result is a passage with the
 * matched words highlighted, who said it and when, linking to the meeting
 * at that second (/m/<slug>?t=<seconds>). The form is a plain GET, so a
 * search is a shareable link: /search?q=budget+amendment&body=Council.
 *
 * Same String.raw rules as the other pages. __TZ__ is replaced at startup.
 */
import { BASE_CSS, BASE_JS, PUBLIC_CSS, PUBLIC_JS } from "./common.js";

export const SEARCH_PAGE = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Search meetings · minutes</title>
<meta name="description" content="Search what was said at public meetings: every transcript, with a link to the moment.">
<link rel="icon" href="data:,">
<style>
${BASE_CSS}
${PUBLIC_CSS}
.sform { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 8px; }
.sform .q { grid-column: 1 / -1; display: flex; gap: 8px; }
.sform .q input { flex: 1; font-size: 16px; padding: 10px 12px; }
.sform .q button { padding: 10px 16px; }
@media (max-width: 600px) { .sform { grid-template-columns: 1fr 1fr; } .sform select { grid-column: 1 / -1; } }
.hit { border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px; }
.hit a.t { font-weight: 600; overflow-wrap: anywhere; }
.hit .m { color: var(--muted); font-size: 13px; margin: 2px 0 6px; }
.hit .x { overflow-wrap: anywhere; }
mark { background: color-mix(in srgb, var(--accent) 28%, transparent); color: inherit; padding: 0 2px; border-radius: 3px; }
#tips { margin-top: 10px; }
</style>
</head>
<body>
<header>
  <h1><a href="/">minutes</a></h1>
  <span class="me" id="me"></span>
</header>
<main>
  <section>
    <h2>Search what was said</h2>
    <form class="sform" id="sform" action="/search" method="get" role="search">
      <div class="q"><input id="q" name="q" type="search" placeholder="e.g. budget amendment, &quot;public hearing&quot;, zoning" aria-label="Search transcripts" autocomplete="off" required maxlength="200"><button class="primary" type="submit" style="margin-top:0;width:auto">Search</button></div>
      <select id="body" name="body" aria-label="Body"><option value="">All bodies</option></select>
      <input id="from" name="from" type="date" aria-label="From date">
      <input id="to" name="to" type="date" aria-label="To date">
    </form>
    <div class="hint" id="tips">Words must all appear (the last one can be a start of a word). Put a phrase in "quotes". Searches machine-made transcripts, so a name may be spelled differently: check the video.</div>
  </section>
  <section id="results" hidden>
    <h2 id="summary"></h2>
    <div class="list" id="hits"></div>
    <button class="more" id="more" hidden>Show more</button>
  </section>
</main>
<script>
"use strict";
var TZ = __TZ__;
${BASE_JS}
${PUBLIC_JS}
var P = new URLSearchParams(location.search), shown = 0, QS = "";
["q", "from", "to"].forEach(function (k) { if (P.get(k)) document.getElementById(k).value = P.get(k); });

function hitCard(h) {
  var text = el("div", { "class": "x" });
  h.parts.forEach(function (p) { text.appendChild(p.hit ? el("mark", { text: p.text }) : document.createTextNode(p.text)); });
  var meta = [whenOf(h.meeting.start), h.meeting.body && h.meeting.body !== h.meeting.title ? h.meeting.body : null, "at " + hms(h.t), h.speaker].filter(Boolean).join(" · ");
  return el("div", { "class": "hit" }, el("a", { "class": "t", href: h.url, text: h.meeting.title }), el("div", { "class": "m", text: meta }), text);
}

function run(more) {
  var q = (P.get("q") || "").trim();
  if (!q) return;
  var box = document.getElementById("hits"), btn = document.getElementById("more");
  var offset = more ? shown : 0;
  var qs = "q=" + encodeURIComponent(q) + "&limit=20&offset=" + offset;
  ["body", "from", "to"].forEach(function (k) { if (P.get(k)) qs += "&" + k + "=" + encodeURIComponent(P.get(k)); });
  api("GET", "/api/search?" + qs).then(function (d) {
    document.getElementById("results").hidden = false;
    if (!more) fill(box);
    d.hits.forEach(function (h) { box.appendChild(hitCard(h)); });
    shown = offset + d.hits.length;
    document.getElementById("summary").textContent = d.total ? d.total + (d.total === 1 ? " passage" : " passages") + " for " + q : "Nothing found for " + q;
    if (!d.total) box.appendChild(el("div", { "class": "empty", text: "No meeting transcript has those words. Try fewer words, or another spelling." }));
    btn.hidden = shown >= d.total;
  }, function (e) { document.getElementById("results").hidden = false; fill(box, el("div", { "class": "empty", text: "Can't reach the server: " + e.message })); });
}

document.getElementById("more").addEventListener("click", function () { run(true); });
// The body filter's choices, then restore the chosen one and search.
api("GET", "/api/meetings?scope=past&limit=1").then(function (d) {
  var sel = document.getElementById("body");
  d.bodies.forEach(function (b) { sel.appendChild(el("option", { value: b, text: b })); });
  if (P.get("body")) sel.value = P.get("body");
}, function () {}).then(function () { run(false); });
renderMe(document.getElementById("me"), false);
</script>
</body>
</html>
`;
