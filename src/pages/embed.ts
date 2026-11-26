/**
 * /embed/:slug : one meeting's video on its own, for other sites' iframes
 * (openlangford.ca, say). The only page that may be framed (EMBED_ORIGINS,
 * serve.ts); it has no sign-in, no account links and no actions, and reads
 * only the public meeting API and /media.
 *
 *   ?transcript=1   the searchable transcript under the video
 *   ?chapters=1     chapter buttons (the gaps where the capture dropped)
 *   ?title=0        hide the title bar (a link back to the meeting page)
 *   ?t=90           start at 1:30 (also 1m30s, 1:30)
 *   ?theme=light|dark   else follows the visitor's setting
 *
 * Captions (the transcript as subtitles) are always in the player's own
 * captions menu. While there's no video yet it shows where the meeting is
 * (starts in..., recording now, processing) and swaps in the player by
 * itself. __TITLE__ and __SLUG__ are filled per meeting; __TZ__ at startup.
 * Same String.raw rules as the other pages.
 */
import { BASE_CSS, BASE_JS, PLAYER_JS, PUBLIC_CSS, PUBLIC_JS } from "./common.js";

export const EMBED_PAGE = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>__TITLE__</title>
<link rel="icon" href="data:,">
<style>
${BASE_CSS}
${PUBLIC_CSS}
:root[data-theme="light"] { --bg: #f6f5f2; --panel: #ffffff; --ink: #1d1c1a; --muted: #6b6862; --line: #e4e1da;
  --accent: #2f5bd3; --ok: #1f7a4d; --warn: #a35a00; --live: #c2185b; color-scheme: light; }
:root[data-theme="dark"] { --bg: #141413; --panel: #1d1d1b; --ink: #ecebe7; --muted: #9a978f; --line: #2e2d2a;
  --accent: #7c9cff; --ok: #5cc28f; --warn: #e0a24a; --live: #ff6fa8; color-scheme: dark; }
html, body { margin: 0; height: 100%; }
body { display: flex; flex-direction: column; }
#box { flex: 1; min-height: 0; display: flex; flex-direction: column; }
#box video { flex: 1; min-height: 0; max-height: none; border-radius: 0; }
.tbar { display: flex; gap: 8px; align-items: baseline; justify-content: space-between; padding: 6px 10px; font-size: 13px; border-top: 1px solid var(--line); background: var(--panel); }
.tbar a { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; text-decoration: none; }
.tbar span { color: var(--muted); white-space: nowrap; }
.note { margin: auto; padding: 16px; max-width: 520px; text-align: center; }
.note b { display: block; font-size: 17px; margin-bottom: 4px; }
.note .hint { margin-top: 6px; }
#extra { overflow: auto; padding: 0 10px 10px; }
#extra .transcript { margin-top: 8px; } #extra .tlist { max-height: 40vh; }
</style>
</head>
<body>
<div id="box"><div class="note"><div class="hint">Loading...</div></div></div>
<script>
"use strict";
var TZ = __TZ__;
var SLUG = __SLUG__;
${BASE_JS}
${PLAYER_JS}
${PUBLIC_JS}
var Q = new URLSearchParams(location.search);
var theme = Q.get("theme");
if (theme === "light" || theme === "dark") document.documentElement.setAttribute("data-theme", theme);
var WANT = { transcript: Q.get("transcript") === "1", chapters: Q.get("chapters") === "1", title: Q.get("title") !== "0" };
var startT = startFrom(location.search), M = null, timer = null;
var box = document.getElementById("box");
// Links leave the frame: the meeting page is the permalink.
var HOME = "/m/" + encodeURIComponent(SLUG);

function note(title, text, extra) {
  fill(box, el("div", { "class": "note" }, el("b", { text: title }), text ? el("div", { "class": "hint", text: text }) : null, extra || null));
}
function homeLink(text) { return el("a", { href: HOME, target: "_blank", rel: "noopener", text: text }); }

function titleBar(m) {
  return el("div", { "class": "tbar" }, el("a", { href: HOME, target: "_blank", rel: "noopener", title: m.title, text: m.title }),
    el("span", { text: whenOf(m.start) }));
}

function render(m) {
  var prev = box.querySelector("video"), t = prev ? prev.currentTime : startT, playing = prev ? !prev.paused : false;
  M = m;
  if (m.hasVideo && m.recording && m.recording.video) {
    var holder = el("div", { style: "display:contents" }), extra = el("div", { id: "extra" });
    var v = play(m.recording, "/media/", holder, [], { bare: true, chapters: WANT.chapters, transcript: WANT.transcript });
    // play() puts the transcript panel after the video; lift it into the scrolling area.
    var panel = holder.querySelector(".transcript"), chap = holder.querySelector(".chapters");
    if (panel) extra.appendChild(panel);
    if (chap) extra.insertBefore(chap, extra.firstChild);
    fill(box, v, WANT.title ? titleBar(m) : null, extra.childNodes.length ? extra : null);
    if (t) v.addEventListener("loadedmetadata", function () { v.currentTime = t; if (playing) v.play().catch(function () {}); }, { once: true });
  } else if (m.stage === "live") {
    note("Recording now", "The video appears here when the meeting ends.", el("div", { "class": "hint" }, homeLink("Follow the live transcript")));
  } else if (m.stage === "stitching") {
    note("Processing the video", "It usually takes a few minutes. This updates by itself.");
  } else if (m.stage === "cancelled") {
    note("Cancelled", m.title);
  } else if (m.stage === "upcoming") {
    note(m.title, "Starts " + until(m.start) + " (" + whenOf(m.start) + ").");
  } else {
    note("No video", "This meeting wasn't recorded here.", el("div", { "class": "hint" }, homeLink("Meeting page")));
  }
  clearInterval(timer);
  if (["upcoming", "live", "stitching", "video_ready"].indexOf(m.stage) >= 0) timer = setInterval(poll, m.stage === "upcoming" ? 30000 : 10000);
}

function load() {
  return api("GET", "/api/meetings/" + encodeURIComponent(SLUG)).then(render, function (e) {
    note("Not available", /no such/.test(e.message) ? "This meeting isn't available." : "Can't reach the server.");
  });
}
function poll() {
  if (document.hidden || !M) return;
  api("GET", "/api/meetings/" + encodeURIComponent(SLUG) + "/status").then(function (s) {
    if (s.stage !== M.stage || s.hasVideo !== M.hasVideo || s.hasTranscript !== M.hasTranscript) load();
  }, function () {});
}
load();
</script>
</body>
</html>
`;
