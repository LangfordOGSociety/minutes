/**
 * Being found: robots.txt, sitemap.xml, structured data and poster images.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, it, type TestContext } from "node:test";
import { Thumbs, frameAt, makeThumb } from "../src/thumbs.js";
import { need, tmpDir, type HasAfter } from "./helpers.js";
import { fakeSource, fixtures } from "./fixtures.js";
import { Client, startApp } from "./server.js";

const ffmpeg = need("ffmpeg");
const at = (h: number) => new Date(Math.round((Date.now() + h * 3_600_000) / 60_000) * 60_000).toISOString();

function video(file: string, seconds = 8) {
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", `testsrc2=size=640x360:rate=10:duration=${seconds}`, "-pix_fmt", "yuv420p", "-c:v", "libx264", "-preset", "ultrafast", file]);
}

async function setup(t: TestContext, extra: Record<string, unknown> = {}) {
  const cleanups: (() => unknown)[] = [];
  t.after(async () => { for (const f of cleanups.reverse()) await f(); });
  const hooks: HasAfter = { after: (fn) => cleanups.push(fn) };
  const out = path.join(tmpDir(hooks), "rec");
  const { app, base } = await startApp(hooks, out, extra);
  fixtures(app, out);
  return { app, base, out, pub: new Client(base), hooks };
}

describe("robots.txt and sitemap.xml", () => {
  it("keep crawlers off the admin, the API and embeds; list the public meetings, not hidden ones", async (t) => {
    const { pub, base } = await setup(t);
    const robots = await pub.get("/robots.txt");
    assert.equal(robots.status, 200);
    assert.match(robots.headers.get("content-type") ?? "", /^text\/plain/);
    for (const line of ["User-agent: *", "Disallow: /admin", "Disallow: /api/", "Allow: /api/docs", "Disallow: /login", "Disallow: /embed/", `Sitemap: ${base}/sitemap.xml`]) assert.ok(robots.text.split("\n").includes(line), line);
    const sm = await pub.get("/sitemap.xml");
    assert.equal(sm.status, 200);
    assert.match(sm.headers.get("content-type") ?? "", /^application\/xml/);
    assert.match(sm.text, /^<\?xml version="1.0" encoding="UTF-8"\?>\n<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">/);
    const locs = [...sm.text.matchAll(/<loc>([^<]*)<\/loc>/g)].map((m) => m[1]);
    assert.ok(locs.includes(`${base}/`) && locs.includes(`${base}/search`) && locs.includes(`${base}/api/docs`));
    assert.ok(locs.includes(`${base}/m/council-a`) && locs.includes(`${base}/m/live-e`));
    assert.ok(!locs.some((l) => /hidden-b|orphan-c/.test(l)), locs.join("\n"));
    assert.match(sm.text, /<loc>[^<]*\/m\/council-a<\/loc><lastmod>\d{4}-\d\d-\d\dT[^<]*Z<\/lastmod>/);
  });

  it("use PUBLIC_URL when set (and the sitemap needs an address to be absolute)", async (t) => {
    const { pub } = await setup(t, { publicUrl: "https://minutes.example.org/" });
    assert.match((await pub.get("/robots.txt")).text, /^Sitemap: https:\/\/minutes\.example\.org\/sitemap\.xml$/m);
    assert.match((await pub.get("/sitemap.xml")).text, /<loc>https:\/\/minutes\.example\.org\/m\/council-a<\/loc>/);
    assert.doesNotMatch((await pub.get("/sitemap.xml")).text, /127\.0\.0\.1/);
  });
});

describe("structured data on a meeting's page", () => {
  const ld = (html: string) => {
    const m = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html);
    return m ? JSON.parse(m[1]) as Record<string, any> : null;
  };

  it("a recording is a VideoObject; an upcoming or cancelled meeting is an Event", async (t) => {
    const { app, pub, base } = await setup(t);
    const v = ld((await pub.get("/m/council-a")).text)!;
    assert.deepEqual([v["@context"], v["@type"], v.name, v.duration, v.embedUrl, v.contentUrl, v.inLanguage],
      ["https://schema.org", "VideoObject", "council-a", "PT46M0S", `${base}/embed/council-a`, `${base}/media/council-a/council-a.mp4`, "en"]);
    assert.ok(!("thumbnailUrl" in v), "no poster image yet, so none is claimed");
    assert.match(v.uploadDate, /^\d{4}-\d\d-\d\dT/);
    const e = ld((await pub.get("/m/failed-d")).text)!;
    assert.deepEqual([e["@type"], e.eventStatus, e.eventAttendanceMode, e.location, e.url], ["Event", "https://schema.org/EventScheduled", "https://schema.org/OnlineEventAttendanceMode",
      { "@type": "VirtualLocation", url: `${base}/m/failed-d` }, `${base}/m/failed-d`]);
    // Cancelled.
    const m = app.sched.meetings.get(app.sched.list().find((j) => j.slug === "live-e")!.meetingRef)!;
    m.status = "cancelled"; app.sched.meetings.save(m);
    assert.equal(ld((await pub.get("/m/live-e")).text)!.eventStatus, "https://schema.org/EventCancelled");
  });

  it("a hostile title can't close the script block", async (t) => {
    const cleanups: (() => unknown)[] = [];
    t.after(async () => { for (const f of cleanups.reverse()) await f(); });
    const hooks: HasAfter = { after: (fn) => cleanups.push(fn) };
    const src = await fakeSource(hooks);
    const { app, base } = await startApp(hooks, path.join(tmpDir(hooks), "rec"), { pollFeeds: false });
    await app.accounts.create({ email: "admin@example.com", role: "admin", password: "admin password 1" });
    const admin = new Client(base);
    await admin.login("admin@example.com", "admin password 1");
    const feed = (await admin.post("/api/admin/feeds", { name: "F", parser: "test-json", config: { url: src.url }, slugPrefix: "x", policy: "auto" })).json;
    src.state.meetings = [{ id: "1", title: '</script><script>alert(1)</script> "quoted" & <b>', start: at(24) }];
    await admin.post(`/api/admin/feeds/${feed.id}/run`);
    const slug = (await admin.get("/api/admin/meetings")).json[0].slug;
    const html = (await new Client(base).get(`/m/${slug}`)).text;
    assert.doesNotMatch(html, /<script>alert\(1\)|<\/script><script>alert/);
    assert.equal(ld(html)!.name, '</script><script>alert(1)</script> "quoted" & <b>');   // the data is intact, only the markup is safe
  });
});

describe("poster images", { skip: ffmpeg }, () => {
  it("frameAt: a little in, never past the middle", () => {
    assert.equal(frameAt(null), 5);
    assert.equal(frameAt(0), 5);
    assert.equal(frameAt(2760), 60);
    assert.equal(frameAt(100), 5);
    assert.equal(frameAt(1), 0.5 > 1 ? 1 : 1);
    assert.ok(frameAt(1.5) <= 0.75 + 1e-9 || frameAt(1.5) === 1);
  });

  it("makeThumb writes a JPEG of the video; a bad file fails cleanly and leaves nothing behind", async (t) => {
    const dir = tmpDir(t);
    const mp4 = path.join(dir, "a.mp4");
    video(mp4);
    const dest = path.join(dir, "a.jpg");
    assert.equal(await makeThumb(mp4, dest, 8), true);
    const jpg = readFileSync(dest);
    assert.deepEqual([jpg[0], jpg[1]], [0xff, 0xd8]);
    assert.ok(jpg.length > 1000);
    assert.match(execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=width,height", "-of", "csv=p=0", dest]).toString(), /640,360/);
    const bad = path.join(dir, "bad.mp4");
    writeFileSync(bad, "not a video");
    assert.equal(await makeThumb(bad, path.join(dir, "bad.jpg"), null), false);
    assert.equal(existsSync(path.join(dir, "bad.jpg")), false);
    assert.equal(existsSync(path.join(dir, "bad.jpg.tmp.jpg")), false);
    assert.equal(await makeThumb(path.join(dir, "missing.mp4"), path.join(dir, "m.jpg"), null), false);
  });

  it("Thumbs makes the missing ones, remembers a failure for an hour, and never runs twice at once", async (t) => {
    const dir = tmpDir(t);
    const good = path.join(dir, "good.mp4"), bad = path.join(dir, "bad.mp4");
    video(good); writeFileSync(bad, "nope");
    const todo = [{ slug: "bad", video: bad, dest: path.join(dir, "bad.jpg"), duration: null }, { slug: "good", video: good, dest: path.join(dir, "good.jpg"), duration: 8 }];
    const th = new Thumbs();
    const [first, concurrent] = await Promise.all([th.run(todo, 1_000), th.run(todo, 1_000)]);
    assert.deepEqual([first, concurrent], [1, 0]);
    assert.ok(existsSync(path.join(dir, "good.jpg")) && !existsSync(path.join(dir, "bad.jpg")));
    writeFileSync(bad, "still nope");
    assert.equal(await th.run([todo[0]], 1_000 + 60_000), 0);                      // within the hour: not retried
    video(bad);
    assert.equal(await th.run([todo[0]], 1_000 + 3_700_000), 1);                   // after: tried again
  });

  it("through the server: a recording gets a poster; it's the player's poster, the preview image and in the files list", async (t) => {
    const { app, out, pub, base } = await setup(t, { publicUrl: "https://minutes.example.org" });
    video(path.join(out, "council-a", "council-a.mp4"), 12);
    assert.equal((await pub.get("/api/meetings/council-a")).json.recording.files.thumb, undefined);
    assert.equal(await app.syncThumbs(), 1);
    const d = (await pub.get("/api/meetings/council-a")).json;
    assert.equal(d.recording.files.thumb, "council-a.jpg");
    const img = await fetch(`${base}/media/council-a/council-a.jpg`);
    assert.deepEqual([img.status, img.headers.get("content-type"), (await img.arrayBuffer()).byteLength > 1000], [200, "image/jpeg", true]);
    const html = (await pub.get("/m/council-a")).text;
    assert.match(html, /<meta property="og:image" content="https:\/\/minutes\.example\.org\/media\/council-a\/council-a\.jpg">/);
    assert.match(html, /<meta name="twitter:card" content="summary_large_image">/);
    const v = JSON.parse(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html)![1]);
    assert.equal(v.thumbnailUrl, "https://minutes.example.org/media/council-a/council-a.jpg");
    assert.ok((await pub.get("/api/v1/meetings/council-a/files")).json.some((f: { kind: string; name: string }) => f.kind === "thumbnail" && f.name === "council-a.jpg"));
    // The meeting list carries it too (the cards show it); hidden and failed ones have none.
    const list = (await pub.get("/api/meetings?scope=past&limit=50")).json.meetings as { id: string; poster: string | null }[];
    assert.equal(list.find((m) => m.id === "council-a")!.poster, "/media/council-a/council-a.jpg");
    assert.equal((await pub.get("/api/v1/meetings/council-a")).json.poster, "/media/council-a/council-a.jpg");
    assert.equal((await pub.get("/api/meetings?scope=upcoming")).json.meetings.every((m: { poster: unknown }) => m.poster === null), true);
    assert.equal(await app.syncThumbs(), 0);                                         // nothing left to do
    // Hidden or unpublished recordings' posters aren't public either.
    assert.equal((await pub.get("/media/hidden-b/hidden-b.jpg")).status, 404);
    // The player uses it as its poster.
    assert.match(readFileSync("src/pages/common.ts", "utf8"), /poster: f\.thumb \? mediaUrl\(base, r\.slug, f\.thumb\) : null/);
  });
});
