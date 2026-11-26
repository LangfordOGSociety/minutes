/**
 * /m/:slug : one meeting. Where it is (stage), filled in as results land
 * without a reload: the countdown, the live transcript draft, "processing",
 * the player the moment the video exists, the transcript as it finishes.
 * Then the city's own links and documents, and the meeting's history
 * (announced, moved, cancelled, documents added).
 *
 * Data: /api/meetings/:slug (detail + history) and /api/meetings/:slug/status
 * (polled). Files from /media. Never join links, the bot's display or logs.
 * The server fills __TITLE__ and __DESC__ per meeting for link previews.
 *
 * Same String.raw rules as the other pages. __TZ__ is replaced at startup.
 */
import { BASE_CSS, BASE_JS, PLAYER_JS, PUBLIC_CSS, PUBLIC_JS } from "./common.js";

export const MEETING_PAGE = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>__TITLE__</title>
<meta name="description" content="__DESC__">
<link rel="icon" href="data:,">
<style>
${BASE_CSS}
${PUBLIC_CSS}
#player[hidden], #livebox[hidden] { display: none; }
</style>
</head>
<body>
<header>
  <h1><a href="/">minutes</a></h1>
  <span class="me" id="me"></span>
</header>
<main>
  <p class="crumbs"><a href="/">&larr; All meetings</a></p>
  <section id="head"><div class="empty">Loading...</div></section>
  <section id="player" hidden></section>
  <section id="livebox" hidden></section>
  <section id="links" hidden></section>
  <section id="history" hidden></section>
</main>
<script>
"use strict";
var TZ = __TZ__;
${BASE_JS}
${PLAYER_JS}
${PUBLIC_JS}
var SLUG = decodeURIComponent(location.pathname.split("/")[2] || "");
var M = null, stopLive = null, untilNode = null, startedNode = null, timer = null;
// el() takes children as arguments, not arrays.
function wrap(tag, attrs, kids) { return el.apply(null, [tag, attrs].concat(kids)); }

function gone(msg) {
  fill(document.getElementById("head"), el("div", { "class": "empty", text: msg }));
  ["player", "livebox", "links", "history"].forEach(function (id) { document.getElementById(id).hidden = true; });
}

function cityLinks(m) {
  var items = [];
  if (m.agendaUrl) items.push(ext(m.agendaUrl, "Agenda"));
  if (m.pageUrl) items.push(ext(m.pageUrl, "Meeting page on the city's site"));
  if (m.streamUrl) items.push(ext(m.streamUrl, m.stage === "upcoming" || m.stage === "live" ? "Watch on the city's site" : "Video on the city's site"));
  return items;
}

// The banner under the title: what's going on with this meeting.
function banner(m) {
  untilNode = startedNode = null;
  var city = cityLinks(m);
  switch (m.stage) {
    case "upcoming":
      untilNode = el("span", { text: until(m.start) });
      return el("div", { "class": "banner" }, el("b", {}, "Starts ", untilNode),
        el("div", { "class": "hint", text: "Video and a transcript appear on this page if the meeting is recorded. This page updates by itself." }));
    case "live":
      startedNode = el("span", { text: m.startedAt ? "started " + ago(m.startedAt) : "" });
      return el("div", { "class": "banner live" }, el("b", {}, "Recording now ", startedNode),
        el("div", { "class": "hint", text: "The video appears here when the meeting ends. A draft transcript follows along below." }));
    case "stitching":
      return el("div", { "class": "banner warn" }, el("b", { text: "Processing the video" }),
        el("div", { "class": "hint", text: "The recording is being put together. It usually takes a few minutes, and this page updates by itself." }));
    case "video_ready":
      return null;   // the player's transcript panel says how far the transcriber is
    case "failed":
      return el("div", { "class": "banner off" }, el("b", { text: "This meeting couldn't be recorded" }),
        el("div", { "class": "hint", text: city.length ? "The city's own pages may have the video." : "No recording exists." }));
    case "not_recorded":
      return el("div", { "class": "banner off" }, el("b", { text: "This meeting wasn't recorded here" }),
        el("div", { "class": "hint", text: city.length ? "The city's own pages may have the video." : "No recording exists." }));
    case "cancelled":
      return el("div", { "class": "banner off" }, el("b", { text: "Cancelled" }), el("div", { "class": "hint", text: "See the history below for when." }));
  }
  return null;
}

