/**
 * Shared by the public page (public.ts) and the admin page (admin.ts):
 * CSS, DOM helpers, and the replay player with its transcript panel.
 *
 * These are pasted into each page's String.raw template, so the same rules
 * hold: no backticks or dollar-brace in the CSS or script, server data only
 * via textContent (el/fill), never innerHTML.
 */

export const BASE_CSS = String.raw`
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
header h1 a { color: inherit; text-decoration: none; }
header .meta { color: var(--muted); font-size: 13px; }
header .me { margin-left: auto; color: var(--muted); font-size: 13px; }
@media (max-width: 900px) { header { padding: 16px 16px 4px; } }
section { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; box-shadow: var(--shadow); padding: 16px; min-width: 0; }
section + section { margin-top: 20px; }
h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); margin: 0 0 12px; font-weight: 600; }
label { display: block; font-size: 13px; font-weight: 600; margin: 10px 0 4px; }
label small { font-weight: 400; color: var(--muted); }
input, select { width: 100%; padding: 8px 10px; border: 1px solid var(--line); border-radius: 7px; background: var(--bg); color: var(--ink); font: inherit; }
input:focus, select:focus { outline: 2px solid var(--accent); outline-offset: -1px; }
button { font: inherit; border-radius: 7px; border: 1px solid var(--line); background: var(--panel); color: var(--ink); padding: 6px 12px; cursor: pointer; }
button:hover { border-color: var(--muted); }
button.primary { background: var(--accent); color: var(--accent-ink); border-color: var(--accent); font-weight: 600; padding: 9px 14px; margin-top: 14px; width: 100%; }
button.danger { color: var(--bad); }
.msg { font-size: 13px; margin-top: 10px; min-height: 1em; }
.msg.err { color: var(--bad); } .msg.ok { color: var(--ok); }
.list { display: flex; flex-direction: column; gap: 8px; }
.row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 4px 10px; padding: 10px 12px; border: 1px solid var(--line); border-radius: 8px; align-items: center; }
.row.selected { border-color: var(--accent); }
.row .title { font-weight: 600; overflow-wrap: anywhere; }
.row .sub { grid-column: 1 / -1; color: var(--muted); font-size: 13px; overflow-wrap: anywhere; }
.row .actions { display: flex; gap: 6px; flex-wrap: wrap; justify-content: flex-end; min-width: 0; }
.row .actions select { width: auto; max-width: 12rem; min-width: 0; }
@media (max-width: 700px) { .row { grid-template-columns: minmax(0, 1fr); } .row .actions { justify-content: flex-start; } .row .actions select { max-width: 100%; } }
.pill { display: inline-block; font-size: 11px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase;
  padding: 2px 7px; border-radius: 999px; border: 1px solid currentColor; margin-right: 6px; vertical-align: 1px; }
.s-scheduled, .s-queued { color: var(--accent); } .s-running, .s-live { color: var(--live); } .s-stopping { color: var(--warn); }
.s-done, .s-ended { color: var(--ok); } .s-failed, .s-blocked, .s-interrupted, .s-invalid_link, .s-email_required { color: var(--bad); } .s-cancelled, .s-stopped { color: var(--muted); }
.empty { color: var(--muted); font-size: 14px; padding: 6px 2px; }
video { width: 100%; max-height: 70vh; background: #000; border-radius: 8px; display: block; }
.player-title { display: flex; justify-content: space-between; gap: 10px; align-items: baseline; flex-wrap: wrap; margin-bottom: 10px; }
.player-title h3 { margin: 0; font-size: 16px; overflow-wrap: anywhere; }
.chapters { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
.chapters button { font-size: 13px; }
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
.tline .tw { color: hsl(var(--h, 220) 60% 36%); font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
@media (prefers-color-scheme: dark) { .tline .tw { color: hsl(var(--h, 220) 70% 72%); } }
.tline .tx { overflow-wrap: anywhere; }
.live-t { max-height: 320px; overflow-y: auto; }
.live-t .tline { grid-template-columns: 6.5em 1fr; cursor: default; }
.live-h { font-size: 14px; margin: 14px 0 6px; }
@media (max-width: 600px) { .tline { grid-template-columns: 3.6em 1fr; } .tline .tw { grid-column: 2; } .tline .tx { grid-column: 1 / -1; } }
`;

