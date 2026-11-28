/**
 * /m/:slug : one meeting. Where it is (stage), filled in as results land
 * without a reload: the countdown, the live transcript draft, "processing",
 * the player the moment the video exists, the transcript as it finishes.
 * Then the city's own links and documents, and the meeting's history
 * (announced, moved, cancelled, documents added).
 *
 * Data: /api/meetings/:slug (detail + history) and /api/meetings/:slug/status
 * (polled). Files from /media. Never join links, the bot's display or logs.
 * The server fills __TITLE__, __DESC__ and __HEAD__ (canonical, Open Graph,
 * oEmbed discovery) per meeting. ?t=90 (or 1m30s, 1:30) starts the video
 * there; the Share section has the permalink, a link at the current time,
 * and the iframe code for /embed/<slug> (pages/embed.ts).
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
__HEAD__
<link rel="icon" href="data:,">
<style>
${BASE_CSS}
${PUBLIC_CSS}
#player[hidden], #livebox[hidden] { display: none; }
.sharebox > summary, .histbox > summary { cursor: pointer; font-weight: 600; font-size: 14px; }
.sharebox[open] > summary, .histbox[open] > summary { margin-bottom: 10px; }
.adminbox { border: 1px dashed var(--line, #8886); border-radius: 10px; padding: 10px 14px; }
.adminbox h2 { font-size: 14px; margin: 0 0 8px; }
.adminbox .btns { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.adminbox form { display: grid; gap: 6px; margin-top: 10px; max-width: 560px; }
.adminbox label { font-size: 13px; color: var(--muted); }
.adminbox input[type=text], .adminbox input[type=url], .adminbox input[type=datetime-local] { width: 100%; }
.adminbox .err { color: var(--bad); font-size: 13px; }
</style>
</head>
<body>
<header>
  <h1><a href="/">minutes</a></h1>
  <span class="me" id="me"></span>
</header>
<main>
  <p class="crumbs"><a href="/">&larr; All meetings</a> &middot; <a href="/search">Search transcripts</a></p>
  <section id="head"><div class="empty">Loading...</div></section>
  <section id="adminbox" hidden></section>
  <section id="player" hidden></section>
  <section id="livebox" hidden></section>
  <section id="links" hidden></section>
  <section id="share" hidden></section>
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
var startT = startFrom(location.search), shareKey = "", shareOpts = { transcript: false, chapters: false };
// el() takes children as arguments, not arrays.
function wrap(tag, attrs, kids) { return el.apply(null, [tag, attrs].concat(kids)); }

function gone(msg) {
  fill(document.getElementById("head"), el("div", { "class": "empty", text: msg }));
  ["player", "livebox", "share", "links", "history"].forEach(function (id) { document.getElementById(id).hidden = true; });
}

// How to join, for a meeting that is about to happen or happening (its number only, no passcode).
function joinBox(m) {
  if (!m.join) return null;
  return el("div", { "class": "joinbox" }, el("span", { "class": "l", text: "Join on " + m.join.platform + ": " }),
    el("a", { href: m.join.url, target: "_blank", rel: "noopener", text: m.join.platform === "Zoom" ? m.join.url.replace("https://", "") : "Open the meeting" }),
    el("span", { "class": "hint", text: (m.join.id ? " Meeting ID " + m.join.id + "." : "") + (m.join.platform === "Zoom" ? " Zoom asks for a passcode if the meeting has one." : "") }));
}

function cityLinks(m) {
  var items = [];
  if (m.agendaUrl) items.push(ext(m.agendaUrl, "Agenda"));
  if (m.pageUrl) items.push(ext(m.pageUrl, "Meeting page on the city's site"));
  if (m.streamUrl && !m.embed) items.push(ext(m.streamUrl, m.stage === "upcoming" || m.stage === "live" ? "Watch on the city's site" : "Video on the city's site"));
  return items;
}

// The banner under the title: what's going on with this meeting.
function banner(m) {
  untilNode = startedNode = null;
  var city = cityLinks(m);
  if (m.embed) {
    // The video is on YouTube: nothing here is "recorded" or "processing"; the transcript follows.
    if (m.stage === "upcoming") { untilNode = el("span", { text: until(m.start) }); return el("div", { "class": "banner" }, el("b", {}, "Starts ", untilNode), el("div", { "class": "hint", text: "The video plays here when the stream starts, and a transcript follows once the meeting is over. This page updates by itself." })); }
    if (m.stage === "live") return el("div", { "class": "banner live" }, el("b", { text: "Live now" }), el("div", { "class": "hint", text: "A transcript follows once the meeting is over." }));
    if (m.stage === "cancelled") return el("div", { "class": "banner off" }, el("b", { text: "Cancelled" }), el("div", { "class": "hint", text: "See the history below for when." }));
    return null;
  }
  switch (m.stage) {
    case "upcoming":
      untilNode = el("span", { text: until(m.start) });
      return el("div", { "class": "banner" }, el("b", {}, "Starts ", untilNode), joinBox(m),
        el("div", { "class": "hint", text: "Video and a transcript appear on this page if the meeting is recorded. This page updates by itself." }));
    case "live":
      startedNode = el("span", { text: m.startedAt ? "started " + ago(m.startedAt) : "" });
      return el("div", { "class": "banner live" }, el("b", {}, "Recording now ", startedNode), joinBox(m),
        el("div", { "class": "hint", text: "The video appears here when the meeting ends. A draft transcript follows along below." }));
    case "stitching":
      return el("div", { "class": "banner warn" }, el("b", { text: "Processing the video" }),
        el("div", { "class": "hint", text: "The recording is being imported or put together. It usually takes a few minutes, and this page updates by itself." }));
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
  var facts = el("div", { "class": "facts" }, m.source ? muniBadge(m) : null, stagePill(m.stage), whenOf(m.start), m.body && m.body !== m.title ? " · " + m.body : null, m.duration ? " · " + hms(m.duration) : null);
  fill(document.getElementById("head"), el("h2", { "class": "mtitle", text: m.title }), facts, banner(m));
}

// A meeting whose video is on YouTube: the player is YouTube's, embedded once (a poll never reloads it); the transcript beside it
// follows it and seeks it. Our own recording of the sound is never shown.
var yt = null;
function renderEmbedded(m, box) {
  var r = m.recording, f = (r && r.files) || {};
  if (!yt || yt.id !== m.embed.id) {
    var frame = youtubeFrame(m.embed.id, { title: m.title, start: startT });
    var links = el("span", { "class": "links" }, el("a", { href: "https://www.youtube.com/watch?v=" + encodeURIComponent(m.embed.id), target: "_blank", rel: "noopener", text: "Watch on YouTube" }));
    yt = { id: m.embed.id, v: frame.v, tkey: null, links: links, panel: el("div", { "class": "transcript" }) };
    fill(box, el("div", { "class": "player-title" }, links), el("div", { "class": "ytbox" }, frame.frame), yt.panel);
  }
  var key = f.transcript ? f.transcript : "note:" + (r && r.transcript ? r.transcript.status + ":" + r.transcript.progress : "none");
  if (key !== yt.tkey) {
    yt.tkey = key;
    [["txt", "Transcript"], ["srt", "SRT"]].forEach(function (x) {
      if (f[x[0]] && !yt.links.querySelector("[data-k='" + x[0] + "']")) {
        yt.links.appendChild(document.createTextNode(" · "));
        yt.links.appendChild(el("a", { href: mediaUrl("/media/", r.slug, f[x[0]]), download: f[x[0]], text: x[1], "data-k": x[0] }));
      }
    });
    if (f.transcript) loadTranscript(mediaUrl("/media/", r.slug, f.transcript), yt.v, yt.panel);
    else fill(yt.panel, el("div", { "class": "hint", text: r ? (transcriptNote({ video: true, transcript: r.transcript }) || "No transcript.") : "A transcript appears here once the meeting has been transcribed." }));
  }
  box.hidden = false;
}

function renderPlayer(m) {
  var box = document.getElementById("player");
  if (m.embed && !(m.hasVideo && m.recording && m.recording.video)) { renderEmbedded(m, box); return; }
  yt = null;
  if (!m.hasVideo || !m.recording || !m.recording.video) { box.hidden = true; fill(box); return; }
  var v = box.querySelector("video"), t = v ? v.currentTime : startT, playing = v ? !v.paused : false;
  play(m.recording, "/media/", box, null, { noTitle: true });   // the title is already at the top of the page
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

function copy(text, btn, input) {
  var was = btn.textContent;
  function done(ok) {
    btn.textContent = ok ? "Copied" : "Press Ctrl+C";
    if (!ok && input) { input.focus(); input.select(); }
    setTimeout(function () { btn.textContent = was; }, 2000);
  }
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(function () { done(true); }, function () { done(false); });
  else done(false);
}
function attr(s) { return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }

// Permalink, a link at the current time, and the iframe code. Built once per
// meeting (a poll-driven reload keeps the open details and ticked options).
function renderShare(m) {
  var box = document.getElementById("share");
  var key = m.id + "|" + m.hasVideo;
  if (key === shareKey) return;
  shareKey = key;
  var link = location.origin + "/m/" + encodeURIComponent(m.id);
  var linkIn = el("input", { type: "text", readonly: "", value: link, "aria-label": "Link to this meeting" });
  var copyBtn = el("button", { text: "Copy link", on: { click: function () { copy(linkIn.value, copyBtn, linkIn); } } });
  var atBtn = m.hasVideo ? el("button", { text: "Copy link at current time", on: { click: function () {
    var v = document.querySelector("#player video"), s = v ? Math.floor(v.currentTime) : (yt ? Math.floor(yt.v.currentTime) : 0);
    linkIn.value = link + (s ? "?t=" + s : "");
    copy(linkIn.value, atBtn, linkIn);
  } } }) : null;
  var code = el("textarea", { readonly: "", rows: "4", "aria-label": "Embed code" });
  function snippet() {
    var q = [];
    if (shareOpts.transcript) q.push("transcript=1");
    if (shareOpts.chapters) q.push("chapters=1");
    var src = location.origin + "/embed/" + encodeURIComponent(m.id) + (q.length ? "?" + q.join("&") : "");
    code.value = '<iframe src="' + attr(src) + '" width="640" height="' + (shareOpts.transcript ? 640 : 360) +
      '" frameborder="0" allow="fullscreen" allowfullscreen title="' + attr(m.title) + '"></iframe>';
  }
  function opt(name, label) {
    var cb = el("input", { type: "checkbox" });
    cb.checked = shareOpts[name];
    cb.addEventListener("change", function () { shareOpts[name] = cb.checked; snippet(); });
    return el("label", { "class": "opt" }, cb, label);
  }
  snippet();
  var copyCode = el("button", { text: "Copy code", on: { click: function () { copy(code.value, copyCode, code); } } });
  var soon = (m.stage === "upcoming" || m.stage === "live") && !m.cancelled;
  var calBtn = soon ? el("button", { text: "Add to calendar", on: { click: function () { downloadCalendar(m, link); } } }) : null;
  if (!m.hasVideo) {
    // Nothing to embed yet: just the link, and the calendar entry for a meeting still to come.
    fill(box, el("div", { "class": "share-row" }, linkIn, copyBtn, calBtn));
  } else {
    fill(box, el("details", { "class": "sharebox" }, el("summary", { text: "Share and embed" }),
      el("div", { "class": "share-row" }, linkIn, copyBtn, atBtn, calBtn),
      el("details", { "class": "embed" }, el("summary", { text: "Embed on your site" }),
        el("div", { "class": "hint", text: "Paste into a page to show the video there. It updates by itself, and plays the same captions." }),
        opt("transcript", "Include the transcript"), opt("chapters", "Include chapters"), code, el("div", {}, copyCode))));
  }
  box.hidden = false;
}

// A calendar entry (.ics) for a meeting that is coming up: built here, nothing is sent anywhere.
function icsText(s) { return String(s).replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n"); }
function downloadCalendar(m, link) {
  function stamp(iso) { return new Date(iso).toISOString().replace(/[-:]|\.\d{3}/g, ""); }
  var end = m.end || new Date(Date.parse(m.start) + 2 * 3600000).toISOString();
  var lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//minutes//meetings//EN", "CALSCALE:GREGORIAN", "BEGIN:VEVENT",
    "UID:" + m.id + "@" + location.host, "DTSTAMP:" + stamp(new Date().toISOString()), "DTSTART:" + stamp(m.start), "DTEND:" + stamp(end),
    "SUMMARY:" + icsText((m.source ? m.source + ": " : "") + m.title), "URL:" + link,
    "DESCRIPTION:" + icsText("Video and transcript: " + link + (m.join ? "\nJoin on " + m.join.platform + ": " + m.join.url : "")), "END:VEVENT", "END:VCALENDAR"];
  var blob = new Blob([lines.join("\r\n") + "\r\n"], { type: "text/calendar" });
  var a = el("a", { href: URL.createObjectURL(blob), download: m.id + ".ics" });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
}

function renderLinks(m) {
  var box = document.getElementById("links");
  var city = cityLinks(m);
  if (!city.length && !m.documents.length) { box.hidden = true; fill(box); return; }
  // A document already linked above (the agenda, the meeting page, the video) is not listed again.
  var docs = m.documents.filter(function (d) { return d.url !== m.agendaUrl && d.url !== m.pageUrl && d.url !== m.streamUrl; });
  fill(box, el("h2", { text: "From the city" }),
    city.length ? wrap("div", { "class": "linkrow" }, city) : null,
    docs.length ? wrap("ul", { "class": "docs" }, docs.map(function (d) {
      return el("li", {}, ext(d.url, d.title),
        d.copy ? el("a", { "class": "k", href: d.copy, target: "_blank", rel: "noopener", text: "stored copy" }) : null);
    })) : null);
  box.hidden = false;
}

// What changed since the meeting was announced: closed until asked for (it is the least-read part of the page), and it keeps its
// open or closed state when the page refreshes itself.
var historyOpen = false;
function renderHistory(m) {
  var box = document.getElementById("history");
  if (!m.history.length) { box.hidden = true; fill(box); return; }
  var d = el("details", { "class": "histbox" }, el("summary", { text: "History (" + m.history.length + (m.history.length === 1 ? " change)" : " changes)") }),
    wrap("div", {}, m.history.map(function (c) {
      return el("div", { "class": "upd" }, el("span", { "class": "w", text: whenOf(c.at) }), el("span", { text: changeText(c) }));
    })), el("div", { "class": "hint", text: "Changes found on the city's own site, newest first. Times in " + TZ + "." }));
  d.open = historyOpen;
  d.addEventListener("toggle", function () { historyOpen = d.open; });
  fill(box, d);
  box.hidden = false;
}

// Admins only: edit a meeting's details or delete it. The server checks the capability on every call;
// this only decides whether to show the controls.
var ADMIN = false, editing = false, adminKey = "";
function localInput(iso) {
  var p = {};
  new Intl.DateTimeFormat("en-CA", { timeZone: TZ, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
    .formatToParts(new Date(iso)).forEach(function (x) { p[x.type] = x.value; });
  return p.year + "-" + p.month + "-" + p.day + "T" + p.hour + ":" + p.minute;
}
function renderAdmin(m) {
  var box = document.getElementById("adminbox");
  if (!ADMIN) { box.hidden = true; fill(box); return; }
  var key = m.id + "|" + editing;
  if (key === adminKey) return;
  adminKey = key;
  box.className = "adminbox";
  box.hidden = false;
  var msg = el("div", { "class": "err", role: "alert" });
  var edit = el("button", { text: "Edit details", on: { click: function () { editing = true; renderAdmin(M); openForm(); } } });
  var del = el("button", { "class": "danger", text: "Delete meeting", on: { click: function () {
    if (!confirm("Delete " + m.title + "? This can't be undone.")) return;
    api("DELETE", "/api/admin/meetings/" + encodeURIComponent(m.id)).then(function () { location.href = "/"; },
      function (e) { msg.textContent = e.message; });
  } } });
  fill(box, el("h2", { text: "Admin" }), el("div", { "class": "btns" }, editing ? null : edit, editing ? null : del,
    el("a", { href: "/admin#recordings", text: "Open in admin" })), el("div", { id: "editform" }), msg);
  if (editing) openForm();
}
function openForm() {
  var host = document.getElementById("editform");
  var msg = host.parentNode.querySelector(".err");
  api("GET", "/api/admin/meetings/" + encodeURIComponent(M.id)).then(function (d) {
    var f = {};
    function field(name, label, type, value, hint) {
      var input = el("input", { type: type, id: "ed-" + name, value: value || "" });
      f[name] = input;
      return [el("label", { "for": "ed-" + name, text: label }), input, hint ? el("div", { "class": "hint", text: hint }) : null];
    }
    var kids = [].concat(
      field("title", "Title", "text", d.title),
      field("body", "Body or committee", "text", d.body),
      d.feedId ? [el("div", { "class": "hint", text: "Starts at " + whenOf(d.start) + ". The start comes from " + d.feedName + " and can't be edited here." })]
        : field("start", "Starts (" + TZ + ")", "datetime-local", localInput(d.start)),
      field("agendaUrl", "Agenda address", "url", d.agendaUrl),
      field("pageUrl", "Meeting page address", "url", d.pageUrl),
      field("streamUrl", "Video page address", "url", d.streamUrl));
    var save = el("button", { type: "submit", "class": "primary", text: "Save" });
    var cancel = el("button", { type: "button", text: "Cancel", on: { click: function () { editing = false; adminKey = ""; renderAdmin(M); } } });
    var form = wrap("form", {}, kids.filter(Boolean).concat([
      d.feedId ? el("div", { "class": "hint", text: "Details you change stay as you set them when the feed is checked again." }) : null,
      el("div", { "class": "btns" }, save, cancel)].filter(Boolean)));
    form.addEventListener("submit", function (ev) {
      ev.preventDefault();
      var body = { title: f.title.value, body: f.body.value, agendaUrl: f.agendaUrl.value, pageUrl: f.pageUrl.value, streamUrl: f.streamUrl.value };
      if (f.start && f.start.value) body.startLocal = f.start.value;
      save.disabled = true; msg.textContent = "";
      api("PATCH", "/api/admin/meetings/" + encodeURIComponent(M.id), body).then(function () {
        editing = false; adminKey = ""; load();
      }, function (e) { save.disabled = false; msg.textContent = e.message; });
    });
    fill(host, form);
  }, function (e) { msg.textContent = e.message; });
}

function render(m) {
  M = m;
  renderAdmin(m);
  renderHead(m); renderPlayer(m); renderLive(m); renderShare(m); renderLinks(m); renderHistory(m);
  schedule();
}

function load() {
  return api("GET", "/api/meetings/" + encodeURIComponent(SLUG)).then(function (m) {
    // The permalink is the meeting's own slug, whatever name the link used.
    if (m.id !== SLUG) { SLUG = m.id; history.replaceState(null, "", "/m/" + encodeURIComponent(m.id) + location.search); }
    render(m);
  }, function (e) {
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
api("GET", "/api/me").then(function (d) {
  ADMIN = !!d.user && d.user.caps.indexOf("admin.view") >= 0;
  if (M) renderAdmin(M);
}, function () {});
load();
</script>
</body>
</html>
`;