function renderHead(m) {
  var facts = el("div", { "class": "facts" }, stagePill(m.stage), whenOf(m.start),
    m.body && m.body !== m.title ? " · " + m.body : null, m.duration ? " · " + hms(m.duration) : null);
  fill(document.getElementById("head"), el("h2", { "class": "mtitle", text: m.title }), facts, banner(m));
}

function renderPlayer(m) {
  var box = document.getElementById("player");
  if (!m.hasVideo || !m.recording || !m.recording.video) { box.hidden = true; fill(box); return; }
  var v = box.querySelector("video"), t = v ? v.currentTime : 0, playing = v ? !v.paused : false;
  play(m.recording, "/media/", box);
  if (t) {
    v = box.querySelector("video");
    v.addEventListener("loadedmetadata", function () { v.currentTime = t; if (playing) v.play(); }, { once: true });
  }
}

function renderLive(m) {
  var box = document.getElementById("livebox");
  if (stopLive) { stopLive(); stopLive = null; }
  var f = m.recording && m.recording.files || {};
  if (m.stage !== "live" || !f.live) { box.hidden = true; fill(box); return; }
  var list = el("div", { "class": "tlist live-t" }), note = el("div", { "class": "hint" });
  fill(box, el("h3", { "class": "live-h", text: "Live transcript (draft)" }), list, note);
  box.hidden = false;
  stopLive = followLive(mediaUrl("/media/", m.recording.slug, f.live), list, note);
}

function renderLinks(m) {
  var box = document.getElementById("links");
  var city = cityLinks(m);
  if (!city.length && !m.documents.length) { box.hidden = true; fill(box); return; }
  var docs = m.documents.filter(function (d) { return d.url !== m.agendaUrl; });
  fill(box, el("h2", { text: "From the city" }),
    city.length ? wrap("div", { "class": "linkrow" }, city) : null,
    docs.length ? wrap("ul", { "class": "docs" }, docs.map(function (d) {
      return el("li", {}, ext(d.url, d.title), d.type ? el("span", { "class": "k", text: d.type }) : null);
    })) : null);
  box.hidden = false;
}

function renderHistory(m) {
  var box = document.getElementById("history");
  if (!m.history.length) { box.hidden = true; fill(box); return; }
  fill(box, el("h2", { text: "History" }), wrap("div", {}, m.history.map(function (c) {
    return el("div", { "class": "upd" }, el("span", { "class": "w", text: whenOf(c.at) }), el("span", { text: changeText(c) }));
  })), el("div", { "class": "hint", text: "Changes found on the city's own site, newest first. Times in " + TZ + "." }));
  box.hidden = false;
}

function render(m) {
  M = m;
  renderHead(m); renderPlayer(m); renderLive(m); renderLinks(m); renderHistory(m);
  schedule();
}

function load() {
  return api("GET", "/api/meetings/" + encodeURIComponent(SLUG)).then(render, function (e) {
    gone(/no such/.test(e.message) ? "This meeting isn't available." : "Can't reach the server: " + e.message);
  });
}

// While anything is pending, ask for the small status and reload when it moved.
function poll() {
  if (document.hidden || !M) return;
  api("GET", "/api/meetings/" + encodeURIComponent(SLUG) + "/status").then(function (s) {
    var t = s.transcript;
    var moved = s.stage !== M.stage || s.hasVideo !== M.hasVideo || s.hasTranscript !== M.hasTranscript;
    if (moved) { load(); return; }
    var hint = document.querySelector("#player .transcript .hint");
    if (M.stage === "video_ready" && hint && t) hint.textContent = transcriptNote({ video: true, transcript: t });
    if (untilNode) untilNode.textContent = until(M.start);
    if (startedNode && M.startedAt) startedNode.textContent = "started " + ago(M.startedAt);
  }, function (e) { if (/no such/.test(e.message)) gone("This meeting isn't available."); });
}
function schedule() {
  clearInterval(timer);
  var fast = M && (M.stage === "live" || M.stage === "stitching" || M.stage === "video_ready");
  if (M && (fast || M.stage === "upcoming")) timer = setInterval(poll, fast ? 10000 : 30000);
}

renderMe(document.getElementById("me"), false);
load();
</script>
</body>
</html>
`;
