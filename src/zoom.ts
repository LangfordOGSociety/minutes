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
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "playwright";
import { saveStorageState } from "./login.js";
import { TIMEOUT, logger, withTimeout } from "./util.js";

const log = logger("zoom");

export enum State {
  LOADING = "loading",           // page coming up / unrecognised screen
  PREJOIN = "prejoin",           // name entry or preview
  WAITING = "waiting",           // waiting for host, webinar not started
  IN_MEETING = "in_meeting",
  RECONNECTING = "reconnecting", // in meeting, Zoom says the link is bad
  ENDED = "ended",
  BLOCKED = "blocked",           // Zoom refused us (bot check, sign-in required)
  INVALID = "invalid",           // the link/ID doesn't point at a meeting
  DEAD = "dead",                 // browser or page gone
}

// When frames disagree, the most significant answer wins.
const PRIORITY: Record<string, number> = {
  loading: 0, prejoin: 1, waiting: 2, in_meeting: 3, reconnecting: 4, ended: 5, blocked: 6, invalid: 6,
};

// --- markers: VERIFY AGAINST A LIVE MEETING ------------------------------
export const MARKERS = {
  ended: String.raw`meeting (has been|has) ended|webinar (has|is) (ended|over)|host (has )?removed you|meeting is no longer available`,
  // "Host has joined. We've let them know you're here." seen live 2026-11-05
  // in the waiting room of a signed-in join.
  waiting: String.raw`let them know you.re here|waiting room|waiting for (the )?host|webinar (has not|hasn't) (yet )?started|will begin soon|host will let you in|meeting has not started`,
  // Seen live 2026-11-05 on a 70s network cut: a sr-only role=alert says
  // "Reconnecting" once, then a full-screen .loading-layer shows "Meeting
  // Disconnected / Trying to reconnect...", and after the network returns a
  // zm-modal dialog "Joining Meeting Timeout or Browser restriction ... Your
  // network connection has timed out" with Retry / Leave. All of these mean
  // the feed is dead; the runner's grace window then rejoins.
  reconnect: String.raw`reconnecting|trying to reconnect|meeting disconnected|joining meeting timeout|network connection has timed out|connection (lost|is unstable)|unable to connect`,
  // Seen live 2026-11-05 (join API errorCode 9516): "Automated bots aren't
  // allowed to join this meeting. If this was a mistake and you are a human,
  // sign in to join the meeting." Also any redirect to the sign-in page.
  blocked: String.raw`bots aren.t allowed to join|sign in to join (this|the) meeting|only (signed[- ]in|authenticated) users can join`,
  blockedPath: String.raw`^/signin`,
  // Seen live 2026-11-06 for a made-up ID: "This meeting link is invalid (3,001)".
  invalid: String.raw`meeting link is invalid|invalid meeting id|meeting id is (not valid|invalid)|this meeting (id )?does not exist`,
  // Footer controls stay in the DOM when auto-hidden. Plain CSS only, these
  // run in the page via querySelector.
  inMeeting: ["button[aria-label*='Leave' i]", ".footer__leave-btn"],
  // Who Zoom shows as speaking (live DOM, 2026-11-05): the name label on the
  // big tile in speaker view, else the highlighted thumbnail in the strip
  // (e.g. while a screen share takes the main area). First match wins.
  // Zoom's own live captions (CC / live transcription). The container is in
  // the DOM (empty) in every meeting; it fills only when the host has
  // captions on and this participant shows them. Text read via textContent.
  captions: [".lt-subtitle-wrap"],
  // Best guess, NOT seen live yet: the footer / More-menu item that turns
  // captions on for this participant. Matched against the accessible name.
  showCaptions: String.raw`^\s*(show captions|captions|closed captions?|cc)\s*$`,
  activeSpeaker: [
    ".speaker-active-container__video-frame .video-avatar__avatar-footer",
    ".speaker-bar-container__video-frame--active .video-avatar__avatar-footer",
  ],
  // Recording-consent notice ("This meeting is being recorded", seen live
  // 2026-11-09 on Oak Bay). Dismissed with a button matching
  // `recordingNoticeOk`, never one matching `recordingNoticeNever` (the same
  // dialog can offer "Leave meeting").
  recordingNotice: String.raw`(meeting|webinar) is being recorded|recording (has )?started|is recording this meeting|consent to (be|being) recorded`,
  recordingNoticeOk: String.raw`^\s*(got it|ok|okay|continue|i agree|agree|dismiss|close)\s*$`,
  recordingNoticeNever: String.raw`leave|end|decline|disagree`,
  name: ["#input-for-name", "input[placeholder*='name' i]"],
  // Seen live 2026-11-10 (ANC 6B, dc-gov.zoom.us): "Enter Meeting Info" with
  // a required Email above Your Name; Join stays disabled until it's filled.
  email: ["#input-for-email", "input[autocomplete='email']", "input[type='email']"],
  // Passcode prompt, shown when the link has no pwd= or only the plain
  // passcode (Zoom only skips the prompt for the long encoded pwd=).
  passcode: ["#input-for-pwd", "input[type='password']"],
  // While in the meeting, ended/reconnect text is only trusted inside these
  // overlays, so chat messages and captions can't end or drop a recording.
  // Overlays holding a text input (chat, Q&A panels) are skipped.
  // Zoom's modals are ReactModal role=dialog wrapping .zm-modal; the
  // disconnected screen is .loading-layer (both seen live).
  overlays: ["[role='dialog']", "[role='alertdialog']", "[aria-modal='true']", "[role='alert']",
             ".zm-modal", ".loading-layer"],
  // Zoom UI kept out of the recording (selectors from the live DOM,
  // 2026-11-05). Everything is made transparent, never display:none: the
  // elements stay in the DOM so `inMeeting` (the Leave button in the footer)
  // and the classifier's text reads keep working. The layout doesn't reflow,
  // so the header/footer/strip areas record as empty black bands.
  hideCss: `
    /* toasts: hardware-accel hint, no mic/camera, "X is the host now" */
    #notificationManager,
    /* popovers and coachmarks (My Notes AI popup etc.) */
    .pop-panel__panel
      { opacity: 0 !important; pointer-events: none !important; }
    /* top bar (title, timer, AI icons), bottom toolbar, thumbnail strip with
       our own self-view, "viewing X's screen" bar. Pointer events left on
       so advance() can still click footer buttons if it ever needs to. */
    .meeting-header,
    #wc-footer,
    .speaker-bar-container__horizontal-view-wrap,
    .sharee-container__indicator,
    /* Zoom captions: recorded as text (captions.jsonl), not burned in */
    .lt-subtitle-wrap
      { opacity: 0 !important; }`,
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
  const blocked = new RegExp(m.blocked, "i");
  const blockedPath = new RegExp(m.blockedPath, "i");
  const invalid = new RegExp(m.invalid, "i");
  const has =(sels: string[]) =>
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
    if (blocked.test(text) || blockedPath.test(location.pathname)) return "blocked";
    if (invalid.test(text)) return "invalid";
    if (ended.test(text)) return "ended";
    if (waiting.test(text)) return "waiting";
    if (has(m.name) || has(m.passcode)) return "prejoin";
    return "loading";
  };

  // Zoom's DOM churns constantly (timers, tiles), so coalesce mutations and
  // only signal Node when the classification actually changes.
  let last = "";
  let timer: ReturnType<typeof setTimeout> | null = null;
  const check = () => {
    timer = null;
    // Re-assert on every check: a style added before the page parses (or
    // before Zoom's SPA swaps <head>) gets dropped.
    try { addStyle(); } catch { /* no document yet */ }
    let s: string;
    try { s = w.__ccClassify(); } catch { return; }
    if (s !== last) {
      last = s;
      try { w.__ccSignal?.(s); } catch { /* binding not ready yet */ }
    }
    // Active speaker, only while in the meeting. "" (nobody / not shown) is
    // reported too, so a gap in speaking is visible downstream.
    const sp = s === "in_meeting" ? speakerName() : "";
    if (sp !== lastSpeaker) {
      lastSpeaker = sp;
      try { w.__ccSpeaker?.(sp); } catch { /* binding not ready yet */ }
    }
    const cap = s === "in_meeting" ? captionText() : "";
    if (cap !== lastCaption) {
      lastCaption = cap;
      try { w.__ccCaption?.(cap); } catch { /* binding not ready yet */ }
    }
  };
  let lastSpeaker = "";
  let lastCaption = "";
  const captionText = (): string => {
    for (const sel of m.captions) {
      try {
        const t = (document.querySelector(sel)?.textContent ?? "").replace(/\s+/g, " ").trim();
        if (t) return t.slice(0, 2000);
      } catch { /* bad selector */ }
    }
    return "";
  };
  const speakerName = (): string => {
    for (const sel of m.activeSpeaker) {
      try {
        const t = (document.querySelector(sel)?.textContent ?? "").replace(/\s+/g, " ").trim();
        if (t) return t.slice(0, 80);
      } catch { /* bad selector */ }
    }
    return "";
  };
  const addStyle = () => {
    if (!m.hideCss || document.getElementById("__cc-hide")) return;
    const st = document.createElement("style");
    st.id = "__cc-hide";
    st.textContent = m.hideCss;
    (document.head ?? document.documentElement).appendChild(st);
  };
  const observe = () => {
    addStyle();
    new MutationObserver(() => { timer ??= setTimeout(check, 400); })
      // class attributes too: the active-speaker highlight in the thumbnail
      // strip is only a class change.
      .observe(document.documentElement, {
        childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["class"],
      });
    check();
  };
  if (document.documentElement) observe();
  else document.addEventListener("DOMContentLoaded", observe, { once: true });
}

