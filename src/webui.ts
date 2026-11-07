/**
 * The single page served at /. Plain HTML/CSS/JS, no build step, no CDN.
 * All server data is inserted with textContent (never innerHTML), so meeting
 * names and log lines can't inject markup.
 *
 * Kept as a TS string so `tsc` ships it in dist/. The script below must not
 * use backticks or dollar-brace: it lives inside a template literal.
 * __TZ__ is replaced with the server's timezone (JSON string) at startup.
 */
export const PAGE = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>zoom-capture</title>
<link rel="icon" href="data:,">
<style>
:root {
  --bg: #f6f5f2; --panel: #ffffff; --ink: #1d1c1a; --muted: #6b6862; --line: #e4e1da;
  --accent: #2f5bd3; --accent-ink: #ffffff; --ok: #1f7a4d; --warn: #a35a00; --bad: #b3261e; --live: #c2185b;
  --shadow: 0 1px 2px rgba(0,0,0,.04), 0 4px 16px rgba(0,0,0,.04);
  color-scheme: light;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #141413; --panel: #1d1d1b; --ink: #ecebe7; --muted: #9a978f; --line: #2e2d2a;
    --accent: #7c9cff; --accent-ink: #0d0d0c; --ok: #5cc28f; --warn: #e0a24a; --bad: #ff7b72; --live: #ff6fa8;
    --shadow: none; color-scheme: dark;
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink);
  font: 15px/1.45 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
header { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; padding: 20px 24px 8px; }
header h1 { font-size: 18px; margin: 0; letter-spacing: -.01em; }
header .meta { color: var(--muted); font-size: 13px; }
main { display: grid; grid-template-columns: minmax(320px, 420px) 1fr; gap: 20px; padding: 12px 24px 40px; align-items: start; }
@media (max-width: 900px) { main { grid-template-columns: 1fr; padding: 12px 16px 32px; } header { padding: 16px 16px 4px; } }
section { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; box-shadow: var(--shadow); padding: 16px; min-width: 0; }
section + section { margin-top: 20px; }
h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); margin: 0 0 12px; font-weight: 600; }
label { display: block; font-size: 13px; font-weight: 600; margin: 10px 0 4px; }
label small { font-weight: 400; color: var(--muted); }
input { width: 100%; padding: 8px 10px; border: 1px solid var(--line); border-radius: 7px; background: var(--bg); color: var(--ink); font: inherit; }
input:focus { outline: 2px solid var(--accent); outline-offset: -1px; }
button { font: inherit; border-radius: 7px; border: 1px solid var(--line); background: var(--panel); color: var(--ink); padding: 6px 12px; cursor: pointer; }
button:hover { border-color: var(--muted); }
button.primary { background: var(--accent); color: var(--accent-ink); border-color: var(--accent); font-weight: 600; padding: 9px 14px; margin-top: 14px; width: 100%; }
button.danger { color: var(--bad); }
.msg { font-size: 13px; margin-top: 10px; min-height: 1em; }
.msg.err { color: var(--bad); } .msg.ok { color: var(--ok); }
.list { display: flex; flex-direction: column; gap: 8px; }
.row { display: grid; grid-template-columns: 1fr auto; gap: 4px 10px; padding: 10px 12px; border: 1px solid var(--line); border-radius: 8px; align-items: center; }
.row.selected { border-color: var(--accent); }
.row .title { font-weight: 600; overflow-wrap: anywhere; }
.row .sub { grid-column: 1 / -1; color: var(--muted); font-size: 13px; overflow-wrap: anywhere; }
.row .actions { display: flex; gap: 6px; }
.pill { display: inline-block; font-size: 11px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase;
  padding: 2px 7px; border-radius: 999px; border: 1px solid currentColor; margin-right: 6px; vertical-align: 1px; }
