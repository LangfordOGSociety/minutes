/**
 * #6: what the public can see and fetch, vs the admin; headers, proxies,
 * request caps. The real server on a random port, recordings as folders.
 */
import assert from "node:assert/strict";
import type http from "node:http";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { Proxies, pageCsp } from "../src/net.js";
import type { App } from "../src/serve.js";
import { tmpDir, type HasAfter } from "./helpers.js";
import { Client, startApp } from "./server.js";
import { fixtures } from "./fixtures.js";

describe("public vs admin", () => {
  let app: App, base: string, out: string, admin: Client;
  const cleanups: (() => unknown)[] = [];
  before(async () => {
    const hooks: HasAfter = { after: (fn) => cleanups.push(fn) };
    out = path.join(tmpDir(hooks), "rec");
    ({ app, base } = await startApp(hooks, out));
    fixtures(app, out);
    await app.accounts.create({ email: "admin@example.com", role: "admin", password: "admin password" });
    admin = new Client(base);
    assert.equal((await admin.login("admin@example.com", "admin password")).status, 200);
  });
  after(async () => { for (const f of cleanups.reverse()) await f(); });

  it("lists only published recordings, with public fields only", async () => {
    const r = await new Client(base).get("/api/recordings");
    assert.deepEqual(r.json.map((x: { slug: string }) => x.slug).sort(), ["council-a", "live-e"]);
    const a = r.json.find((x: { slug: string }) => x.slug === "council-a");
    assert.deepEqual(Object.keys(a).sort(), ["active", "chapters", "duration", "files", "scheduledStart", "slug", "title", "transcript", "video", "videoBytes"]);
    assert.equal(a.duration, 2760);
    assert.deepEqual(Object.keys(a.files).sort(), ["srt", "transcript", "txt", "vtt", "zoomCaptions"]);
    assert.equal(r.json.find((x: { slug: string }) => x.slug === "live-e").files.live, "live.json");
    assert.doesNotMatch(r.text, /pwd|429539|87093163922|blocked|capture\.log/);
    // The deploy guard's status: counts and a time, nothing that names a meeting.
    const st = await new Client(base).get("/api/status?within=2000");
    assert.deepEqual(Object.keys(st.json).sort(), ["busy", "nextStart", "running"]);
    assert.equal(st.json.busy, true);   // live-e is scheduled within the window
    assert.doesNotMatch(st.text, /live-e|council|zoom/);
  });

  it("serves only a published recording's public files", async () => {
    const c = new Client(base);
    for (const f of ["council-a.mp4", "council-a.vtt", "council-a.srt", "council-a.txt", "council-a.transcript.json", "council-a.zoom-captions.vtt"]) {
      assert.equal((await c.get(`/media/council-a/${f}`)).status, 200, f);
    }
    assert.equal((await c.get("/media/live-e/live.json")).status, 200);
    for (const p of ["council-a/manifest.json", "council-a/part_001.mkv", "council-a/capture.log", "council-a/council-a.speakers.json",
                     "council-a/transcript.status.json", "hidden-b/hidden-b.mp4", "orphan-c/orphan-c.mp4", "failed-d/manifest.json",
                     "live-e/manifest.json", "..%2Fminutes.db/x.mp4", "council-a/..%2F..%2Fminutes.db"]) {
      assert.equal((await c.get(`/media/${p}`)).status, 404, p);
    }
    // Signed in as admin, /media is still only the public files.
    assert.equal((await admin.get("/media/council-a/manifest.json")).status, 404);
  });

  it("the admin sees and fetches everything, the public none of it", async () => {
    const all = await admin.get("/api/admin/recordings");
    assert.deepEqual(all.json.map((x: { slug: string; public: boolean }) => x.slug + ":" + x.public).sort(),
      ["council-a:true", "failed-d:false", "hidden-b:false", "live-e:true", "orphan-c:false"]);
    for (const p of ["council-a/manifest.json", "hidden-b/hidden-b.mp4", "orphan-c/part_001.mkv"]) {
      assert.equal((await admin.get(`/admin/media/${p}`)).status, 200, p);
      assert.equal((await new Client(base).get(`/admin/media/${p}`)).status, 401, p);
    }
    assert.equal((await admin.get("/admin/media/council-a/capture.log")).status, 404);   // not a media type
    for (const p of ["/api/admin/jobs", "/api/admin/session", "/api/admin/info", "/api/admin/recordings"]) {
      assert.equal((await new Client(base).get(p)).status, 401, p);
    }
    // Old paths are gone.
    assert.equal((await admin.get("/api/jobs")).status, 404);
    assert.equal((await admin.get("/api/session")).status, 404);
  });

  it("the public page carries none of the admin page", async () => {
    const pub = (await new Client(base).get("/")).text;
    assert.doesNotMatch(pub, /api\/admin|\/jobs|screen|session\/check|Schedule a meeting/);
    assert.match((await admin.get("/admin")).text, /Schedule a meeting/);
  });

  it("security headers and a hash-only script CSP on every page", async () => {
    for (const p of ["/", "/login", "/admin"]) {
      const r = await admin.get(p);
      assert.equal(r.status, 200, p);
      assert.equal(r.headers.get("x-frame-options"), "DENY");
      assert.equal(r.headers.get("x-content-type-options"), "nosniff");
      assert.equal(r.headers.get("referrer-policy"), "same-origin");
      assert.match(r.headers.get("permissions-policy") ?? "", /microphone=\(\)/);
      const csp = r.headers.get("content-security-policy") ?? "";
      assert.match(csp, /script-src 'sha256-[A-Za-z0-9+/=]{44}'(;|$)/, p);
      assert.match(csp, /frame-ancestors 'none'/);
      assert.equal(csp, pageCsp(r.text));
      assert.equal(r.headers.get("strict-transport-security"), null);   // plain http, no trusted proxy
    }
    assert.equal((await new Client(base).get("/api/recordings")).headers.get("x-frame-options"), "DENY");
  });

  it("caps URL and body size, refuses bad encodings", async () => {
    const c = new Client(base);
    assert.equal((await c.get("/media/" + "a".repeat(3000))).status, 414);
    assert.equal((await c.get("/media/%zz/x.mp4")).status, 400);
    assert.equal((await c.post("/api/login", { email: "x@example.com", password: "p".repeat(20_000) })).status, 413);
    assert.equal((await c.req("POST", "/api/login", undefined, { "content-type": "text/plain" })).status, 415);
  });
});

