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
</style>
</head>
<body>
<header>
  <h1><a href="/">minutes</a></h1>
  <span class="me" id="me"></span>
</header>
<p class="intro">Public meetings: what's coming up, and video and transcripts of the ones that have happened, usually the same night. Transcripts are machine-made: check the video before quoting.</p>
<main>
  <section>
    <h2>Upcoming</h2>
    <div class="list" id="upcoming"><div class="empty">Loading...</div></div>
  </section>
  <section>
    <h2>Past meetings</h2>
    <div class="filters">
      <select id="f-body" aria-label="Body"><option value="">All bodies</option></select>
      <input id="f-from" type="date" aria-label="From date">
      <input id="f-to" type="date" aria-label="To date">
      <input id="f-q" class="q" type="search" placeholder="Search by title" aria-label="Search by title">
    </div>
    <div class="list" id="past"><div class="empty">Loading...</div></div>
    <div class="hint" id="pastcount"></div>
    <button class="more" id="more" hidden>Show more</button>
  </section>
  <section>
    <h2>Recent updates</h2>
    <div id="updates"><div class="empty">Loading...</div></div>
  </section>
</main>
<script>
"use strict";
var TZ = __TZ__;
${BASE_JS}
${PUBLIC_JS}
// Old shared links were /#<recording>: send them to the meeting's page.
if (location.hash.length > 1) location.replace("/m/" + encodeURIComponent(decodeURIComponent(location.hash.slice(1))));

function offline(box, e) { fill(box, el("div", { "class": "empty", text: "Can't reach the server: " + e.message })); }

function loadUpcoming() {
  var box = document.getElementById("upcoming");
  return api("GET", "/api/meetings?scope=upcoming&limit=50").then(function (d) {
    if (!d.meetings.length) { fill(box, el("div", { "class": "empty", text: "No upcoming meetings listed." })); return; }
    fill.apply(null, [box].concat(d.meetings.map(meetingCard)));
  }, function (e) { offline(box, e); });
}

var shown = 0, haveBodies = false;
function pastQuery(offset) {
  var q = "scope=past&limit=25&offset=" + offset;
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

function loadUpdates() {
  var box = document.getElementById("updates");
  return api("GET", "/api/changes?limit=15").then(function (cs) {
    if (!cs.length) { fill(box, el("div", { "class": "empty", text: "Nothing has changed lately." })); return; }
    fill.apply(null, [box].concat(cs.map(function (c) {
      return el("div", { "class": "upd" }, el("span", { "class": "w", text: ago(c.at) }),
        el("span", {}, el("a", { href: "/m/" + encodeURIComponent(c.meeting.id), text: c.meeting.title }), ": " + changeText(c)));
    })));
  }, function (e) { offline(box, e); });
}

var timer = null;
function onFilter() { clearTimeout(timer); timer = setTimeout(function () { loadPast(false); }, 250); }
["f-body", "f-from", "f-to"].forEach(function (id) { document.getElementById(id).addEventListener("change", function () { loadPast(false); }); });
document.getElementById("f-q").addEventListener("input", onFilter);
document.getElementById("more").addEventListener("click", function () { loadPast(true); });

renderMe(document.getElementById("me"), false);
loadUpcoming(); loadPast(false); loadUpdates();
setInterval(function () { if (!document.hidden) { loadUpcoming(); loadUpdates(); } }, 30000);
</script>
</body>
</html>
`;
