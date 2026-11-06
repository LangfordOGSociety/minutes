/**
 * Zoom web client session.
 *
 * Detection runs *inside* the page: an init script installs an agent in every
 * frame that classifies the screen and watches the DOM with a
 * MutationObserver. When the classification changes it calls back into Node
 * through an exposed binding, which wakes the runner immediately instead of
 * waiting for the next poll.
 *
 * Everything Zoom-specific is in MARKERS and the selectors below. Zoom
 * changes its web client regularly, so verify these against a live meeting
 * (a committee meeting is a good low-stakes test) before council night.
 */
import { chromium, type Browser, type Locator, type Page } from "playwright";
import { TIMEOUT, logger, withTimeout } from "./util.js";

const log = logger("zoom");

export enum State {
  LOADING = "loading",           // page coming up / unrecognised screen
  PREJOIN = "prejoin",           // name entry or preview
  WAITING = "waiting",           // waiting for host, webinar not started
  IN_MEETING = "in_meeting",
  RECONNECTING = "reconnecting", // in meeting, Zoom says the link is bad
  ENDED = "ended",
  DEAD = "dead",                 // browser or page gone
}

// When frames disagree, the most significant answer wins.
const PRIORITY: Record<string, number> = {
  loading: 0, prejoin: 1, waiting: 2, in_meeting: 3, reconnecting: 4, ended: 5,
};

// --- markers: VERIFY AGAINST A LIVE MEETING ------------------------------
export const MARKERS = {
  ended: String.raw`meeting (has been|has) ended|webinar (has|is) (ended|over)|host (has )?removed you|meeting is no longer available`,
  waiting: String.raw`waiting for (the )?host|webinar (has not|hasn't) (yet )?started|will begin soon|host will let you in|meeting has not started`,
  reconnect: String.raw`reconnecting|connection (lost|is unstable)|unable to connect`,
  // Footer controls stay in the DOM when auto-hidden. Plain CSS only, these
  // run in the page via querySelector.
  inMeeting: ["button[aria-label*='Leave' i]", ".footer__leave-btn"],
  name: ["#input-for-name", "input[placeholder*='name' i]"],
  // While in the meeting, ended/reconnect text is only trusted inside these
  // overlays, so chat messages and captions can't end or drop a recording.
  // Overlays holding a text input (chat, Q&A panels) are skipped.
  overlays: ["[role='dialog']", "[role='alertdialog']", "[aria-modal='true']", "[role='alert']"],
};
const JOIN_BUTTON = /^\s*join\s*$/i;
const JOIN_AUDIO = /join audio by computer|join with computer audio/i;
const MUTE_SELECTOR = "button[aria-label*='mute my microphone' i]";
// -------------------------------------------------------------------------

type Markers = typeof MARKERS;

/**
 * Runs inside every frame. Serialized by Playwright, so it must be fully
 * self-contained: no references to anything outside this function.
 */
function pageAgent(m: Markers): void {
  const w = window as any;
  if (w.__ccClassify) return;

  const ended = new RegExp(m.ended, "i");
  const waiting = new RegExp(m.waiting, "i");
  const reconnect = new RegExp(m.reconnect, "i");
  const has = (sels: string[]) =>
    sels.some((s) => {
      try { return !!document.querySelector(s); } catch { return false; }
    });

  const overlayText = (): string => {
    const seen = new Set<Element>();
    for (const s of m.overlays) {
      try { document.querySelectorAll(s).forEach((el) => seen.add(el)); } catch { /* bad selector */ }
    }
    let out = "";
    for (const el of seen) {
      if (el.querySelector("textarea, input[type='text'], [contenteditable='true']")) continue;
      out += "\n" + ((el as HTMLElement).innerText ?? "");
    }
    return out;
  };

  w.__ccClassify = (): string => {
    if (has(m.inMeeting)) {
      // Meeting UI is up: the page body includes chat and captions, so only
      // read status overlays.
      const text = overlayText();
      if (ended.test(text)) return "ended";
      return reconnect.test(text) ? "reconnecting" : "in_meeting";
    }
    const text = document.body?.innerText ?? "";
    if (ended.test(text)) return "ended";
    if (waiting.test(text)) return "waiting";
    if (has(m.name)) return "prejoin";
    return "loading";
  };

  // Zoom's DOM churns constantly (timers, tiles), so coalesce mutations and
  // only signal Node when the classification actually changes.
  let last = "";
  let timer: ReturnType<typeof setTimeout> | null = null;
  const check = () => {
    timer = null;
    let s: string;
    try { s = w.__ccClassify(); } catch { return; }
    if (s !== last) {
      last = s;
      try { w.__ccSignal?.(s); } catch { /* binding not ready yet */ }
    }
  };
  const observe = () => {
    new MutationObserver(() => { timer ??= setTimeout(check, 400); })
      .observe(document.documentElement, { childList: true, subtree: true, characterData: true });
    check();
  };
  if (document.documentElement) observe();
  else document.addEventListener("DOMContentLoaded", observe, { once: true });
}

