/**
 * /admin: schedule and run captures, watch the bot's screen and log, the
 * Zoom login banner, every recording (incl. failed attempts). Admin only;
 * its APIs are under /api/admin and its files under /admin/media, so a
 * proxy can restrict all of it by path.
 *
 * Kept as a TS string so `tsc` ships it in dist/. The script must not use
 * backticks or dollar-brace: it lives inside a template literal. Server
 * data only via textContent. __TZ__ is replaced with the server's timezone.
 */
import { BASE_CSS, BASE_JS, PLAYER_JS } from "./common.js";

export const ADMIN_PAGE = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Admin · minutes</title>
<link rel="icon" href="data:,">
<style>
${BASE_CSS}
main { padding: 16px 24px 40px; max-width: 1200px; margin: 0 auto; }
main[hidden] { display: none !important; }
main.two { display: grid; grid-template-columns: minmax(320px, 420px) 1fr; gap: 20px; align-items: start; max-width: none; }
main.two > div > section + section { margin-top: 20px; }
main.cols { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; align-items: start; }
main.cols > div > section + section { margin-top: 20px; }
@media (max-width: 900px) { main, main.two, main.cols { grid-template-columns: 1fr; padding: 12px 16px 32px; } }
.tabs { display: flex; gap: 4px; flex-wrap: wrap; padding: 0 24px; background: var(--panel); border-bottom: 1px solid var(--line); }
.tabs a { padding: 10px 14px; text-decoration: none; color: var(--muted); border-bottom: 2px solid transparent; margin-bottom: -1px; font-size: 14px; }
.tabs a:hover { color: var(--ink); }
.tabs a[aria-current] { color: var(--ink); font-weight: 600; border-bottom-color: var(--accent); }
.tabs .badge { display: inline-block; min-width: 18px; padding: 0 5px; margin-left: 6px; border-radius: 999px; background: var(--bad); color: #fff; font-size: 11px; text-align: center; }
.tabs .badge.n { background: var(--live); }
.tabs .badge[hidden] { display: none; }
@media (max-width: 900px) { .tabs { padding: 0 12px; } }
.ov { display: grid; grid-template-columns: minmax(0, 3fr) minmax(0, 2fr); gap: 20px; align-items: start; }
.ov > div > section + section { margin-top: 20px; }
@media (max-width: 900px) { .ov { grid-template-columns: 1fr; } }
.ok-line { color: var(--ok); font-weight: 600; }
.bar { height: 6px; background: var(--line); border-radius: 3px; overflow: hidden; margin-top: 6px; grid-column: 1 / -1; }
.bar > i { display: block; height: 100%; background: var(--accent); }
.kv { display: flex; gap: 8px 18px; flex-wrap: wrap; font-size: 13px; color: var(--muted); margin-bottom: 10px; }
.kv b { color: var(--ink); }
form .actions { display: flex; gap: 8px; align-items: stretch; }
form .actions button.primary { flex: 1; }
#editcancel { margin-top: 14px; }
#editcancel[hidden] { display: none; }
#login { margin: 4px 24px 0; padding: 8px 12px; border-radius: 8px; font-size: 13px; color: var(--muted);
  display: flex; gap: 10px; align-items: center; flex-wrap: wrap; border: 1px solid transparent; }
