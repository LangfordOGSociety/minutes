/**
 * Speaker names added by hand: applied when serving (the files on disk
 * stay as the transcriber wrote them), in every readable format, in search,
 * through the admin API and its page.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, it, type TestContext } from "node:test";
import { NAMES_FILE, NamesError, applyNames, cleanNames, kindOf, labelsOf, nameSegments, namedFile, readNames, writeNames } from "../src/speakers.js";
import { tmpDir, type HasAfter } from "./helpers.js";
import { fixtures } from "./fixtures.js";
import { Client, startApp } from "./server.js";

const TRANSCRIPT = {
  model: "large-v3-turbo",
  segments: [
    { start: 0.03, end: 2.95, text: "My name is Marie Watmo and I will be the moderator.", label: "Speaker 1", speaker: "SPEAKER_00", zoom_speaker: "Zoom Council" },
    { start: 5, end: 9, text: "Speaker 1: is not a label here.", label: "Speaker 2" },
    { start: 10, end: 12, text: "Thank you.", label: "Speaker 1" },
    { start: 20, end: 30, text: "I move that we adjourn.", label: "Eric McNiece" },
    { start: 40, end: 41, text: "Hello.", zoom_speaker: "Zoom Council" },
    { start: 50, end: 51, text: "No label at all." },
  ],
};
const VTT = `WEBVTT\n\nNOTE x\n\n1\n00:00:00.031 --> 00:00:02.954\n<v Speaker 1>My name is Marie.\n\n2\n00:00:05.000 --> 00:00:09.000\n<v Speaker 2>The <v Speaker 1> tag in the talk stays.\n\n3\n00:00:20.000 --> 00:00:30.000\n<v Eric McNiece>I move.\n`;
const SRT = `1\n00:00:00,031 --> 00:00:02,954\nSpeaker 1: My name is Marie.\n\n2\n00:00:05,000 --> 00:00:09,000\nSpeaker 2: Speaker 1: is not a label here.\n\n3\n00:00:20,000 --> 00:00:30,000\nEric McNiece: I move.\n`;
const TXT = `[00:00:00] Speaker 1:\nMy name is Marie.\nSpeaker 1: said in passing.\n\n[00:00:05] Speaker 2:\nSpeaker 1: is not a label here.\n\n[00:00:20] Eric McNiece:\nI move.\n`;

describe("applying names", () => {
  const names = { "Speaker 1": "Marie Watmo", "Speaker 2": "Councillor O'Brien", "Eric McNiece": "Eric (Councillor)" };

  it("each format, anchored to where the transcriber puts labels, so the talk itself is untouched", () => {
    const vtt = applyNames("vtt", VTT, names);
    assert.match(vtt, /^<v Marie Watmo>My name is Marie\.$/m);
    assert.match(vtt, /^<v Councillor O'Brien>The <v Speaker 1> tag in the talk stays\.$/m);   // only a cue's leading tag
    assert.match(vtt, /^<v Eric \(Councillor\)>I move\.$/m);
    const srt = applyNames("srt", SRT, names);
    assert.match(srt, /^Marie Watmo: My name is Marie\.$/m);
    assert.match(srt, /^Councillor O'Brien: Speaker 1: is not a label here\.$/m);              // the first one only
    assert.match(srt, /^Eric \(Councillor\): I move\.$/m);
    assert.doesNotMatch(srt, /^Speaker 1: My/m);
    const txt = applyNames("txt", TXT, names);
    assert.match(txt, /^\[00:00:00\] Marie Watmo:$/m);
    assert.match(txt, /^Speaker 1: said in passing\.$/m);                                       // a line of speech, not a header
    assert.match(txt, /^\[00:00:20\] Eric \(Councillor\):$/m);
    const json = JSON.parse(applyNames("json", JSON.stringify(TRANSCRIPT), names));
    assert.deepEqual(json.segments.map((s: { label?: string }) => s.label ?? null), ["Marie Watmo", "Councillor O'Brien", "Marie Watmo", "Eric (Councillor)", null, null]);
    assert.equal(json.names_applied, true);
    assert.equal(json.segments[1].text, "Speaker 1: is not a label here.");                     // the words are never changed
    assert.equal(json.segments[0].speaker, "SPEAKER_00");                                        // nor the transcriber's own fields
    // A segment with only a Zoom name is renameable by that name.
    assert.equal(JSON.parse(applyNames("json", JSON.stringify(TRANSCRIPT), { "Zoom Council": "Room" })).segments[4].label, "Room");
    // No names: the text exactly as it was; names that match nothing: no flag.
    assert.equal(applyNames("vtt", VTT, {}), VTT);
    assert.equal(JSON.parse(applyNames("json", JSON.stringify(TRANSCRIPT), { "Speaker 9": "X" })).names_applied, undefined);
    // Two voices, one name: merged.
    assert.equal([...applyNames("srt", SRT, { "Speaker 1": "A", "Speaker 2": "A" }).matchAll(/^A: /gm)].length, 2);
    // Regex characters in a label are just characters.
    assert.match(applyNames("vtt", "<v a.b (c)>x", { "a.b (c)": "N" }), /^<v N>x$/);
    assert.equal(applyNames("vtt", "<v axb (c)>x", { "a.b (c)": "N" }), "<v axb (c)>x");
  });

  it("names are validated against the transcript's own labels and tidied", () => {
    const valid = new Set(["Speaker 1", "Speaker 2"]);
    assert.deepEqual(cleanNames({ "Speaker 1": "  Marie   Watmo ", "Speaker 2": "" }, valid), { "Speaker 1": "Marie Watmo" });
    assert.deepEqual(cleanNames({ "Speaker 1": null, "Speaker 2": "  " }, valid), {});
    assert.deepEqual(cleanNames({ "Speaker 1": "Marie\nWatmo\t(Chair)" }, valid), { "Speaker 1": "Marie Watmo (Chair)" });       // whitespace is tidied, not refused
    assert.deepEqual(cleanNames({}, valid), {});
    for (const [bad, re] of [[{ "Speaker 9": "X" }, /isn't a speaker/], [{ "Speaker 1": 5 }, /must be text/], [{ "Speaker 1": "x".repeat(61) }, /over 60/], [{ "Speaker 1": "a<b" }, /can't contain/],
      [{ "Speaker 1": "a>b" }, /can't contain/], [{ "Speaker 1": "a&b" }, /can't contain/], [{ "Speaker 1": "a\u0001b" }, /can't contain/], [[], /must be an object/], ["x", /must be an object/], [null, /must be an object/]] as [unknown, RegExp][]) {
      assert.throws(() => cleanNames(bad, valid), (e: Error) => e instanceof NamesError && re.test(e.message), JSON.stringify(bad));
    }
  });

  it("labels in order of first appearance, with time spoken and a first line", () => {
    const l = labelsOf(TRANSCRIPT);
    assert.deepEqual(l.map((x) => [x.label, x.segments, x.seconds]), [["Speaker 1", 2, 5], ["Speaker 2", 1, 4], ["Eric McNiece", 1, 10], ["Zoom Council", 1, 1]]);
    assert.deepEqual(l[0].first, { t: 0.03, text: "My name is Marie Watmo and I will be the moderator." });
    assert.deepEqual(labelsOf({}), []);
    assert.deepEqual(labelsOf(null), []);
    assert.deepEqual(nameSegments([{ start: 1, label: "Speaker 1" }, { start: 2 }], { "Speaker 1": "A" }), [{ start: 1, label: "A" }, { start: 2 }]);
  });

  it("the names file: read tolerantly, written atomically, and only the readable files are renamed", (t) => {
    const dir = tmpDir({ after: (fn) => t.after(fn) } as HasAfter);
    assert.deepEqual(readNames(dir), {});
    writeFileSync(path.join(dir, NAMES_FILE), "{garbage");
    assert.deepEqual(readNames(dir), {});
    writeFileSync(path.join(dir, NAMES_FILE), JSON.stringify({ "Speaker 1": "A", "": "x", "Speaker 2": 5, "Speaker 3": "  " }));
    assert.deepEqual(readNames(dir), { "Speaker 1": "A" });
    writeNames(dir, { "Speaker 1": "Marie" });
    assert.equal(existsSync(path.join(dir, `${NAMES_FILE}.tmp`)), false);
    assert.deepEqual(JSON.parse(readFileSync(path.join(dir, NAMES_FILE), "utf8")), { "Speaker 1": "Marie" });
    for (const [f, k] of [["s.transcript.json", "json"], ["s.vtt", "vtt"], ["s.srt", "srt"], ["s.txt", "txt"], ["s.mp4", null], ["manifest.json", null], ["other.vtt", null], ["s.zoom-captions.vtt", null]] as const) assert.equal(kindOf("s", f), k, f);
    writeFileSync(path.join(dir, "s.vtt"), VTT);
    const cache = new Map<string, string>();
    assert.match(namedFile(dir, "s", "s.vtt", cache)!, /<v Marie>My name is Marie/);
    assert.equal(namedFile(dir, "s", "s.mp4", cache), null);
    writeNames(dir, {});
    assert.equal(namedFile(dir, "s", "s.vtt", cache), null);                                                       // no names: serve the file itself
  });
});

async function setup(t: TestContext) {
  const cleanups: (() => unknown)[] = [];
  t.after(async () => { for (const f of cleanups.reverse()) await f(); });
  const hooks: HasAfter = { after: (fn) => cleanups.push(fn) };
  const out = path.join(tmpDir(hooks), "rec");
  const { app, base } = await startApp(hooks, out);
  fixtures(app, out);
  const d = path.join(out, "council-a");
  writeFileSync(path.join(d, "council-a.transcript.json"), JSON.stringify(TRANSCRIPT));
  writeFileSync(path.join(d, "council-a.vtt"), VTT); writeFileSync(path.join(d, "council-a.srt"), SRT); writeFileSync(path.join(d, "council-a.txt"), TXT);
  await app.accounts.create({ email: "admin@example.com", role: "admin", password: "admin password 1", verified: true });
  await app.accounts.create({ email: "reader@example.com", role: "user", password: "reader password 1", verified: true });
  const as = async (e: string, p: string) => { const c = new Client(base); assert.equal((await c.login(e, p)).status, 200); return c; };
  return { app, base, out, d, admin: await as("admin@example.com", "admin password 1"), reader: await as("reader@example.com", "reader password 1"), pub: new Client(base) };
}

describe("speaker names through the server", () => {
  it("the admin names voices; every transcript view shows them, the files on disk don't change", async (t) => {
    const { app, d, admin, pub } = await setup(t);
    const ed = await admin.get("/api/admin/recordings/council-a/speakers");
    assert.equal(ed.status, 200);
    assert.deepEqual(ed.json.labels.map((l: { label: string; name: string | null }) => [l.label, l.name]), [["Speaker 1", null], ["Speaker 2", null], ["Eric McNiece", null], ["Zoom Council", null]]);
    assert.equal((await pub.get("/media/council-a/council-a.vtt")).text, VTT);                                      // before: as the transcriber wrote it
    const put = await admin.req("PUT", "/api/admin/recordings/council-a/speakers", { names: { "Speaker 1": "Marie Watmo", "Speaker 2": "Councillor O'Brien" } });
    assert.deepEqual([put.status, put.json.names], [200, { "Speaker 1": "Marie Watmo", "Speaker 2": "Councillor O'Brien" }]);
    const vtt = await pub.get("/media/council-a/council-a.vtt");
    assert.deepEqual([vtt.status, vtt.headers.get("content-type"), vtt.headers.get("content-length")], [200, "text/vtt; charset=utf-8", String(Buffer.byteLength(vtt.text))]);
    assert.match(vtt.text, /<v Marie Watmo>My name is Marie/);
    assert.match((await pub.get("/media/council-a/council-a.srt")).text, /^Marie Watmo: My name/m);
    assert.match((await pub.get("/media/council-a/council-a.txt")).text, /^\[00:00:00\] Marie Watmo:$/m);
    const json = (await pub.get("/media/council-a/council-a.transcript.json")).json;
    assert.deepEqual([json.names_applied, json.segments[0].label, json.segments[3].label], [true, "Marie Watmo", "Eric McNiece"]);
    assert.equal((await pub.req("HEAD", "/media/council-a/council-a.vtt")).status, 200);
    // Files that aren't transcripts are served as they were; the originals on disk are untouched.
    assert.equal((await pub.get("/media/council-a/council-a.zoom-captions.vtt")).status, 200);
    assert.equal(readFileSync(path.join(d, "council-a.vtt"), "utf8"), VTT);
    assert.equal(JSON.parse(readFileSync(path.join(d, "council-a.transcript.json"), "utf8")).segments[0].label, "Speaker 1");
    // The admin's own player gets them too; the API's downloads and the editor's labels are as intended.
    assert.match((await admin.get("/admin/media/council-a/council-a.vtt")).text, /<v Marie Watmo>/);
    assert.equal((await admin.get("/api/admin/recordings/council-a/speakers")).json.labels[0].name, "Marie Watmo");
    assert.equal((await admin.get("/api/admin/recordings/council-a/speakers")).json.labels[0].label, "Speaker 1");     // still by the original label
    assert.match(readFileSync(path.join(d, "speaker-names.json"), "utf8"), /Marie Watmo/);
    assert.match((await admin.get("/api/admin/audit?limit=10")).text, /speakers\.update/);
    // Changing it takes effect at once; clearing returns the original.
    await admin.req("PUT", "/api/admin/recordings/council-a/speakers", { names: { "Speaker 1": "Marie W." } });
    assert.match((await pub.get("/media/council-a/council-a.srt")).text, /^Marie W\.: My name/m);
    await admin.req("PUT", "/api/admin/recordings/council-a/speakers", { names: {} });
    assert.equal((await pub.get("/media/council-a/council-a.vtt")).text, VTT);
    void app;
  });

  it("API downloads carry the names too, and the search finds a person by name", async (t) => {
    const { app, admin, pub } = await setup(t);
    app.syncSearch(true);
    assert.equal((await pub.get("/api/search?q=marie+watmo")).json.total, 1);                                         // the text itself says it
    assert.equal((await pub.get("/api/search?q=councillor+o%27brien")).json.total, 0);
    await admin.req("PUT", "/api/admin/recordings/council-a/speakers", { names: { "Speaker 2": "Councillor O'Brien" } });   // re-indexes by itself
    const r = (await pub.get("/api/search?q=o%27brien")).json;
    assert.deepEqual([r.total, r.hits[0].speaker], [1, "Councillor O'Brien"]);                                       // found by who said it
    await admin.req("PUT", "/api/admin/recordings/council-a/speakers", { names: {} });
    assert.equal((await pub.get("/api/search?q=o%27brien")).json.total, 0);
    // A token download of the transcript is renamed as well.
    await admin.req("PUT", "/api/admin/recordings/council-a/speakers", { names: { "Speaker 1": "Marie Watmo" } });
    const tok = (await admin.post("/api/account/tokens", { label: "t" })).json.token;
    const dl = await new Client(pub.base).req("GET", "/api/v1/meetings/council-a/files/council-a.txt", undefined, { authorization: `Bearer ${tok}` });
    assert.match(dl.text, /^\[00:00:00\] Marie Watmo:$/m);
    assert.equal(dl.headers.get("content-disposition"), 'attachment; filename="council-a.txt"');
  });

  it("gating and validation: admin only, real labels only, tidy values", async (t) => {
    const { reader, pub, admin, d } = await setup(t);
    const url = "/api/admin/recordings/council-a/speakers";
    assert.equal((await pub.get(url)).status, 401);
    assert.equal((await reader.get(url)).status, 403);
    assert.equal((await reader.req("PUT", url, { names: { "Speaker 1": "X" } })).status, 403);
    assert.equal((await admin.req("PUT", url, { names: { "Speaker 1": "X" } }, { origin: "https://evil.example" })).status, 403);
    for (const [body, re] of [[{ names: { "Speaker 9": "X" } }, /isn't a speaker/], [{ names: { "Speaker 1": "<b>" } }, /can't contain/], [{ names: [] }, /must be an object/], [{}, /must be an object/]] as [object, RegExp][]) {
      const r = await admin.req("PUT", url, body);
      assert.deepEqual([r.status, re.test(r.json.error)], [400, true], JSON.stringify(body));
    }
    assert.equal(existsSync(path.join(d, "speaker-names.json")), false);                                              // nothing was written
    assert.equal((await admin.get("/api/admin/recordings/orphan-nothing/speakers")).status, 404);
    assert.equal((await admin.get("/api/admin/recordings/failed-d/speakers")).status, 404);                           // no transcript
    assert.equal((await admin.get("/api/admin/recordings/..%2Fx/speakers")).status, 404);
  });

  it("the player says some names were added by hand", () => {
    assert.match(readFileSync("src/pages/common.ts", "utf8"), /t\.names_applied \? " Some speaker names were added by hand\."/);
  });
});
