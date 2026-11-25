/**
 * In Chromium: the media guard (CLAUDE.md "Invariants": nothing we hand the
 * page can send audio or video into a meeting) and the in-page classifier.
 * Needs Playwright's Chromium (`npx playwright install chromium`).
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { after, before, describe, it } from "node:test";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { mediaGuard } from "../src/platforms/guard.js";
import { MARKERS, pageAgent } from "../src/platforms/zoom.js";

function skipReason(): string | false {
  if (existsSync(chromium.executablePath())) return false;
  if (process.env.CI) throw new Error("Playwright's Chromium is required in CI");
  return "Playwright Chromium not installed";
}

// A real origin, so navigator.mediaDevices exists (secure context).
const ORIGIN = "https://meeting.test";

async function pageWith(ctx: BrowserContext, html: string): Promise<Page> {
  const page = await ctx.newPage();
  await page.route(`${ORIGIN}/**`, (r) => {
    const u = new URL(r.request().url());
    const body = u.pathname === "/frame" ? "<body>frame</body>" : html;
    return r.fulfill({ contentType: "text/html", body });
  });
  await page.goto(`${ORIGIN}/`);
  return page;
}

describe("in the browser", { skip: skipReason() }, () => {
  let browser: Browser;
  before(async () => {
    browser = await chromium.launch({
      args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required"],
    });
  });
  after(async () => { await browser?.close(); });

  describe("mediaGuard", () => {
    let ctx: BrowserContext;
    before(async () => {
      ctx = await browser.newContext({ permissions: ["microphone", "camera"] });
      await ctx.addInitScript(mediaGuard);
    });
    after(async () => { await ctx?.close(); });

    /** In the page (and its iframe): mic tracks, re-enable attempts, the
     *  peak level they carry, and what video and screen share requests get. */
    const probe = () => (async () => {
      const md = navigator.mediaDevices;
      const s = await md.getUserMedia({ audio: true, video: true });
      const t = s.getAudioTracks()[0];
      t.enabled = true;
      const c = t.clone();
      c.enabled = true;
      // Chromium's fake mic beeps about once a second: sample for 2.5s.
      const ac = new AudioContext();
      await ac.resume();
      const an = ac.createAnalyser();
      ac.createMediaStreamSource(new MediaStream([t, c])).connect(an);
      const buf = new Float32Array(an.fftSize);
      let peak = 0;
      for (let i = 0; i < 50; i++) {
        await new Promise((r) => setTimeout(r, 50));
        an.getFloatTimeDomainData(buf);
        for (const v of buf) peak = Math.max(peak, Math.abs(v));
      }
      const err = (p: Promise<unknown>) => p.then(() => "allowed", (e) => (e as DOMException).name);
      return {
        video: s.getVideoTracks().length,
        audio: s.getAudioTracks().length,
        enabled: t.enabled, cloneEnabled: c.enabled, peak,
        cameraOnly: await err(md.getUserMedia({ video: true })),
        screen: await err(md.getDisplayMedia({ video: true })),
      };
    })();

    it("mutes every mic track and refuses camera and screen, also in iframes", async () => {
      const page = await pageWith(ctx, `<body><iframe src="${ORIGIN}/frame" allow="microphone; camera"></iframe></body>`);
      await page.waitForFunction(() => document.querySelector("iframe")?.contentDocument?.readyState === "complete");
      const expected = { video: 0, audio: 1, enabled: false, cloneEnabled: false, peak: 0,
        cameraOnly: "NotAllowedError", screen: "NotAllowedError" };
      assert.deepEqual(await page.evaluate(probe), expected);
      const frame = page.frames().find((f) => f.url().endsWith("/frame"));
      assert.ok(frame);
      assert.deepEqual(await frame.evaluate(probe), expected);
    });

    it("the fake mic is audible without the guard (so peak 0 means something)", async () => {
      const bare = await browser.newContext({ permissions: ["microphone"] });
      try {
        const page = await pageWith(bare, "<body></body>");
        const peak = await page.evaluate(async () => {
          const s = await navigator.mediaDevices.getUserMedia({ audio: true });
          const ac = new AudioContext();
          await ac.resume();
          const an = ac.createAnalyser();
          ac.createMediaStreamSource(s).connect(an);
          const buf = new Float32Array(an.fftSize);
          let peak = 0;
          for (let i = 0; i < 50; i++) {
            await new Promise((r) => setTimeout(r, 50));
            an.getFloatTimeDomainData(buf);
            for (const v of buf) peak = Math.max(peak, Math.abs(v));
          }
          return peak;
        });
        assert.ok(peak > 0.01, `peak ${peak}`);
      } finally {
        await bare.close();
      }
    });
  });

  describe("pageAgent classifier", () => {
    let ctx: BrowserContext;
    before(async () => {
      ctx = await browser.newContext();
      await ctx.addInitScript(pageAgent, MARKERS);
    });
    after(async () => { await ctx?.close(); });

    const LEAVE = `<footer id="wc-footer"><button aria-label="Leave">Leave</button></footer>`;
    const cases: [string, string][] = [
      ["loading", `<div>Loading...</div>`],
      ["prejoin", `<input id="input-for-name"><button>Join</button>`],
      ["waiting", `<div>Host has joined. We've let them know you're here.</div>`],
      ["blocked", `<div>Automated bots aren't allowed to join this meeting.</div>`],
      ["invalid", `<div>This meeting link is invalid (3,001)</div>`],
      ["ended", `<div>This webinar has been ended by host</div>`],
      ["in_meeting", LEAVE],
      // Chat and captions can't end a recording: only overlays count in the meeting.
      ["in_meeting", `${LEAVE}<div class="chat">the meeting has ended, see you</div>`],
      ["in_meeting", `${LEAVE}<div role="dialog"><textarea></textarea>meeting has been ended</div>`],
      ["ended", `${LEAVE}<div role="dialog">This meeting has been ended by host <button>OK</button></div>`],
      ["reconnecting", `${LEAVE}<div class="loading-layer">Meeting Disconnected. Trying to reconnect...</div>`],
    ];
    for (const [want, html] of cases) {
      it(`${want}: ${html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 60) || "(markup only)"}`, async () => {
        const page = await pageWith(ctx, `<body>${html}</body>`);
        try {
          assert.equal(await page.evaluate(() => (window as any).__ccClassify()), want);
        } finally {
          await page.close();
        }
      });
    }

    it("hides Zoom's own UI without removing it", async () => {
      const page = await pageWith(ctx, `<body>${LEAVE}<div id="notificationManager">toast</div></body>`);
      await page.waitForSelector("#__cc-hide", { state: "attached" });
      assert.equal(await page.$eval("#wc-footer", (e) => getComputedStyle(e).opacity), "0");
      assert.equal(await page.$eval("#notificationManager", (e) => getComputedStyle(e).opacity), "0");
      await page.close();
    });
  });
});
