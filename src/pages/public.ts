/**
 * / : what anyone may see. Upcoming meetings, past meetings with filters
 * (body, dates, search), and recent changes (announced, moved, cancelled,
 * documents added). Each meeting opens /m/:slug (pages/meeting.ts).
 *
 * Never join links, meeting IDs, the bot's display, logs, failed attempts
 * or the Zoom login state: the data comes from /api/meetings and
 * /api/changes, which only have the public fields (site.ts).
 *
 * Same String.raw rules as the other pages. __TZ__ is replaced at startup.
 */
import { BASE_CSS, BASE_JS, PUBLIC_CSS, PUBLIC_JS } from "./common.js";

export const PUBLIC_PAGE = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>minutes: public meetings</title>
<meta name="description" content="Upcoming and past public meetings with video, transcripts and a record of every change.">
<link rel="icon" href="data:,">
<style>
${BASE_CSS}
${PUBLIC_CSS}
.hero { max-width: 1100px; margin: 0 auto; padding: 22px 24px 4px; }
.hero h2.lead { font-size: 26px; letter-spacing: -.02em; text-transform: none; color: var(--ink); margin: 0 0 6px; }
.hero .intro { padding: 0; margin: 0 0 12px; }
.hero .hsearch { padding: 0; margin: 0 0 14px; max-width: 560px; }
.chips { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.chips .lab { color: var(--muted); font-size: 13px; margin-right: 2px; }
.chip .dot { display: inline-block; width: 10px; height: 10px; border-radius: 50%; margin-right: 6px; }
.chip { border-radius: 999px; padding: 6px 14px; font-size: 14px; }
.chip[aria-pressed="true"] { background: var(--accent); color: var(--accent-ink); border-color: var(--accent); font-weight: 600; }
.home { display: grid; grid-template-columns: minmax(0, 1fr) 300px; gap: 20px; align-items: start; }
.home > div > section + section { margin-top: 20px; }
.sechead { display: flex; justify-content: space-between; align-items: baseline; gap: 10px; }
#livenow { border-color: var(--live); }
#livenow h2 { color: var(--live); }
details.filt { margin-bottom: 12px; }
details.filt summary { cursor: pointer; color: var(--muted); font-size: 13px; margin-bottom: 8px; }
.side .upd { grid-template-columns: 1fr; gap: 0; }
#updbox > summary { cursor: pointer; list-style: none; } #updbox > summary::-webkit-details-marker { display: none; }
#updbox > summary h2 { display: inline; margin: 0; } #updbox > summary::after { content: ' ▾'; color: var(--muted); } #updbox:not([open]) > summary::after { content: ' ▸'; }
#updbox[open] > summary { margin-bottom: 12px; }
@media (max-width: 900px) { .home { grid-template-columns: 1fr; } .hero { padding: 16px 16px 0; } }
</style>
</head>
<body>
<header>
  <h1><a href="/">minutes</a></h1>
  <span class="me" id="me"></span>
</header>
<div class="hero">
  <h2 class="lead">Public meetings, recorded and searchable</h2>
  <p class="intro">What's coming up, and video and transcripts of the ones that have happened, usually the same night. Transcripts are machine-made: check the video before quoting.</p>
  <form class="hsearch" action="/search" method="get" role="search">
    <input name="q" type="search" placeholder="Search what was said at meetings" aria-label="Search transcripts" required maxlength="200">
    <button type="submit">Search</button>
  </form>
  <div class="chips" id="chips" role="group" aria-label="Municipality" hidden></div>
</div>
<main class="home">
  <div>
    <section id="livenow" hidden>
      <h2>Live now</h2>
      <div class="list" id="live"></div>
    </section>
    <section>
      <h2>Upcoming</h2>
      <div class="list" id="upcoming"><div class="empty">Loading...</div></div>
    </section>
    <section>
      <h2>Recent meetings</h2>
      <details class="filt" id="filt">
        <summary>Filter by body, date or title</summary>
        <div class="filters">
          <select id="f-body" aria-label="Body"><option value="">All bodies</option></select>
          <input id="f-from" type="date" aria-label="From date">
          <input id="f-to" type="date" aria-label="To date">
          <input id="f-q" class="q" type="search" placeholder="Search by title" aria-label="Search by title">
        </div>
      </details>
      <div class="list" id="past"><div class="empty">Loading...</div></div>
      <div class="hint" id="pastcount"></div>
      <button class="more" id="more" hidden>Show more</button>
    </section>
  </div>
  <aside class="side">
    <section>
      <details id="updbox" open>
        <summary><h2>Recent updates</h2></summary>
        <div id="updates"><div class="empty">Loading...</div></div>
      </details>
    </section>
  </aside>
</main>
<script>
"use strict";
var TZ = __TZ__;
${BASE_JS}
${PUBLIC_JS}
// Old shared links were /#<recording>: send them to the meeting's page.
if (location.hash.length > 1) location.replace("/m/" + encodeURIComponent(decodeURIComponent(location.hash.slice(1))));

function offline(box, e) { fill(box, el("div", { "class": "empty", text: "Can't reach the server: " + e.message })); }

// The chosen municipality (chips) is remembered in the address: /?m=Langford.
var muni = new URLSearchParams(location.search).get("m") || "";
function setMuni(v) {
  muni = v;
  history.replaceState(null, "", v ? "/?m=" + encodeURIComponent(v) : "/");
  drawChips();
  loadUpcoming(); loadPast(false); loadUpdates();
}
var sourceList = [], sourceColors = {};
function drawChips() {
  var box = document.getElementById("chips");
  if (sourceList.length < 2) { box.hidden = true; return; }
  box.hidden = false;
  var kids = [el("span", { "class": "lab", text: "Municipality" })];
  [""].concat(sourceList).forEach(function (s) {
    var b = el("button", { type: "button", "class": "chip", "aria-pressed": String(muni === s),
      on: { click: function () { setMuni(s); } } }, s && sourceColors[s] ? el("span", { "class": "dot" }) : null, s || "All");
    if (s && sourceColors[s]) b.firstChild.style.background = sourceColors[s];
    kids.push(b);
  });
  fill.apply(null, [box].concat(kids));
}
function loadUpcoming() {
  var box = document.getElementById("upcoming"), live = document.getElementById("live");
  return api("GET", "/api/meetings?scope=upcoming&limit=50" + (muni ? "&source=" + encodeURIComponent(muni) : "")).then(function (d) {
    var now = d.meetings.filter(function (m) { return m.stage === "live"; });
    var next = d.meetings.filter(function (m) { return m.stage !== "live"; });
    document.getElementById("livenow").hidden = !now.length;
    fill.apply(null, [live].concat(now.map(meetingCard)));
    if (!next.length) { fill(box, el("div", { "class": "empty", text: muni ? "No upcoming " + muni + " meetings listed." : "No upcoming meetings listed." })); return; }
    fill.apply(null, [box].concat(next.map(meetingCard)));
  }, function (e) { offline(box, e); });
}

var shown = 0, haveBodies = false, haveSources = false;
function pastQuery(offset) {
  var q = "scope=past&limit=25&offset=" + offset;
  if (muni) q += "&source=" + encodeURIComponent(muni);
  [["body", "f-body"], ["from", "f-from"], ["to", "f-to"], ["q", "f-q"]].forEach(function (p) {
    var v = document.getElementById(p[1]).value.trim();
    if (v) q += "&" + p[0] + "=" + encodeURIComponent(v);
  });
  return q;
}
function loadPast(more) {
  var box = document.getElementById("past"), btn = document.getElementById("more");
  var offset = more ? shown : 0;
  return api("GET", "/api/meetings?" + pastQuery(offset)).then(function (d) {
    if (!haveSources && d.sources) { haveSources = true; sourceList = d.sources; sourceColors = d.sourceColors || {}; drawChips(); }
    if (!haveBodies && d.bodies.length) {
      haveBodies = true;
      var sel = document.getElementById("f-body");
      d.bodies.forEach(function (b) { sel.appendChild(el("option", { value: b, text: b })); });
    }
    if (!more) fill(box);
    if (!more && !d.meetings.length) box.appendChild(el("div", { "class": "empty", text: "No past meetings match." }));
    d.meetings.forEach(function (m) { box.appendChild(meetingCard(m)); });
    shown = offset + d.meetings.length;
    document.getElementById("pastcount").textContent = d.total ? "Showing " + shown + " of " + d.total : "";
    btn.hidden = shown >= d.total;
  }, function (e) { offline(box, e); });
}

// What a reader wants from the news: a meeting announced, moved, cancelled, a transcript ready. A meeting's documents arriving become
// one line, not one per file, and "transcription started" is left out (the full list is on each meeting's page).
function groupUpdates(cs) {
  var out = [], docs = {};
  cs.forEach(function (c) {
    if (c.kind === "transcript_started") return;
    if (c.kind.indexOf("document_") === 0) {
      var d = docs[c.meeting.id];
      if (!d) { d = docs[c.meeting.id] = { at: c.at, meeting: c.meeting, n: 0, first: c }; out.push(d); }
      d.n++;
      if (c.at > d.at) d.at = c.at;
      return;
    }
    out.push({ at: c.at, meeting: c.meeting, text: changeText(c) });
  });
  out.forEach(function (u) { if (u.n) u.text = u.n === 1 ? changeText(u.first) : u.n + " documents added or updated"; });
  return out.sort(function (a, b) { return b.at.localeCompare(a.at); });
}
function loadUpdates() {
  var box = document.getElementById("updates");
  return api("GET", "/api/changes?limit=" + (muni ? 100 : 60)).then(function (cs) {
    if (muni) cs = cs.filter(function (c) { return c.meeting.source === muni; });
    var ups = groupUpdates(cs).slice(0, 10);
    if (!ups.length) { fill(box, el("div", { "class": "empty", text: "Nothing has changed lately." })); return; }
    fill.apply(null, [box].concat(ups.map(function (u) {
      return el("div", { "class": "upd" }, el("span", { "class": "w", text: ago(u.at) }),
        el("span", {}, u.meeting.source && !muni ? el("span", { "class": "src", text: u.meeting.source + " · " }) : null,
          el("a", { href: "/m/" + encodeURIComponent(u.meeting.id), text: u.meeting.title }), ": " + u.text));
    })));
  }, function (e) { offline(box, e); });
}

var timer = null;
function onFilter() { clearTimeout(timer); timer = setTimeout(function () { loadPast(false); }, 250); }
["f-body", "f-from", "f-to"].forEach(function (id) { document.getElementById(id).addEventListener("change", function () { loadPast(false); }); });
document.getElementById("f-q").addEventListener("input", onFilter);
document.getElementById("more").addEventListener("click", function () { loadPast(true); });

// On a phone the updates start closed: the meetings come first.
if (window.matchMedia && window.matchMedia("(max-width: 900px)").matches) document.getElementById("updbox").open = false;
renderMe(document.getElementById("me"), false);
loadUpcoming(); loadPast(false); loadUpdates();
setInterval(function () { if (!document.hidden) { loadUpcoming(); loadUpdates(); } }, 30000);
</script>
</body>
</html>
`;