/** Helpers. Needs a global TZ (server timezone) defined before it. */
export const BASE_JS = String.raw`
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
var fmtClock = new Intl.DateTimeFormat(undefined, { timeZone: TZ, hour: "numeric", minute: "2-digit", second: "2-digit" });
function fmt(iso) { return iso ? fmtDT.format(new Date(iso)) : "?"; }
function mb(n) { return n === null || n === undefined ? "" : (n / 1048576).toFixed(n > 1e8 ? 0 : 1) + " MB"; }
function hms(s) { s = Math.round(s); var h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), r = s % 60;
  return (h ? h + ":" + String(m).padStart(2, "0") : m) + ":" + String(r).padStart(2, "0"); }
function ago(iso) {
  var m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return m + " min ago";
  var h = Math.round(m / 60);
  return h < 48 ? h + " h ago" : Math.round(h / 24) + " days ago";
}

// signIn: on 401, go to the sign-in page (admin pages); else just fail.
function api(method, url, body, signIn) {
  var opts = { method: method, headers: {} };
  if (body !== undefined) { opts.headers["Content-Type"] = "application/json"; opts.body = JSON.stringify(body); }
  return fetch(url, opts).then(function (r) {
    if (r.status === 401 && signIn) { location.href = "/login?next=" + encodeURIComponent(location.pathname); throw new Error("sign in first"); }
    var ct = r.headers.get("content-type") || "";
    var p = ct.indexOf("json") >= 0 ? r.json() : r.text();
    return p.then(function (d) {
      if (!r.ok) throw new Error((d && d.error) || d || ("HTTP " + r.status));
      return d;
    });
  });
}

// Header: who's signed in, links, sign out.
function renderMe(box, admin) {
  api("GET", "/api/me").then(function (d) {
    var u = d.user;
    if (!u) { fill(box, el("a", { href: "/login?next=" + encodeURIComponent(location.pathname), text: "Sign in" })); return; }
    var links = [u.email];
    if (!u.verified && d.signup) links.push(el("a", { href: "/account", text: "confirm your email" }));
    if (admin) links.push(el("a", { href: "/", text: "public site" }));
    else if (u.caps.indexOf("admin.view") >= 0) links.push(el("a", { href: "/admin", text: "admin" }));
    links.push(el("a", { href: "/account", text: "account" }));
    links.push(el("a", { href: "#", text: "sign out", on: { click: function (ev) {
      ev.preventDefault(); api("POST", "/api/logout").then(function () { location.href = admin ? "/login" : "/"; });
    } } }));
    var kids = [];
    links.forEach(function (x, i) { if (i) kids.push(" · "); kids.push(x); });
    fill.apply(null, [box].concat(kids));
  }, function () {});
}
`;

/**
 * Replay player. play(r, mediaBase, box): r is a recording from
 * /api/recordings (public) or /api/admin/recordings; mediaBase is the URL
 * prefix for its files ("/media/" or "/admin/media/").
 */
