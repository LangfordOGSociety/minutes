/**
 * scripts/deploy-guard.sh against the real server: a deploy must wait for
 * captures, and must not mistake an auth error for "server down".
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { describe, it } from "node:test";
import { inDays, need, tmpDir, type HasAfter } from "./helpers.js";
import { startApp } from "./server.js";

const LINK = "https://zoom.us/j/87093163922?pwd=429539";
const GUARD = path.resolve("scripts/deploy-guard.sh");

function guard(api: string): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile("bash", [GUARD, api], { env: { ...process.env, MAX_WAIT_MIN: "0", POLL_S: "1" }, timeout: 30_000 },
      (err, stdout, stderr) => resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, out: stdout + stderr }));
  });
}

async function fake(t: HasAfter, status: number, body: string): Promise<string> {
  const s = http.createServer((_, res) => { res.writeHead(status, { "content-type": "application/json" }); res.end(body); });
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => s.close(r)));
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
}

describe("deploy guard", { skip: need("jq") || need("curl") }, () => {
  it("allows a deploy when idle, waits for a capture due soon", async (t) => {
    const cleanups: (() => unknown)[] = [];
    t.after(async () => { for (const f of cleanups.reverse()) await f(); });
    const hooks: HasAfter = { after: (fn) => cleanups.push(fn) };
    const { app, base } = await startApp(hooks, path.join(tmpDir(hooks), "rec"));
    const idle = await guard(base);
    assert.equal(idle.code, 0, idle.out);
    app.sched.add({ link: LINK, start: inDays(1), slug: "tomorrow" });
    assert.equal((await guard(base)).code, 0);                         // a day away: fine
    app.sched.add({ link: LINK, start: new Date(Date.now() + 20 * 60_000).toISOString(), slug: "soon" });
    const busy = await guard(base);
    assert.equal(busy.code, 1, busy.out);
    assert.match(busy.out, /still busy/);
  });

  it("treats an answer it can't use as busy, only no answer as down", async (t) => {
    for (const [status, body] of [[401, '{"error":"sign in first"}'], [500, "oops"], [200, "not json"], [200, "{}"]] as const) {
      const r = await guard(await fake(t, status, body));
      assert.equal(r.code, 1, `${status} ${body}: ${r.out}`);
    }
    const down = await guard("http://127.0.0.1:9");   // nothing listens
    assert.equal(down.code, 0, down.out);
    assert.match(down.out, /unreachable/);
  });

  it("still reads an old server's open job list", async (t) => {
    // Old servers: /api/status is a 404, /api/jobs lists jobs.
    const s = http.createServer((req, res) => {
      if (req.url?.startsWith("/api/jobs")) {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify([{ status: "running", slug: "council", start: new Date().toISOString() }]));
      }
      res.writeHead(404); res.end();
    });
    await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
    t.after(() => new Promise((r) => s.close(r)));
    const r = await guard(`http://127.0.0.1:${(s.address() as AddressInfo).port}`);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /running council/);
  });
});
