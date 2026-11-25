/**
 * The real server (createApp) on a random port: who may do what.
 */
import assert from "node:assert/strict";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { safeNext, type App } from "../src/serve.js";
import { Client, startApp } from "./server.js";
import { inDays, tmpDir, type HasAfter } from "./helpers.js";

const LINK = "https://zoom.us/j/87093163922?pwd=429539";

describe("http: accounts and permissions", () => {
  let app: App, base: string;
  const cleanups: (() => unknown)[] = [];
  before(async () => {
    const hooks: HasAfter = { after: (fn) => cleanups.push(fn) };
    ({ app, base } = await startApp(hooks, path.join(tmpDir(hooks), "rec")));
  });
  after(async () => { for (const f of cleanups.reverse()) await f(); });

  it("signed out: recordings yes, the capture page and job APIs no", async () => {
    const c = new Client(base);
    assert.deepEqual((await c.get("/api/me")).json, { user: null, setupNeeded: true });
    const page = await c.get("/");
    assert.equal(page.status, 302);
    assert.equal(page.headers.get("location"), "/login?next=%2F");
    assert.equal((await c.get("/login")).status, 200);
    assert.equal((await c.get("/api/recordings")).status, 200);
    assert.equal((await c.get("/api/info")).status, 200);
    assert.equal((await c.get("/api/jobs")).status, 401);
    assert.equal((await c.get("/api/session")).status, 401);
    assert.equal((await c.post("/api/jobs", { link: LINK, start: inDays(1) })).status, 401);
    assert.equal((await c.post("/api/session/check")).status, 401);
  });

  it("admin: one-time password, forced change, then everything", async () => {
    await app.accounts.create({ email: "admin@example.com", role: "admin", password: "one-time-pass", mustChange: true, verified: true });
    const c = new Client(base);
    assert.equal((await c.login("admin@example.com", "wrong password")).status, 401);
    const r = await c.login("ADMIN@example.com ", "one-time-pass");
    assert.equal(r.status, 200);
    assert.equal(r.json.user.mustChangePassword, true);
    assert.match(r.setCookie!, /^__Host-minutes_session=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Lax; Secure; Max-Age=1209600$/);

    // Nothing else until the password is changed.
    assert.deepEqual((await c.get("/api/jobs")).json, { error: "change your password first" });
    assert.equal((await c.get("/")).headers.get("location"), "/account?denied=1");
    assert.equal((await c.post("/api/account/password", { current: "wrong", password: "a brand new password" })).status, 403);
    assert.equal((await c.post("/api/account/password", { current: "one-time-pass", password: "short" })).status, 400);
    const ch = await c.post("/api/account/password", { current: "one-time-pass", password: "a brand new password" });
    assert.equal(ch.status, 200);
    assert.equal(ch.json.user.mustChangePassword, false);

    assert.equal((await c.get("/")).status, 200);
    assert.equal((await c.get("/api/jobs")).status, 200);
    const add = await c.post("/api/jobs", { link: LINK, start: inDays(1), slug: "council-x" });
    assert.equal(add.status, 201);
    assert.equal(add.json.link, undefined);
    assert.equal((await c.get("/api/session")).status, 200);

    // Old password is gone; new one works.
    assert.equal((await new Client(base).login("admin@example.com", "one-time-pass")).status, 401);
    assert.equal((await new Client(base).login("admin@example.com", "a brand new password")).status, 200);

    assert.equal((await c.post("/api/logout")).status, 200);
    assert.equal(c.cookie, "");
    assert.equal((await c.get("/api/jobs")).status, 401);
  });

  it("a user account can watch but not run captures", async () => {
    await app.accounts.create({ email: "viewer@example.com", role: "user", password: "viewer password" });
    const c = new Client(base);
    assert.equal((await c.login("viewer@example.com", "viewer password")).status, 200);
    assert.equal((await c.get("/api/recordings")).status, 200);
    assert.equal((await c.get("/api/jobs")).status, 403);
    assert.equal((await c.post("/api/jobs", { link: LINK, start: inDays(1) })).status, 403);
    assert.equal((await c.get("/")).headers.get("location"), "/account?denied=1");
    app.accounts.setDisabled("viewer@example.com", true);
    assert.equal((await c.get("/api/me")).json.user, null);
  });

  it("refuses cross-origin writes, including sign-in", async () => {
    const c = new Client(base);
    const r = await c.req("POST", "/api/login", { email: "admin@example.com", password: "a brand new password" }, { origin: "https://evil.example" });
    assert.equal(r.status, 403);
    assert.equal(r.setCookie, null);
  });

  it("limits failed sign-ins per account", async () => {
    await app.accounts.create({ email: "target@example.com", role: "user", password: "the real password" });
    for (let i = 0; i < 10; i++) assert.equal((await new Client(base).login("target@example.com", "guess " + i)).status, 401);
    const r = await new Client(base).login("target@example.com", "the real password");
    assert.equal(r.status, 429);
    assert.ok(Number(r.headers.get("retry-after")) > 0);
  });
});

describe("safeNext", () => {
  it("allows only paths on this site", () => {
    assert.equal(safeNext("/admin?x=1"), "/admin?x=1");
    for (const bad of ["//evil.example", "/\\evil.example", "https://evil.example", "javascript:alert(1)", null, ""]) {
      assert.equal(safeNext(bad), "/", String(bad));
    }
  });
});
