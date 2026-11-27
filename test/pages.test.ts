/**
 * The pages in Chromium against the real server: sign-in, the forced
 * password change, the admin page. Needs Playwright's Chromium.
 */
import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
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
    await page.click("#tabs a[href='#captures']");
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
    await page.click("#tabs a[href='#audit']");
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
  it("account page: create an API token (shown once), see it listed, use it, revoke it", async () => {
    await app.accounts.create({ email: "dev@example.com", role: "user", password: "developer password", verified: true });
    const page = await (await browser.newContext()).newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("dialog", (d) => void d.accept());
    await page.goto(base + "/login?next=/account");
    await page.fill("#email", "dev@example.com");
    await page.fill("#password", "developer password");
    await page.click("#loginform button");
    await page.waitForSelector("#tokens:not([hidden])");
    await page.fill("#tk-label", "archive script");
    await page.selectOption("#tk-exp", "30");
    await page.click("#tokform button");
    await page.waitForSelector("#newtok:not([hidden])");
    const tok = await page.inputValue("#newtokval");
    assert.match(tok, /^mnt_[0-9a-f]{8}_[A-Za-z0-9_-]{43}$/);
    await page.waitForSelector("#toklist .tok:has-text('archive script')");
    assert.match(await page.textContent("#toklist") ?? "", /can download.*expires/);
    assert.ok(!(await page.textContent("#toklist") ?? "").includes(tok.slice(13)), "the list never shows the secret");
    const call = async () => (await fetch(base + "/api/v1/me", { headers: { authorization: `Bearer ${tok}` } })).status;
    assert.equal(await call(), 200);
    await page.click("#toklist .tok:has-text('archive script') button");
    await page.waitForSelector("#toklist .tok.off:has-text('revoked')");
    assert.equal(await call(), 401);
    assert.deepEqual(errors, []);
  });
});