export const PLAYER_JS = String.raw`
function mediaUrl(base, slug, file) { return base + encodeURIComponent(slug) + "/" + encodeURIComponent(file); }

function transcriptNote(r) {
  var t = r.transcript;
  if (!t) return r.video ? "Waiting for the transcriber." : "";
  if (t.status === "done") return "";
  if (t.status === "failed") return "Transcription failed: " + (t.error || "unknown error");
  return "Transcribing" + (t.progress !== null ? " " + t.progress + "%" : "") + (t.stage ? " (" + t.stage + ")" : "") + "...";
}

// o (optional): { bare: no title or download links, chapters: false hides
// the chapter buttons, transcript: false leaves the panel out }.
function play(r, base, box, extraLinks, o) {
  o = o || {};
  var src = mediaUrl(base, r.slug, r.video), f = r.files || {};
  var v = el("video", { controls: "", preload: "metadata", src: src, crossorigin: "anonymous", poster: f.thumb ? mediaUrl(base, r.slug, f.thumb) : null });
  // Subtitles: the Whisper transcript on by default; Zoom's own captions as
  // a second, optional track (reference only).
  if (f.vtt) v.appendChild(el("track", { kind: "subtitles", srclang: "en", label: "Transcript", src: mediaUrl(base, r.slug, f.vtt), "default": "" }));
  if (f.zoomCaptions) v.appendChild(el("track", { kind: "subtitles", srclang: "en", label: "Zoom captions", src: mediaUrl(base, r.slug, f.zoomCaptions) }));
  var chapters = el("div", { "class": "chapters" });
  var showChapters = o.chapters !== false && r.chapters.length > 1;
  r.chapters.forEach(function (c) {
    chapters.appendChild(el("button", { text: hms(c.at) + "  " + c.title, on: { click: function () { v.currentTime = c.at; v.play(); } } }));
  });
  var links = el("span", { "class": "links" }, el("a", { href: src, download: r.video, text: "Video" }));
  [["txt", "Transcript"], ["srt", "SRT"], ["zoomCaptions", "Zoom captions"]].forEach(function (x) {
    if (f[x[0]]) { links.appendChild(document.createTextNode(" · ")); links.appendChild(el("a", { href: mediaUrl(base, r.slug, f[x[0]]), download: f[x[0]], text: x[1] })); }
  });
  (extraLinks || []).forEach(function (a) { links.appendChild(document.createTextNode(" · ")); links.appendChild(a); });
  var tpanel = el("div", { "class": "transcript" });
  fill(box,
    o.bare ? null : el("div", { "class": "player-title" }, el("h3", { text: r.title || r.slug }), links),
    v, showChapters ? chapters : null, o.transcript === false ? null : tpanel);
  box.hidden = false;
  if (o.transcript === false) return v;
  if (f.transcript) loadTranscript(mediaUrl(base, r.slug, f.transcript), v, tpanel);
  else tpanel.appendChild(el("div", { "class": "hint", text: transcriptNote(r) || "No transcript." }));
  return v;
}

function loadTranscript(url, v, box) {
  fill(box, el("div", { "class": "hint", text: "Loading transcript..." }));
  api("GET", url).then(function (t) {
    var segs = (t && t.segments) || [];
    var search = el("input", { type: "search", placeholder: "Search transcript", "aria-label": "Search transcript" });
    var list = el("div", { "class": "tlist" });
    // One colour per speaker, in order of first appearance (golden-angle hues).
    var hues = {}, nh = 0;
    function who(sg) { return sg.label || sg.zoom_speaker || ""; }
    function hue(name) { if (!(name in hues)) hues[name] = Math.round((nh++ * 137.5 + 210) % 360); return hues[name]; }
    var rows = segs.map(function (sg) {
      var w = who(sg);
      var row = el("button", { "class": "tline", type: "button", on: { click: function () { v.currentTime = sg.start; v.play(); } } },
        el("span", { "class": "tt", text: hms(sg.start) }),
        w ? el("span", { "class": "tw", text: w, style: "--h: " + hue(w) }) : null,
        el("span", { "class": "tx", text: (sg.text || "").trim() }));
      row._seg = sg; list.appendChild(row); return row;
    });
    search.addEventListener("input", function () {
      var q = search.value.trim().toLowerCase();
      rows.forEach(function (row) {
        var hit = !q || (row._seg.text || "").toLowerCase().indexOf(q) >= 0 || who(row._seg).toLowerCase().indexOf(q) >= 0;
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
      el("div", { "class": "hint", text: "Whisper " + (t.model || "") + " transcript. " +
        (t.diarization ? t.diarization.speakers_found + " voices found (pyannote); a voice shows a Zoom name only when one participant matched one voice."
                       : "Names are Zoom's active-speaker label, not voice ID.") +
        (t.names_applied ? " Some speaker names were added by hand." : "") + " Times in " + TZ + "." }));
  }, function (e) { fill(box, el("div", { "class": "hint", text: "Couldn't load the transcript: " + e.message })); });
}

// Live draft transcript (live.json) into box; returns a stop function.
function followLive(url, box, note) {
  var shown = 0;
  fill(box, el("div", { "class": "empty", text: "Live transcript: waiting for the first chunk (about 2 minutes of audio)..." }));
  function tick() {
    api("GET", url).then(function (t) {
      if (!t || !t.segments || t.segments.length === shown) return;
      var atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 8;
      if (!shown) fill(box);
      t.segments.slice(shown).forEach(function (sg) {
        box.appendChild(el("div", { "class": "tline" }, el("span", { "class": "tt", text: sg.at ? fmtClock.format(new Date(sg.at)) : "" }),
          el("span", { "class": "tx", text: sg.text })));
      });
      shown = t.segments.length;
      if (atBottom) box.scrollTop = box.scrollHeight;
      if (note) note.textContent = "Transcribed in chunks of about 2 minutes while recording; updated " + ago(t.updated) +
        ". Speakers are added once the meeting ends.";
    }).catch(function () {});
  }
  tick();
  var timer = setInterval(tick, 5000);
  return function () { clearInterval(timer); };
}
`;

