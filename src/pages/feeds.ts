/**
 * /admin/feeds: where meetings are found (#8-#11). List feeds with their
 * health and runs, add or edit one (the form is built from the parser's
 * `fields`), preview what a feed returns and would change without saving,
 * run one now; the review queue; upcoming meetings with their history,
 * and "same as" / split for duplicates.
 *
 * Same rules as the other pages: String.raw, so no backticks or dollar-brace
 * in the script; data only via textContent; listeners in the script (CSP).
 */
import { BASE_CSS, BASE_JS } from "./common.js";

export const FEEDS_PAGE = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Feeds · minutes</title>
<link rel="icon" href="data:,">
<style>
${BASE_CSS}
main { display: grid; grid-template-columns: minmax(320px, 440px) 1fr; gap: 20px; padding: 12px 24px 40px; align-items: start; }
@media (max-width: 900px) { main { grid-template-columns: 1fr; padding: 12px 16px 32px; } }
textarea { width: 100%; min-height: 80px; padding: 8px 10px; border: 1px solid var(--line); border-radius: 7px; background: var(--bg); color: var(--ink); font: inherit; }
.actions-row { display: flex; gap: 8px; margin-top: 14px; flex-wrap: wrap; }
.actions-row button { flex: 1; }
.h-ok { color: var(--ok); } .h-failing { color: var(--warn); } .h-unhealthy { color: var(--bad); } .h-new, .h-disabled { color: var(--muted); }
.field-help { color: var(--muted); font-size: 12px; margin-top: 3px; }
table.list { width: 100%; border-collapse: collapse; font-size: 13px; }
table.list th, table.list td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--line); vertical-align: top; overflow-wrap: anywhere; }
table.list th { color: var(--muted); font-weight: 600; }
.tag { display: inline-block; font-size: 11px; padding: 1px 6px; border-radius: 999px; border: 1px solid currentColor; }
.links-line a { overflow-wrap: anywhere; }
nav.sub { padding: 0 24px; font-size: 13px; color: var(--muted); }
@media (max-width: 900px) { nav.sub { padding: 0 16px; } }
#preview[hidden], #runsbox[hidden] { display: none; }
.muni { font-size: 12px; font-weight: 700; padding: 2px 8px; border-radius: 999px; background: var(--accent); color: var(--accent-ink); }
.colorrow { display: flex; gap: 10px; align-items: center; }
.colorrow input[type=color] { width: 44px; height: 32px; padding: 2px; }
.swatch { display: inline-block; width: 12px; height: 12px; border-radius: 50%; margin-left: 8px; vertical-align: middle; border: 1px solid var(--line, #8885); }
</style>
</head>
<body>
<header>
  <h1><a href="/admin">minutes</a> <small class="meta">admin · feeds</small></h1>
  <span class="me" id="me"></span>
</header>
<nav class="sub"><a href="/admin">Captures</a> · <b>Feeds</b></nav>
<main>
  <div>
    <section>
      <h2 id="formtitle">Add a feed</h2>
      <form id="form" autocomplete="off">
        <label for="f-name">Name</label>
        <input id="f-name" name="name" required maxlength="100" placeholder="Langford council">
        <label for="f-parser">Source type</label>
        <select id="f-parser" name="parser"></select>
        <div class="field-help" id="parserhelp"></div>
        <div id="fields"></div>
        <label for="f-color">Badge color <small>(the municipality badge on the public site)</small></label>
        <div class="colorrow">
          <input id="f-color" type="color" value="#1a7f5a" aria-label="Badge color">
          <span id="f-colorpv" class="muni">Name</span>
          <button type="button" id="f-colornone">No color</button>
        </div>
        <label for="f-prefix">Folder prefix <small>(recordings are named prefix-title-date)</small></label>
        <input id="f-prefix" name="slugPrefix" required maxlength="40" pattern="[A-Za-z0-9][A-Za-z0-9._\-]{0,39}" placeholder="langford">
        <label for="f-policy">New meetings</label>
        <select id="f-policy" name="policy">
          <option value="review">Wait for my review (recommended for a new feed)</option>
          <option value="auto">Record automatically when there's a supported link</option>
          <option value="list_only">List only, never record</option>
        </select>
        <label for="f-interval">Check every <small>(minutes; every 5 on a meeting day)</small></label>
        <input id="f-interval" name="intervalMin" type="number" min="5" max="1440" value="60">
        <label class="check"><input type="checkbox" id="f-enabled" name="enabled" checked> Enabled</label>
        <div class="actions-row">
          <button type="button" id="previewbtn">Preview</button>
          <button class="primary" type="submit" id="savebtn" style="margin-top:0">Add feed</button>
          <button type="button" id="cancelbtn" hidden>Cancel edit</button>
        </div>
        <div class="msg" id="formmsg" role="status"></div>
      </form>
    </section>
  </div>
  <div>
    <section>
      <h2>Feeds</h2>
      <div class="list" id="feeds"><div class="empty">Loading...</div></div>
    </section>
    <section>
      <h2>Review queue</h2>
      <div class="list" id="review"><div class="empty">Loading...</div></div>
    </section>
    <section>
      <h2>Upcoming meetings</h2>
      <div class="list" id="meetings"><div class="empty">Loading...</div></div>
    </section>
    <section id="preview" hidden>
      <div class="player-title"><h3 id="previewtitle">Preview</h3><button type="button" id="previewclose">Close</button></div>
      <div id="previewbody"></div>
    </section>
    <section id="runsbox" hidden>
      <div class="player-title"><h3 id="runstitle">Runs</h3><button type="button" id="runsclose">Close</button></div>
      <div id="runsbody"></div>
    </section>
  </div>
</main>
<script>
"use strict";
var TZ = __TZ__;
${BASE_JS}
var PARSERS = [], FEEDS = [], editing = null;
function aapi(method, url, body) { return api(method, url, body, true); }
function $(id) { return document.getElementById(id); }
function msg(cls, text) { var m = $("formmsg"); m.className = "msg" + (cls ? " " + cls : ""); m.textContent = text; }
function parser(id) { return PARSERS.find(function (p) { return p.id === id; }); }

// The config fields for the chosen parser, filled from values.
function renderFields(values) {
  var p = parser($("f-parser").value), box = $("fields");
  fill(box);
  $("parserhelp").textContent = p ? p.description : "";
  if (!p) return;
  p.fields.forEach(function (f) {
    var id = "cfg-" + f.name, v = values && values[f.name] !== undefined ? values[f.name] : "";
    if (f.type === "list" && Array.isArray(v)) v = v.join("\n");
    var input = f.type === "textarea" || f.type === "list"
      ? el("textarea", { id: id, name: f.name, placeholder: f.placeholder || "" })
      : el("input", { id: id, name: f.name, type: f.type === "number" ? "number" : f.type === "url" ? "url" : "text", placeholder: f.placeholder || "" });
    if (f.required) input.required = true;
    input.value = v === null || v === undefined ? "" : String(v);
    box.appendChild(el("label", { "for": id }, f.label, f.required ? null : el("small", { text: " (optional)" })));
    box.appendChild(input);
    if (f.help) box.appendChild(el("div", { "class": "field-help", text: f.help }));
  });
}
function config() {
  var p = parser($("f-parser").value), c = {};
  if (!p) return c;
  p.fields.forEach(function (f) {
    var v = $("cfg-" + f.name).value;
    if (f.type === "list") c[f.name] = v.split("\n").map(function (x) { return x.trim(); }).filter(Boolean);
    else if (f.type === "number") { if (v !== "") c[f.name] = Number(v); }
    else if (v.trim() !== "") c[f.name] = v.trim();
  });
  return c;
}
var colorOn = false;
function inkFor(hex) {
  var n = parseInt(hex.slice(1), 16), r = n >> 16, g = (n >> 8) & 255, b = n & 255;
  return (r * 299 + g * 587 + b * 114) / 1000 > 150 ? "#111" : "#fff";
}
function setColor(hex) {
  colorOn = !!hex;
  if (hex) $("f-color").value = hex;
  var pv = $("f-colorpv");
  pv.style.background = hex || ""; pv.style.color = hex ? inkFor(hex) : "";
  pv.textContent = $("f-name").value || "Name";
  $("f-colornone").hidden = !hex;
}
$("f-color").addEventListener("input", function () { setColor($("f-color").value); });
$("f-colornone").addEventListener("click", function () { setColor(""); });
$("f-name").addEventListener("input", function () { $("f-colorpv").textContent = $("f-name").value || "Name"; });
function formBody() {
  return { name: $("f-name").value, parser: $("f-parser").value, config: config(), slugPrefix: $("f-prefix").value, color: colorOn ? $("f-color").value : "",
    policy: $("f-policy").value, intervalMin: $("f-interval").value, enabled: $("f-enabled").checked };
}

function setMode(f) {
  editing = f || null;
  $("formtitle").textContent = f ? "Edit " + f.name : "Add a feed";
  $("savebtn").textContent = f ? "Save" : "Add feed";
  $("cancelbtn").hidden = !f;
  $("f-name").value = f ? f.name : "";
  $("f-parser").value = f ? f.parser : (PARSERS[0] ? PARSERS[0].id : "");
  $("f-parser").disabled = false;
  $("f-prefix").value = f ? f.slugPrefix : "";
  setColor(f && f.color ? f.color : "");
  $("f-policy").value = f ? f.policy : "review";
  $("f-interval").value = f ? f.intervalMin : 60;
  $("f-enabled").checked = f ? f.enabled : true;
  renderFields(f ? f.config : null);
  msg("", "");
}

var HEALTH = { ok: "healthy", failing: "failing", unhealthy: "failing for over 24 h", "new": "not run yet", disabled: "disabled" };
function render() {
  var box = $("feeds");
  fill(box);
  if (!FEEDS.length) { box.appendChild(el("div", { "class": "empty", text: PARSERS.length ? "No feeds yet. Add one on the left." : "No feed parsers are installed." })); return; }
  FEEDS.forEach(function (f) {
    var last = f.runs[0];
    var sub = f.parserLabel + " · " + f.policy.replace("_", " ") + " · every " + f.intervalMin + " min" +
      (last ? " · last run " + ago(last.startedAt) + ": " + last.status + (last.items !== null ? " (" + last.items + " meetings)" : "") : "") +
      (f.enabled && f.nextRunAt ? " · next " + fmt(f.nextRunAt) : "") + (f.lastError ? " · " + f.lastError : "");
    var actions = el("div", { "class": "actions" },
      el("button", { text: f.running ? "Running..." : "Run now", disabled: f.running ? "" : null, on: { click: function (ev) { runNow(f, ev.target); } } }),
      el("button", { text: "Preview", on: { click: function () { preview(f.parser, f.config, f); } } }),
      el("button", { text: "Runs", on: { click: function () { showRuns(f); } } }),
      el("button", { text: "Edit", on: { click: function () { setMode(f); window.scrollTo({ top: 0, behavior: "smooth" }); } } }),
      el("button", { "class": "danger", text: "Delete", on: { click: function () {
        if (confirm("Delete the feed " + f.name + "? Meetings it found stay.")) aapi("DELETE", "/api/admin/feeds/" + f.id).then(load, function (e) { alert(e.message); });
      } } }));
    box.appendChild(el("div", { "class": "row" },
      el("div", { "class": "title" }, el("span", { "class": "pill h-" + f.health, text: HEALTH[f.health] || f.health }), f.name,
        f.color ? el("span", { "class": "swatch", title: "Badge color " + f.color, style: "background:" + f.color }) : null),
      actions, el("div", { "class": "sub", text: sub })));
  });
}

function runNow(f, btn) {
  btn.disabled = true; btn.textContent = "Running...";
  aapi("POST", "/api/admin/feeds/" + f.id + "/run", {}).then(function (d) {
    var o = d.outcome;
    load();
    showRuns(d.feed);
    if (o.status === "suspect") alert(f.name + ": suspect run, nothing applied. " + o.note);
    if (o.status === "error") alert(f.name + ": " + o.error);
  }, function (e) { alert(e.message); load(); });
}

function cell(t) { return el("td", { text: t === null || t === undefined ? "" : String(t) }); }
function preview(parserId, cfg, feed) {
  var box = $("previewbody");
  $("preview").hidden = false;
  $("previewtitle").textContent = "Preview" + (feed ? ": " + feed.name : "");
  fill(box, el("div", { "class": "hint", text: "Fetching... (nothing is saved)" }));
  $("preview").scrollIntoView({ behavior: "smooth", block: "start" });
  aapi("POST", "/api/admin/feeds/preview", { parser: parserId, config: cfg, feedId: feed ? feed.id : undefined }).then(function (d) {
    var t = el("table", { "class": "list" }, el("tr", null, el("th", { text: "Start" }), el("th", { text: "Meeting" }), el("th", { text: "Join link" }),
      el("th", { text: "Stream" }), el("th", { text: "Notes" })));
    d.meetings.sort(function (a, b) { return a.start.localeCompare(b.start); }).forEach(function (m) {
      var notes = [m.cancelled ? "CANCELLED" : null, m.agendaUrl ? "agenda" : null, m.externalId].filter(Boolean).join(" · ");
      t.appendChild(el("tr", null, cell(fmt(m.start)), el("td", null, m.title, m.body && m.body !== m.title ? el("div", { "class": "hint", text: m.body }) : null),
        cell(m.link || "not yet"), m.streamUrl ? el("td", null, el("a", { href: m.streamUrl, target: "_blank", rel: "noopener", text: "watch" })) : cell("not yet"),
        cell(notes)));
    });
    fill(box, el("div", { "class": "hint", text: d.meetings.length + " meeting(s) found. Nothing was saved." }),
      d.meetings.length ? t : null,
      d.changes ? changeTable(d.changes) : null,
      d.log && d.log.length ? el("pre", { text: d.log.join("\n") }) : null);
  }, function (e) { fill(box, el("div", { "class": "msg err", text: e.message })); });
}

function show(v) { return v === null || v === undefined ? "none" : typeof v === "string" ? v : JSON.stringify(v); }
function delta(c) {
  var keys = Object.keys(c.after || c.before || {});
  return keys.map(function (k) {
    return k + ": " + (c.before && c.after ? show(c.before[k]) + " → " + show(c.after[k]) : show((c.after || c.before)[k]));
  }).join("; ");
}
// What a run would do (preview) or did (history).
function changeTable(d) {
  var list = d.changes || d;
  var t = el("table", { "class": "list" }, el("tr", null, el("th", { text: "Change" }), el("th", { text: "Meeting" }), el("th", { text: "What" }), el("th", { text: "Effect" })));
  list.forEach(function (c) {
    t.appendChild(el("tr", null, cell(c.kind.replace("_", " ")), cell((c.title || "") + (c.start ? " · " + fmt(c.start) : "")), cell(delta(c)), cell(c.effect)));
  });
  return el("div", null,
    d.suspect ? el("div", { "class": "msg err", text: "Suspect: " + d.note } ) : null,
    el("h4", { text: list.length ? "Would change:" : "No changes." }), list.length ? t : null);
}

var MEETINGS = [];
function meetingRow(m, inQueue) {
  var pills = [];
  if (m.status === "cancelled") pills.push(pill("cancelled"));
  else if (m.duplicateOf) pills.push(el("span", { "class": "pill s-stopped", text: "duplicate" }));
  else if (m.review === "pending") pills.push(el("span", { "class": "pill s-scheduled", text: "to review" }));
  else if (m.review === "rejected") pills.push(el("span", { "class": "pill s-stopped", text: "rejected" }));
  if (m.capture && m.capture.status !== "cancelled") pills.push(pill(m.capture.status));
  if (m.removedAt) pills.push(el("span", { "class": "pill s-failed", text: "gone from feed" }));
  if (m.visibility === "hidden") pills.push(el("span", { "class": "pill s-stopped", text: "hidden" }));
  var sub = [fmt(m.start), m.body && m.body !== m.title ? m.body : null, m.feedName,
    m.capture ? "capture " + m.capture.slug : null,
    m.duplicateOf ? "same as " + m.duplicateOf.title + " (" + m.duplicateOf.slug + ")" : null].filter(Boolean).join(" · ");
  var hist = el("div", { "class": "sub" });
  var actions = el("div", { "class": "actions" });
  function act(name, body) {
    return function () {
      aapi("POST", "/api/admin/meetings/" + m.id + "/" + name, body || {}).then(function (d) { loadMeetings(); msgFor(m, d.effect); },
        function (e) { alert(e.message); });
    };
  }
  if (m.review === "pending" && m.status !== "cancelled" && !m.duplicateOf) {
    actions.appendChild(el("button", { text: "Approve", on: { click: act("approve") } }));
    actions.appendChild(el("button", { "class": "danger", text: "Reject", on: { click: act("reject") } }));
  }
  if (!inQueue) {
    if (m.duplicateOf) actions.appendChild(el("button", { text: "Split", on: { click: act("split") } }));
    else {
      var near = MEETINGS.filter(function (x) { return x.id !== m.id && !x.duplicateOf && Math.abs(Date.parse(x.start) - Date.parse(m.start)) < 86400000; });
      if (near.length) {
        var sel = el("select", { "aria-label": "Same meeting as" }, el("option", { value: "", text: "Same as..." }));
        near.forEach(function (x) { sel.appendChild(el("option", { value: x.id, text: x.title + " · " + fmt(x.start) + (x.feedName ? " · " + x.feedName : "") })); });
        sel.addEventListener("change", function () {
          if (sel.value && confirm("Treat " + m.title + " as the same meeting? It won't be captured itself.")) act("merge", { into: sel.value })();
          else sel.value = "";
        });
        actions.appendChild(sel);
      }
    }
    if (!m.duplicateOf) {
      actions.appendChild(el("button", { text: m.visibility === "hidden" ? "Show publicly" : "Hide", title: "Admin-only override: a hidden meeting is not on the public site",
        on: { click: act(m.visibility === "hidden" ? "show" : "hide") } }));
    }
    actions.appendChild(el("button", { text: "History", on: { click: function () {
      if (hist.childNodes.length) { fill(hist); return; }
      aapi("GET", "/api/admin/meetings/" + m.id + "/changes").then(function (cs) {
        fill(hist, cs.length ? changeTable(cs) : el("div", { "class": "hint", text: "No changes recorded." }));
      });
    } } }));
  }
  // el() takes children one by one, not an array.
  var title = el("div", { "class": "title" });
  pills.forEach(function (p) { title.appendChild(p); });
  title.appendChild(document.createTextNode(m.title));
  var row = el("div", { "class": "row", id: (inQueue ? "q-" : "m-") + m.id }, title, actions, el("div", { "class": "sub", text: sub }),
    linksLine(m), hist);
  return row;
}
// Join link (what gets recorded) and stream page (what viewers watch):
// detected or not, and where. The join link never includes its passcode.
function linksLine(m) {
  var j = m.joinLink, line = el("div", { "class": "sub links-line" });
  line.appendChild(el("span", { "class": "tag " + (j ? "h-ok" : "h-new"), text: j ? "join link" : "no join link yet" }));
  if (j) {
    line.appendChild(document.createTextNode(" "));
    line.appendChild(j.url ? el("a", { href: j.url, target: "_blank", rel: "noopener", text: j.label }) : el("span", { text: j.label }));
    if (j.passcode) line.appendChild(document.createTextNode(" (passcode on file)"));
    if (m.joinSource) line.appendChild(document.createTextNode(" (found in " + m.joinSource + ")"));
  }
  line.appendChild(document.createTextNode("  "));
  line.appendChild(el("span", { "class": "tag " + (m.streamUrl ? "h-ok" : "h-new"), text: m.streamUrl ? "stream" : "no stream page yet" }));
  if (m.streamUrl) { line.appendChild(document.createTextNode(" ")); line.appendChild(el("a", { href: m.streamUrl, target: "_blank", rel: "noopener", text: m.streamUrl })); }
  return line;
}

function msgFor(m, text) {
  var r = document.getElementById("m-" + m.id) || document.getElementById("q-" + m.id);
  if (r) r.appendChild(el("div", { "class": "sub msg ok", text: text }));
}
function loadMeetings() {
  return Promise.all([aapi("GET", "/api/admin/meetings?view=upcoming"), aapi("GET", "/api/admin/meetings?view=review")]).then(function (d) {
    MEETINGS = d[0];
    var box = $("meetings"), q = $("review");
    fill(box); fill(q);
    if (!d[1].length) q.appendChild(el("div", { "class": "empty", text: "Nothing waiting for review." }));
    d[1].forEach(function (m) { q.appendChild(meetingRow(m, true)); });
    if (!MEETINGS.length) box.appendChild(el("div", { "class": "empty", text: "No upcoming meetings." }));
    MEETINGS.forEach(function (m) { box.appendChild(meetingRow(m, false)); });
  }).catch(function (e) { fill($("meetings"), el("div", { "class": "msg err", text: "Can't show meetings: " + e.message })); });
}

function showRuns(f) {
  $("runsbox").hidden = false;
  $("runstitle").textContent = "Runs: " + f.name;
  aapi("GET", "/api/admin/feeds/" + f.id + "/runs").then(function (runs) {
    var t = el("table", { "class": "list" }, el("tr", null, el("th", { text: "Started" }), el("th", { text: "Status" }),
      el("th", { text: "Meetings" }), el("th", { text: "Changes" }), el("th", { text: "Error / note" })));
    runs.forEach(function (r) {
      t.appendChild(el("tr", null, cell(fmt(r.startedAt) + (r.trigger === "manual" ? " (manual)" : "")), cell(r.status), cell(r.items), cell(r.changes), cell(r.error)));
    });
    fill($("runsbody"), runs.length ? t : el("div", { "class": "empty", text: "No runs yet." }));
  }, function (e) { fill($("runsbody"), el("div", { "class": "msg err", text: e.message })); });
}

function load(skipMeetings) {
  return aapi("GET", "/api/admin/feeds").then(function (d) {
    var first = !PARSERS.length;
    PARSERS = d.parsers; FEEDS = d.feeds;
    if (first) {
      var sel = $("f-parser");
      fill(sel);
      PARSERS.forEach(function (p) { sel.appendChild(el("option", { value: p.id, text: p.label })); });
      if (!editing) setMode(null);
    }
    render();
    if (!skipMeetings) loadMeetings();
  }, function (e) { fill($("feeds"), el("div", { "class": "empty", text: "Can't load feeds: " + e.message })); });
}

$("f-parser").addEventListener("change", function () { renderFields(null); });
$("cancelbtn").addEventListener("click", function () { setMode(null); });
$("previewclose").addEventListener("click", function () { $("preview").hidden = true; });
$("runsclose").addEventListener("click", function () { $("runsbox").hidden = true; });
$("previewbtn").addEventListener("click", function () {
  if (!$("f-parser").value) return;
  preview($("f-parser").value, config(), editing);
});
$("form").addEventListener("submit", function (ev) {
  ev.preventDefault();
  msg("", "Saving...");
  var req = editing ? aapi("PATCH", "/api/admin/feeds/" + editing.id, formBody()) : aapi("POST", "/api/admin/feeds", formBody());
  req.then(function (f) { msg("ok", (editing ? "Saved " : "Added ") + f.name + "."); setMode(null); load(); },
    function (e) { msg("err", e.message); });
});

renderMe($("me"), true);
load();
// Feeds only: a refresh of the meeting lists would close open histories.
setInterval(function () { if (!document.hidden) load(true); }, 15000);
</script>
</body>
</html>
`;
