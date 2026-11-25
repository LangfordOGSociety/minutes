/**
 * / : what anyone may see. Published recordings with their transcripts,
 * and meetings being recorded right now with the live draft transcript.
 * Never join links, meeting IDs, the bot's screen, logs, failed attempts or
 * the Zoom login state: the data comes from /api/recordings, which only
 * has the public fields, and files from /media, which only serves the
 * public ones (serve.ts).
 *
 * Same String.raw rules as the other pages. __TZ__ is replaced at startup.
 */
import { BASE_CSS, BASE_JS, PLAYER_JS } from "./common.js";

export const PUBLIC_PAGE = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>minutes</title>
<meta name="description" content="Recordings and transcripts of public meetings.">
<link rel="icon" href="data:,">
<style>
${BASE_CSS}
main { max-width: 1100px; margin: 0 auto; padding: 12px 24px 40px; }
@media (max-width: 900px) { main { padding: 12px 16px 32px; } }
.intro { color: var(--muted); margin: 0 24px 4px; font-size: 14px; max-width: 1100px; }
@media (min-width: 1148px) { .intro { margin: 0 auto 4px; padding: 0 24px; } }
#player[hidden], #livebox[hidden] { display: none; }
</style>
</head>
<body>
<header>
  <h1><a href="/">minutes</a></h1>
  <span class="me" id="me"></span>
</header>
<p class="intro">Recordings and transcripts of public meetings, usually the same night. Transcripts are machine-made: check the video before quoting.</p>
<main>
  <section id="player" hidden></section>
  <section id="livebox" hidden></section>
  <section>
    <h2>Recordings</h2>
    <div class="list" id="recs"><div class="empty">Loading...</div></div>
  </section>
</main>
<script>
"use strict";
var TZ = __TZ__;
${BASE_JS}
${PLAYER_JS}
var selected = null, following = null, stopLive = null;

function render(recs) {
  var box = document.getElementById("recs");
  fill(box);
  if (!recs.length) { box.appendChild(el("div", { "class": "empty", text: "No recordings yet." })); return; }
  recs.forEach(function (r) {
    var sub = fmt(r.scheduledStart) + (r.duration ? " · " + hms(r.duration) : "") +
      (r.video ? (r.files.transcript ? " · transcript" : transcriptNote(r) ? " · " + transcriptNote(r).toLowerCase() : "") : " · recording now");
    var actions = el("div", { "class": "actions" },
      r.video ? el("button", { text: selected === r.slug ? "Playing" : "Play", on: { click: function () { openRec(r); } } }) : null,
      r.active && r.files.live ? el("button", { text: following === r.slug ? "Following" : "Live transcript", on: { click: function () { live(r); } } }) : null);
    box.appendChild(el("div", { "class": "row" + (selected === r.slug || following === r.slug ? " selected" : "") },
      el("div", { "class": "title" }, r.active ? pill("live") : null, r.title || r.slug), actions, el("div", { "class": "sub", text: sub })));
  });
}

function openRec(r) {
  closeLive();
  selected = r.slug;
  var p = document.getElementById("player");
  play(r, "/media/", p);
  history.replaceState(null, "", "#" + encodeURIComponent(r.slug));
  p.scrollIntoView({ behavior: "smooth", block: "start" });
  refresh();
}

function live(r) {
  var p = document.getElementById("player");
  p.hidden = true; fill(p); selected = null;
  closeLive();
  following = r.slug;
  var box = document.getElementById("livebox");
  var list = el("div", { "class": "tlist live-t" }), note = el("div", { "class": "hint" });
  fill(box, el("div", { "class": "player-title" }, el("h3", { text: (r.title || r.slug) + " (live)" }),
      el("button", { text: "Close", on: { click: function () { closeLive(); refresh(); } } })),
    el("div", { "class": "hint", text: "Being recorded now. The video appears here once the meeting ends." }),
    el("h3", { "class": "live-h", text: "Live transcript (draft)" }), list, note);
  box.hidden = false;
  stopLive = followLive(mediaUrl("/media/", r.slug, "live.json"), list, note);
  refresh();
}
function closeLive() {
  if (stopLive) { stopLive(); stopLive = null; }
  following = null;
  var box = document.getElementById("livebox"); box.hidden = true; fill(box);
}

var first = true;
function refresh() {
  return api("GET", "/api/recordings").then(function (recs) {
    render(recs);
    // A shared link (#slug) opens that recording.
    if (first) {
      first = false;
      var want = decodeURIComponent(location.hash.slice(1));
      var r = recs.find(function (x) { return x.slug === want; });
      if (r && r.video) openRec(r);
    }
  }, function (e) { fill(document.getElementById("recs"), el("div", { "class": "empty", text: "Can't reach the server: " + e.message })); });
}

renderMe(document.getElementById("me"), false);
refresh();
setInterval(function () { if (!document.hidden) refresh(); }, 15000);
</script>
</body>
</html>
`;