/** Invite link (zoom.us/j/<id>?pwd=...) or bare ID -> browser client URL. */
export function webClientUrl(link: string): string {
  const digits = link.replace(/[\s-]/g, "");
  if (/^\d+$/.test(digits)) return `https://app.zoom.us/wc/join/${digits}`;
  let u: URL;
  try { u = new URL(link); } catch { return link; }
  const m = u.pathname.match(/\/(?:j|w|wc\/join|wc)\/(\d{9,12})/);
  if (!m) return link;
  const pwd = u.searchParams.get("pwd");
  return `https://app.zoom.us/wc/join/${m[1]}` + (pwd ? `?pwd=${pwd}` : "");
}

export class ZoomSession {
  readonly url: string;
  private browser?: Browser;
  private page?: Page;
  private dead = false;
  private audioJoined = false;
  private muteChecked = false;

  /** Called whenever the page agent reports a change, or the browser dies. */
  onChange: (state: string) => void = () => {};

  constructor(link: string, private displayName: string,
              private width: number, private height: number) {
    this.url = webClientUrl(link);
  }

  private markDead(why: string): void {
    if (this.dead) return;
    this.dead = true;
    log.warn(`browser gone: ${why}`);
    this.onChange("dead");
  }

  async open(): Promise<void> {
    this.browser = await chromium.launch({
      headless: false, // must render to the Xvfb display for x11grab
      args: [
        "--kiosk",
        "--window-position=0,0",
        `--window-size=${this.width},${this.height}`,
        "--autoplay-policy=no-user-gesture-required",
        "--use-fake-ui-for-media-stream", // auto-accept the mic prompt
        "--disable-dev-shm-usage",
        "--no-first-run",
        "--disable-infobars",
      ],
    });
    this.browser.on("disconnected", () => this.markDead("disconnected"));

    const ctx = await this.browser.newContext({ viewport: null });
    // Mic only; the container's default source is a silent null sink so
    // nothing ever reaches the meeting. No camera permission at all.
    await ctx.grantPermissions(["microphone"], { origin: "https://app.zoom.us" });
    await ctx.exposeBinding("__ccSignal", (_src, s: string) => {
      log.debug(`agent signal: ${s}`);
      this.onChange(s);
    });
    await ctx.addInitScript(pageAgent, MARKERS);

    this.page = await ctx.newPage();
    this.page.on("crash", () => this.markDead("renderer crashed"));
    this.page.on("close", () => this.markDead("page closed"));
    log.info(`opening ${this.url}`);
    await this.page.goto(this.url, { waitUntil: "domcontentloaded", timeout: 60_000 });
  }

  async close(): Promise<void> {
    try { await withTimeout(this.browser?.close() ?? Promise.resolve(), 15_000); } catch { /* already gone */ }
  }

  /** Ask every frame's agent for its view and take the strongest answer.
   *  Doubles as a health check: a hung renderer times out here. */
  async state(): Promise<State> {
    if (this.dead) return State.DEAD;
    if (!this.page) return State.LOADING;
    const answers = await withTimeout(
      Promise.all(this.page.frames().map((f) =>
        f.evaluate(() => (window as any).__ccClassify?.() ?? "loading").catch(() => "loading"),
      )),
      15_000,
    );
    if (answers === TIMEOUT) {
      log.warn("page didn't answer within 15s");
      return this.dead ? State.DEAD : State.LOADING;
    }
    let best = "loading";
    for (const a of answers as string[]) {
      if ((PRIORITY[a] ?? 0) > (PRIORITY[best] ?? 0)) best = a;
    }
    return best as State;
  }

  private async find(selectors: string[]): Promise<Locator | null> {
    for (const frame of this.page?.frames() ?? []) {
      for (const sel of selectors) {
        try {
          const loc = frame.locator(sel);
          if (await loc.count()) return loc.first();
        } catch { /* frame detached */ }
      }
    }
    return null;
  }

  private async findButton(name: RegExp): Promise<Locator | null> {
    for (const frame of this.page?.frames() ?? []) {
      try {
        const loc = frame.getByRole("button", { name });
        if ((await loc.count()) && (await loc.first().isVisible())) return loc.first();
      } catch { /* frame detached */ }
    }
    return null;
  }

  /** Do whatever the current screen needs to get us further in. */
  async advance(state: State): Promise<void> {
    try {
      if (state === State.PREJOIN) {
        const name = await this.find(MARKERS.name);
        if (name && !(await name.inputValue())) await name.fill(this.displayName);
        const btn = await this.findButton(JOIN_BUTTON);
        if (btn && (await btn.isEnabled())) {
          log.info(`clicking Join as "${this.displayName}"`);
          await btn.click();
        }
      } else if (state === State.IN_MEETING) {
        if (!this.audioJoined) {
          const btn = await this.findButton(JOIN_AUDIO);
          if (btn) {
            log.info("joining computer audio");
            await btn.click();
            this.audioJoined = true;
          }
        }
        if (!this.muteChecked) {
          const mute = await this.find([MUTE_SELECTOR]);
          if (mute) {
            // Selector also matches "Unmute my microphone", so only click
            // when the label says we're live.
            const label = ((await mute.getAttribute("aria-label")) ?? "").trim().toLowerCase();
            if (label.startsWith("mute")) {
              await mute.click();
              log.info("mic muted");
            }
            this.muteChecked = true;
          }
        }
      }
    } catch (e) {
      log.debug(`advance(${state}) hiccup`, e);
    }
  }
}