.s-scheduled, .s-queued { color: var(--accent); } .s-running { color: var(--live); } .s-stopping { color: var(--warn); }
.s-done, .s-ended { color: var(--ok); } .s-failed, .s-blocked, .s-interrupted, .s-invalid_link { color: var(--bad); } .s-cancelled, .s-stopped { color: var(--muted); }
.empty { color: var(--muted); font-size: 14px; padding: 6px 2px; }
video { width: 100%; max-height: 70vh; background: #000; border-radius: 8px; display: block; }
.player-title { display: flex; justify-content: space-between; gap: 10px; align-items: baseline; flex-wrap: wrap; margin-bottom: 10px; }
.player-title h3 { margin: 0; font-size: 16px; overflow-wrap: anywhere; }
.chapters { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
.chapters button { font-size: 13px; }
.live img { width: 100%; border-radius: 8px; background: #000; display: block; min-height: 120px; }
pre { background: var(--bg); border: 1px solid var(--line); border-radius: 8px; padding: 10px; font-size: 12px; line-height: 1.4;
  max-height: 260px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; margin: 10px 0 0; }
a { color: var(--accent); }
.hint { color: var(--muted); font-size: 13px; margin-top: 8px; }
.links { font-size: 14px; }
.transcript { margin-top: 14px; }
.thead { display: flex; gap: 10px; align-items: center; justify-content: space-between; flex-wrap: wrap; margin-bottom: 8px; }
.thead h4 { margin: 0; font-size: 13px; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); }
.thead input { width: auto; flex: 1 1 200px; max-width: 320px; padding: 6px 10px; }
.tlist { max-height: 46vh; overflow: auto; border: 1px solid var(--line); border-radius: 8px; }
.tline { display: grid; grid-template-columns: 4.2em minmax(0, 9em) 1fr; gap: 10px; width: 100%; text-align: left;
  border: 0; border-bottom: 1px solid var(--line); border-radius: 0; padding: 7px 10px; background: transparent; font-size: 14px; }
.tline:last-child { border-bottom: 0; }
.tline:hover { background: var(--bg); }
.tline.now { background: color-mix(in srgb, var(--accent) 14%, transparent); }
.tline .tt { color: var(--muted); font-variant-numeric: tabular-nums; }
.tline .tw { color: var(--accent); font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tline .tx { overflow-wrap: anywhere; }
@media (max-width: 600px) { .tline { grid-template-columns: 3.6em 1fr; } .tline .tw { grid-column: 2; } .tline .tx { grid-column: 1 / -1; } }
</style>
</head>
<body>
<header>
  <h1>zoom-capture</h1>
  <span class="meta" id="meta"></span>
</header>
<main>
  <div>
    <section>
      <h2>Schedule a meeting</h2>
      <form id="form" autocomplete="off">
        <label for="link">Zoom link or meeting ID</label>
        <input id="link" name="link" required placeholder="https://us06web.zoom.us/j/123456789?pwd=...">
        <small>Only an ID and passcode? Use https://zoom.us/j/ID?pwd=PASSCODE</small>
        <label for="start">Start time <small id="tzlabel"></small></label>
        <input id="start" name="start" type="datetime-local" required>
        <label for="slug">Name <small>(folder and file name, optional)</small></label>
        <input id="slug" name="slug" placeholder="council-2026-11-16" pattern="[A-Za-z0-9][A-Za-z0-9._\-]{0,79}">
        <label for="name">Shown in Zoom as <small>(optional)</small></label>
        <input id="name" name="name" placeholder="Recorder" maxlength="64">
        <button class="primary" type="submit">Schedule capture</button>
        <div class="msg" id="formmsg" role="status"></div>
      </form>
    </section>
    <section>
      <h2>Captures</h2>
      <div class="list" id="jobs"><div class="empty">Loading...</div></div>
    </section>
  </div>
  <div>
    <section id="viewer">
      <h2 id="viewer-h">Recordings</h2>
      <div id="player" hidden></div>
      <div id="live" class="live" hidden></div>
      <div class="list" id="recs"><div class="empty">Loading...</div></div>
    </section>
  </div>
</main>
<script>
"use strict";
var TZ = __TZ__;
var selectedRec = null, watching = null, liveTimer = null, lastJobs = [];

function el(tag, attrs) {
  var e = document.createElement(tag);
  if (attrs) for (var k in attrs) {
    if (k === "text") e.textContent = attrs[k];
    else if (k === "on") for (var ev in attrs.on) e.addEventListener(ev, attrs.on[ev]);
    else if (attrs[k] !== null && attrs[k] !== undefined && attrs[k] !== false) e.setAttribute(k, attrs[k]);
  }
  for (var i = 2; i < arguments.length; i++) {
    var c = arguments[i];
    if (c === null || c === undefined || c === false) continue;
    e.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return e;
}
// replaceChildren() turns a null argument into the text "null"; skip them.
function fill(node) {
  var kids = [];
  for (var i = 1; i < arguments.length; i++) if (arguments[i] !== null && arguments[i] !== undefined && arguments[i] !== false) kids.push(arguments[i]);
  node.replaceChildren.apply(node, kids);
  return node;
}
function pill(status) { return el("span", { "class": "pill s-" + status, text: status }); }
var fmtDT = new Intl.DateTimeFormat(undefined, { timeZone: TZ, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
function fmt(iso) { return iso ? fmtDT.format(new Date(iso)) : "?"; }
function mb(n) { return n === null || n === undefined ? "" : (n / 1048576).toFixed(n > 1e8 ? 0 : 1) + " MB"; }
function hms(s) { s = Math.round(s); var h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), r = s % 60;
  return (h ? h + ":" + String(m).padStart(2, "0") : m) + ":" + String(r).padStart(2, "0"); }

function api(method, url, body) {
  var opts = { method: method, headers: {} };
  if (body !== undefined) { opts.headers["Content-Type"] = "application/json"; opts.body = JSON.stringify(body); }
  return fetch(url, opts).then(function (r) {
    var ct = r.headers.get("content-type") || "";
    var p = ct.indexOf("json") >= 0 ? r.json() : r.text();
    return p.then(function (d) {
      if (!r.ok) throw new Error((d && d.error) || d || ("HTTP " + r.status));
      return d;
    });
  });
}

var ACTIVE = { running: 0, stopping: 1, queued: 2, scheduled: 3 };
function renderJobs(jobs) {
  lastJobs = jobs;
  var box = document.getElementById("jobs");
  fill(box);
  var active = jobs.filter(function (j) { return j.status in ACTIVE; })
    .sort(function (a, b) { return ACTIVE[a.status] - ACTIVE[b.status] || a.start.localeCompare(b.start); });
  var past = jobs.filter(function (j) { return !(j.status in ACTIVE); })
    .sort(function (a, b) { return (b.endedAt || b.start).localeCompare(a.endedAt || a.start); }).slice(0, 10);
  if (!active.length && !past.length) { box.appendChild(el("div", { "class": "empty", text: "Nothing scheduled yet." })); return; }
  active.concat(past).forEach(function (j) {
    var actions = el("div", { "class": "actions" });
    if (j.status === "running") {
      actions.appendChild(el("button", { text: watching === j.id ? "Watching" : "Watch", on: { click: function () { watch(j.id); } } }));
      actions.appendChild(el("button", { "class": "danger", text: "Stop", on: { click: function () {
        if (confirm("Stop recording " + j.slug + "? What's been recorded so far is kept and stitched.")) cancel(j.id);
      } } }));
    } else if (j.status === "scheduled" || j.status === "queued") {
      actions.appendChild(el("button", { "class": "danger", text: "Cancel", on: { click: function () {
        if (confirm("Cancel " + j.slug + "?")) cancel(j.id);
      } } }));
    }
    var sub = "Meeting " + j.meetingId + " · starts " + fmt(j.start) + " · as “" + j.name + "”";
    if (j.outcome) sub += " · outcome " + j.outcome;
    if (j.error) sub += " · " + j.error;
    box.appendChild(el("div", { "class": "row" + (watching === j.id ? " selected" : "") },
      el("div", { "class": "title" }, pill(j.status), j.slug), actions, el("div", { "class": "sub", text: sub })));
  });
}

function renderRecs(recs) {
  var box = document.getElementById("recs");
  fill(box);
  // Attempts that never got into a meeting have nothing to replay.
  recs = recs.filter(function (r) { return r.video || r.active || r.parts.length; });
  if (!recs.length) { box.appendChild(el("div", { "class": "empty", text: "No recordings yet." })); return; }
  recs.forEach(function (r) {
    var status = r.active ? "running" : r.outcome;
    var parts = r.parts.length + (r.parts.length === 1 ? " part" : " parts");
    var sub = fmt(r.scheduledStart) + " · " + parts + (r.chapters.length > 1 ? " · " + (r.chapters.length - 1) + " gap(s)" : "") +
      (r.videoBytes ? " · " + mb(r.videoBytes) : "") + (r.video ? "" : r.active ? " · recording now" : " · no video") +
      (r.files && r.files.transcript ? " · transcript" : r.video && transcriptNote(r) ? " · " + transcriptNote(r).toLowerCase() : "");
    var actions = el("div", { "class": "actions" },
      r.video ? el("button", { text: selectedRec === r.slug ? "Playing" : "Play", on: { click: function () { play(r); } } }) : null);
    box.appendChild(el("div", { "class": "row" + (selectedRec === r.slug ? " selected" : "") },
      el("div", { "class": "title" }, pill(status), r.slug), actions, el("div", { "class": "sub", text: sub })));
  });
}

function media(slug, file) { return "/media/" + encodeURIComponent(slug) + "/" + encodeURIComponent(file); }

function play(r) {
  stopWatching();
  selectedRec = r.slug;
  var src = media(r.slug, r.video), f = r.files || {};
  var v = el("video", { controls: "", preload: "metadata", src: src, crossorigin: "anonymous" });
  // Subtitles: the Whisper transcript on by default; Zoom's own captions as
  // a second, optional track (reference only).
  if (f.vtt) v.appendChild(el("track", { kind: "subtitles", srclang: "en", label: "Transcript", src: media(r.slug, f.vtt), "default": "" }));
  if (f.zoomCaptions) v.appendChild(el("track", { kind: "subtitles", srclang: "en", label: "Zoom captions", src: media(r.slug, f.zoomCaptions) }));
  var chapters = el("div", { "class": "chapters" });
  r.chapters.forEach(function (c) {
    chapters.appendChild(el("button", { text: hms(c.at) + "  " + c.title, on: { click: function () { v.currentTime = c.at; v.play(); } } }));
  });
  var links = el("span", { "class": "links" }, el("a", { href: src, download: r.video, text: "Video" }));
  [["txt", "Transcript"], ["srt", "SRT"], ["zoomCaptions", "Zoom captions"]].forEach(function (x) {
    if (f[x[0]]) { links.appendChild(document.createTextNode(" · ")); links.appendChild(el("a", { href: media(r.slug, f[x[0]]), download: f[x[0]], text: x[1] })); }
  });
  links.appendChild(document.createTextNode(" · "));
  links.appendChild(el("a", { href: media(r.slug, "manifest.json"), target: "_blank", text: "manifest" }));
  var tpanel = el("div", { "class": "transcript" });
  var p = document.getElementById("player");
  fill(p, 
    el("div", { "class": "player-title" }, el("h3", { text: r.slug }), links),
    v, r.chapters.length > 1 ? chapters : null, tpanel);
  p.hidden = false;
  document.getElementById("viewer-h").textContent = "Replay";
  if (f.transcript) loadTranscript(r, v, tpanel);
  else tpanel.appendChild(el("div", { "class": "hint", text: transcriptNote(r) || "No transcript." }));
  refresh();
  p.scrollIntoView({ behavior: "smooth", block: "start" });
}

function transcriptNote(r) {
  var t = r.transcript;
  if (!t) return r.video ? "Waiting for the transcriber." : "";
  if (t.status === "done") return "";
  if (t.status === "failed") return "Transcription failed: " + (t.error || "unknown error");
  return "Transcribing" + (t.progress !== null ? " " + t.progress + "%" : "") + (t.stage ? " (" + t.stage + ")" : "") + "...";
}

function loadTranscript(r, v, box) {
  fill(box, el("div", { "class": "hint", text: "Loading transcript..." }));
  api("GET", media(r.slug, r.files.transcript)).then(function (t) {
    var segs = (t && t.segments) || [];
    var search = el("input", { type: "search", placeholder: "Search transcript", "aria-label": "Search transcript" });
    var list = el("div", { "class": "tlist" });
    var rows = segs.map(function (sg) {
      var row = el("button", { "class": "tline", type: "button", on: { click: function () { v.currentTime = sg.start; v.play(); } } },
        el("span", { "class": "tt", text: hms(sg.start) }),
        sg.zoom_speaker ? el("span", { "class": "tw", text: sg.zoom_speaker }) : null,
        el("span", { "class": "tx", text: (sg.text || "").trim() }));
      row._seg = sg; list.appendChild(row); return row;
    });
    search.addEventListener("input", function () {
      var q = search.value.trim().toLowerCase();
      rows.forEach(function (row) {
        var hit = !q || (row._seg.text || "").toLowerCase().indexOf(q) >= 0 || (row._seg.zoom_speaker || "").toLowerCase().indexOf(q) >= 0;
        row.hidden = !hit;
      });
    });
    var cur = null;
    v.addEventListener("timeupdate", function () {
      var tnow = v.currentTime, found = null;
      for (var i = 0; i < rows.length; i++) { if (rows[i]._seg.start <= tnow + 0.05) found = rows[i]; else break; }
      if (found !== cur) {
        if (cur) cur.classList.remove("now");
        cur = found;
        if (cur) { cur.classList.add("now"); if (!search.value) cur.scrollIntoView({ block: "nearest" }); }
      }
    });
    fill(box, 
      el("div", { "class": "thead" }, el("h4", { text: "Transcript" }), search),
      segs.length ? list : el("div", { "class": "hint", text: "No speech was found." }),
      el("div", { "class": "hint", text: "Whisper " + (t.model || "") + " transcript. Names are Zoom's active-speaker label, not voice ID. Times in " + TZ + "." }));
  }, function (e) { fill(box, el("div", { "class": "hint", text: "Couldn't load the transcript: " + e.message })); });
}

function watch(id) {
  selectedRec = null;
  document.getElementById("player").hidden = true;
  fill(document.getElementById("player"));
  watching = id;
  var live = document.getElementById("live");
  var img = el("img", { alt: "What the recorder's screen shows right now" });
  var log = el("pre", { text: "Loading log..." });
  var j = lastJobs.find(function (x) { return x.id === id; });
  fill(live, 
    el("div", { "class": "player-title" }, el("h3", { text: (j ? j.slug : "capture") + " (live)" }),
      el("button", { text: "Close", on: { click: function () { stopWatching(); refresh(); } } })),
    img, el("div", { "class": "hint", text: "Screen refreshes every 5 seconds. This is exactly what gets recorded." }), log);
  live.hidden = false;
  document.getElementById("viewer-h").textContent = "Live";
  function tick() {
    var cur = lastJobs.find(function (x) { return x.id === id; });
    if (!cur || (cur.status !== "running" && cur.status !== "stopping")) {
      log.textContent += "\n[capture is " + (cur ? cur.status : "gone") + "]"; clearInterval(liveTimer); liveTimer = null; return;
    }
    fetch("/api/jobs/" + id + "/screen").then(function (r) { return r.ok ? r.blob() : null; }).then(function (b) {
      if (!b) return; var old = img.src; img.src = URL.createObjectURL(b); if (old) URL.revokeObjectURL(old);
    }).catch(function () {});
    api("GET", "/api/jobs/" + id + "/log").then(function (t) {
      var atBottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 8;
      log.textContent = t || "(no log yet)"; if (atBottom) log.scrollTop = log.scrollHeight;
    }).catch(function () {});
  }
  if (liveTimer) clearInterval(liveTimer);
  tick(); liveTimer = setInterval(tick, 5000);
  refresh();
}
function stopWatching() {
  watching = null;
  if (liveTimer) { clearInterval(liveTimer); liveTimer = null; }
  var live = document.getElementById("live"); live.hidden = true; fill(live);
  document.getElementById("viewer-h").textContent = selectedRec ? "Replay" : "Recordings";
}

function cancel(id) { api("DELETE", "/api/jobs/" + id).then(refresh, function (e) { alert(e.message); }); }

function refresh() {
  return Promise.all([api("GET", "/api/jobs"), api("GET", "/api/recordings")])
    .then(function (d) { renderJobs(d[0]); renderRecs(d[1]); })
    .catch(function (e) { fill(document.getElementById("jobs"), el("div", { "class": "empty", text: "Can't reach the server: " + e.message })); });
}

document.getElementById("form").addEventListener("submit", function (ev) {
  ev.preventDefault();
  var f = ev.target, msg = document.getElementById("formmsg");
  var body = { link: f.link.value, start: f.start.value, slug: f.slug.value || undefined, name: f.name.value || undefined };
  msg.className = "msg"; msg.textContent = "Scheduling...";
  api("POST", "/api/jobs", body).then(function (j) {
    msg.className = "msg ok";
    msg.textContent = "Scheduled " + j.slug + " for " + fmt(j.start) + ". It joins a few minutes early.";
    f.reset(); refresh();
  }, function (e) { msg.className = "msg err"; msg.textContent = e.message; });
});

api("GET", "/api/info").then(function (i) {
  document.getElementById("tzlabel").textContent = "(" + i.tz + ")";
  document.getElementById("meta").textContent = "Times in " + i.tz + " · tzdata " + (i.tzdata || "?") +
    " · joins " + i.leadMinutes + " min early · up to " + i.maxConcurrent + " at once";
});
refresh();
setInterval(function () { if (!document.hidden) refresh(); }, 5000);
</script>
</body>
</html>
`;
