/**
 * Agenda-aware transcription: names from the agenda become the transcriber's
 * extra vocabulary. The extraction, the file the transcriber reads, what
 * the server will fetch, the hooks, and the Python side.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, it, type TestContext } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { agendaTerms, agendaTermsFromHtml, fetchAgenda, hasVocabExtra, isPublicAddress, prepareVocab, writeVocabExtra } from "../src/agendavocab.js";
import { fixtures } from "./fixtures.js";
import { need, tmpDir, type HasAfter } from "./helpers.js";
import { Client, startApp } from "./server.js";

const AGENDA = `Delegation: Marie Watmough, Executive Director of Bear Mountain Resort, addresses Council about the Walfred Road rezoning.
Councillor Harder moved that Council receive the report from Kiedyk. Councillor Harder asked about Goldstream Heights and Goldstream Heights again.
The Songhees Nation and Mayor Goodmanson thanked Marie Watmough. Staff Report - Jane Doe (Planner) on 123 Main Street.
20261124 - Council Minutes.pdf  Join at Zoom.us  1. CALL TO ORDER 2. APPROVAL OF THE AGENDA 3. PUBLIC PARTICIPATION`;

describe("terms from an agenda", () => {
  it("names and places, best first; boilerplate, titles, headings and file names left out", () => {
    const t = agendaTerms(AGENDA);
    for (const want of ["Marie Watmough", "Walfred Road", "Bear Mountain Resort", "Goldstream Heights", "Songhees Nation", "Main Street", "Harder", "Goodmanson"]) assert.ok(t.includes(want), `${want} in ${t.join(" | ")}`);
    for (const never of ["Council", "Councillor", "Mayor", "Delegation", "Staff", "Report", "Zoom.us", "Minutes.pdf", "CALL", "ORDER", "Planner", "Executive"]) assert.ok(!t.some((x) => x.split(" ").includes(never) || x === never), `${never} in ${t.join(" | ")}`);
    assert.ok(!t.some((x) => /\.(pdf|us)/i.test(x)));
    assert.deepEqual(agendaTerms(""), []);
    assert.deepEqual(agendaTerms("THE COUNCIL WILL MEET. CALL TO ORDER. ADJOURNMENT."), []);                    // headings aren't names
  });

  it("a lone capitalized word needs evidence; a name already inside a longer one isn't repeated; the list is capped", () => {
    assert.ok(!agendaTerms("Proposed amendments. Proposed changes. Proposed dates.").includes("Proposed"));        // an ordinary word, even repeated
    assert.ok(agendaTerms("We heard from Olytska. Then Olytska again, and Olytska.").includes("Olytska"));          // a rare word seen in running text
    assert.ok(agendaTerms("Councillor Wagner spoke.").includes("Wagner"));                                           // after a title
    const t = agendaTerms("Bear Mountain Resort opened. Bear Mountain Resort closed. Mountain talk about Bear Mountain Resort.");
    assert.deepEqual(t.filter((x) => /Bear|Mountain/.test(x)), ["Bear Mountain Resort"]);
    const many = Array.from({ length: 60 }, (_, i) => `We met ${String.fromCharCode(65 + (i % 26))}ookland${"x".repeat(i % 7)}${i} Hollow Road near ${String.fromCharCode(65 + ((i * 3) % 26))}ellville${i} Heights.`).join("\n");
    const capped = agendaTerms(many);
    assert.ok(capped.length <= 28 && capped.join(", ").length <= 400, `${capped.length} terms, ${capped.join(", ").length} chars`);
  });

  it("the real Langford agenda page gives few, sane terms (its text is mostly headings and file names)", () => {
    const html = readFileSync("test/fixtures/feeds/escribe/agenda-b3e00e65.html", "utf8");
    const t = agendaTermsFromHtml(html);
    assert.deepEqual(t, ["West Shore Parks"]);                                                                       // honest: this agenda page names little
    assert.ok(t.length <= 10, t.join(" | "));
    for (const junk of ["Minutes.pdf", "Zoom.us", "Video", "Window", "Join", "Dial-In Details"]) assert.ok(!t.includes(junk), junk);
  });
});

describe("the file the transcriber reads", () => {
  it("vocab_extra is merged into transcribe.json, keeping other keys; unchanged text isn't rewritten; by-hand is respected", (t) => {
    const dir = path.join(tmpDir({ after: (fn) => t.after(fn) } as HasAfter), "rec", "council");
    assert.equal(writeVocabExtra(dir, []), false);
    assert.equal(existsSync(path.join(dir, "transcribe.json")), false);
    assert.equal(writeVocabExtra(dir, ["Marie Watmough", "Walfred Road"]), true);
    assert.deepEqual(JSON.parse(readFileSync(path.join(dir, "transcribe.json"), "utf8")), { vocab_extra: "Marie Watmough, Walfred Road." });
    assert.equal(hasVocabExtra(dir), true);
    assert.equal(writeVocabExtra(dir, ["Marie Watmough", "Walfred Road"]), false);                                 // same: nothing to do
    writeFileSync(path.join(dir, "transcribe.json"), JSON.stringify({ min_speakers: 6, vocab: "langford", vocab_extra: "old." }));
    assert.equal(writeVocabExtra(dir, ["Kiedyk"]), true);
    assert.deepEqual(JSON.parse(readFileSync(path.join(dir, "transcribe.json"), "utf8")), { min_speakers: 6, vocab: "langford", vocab_extra: "Kiedyk." });
    writeFileSync(path.join(dir, "transcribe.json"), JSON.stringify({ vocab_extra: "Typed by hand.", vocab_extra_by_hand: true }));
    assert.equal(writeVocabExtra(dir, ["Kiedyk"]), false);
    assert.equal(JSON.parse(readFileSync(path.join(dir, "transcribe.json"), "utf8")).vocab_extra, "Typed by hand.");
    writeFileSync(path.join(dir, "transcribe.json"), "{broken");
    assert.equal(writeVocabExtra(dir, ["Kiedyk"]), true);                                                           // an unreadable file is replaced
  });

  it("prepareVocab reads the agenda page it's given; nothing without one", async (t) => {
    const dir = path.join(tmpDir({ after: (fn) => t.after(fn) } as HasAfter), "rec", "c1");
    assert.equal(await prepareVocab({ dir, agendaUrl: undefined }), false);
    assert.equal(await prepareVocab({ dir, agendaUrl: "https://city.example/a", fetchText: async () => null }), false);
    assert.equal(await prepareVocab({ dir, agendaUrl: "https://city.example/a", fetchText: async () => ({ type: "text/html", body: `<html><body><p>${AGENDA.replace(/\n/g, "</p><p>")}</p></body></html>` }) }), true);
    assert.match(JSON.parse(readFileSync(path.join(dir, "transcribe.json"), "utf8")).vocab_extra, /Marie Watmough/);
  });
});

describe("what the server will fetch", () => {
  it("only public addresses", () => {
    for (const ok of ["8.8.8.8", "203.0.113.9", "2606:4700::1111"]) assert.equal(isPublicAddress(ok), true, ok);
    for (const bad of ["127.0.0.1", "10.0.0.5", "192.168.1.1", "172.16.0.1", "172.31.255.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "::1", "fe80::1", "fd00::1", "::ffff:10.0.0.1", "not-an-ip"]) assert.equal(isPublicAddress(bad), false, bad);
  });

  it("refuses loopback, private, non-http and credentialed URLs without connecting", async () => {
    for (const u of ["http://127.0.0.1:1/a", "https://localhost/a", "http://10.0.0.1/a", "http://169.254.169.254/latest/meta-data", "file:///etc/passwd", "ftp://example.com/a", "https://u:p@example.com/a", "nope", ""]) {
      assert.equal(await fetchAgenda(u), null, u);
    }
  });
});

const py = need("python3");
describe("the transcriber's prompt", { skip: py }, () => {
  const run = (dir: string, extra: string = "") => execFileSync("python3", ["-I", "-c", `
import sys, os, json
os.environ["RECORDINGS"] = ${JSON.stringify(path.dirname(dir))}
sys.path.insert(0, "transcriber")
import transcribe
p, used = transcribe.vocab_for(__import__("pathlib").Path(${JSON.stringify(dir)}))
print(json.dumps({"prompt": p, "used": used}))`], { encoding: "utf8", env: { ...process.env, VOCAB_FILE: "", PYTHONPATH: "" } }).trim();

  it("appends vocab_extra after the standing vocabulary (the end of a prompt is what Whisper keeps); nothing changes without it", (t) => {
    const root = tmpDir({ after: (fn) => t.after(fn) } as HasAfter);
    const d = path.join(root, "langford-council-2026-12-08");
    mkdirSync(d, { recursive: true });
    const plain = JSON.parse(run(d));
    assert.deepEqual(plain.used, ["common.txt", "langford.txt"]);
    assert.ok(!plain.prompt.includes("Zzyzx"));
    writeFileSync(path.join(d, "transcribe.json"), JSON.stringify({ min_speakers: 4, vocab_extra: "Marie  Watmough,\nZzyzx Lane." }));
    const withExtra = JSON.parse(run(d));
    assert.deepEqual(withExtra.used, ["common.txt", "langford.txt", "agenda"]);
    assert.ok(withExtra.prompt.startsWith(plain.prompt), "the standing vocabulary comes first");
    assert.ok(withExtra.prompt.endsWith("Marie Watmough, Zzyzx Lane."), withExtra.prompt.slice(-80));              // whitespace tidied, at the end
    writeFileSync(path.join(d, "transcribe.json"), JSON.stringify({ vocab_extra: "x ".repeat(2000) }));
    assert.ok(JSON.parse(run(d)).prompt.length < plain.prompt.length + 710);                                         // capped
    writeFileSync(path.join(d, "transcribe.json"), JSON.stringify({ vocab_extra: 5 }));
    assert.deepEqual(JSON.parse(run(d)).used, ["common.txt", "langford.txt"]);                                       // not text: ignored
  });
});

describe("the hooks", () => {
  async function app(t: TestContext) {
    const cleanups: (() => unknown)[] = [];
    t.after(async () => { for (const f of cleanups.reverse()) await f(); });
    const hooks: HasAfter = { after: (fn) => cleanups.push(fn) };
    const out = path.join(tmpDir(hooks), "rec");
    const r = await startApp(hooks, out);
    fixtures(r.app, out);
    await r.app.accounts.create({ email: "admin@example.com", role: "admin", password: "admin password 1", verified: true });
    const admin = new Client(r.base);
    await admin.login("admin@example.com", "admin password 1");
    return { ...r, out, admin };
  }

  it("transcribe again takes the agenda's names again first; without an agenda it just asks", async (t) => {
    const { app: a, out, admin } = await app(t);
    const m = a.sched.meetings.get(a.sched.list().find((j) => j.slug === "council-a")!.meetingRef)!;
    m.agendaUrl = "http://127.0.0.1:9/agenda";                                                                         // refused (loopback): no names, and no harm
    a.sched.meetings.save(m);
    assert.equal((await admin.post("/api/admin/recordings/council-a/retranscribe")).status, 200);
    assert.equal(existsSync(path.join(out, "council-a", "transcribe.json")), false);
    assert.equal(existsSync(path.join(out, "council-a", "transcript.status.json")), false);
    await sleep(10);
  });
});
