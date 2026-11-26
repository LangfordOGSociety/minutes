/**
 * Phase 4 (#16-#19): API tokens, the /api/v1 API with token downloads,
 * usage tracking, the rate-limit hook, CORS, and the OpenAPI document.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import path from "node:path";
import { describe, it, type TestContext } from "node:test";
import { openApi } from "../src/apidocs.js";
import { openDb } from "../src/db.js";
import { MAX_ACTIVE_TOKENS, Tokens, TokenError } from "../src/tokens.js";
import { tmpDir, type HasAfter } from "./helpers.js";
import { fixtures } from "./fixtures.js";
import { Client, startApp } from "./server.js";

const DAY = 86_400_000;

describe("tokens (store)", () => {
  function store(t: TestContext) {
    const hooks: HasAfter = { after: (fn) => t.after(fn) };
    const db = openDb(path.join(tmpDir(hooks), "x.db"));
    t.after(() => db.close());
    db.prepare("INSERT INTO users (id, email, name, role, created_at, updated_at) VALUES ('u1', 'a@example.com', '', 'user', 'x', 'x')").run();
    db.prepare("INSERT INTO users (id, email, name, role, created_at, updated_at) VALUES ('u2', 'b@example.com', '', 'user', 'x', 'x')").run();
    return { db, tokens: new Tokens(db) };
  }

  it("format, only a hash is stored, shown once, authenticates until revoked or expired", (t) => {
    const { db, tokens } = store(t);
    const now = new Date("2026-12-01T00:00:00Z");
    const { token, record } = tokens.create("u1", { label: "  my script ", expiresInDays: 30 }, now);
    assert.match(token, /^mnt_[0-9a-f]{8}_[A-Za-z0-9_-]{43}$/);
    assert.equal(record.prefix, token.slice(4, 12));
    assert.deepEqual([record.label, record.scopes, record.expiresAt], ["my script", ["read", "download"], new Date(now.getTime() + 30 * DAY).toISOString()]);
    const row = db.prepare("SELECT * FROM api_tokens").get() as Record<string, string>;
    assert.equal(row.hash, createHash("sha256").update(token).digest("hex"));
    assert.ok(!JSON.stringify(row).includes(token.slice(13)), "the secret isn't stored");
    assert.equal(tokens.authenticate(token, now)?.id, record.id);
    assert.equal(tokens.authenticate(token.slice(0, -1) + (token.endsWith("A") ? "B" : "A"), now), null);   // one character off
    assert.equal(tokens.authenticate("mnt_00000000_" + "A".repeat(43), now), null);
    for (const bad of ["", "nope", token + "x", token.toUpperCase()]) assert.equal(tokens.authenticate(bad, now), null, bad);
    assert.equal(tokens.authenticate(token, new Date(now.getTime() + 31 * DAY)), null);   // expired
    tokens.revoke(record.id);
    assert.equal(tokens.authenticate(token, now), null);                                   // revoked
    assert.equal(tokens.revoke("nope"), false);
    // last_used_at moves at most once a minute.
    const b = tokens.create("u1", { label: "b" }, now);
    tokens.authenticate(b.token, now);
    assert.equal(tokens.get(b.record.id)!.lastUsedAt, now.toISOString());
    tokens.authenticate(b.token, new Date(now.getTime() + 10_000));
    assert.equal(tokens.get(b.record.id)!.lastUsedAt, now.toISOString());
    tokens.authenticate(b.token, new Date(now.getTime() + 61_000));
    assert.equal(tokens.get(b.record.id)!.lastUsedAt, new Date(now.getTime() + 61_000).toISOString());
  });

  it("validates labels, scopes, expiry; five active per user", (t) => {
    const { tokens } = store(t);
    for (const bad of [{}, { label: "" }, { label: "x".repeat(61) }, { label: 5 }]) assert.throws(() => tokens.create("u1", bad), TokenError);
    assert.throws(() => tokens.create("u1", { label: "x", scopes: ["admin"] }), /scopes can be/);
    assert.throws(() => tokens.create("u1", { label: "x", expiresInDays: 0 }), /expiry/);
    assert.throws(() => tokens.create("u1", { label: "x", expiresInDays: 731 }), /expiry/);
    assert.deepEqual(tokens.create("u1", { label: "ro", scopes: [] }).record.scopes, ["read"]);       // read is always there
    assert.deepEqual(tokens.create("u1", { label: "dl", scopes: ["download"] }).record.scopes, ["read", "download"]);
    for (let i = 0; i < MAX_ACTIVE_TOKENS - 2; i++) tokens.create("u1", { label: `t${i}` });
    assert.throws(() => tokens.create("u1", { label: "one too many" }), (e: TokenError) => e.status === 409 && /up to 5/.test(e.message));
    tokens.create("u2", { label: "someone else's own five" });                                          // limits are per user
    // Revoked and expired ones don't count against the five.
    const first = tokens.list("u1").at(-1)!;
    tokens.revoke(first.id);
    assert.equal(tokens.create("u1", { label: "fits again" }).record.label, "fits again");
  });

  it("usage: raw rows, daily totals, top files, 90-day prune", (t) => {
    const { tokens } = store(t);
    const a = tokens.create("u1", { label: "a" }).record, b = tokens.create("u2", { label: "b" }).record;
    const d1 = new Date("2026-12-01T10:00:00Z"), d2 = new Date("2026-12-02T10:00:00Z");
    const hit = (tk: typeof a, u: string, bytes: number, file: string | null, at: Date, status = 200) =>
      tokens.record({ tokenId: tk.id, userId: u, route: file ? "/meetings/:id/files/:name" : "/meetings", file, status, bytes }, at);
    hit(a, "u1", 1000, "m1/m1.mp4", d1); hit(a, "u1", 500, "m1/m1.mp4", d1); hit(a, "u1", 10, null, d2); hit(b, "u2", 9000, "m2/m2.mp4", d2);
    const r = tokens.usage({ userId: "u1", days: 30 }, new Date("2026-12-03T00:00:00Z"));
    assert.deepEqual(r.days, [{ day: "2026-12-01", requests: 2, bytes: 1500 }, { day: "2026-12-02", requests: 1, bytes: 10 }]);
    assert.deepEqual(r.files, [{ file: "m1/m1.mp4", requests: 2, bytes: 1500 }]);                      // only their own
    assert.deepEqual(r.tokens.map((x) => [x.label, x.requests, x.bytes]), [["a", 3, 1510]]);
    assert.deepEqual(r.users, []);
    const all = tokens.usage({ days: 30 }, new Date("2026-12-03T00:00:00Z"));
    assert.deepEqual(all.users.map((x) => [x.email, x.requests, x.bytes]), [["b@example.com", 1, 9000], ["a@example.com", 3, 1510]]);
    assert.deepEqual(all.files.map((x) => x.file), ["m2/m2.mp4", "m1/m1.mp4"]);                        // biggest first
    assert.deepEqual(tokens.usage({ days: 1 }, new Date("2026-12-03T00:00:00Z")).days, []);            // one day = today only
    // Raw rows go after 90 days; the daily totals stay.
    assert.equal(tokens.prune(new Date("2027-02-28T00:00:00Z")), 0);
    assert.equal(tokens.prune(new Date("2027-03-05T00:00:00Z")), 4);
    assert.equal(tokens.usage({ days: 365 }, new Date("2027-03-05T00:00:00Z")).days.length, 2);
    assert.deepEqual(tokens.usage({ days: 365 }, new Date("2027-03-05T00:00:00Z")).files, []);
  });
});

async function setup(t: TestContext, extra: Record<string, unknown> = {}) {
  const cleanups: (() => unknown)[] = [];
  t.after(async () => { for (const f of cleanups.reverse()) await f(); });
  const hooks: HasAfter = { after: (fn) => cleanups.push(fn) };
  const out = path.join(tmpDir(hooks), "rec");
  const { app, base } = await startApp(hooks, out, extra);
  fixtures(app, out);
  await app.accounts.create({ email: "admin@example.com", role: "admin", password: "admin password 1", verified: true });
  await app.accounts.create({ email: "reader@example.com", role: "user", password: "reader password 1", verified: true });
  await app.accounts.create({ email: "new@example.com", role: "user", password: "new password 123" });   // not verified
  const as = async (email: string, pw: string) => { const c = new Client(base); assert.equal((await c.login(email, pw)).status, 200); return c; };
  const admin = await as("admin@example.com", "admin password 1");
  const reader = await as("reader@example.com", "reader password 1");
  const unverified = await as("new@example.com", "new password 123");
  const mint = async (c: Client, body: object = { label: "script" }) => (await c.post("/api/account/tokens", body)).json as { token: string; record: { id: string; prefix: string } };
  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
  const get = (path_: string, token?: string, h: Record<string, string> = {}) => new Client(base).req("GET", path_, undefined, { ...(token ? bearer(token) : {}), ...h });
  return { app, base, out, admin, reader, unverified, mint, get, bearer };
}

describe("account tokens", () => {
  it("verified users make, list and revoke their own; the secret is shown once", async (t) => {
    const { app, reader, admin, mint } = await setup(t);
    const r = await reader.post("/api/account/tokens", { label: "my script", scopes: ["download"], expiresInDays: 90 });
    assert.equal(r.status, 201);
    assert.match(r.json.token, /^mnt_[0-9a-f]{8}_/);
    assert.deepEqual([r.json.record.label, r.json.record.scopes, r.json.record.active], ["my script", ["read", "download"], true]);
    const list = (await reader.get("/api/account/tokens")).json;
    assert.deepEqual(list.map((x: { label: string }) => x.label), ["my script"]);
    assert.doesNotMatch(JSON.stringify(list), /hash|mnt_[0-9a-f]{8}_[A-Za-z0-9_-]{43}/);                 // never the secret again
    // Someone else can't see or revoke it.
    assert.deepEqual((await admin.get("/api/account/tokens")).json, []);
    assert.equal((await admin.req("DELETE", `/api/account/tokens/${r.json.record.id}`)).status, 404);
    assert.equal((await reader.req("DELETE", `/api/account/tokens/${r.json.record.id}`)).status, 200);
    assert.equal((await reader.get("/api/account/tokens")).json[0].active, false);
    // Five at a time, readable errors.
    for (let i = 0; i < 5; i++) assert.equal((await reader.post("/api/account/tokens", { label: `t${i}` })).status, 201);
    const sixth = await reader.post("/api/account/tokens", { label: "t6" });
    assert.deepEqual([sixth.status, /up to 5/.test(sixth.json.error)], [409, true]);
    assert.equal((await reader.post("/api/account/tokens", { label: "" })).status, 400);
    // The audit log records who made and revoked tokens, never a secret.
    const audit = (await admin.get("/api/admin/audit?limit=50")).text;
    assert.match(audit, /token\.create/); assert.match(audit, /token\.revoke/);
    assert.doesNotMatch(audit, /mnt_[0-9a-f]{8}_[A-Za-z0-9_-]{43}/);
    void app; void mint;
  });

  it("needs a session, a confirmed email and a same-origin request", async (t) => {
    const { base, unverified } = await setup(t);
    assert.equal((await new Client(base).get("/api/account/tokens")).status, 401);
    assert.equal((await new Client(base).post("/api/account/tokens", { label: "x" })).status, 401);
    assert.equal((await unverified.get("/api/account/tokens")).status, 403);                              // email not confirmed
    assert.equal((await unverified.post("/api/account/tokens", { label: "x" })).status, 403);
    assert.equal((await unverified.get("/api/account/usage")).status, 403);
    const r = await unverified.req("POST", "/api/account/tokens", { label: "x" }, { origin: "https://evil.example" });
    assert.equal(r.status, 403);
  });
});

describe("the /api/v1 API", () => {
  it("reads need no token; downloads do, with the download scope", async (t) => {
    const { reader, get, mint } = await setup(t);
    const pubList = await get("/api/v1/meetings?scope=past");
    assert.equal(pubList.status, 200);
    assert.deepEqual(pubList.json.meetings.map((m: { id: string }) => m.id), ["council-a"]);
    assert.equal((await get("/api/v1/meetings/council-a")).json.recording.video, "council-a.mp4");
    assert.equal((await get("/api/v1/meetings/council-a/status")).json.stage, "ready");
    assert.equal((await get("/api/v1/changes")).status, 200);
    const files = (await get("/api/v1/meetings/council-a/files")).json as { name: string; kind: string; bytes: number; url: string }[];
    assert.deepEqual(files.map((f) => [f.kind, f.name]).sort(), [["subtitles", "council-a.vtt"], ["subtitles-srt", "council-a.srt"], ["transcript-json", "council-a.transcript.json"],
      ["transcript-text", "council-a.txt"], ["video", "council-a.mp4"], ["zoom-captions", "council-a.zoom-captions.vtt"]]);
    assert.equal(files.find((f) => f.kind === "video")!.url, "/api/v1/meetings/council-a/files/council-a.mp4");

    // No token: 401 with a hint. A good one: the file.
    const noTok = await get("/api/v1/meetings/council-a/files/council-a.mp4");
    assert.equal(noTok.status, 401);
    assert.match(noTok.headers.get("www-authenticate") ?? "", /Bearer/);
    const { token } = await mint(reader);
    const dl = await get("/api/v1/meetings/council-a/files/council-a.mp4", token);
    assert.equal(dl.status, 200);
    assert.equal(dl.headers.get("content-disposition"), 'attachment; filename="council-a.mp4"');
    assert.equal(dl.headers.get("content-type"), "video/mp4");
    assert.equal(dl.text.length, 100);
    const part = await get("/api/v1/meetings/council-a/files/council-a.mp4", token, { range: "bytes=10-19" });
    assert.deepEqual([part.status, part.headers.get("content-range"), part.text.length], [206, "bytes 10-99".slice(0, 0) + "bytes 10-19/100", 10]);

    // Only the download scope may; read-only tokens can't.
    const ro = await mint(reader, { label: "read only", scopes: [] });
    assert.equal((await get("/api/v1/meetings/council-a/files/council-a.mp4", ro.token)).status, 403);
    assert.equal((await get("/api/v1/meetings/council-a/files", ro.token)).status, 200);
    // Hidden, unknown and non-public files are 404; never the manifest, parts or the live draft.
    for (const p of ["council-a/manifest.json", "council-a/capture.log", "council-a/part_001.mkv", "council-a/council-a.speakers.json", "council-a/..%2Fminutes.db", "council-a/live.json"]) {
      assert.equal((await get(`/api/v1/meetings/${p}`.replace("/council-a/", "/council-a/files/"), token)).status, 404, p);
    }
    assert.equal((await get("/api/v1/meetings/hidden-b/files", token)).status, 404);
    assert.equal((await get("/api/v1/meetings/nope/files/x.mp4", token)).status, 404);
    assert.equal((await get("/api/v1/meetings/failed-d/files", token)).status, 404);                       // nothing recorded
    assert.equal((await get("/api/v1/nope", token)).status, 404);
    assert.equal((await get("/api/v1/meetings/council-a/files/council-a.mp4/extra", token)).status, 404);
  });

  it("bad, revoked, expired and wrong-kind credentials are refused; tokens open nothing else", async (t) => {
    const { app, admin, reader, get, mint, base } = await setup(t);
    const { token, record } = await mint(reader);
    const f = "/api/v1/meetings/council-a/files/council-a.mp4";
    for (const bad of ["Bearer nope", "Bearer", "Basic abc", token, `Bearer ${token}x`]) {
      const r = await new Client(base).req("GET", "/api/v1/meetings", undefined, { authorization: bad });
      assert.equal(r.status, 401, bad);                                                                    // even on a public endpoint: you'd want to know
    }
    assert.equal((await get(f, token)).status, 200);
    assert.equal((await reader.req("DELETE", `/api/account/tokens/${record.id}`)).status, 200);
    assert.equal((await get(f, token)).status, 401);
    // Expired.
    const exp = await mint(reader, { label: "short", expiresInDays: 1 });
    assert.equal((await get(f, exp.token)).status, 200);
    (app.tokens as unknown as { db: { prepare(s: string): { run(...a: unknown[]): unknown } } }).db.prepare("UPDATE api_tokens SET expires_at = ? WHERE id = ?").run(new Date(Date.now() - 1000).toISOString(), exp.record.id);
    assert.equal((await get(f, exp.token)).status, 401);
    // An admin's token is still just an API token: nothing of /admin or the session's powers.
    const at = await mint(admin, { label: "admin's" });
    for (const p of ["/api/admin/jobs", "/api/admin/tokens", "/api/admin/info", "/api/account/tokens", "/admin/media/council-a/manifest.json"]) {
      assert.equal((await get(p, at.token)).status, 401, p);
    }
    assert.equal((await get("/api/me", at.token)).json.user, null);
    // The API is read-only, and not writable cross-site.
    const w = await admin.req("POST", "/api/v1/meetings", {});
    assert.equal(w.status, 405);
    assert.equal((await new Client(base).req("POST", "/api/v1/meetings", {}, { origin: "https://evil.example" })).status, 403);
  });

  it("disabling a user, or an unconfirmed email, switches their tokens off", async (t) => {
    const { app, admin, reader, get, mint } = await setup(t);
    const { token, record } = await mint(reader);
    const f = "/api/v1/meetings/council-a/files/council-a.mp4";
    assert.equal((await get(f, token)).status, 200);
    const u = app.accounts.byEmail("reader@example.com")!;
    assert.equal((await admin.req("PATCH", `/api/admin/users/${u.id}`, { disabled: true })).status, 200);
    assert.equal((await get(f, token)).status, 401);
    assert.notEqual(app.tokens.get(record.id)!.revokedAt, null);                                          // revoked, not merely ignored
    await admin.req("PATCH", `/api/admin/users/${u.id}`, { disabled: false });
    assert.equal((await get(f, token)).status, 401);                                                      // and it stays revoked
    // Email not confirmed (say an admin cleared it): can't download.
    const n = app.accounts.byEmail("new@example.com")!;
    const forged = app.tokens.create(n.id, { label: "forged" });
    const me = await get("/api/v1/me", forged.token);
    assert.deepEqual([me.status, me.json.canDownload], [200, false]);
    assert.equal((await get(f, forged.token)).status, 403);
  });

  it("/api/v1/me describes the token, and never the secret", async (t) => {
    const { reader, get, mint } = await setup(t);
    const { token, record } = await mint(reader, { label: "me test", expiresInDays: 30 });
    const me = (await get("/api/v1/me", token)).json;
    assert.deepEqual([me.prefix, me.label, me.scopes, me.canDownload], [record.prefix, "me test", ["read", "download"], true]);
    assert.doesNotMatch(JSON.stringify(me), /mnt_/);
    assert.equal((await get("/api/v1/me")).status, 401);
  });
});

describe("usage tracking and limits", () => {
  it("logs every token request with bytes actually sent; users see their own, admins everyone's", async (t) => {
    const { app, admin, reader, get, mint, base } = await setup(t);
    const { token } = await mint(reader), other = await mint(admin, { label: "admin's" });
    const f = "/api/v1/meetings/council-a/files/council-a.mp4";
    await get(f, token);                                                  // 100 bytes
    await get(f, token, { range: "bytes=0-9" });                          // 10 bytes
    await get(f, token, { range: "bytes=0-9999" });                       // clipped to 100
    await get("/api/v1/meetings", token);
    await get(f, other.token);
    await get("/api/v1/meetings");                                        // no token: not logged
    await get(f, "mnt_00000000_" + "A".repeat(43));                       // unknown token: not logged
    await new Promise((r) => setTimeout(r, 100));                         // 'close' handlers
    const mine = (await reader.get("/api/account/usage")).json;
    const dl = mine.files[0];
    assert.deepEqual([dl.file, dl.requests, dl.bytes], ["council-a/council-a.mp4", 3, 210]);
    assert.equal(mine.days.length, 1);
    assert.equal(mine.days[0].requests, 4);
    assert.ok(mine.days[0].bytes > 210);                                  // + the list's JSON
    assert.deepEqual(mine.tokens.map((x: { label: string; requests: number }) => [x.label, x.requests]), [["script", 4]]);
    assert.deepEqual(mine.users, []);                                     // a user sees nobody else
    const all = (await admin.get("/api/admin/usage")).json;
    assert.deepEqual(all.users.map((x: { email: string; requests: number }) => [x.email, x.requests]).sort(), [["admin@example.com", 1], ["reader@example.com", 4]]);
    assert.equal(all.files[0].bytes, 210 + 100);
    assert.equal((await admin.get(`/api/admin/usage?user=${app.accounts.byEmail("reader@example.com")!.id}`)).json.users.length, 0);
    assert.equal((await new Client(base).get("/api/admin/usage")).status, 401);
    assert.equal((await reader.get("/api/admin/usage")).status, 403);
    // The raw rows hold route patterns and the client, never a token.
    const rows = (app.tokens as unknown as { db: { prepare(s: string): { all(): Record<string, unknown>[] } } }).db.prepare("SELECT * FROM api_usage").all();
    assert.ok(rows.some((r) => r.route === "/meetings/:id/files/:name" && r.status === 206 && r.bytes === 10 && r.ip));
    assert.doesNotMatch(JSON.stringify(rows), /mnt_/);
  });

  it("the limit hook runs for every token request, and a refusal is a 429 with Retry-After", async (t) => {
    const { app, reader, get, mint } = await setup(t);
    const { token } = await mint(reader);
    const seen: string[] = [];
    app.tokens.limiter = (tk, route) => { seen.push(`${tk.label} ${route}`); return route === "/meetings/:id/files/:name" ? { allow: false, retryAfterS: 7.2 } : { allow: true }; };
    assert.equal((await get("/api/v1/meetings", token)).status, 200);
    const r = await get("/api/v1/meetings/council-a/files/council-a.mp4", token);
    assert.deepEqual([r.status, r.headers.get("retry-after")], [429, "8"]);
    assert.deepEqual(seen, ["script /meetings", "script /meetings/:id/files/:name"]);
    await get("/api/v1/meetings");                                        // no token: the hook isn't asked
    assert.equal(seen.length, 2);
    await new Promise((r2) => setTimeout(r2, 100));
    const u = (await reader.get("/api/account/usage")).json;
    assert.equal(u.days[0].requests, 2);                                  // the refused one is logged too (status 429)
  });
});

describe("admin: all tokens", () => {
  it("lists everyone's, revokes any (audited), users can't", async (t) => {
    const { admin, reader, mint, get } = await setup(t);
    const { token, record } = await mint(reader, { label: "reader's" });
    await mint(admin, { label: "admin's" });
    const list = (await admin.get("/api/admin/tokens")).json as { label: string; userEmail: string }[];
    assert.deepEqual(list.map((x) => [x.label, x.userEmail]).sort(), [["admin's", "admin@example.com"], ["reader's", "reader@example.com"]]);
    assert.equal((await reader.get("/api/admin/tokens")).status, 403);
    assert.equal((await reader.req("DELETE", `/api/admin/tokens/${record.id}`)).status, 403);
    assert.equal((await admin.req("DELETE", `/api/admin/tokens/${record.id}`)).status, 200);
    assert.equal((await get("/api/v1/me", token)).status, 401);
    assert.equal((await admin.req("DELETE", "/api/admin/tokens/nope")).status, 404);
    assert.match((await admin.get("/api/admin/audit?limit=20")).text, /reader@example\.com\)/);
  });
});

describe("CORS and the OpenAPI document", () => {
  it("public reads are open to other sites, with preflight for Range and Authorization; writes are not", async (t) => {
    const { get, base } = await setup(t);
    for (const p of ["/api/v1/meetings", "/api/v1/meetings/council-a", "/api/meetings", "/api/changes", "/media/council-a/council-a.vtt", "/api/v1/openapi.json"]) {
      const r = await get(p);
      assert.equal(r.status, 200, p);
      assert.equal(r.headers.get("access-control-allow-origin"), "*", p);
      assert.match(r.headers.get("access-control-expose-headers") ?? "", /Content-Range/, p);
    }
    const pre = await new Client(base).req("OPTIONS", "/api/v1/meetings/council-a/files/council-a.mp4", undefined, { origin: "https://openlangford.ca", "access-control-request-method": "GET", "access-control-request-headers": "authorization, range" });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get("access-control-allow-origin"), "*");
    assert.match(pre.headers.get("access-control-allow-headers") ?? "", /Authorization.*Range|Range.*Authorization/);
    assert.equal((await new Client(base).req("OPTIONS", "/media/council-a/council-a.mp4")).status, 204);
    // Not for the admin or session endpoints, and never with credentials.
    for (const p of ["/api/admin/jobs", "/api/login", "/api/account/tokens"]) {
      const r = await new Client(base).req("OPTIONS", p, undefined, { origin: "https://evil.example", "access-control-request-method": "POST" });
      assert.notEqual(r.status, 204, p);
      assert.equal(r.headers.get("access-control-allow-origin"), null, p);
    }
    for (const p of ["/api/admin/jobs", "/api/me", "/login"]) assert.equal((await get(p)).headers.get("access-control-allow-origin"), null, p);
    assert.equal((await get("/media/council-a/manifest.json")).status, 404);
  });

  it("every path in openapi.json exists, and every v1 route is in it", async (t) => {
    const { get, base } = await setup(t);
    const doc = (await get("/api/v1/openapi.json")).json as { openapi: string; paths: Record<string, { get: { operationId: string } }> };
    assert.equal(doc.openapi, "3.1.0");
    assert.deepEqual(Object.keys(doc.paths).sort(), ["/api/v1/changes", "/api/v1/me", "/api/v1/meetings", "/api/v1/meetings/{id}", "/api/v1/meetings/{id}/files",
      "/api/v1/meetings/{id}/files/{name}", "/api/v1/meetings/{id}/status", "/api/v1/openapi.json", "/api/v1/search"].sort());
    for (const p of Object.keys(doc.paths)) {
      const url = p.replace("{id}", "council-a").replace("{name}", "council-a.mp4");
      const r = await get(url);
      assert.ok([200, 401].includes(r.status), `${p} -> ${r.status}`);                                    // 401 = needs a token, but it's there
    }
    assert.equal(new Set(Object.values(doc.paths).map((x) => x.get.operationId)).size, Object.keys(doc.paths).length);
    assert.equal((openApi("https://x.example") as { servers: { url: string }[] }).servers[0].url, "https://x.example");
    // The human page: real site address in the examples, no script, can't be framed.
    const page = await get("/api/docs");
    assert.equal(page.status, 200);
    assert.match(page.text, new RegExp(base.replace(/[.:/]/g, "\\$&") + "/api/v1/meetings"));
    assert.doesNotMatch(page.text, /<script|YOUR-SITE/);
    assert.match(page.text, /can be saved by anyone/);
    assert.equal(page.headers.get("x-frame-options"), "DENY");
    assert.match(page.headers.get("content-security-policy") ?? "", /script-src 'none'/);
  });
});