#login.bad { color: var(--ink); background: color-mix(in srgb, var(--bad) 12%, transparent); border-color: var(--bad); }
#login.bad b { color: var(--bad); }
#login button { padding: 3px 10px; font-size: 13px; }
@media (max-width: 900px) { #login { margin: 4px 16px 0; } }
.live img { width: 100%; border-radius: 8px; background: #000; display: block; min-height: 120px; }
label.check { display: flex; align-items: center; gap: 8px; font-weight: normal; }
label.check input { width: auto; margin: 0; }
label.check[hidden] { display: none; }
.hint code { font-size: 12px; }
.auditf { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 6px; margin-bottom: 10px; }
@media (max-width: 600px) { .auditf { grid-template-columns: 1fr; } }
.change { font-size: 13px; overflow-wrap: anywhere; }
.change b { font-weight: 600; }
#amore[hidden] { display: none; }
.spk { padding: 8px 0; border-top: 1px solid var(--line); }
.spk input { margin-top: 4px; }
</style>
</head>
<body>
<header>
  <h1><a href="/admin">minutes</a> <small class="meta">admin</small></h1>
  <span class="me" id="me"></span>
</header>
<nav class="tabs" id="tabs" aria-label="Admin">
  <a href="#overview">Overview<span class="badge" id="b-over" hidden></span></a>
  <a href="#captures">Captures</a>
  <a href="#recordings">Recordings</a>
  <a href="#people">People &amp; access</a>
  <a href="#audit">Audit log</a>
  <a href="/admin/feeds">Feeds<span class="badge n" id="b-review" hidden></span></a>
</nav>
<div id="login" role="status"></div>

<main id="t-overview" class="ov">
  <div>
    <section>
      <h2>Right now</h2>
      <div class="kv" id="meta"></div>
      <div class="list" id="now"><div class="empty">Loading...</div></div>
    </section>
    <section>
      <h2>Coming up</h2>
      <div class="list" id="next"><div class="empty">Loading...</div></div>
    </section>
  </div>
  <div>
    <section>
      <h2>Needs attention</h2>
      <div class="list" id="attn"><div class="empty">Loading...</div></div>
    </section>
    <section>
      <h2>Recent activity</h2>
      <div class="list" id="recent"><div class="empty">Loading...</div></div>
      <p class="hint"><a href="#audit">Full audit log</a></p>
    </section>
  </div>
</main>

<main id="t-captures" class="two" hidden>
  <div>
    <section>
      <h2 id="formtitle">Schedule a meeting</h2>
      <form id="form" autocomplete="off">
        <label for="link">Meeting link (Zoom, YouTube or a Granicus video) or Zoom ID</label>
        <input id="link" name="link" required placeholder="https://us06web.zoom.us/j/123456789?pwd=... or https://www.youtube.com/watch?v=...">
        <small>Only a Zoom ID and passcode? Use https://zoom.us/j/ID?pwd=PASSCODE. A YouTube or Granicus video is recorded from its stream, not a browser. A Granicus <b>clip</b> (an archived meeting, <code>.../player/clip/123</code>) is imported at once: give the meeting's own date as the start.</small>
        <label for="start">Start time <small id="tzlabel"></small></label>
        <input id="start" name="start" type="datetime-local" required>
        <label for="slug">Name <small>(folder and file name, optional)</small></label>
        <input id="slug" name="slug" placeholder="council-2026-11-16" pattern="[A-Za-z0-9][A-Za-z0-9._\-]{0,79}">
        <label for="name">Shown in Zoom as <small>(optional)</small></label>
        <input id="name" name="name" placeholder="Recorder" maxlength="64">
        <label for="email">Email <small>(optional, typed only if the host requires one; the host sees it)</small></label>
        <input id="email" name="email" type="email" maxlength="254" placeholder="Only used if Zoom asks">
        <label class="check" id="clearemailrow" hidden><input type="checkbox" id="clearemail" name="clearemail"> Remove the saved email</label>
        <div class="actions">
          <button class="primary" type="submit" id="submitbtn">Schedule capture</button>
          <button type="button" id="editcancel" hidden>Cancel edit</button>
        </div>
        <div class="msg" id="formmsg" role="status"></div>
      </form>
    </section>
  </div>
  <div>
    <section>
      <h2>Captures</h2>
      <div class="list" id="jobs"><div class="empty">Loading...</div></div>
    </section>
  </div>
</main>

<main id="t-recordings" hidden>
  <section id="viewer">
    <h2 id="viewer-h">Recordings</h2>
    <div id="player" hidden></div>
    <div id="live" class="live" hidden></div>
    <div class="list" id="recs"><div class="empty">Loading...</div></div>
  </section>
</main>

<main id="t-people" class="cols" hidden>
  <div>
    <section>
      <h2>Users</h2>
      <div class="list" id="users"><div class="empty">Loading...</div></div>
      <p class="hint">New admins: <code>minutes user add --admin email</code> on the server, or promote a user here.</p>
    </section>
  </div>
  <div>
    <section>
      <h2>API tokens</h2>
      <div class="list" id="tokens"><div class="empty">Loading...</div></div>
      <div class="hint" id="tokusage"></div>
    </section>
  </div>
</main>

<main id="t-audit" hidden>
  <section>
    <h2>Audit log</h2>
    <form id="auditf" class="auditf" autocomplete="off">
      <select id="aaction" aria-label="Action"><option value="">All actions</option></select>
      <input id="aactor" placeholder="Who" aria-label="Who">
      <input id="atarget" placeholder="What (name, email)" aria-label="What">
    </form>
    <div class="list" id="audit"><div class="empty">Loading...</div></div>
    <button type="button" id="amore" hidden>Older</button>
  </section>
</main>
<script>
"use strict";
var TZ = __TZ__;
${BASE_JS}
${PLAYER_JS}
var selectedRec = null, watching = null, liveTimer = null, stopLive = null, lastJobs = [];
var MEDIA = "/admin/media/";
function aapi(method, url, body) { return api(method, url, body, true); }

// A capture or recording by what it is (municipality and title), not its folder name; the folder name stays as small text.
function jobName(j) { return (j.source ? j.source + ": " : "") + (j.title || j.slug); }
function recName(r) { return (r.source ? r.source + ": " : "") + (r.title && r.title !== r.slug ? r.title : r.slug); }
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
        if (confirm("Stop recording " + jobName(j) + "? What's been recorded so far is kept and stitched.")) cancel(j.id);
      } } }));
    } else if (j.status === "scheduled" || j.status === "queued") {
      actions.appendChild(el("button", { text: editing && editing.id === j.id ? "Editing" : "Edit", on: { click: function () { startEdit(j); } } }));
      actions.appendChild(el("button", { "class": "danger", text: "Cancel", on: { click: function () {
        if (confirm("Cancel the capture of " + jobName(j) + "?")) cancel(j.id);
      } } }));
    } else if (j.status !== "cancelled" && !jobs.some(function (o) { return o.meetingRef === j.meetingRef && o.status in ACTIVE; })) {
      actions.appendChild(el("button", { text: "Record again", on: { click: function () {
        if (confirm("Record this meeting again? A new capture starts now (or at the meeting's time if that's still ahead), in a new folder.")) {
          aapi("POST", "/api/admin/jobs/" + j.id + "/retry").then(refresh, function (e) { alert(e.message); });
        }
      } } }));
    }
    var sub = "Starts " + fmt(j.start) + " · meeting " + j.meetingId + " · joins as “" + j.name + "”" + (j.hasEmail ? " · email set" : "") + " · folder " + j.slug;
    if (j.outcome) sub += " · outcome " + j.outcome;
    if (j.error) sub += " · " + j.error;
    box.appendChild(el("div", { "class": "row" + (watching === j.id || (editing && editing.id === j.id) ? " selected" : "") },
      el("div", { "class": "title", title: j.slug }, pill(j.status), jobName(j)), actions, el("div", { "class": "sub", text: sub })));
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
      (r.videoBytes ? " · " + mb(r.videoBytes) : "") + (r.audioGone ? " · sound deleted after the transcript (the video is on YouTube)" : r.audioOnly ? " · sound only (the video is on YouTube)" : "") + (r.video ? "" : r.active ? " · recording now" : " · no video") +
      (r.files && r.files.transcript ? " · transcript" : r.video && transcriptNote(r) ? " · " + transcriptNote(r).toLowerCase() : "") +
      (r.public ? "" : " · not public");
    var panel = el("div", { "class": "spk-panel", style: "grid-column: 1 / -1" });
    var actions = el("div", { "class": "actions" },
      r.video ? el("button", { text: selectedRec === r.slug ? "Playing" : "Play", on: { click: function () { playRec(r); } } }) : null,
      r.files && r.files.transcript ? el("button", { text: "Speakers", on: { click: function () { toggleSpeakers(r, panel); } } }) : null,
      r.video && r.transcript && (r.transcript.status === "done" || r.transcript.status === "failed") ? el("button", { text: r.transcript.status === "failed" ? "Retry transcript" : "Transcribe again", on: { click: function () {
        if (!confirm("Ask the transcriber to do " + recName(r) + " again? The current transcript stays until the new one replaces it.")) return;
        aapi("POST", "/api/admin/recordings/" + encodeURIComponent(r.slug) + "/retranscribe", {}).then(function () { refresh(); }, function (e) { alert(e.message); });
      } } }) : null);
    box.appendChild(el("div", { "class": "row" + (selectedRec === r.slug ? " selected" : "") },
      el("div", { "class": "title", title: r.slug }, pill(status), recName(r)), actions, el("div", { "class": "sub", text: sub + " · folder " + r.slug }), panel));
  });
  if (recTotal > recs.length) {
    box.appendChild(el("div", { "class": "row" }, el("div", { "class": "sub", text: "Showing the latest " + recs.length + " of " + recTotal + " recordings. " }),
      el("button", { text: "Show more", on: { click: function () { recLimit += 50; refresh(); } } })));
  }
}

