import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { promisify } from "node:util";
import { Audit, CLI, diff, redact } from "../src/audit.js";
import { openDb } from "../src/db.js";
import type { App } from "../src/serve.js";
import { inDays, tmpDir, type HasAfter } from "./helpers.js";
import { Client, startApp } from "./server.js";

const LINK = "https://zoom.us/j/87093163922?pwd=429539";
const run = promisify(execFile);

describe("redaction", () => {
  it("keeps the meeting number, drops passcodes, emails, passwords and tokens", () => {
    assert.deepEqual(redact({
      link: LINK, email: "rec@example.com", password: "hunter22222", password_hash: "scrypt$...", apiToken: "abc",
      note: "see https://us02web.zoom.us/w/123456789?tk=x&pwd=secret for details", nested: [{ link: "87093163922" }], slug: "council",
    }), {
      link: "zoom meeting 87093163922", email: "[set]", password: "[redacted]", password_hash: "[redacted]", apiToken: "[redacted]",
      note: "see https://us02web.zoom.us/w/123456789?tk=x&pwd=[redacted] for details", nested: [{ link: "zoom meeting 87093163922" }], slug: "council",
    });
    assert.equal(redact(null, "email"), null);
    assert.equal(redact({ mustChangePassword: true }) && (redact({ mustChangePassword: true }) as any).mustChangePassword, true);
  });

  it("diffs only what changed, and an email change says so without saying what", () => {
    assert.deepEqual(diff({ a: 1, b: 2, email: "x@example.com", link: LINK }, { a: 1, b: 3, email: "y@example.com", link: LINK }),
      { before: { b: 2, email: "[set]" }, after: { b: 3, email: "[changed]" } });
    assert.deepEqual(diff({ email: null }, { email: "y@example.com" }), { before: { email: null }, after: { email: "[set]" } });
    assert.deepEqual(diff(null, { link: LINK }), { before: null, after: { link: "zoom meeting 87093163922" } });
  });
});

describe("Audit", () => {
  it("records, skips no-ops, filters and pages", (t) => {
    const db = openDb(path.join(tmpDir(t), "minutes.db"));
    t.after(() => db.close());
    const a = new Audit(db);
    const admin = { id: "u1", label: "admin@example.com", ip: "203.0.113.9" };
    a.record(admin, "job.create", { type: "job", id: "j1", label: "council-a" }, null, { slug: "council-a" });
    a.record(admin, "job.update", { type: "job", id: "j1", label: "council-a" }, { name: "A" }, { name: "A" });   // no change: skipped
    a.record(admin, "job.update", { type: "job", id: "j1", label: "council-a" }, { name: "A" }, { name: "B" });
    a.record(CLI, "user.role", { type: "user", id: "u2", label: "100%_sure@example.com" }, { role: "user" }, { role: "admin" });
    for (let i = 0; i < 60; i++) a.record(admin, "login.check", { type: "zoom-login" }, null, { state: "ok" });

    assert.equal(a.list({ action: "job" }).length, 2);
    assert.deepEqual(a.list({ action: "job.update" }).map((e) => e.after), [{ name: "B" }]);
    assert.equal(a.list({ action: "jo" }).length, 0);                       // prefix by whole segments
    assert.deepEqual(a.list({ actor: "cli" }).map((e) => e.action), ["user.role"]);
    assert.deepEqual(a.list({ target: "j1" }).map((e) => e.action), ["job.update", "job.create"]);
    assert.deepEqual(a.list({ target: "100%" }).map((e) => e.targetLabel), ["100%_sure@example.com"]);
    assert.equal(a.list({ target: "%" }).length, 1);                        // LIKE wildcards are literal
    const page1 = a.list();
    assert.equal(page1.length, 50);
    assert.equal(page1[0].ip, "203.0.113.9");
    const page2 = a.list({ beforeId: page1[49].id });
    assert.equal(page2.length, 13);
    assert.ok(page2.every((e) => e.id < page1[49].id));
    assert.deepEqual(a.actions(), ["job.create", "job.update", "login.check", "user.role"]);
  });
});

