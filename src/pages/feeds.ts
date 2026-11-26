/**
 * /admin/feeds: where meetings are found (#8, #9). List feeds with their
 * health and runs, add or edit one (the form is built from the parser's
 * `fields`), preview what a feed returns without saving, run one now.
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
nav.sub { padding: 0 24px; font-size: 13px; color: var(--muted); }
@media (max-width: 900px) { nav.sub { padding: 0 16px; } }
#preview[hidden], #runsbox[hidden] { display: none; }
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
function formBody() {
  return { name: $("f-name").value, parser: $("f-parser").value, config: config(), slugPrefix: $("f-prefix").value,
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
      el("div", { "class": "title" }, el("span", { "class": "pill h-" + f.health, text: HEALTH[f.health] || f.health }), f.name),
      actions, el("div", { "class": "sub", text: sub })));
  });
}

function runNow(f, btn) {
  btn.disabled = true; btn.textContent = "Running...";
  aapi("POST", "/api/admin/feeds/" + f.id + "/run", {}).then(function (d) {
    var o = d.outcome;
    load();
    showRuns(d.feed);
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
    var t = el("table", { "class": "list" }, el("tr", null, el("th", { text: "Start" }), el("th", { text: "Meeting" }), el("th", { text: "Link" }), el("th", { text: "Notes" })));
    d.meetings.sort(function (a, b) { return a.start.localeCompare(b.start); }).forEach(function (m) {
      var notes = [m.cancelled ? "CANCELLED" : null, m.agendaUrl ? "agenda" : null, m.externalId].filter(Boolean).join(" · ");
      t.appendChild(el("tr", null, cell(fmt(m.start)), el("td", null, m.title, m.body && m.body !== m.title ? el("div", { "class": "hint", text: m.body }) : null),
        cell(m.link || "none"), cell(notes)));
    });
    fill(box, el("div", { "class": "hint", text: d.meetings.length + " meeting(s) found. Nothing was saved." }),
      d.meetings.length ? t : null,
      d.changes ? el("pre", { text: JSON.stringify(d.changes, null, 1) }) : null,
      d.log && d.log.length ? el("pre", { text: d.log.join("\n") }) : null);
  }, function (e) { fill(box, el("div", { "class": "msg err", text: e.message })); });
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

function load() {
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
setInterval(function () { if (!document.hidden) load(); }, 15000);
</script>
</body>
</html>
`;
