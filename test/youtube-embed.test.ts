/**
 * A meeting whose video is on YouTube: the page embeds it, we keep only the sound (never public) for the transcript and
 * delete it once the transcript is done.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, it, type TestContext } from "node:test";
import { chromium } from "playwright";
import { openDb } from "../src/db.js";
import { Meetings } from "../src/meetings.js";
import { deleteAudio } from "../src/parts.js";
import { embedOf } from "../src/site.js";
import { tmpDir, type HasAfter } from "./helpers.js";
import { Client, startApp } from "./server.js";

const YT = "https://www.youtube.com/watch?v=Y_YczaGqniY";

async function seeded(t: TestContext, o: { link?: string; transcript?: boolean } = {}) {
  const cleanups: (() => unknown)[] = [];
  t.after(async () => { for (const f of cleanups.reverse()) await f(); });
  const hooks: HasAfter = { after: (fn) => cleanups.push(fn) };
  const out = path.join(tmpDir(hooks), "rec");
  mkdirSync(out, { recursive: true });
  const db = openDb(path.join(out, "minutes.db"));
  const start = new Date(Date.now() - 3 * 86_400_000).toISOString();
  const m = new Meetings(db).create({ title: "Council", platform: "youtube", link: o.link ?? YT, start, slug: "council-yt" });
  db.prepare(`INSERT INTO jobs (id, meeting_id, link, start, slug, name, status, created_at, ended_at, outcome) VALUES ('j1', ?, ?, ?, 'council-yt', 'Recorder', 'done', ?, ?, 'ended')`)
    .run(m.id, o.link ?? YT, start, start, start);
  db.close();
  const dir = path.join(out, "council-yt");
  mkdirSync(path.join(dir, ".live"), { recursive: true });
  writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ slug: "council-yt", link: YT, scheduledStart: start, outcome: "ended", audioOnly: true,
    parts: [{ index: 1, file: "part_001.mkv", started: start, ended: start }], offsets: [{ part: 1, at: 0, dur: 600 }], output: "council-yt.mp4" }));
  writeFileSync(path.join(dir, "council-yt.mp4"), "sound");
  writeFileSync(path.join(dir, "part_001.mkv"), "sound");
  writeFileSync(path.join(dir, ".live", "state.json"), "{}");
  if (o.transcript !== false) {
    writeFileSync(path.join(dir, "council-yt.transcript.json"), JSON.stringify({ segments: [{ start: 1, text: "Call to order.", label: "Speaker 1" }] }));
    writeFileSync(path.join(dir, "council-yt.vtt"), "WEBVTT\n");
    writeFileSync(path.join(dir, "transcript.status.json"), JSON.stringify({ status: "done", finished: start, updated: start }));
  }
  const { app, base } = await startApp(hooks, out, { pollFeeds: false });
  return { app, c: new Client(base), out, dir };
}

describe("YouTube meetings: embedded video, sound kept only for the transcript", () => {
  it("which links are embedded", () => {
    const m = (o: object) => ({ link: "", status: "scheduled", ...o }) as Parameters<typeof embedOf>[0];
    assert.deepEqual(embedOf(m({ link: YT })), { provider: "youtube", id: "Y_YczaGqniY" });
    assert.deepEqual(embedOf(m({ link: "https://zoom.us/j/87093163922", streamUrl: "https://youtu.be/abcdefghijk" })), { provider: "youtube", id: "abcdefghijk" });
    assert.equal(embedOf(m({ link: "https://zoom.us/j/87093163922", streamUrl: "https://city.example/video" })), null);
    assert.equal(embedOf(m({ link: YT, status: "cancelled" })), null);
  });

  it("the public sees an embed and the transcript, never the sound", async (t) => {
    const { c } = await seeded(t);
    const m = (await c.get("/api/meetings/council-yt")).json;
    assert.deepEqual(m.embed, { provider: "youtube", id: "Y_YczaGqniY" });
    assert.equal(m.stage, "ready");
    assert.equal(m.hasVideo, true);
    assert.equal(m.recording.video, null);
    assert.equal(m.recording.videoBytes, null);
    assert.equal(m.recording.files.transcript, "council-yt.transcript.json");
    assert.doesNotMatch(JSON.stringify(m), /council-yt\.mp4|part_001/);
    assert.equal((await c.req("GET", "/media/council-yt/council-yt.mp4")).status, 404, "the sound is not served");
    assert.equal((await c.req("GET", "/media/council-yt/part_001.mkv")).status, 404);
    assert.equal((await c.req("GET", "/media/council-yt/council-yt.transcript.json")).status, 200);
    // The page may frame YouTube's player, and only the pages that show a video may.
    const page = await c.req("GET", "/m/council-yt");
    assert.match(page.headers.get("content-security-policy") ?? "", /frame-src https:\/\/www\.youtube-nocookie\.com/);
    assert.doesNotMatch((await c.req("GET", "/")).headers.get("content-security-policy") ?? "", /frame-src/);
    assert.match((await c.req("GET", "/embed/council-yt")).headers.get("content-security-policy") ?? "", /frame-src https:\/\/www\.youtube-nocookie\.com/);
    assert.match(page.text, /embedUrl.*youtube\.com\/embed\/Y_YczaGqniY/);
    assert.doesNotMatch(page.text, /contentUrl/);
  });

  it("the sound is deleted once the transcript is done, and the meeting stays ready with its transcript", async (t) => {
    const { app, c, out, dir } = await seeded(t);
    assert.equal(deleteAudio({ out, slug: "council-yt", days: 7 }), null, "the transcript finished 3 days ago: kept until 7 days, if asked to");
    assert.equal(existsSync(path.join(dir, "council-yt.mp4")), true);
    const freed = deleteAudio({ out, slug: "council-yt", days: 0 });
    assert.ok(freed !== null && freed > 0);
    for (const f of ["council-yt.mp4", "part_001.mkv", ".live"]) assert.equal(existsSync(path.join(dir, f)), false, f);
    assert.equal(existsSync(path.join(dir, "audio.deleted")), true);
    assert.equal(existsSync(path.join(dir, "council-yt.transcript.json")), true);
    assert.equal(deleteAudio({ out, slug: "council-yt", days: 0 }), null, "only once");
    const m = (await c.get("/api/meetings/council-yt")).json;
    assert.equal(m.stage, "ready", "not 'failed' because the sound is gone");
    assert.equal(m.recording.files.transcript, "council-yt.transcript.json");
    await app.accounts.create({ email: "a@example.com", role: "admin", password: "admin password 1" });
    const admin = new Client(c.base);
    await admin.login("a@example.com", "admin password 1");
    const again = await admin.post("/api/admin/recordings/council-yt/retranscribe");
    assert.equal(again.status, 409);
    assert.match(again.json.error, /deleted/);
  });

  it("the sound stays while there is no finished transcript", async (t) => {
    const { out, dir } = await seeded(t, { transcript: false });
    assert.equal(deleteAudio({ out, slug: "council-yt", days: 0 }), null);
    assert.equal(existsSync(path.join(dir, "council-yt.mp4")), true);
  });

  it("a recording with its picture (not sound only) is untouched and still played from here", async (t) => {
    const { out, dir, c } = await seeded(t);
    writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ slug: "council-yt", scheduledStart: new Date().toISOString(), outcome: "ended",
      parts: [], offsets: [{ part: 1, at: 0, dur: 600 }], output: "council-yt.mp4" }));
    assert.equal(deleteAudio({ out, slug: "council-yt", days: 0 }), null);
    const m = (await c.get("/api/meetings/council-yt")).json;
    assert.equal(m.recording.video, "council-yt.mp4");
    assert.equal((await c.req("GET", "/media/council-yt/council-yt.mp4")).status, 200);
  });
});

// A stand-in for YouTube's player page: it answers the same messages (listening, seekTo) the way the real one reports them.
const FAKE_PLAYER = `<!doctype html><script>
var t = 1.2;
function report() { parent.postMessage(JSON.stringify({ event: "infoDelivery", info: { currentTime: t, playerState: 1 } }), "*"); }
window.addEventListener("message", function (e) {
  var d; try { d = JSON.parse(e.data); } catch (x) { return; }
  if (d.event === "listening") setInterval(report, 200);   // the real one reports several times a second while it is listening
  if (d.event === "command" && d.func === "seekTo") { t = d.args[0]; report(); }
});
</script>`;

describe("YouTube meetings in Chromium", { skip: existsSync(chromium.executablePath()) ? false : "Playwright Chromium not installed" }, () => {
  it("the page embeds YouTube's player, and the transcript follows it and seeks it", async (t) => {
    const { dir, c } = await seeded(t);
    writeFileSync(path.join(dir, "council-yt.transcript.json"), JSON.stringify({ segments: [
      { start: 1, text: "Call to order.", label: "Speaker 1" }, { start: 60, text: "Item two.", label: "Speaker 2" }] }));
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const page = await (await browser.newContext()).newPage();
    const asked: string[] = [];
    await page.route("https://www.youtube-nocookie.com/**", (route) => { asked.push(route.request().url()); return route.fulfill({ contentType: "text/html", body: FAKE_PLAYER }); });
    await page.goto(c.base + "/m/council-yt");
    await page.waitForSelector("#player iframe.ytframe");
    assert.match(await page.getAttribute("#player iframe", "src") ?? "", /^https:\/\/www\.youtube-nocookie\.com\/embed\/Y_YczaGqniY\?enablejsapi=1/);
    assert.equal(await page.isVisible("#player video"), false, "no player of ours");
    assert.match(await page.textContent("#player .links") ?? "", /Watch on YouTube/);
    await page.waitForSelector(".tline");
    // The player reported 1.2 s: the first line is the current one.
    await page.waitForSelector(".tline.now:has-text('Call to order')");
    // Clicking a line asks the player to seek, and the player's report moves the highlight.
    await page.click(".tline:has-text('Item two')");
    await page.waitForSelector(".tline.now:has-text('Item two')");
    assert.ok(asked.length >= 1);
    // The banner doesn't claim a recording or a failure.
    assert.doesNotMatch(await page.textContent("#head") ?? "", /couldn't be recorded|wasn't recorded|Processing the video/);
    // The page's CSP let the frame load: no violations were needed beyond YouTube's player.
    await page.goto(c.base + "/embed/council-yt?transcript=1");
    await page.waitForSelector("#box iframe.ytframe");
    await page.waitForSelector(".tline");
  });
});