/**
 * Client-side mute, injected into every frame before Zoom's code runs.
 * Whatever Zoom or its UI does, the page never gets a live microphone,
 * camera or screen: every audio track it asks for is disabled and can't be
 * re-enabled (own `enabled` property shadows the prototype setter; clones
 * stay guarded), video requests are refused, screen share is refused.
 * Incoming meeting audio is untouched: only tracks we hand out are guarded.
 * Self-contained: serialized by addInitScript.
 */
export function mediaGuard(): void {
  const md = navigator.mediaDevices;
  const w = window as unknown as Record<string, unknown>;
  if (!md || w.__ccMediaGuard) return;
  w.__ccMediaGuard = true;
  const guarded = new WeakSet<MediaStreamTrack>();
  const guard = (t: MediaStreamTrack): MediaStreamTrack => {
    t.enabled = false;
    Object.defineProperty(t, "enabled", { get: () => false, set: () => {}, configurable: false });
    guarded.add(t);
    return t;
  };
  const clone = MediaStreamTrack.prototype.clone;
  MediaStreamTrack.prototype.clone = function (this: MediaStreamTrack) {
    const c = clone.call(this);
    return guarded.has(this) ? guard(c) : c;
  };
  const refuse = (what: string) => Promise.reject(new DOMException(what + " disabled by recorder", "NotAllowedError"));
  const gum = md.getUserMedia.bind(md);
  md.getUserMedia = async (c?: MediaStreamConstraints) => {
    if (!c?.audio) return refuse("camera");
    const s = await gum({ audio: c.audio });   // never pass video through
    s.getAudioTracks().forEach(guard);
    return s;
  };
  md.getDisplayMedia = () => refuse("screen share");
}