/** The public site's own styles (home and meeting pages). */
export const PUBLIC_CSS = String.raw`
main { max-width: 1100px; margin: 0 auto; padding: 12px 24px 40px; }
@media (max-width: 900px) { main { padding: 12px 16px 32px; } }
.intro { color: var(--muted); margin: 0 auto 4px; font-size: 14px; max-width: 1100px; padding: 0 24px; }
@media (max-width: 900px) { .intro { padding: 0 16px; } }
.hsearch { max-width: 1100px; margin: 10px auto 0; padding: 0 24px; display: flex; gap: 8px; }
.hsearch input { flex: 1; min-width: 0; }
@media (max-width: 900px) { .hsearch { padding: 0 16px; } }
.mcard { display: flex; gap: 12px; align-items: flex-start; text-decoration: none; color: inherit; border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px; }
.mcard .p { flex: none; width: 128px; aspect-ratio: 16 / 9; object-fit: cover; border-radius: 5px; background: var(--bg); border: 1px solid var(--line); }
.mcard .b { min-width: 0; flex: 1; }
@media (max-width: 480px) { .mcard .p { width: 88px; } }
.mcard:hover, .mcard:focus-visible { border-color: var(--accent); outline: none; }
.mcard .t { font-weight: 600; overflow-wrap: anywhere; }
.mcard .s { color: var(--muted); font-size: 13px; margin-top: 2px; overflow-wrap: anywhere; }
.s-upcoming { color: var(--accent); } .s-processing { color: var(--warn); } .s-ready { color: var(--ok); }
.s-nofile { color: var(--muted); }
.filters { display: grid; grid-template-columns: 1fr 1fr 1fr 2fr; gap: 8px; margin-bottom: 12px; }
@media (max-width: 700px) { .filters { grid-template-columns: 1fr 1fr; } .filters .q { grid-column: 1 / -1; } }
.more { margin-top: 10px; width: 100%; }
.upd { display: grid; grid-template-columns: 9.5em 1fr; gap: 4px 12px; padding: 7px 2px; border-bottom: 1px solid var(--line); font-size: 14px; }
.upd:last-child { border-bottom: 0; }
.upd .w { color: var(--muted); font-variant-numeric: tabular-nums; }
.upd a { overflow-wrap: anywhere; }
@media (max-width: 600px) { .upd { grid-template-columns: 1fr; gap: 0; } }
.crumbs { margin: 4px 0 12px; font-size: 14px; }
.mtitle { font-size: 22px; line-height: 1.25; text-transform: none; letter-spacing: -.01em; color: var(--ink); margin: 0 0 6px; overflow-wrap: anywhere; font-weight: 700; }
.facts { color: var(--muted); font-size: 14px; display: flex; flex-wrap: wrap; gap: 4px 12px; align-items: center; }
.banner { border: 1px solid var(--line); border-left: 4px solid var(--accent); border-radius: 8px; padding: 10px 12px; margin-top: 12px; }
.banner.live { border-left-color: var(--live); } .banner.warn { border-left-color: var(--warn); } .banner.off { border-left-color: var(--muted); }
.banner b { display: block; }
.joinbox { margin-top: 6px; overflow-wrap: anywhere; } .joinbox .l { font-weight: 600; }
.linkrow { display: flex; flex-wrap: wrap; gap: 6px 14px; margin-bottom: 8px; }
.docs { list-style: none; margin: 0; padding: 0; }
.docs li { padding: 5px 0; border-bottom: 1px solid var(--line); overflow-wrap: anywhere; }
.docs li:last-child { border-bottom: 0; }
.docs .k { color: var(--muted); font-size: 12px; margin-left: 6px; }
.share-row { display: flex; gap: 8px; flex-wrap: wrap; }
.share-row input { flex: 1 1 260px; width: auto; min-width: 0; }
details.embed { margin-top: 12px; }
details.embed summary { cursor: pointer; font-weight: 600; }
.opt { display: inline-flex; gap: 6px; align-items: center; font-weight: 400; margin: 8px 14px 0 0; }
.opt input { width: auto; }
textarea { width: 100%; margin-top: 8px; font: 12px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; padding: 8px; border: 1px solid var(--line);
  border-radius: 7px; background: var(--bg); color: var(--ink); resize: vertical; }
`;

