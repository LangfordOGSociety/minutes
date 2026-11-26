/**
 * #36: optional download speed caps. The bucket with a fake clock, the rate
 * syntax, and real downloads through the server (global cap, per-token cap,
 * a token's own override, Range, bytes counted).
 */
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { describe, it, type TestContext } from "node:test";
import { Bucket, Throttle, parseRate } from "../src/throttle.js";
import { tmpDir, type HasAfter } from "./helpers.js";
import { fixtures } from "./fixtures.js";
import { Client, startApp } from "./server.js";

describe("rate syntax", () => {
  it("bytes per second, with k m g (x1000); empty and 0 are unlimited; nonsense is refused", () => {
    assert.deepEqual(["", undefined, null, "0", 0].map((x) => parseRate(x as never)), [0, 0, 0, 0, 0]);
    assert.deepEqual(["1500000", "1500k", "1.5m", "2g", " 20M ", "5mb", "5MB/s", 700].map((x) => parseRate(x)), [1_500_000, 1_500_000, 1_500_000, 2e9, 2e7, 5e6, 5e6, 700]);
    for (const bad of ["fast", "-5", "1.2.3", "5 gigs", "1e6"]) assert.throws(() => parseRate(bad), /bad rate/, bad);
    assert.throws(() => parseRate(-1), /bad rate/);
  });
});

describe("bucket", () => {
  const fake = () => {
    let t = 0;
    const slept: number[] = [];
    return { now: () => t, sleep: async (ms: number) => { slept.push(ms); t += ms; }, slept, at: () => t, advance: (ms: number) => { t += ms; } };
  };

  it("lets a burst through, then paces at the rate", async () => {
    const c = fake();
    const b = new Bucket(100_000, c.now, c.sleep);
    await b.take(100_000);                    // one second's worth: free
    assert.deepEqual(c.slept, []);
    await b.take(50_000);                     // now 0.5 s
    await b.take(100_000);                    // and 1 s
    assert.deepEqual(c.slept, [500, 1000]);
    c.advance(10_000);                        // idle: refills, never beyond one second's worth
    await b.take(100_000);
    await b.take(100_000);
    assert.deepEqual(c.slept, [500, 1000, 1000]);
  });

  it("small caps still move (a chunk is the least burst); callers share the rate in order", async () => {
    const c = fake();
    const small = new Bucket(1_000, c.now, c.sleep);
    await small.take(60_000);                 // within the 64 KB minimum burst
    assert.deepEqual(c.slept, []);
    const d = fake();
    const shared = new Bucket(100_000, d.now, d.sleep);
    await Promise.all([shared.take(100_000), shared.take(100_000), shared.take(100_000)]);   // three downloads at once
    assert.equal(d.at(), 2000);               // 200 KB over the free 100 KB at 100 KB/s
  });

  it("throttle: off by default, global and per-token buckets, a token's own cap wins", () => {
    assert.equal(new Throttle({}).enabled, false);
    assert.deepEqual(new Throttle({}).buckets("t1"), []);
    const t = new Throttle({ globalBps: 1000, tokenBps: 500 });
    assert.deepEqual(t.buckets("t1").map((b) => b.rate), [1000, 500]);
    assert.equal(t.buckets("t1")[1], t.buckets("t1")[1]);                 // the same bucket while downloads overlap
    assert.notEqual(t.buckets("t1")[1], t.buckets("t2")[1]);              // another token has its own
    assert.deepEqual(t.buckets("t1", 200).map((b) => b.rate), [1000, 200]);
    assert.deepEqual(new Throttle({ tokenBps: 500 }).buckets("t1", 9000).map((b) => b.rate), [9000]);
    assert.deepEqual(new Throttle({}).buckets("t1", 9000).map((b) => b.rate), [9000]);   // an override alone also applies
  });
});

async function setup(t: TestContext, extra: Record<string, unknown>) {
  const cleanups: (() => unknown)[] = [];
  t.after(async () => { for (const f of cleanups.reverse()) await f(); });
  const hooks: HasAfter = { after: (fn) => cleanups.push(fn) };
  const out = path.join(tmpDir(hooks), "rec");
  const { app, base } = await startApp(hooks, out, extra);
  fixtures(app, out);
  writeFileSync(path.join(out, "council-a", "council-a.mp4"), Buffer.alloc(400_000, 7));   // 400 KB "video"
  await app.accounts.create({ email: "admin@example.com", role: "admin", password: "admin password 1", verified: true });
  await app.accounts.create({ email: "reader@example.com", role: "user", password: "reader password 1", verified: true });
  const login = async (e: string, p: string) => { const c = new Client(base); await c.login(e, p); return c; };
  const admin = await login("admin@example.com", "admin password 1"), reader = await login("reader@example.com", "reader password 1");
  const mint = async (label = "t") => (await reader.post("/api/account/tokens", { label })).json as { token: string; record: { id: string } };
  const file = "/api/v1/meetings/council-a/files/council-a.mp4";
  const dl = async (token: string, headers: Record<string, string> = {}) => {
    const t0 = Date.now();
    const r = await fetch(base + file, { headers: { authorization: `Bearer ${token}`, ...headers } });
    const body = Buffer.from(await r.arrayBuffer());
    return { status: r.status, bytes: body.length, ms: Date.now() - t0 };
  };
  return { app, admin, reader, mint, dl };
}