describe("public page in Chromium", { skip: skipReason() }, () => {
  let browser: Browser, base: string, app: App, out: string;
  const cleanups: (() => unknown)[] = [];
  before(async () => {
    const hooks: HasAfter = { after: (fn) => cleanups.push(fn) };
    out = path.join(tmpDir(hooks), "rec");
    // Chromium drops __Host- cookies on plain http, so sessions need COOKIE_SECURE=0 here (as in the other describes that sign in).
    ({ app, base } = await startApp(hooks, out, { secureCookie: false }));
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
    assert.deepEqual((await page.$$eval("#upcoming .mcard .t", (els) => els.map((e) => e.textContent))).sort(), ["failed-d", "live-e"]);
    assert.equal(await page.isVisible("#livenow"), false);   // "Live now" only shows when a meeting is live
    assert.deepEqual(await page.$$eval("#past .mcard .t", (els) => els.map((e) => e.textContent)), ["council-a"]);
    assert.match(await page.textContent("#past .mcard .mh") ?? "", /video \+ transcript/);
    assert.match(await page.textContent("#sitenav") ?? "", /Meetings.*Search.*Embed & API/);
    assert.equal(await page.textContent("#me"), "Sign in");
    assert.match(await page.textContent("#updates") ?? "", /Nothing has changed lately|Announced/);

    // Filters: a search that matches nothing, then clearing it.
    await page.click("#filt summary");
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

  it("the share box: permalink, embed code with the chosen options", async () => {
    const page = await (await browser.newContext()).newPage();
    await page.goto(base + "/m/council-a?t=5");
    await page.waitForSelector("#share input[type=text]");
    assert.equal(await page.inputValue("#share input[type=text]"), base + "/m/council-a");
    await page.click("#share summary");
    assert.match(await page.inputValue("#share textarea"), /^<iframe src="http:\/\/127\.0\.0\.1:\d+\/embed\/council-a" width="640" height="360" /);
    await page.check("#share .opt:has-text('transcript') input");
    await page.check("#share .opt:has-text('chapters') input");
    assert.match(await page.inputValue("#share textarea"), /\/embed\/council-a\?transcript=1&amp;chapters=1" width="640" height="640"/);
    assert.equal(await page.isVisible("#share button:has-text('Copy link at current time')"), true);
    // Another name for the same meeting (the capture's folder) lands on the permalink.
    await page.goto(base + "/m/council-a");
    assert.equal(new URL(page.url()).pathname, "/m/council-a");
  });

  it("another site can frame /embed/<slug> and play it; the meeting page can't be framed", async () => {
    // A second origin (another port) standing in for openlangford.ca.
    const other = http.createServer((req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<!doctype html><title>host</title><iframe id="e" src="${base}/embed/council-a?transcript=1&title=1" width="640" height="560"></iframe>` +
        `<iframe id="m" src="${base}/m/council-a" width="640" height="300"></iframe>`);
    });
    await new Promise<void>((r) => other.listen(0, "127.0.0.1", r));
    try {
      const hostUrl = `http://localhost:${(other.address() as AddressInfo).port}/`;   // localhost vs 127.0.0.1: a different site
      const page = await (await browser.newContext()).newPage();
      await page.goto(hostUrl);
      const frame = page.frames().find((f) => f.url().includes("/embed/council-a"))!;
      await frame.waitForSelector("video");
      assert.equal(await frame.getAttribute("video", "src"), "/media/council-a/council-a.mp4");
      await frame.waitForSelector(".tline");
      assert.match(await frame.textContent(".tline") ?? "", /Call to order\./);
      assert.equal(await frame.textContent(".tbar a"), "council-a");
      assert.equal(await frame.getAttribute(".tbar a", "target"), "_blank");
      // The meeting page refuses to be framed: its frame never gets the page.
      const blocked = page.frames().find((f) => f.url().includes("/m/council-a"));
      assert.ok(!blocked || (await blocked.$("#head")) === null, "the meeting page rendered inside another site's frame");
    } finally {
      await new Promise<void>((r) => { other.closeAllConnections(); other.close(() => r()); });
    }
  });
  it("search: the home page's box, highlighted passages, a link at the second", async () => {
    const page = await (await browser.newContext()).newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(base + "/");
    await page.fill(".hsearch input", "call to order");
    await page.press(".hsearch input", "Enter");
    await page.waitForURL(/\/search\?q=call\+to\+order/);
    await page.waitForSelector("#hits .hit");
    assert.match(await page.textContent("#summary") ?? "", /1 passage for call to order/);
    assert.equal(await page.inputValue("#q"), "call to order");
    assert.deepEqual(await page.$$eval("#hits .hit mark", (els) => els.map((e) => e.textContent?.toLowerCase())), ["call", "to", "order"]);
    assert.equal(await page.getAttribute("#hits .hit a.t", "href"), "/m/council-a?t=1");
    assert.match(await page.textContent("#hits .hit .m") ?? "", /at 0:01/);
    await page.fill("#q", "nonexistentword");
    await page.press("#q", "Enter");
    await page.waitForSelector("#hits .empty");
    assert.match(await page.textContent("#summary") ?? "", /Nothing found for nonexistentword/);
    // A search is a link: it works from a fresh load with the filter in the URL.
    await page.goto(base + "/search?q=order&body=Nope");
    await page.waitForSelector("#hits .empty");
    assert.deepEqual(errors, []);
  });
  it("an admin names a speaker; the public meeting page shows the name", async () => {
    writeFileSync(path.join(out, "council-a", "council-a.transcript.json"), JSON.stringify({ segments: [{ start: 1, end: 5, text: "Call to order.", label: "Speaker 1" }] }));
    await app.accounts.create({ email: "chair@example.com", role: "admin", password: "chair password 12", verified: true });
    const page = await (await browser.newContext()).newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(base + "/login?next=/admin");
    await page.fill("#email", "chair@example.com");
    await page.fill("#password", "chair password 12");
    await page.click("#loginform button");
    await page.waitForURL(base + "/admin");
    await page.click("#tabs a[href='#recordings']");
    await page.click("#recs .row:has-text('council-a') button:has-text('Speakers')");
    await page.waitForSelector("#recs .spk input");
    assert.match(await page.textContent("#recs .spk") ?? "", /Speaker 1 .*Call to order/);
    await page.fill("#recs .spk input", "Marie Watmo");
    await page.click("#recs button:has-text('Save names')");
    await page.waitForSelector("#recs .msg.ok");
    const pub = await (await browser.newContext()).newPage();
    pub.on("pageerror", (e) => errors.push(e.message));
    await pub.goto(base + "/m/council-a");
    await pub.waitForSelector("#player .tline .tw");
    assert.equal(await pub.textContent("#player .tline .tw"), "Marie Watmo");
    assert.match(await pub.textContent("#player .transcript") ?? "", /Some speaker names were added by hand/);
    assert.deepEqual(errors, []);
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
    await page.click("#tabs a[href='#people']");
    const row = "#users .row:has-text('reader@example.com')";
    await page.waitForSelector(row);
    await page.click(`${row} button:has-text('Make admin')`);
    await page.waitForSelector(`${row} button:has-text('Make user')`);
    await page.click(`${row} button:has-text('Disable')`);
    await page.waitForSelector(`${row} button:has-text('Enable')`);
    assert.ok(app.accounts.byEmail("reader@example.com")?.disabledAt);
    assert.equal(await page.isVisible("#users .row:has-text('boss@example.com') button"), false);   // not yourself
    await page.click("#tabs a[href='#audit']");
    await page.waitForSelector("#audit .row:has-text('user.update')");
  });
  it("alerts: made from a search, listed and deleted on the account page, stopped from the email's link", async () => {
    await app.accounts.create({ email: "watcher@example.com", role: "user", password: "watcher password 1", verified: true });
    const page = await (await browser.newContext()).newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    // Signed out: the search offers to sign in.
    await page.goto(base + "/search?q=harbour");
    await page.waitForSelector("#alertbox a");
    assert.match(await page.getAttribute("#alertbox a", "href") ?? "", /^\/login\?next=%2Fsearch%3Fq%3Dharbour$/);
    await page.click("#alertbox a");
    await page.fill("#email", "watcher@example.com");
    await page.fill("#password", "watcher password 1");
    await page.click("#loginform button");
    await page.waitForURL(/\/search\?q=harbour/);
    await page.click("#alertbox button");
    await page.waitForSelector("#alertbox .msg.ok");
    assert.match(await page.textContent("#alertbox") ?? "", /Saved/);
    await page.click("#alertbox button", { force: true }).catch(() => {});    // disabled now: no second alert
    await page.goto(base + "/account#alerts");
    await page.waitForSelector("#alertlist .tok");
    assert.match(await page.textContent("#alertlist") ?? "", /harbour.*last email none yet/);
    await page.fill("#al-q", "zoning");
    await page.click("#alertform button");
    await page.waitForSelector("#alertlist .tok:nth-child(2)");
    await page.click("#alertlist .tok:has-text('zoning') button");
    await page.waitForSelector("#alertlist .tok:nth-child(2)", { state: "detached" });
    // The email's link asks first, then stops it, with no sign-in.
    const u = app.accounts.byEmail("watcher@example.com")!;
    const token = app.alerts.list(u.id)[0].token;
    const anon = await (await browser.newContext()).newPage();
    anon.on("pageerror", (e) => errors.push(e.message));
    await anon.goto(`${base}/alerts/${token}/stop`);
    await anon.waitForSelector("#box button");
    assert.match(await anon.textContent("#box") ?? "", /harbour/);
    assert.equal(app.alerts.list(u.id).length, 1);                                  // opening the page stopped nothing
    await anon.click("#box button");
    await anon.waitForSelector("#box:has-text('Stopped')");
    assert.equal(app.alerts.list(u.id).length, 0);
    await anon.goto(`${base}/alerts/${token}/stop`);
    await anon.waitForSelector("#box:has-text('already stopped')");
    assert.deepEqual(errors, []);
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

describe("redesigned pages in Chromium", { skip: skipReason() }, () => {
  let browser: Browser, base: string, app: App, out: string;
  const cleanups: (() => unknown)[] = [];
  before(async () => {
    const hooks: HasAfter = { after: (fn) => cleanups.push(fn) };
    out = path.join(tmpDir(hooks), "rec");
    ({ app, base } = await startApp(hooks, out, { secureCookie: false }));
    fixtures(app, out);
    browser = await chromium.launch();
  });
  after(async () => {
    await browser?.close();
    for (const f of cleanups.reverse()) await f();
  });

  async function signIn(email: string, password: string, next: string) {
    const page = await (await browser.newContext()).newPage();
    page.on("dialog", (d) => void d.accept());
    await page.goto(base + "/login?next=" + encodeURIComponent(next));
    await page.fill("#email", email);
    await page.fill("#password", password);
    await page.click("#loginform button");
    await page.waitForURL(base + next);
    return page;
  }

  it("/embed/upcoming lists the next meetings and may be framed", async () => {
    const r = await fetch(base + "/embed/upcoming?limit=3");
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("x-frame-options"), null);
    assert.match(r.headers.get("content-security-policy") ?? "", /frame-ancestors/);
    const page = await (await browser.newContext()).newPage();
    await page.goto(base + "/embed/upcoming?limit=3&theme=dark&title=0");
    await page.waitForSelector(".mcard");
    assert.equal(await page.getAttribute("html", "data-theme"), "dark");
    assert.equal(await page.getAttribute(".mcard", "target"), "_blank");
    assert.equal(await page.isHidden("#h"), true);
    await page.goto(base + "/embed/upcoming?source=Nowhere");
    await page.waitForSelector(".empty:has-text('No upcoming meetings')");
  });

  it("account: tabs, an embed builder for a meeting and for the upcoming list", async () => {
    await app.accounts.create({ email: "embedder@example.com", role: "user", password: "embedder password", verified: true });
    const page = await signIn("embedder@example.com", "embedder password", "/account");
    await page.waitForSelector("#tokens:not([hidden])");           // API keys first
    assert.equal(await page.isHidden("#p-embed"), true);
    assert.match(await page.textContent("#snip") ?? "", /Authorization: Bearer mnt_/);
    await page.click("#tabs a[href='#embed']");
    await page.waitForSelector("#p-embed:not([hidden])");
    assert.equal(await page.isHidden("#tokens"), true);
    await page.selectOption("#em-m", "council-a");
    await page.check("#em-tr");
    assert.match(await page.inputValue("#em-code"), /\/embed\/council-a\?transcript=1" width="640" height="640"/);
    assert.match(await page.inputValue("#up-code"), /\/embed\/upcoming\?limit=5" width="420"/);
    await page.fill("#up-n", "3");
    await page.selectOption("#up-th", "dark");
    assert.match(await page.inputValue("#up-code"), /\/embed\/upcoming\?limit=3&theme=dark" width="420" height="322"/);
    // The tab is a link: a fresh load of /account#embed opens it.
    await page.goto(base + "/account#embed");
    await page.waitForSelector("#p-embed:not([hidden])");
  });

  it("admin: tabs, and an overview of what is running and what needs attention", async () => {
    await app.accounts.create({ email: "ops@example.com", role: "admin", password: "ops password 1", verified: true });
    const page = await signIn("ops@example.com", "ops password 1", "/admin");
    await page.waitForSelector("#now .row, #now .empty");
    assert.equal(await page.isVisible("#t-overview"), true);
    assert.equal(await page.isHidden("#t-people"), true);
    await page.waitForSelector("#next .row:has-text('live-e')");   // scheduled capture listed under Coming up
    await page.click("#tabs a[href='#people']");
    await page.waitForSelector("#users .row:has-text('ops@example.com')");
    assert.equal(await page.isHidden("#t-overview"), true);
    await page.click("#tabs a[href='#audit']");
    await page.waitForSelector("#t-audit:not([hidden])");
    assert.match(await page.textContent("#sitenav") ?? "", /Admin/);
  });
});
