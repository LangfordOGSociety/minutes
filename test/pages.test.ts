/**
 * The pages in Chromium against the real server: sign-in, the forced
 * password change, the admin page. Needs Playwright's Chromium.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { chromium, type Browser } from "playwright";
import type { App } from "../src/serve.js";
import { tmpDir, type HasAfter } from "./helpers.js";
import { startApp } from "./server.js";
import { fakeSource, fixtures } from "./fixtures.js";
import { MemoryMailer } from "./smtp.js";

function skipReason(): string | false {
  if (existsSync(chromium.executablePath())) return false;
  if (process.env.CI) throw new Error("Playwright's Chromium is required in CI");
  return "Playwright Chromium not installed";
}

describe("pages in Chromium", { skip: skipReason() }, () => {
  let browser: Browser, app: App, base: string;
  const cleanups: (() => unknown)[] = [];
  before(async () => {
    const hooks: HasAfter = { after: (fn) => cleanups.push(fn) };
    // Chromium drops __Host- cookies on plain http, so this runs as compose
    // does (COOKIE_SECURE=0). The production cookie header is checked in
    // http.test.ts.
    ({ app, base } = await startApp(hooks, path.join(tmpDir(hooks), "rec"), { secureCookie: false }));
    browser = await chromium.launch();
  });
  after(async () => {
    await browser?.close();
    for (const f of cleanups.reverse()) await f();
  });

  it("sign in with a one-time password, choose a new one, land on the admin page", async () => {
    await app.accounts.create({ email: "admin@example.com", role: "admin", password: "one-time-pass", mustChange: true });
    const page = await (await browser.newContext()).newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));

    await page.goto(base + "/admin");
    assert.equal(new URL(page.url()).pathname, "/login");
    await page.fill("#email", "admin@example.com");
    await page.fill("#password", "wrong password");
    await page.click("#loginform button");
    await page.waitForSelector("#loginmsg.err");
    assert.equal(await page.textContent("#loginmsg"), "wrong email or password");

    await page.fill("#password", "one-time-pass");
    await page.click("#loginform button");
    await page.waitForSelector("#change:not([hidden])");
    assert.equal(await page.isVisible("#changehint"), true);
    assert.equal(await page.isVisible("#current"), false);   // the one-time password is reused
    await page.fill("#new", "my own long password");
    await page.fill("#confirm", "my own long password");
    await page.click("#changeform button");
    // (No waitForFunction: the page's CSP rightly refuses eval.)
    await Promise.race([page.waitForURL(base + "/admin"), page.waitForSelector("#changemsg.err")]);
    if (new URL(page.url()).pathname !== "/admin") assert.fail("password change: " + await page.textContent("#changemsg"));
    await page.waitForLoadState();
    await page.waitForSelector("#me a[href='/account']");
    assert.match(await page.textContent("#me") ?? "", /admin@example.com/);
    assert.equal(await page.textContent("#formtitle"), "Schedule a meeting");

    // The Secure cookie held, and it's HttpOnly.
    const [c] = await page.context().cookies();
    assert.equal(c.name, "minutes_session");
    assert.equal(c.httpOnly, true);
    assert.equal(await page.evaluate(() => document.cookie), "");

    // Schedule through the form; the audit log shows it.
    const d = new Date(Date.now() + 2 * 86_400_000);
    const local = (n: number) => String(n).padStart(2, "0");
    await page.fill("#link", "https://zoom.us/j/87093163922?pwd=429539");
    await page.fill("#start", `${d.getFullYear()}-${local(d.getMonth() + 1)}-${local(d.getDate())}T19:00`);
    await page.fill("#slug", "council-ui");
    await page.click("#submitbtn");
    await page.waitForSelector("#formmsg.ok");
    await page.waitForSelector("#audit .row:has-text('job.create')");
    const row = await page.textContent("#audit .row:has-text('job.create')") ?? "";
    assert.match(row, /council-ui/);
    assert.match(row, /admin@example\.com/);
    assert.match(row, /zoom meeting 87093163922/);
    assert.doesNotMatch(row, /429539/);
    await page.selectOption("#aaction", "job.create");
    await page.waitForSelector("#audit .row");

    await page.click("#me a:has-text('sign out')");
    await page.waitForURL(/\/login$/);
    await page.goto(base + "/admin");
    assert.equal(new URL(page.url()).pathname, "/login");
    assert.deepEqual(errors, []);
  });
});

describe("public page in Chromium", { skip: skipReason() }, () => {
  let browser: Browser, base: string;
  const cleanups: (() => unknown)[] = [];
  before(async () => {
    const hooks: HasAfter = { after: (fn) => cleanups.push(fn) };
    const out = path.join(tmpDir(hooks), "rec");
    let app: App;
    ({ app, base } = await startApp(hooks, out));
    fixtures(app, out);
    browser = await chromium.launch();
  });
  after(async () => {
    await browser?.close();
    for (const f of cleanups.reverse()) await f();
  });

  it("home: upcoming, past with filters, recent updates; a meeting's page plays it with its transcript", async () => {
    const page = await (await browser.newContext()).newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
    const requests: string[] = [];
    page.on("request", (r) => requests.push(new URL(r.url()).pathname));

    await page.goto(base + "/");
    await page.waitForSelector("#past .mcard");
    assert.deepEqual((await page.$$eval("#upcoming .mcard .t", (els) => els.map((e) => e.textContent))).sort(), ["upcomingfailed-d", "upcominglive-e"]);
    assert.deepEqual(await page.$$eval("#past .mcard .t", (els) => els.map((e) => e.textContent)), ["video + transcriptcouncil-a"]);
    assert.equal(await page.textContent("#me"), "Sign in");
    assert.match(await page.textContent("#updates") ?? "", /Nothing has changed lately|Announced/);

    // Filters: a search that matches nothing, then clearing it.
    await page.fill("#f-q", "zzz");
    await page.waitForSelector("#past .empty:has-text('No past meetings match')");
    await page.fill("#f-q", "");
    await page.waitForSelector("#past .mcard");

    // Open the meeting: its page has the player, the transcript and the title.
    await page.click("#past .mcard");
    await page.waitForSelector("#player video");
    assert.equal(new URL(page.url()).pathname, "/m/council-a");
    assert.equal(await page.getAttribute("#player video", "src"), "/media/council-a/council-a.mp4");
    await page.waitForSelector("#player .tline");
    assert.match(await page.textContent("#player .tline") ?? "", /Call to order\./);
    assert.match(await page.title(), /^council-a \(/);

    // An old shared link (/#recording) lands on the meeting's page.
    const old = await page.context().newPage();
    await old.goto(base + "/#council-a");
    await old.waitForURL(base + "/m/council-a");
    await old.waitForSelector("#player video");

    // An upcoming one: the banner and the countdown, no player.
    await page.goto(base + "/m/failed-d");
    await page.waitForSelector("#head .banner");
    assert.match(await page.textContent("#head .banner") ?? "", /Starts in/);
    assert.equal(await page.isHidden("#player"), true);
    // Hidden/unknown meetings are a plain 404, and nothing admin was fetched.
    assert.equal((await page.goto(base + "/m/hidden-b"))?.status(), 404);
    assert.ok(!requests.some((p) => p.startsWith("/api/admin") || p.startsWith("/admin")), requests.join(" "));
    // Media 206s for the fake 100-byte video show up as errors; ignore those, and the 404 page.
    assert.deepEqual(errors.filter((e) => !/media|video|MEDIA_ERR|Failed to load resource/i.test(e)), []);
  });
});

describe("sign-up and reset in Chromium", { skip: skipReason() }, () => {
  let browser: Browser, base: string, app: App;
  const mailer = new MemoryMailer();
  const cleanups: (() => unknown)[] = [];
  before(async () => {
    const hooks: HasAfter = { after: (fn) => cleanups.push(fn) };
    ({ app, base } = await startApp(hooks, path.join(tmpDir(hooks), "rec"), { secureCookie: false, mailer }));
    browser = await chromium.launch();
  });
  after(async () => {
    await browser?.close();
    for (const f of cleanups.reverse()) await f();
  });

  it("creates an account with the emailed code, then resets its password", async () => {
    const page = await (await browser.newContext()).newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));

    await page.goto(base + "/login");
    await page.click("#tosignup");
    await page.fill("#su-email", "reader@example.com");
    await page.fill("#su-name", "Reader");
    await page.fill("#su-password", "reader password 1");
    await page.fill("#su-confirm", "reader password 1");
    await page.click("#signupform button");
    await page.waitForSelector("#signupcodeform:not([hidden])");
    assert.match(await page.textContent("#signupsent") ?? "", /reader@example\.com/);
    await page.fill("#su-code", mailer.code("reader@example.com")!);
    await page.click("#signupcodeform button");
    await page.waitForURL(base + "/");
    await page.waitForSelector("#me a[href='/account']");
    assert.match(await page.textContent("#me") ?? "", /reader@example\.com/);
    assert.doesNotMatch(await page.textContent("#me") ?? "", /confirm your email/);
    assert.equal(app.accounts.byEmail("reader@example.com")?.role, "user");

    await page.click("#me a:has-text('sign out')");
    await page.waitForSelector("#me a:has-text('Sign in')");   // reloaded, signed out
    await page.goto(base + "/login");
    await page.fill("#email", "reader@example.com");
    await page.click("#toforgot");
    assert.equal(await page.inputValue("#fg-email"), "reader@example.com");
    await page.click("#forgotform button");
    await page.waitForSelector("#resetform:not([hidden])");
    await page.fill("#rs-code", mailer.code("reader@example.com")!);
    await page.fill("#rs-new", "reader password 2");
    await page.fill("#rs-confirm", "reader password 2");
    await page.click("#resetform button");
    await page.waitForSelector("#signin:not([hidden]) #loginmsg.ok");
    await page.fill("#password", "reader password 2");
    await page.click("#loginform button");
    await page.waitForURL(base + "/");
    assert.deepEqual(errors, []);
  });

  it("the admin's Users list promotes and disables", async () => {
    await app.accounts.create({ email: "boss@example.com", role: "admin", password: "boss password 1", verified: true });
    const page = await (await browser.newContext()).newPage();
    page.on("dialog", (d) => d.accept());
    await page.goto(base + "/login?next=%2Fadmin");
    await page.fill("#email", "boss@example.com");
    await page.fill("#password", "boss password 1");
    await page.click("#loginform button");
    await page.waitForURL(base + "/admin");
    const row = "#users .row:has-text('reader@example.com')";
    await page.waitForSelector(row);
    await page.click(`${row} button:has-text('Make admin')`);
    await page.waitForSelector(`${row} button:has-text('Make user')`);
    await page.click(`${row} button:has-text('Disable')`);
    await page.waitForSelector(`${row} button:has-text('Enable')`);
    assert.ok(app.accounts.byEmail("reader@example.com")?.disabledAt);
    assert.equal(await page.isVisible("#users .row:has-text('boss@example.com') button"), false);   // not yourself
    await page.waitForSelector("#audit .row:has-text('user.update')");
  });
});

describe("feeds page in Chromium", { skip: skipReason() }, () => {
  let browser: Browser, base: string, app: App, src: Awaited<ReturnType<typeof fakeSource>>;
  const cleanups: (() => unknown)[] = [];
  before(async () => {
    const hooks: HasAfter = { after: (fn) => cleanups.push(fn) };
    src = await fakeSource(hooks);
    ({ app, base } = await startApp(hooks, path.join(tmpDir(hooks), "rec"), { secureCookie: false, pollFeeds: false }));
    browser = await chromium.launch();
  });
  after(async () => {
    await browser?.close();
    for (const f of cleanups.reverse()) await f();
  });

  it("adds a feed with the generated form, previews it, runs it", async () => {
    src.state.meetings = [{ id: "m1", title: "Council Meeting", start: "2027-01-12T01:30:00Z", link: "https://zoom.us/j/87093163922?pwd=429539" }];
    await app.accounts.create({ email: "boss@example.com", role: "admin", password: "boss password 1", verified: true });
    const page = await (await browser.newContext()).newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("dialog", (d) => { errors.push("dialog: " + d.message()); void d.dismiss(); });
    await page.goto(base + "/login?next=%2Fadmin%2Ffeeds");
    await page.fill("#email", "boss@example.com");
    await page.fill("#password", "boss password 1");
    await page.click("#loginform button");
    await page.waitForURL(base + "/admin/feeds");
    await page.waitForSelector("#feeds .empty");

    await page.selectOption("#f-parser", "test-json");
    await page.fill("#f-name", "Langford council");
    await page.fill("#cfg-url", src.url);
    await page.fill("#f-prefix", "langford");
    await page.click("#previewbtn");
    await page.waitForSelector("#previewbody table");
    const row = await page.textContent("#previewbody table tr:nth-child(2)") ?? "";
    assert.match(row, /Council Meeting/);
    assert.match(row, /Zoom 87093163922/);
    assert.doesNotMatch(await page.content(), /429539/);

    await page.click("#savebtn");
    await page.waitForSelector("#feeds .row:has-text('Langford council')");
    await page.click("#feeds .row:has-text('Langford council') button:has-text('Run now')");
    await page.waitForSelector("#runsbody table");
    assert.match(await page.textContent("#runsbody table") ?? "", /ok/);
    await page.waitForSelector("#feeds .row:has-text('healthy')");

    // Review policy by default: the meeting waits in the queue; Approve schedules it.
    await page.reload();
    await page.waitForSelector("#review .row:has-text('Council Meeting') button:has-text('Approve')");
    await page.click("#review .row:has-text('Council Meeting') button:has-text('Approve')");
    await page.waitForSelector("#review .empty");
    await page.waitForSelector("#meetings .row:has-text('Council Meeting') .pill.s-scheduled");
    const rowText = await page.textContent("#meetings .row:has-text('Council Meeting')") ?? "";
    assert.match(rowText, /capture langford-council-meeting-/);
    assert.match(rowText, /join link Zoom 87093163922 \(passcode on file\)\s+no stream page yet/);
    assert.equal(await page.getAttribute("#meetings .row:has-text('Council Meeting') .links-line a", "href"), "https://zoom.us/j/87093163922");
    assert.doesNotMatch(await page.content(), /429539/);
    await page.click("#meetings .row:has-text('Council Meeting') button:has-text('History')");
    await page.waitForSelector("#meetings .row:has-text('Council Meeting') table");
    assert.match(await page.textContent("#meetings .row:has-text('Council Meeting') table") ?? "", /approved[\s\S]*added/);
    assert.equal(app.sched.list().length, 1);
    assert.deepEqual(errors, []);
  });
});