describe("throttled downloads", () => {
  it("unlimited by default", async (t) => {
    const { mint, dl } = await setup(t, {});
    const r = await dl((await mint()).token);
    assert.deepEqual([r.status, r.bytes], [200, 400_000]);
    assert.ok(r.ms < 800, `${r.ms} ms`);
  });

  it("a per-token cap paces the download; Range and the byte count still hold", async (t) => {
    const { app, mint, dl } = await setup(t, { tokenDownloadBps: 200_000 });
    const { token } = await mint();
    const r = await dl(token);                         // a free burst of one second's worth (200 KB), then 200 KB/s: ~1 s
    assert.deepEqual([r.status, r.bytes], [200, 400_000]);
    assert.ok(r.ms >= 900 && r.ms < 6000, `${r.ms} ms`);
    const part = await dl(token, { range: "bytes=0-99999" });
    assert.deepEqual([part.status, part.bytes], [206, 100_000]);
    await new Promise((res) => setTimeout(res, 100));
    const rows = (app.tokens as unknown as { db: { prepare(s: string): { all(): { bytes: number; status: number }[] } } }).db.prepare("SELECT bytes, status FROM api_usage ORDER BY id").all();
    assert.deepEqual(rows.map((x) => [x.status, x.bytes]), [[200, 400_000], [206, 100_000]]);   // exactly what was sent
  });

  it("the cap is per token: two tokens at once each get the full rate", async (t) => {
    const { mint, dl } = await setup(t, { tokenDownloadBps: 200_000 });
    const [a, b] = [(await mint("a")).token, (await mint("b")).token];
    const t0 = Date.now();
    const [ra, rb] = await Promise.all([dl(a), dl(b)]);
    const total = Date.now() - t0;
    assert.deepEqual([ra.bytes, rb.bytes], [400_000, 400_000]);
    assert.ok(total < 3500, `${total} ms: not serialised`);
    assert.ok(ra.ms >= 900 && rb.ms >= 900, `${ra.ms} ${rb.ms}`);
  });

  it("a global cap is shared by every download", async (t) => {
    const { mint, dl } = await setup(t, { downloadBps: 400_000 });
    const [a, b] = [(await mint("a")).token, (await mint("b")).token];
    const t0 = Date.now();
    await Promise.all([dl(a), dl(b)]);                 // 800 KB through 400 KB/s (+ a 400 KB burst): ~1 s+
    const total = Date.now() - t0;
    assert.ok(total >= 800 && total < 6000, `${total} ms`);
  });

  it("an admin can give one token its own cap (audited); 0 goes back to the default", async (t) => {
    const { admin, reader, mint, dl } = await setup(t, {});
    const { token, record } = await mint();
    assert.equal((await dl(token)).ms < 800, true);
    const set = await admin.req("PATCH", `/api/admin/tokens/${record.id}`, { downloadBps: 200_000 });
    assert.deepEqual([set.status, set.json.downloadBps], [200, 200_000]);
    const slow = await dl(token);
    assert.ok(slow.ms >= 900, `${slow.ms} ms`);
    assert.equal((await reader.get("/api/account/tokens")).json[0].downloadBps, 200_000);             // they can see their cap
    assert.equal((await reader.req("PATCH", `/api/admin/tokens/${record.id}`, { downloadBps: 1 })).status, 403);
    for (const bad of [{}, { downloadBps: "fast" }, { downloadBps: -1 }, { downloadBps: 1.5 }]) {
      assert.equal((await admin.req("PATCH", `/api/admin/tokens/${record.id}`, bad)).status, 400, JSON.stringify(bad));
    }
    assert.equal((await admin.req("PATCH", "/api/admin/tokens/nope", { downloadBps: 1 })).status, 404);
    assert.match((await admin.get("/api/admin/audit?limit=10")).text, /token\.limit/);
    assert.equal((await admin.req("PATCH", `/api/admin/tokens/${record.id}`, { downloadBps: 0 })).json.downloadBps, null);
    assert.equal((await dl(token)).ms < 800, true);
  });
});
