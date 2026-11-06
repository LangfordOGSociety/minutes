/**
 * One-time interactive sign-in. Opens a real browser window at the Zoom
 * sign-in page; a human signs in (captcha, 2FA, SSO all work because it's a
 * person doing it). The session cookies are saved as Playwright storage state,
 * which the recorder loads into its own browser. No password is ever stored.
 *
 * Run it on a machine with a screen (e.g. your laptop), then copy or mount
 * the file into the container. Storage state is plain JSON, so it moves
 * between platforms, unlike a Chrome profile.
 */
import { chmodSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { chromium, type Browser } from "playwright";
import { logger } from "./util.js";

const log = logger("login");

// Where Zoom lands after a successful sign-in. Best guess; if it doesn't
// match, close the window yourself and the last periodic save is kept.
const SIGNED_IN = /^https:\/\/([a-z0-9-]+\.)?zoom\.us\/(myhome|profile|meeting|user|home)|^https:\/\/app\.zoom\.us\/wc\/home/i;

export function saveStorageState(file: string, state: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}

export async function login(authFile: string): Promise<number> {
  let browser: Browser;
  try {
    // Prefer the installed Chrome: current version, and it's a normal browser
    // for a human to sign in with.
    browser = await chromium.launch({ channel: "chrome", headless: false });
  } catch {
    browser = await chromium.launch({ headless: false });
  }
  const ctx = await browser.newContext({ viewport: null });
  const page = await ctx.newPage();
  let open = true;
  browser.on("disconnected", () => { open = false; });
  page.on("close", () => { open = false; });

  await page.goto("https://zoom.us/signin");
  log.info(`sign in to Zoom in the browser window; session will be saved to ${authFile}`);

  // Don't call ctx.storageState() in this loop: in a headed browser it opens
  // a page per origin to read localStorage, which pops tabs and steals focus.
  // Poll the URL, and keep a cookies-only snapshot (no pages opened) in case
  // the window is closed before sign-in is detected.
  let saved = false;
  let signedIn = false;
  let cookies: Awaited<ReturnType<typeof ctx.cookies>> = [];
  while (open) {
    try {
      cookies = await ctx.cookies();
      if (SIGNED_IN.test(page.url())) {
        signedIn = true;
        await new Promise((r) => setTimeout(r, 2_000)); // let post-login cookies settle
        saveStorageState(authFile, await ctx.storageState());
        saved = true;
        log.info("signed in, session saved; closing the window");
        break;
      }
    } catch { /* window closing */ }
    await new Promise((r) => setTimeout(r, 2_000));
  }
  if (!saved && cookies.length) {
    saveStorageState(authFile, { cookies, origins: [] });
    saved = true;
  }
  try { await browser.close(); } catch { /* already closed */ }

  if (signedIn) return 0;
  log.warn(saved
    ? `window closed before sign-in was detected; kept the last save in ${authFile}, verify with a test join`
    : "window closed before anything was saved");
  return saved ? 0 : 1;
}