// Who the transcriber's "Speaker N" voices are, by hand. Names show on every transcript view, public too.
function toggleSpeakers(r, panel) {
  if (panel.childNodes.length) { fill(panel); return; }
  fill(panel, el("div", { "class": "hint", text: "Loading..." }));
  aapi("GET", "/api/admin/recordings/" + encodeURIComponent(r.slug) + "/speakers").then(function (d) {
    var inputs = {}, msg = el("div", { "class": "msg" });
    var rows = d.labels.map(function (l) {
      var inp = el("input", { type: "text", maxlength: "60", value: l.name || "", placeholder: "Who is this?", "aria-label": "Name for " + l.label });
      inputs[l.label] = inp;
      return el("div", { "class": "spk" }, el("div", { "class": "title", text: l.label + " · " + hms(l.seconds) + " · starts at " + hms(l.first.t) }),
        el("div", { "class": "hint", text: "\u201c" + l.first.text + "\u201d" }), inp);
    });
    var save = el("button", { "class": "primary", text: "Save names", on: { click: function () {
      var names = {};
      Object.keys(inputs).forEach(function (k) { names[k] = inputs[k].value; });
      msg.className = "msg"; msg.textContent = "Saving...";
      aapi("PUT", "/api/admin/recordings/" + encodeURIComponent(r.slug) + "/speakers", { names: names }).then(function () {
        msg.className = "msg ok"; msg.textContent = "Saved. The transcript shows them now (a replay in progress needs a reload).";
      }, function (e) { msg.className = "msg err"; msg.textContent = e.message; });
    } } });
    fill.apply(null, [panel, el("div", { "class": "hint", text: "Name the voices. Two voices given the same name are merged. Names show on every transcript view, public too, and are marked as added by hand." })]
      .concat(rows, [save, msg]));
  }, function (e) { fill(panel, el("div", { "class": "msg err", text: e.message })); });
}