describe("audit over http and the CLI", () => {
  let app: App, base: string, out: string, admin: Client;
  const cleanups: (() => unknown)[] = [];
  before(async () => {
    const hooks: HasAfter = { after: (fn) => cleanups.push(fn) };
    out = path.join(tmpDir(hooks), "rec");
    ({ app, base } = await startApp(hooks, out, { trustedProxies: "127.0.0.1" }));
    await app.accounts.create({ email: "admin@example.com", role: "admin", password: "admin password" });
    admin = new Client(base);
    await admin.login("admin@example.com", "admin password");
  });
  after(async () => { for (const f of cleanups.reverse()) await f(); });

  it("records each admin write with who, where and what changed, never the secrets", async () => {
    const h = { "x-forwarded-for": "203.0.113.9" };
    const add = await admin.req("POST", "/api/admin/jobs", { link: LINK, start: inDays(1), slug: "council-a", email: "typed@example.com" }, h);
    assert.equal(add.status, 201);
    const start = inDays(2);
    assert.equal((await admin.req("PATCH", `/api/admin/jobs/${add.json.id}`, { start, name: "Recorder (Eric)" }, h)).status, 200);
    assert.equal((await admin.req("POST", "/api/admin/jobs", { link: "https://evil.example/j/1", start: inDays(1) }, h)).status, 400);
    assert.equal((await admin.req("DELETE", `/api/admin/jobs/${add.json.id}`, undefined, h)).status, 200);
    assert.equal((await admin.req("POST", `/api/admin/jobs/${add.json.id}/retry`, {}, h)).status, 201);

    const r = await admin.get("/api/admin/audit");
    assert.equal(r.status, 200);
    const e = r.json.entries;
    assert.deepEqual(e.map((x: { action: string }) => x.action), ["job.retry", "job.cancel", "job.update", "job.create"]);
    assert.ok(e.every((x: { actor: string; ip: string }) => x.actor === "admin@example.com" && x.ip === "203.0.113.9"));
    assert.deepEqual(e[3].after, { slug: "council-a", link: "zoom meeting 87093163922", start: add.json.start, name: "Recorder", email: "[set]", status: "scheduled" });
    assert.deepEqual(e[2].before, { start: add.json.start, name: "Recorder" });
    assert.deepEqual(e[2].after, { start, name: "Recorder (Eric)" });
    assert.deepEqual(e[1].after, { status: "cancelled" });
    assert.equal(e[0].targetLabel, "council-a-2");
    assert.equal(e[0].after.previousAttempt, "council-a");

    // Nowhere in the stored rows: the passcode or the typed email.
    const raw = JSON.stringify(app.audit.list({ limit: 200 }));
    assert.doesNotMatch(raw, /429539|typed@example\.com/);

    // Filters over http.
    assert.deepEqual((await admin.get("/api/admin/audit?action=job.update")).json.entries.length, 1);
    assert.ok((await admin.get("/api/admin/audit")).json.actions.includes("job.retry"));
  });

  it("records password changes; only admins may read the log", async () => {
    await app.accounts.create({ email: "viewer@example.com", role: "user", password: "viewer password" });
    const v = new Client(base);
    await v.login("viewer@example.com", "viewer password");
    assert.equal((await v.post("/api/account/password", { current: "viewer password", password: "a new viewer password" })).status, 200);
    assert.equal((await v.get("/api/admin/audit")).status, 403);
    assert.equal((await new Client(base).get("/api/admin/audit")).status, 401);
    const [p] = (await admin.get("/api/admin/audit?action=account")).json.entries;
    assert.equal(p.action, "account.password");
    assert.equal(p.actor, "viewer@example.com");
    assert.equal(p.targetLabel, "viewer@example.com");
    assert.doesNotMatch(JSON.stringify(p), /viewer password/);
  });

  it("records `minutes user` changes as the CLI", async () => {
    const cli = (...args: string[]) => run(process.execPath, [path.resolve(".test-build/src/index.js"), "user", ...args, "--out", out]);
    const added = await cli("add", "new@example.com");
    const pw = /one-time password: (\S+)/.exec(added.stdout)?.[1];
    assert.ok(pw);
    await cli("role", "new@example.com", "admin");
    await cli("disable", "new@example.com");
    await cli("passwd", "new@example.com");
    const e = app.audit.list({ actor: "cli" });
    assert.deepEqual(e.map((x) => x.action), ["user.passwd", "user.disable", "user.role", "user.create"]);
    assert.deepEqual(e[2].before, { role: "user" });
    assert.deepEqual(e[2].after, { role: "admin" });
    assert.deepEqual(e[1].after, { disabled: true });
    assert.equal(e[3].targetLabel, "new@example.com");
    assert.doesNotMatch(JSON.stringify(e), new RegExp(pw!));
  });
});
