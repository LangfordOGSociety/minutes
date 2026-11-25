/**
 * #32 over HTTP: sign-up with an emailed code, verification, password
 * reset, the abuse controls, and the admin's Users list.
 */
import assert from "node:assert/strict";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import type { App } from "../src/serve.js";
import { tmpDir, type HasAfter } from "./helpers.js";
import { Client, startApp } from "./server.js";
import { MemoryMailer } from "./smtp.js";

describe("sign-up and password reset", () => {
  let app: App, base: string;
  const mailer = new MemoryMailer();
  const cleanups: (() => unknown)[] = [];
  before(async () => {
    const hooks: HasAfter = { after: (fn) => cleanups.push(fn) };
    ({ app, base } = await startApp(hooks, path.join(tmpDir(hooks), "rec"),
      { mailer, publicUrl: "https://minutes.example", trustedProxies: "127.0.0.1" }));
  });
  after(async () => { for (const f of cleanups.reverse()) await f(); });
  // Each test from its own address, so the per-address limits don't mix.
  let n = 0;
  const client = () => { const c = new Client(base); const ip = `198.51.100.${++n}`; const req = c.req.bind(c);
    c.req = (m, p, b, h = {}) => req(m, p, b, { "x-forwarded-for": ip, ...h }); return c; };

  it("signs up, emails a code, verifies, signs in; no tokens before that", async () => {
    const c = client();
    assert.equal((await c.get("/api/me")).json.signup, true);
    const r = await c.post("/api/signup", { email: "New@Example.com", password: "a good long password", name: "Newbie" });
    assert.equal(r.status, 202);
    assert.equal(r.setCookie, null);                         // not signed in until verified
    const msg = mailer.sent.at(-1)!;
    assert.equal(msg.to, "New@Example.com");
    assert.match(msg.subject, /^Your minutes code: \d{6}$/);
    assert.match(msg.text, /https:\/\/minutes\.example/);
    const code = mailer.code("New@Example.com")!;

    // Before verifying, signing in works but the account can't have tokens.
    const early = client();
    const li = await early.login("new@example.com", "a good long password");
    assert.equal(li.json.user.verified, false);
    assert.ok(!li.json.user.caps.includes("tokens.own"));

    assert.equal((await c.post("/api/signup/verify", { email: "new@example.com", code: "000000" === code ? "111111" : "000000" })).status, 400);
    const v = await c.post("/api/signup/verify", { email: "new@example.com", code });
    assert.equal(v.status, 200);
    assert.equal(v.json.user.verified, true);
    assert.ok(v.json.user.caps.includes("tokens.own"));
    assert.equal(v.json.user.role, "user");
    assert.ok(c.cookie);
    // Single use.
    assert.equal((await client().post("/api/signup/verify", { email: "new@example.com", code })).status, 400);
    assert.deepEqual(app.audit.list({ target: "new@example.com" }).map((e) => e.action), ["user.verify", "user.signup"]);
  });

  it("answers the same for an existing account, and tells its owner instead", async () => {
    await app.accounts.create({ email: "taken@example.com", role: "user", password: "the owner's password", verified: true });
    const before = mailer.sent.length;
    const r = await client().post("/api/signup", { email: "taken@example.com", password: "attacker password 1" });
    assert.equal(r.status, 202);
    assert.deepEqual(r.json, { ok: true, email: "taken@example.com" });
    const msg = mailer.sent.at(-1)!;
    assert.equal(mailer.sent.length, before + 1);
    assert.equal(msg.subject, "You already have a minutes account");
    assert.equal(mailer.code("taken@example.com"), null);
    // The password didn't change.
    assert.equal((await client().login("taken@example.com", "the owner's password")).status, 200);
  });

  it("verifies from the account page, with resend", async () => {
    const c = client();
    await c.post("/api/signup", { email: "later@example.com", password: "later password 1" });
    const first = mailer.code("later@example.com");
    await c.login("later@example.com", "later password 1");
    assert.equal((await c.post("/api/account/verify/resend")).status, 202);
    const second = mailer.code("later@example.com")!;
    if (first !== second) assert.equal((await c.post("/api/account/verify", { code: first })).status, 400);   // replaced
    const v = await c.post("/api/account/verify", { code: second });
    assert.equal(v.status, 200);
    assert.equal(v.json.user.verified, true);
  });

  it("resets a password by emailed code, once, and signs out everywhere", async () => {
    await app.accounts.create({ email: "forgetful@example.com", role: "user", password: "old password 123" });
    const old = client();
    await old.login("forgetful@example.com", "old password 123");
    const c = client();
    assert.equal((await c.post("/api/password/forgot", { email: "forgetful@example.com" })).status, 202);
    const code = mailer.code("forgetful@example.com")!;
    assert.match(mailer.sent.at(-1)!.subject, /^Your minutes password reset code: \d{6}$/);
    assert.equal((await c.post("/api/password/reset", { email: "forgetful@example.com", code, password: "short" })).status, 400);
    assert.equal((await c.post("/api/password/reset", { email: "forgetful@example.com", code, password: "new password 456" })).status, 200);
    assert.equal((await c.post("/api/password/reset", { email: "forgetful@example.com", code, password: "again password 789" })).status, 400);
    assert.equal((await old.get("/api/me")).json.user, null);
    assert.equal((await client().login("forgetful@example.com", "old password 123")).status, 401);
    const li = await client().login("forgetful@example.com", "new password 456");
    assert.equal(li.json.user.verified, true);   // reading the mail proved the address
    // Unknown addresses get the same answer and no mail.
    const before = mailer.sent.length;
    assert.equal((await c.post("/api/password/forgot", { email: "nobody@example.com" })).status, 202);
    assert.equal(mailer.sent.length, before);
  });

  it("a code dies after 5 wrong tries", async () => {
    await app.accounts.create({ email: "guess@example.com", role: "user", password: "guess password 1" });
    const c = client();
    await c.post("/api/password/forgot", { email: "guess@example.com" });
    const code = mailer.code("guess@example.com")!;
    const wrong = code === "123456" ? "654321" : "123456";
    for (let i = 0; i < 5; i++) {
      assert.equal((await client().post("/api/password/reset", { email: "guess@example.com", code: wrong, password: "whatever password" })).status, 400);
    }
    assert.equal((await client().post("/api/password/reset", { email: "guess@example.com", code, password: "whatever password" })).status, 400);
  });

  it("abuse controls: honeypot, per-address sign-up limit, per-account mail limit", async () => {
    const before = mailer.sent.length;
    const bot = client();
    assert.equal((await bot.post("/api/signup", { email: "bot@example.com", password: "bot password 12", website: "http://spam" })).status, 202);
    assert.equal(app.accounts.byEmail("bot@example.com"), undefined);
    assert.equal(mailer.sent.length, before);

    const busy = client();
    for (let i = 0; i < 5; i++) assert.equal((await busy.post("/api/signup", { email: `s${i}@example.com`, password: "some password 1" })).status, 202);
    assert.equal((await busy.post("/api/signup", { email: "s9@example.com", password: "some password 1" })).status, 429);

    await app.accounts.create({ email: "inbox@example.com", role: "user", password: "inbox password 1" });
    const sentTo = () => mailer.sent.filter((m) => m.to === "inbox@example.com").length;
    for (let i = 0; i < 5; i++) await client().post("/api/password/forgot", { email: "inbox@example.com" });
    assert.equal(sentTo(), 3);   // the rest answered 202 but sent nothing
  });

  it("unverified self sign-ups are deleted after 7 days, nobody else", async () => {
    const old = new Date(Date.now() - 8 * 86_400_000);
    await app.accounts.create({ email: "stale@example.com", role: "user", password: "stale password 1" });
    await app.accounts.create({ email: "stale-admin@example.com", role: "admin", password: "stale password 1" });
    const gone = app.accounts.deleteUnverified(7, new Date(Date.now() + 8 * 86_400_000));
    assert.ok(gone.includes("stale@example.com"));
    assert.ok(!gone.includes("stale-admin@example.com"));
    assert.ok(!gone.includes("taken@example.com"));   // verified
    assert.ok(old);
  });
});