function playRec(r) {
  stopWatching();
  selectedRec = r.slug;
  var p = document.getElementById("player");
  play(r, MEDIA, p, [el("a", { href: mediaUrl(MEDIA, r.slug, "manifest.json"), target: "_blank", text: "manifest" })]);
  document.getElementById("viewer-h").textContent = "Replay";
  refresh();
  p.scrollIntoView({ behavior: "smooth", block: "start" });
}

function watch(id) {
  goTab("recordings");
  selectedRec = null;
  document.getElementById("player").hidden = true;
  fill(document.getElementById("player"));
  watching = id;
  var live = document.getElementById("live");
  var img = el("img", { alt: "What the recorder's screen shows right now" });
  var log = el("pre", { text: "Loading log..." });
  var j = lastJobs.find(function (x) { return x.id === id; });
  var draft = el("div", { "class": "tlist live-t" });
  var draftNote = el("div", { "class": "hint" });
  fill(live,
    el("div", { "class": "player-title" }, el("h3", { text: (j ? jobName(j) : "capture") + " (live)" }),
      el("button", { text: "Close", on: { click: function () { stopWatching(); refresh(); } } })),
    img, el("div", { "class": "hint", text: "Screen refreshes every 5 seconds. This is exactly what gets recorded." }),
    el("h3", { "class": "live-h", text: "Live transcript (draft)" }), draft, draftNote, log);
  live.hidden = false;
  document.getElementById("viewer-h").textContent = "Live";
  if (stopLive) stopLive();
  stopLive = j ? followLive(mediaUrl(MEDIA, j.slug, "live.json"), draft, draftNote) : null;
  function tick() {
    var cur = lastJobs.find(function (x) { return x.id === id; });
    if (!cur || (cur.status !== "running" && cur.status !== "stopping")) {
      log.textContent += "\n[capture is " + (cur ? cur.status : "gone") + "]"; clearInterval(liveTimer); liveTimer = null; return;
    }
    fetch("/api/admin/jobs/" + id + "/screen").then(function (r) { return r.ok ? r.blob() : null; }).then(function (b) {
      if (!b) return; var old = img.src; img.src = URL.createObjectURL(b); if (old) URL.revokeObjectURL(old);
    }).catch(function () {});
    aapi("GET", "/api/admin/jobs/" + id + "/log").then(function (t) {
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
  if (stopLive) { stopLive(); stopLive = null; }
  var live = document.getElementById("live"); live.hidden = true; fill(live);
  document.getElementById("viewer-h").textContent = selectedRec ? "Replay" : "Recordings";
}

var LOGIN_TEXT = { ok: "signed in", expired: "EXPIRED", missing: "MISSING", error: "couldn't check", unchecked: "not checked yet" };
function renderLogin(s) {
  sessionNow = s;
  var box = document.getElementById("login");
  var bad = s.state === "expired" || s.state === "missing" || s.state === "error";
  box.className = bad ? "bad" : "";
  var when = s.checkedAt ? "checked " + ago(s.checkedAt) : "";
  var btn = el("button", { type: "button", text: s.checking ? "Checking..." : "Check now", on: { click: function () {
    btn.disabled = true; btn.textContent = "Checking...";
    aapi("POST", "/api/admin/session/check").then(renderLogin, function (e) { alert(e.message); refreshLogin(); });
  } } });
  if (s.checking) btn.disabled = true;
  fill(box,
    el("span", null, "Zoom login: ", el("b", { text: LOGIN_TEXT[s.state] || s.state }), when ? " · " + when : ""),
    bad ? el("span", { text: s.detail + (s.state === "expired" || s.state === "missing"
      ? ". Scheduled captures will fail until you run: minutes login --auth auth/zoom-auth.json" : "") }) : null,
    btn);
}
function refreshLogin() { return aapi("GET", "/api/admin/session").then(renderLogin, function () {}); }

function cancel(id) { aapi("DELETE", "/api/admin/jobs/" + id).then(refresh, function (e) { alert(e.message); }); }

// The lists are bounded (the latest few captures, the latest recordings): "Show more" asks for more.
var recLimit = 50, recTotal = 0;
function listApi(url) {
  return fetch(url).then(function (r) {
    if (r.status === 401) { location.reload(); throw new Error("sign in first"); }
    return r.json().then(function (d) {
      if (!r.ok) throw new Error((d && d.error) || ("HTTP " + r.status));
      return { rows: d, total: Number(r.headers.get("X-Total-Count")) || d.length };
    });
  });
}
function refresh() {
  return Promise.all([aapi("GET", "/api/admin/jobs?limit=20"), listApi("/api/admin/recordings?limit=" + recLimit)])
    .then(function (d) { lastRecs = d[1].rows; recTotal = d[1].total; renderJobs(d[0]); renderRecs(d[1].rows); renderOverview(); refreshLogin(); if (!auditOlder) loadAudit(); })
    .catch(function (e) { fill(document.getElementById("jobs"), el("div", { "class": "empty", text: "Can't reach the server: " + e.message })); });
}

// "2026-11-09T19:00" for a datetime-local input, in the server's timezone.
var fmtParts = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
function localInput(iso) {
  var p = {};
  fmtParts.formatToParts(new Date(iso)).forEach(function (x) { p[x.type] = x.value; });
  return p.year + "-" + p.month + "-" + p.day + "T" + p.hour + ":" + p.minute;
}

// Edit mode reuses the schedule form. The link is never sent to the page
// (it holds the passcode), so a blank link means "keep the current one".
var editing = null;
function setMode(job) {
  var f = document.getElementById("form");
  editing = job ? { id: job.id, start: localInput(job.start), slug: job.slug, name: job.name, hasEmail: job.hasEmail } : null;
  document.getElementById("formtitle").textContent = job ? "Edit " + job.slug : "Schedule a meeting";
  document.getElementById("submitbtn").textContent = job ? "Save changes" : "Schedule capture";
  document.getElementById("editcancel").hidden = !job;
  f.link.required = !job;
  f.link.placeholder = job ? "Leave blank to keep meeting " + job.meetingId : "https://us06web.zoom.us/j/123456789?pwd=... or a YouTube link";
  // Like the link, a saved email never comes back to the page.
  f.email.placeholder = job && job.hasEmail ? "Leave blank to keep the saved email" : "Only used if Zoom asks";
  document.getElementById("clearemailrow").hidden = !(job && job.hasEmail);
  f.reset();
  if (job) { f.start.value = editing.start; f.slug.value = job.slug; f.name.value = job.name; }
  if (lastJobs) renderJobs(lastJobs);
}
function startEdit(j) {
  setMode(j);
  var msg = document.getElementById("formmsg"); msg.className = "msg"; msg.textContent = "";
  document.getElementById("form").scrollIntoView({ behavior: "smooth", block: "start" });
}
document.getElementById("editcancel").addEventListener("click", function () {
  setMode(null); document.getElementById("formmsg").textContent = "";
});

document.getElementById("form").addEventListener("submit", function (ev) {
  ev.preventDefault();
  var f = ev.target, msg = document.getElementById("formmsg");
  if (editing) {
    // Send only what changed, so an untouched start isn't re-checked.
    var ch = {};
    if (f.link.value.trim()) ch.link = f.link.value;
    if (f.start.value !== editing.start) ch.start = f.start.value;
    if (f.slug.value.trim() && f.slug.value.trim() !== editing.slug) ch.slug = f.slug.value;
    if (f.name.value.trim() && f.name.value.trim() !== editing.name) ch.name = f.name.value;
    if (f.email.value.trim()) ch.email = f.email.value;
    else if (f.clearemail.checked) ch.clearEmail = true;
    if (!Object.keys(ch).length) { msg.className = "msg"; msg.textContent = "Nothing changed."; return; }
    msg.className = "msg"; msg.textContent = "Saving...";
    aapi("PATCH", "/api/admin/jobs/" + editing.id, ch).then(function (j) {
      setMode(null);
      msg.className = "msg ok";
      msg.textContent = "Saved " + j.slug + ": starts " + fmt(j.start) + " as “" + j.name + "”.";
      refresh();
    }, function (e) { msg.className = "msg err"; msg.textContent = e.message; });
    return;
  }
  var body = { link: f.link.value, start: f.start.value, slug: f.slug.value || undefined, name: f.name.value || undefined,
    email: f.email.value.trim() || undefined };
  msg.className = "msg"; msg.textContent = "Scheduling...";
  aapi("POST", "/api/admin/jobs", body).then(function (j) {
    msg.className = "msg ok";
    msg.textContent = "Scheduled " + j.slug + " for " + fmt(j.start) + ". It joins a few minutes early.";
    f.reset(); refresh();
  }, function (e) { msg.className = "msg err"; msg.textContent = e.message; });
});

// --- users ---
function renderUsers(users) {
  var box = document.getElementById("users");
  fill(box);
  users.forEach(function (u) {
    var actions = el("div", { "class": "actions" });
    if (!u.self) {
      actions.appendChild(el("button", { text: u.role === "admin" ? "Make user" : "Make admin", on: { click: function () {
        var role = u.role === "admin" ? "user" : "admin";
        if (confirm((role === "admin" ? "Make " + u.email + " an admin? Admins can run captures and manage users." : "Remove admin from " + u.email + "?"))) updateUser(u, { role: role });
      } } }));
      actions.appendChild(el("button", { "class": u.disabled ? "" : "danger", text: u.disabled ? "Enable" : "Disable", on: { click: function () {
        if (u.disabled || confirm("Disable " + u.email + "? They're signed out everywhere and can't sign in.")) updateUser(u, { disabled: !u.disabled });
      } } }));
    }
    var sub = [u.name, u.verified ? "email confirmed" : "email not confirmed", u.mustChangePassword ? "one-time password" : null,
      u.lastLoginAt ? "last sign-in " + fmt(u.lastLoginAt) : "never signed in", u.self ? "you" : null].filter(Boolean).join(" · ");
    box.appendChild(el("div", { "class": "row" },
      el("div", { "class": "title" }, u.disabled ? pill("disabled") : el("span", { "class": "pill", text: u.role }), u.email),
      actions, el("div", { "class": "sub", text: sub })));
  });
}
function loadUsers() { return aapi("GET", "/api/admin/users").then(renderUsers, function () {}); }
function updateUser(u, ch) {
  aapi("PATCH", "/api/admin/users/" + u.id, ch).then(function () { loadUsers(); loadAudit(); }, function (e) { alert(e.message); });
}
loadUsers();
setInterval(function () { if (!document.hidden) loadUsers(); }, 30000);

// --- API tokens and usage (#16, #18) ---
function gb(n) { return n < 1048576 ? Math.round(n / 1024) + " KB" : n < 1073741824 ? (n / 1048576).toFixed(1) + " MB" : (n / 1073741824).toFixed(2) + " GB"; }
function loadTokens() {
  Promise.all([aapi("GET", "/api/admin/tokens"), aapi("GET", "/api/admin/usage?days=30")]).then(function (r) {
    var list = r[0], use = r[1], byId = {};
    use.tokens.forEach(function (t) { byId[t.id] = t; });
    var box = document.getElementById("tokens");
    fill(box);
    if (!list.length) box.appendChild(el("div", { "class": "empty", text: "No API tokens." }));
    list.forEach(function (t) {
      var u = byId[t.id] || { requests: 0, bytes: 0 };
      var state = t.revokedAt ? "revoked" : !t.active ? "expired" : null;
      var actions = el("div", { "class": "actions" });
      if (t.active) actions.appendChild(el("button", { "class": "danger", text: "Revoke", on: { click: function () {
        if (confirm("Revoke " + t.userEmail + "'s token " + t.label + "?")) aapi("DELETE", "/api/admin/tokens/" + t.id).then(loadTokens, function (e) { alert(e.message); });
      } } }));
      box.appendChild(el("div", { "class": "row" },
        el("div", { "class": "title" }, state ? el("span", { "class": "pill s-stopped", text: state }) : null, t.userEmail + " · " + t.label), actions,
        el("div", { "class": "sub", text: "mnt_" + t.prefix + "_... · " + t.scopes.join(", ") + " · last used " + (t.lastUsedAt ? ago(t.lastUsedAt) : "never") +
          " · 30 days: " + u.requests + " requests, " + gb(u.bytes) })));
    });
    var tu = document.getElementById("tokusage");
    tu.textContent = use.users.length ? "By user, last 30 days: " + use.users.map(function (x) { return x.email + " " + x.requests + " requests, " + gb(x.bytes); }).join("; ") +
      (use.files.length ? ". Most downloaded: " + use.files.slice(0, 3).map(function (f) { return f.file + " (" + f.requests + "x)"; }).join(", ") : "") + "." : "No API use in the last 30 days.";
  }, function () {});
}
loadTokens();
setInterval(function () { if (!document.hidden) loadTokens(); }, 60000);

// --- audit log ---
var auditOlder = false, auditTimer = null;
function auditQuery(before) {
  var q = new URLSearchParams();
  var a = document.getElementById("aaction").value, w = document.getElementById("aactor").value.trim(), t = document.getElementById("atarget").value.trim();
  if (a) q.set("action", a); if (w) q.set("actor", w); if (t) q.set("target", t);
  if (before) q.set("before", before);
  return "/api/admin/audit?" + q.toString();
}
function show(v) { return v === null || v === undefined ? "none" : typeof v === "string" ? v : JSON.stringify(v); }
function auditRow(e) {
  var b = e.before || {}, a = e.after || {}, keys = Object.keys(a).length ? Object.keys(a) : Object.keys(b);
  var changes = el("div", { "class": "sub" });
  keys.forEach(function (k) {
    var line = e.before && e.after ? show(b[k]) + " → " + show(a[k]) : show(e.after ? a[k] : b[k]);
    changes.appendChild(el("div", { "class": "change" }, el("b", { text: k + ": " }), line));
  });
  return el("div", { "class": "row" },
    el("div", { "class": "title" }, el("span", { "class": "pill", text: e.action }), e.targetLabel || e.targetType),
    el("div", null),
    el("div", { "class": "sub", text: fmt(e.at) + " · " + e.actor + (e.ip ? " · " + e.ip : "") }),
    keys.length ? changes : null);
}
function loadAudit(before) {
  return aapi("GET", auditQuery(before)).then(function (d) {
    var box = document.getElementById("audit"), sel = document.getElementById("aaction");
    var have = [].map.call(sel.options, function (o) { return o.value; });
    d.actions.forEach(function (x) { if (have.indexOf(x) < 0) sel.appendChild(el("option", { value: x, text: x })); });
    if (!before) fill(box);
    d.entries.forEach(function (e) { box.appendChild(auditRow(e)); });
    if (!before && !d.entries.length) box.appendChild(el("div", { "class": "empty", text: "Nothing yet." }));
    var more = document.getElementById("amore");
    more.hidden = d.entries.length < 50;
    more.dataset.before = d.entries.length ? d.entries[d.entries.length - 1].id : "";
  }).catch(function (e) { fill(document.getElementById("audit"), el("div", { "class": "empty", text: e.message })); });
}
document.getElementById("amore").addEventListener("click", function (ev) { auditOlder = true; loadAudit(ev.target.dataset.before); });
["aaction", "aactor", "atarget"].forEach(function (id) {
  document.getElementById(id).addEventListener("input", function () {
    clearTimeout(auditTimer); auditOlder = false; auditTimer = setTimeout(function () { loadAudit(); }, 300);
  });
});
document.getElementById("auditf").addEventListener("submit", function (ev) { ev.preventDefault(); });

renderMe(document.getElementById("me"), true);
aapi("GET", "/api/admin/info").then(function (i) {
  document.getElementById("tzlabel").textContent = "(" + i.tz + ")";
  fill(document.getElementById("meta"),
    el("span", null, "Times in ", el("b", { text: i.tz })), el("span", null, "tzdata ", el("b", { text: i.tzdata || "?" })),
    el("span", null, "joins ", el("b", { text: i.leadMinutes + " min" }), " early"), el("span", null, "up to ", el("b", { text: String(i.maxConcurrent) }), " at once"));
});

// --- tabs: #overview (default), #captures, #recordings, #people, #audit ---
var TABS = ["overview", "captures", "recordings", "people", "audit"];
function curTab() { var h = location.hash.slice(1); return TABS.indexOf(h) >= 0 ? h : "overview"; }
function showTab() {
  var cur = curTab();
  TABS.forEach(function (t) { document.getElementById("t-" + t).hidden = t !== cur; });
  [].forEach.call(document.querySelectorAll("#tabs a[href^='#']"), function (a) {
    if (a.getAttribute("href") === "#" + cur) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
  });
  if (cur === "audit" && !document.getElementById("audit").childNodes.length) loadAudit();
}
function goTab(t) { if (location.hash !== "#" + t) location.hash = "#" + t; else showTab(); }
window.addEventListener("hashchange", showTab);
showTab();

// --- overview: what the app is doing now, what needs a person, what's next ---
var lastRecs = [], feedsNow = [], reviewCount = 0, sessionNow = null;
function line(pillEl, title, sub, actions, pct) {
  return el("div", { "class": "row" }, el("div", { "class": "title" }, pillEl, title), actions || el("div", null),
    sub ? el("div", { "class": "sub", text: sub }) : null,
    pct !== undefined && pct !== null ? el("div", { "class": "bar", role: "progressbar", "aria-valuenow": String(pct), "aria-valuemin": "0", "aria-valuemax": "100" }, el("i", { style: "width:" + pct + "%" })) : null);
}
function renderOverview() {
  var now = [], next = [], attn = [];
  var live = lastJobs.filter(function (j) { return j.status === "running" || j.status === "stopping"; });
  live.forEach(function (j) {
    var r = lastRecs.filter(function (x) { return x.slug === j.slug; })[0];
    var sub = (j.status === "stopping" ? "Stopping, stitching the video" : "Recording") + (r ? " · " + r.parts.length + (r.parts.length === 1 ? " part" : " parts") : "") +
      (j.launchedAt ? " · since " + fmt(j.launchedAt) : "");
    now.push(line(pill(j.status), jobName(j), sub, el("div", { "class": "actions" },
      el("button", { text: "Watch", on: { click: function () { goTab("recordings"); watch(j.id); } } }))));
  });
  lastRecs.forEach(function (r) {
    var t = r.transcript;
    if (t && t.status !== "done" && t.status !== "failed") {
      now.push(line(el("span", { "class": "pill s-queued", text: "transcribing" }), recName(r),
        (t.stage || "working") + (t.progress !== null && t.progress !== undefined ? " · " + t.progress + "%" : "") + (t.updated ? " · updated " + ago(t.updated) : ""), null, t.progress));
    } else if (!t && r.video && !r.active && r.public !== undefined) {
      var waiting = r.video && !r.files.transcript;
      if (waiting) now.push(line(el("span", { "class": "pill s-scheduled", text: "waiting" }), recName(r), "Video ready, waiting for the transcriber"));
    }
  });
  var feedBusy = feedsNow.filter(function (f) { return f.running; });
  feedBusy.forEach(function (f) { now.push(line(el("span", { "class": "pill s-running", text: "feed" }), f.name, "Checking for meetings")); });
  fill.apply(null, [document.getElementById("now")].concat(now.length ? now : [el("div", { "class": "empty", text: "Idle. Nothing is being captured or transcribed." })]));

  lastJobs.filter(function (j) { return j.status === "scheduled" || j.status === "queued"; })
    .sort(function (a, b) { return a.start.localeCompare(b.start); }).slice(0, 6).forEach(function (j) {
      next.push(line(pill(j.status), jobName(j), fmt(j.start) + " · meeting " + j.meetingId, el("div", { "class": "actions" },
        el("button", { text: "Edit", on: { click: function () { goTab("captures"); startEdit(j); } } }))));
    });
  fill.apply(null, [document.getElementById("next")].concat(next.length ? next : [el("div", { "class": "empty", text: "No captures scheduled." })]));

  var week = Date.now() - 3 * 86400000;
  if (sessionNow && (sessionNow.state === "expired" || sessionNow.state === "missing" || sessionNow.state === "error"))
    attn.push(line(el("span", { "class": "pill s-failed", text: "login" }), "Zoom login " + (LOGIN_TEXT[sessionNow.state] || sessionNow.state), sessionNow.detail || ""));
  lastJobs.filter(function (j) { return (j.status === "failed" || (j.outcome && ["blocked", "invalid_link", "email_required", "not_started", "failed"].indexOf(j.outcome) >= 0)) && new Date(j.endedAt || j.start).getTime() > week; })
    .forEach(function (j) {
      attn.push(line(pill(j.outcome || j.status), jobName(j), (j.error || "") + (j.error ? " · " : "") + fmt(j.endedAt || j.start), el("div", { "class": "actions" },
        el("button", { text: "Open", on: { click: function () { goTab("captures"); } } }))));
    });
  lastRecs.forEach(function (r) {
    if (r.transcript && r.transcript.status === "failed") attn.push(line(el("span", { "class": "pill s-failed", text: "transcript" }), recName(r), r.transcript.error || "Transcription failed", el("div", { "class": "actions" },
      el("button", { text: "Recordings", on: { click: function () { goTab("recordings"); } } }))));
  });
  feedsNow.filter(function (f) { return f.health === "failing" || f.health === "unhealthy"; }).forEach(function (f) {
    attn.push(line(el("span", { "class": "pill s-" + (f.health === "unhealthy" ? "failed" : "stopping"), text: "feed" }), f.name, "Failing" + (f.health === "unhealthy" ? " for over 24 h" : ""), el("div", { "class": "actions" },
      el("a", { href: "/admin/feeds", text: "Feeds" }))));
  });
  if (reviewCount) attn.push(line(el("span", { "class": "pill s-queued", text: "review" }), reviewCount + (reviewCount === 1 ? " meeting" : " meetings") + " waiting for approval", "", el("div", { "class": "actions" },
    el("a", { href: "/admin/feeds", text: "Review" }))));
  fill.apply(null, [document.getElementById("attn")].concat(attn.length ? attn : [el("div", { "class": "ok-line", text: "All clear." })]));
  var b = document.getElementById("b-over");
  b.hidden = !attn.length; b.textContent = String(attn.length);
  var br = document.getElementById("b-review");
  br.hidden = !reviewCount; br.textContent = String(reviewCount);
}
function loadOverviewExtra() {
  aapi("GET", "/api/admin/feeds").then(function (d) { feedsNow = Array.isArray(d) ? d : (d.feeds || []); renderOverview(); }, function () {});
  aapi("GET", "/api/admin/meetings?view=review").then(function (d) { reviewCount = (Array.isArray(d) ? d : (d.meetings || [])).length; renderOverview(); }, function () {});
  aapi("GET", "/api/admin/audit?limit=8").then(function (d) {
    fill.apply(null, [document.getElementById("recent")].concat(d.entries.length ? d.entries.map(function (e) {
      return el("div", { "class": "row" }, el("div", { "class": "title" }, el("span", { "class": "pill", text: e.action }), e.targetLabel || e.targetType),
        el("div", null), el("div", { "class": "sub", text: fmt(e.at) + " · " + e.actor }));
    }) : [el("div", { "class": "empty", text: "Nothing yet." })]));
  }, function () {});
}
loadOverviewExtra();
setInterval(function () { if (!document.hidden) loadOverviewExtra(); }, 15000);
refresh();
setInterval(function () { if (!document.hidden) refresh(); }, 5000);
</script>
</body>
</html>
`;
