import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";
import { Accounts, FailureLimiter, ROLE_CAPS, can, generatePassword, hashPassword, verifyPassword } from "../src/accounts.js";
import { openDb } from "../src/db.js";
import { tmpDir } from "./helpers.js";

function accounts(t: import("node:test").TestContext) {
  const db = openDb(path.join(tmpDir(t), "minutes.db"));
  t.after(() => db.close());
  return { a: new Accounts(db), db };
}

describe("passwords", () => {
  it("hash and verify with scrypt, salted", async () => {
    const h = await hashPassword("correct horse battery");
    assert.match(h, /^scrypt\$32768\$8\$1\$/);
    assert.notEqual(h, await hashPassword("correct horse battery"));
    assert.equal(await verifyPassword("correct horse battery", h), true);
    assert.equal(await verifyPassword("correct horse batterY", h), false);
    assert.equal(await verifyPassword("anything", null), false);
    assert.equal(await verifyPassword("anything", "garbage"), false);
  });

  it("one-time passwords are 16 unambiguous characters", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const p = generatePassword();
      assert.match(p, /^[a-km-zA-HJ-NP-Z2-9]{16}$/);
      seen.add(p);
    }
    assert.equal(seen.size, 50);
  });
});

describe("roles", () => {
  it("map to capabilities; unknown roles get public's", () => {
    assert.equal(can(null, "watch"), true);
    assert.equal(can(null, "admin.view"), false);
    assert.equal(can("user", "tokens.own"), true);
    assert.equal(can("user", "admin.view"), false);
    assert.equal(can("admin", "admin.manage"), true);
    assert.equal(can("superuser", "admin.view"), false);
    for (const caps of Object.values(ROLE_CAPS)) assert.ok(caps.includes("watch"));
  });
});

describe("Accounts", () => {
  it("creates users with unique, case-insensitive emails", async (t) => {
    const { a } = accounts(t);
    const u = await a.create({ email: "Admin@Example.com", role: "admin", password: "a long password", verified: true });
    assert.equal(u.role, "admin");
    assert.ok(u.emailVerifiedAt);
    assert.equal(a.byEmail("admin@example.COM")?.id, u.id);
    await assert.rejects(a.create({ email: "admin@example.com", role: "user", password: "another password" }), /already has an account/);
    await assert.rejects(a.create({ email: "x@example.com", role: "root", password: "another password" }), /role must be/);
    await assert.rejects(a.create({ email: "nope", role: "user", password: "another password" }), /email/);
    await assert.rejects(a.create({ email: "y@example.com", role: "user", password: "short" }), /at least 10/);
  });

  it("authenticates, and never a disabled account", async (t) => {
    const { a } = accounts(t);
    await a.create({ email: "a@example.com", role: "admin", password: "a long password" });
    await a.create({ email: "u@example.com", role: "user", password: "a long password" });
    assert.equal((await a.authenticate(" A@example.com ", "a long password"))?.email, "a@example.com");
    assert.equal(await a.authenticate("a@example.com", "wrong password"), null);
    assert.equal(await a.authenticate("nobody@example.com", "a long password"), null);
    a.setDisabled("u@example.com", true);
    assert.equal(await a.authenticate("u@example.com", "a long password"), null);
  });

  it("sessions: hashed at rest, sliding 14 days, ended by disable and password change", async (t) => {
    const { a, db } = accounts(t);
    const u = await a.create({ email: "a@example.com", role: "user", password: "a long password" });
    const t0 = new Date("2026-11-25T12:00:00Z");
    const tok = a.createSession(u.id, { ip: "1.2.3.4" }, t0);
    assert.equal(Buffer.from(tok, "base64url").length, 32);
    const stored = db.prepare("SELECT token_hash FROM sessions").all() as { token_hash: string }[];
    assert.equal(stored.length, 1);
    assert.notEqual(stored[0].token_hash, tok);

    assert.equal(a.session(tok, new Date(t0.getTime() + 60_000))?.renewed, false);   // touched < 10 min ago
    const day13 = new Date(t0.getTime() + 13 * 86_400_000);
    assert.equal(a.session(tok, day13)?.renewed, true);                               // pushed out
    assert.ok(a.session(tok, new Date(day13.getTime() + 13 * 86_400_000)));            // 26 days in, still valid
    const idle = a.createSession(u.id, {}, t0);
    assert.equal(a.session(idle, new Date(t0.getTime() + 15 * 86_400_000)), null);      // unused for 15 days
    assert.equal(a.session("made-up"), null);

    const s1 = a.createSession(u.id), s2 = a.createSession(u.id);
    await a.setPassword(u.id, "a new long password", { mustChange: false, keepSession: s1 });
    assert.ok(a.session(s1));
    assert.equal(a.session(s2), null);
    a.setDisabled("a@example.com", true);
    assert.equal(a.session(s1), null);
  });

  it("never removes or demotes the last admin", async (t) => {
    const { a } = accounts(t);
    await a.create({ email: "a@example.com", role: "admin", password: "a long password" });
    assert.throws(() => a.setRole("a@example.com", "user"), /last admin/);
    assert.throws(() => a.setDisabled("a@example.com", true), /last admin/);
    await a.create({ email: "b@example.com", role: "user", password: "a long password" });
    a.setRole("b@example.com", "admin");
    assert.equal(a.setRole("a@example.com", "user").role, "user");
  });
});

describe("FailureLimiter", () => {
  it("blocks after max failures in the window, then lets go", () => {
    const l = new FailureLimiter(3, 60_000, 2);
    l.fail("k", 0); l.fail("k", 10_000);
    assert.equal(l.blockedFor("k", 20_000), 0);
    l.fail("k", 20_000);
    assert.equal(l.blockedFor("k", 20_000), 40_000);   // until the first one ages out
    assert.equal(l.blockedFor("k", 60_000), 0);
    l.reset("k");
    l.fail("a", 0); l.fail("b", 0); l.fail("c", 0);       // bounded: "k" and "a" dropped
    assert.equal(l.blockedFor("a", 0), 0);
  });
});