/** The plain passcode from a link's pwd= (agendas print "Passcode: 429539",
 *  so links get written as /j/<id>?pwd=429539). Zoom's encoded pwd= is
 *  longer (32+ chars) and must not be typed into the prompt. */
export function plainPasscode(link: string): string | null {
  let u: URL;
  try { u = new URL(link); } catch { return null; }
  const pwd = u.searchParams.get("pwd");
  return pwd && /^[A-Za-z0-9@*_.-]{1,10}$/.test(pwd) ? pwd : null;
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
  private ctx?: BrowserContext;
  private dead = false;
  private joined = false;        // reached IN_MEETING at least once
  private lastJoinClick = 0;
  private audioJoined = false;
  private muteChecked = false;
  private captionsClicked = false;
  private captionsSeen = false;
  private inMeetingSince = 0;
  private readonly passcode: string | null;
  private passcodeTries = 0;
  private emailFilled = false;
  /** Zoom wants an email to join and none is configured (CAPTURE_EMAIL). */
  needsEmail = false;

  /** Called whenever the page agent reports a change, or the browser dies. */
  onChange: (state: string) => void = () => {};
  /** Called when the active speaker Zoom shows changes ("" = none shown). */
  onSpeaker: (name: string) => void = () => {};
  /** Called when Zoom's caption text changes ("" = cleared). */
  onCaption: (text: string) => void = () => {};

  constructor(link: string, private displayName: string,
              private width: number, private height: number,
              private authFile: string | null = null,
              private email: string | null = null) {
    this.url = webClientUrl(link);
    this.passcode = plainPasscode(link);
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

    const ctx = await this.browser.newContext({
      viewport: null,
      // Signed-in Zoom session from `minutes login`.
      ...(this.authFile ? { storageState: this.authFile } : {}),
    });
    this.ctx = ctx;
    if (this.authFile) log.info(`using signed-in session from ${this.authFile}`);
    // Mic only; the container's default source is a silent null sink so
    // nothing ever reaches the meeting, and mediaGuard() disables every mic
    // track the page gets. No camera permission at all.
    await ctx.grantPermissions(["microphone"], { origin: "https://app.zoom.us" });
    await ctx.exposeBinding("__ccCaption", (_src, text: string) => {
      if (text) this.captionsSeen = true;
      this.onCaption(String(text ?? "").slice(0, 2000));
    });
    await ctx.exposeBinding("__ccSpeaker", (_src, name: string) => {
      log.debug(`active speaker: ${name || "(none)"}`);
      this.onSpeaker(String(name ?? "").slice(0, 80));
    });
    await ctx.exposeBinding("__ccSignal", (_src, s: string) => {
      log.debug(`agent signal: ${s}`);
      this.onChange(s);
    });
    await ctx.addInitScript(mediaGuard);
    await ctx.addInitScript(pageAgent, MARKERS);

    this.page = await ctx.newPage();
    await this.hideBrowserUi(this.page);
    this.page.on("crash", () => this.markDead("renderer crashed"));
    this.page.on("close", () => this.markDead("page closed"));
    log.info(`opening ${this.url.replace(/([?&]pwd=)[^&]+/, "$1<hidden>")}`);
    await this.page.goto(this.url, { waitUntil: "domcontentloaded", timeout: 60_000 });
  }

  async close(): Promise<void> {
    // Zoom rotates session cookies; write them back after a session that got
    // into the meeting, so the saved login stays fresh between meetings.
    if (this.authFile && this.ctx && this.joined && !this.dead) {
      try {
        const st = await withTimeout(this.ctx.storageState(), 5_000);
        if (st !== TIMEOUT) saveStorageState(this.authFile, st);
      } catch (e) {
        log.warn("couldn't refresh saved session", e);
      }
    }
    try { await withTimeout(this.browser?.close() ?? Promise.resolve(), 15_000); } catch { /* already gone */ }
  }

  /** Keep the tab strip and address bar (which shows the meeting's join
   *  token) out of the x11grab capture. --kiosk doesn't take effect on
   *  windows Playwright creates, and fullscreen needs a window manager, which
   *  Xvfb doesn't have. So move the window up by the browser-UI height,
   *  pushing that UI above the screen, and grow it so the page area is
   *  exactly width x height at the screen origin. */
  private async hideBrowserUi(page: Page): Promise<void> {
    try {
      const ui = await page.evaluate(() => window.outerHeight - window.innerHeight);
      if (ui <= 0) return;
      const cdp = await page.context().newCDPSession(page);
      const { windowId } = await cdp.send("Browser.getWindowForTarget");
      await cdp.send("Browser.setWindowBounds", {
        windowId, bounds: { left: 0, top: -ui, width: this.width, height: this.height + ui },
      });
      await cdp.detach();
      log.debug(`browser UI is ${ui}px; window shifted up to hide it`);
    } catch (e) {
      log.warn("couldn't hide the browser UI; it will be in the recording", e);
    }
  }

  /** Debug aid for tuning MARKERS: screenshot plus each frame's HTML and
   *  classification, written as <dir>/<label>.png / .html. Never throws. */
  async dump(dir: string, label: string): Promise<void> {
    const page = this.page;
    if (!page || this.dead) return;
    try {
      mkdirSync(dir, { recursive: true });
      const base = path.join(dir, label);
      await withTimeout(page.screenshot({ path: `${base}.png` }), 10_000);
      const parts: string[] = [];
      for (const f of page.frames()) {
        const r = await withTimeout(f.evaluate(() => ({
          state: (window as any).__ccClassify?.() ?? "?",
          html: document.documentElement?.outerHTML ?? "",
        })), 5_000).catch(() => null);
        if (r === null || r === TIMEOUT) continue;
        parts.push(`<!-- frame ${f.url()} classify=${r.state} -->\n${r.html}`);
      }
      writeFileSync(`${base}.html`, parts.join("\n\n"));
      log.debug(`dumped ${label}`);
    } catch (e) {
      log.debug(`dump ${label} failed`, e);
    }
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
    if (best === State.IN_MEETING) this.joined = true;
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

  private noticeWarned = false;

  /** After a click, move the pointer to the bottom-right corner (the
   *  footer area, which hideCss makes transparent) so it doesn't sit over
   *  the video and keep Zoom's hover controls up. ffmpeg doesn't draw the
   *  cursor (-draw_mouse 0); this is about what Zoom shows on hover. */
  private async parkMouse(): Promise<void> {
    try { await this.page?.mouse.move(this.width - 2, this.height - 2); } catch { /* page gone */ }
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

  /** Click "Got it" on Zoom's "this meeting is being recorded" dialog, which
   *  otherwise sits in the middle of the recording. Only inside an overlay
   *  whose text is the recording notice, and never a Leave/End button. */
  private async dismissRecordingNotice(): Promise<void> {
    const notice = new RegExp(MARKERS.recordingNotice, "i");
    const ok = new RegExp(MARKERS.recordingNoticeOk, "i");
    const never = new RegExp(MARKERS.recordingNoticeNever, "i");
    for (const frame of this.page?.frames() ?? []) {
      for (const sel of MARKERS.overlays) {
        try {
          const dlg = frame.locator(sel).filter({ hasText: notice });
          if (!(await dlg.count()) || !(await dlg.first().isVisible())) continue;
          const buttons = dlg.first().getByRole("button");
          const n = await buttons.count();
          for (let i = 0; i < n; i++) {
            const b = buttons.nth(i);
            const label = ((await b.getAttribute("aria-label")) || (await b.innerText()) || "").trim();
            if (!ok.test(label) || never.test(label) || !(await b.isVisible())) continue;
            log.info(`dismissing recording notice ("${label}")`);
            await b.click({ timeout: 2_000 });
            await this.parkMouse();
            return;
          }
          if (!this.noticeWarned) {
            this.noticeWarned = true;
            log.warn("recording notice showing but no safe button to dismiss it");
          }
        } catch { /* frame detached */ }
      }
    }
  }

  /** Do whatever the current screen needs to get us further in. */
  async advance(state: State): Promise<void> {
    try {
      if (state === State.PREJOIN) {
        const name = await this.find(MARKERS.name);
        // Signed in, Zoom prefills the account name (and may lock the
        // field). Try to set ours, but never let that stop the Join click.
        if (name) {
          try {
            if ((await name.inputValue()) !== this.displayName && (await name.isEditable())) {
              await name.fill(this.displayName);
            }
          } catch { /* locked or detached */ }
        }
        const pass = await this.find(MARKERS.passcode);
        if (pass) {
          if (!this.passcode) {
            if (!this.passcodeTries++) log.warn("Zoom asks for a passcode: add it to the link as ?pwd=<passcode>");
            return;
          }
          try {
            if ((await pass.inputValue()) !== this.passcode) {
              // Never log the passcode itself.
              if (this.passcodeTries++ < 5) log.info("entering meeting passcode");
              await pass.fill(this.passcode);
            }
          } catch { /* detached */ }
        }
        // Some hosts require an email. Fill the configured one; with none,
        // report it only if Join really is disabled (never invent one).
        const email = await this.find(MARKERS.email);
        if (email) {
          try {
            const have = (await email.inputValue()).trim();
            if (this.email && have !== this.email && (await email.isEditable())) {
              // Never log the address itself.
              if (!this.emailFilled) log.info("Zoom asks for an email: entering CAPTURE_EMAIL");
              this.emailFilled = true;
              await email.fill(this.email);
            } else if (!this.email && !have) {
              const join = await this.findButton(JOIN_BUTTON);
              if (!join || !(await join.isEnabled())) {
                if (!this.needsEmail) log.warn("Zoom requires an email to join this meeting: set CAPTURE_EMAIL");
                this.needsEmail = true;
                return;
              }
            }
          } catch { /* detached */ }
        }
        const btn = await this.findButton(JOIN_BUTTON);
        // One click per 10s: the button stays up briefly while Zoom works.
        if (btn && (await btn.isEnabled()) && Date.now() - this.lastJoinClick > 10_000) {
          log.info(`clicking Join as "${this.displayName}"`);
          this.lastJoinClick = Date.now();
          await btn.click();
          await this.parkMouse();
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
        await this.dismissRecordingNotice();
        // Turn on Zoom's captions so they can be recorded as text. Only
        // present when the host enabled captions. Click at most once per
        // session and never once captions are flowing: the same control
        // usually toggles, and a second click would hide them again.
        this.inMeetingSince ||= Date.now();
        if (!this.captionsClicked && !this.captionsSeen && Date.now() - this.inMeetingSince > 8_000) {
          const cc = await this.findButton(new RegExp(MARKERS.showCaptions, "i"));
          if (cc) {
            this.captionsClicked = true;
            log.info("turning on Zoom captions");
            await cc.click();
            await this.parkMouse();
          }
        }
      }
    } catch (e) {
      log.debug(`advance(${state}) hiccup`, e);
    }
  }
}