describe("without mail", () => {
  it("sign-up and reset are off", async (t) => {
    const cleanups: (() => unknown)[] = [];
    t.after(async () => { for (const f of cleanups.reverse()) await f(); });
    const hooks: HasAfter = { after: (fn) => cleanups.push(fn) };
    const { base } = await startApp(hooks, path.join(tmpDir(hooks), "rec"));
    const c = new Client(base);
    assert.equal((await c.get("/api/me")).json.signup, false);
    for (const p of ["/api/signup", "/api/signup/verify", "/api/password/forgot", "/api/password/reset", "/api/account/verify"]) {
      const r = await c.post(p, { email: "x@example.com" });
      assert.equal(r.status, 404, p);
      assert.match(r.json.error, /made by an admin/);
    }
  });
});

describe("admin: users", () => {
  it("lists, promotes, disables (signing out), audited; never yourself", async (t) => {
    const cleanups: (() => unknown)[] = [];
    t.after(async () => { for (const f of cleanups.reverse()) await f(); });
    const hooks: HasAfter = { after: (fn) => cleanups.push(fn) };
    const { app, base } = await startApp(hooks, path.join(tmpDir(hooks), "rec"));
    const me = await app.accounts.create({ email: "admin@example.com", role: "admin", password: "admin password 1" });
    const u = await app.accounts.create({ email: "u@example.com", role: "user", password: "user password 12" });
    const admin = new Client(base), user = new Client(base);
    await admin.login("admin@example.com", "admin password 1");
    await user.login("u@example.com", "user password 12");

    const list = await admin.get("/api/admin/users");
    assert.deepEqual(list.json.map((x: { email: string }) => x.email), ["admin@example.com", "u@example.com"]);
    assert.equal(list.json[0].password_hash, undefined);
    assert.equal((await user.get("/api/admin/users")).status, 403);

    assert.equal((await admin.req("PATCH", `/api/admin/users/${u.id}`, { role: "admin" })).json.role, "admin");
    assert.equal((await admin.req("PATCH", `/api/admin/users/${u.id}`, { role: "root" })).status, 400);
    assert.equal((await admin.req("PATCH", `/api/admin/users/${u.id}`, { role: "user", disabled: true })).json.disabled, true);
    assert.equal((await user.get("/api/me")).json.user, null);
    assert.equal((await admin.req("PATCH", `/api/admin/users/${me.id}`, { disabled: true })).status, 409);
    assert.equal((await admin.req("PATCH", `/api/admin/users/${me.id}`, { role: "user" })).status, 409);
    assert.deepEqual(app.audit.list({ action: "user.update" }).map((e) => e.after), [{ role: "user", disabled: true }, { role: "admin" }]);
  });
});
