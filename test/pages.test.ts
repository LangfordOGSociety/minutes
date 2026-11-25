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
import { fixtures } from "./fixtures.js";

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

  it("lists published recordings, plays one with its transcript, follows a live one", async () => {
    const page = await (await browser.newContext()).newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
    const requests: string[] = [];
    page.on("request", (r) => requests.push(new URL(r.url()).pathname));

    await page.goto(base + "/");
    await page.waitForSelector("#recs .row");
    const titles = await page.$$eval("#recs .row .title", (els) => els.map((e) => e.textContent));
    assert.deepEqual(titles.sort(), ["council-a", "livelive-e"]);
    assert.equal(await page.textContent("#me"), "Sign in");

    await page.click("#recs .row:has-text('council-a') button:has-text('Play')");
    await page.waitForSelector("#player video");
    assert.equal(await page.getAttribute("#player video", "src"), "/media/council-a/council-a.mp4");
    await page.waitForSelector("#player .tline");
    assert.match(await page.textContent("#player .tline") ?? "", /Call to order\./);
    assert.equal(new URL(page.url()).hash, "#council-a");

    await page.click("#recs .row:has-text('live-e') button:has-text('Live transcript')");
    await page.waitForSelector("#livebox .tline");
    assert.match(await page.textContent("#livebox") ?? "", /Good evening\./);
    assert.equal(await page.isHidden("#player"), true);

    // A shared link (fresh page load) opens the recording.
    const shared = await page.context().newPage();
    await shared.goto(base + "/#council-a");
    await shared.waitForSelector("#player video");

    assert.ok(!requests.some((p) => p.startsWith("/api/admin") || p.startsWith("/admin")), requests.join(" "));
    // Media 206s for the fake 100-byte video show up as errors; ignore those.
    assert.deepEqual(errors.filter((e) => !/media|video|MEDIA_ERR|Failed to load resource/i.test(e)), []);
  });
});