describe("trusted proxies", () => {
  it("parse addresses and CIDRs, refuse garbage", () => {
    const p = new Proxies("10.42.0.0/16, 127.0.0.1, fd00::/8");
    assert.equal(p.size, 3);
    assert.equal(p.trusted("10.42.7.1"), true);
    assert.equal(p.trusted("::ffff:10.42.7.1"), true);
    assert.equal(p.trusted("10.43.0.1"), false);
    assert.equal(p.trusted("fd12::1"), true);
    assert.throws(() => new Proxies("10.0.0.0/33"), /bad prefix/);
    assert.throws(() => new Proxies("traefik"), /not an address/);
    assert.equal(new Proxies(undefined).size, 0);
  });

  const req = (remote: string, xff?: string, proto?: string) => ({
    socket: { remoteAddress: remote }, headers: { ...(xff ? { "x-forwarded-for": xff } : {}), ...(proto ? { "x-forwarded-proto": proto } : {}) },
  }) as unknown as http.IncomingMessage;

  it("believe X-Forwarded-For only from a trusted proxy, rightmost untrusted hop wins", () => {
    const p = new Proxies("10.42.0.0/16");
    assert.equal(p.clientIp(req("203.0.113.9", "1.1.1.1")), "203.0.113.9");                 // not from our proxy
    assert.equal(p.clientIp(req("10.42.0.5", "203.0.113.9")), "203.0.113.9");
    assert.equal(p.clientIp(req("10.42.0.5", "1.1.1.1, 203.0.113.9")), "203.0.113.9");      // client-sent 1.1.1.1 ignored
    assert.equal(p.clientIp(req("10.42.0.5", "203.0.113.9, 10.42.0.9")), "203.0.113.9");    // two proxies
    assert.equal(p.clientIp(req("10.42.0.5", "not-an-ip")), "10.42.0.5");
    assert.equal(p.clientIp(req("10.42.0.5")), "10.42.0.5");
    assert.equal(p.https(req("10.42.0.5", undefined, "https")), true);
    assert.equal(p.https(req("203.0.113.9", undefined, "https")), false);
  });

  it("sign-in limits follow the real client behind the proxy, and can't be dodged by spoofing", async (t) => {
    // Last registered, first run: servers close before their folders go.
    const cleanups: (() => unknown)[] = [];
    t.after(async () => { for (const f of cleanups.reverse()) await f(); });
    const hooks: HasAfter = { after: (fn) => cleanups.push(fn) };
    const { base } = await startApp(hooks, path.join(tmpDir(hooks), "rec"), { trustedProxies: "127.0.0.1" });
    const as = (ip: string) => new Client(base).req("POST", "/api/login", { email: `${Math.random()}@example.com`, password: "x" }, { "x-forwarded-for": ip });
    for (let i = 0; i < 30; i++) assert.equal((await as("203.0.113.9")).status, 401);
    assert.equal((await as("203.0.113.9")).status, 429);
    assert.equal((await as("198.51.100.7")).status, 401);   // someone else behind the same proxy
    // Over https (per the proxy), HSTS is sent.
    const r = await new Client(base).req("GET", "/", undefined, { "x-forwarded-proto": "https" });
    assert.equal(r.headers.get("strict-transport-security"), "max-age=15552000");

    const direct = await startApp(hooks, path.join(tmpDir(hooks), "rec2"));   // no trusted proxies
    const spoof = (ip: string) => new Client(direct.base).req("POST", "/api/login", { email: `${Math.random()}@example.com`, password: "x" }, { "x-forwarded-for": ip });
    for (let i = 0; i < 30; i++) assert.equal((await spoof(`198.51.100.${i}`)).status, 401);
    assert.equal((await spoof("198.51.100.200")).status, 429);
  });
});