/** Public-site helpers: dates with a year, countdowns, cards, change text. Needs BASE_JS. */
export const PUBLIC_JS = String.raw`
var fmtFull = new Intl.DateTimeFormat(undefined, { timeZone: TZ, weekday: "short", year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
function whenOf(iso) { return iso ? fmtFull.format(new Date(iso)) : "?"; }
function until(iso) {
  var m = Math.round((new Date(iso).getTime() - Date.now()) / 60000);
  if (m <= 0) return "now";
  if (m < 60) return "in " + m + " min";
  var h = Math.floor(m / 60);
  if (h < 24) return "in " + h + " h" + (m % 60 ? " " + (m % 60) + " min" : "");
  var d = Math.round(m / 1440);
  return "in " + d + (d === 1 ? " day" : " days");
}
// ?t=90, ?t=1m30s, ?t=1h2m3s, ?t=1:02:03 -> seconds (0 if absent or not a time).
function startFrom(search) {
  var m = /[?&]t=([^&#]*)/.exec(search || "");
  if (!m) return 0;
  var s; try { s = decodeURIComponent(m[1]); } catch (e) { return 0; }
  var n = /^(\d+)(?::(\d+))?(?::(\d+))?$/.exec(s);
  if (n) { var a = [n[1], n[2], n[3]].filter(function (x) { return x !== undefined; }).map(Number); return a.length === 1 ? a[0] : a.length === 2 ? a[0] * 60 + a[1] : a[0] * 3600 + a[1] * 60 + a[2]; }
  var u = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(s);
  return u && s ? (+(u[1] || 0)) * 3600 + (+(u[2] || 0)) * 60 + (+(u[3] || 0)) : 0;
}
function safeUrl(u) { return typeof u === "string" && /^https?:[/][/]/i.test(u) ? u : null; }
function ext(href, text) { return el("a", { href: safeUrl(href) || "#", text: text, target: "_blank", rel: "noopener noreferrer" }); }

// stage -> [label shown, colour class]
var STAGES = { upcoming: ["upcoming", "upcoming"], live: ["live", "live"], stitching: ["processing", "processing"],
  video_ready: ["video", "ready"], ready: ["video + transcript", "ready"], failed: ["not recorded", "nofile"],
  not_recorded: ["not recorded", "nofile"], cancelled: ["cancelled", "cancelled"] };
function stagePill(stage) {
  var s = STAGES[stage] || [stage, "nofile"];
  return el("span", { "class": "pill s-" + s[1], text: s[0] });
}

function meetingCard(m) {
  var sub = [whenOf(m.start), m.body && m.body !== m.title ? m.body : null, m.duration ? hms(m.duration) : null].filter(Boolean).join(" · ");
  return el("a", { "class": "mcard", href: "/m/" + encodeURIComponent(m.id) },
    m.poster ? el("img", { "class": "p", src: m.poster, alt: "", loading: "lazy", width: "128", height: "72" }) : null,
    el("div", { "class": "b" }, el("div", { "class": "t" }, stagePill(m.stage), m.title), el("div", { "class": "s", text: sub })));
}

function changeText(c) {
  var d = c.doc ? c.doc.title + (c.doc.type ? " (" + c.doc.type + ")" : "") : "";
  switch (c.kind) {
    case "added": return "Announced for " + whenOf(c.to);
    case "date_changed": return "Moved from " + whenOf(c.from) + " to " + whenOf(c.to);
    case "time_changed": return "Time changed from " + whenOf(c.from) + " to " + whenOf(c.to);
    case "cancelled": return "Cancelled";
    case "reinstated": return "Back on the schedule";
    case "document_added": return "Added " + d;
    case "document_changed": return "Updated " + d;
    case "document_removed": return "Removed " + d;
  }
  return c.kind;
}
`;
