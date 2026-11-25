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
import { startApp } from "./http.test.js";

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

    await page.goto(base + "/");
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
    await Promise.race([page.waitForURL(base + "/"), page.waitForSelector("#changemsg.err")]);
    if (new URL(page.url()).pathname !== "/") assert.fail("password change: " + await page.textContent("#changemsg"));
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
    await page.goto(base + "/");
    assert.equal(new URL(page.url()).pathname, "/login");
    assert.deepEqual(errors, []);
  });
});
