/**
 * Orchestration: wait for the meeting, record, recover from drops, stitch.
 *
 *   sleep until (start - lead)
 *   loop:
 *     open browser -> join -> sit in waiting room until the meeting goes live
 *     record while IN_MEETING
 *     ENDED                  -> done
 *     drop / crash           -> close the part cleanly, back off, rejoin as a new part
 *     rejoined but stuck waiting for rejoinWait -> meeting is over, done
 *   stitch parts -> <slug>.mp4 with a chapter at every gap
 *
 * The loop is event-driven: the in-page agent kicks the Waker on every state
 * change, and pollMs is just the heartbeat.
 */
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Recorder, type Encoder, type Part } from "./recorder.js";
import { stitch, type Gap, type PartOffset } from "./stitch.js";
import { appendTimeline, finalizeTimelines, type TimelineKind } from "./timeline.js";
import { Waker, logger } from "./util.js";
import { State, ZoomSession } from "./zoom.js";

const log = logger("runner");

const FF_MIN_PART_MS = 10_000;     // a part shorter than this is a fast failure
const FF_MAX_BACKOFF_MS = 60_000;
const IN_MEETING_SETTLE_MS = 3_000; // IN_MEETING must hold this long before recording

export interface Config {
  link: string;
  start: Date;
  slug: string;
  tz: string;
  out: string;
  displayName: string;
  auth: string | null;      // Playwright storage state from `zoom-capture login`
  email: string | null;     // typed only when the host requires an email to join
  debug: boolean;           // dump screenshot + HTML to <dir>/debug on every state change
  display: string;
  sink: string;
  width: number;
  height: number;
  fps: number;
  quality: number;
  encoder: Encoder;
  vaapiDevice: string;
  leadMs: number;           // join this long before scheduled start
  noShowMs: number;         // give up if nothing starts by start + noShow
  rejoinWaitMs: number;     // rejoined into a waiting room this long => ended
  reconnectGraceMs: number; // tolerate Zoom's own reconnect this long
  maxDurationMs: number;    // hard cap from first frame recorded
  pollMs: number;
  retryBaseMs: number;
  retryMaxMs: number;
}

type SessionResult = "ended" | "interrupted" | "not_started" | "stopped" | "blocked" | "invalid_link" | "email_required";

export class Capture {
  private dir: string;
  private rec: Recorder;
  private parts: Part[] = [];
  private events: Record<string, unknown>[] = [];
  private outcome = "pending";
  private waker = new Waker();
  private stopped = false;
  // ffmpeg crash-loop protection: parts that die within FF_MIN_PART_MS count
  // as fast failures and push the next start back exponentially.
  private ffFastFails = 0;
  private ffRetryAt = 0;
  private dumpSeq = 0;
  private lastSpeaker = "";

  constructor(private cfg: Config) {
    this.dir = path.join(cfg.out, cfg.slug);
    mkdirSync(this.dir, { recursive: true });
    this.rec = new Recorder({
      outdir: this.dir, display: cfg.display, sink: cfg.sink,
      width: cfg.width, height: cfg.height, fps: cfg.fps,
      quality: cfg.quality, encoder: cfg.encoder, vaapiDevice: cfg.vaapiDevice,
    });
  }

  /** SIGTERM / SIGINT: close the current part cleanly and still stitch. */
  requestStop(): void {
    if (this.stopped) return;
    this.stopped = true;
    log.info("stop requested");
    this.waker.kick();
  }

  private event(kind: string, data: Record<string, unknown> = {}): void {
    this.events.push({ t: new Date().toISOString(), event: kind, ...data });
    log.info(kind, ...(Object.keys(data).length ? [data] : []));
    this.writeManifest();
  }

  private writeManifest(extra: Record<string, unknown> = {}): void {
    const data = {
      slug: this.cfg.slug,
      link: this.cfg.link,
      scheduledStart: this.cfg.start.toISOString(),
      outcome: this.outcome,
      parts: this.parts.map((p) => ({
        index: p.index,
        file: path.basename(p.file),
        started: p.started.toISOString(),
        ended: p.ended?.toISOString() ?? null,
        videoStart: p.videoStart?.toISOString() ?? null,
        exitCode: p.exitCode,
      })),
      events: this.events,
      ...extra,
    };
    const tmp = path.join(this.dir, "manifest.json.tmp");
    writeFileSync(tmp, JSON.stringify(data, null, 2));
    renameSync(tmp, path.join(this.dir, "manifest.json"));
  }

  async run(): Promise<number> {
    const { cfg } = this;

    // Make a wrong UTC offset obvious up front (stale tzdata got BC's 2026
    // switch to permanent UTC-7 wrong by an hour).
    this.event("config", {
      tz: cfg.tz,
      tzdata: process.versions.tz ?? "unknown",
      scheduledStartLocal: cfg.start.toString(),
      scheduledStartUtc: cfg.start.toISOString(),
    });

    const begin = cfg.start.getTime() - cfg.leadMs;
    if (begin > Date.now()) {
      this.event("sleeping", { until: new Date(begin).toISOString() });
      while (!this.stopped && Date.now() < begin) {
        await this.waker.wait(Math.min(begin - Date.now(), 3_600_000));
      }
    }

    let attempt = 0;
    while (!this.stopped) {
      attempt++;
      this.event("session_open", { attempt });
      const session = new ZoomSession(cfg.link, cfg.displayName, cfg.width, cfg.height, cfg.auth, cfg.email);
      session.onChange = () => this.waker.kick();
      session.onSpeaker = (name) => { this.lastSpeaker = name; this.track("speakers", name); };
      session.onCaption = (text) => this.track("captions", text);
      let result: SessionResult = "interrupted";
      try {
        await session.open();
        result = await this.runSession(session);
      } catch (e) {
        log.error("session error", e);
        this.event("session_error", { error: String(e).slice(0, 300) });
      } finally {
        session.onChange = () => {};
        session.onSpeaker = () => {};
        session.onCaption = () => {};
        // Unconditional: if ffmpeg already died, stop() just closes the part.
        await this.rec.stop();
        await session.close();
      }
      this.event("session_closed", { result });

      if (result !== "interrupted") {
        this.outcome = result;
        break;
      }

      // Interrupted. Has the meeting been unreachable so long it's surely over?
      const now = Date.now();
      if (this.parts.length) {
        const last = this.parts.at(-1)!.ended?.getTime() ?? now;
        if (now - last > cfg.rejoinWaitMs + 5 * 60_000) {
          this.outcome = "ended_after_interruption";
          break;
        }
      } else if (now > cfg.start.getTime() + cfg.noShowMs) {
        this.outcome = "not_started";
        break;
      }

      const backoff = Math.min(cfg.retryMaxMs, cfg.retryBaseMs * 2 ** Math.min(attempt - 1, 6));
      this.event("retry_backoff", { ms: backoff });
      await this.waker.wait(backoff);
    }
    if (this.outcome === "pending") this.outcome = "stopped";

    let output: string | null = null;
    let gaps: Gap[] = [];
    let offsets: PartOffset[] = [];
    let sidecars: Record<string, string> = {};
    if (this.parts.length) {
      this.event("stitching", { parts: this.parts.length });
      ({ output, gaps, offsets } = await stitch(this.parts, this.dir, cfg.slug, cfg.tz));
      if (output) {
        try {
          sidecars = finalizeTimelines(this.dir, cfg.slug, offsets,
            new Map(this.parts.map((p) => [p.index, p.videoStart ?? p.started])));
        } catch (e) {
          log.warn("couldn't write speaker/caption timelines", e);
        }
      }
    }
    this.writeManifest({ output: output ? path.basename(output) : null, gaps, offsets, sidecars });
    log.info(`finished: outcome=${this.outcome} output=${output}`);
    return output ? 0 : 1;
  }

  /** Record a speaker/caption change against the part being recorded.
   *  Outside a part (waiting room, between parts) there's no video to pin
   *  it to, so it's dropped; the speaker is re-stated when a part starts. */
  private track(kind: TimelineKind, value: string): void {
    const part = this.rec.current;
    if (!this.rec.alive || !part || part.ended) return;
    try {
      appendTimeline(this.dir, kind, {
        t: new Date().toISOString(), part: part.index,
        partOffset: +((Date.now() - part.started.getTime()) / 1000).toFixed(2), value,
      });
    } catch (e) {
      log.debug(`couldn't append ${kind}`, e);
    }
  }

  private async runSession(session: ZoomSession): Promise<SessionResult> {
    const { cfg } = this;
    let waitingSince: number | null = null;
    let troubleSince: number | null = null;
    let lastState: State | null = null;
    let inMeetingSince: number | null = null;

    while (!this.stopped) {
      const st = await session.state();
      const now = Date.now();
      if (st !== lastState) {
        this.event("state", { state: st });
        lastState = st;
        if (cfg.debug) await session.dump(path.join(this.dir, "debug"), `${String(++this.dumpSeq).padStart(3, "0")}-${st}`);
      }
      inMeetingSince = st === State.IN_MEETING ? (inMeetingSince ?? now) : null;

      if (st === State.ENDED) return "ended";
      if (st === State.BLOCKED) {
        // Retrying won't help; it needs a (fresh) signed-in session.
        this.event("blocked", {
          hint: cfg.auth
            ? `Zoom rejected the session in ${cfg.auth}; run "zoom-capture login" again`
            : "Zoom requires sign-in; run \"zoom-capture login\" and pass --auth",
        });
        return "blocked";
      }
      if (st === State.INVALID) {
        this.event("invalid_link", { hint: "Zoom says this meeting link or ID is invalid; check it" });
        return "invalid_link";
      }
      if (st === State.DEAD) return "interrupted";

      if (st === State.IN_MEETING) {
        troubleSince = waitingSince = null;
        // Seen live: right after the Join click the meeting UI flashes for
        // under a second before the waiting room renders. Don't start a part
        // until IN_MEETING has held for a moment.
        const settling = !this.rec.alive && now - inMeetingSince! < IN_MEETING_SETTLE_MS;
        if (!this.rec.alive && !settling) {
          const cur = this.rec.current;
          if (cur && cur.ended === null) {
            // Died on its own since the last tick. Close it now so the
            // lifetime (and the part's end time) is real.
            await this.rec.stop();
            const lived = cur.ended!.getTime() - cur.started.getTime();
            this.ffFastFails = lived < FF_MIN_PART_MS ? this.ffFastFails + 1 : 0;
            const delay = this.ffFastFails
              ? Math.min(FF_MAX_BACKOFF_MS, 1_000 * 2 ** this.ffFastFails) : 0;
            this.ffRetryAt = Date.now() + delay;
            this.event("ffmpeg_died", {
              part: cur.index, exitCode: cur.exitCode, livedMs: lived,
              ...(delay ? { retryInMs: delay } : {}),
            });
          }
          if (Date.now() >= this.ffRetryAt) {
            this.parts.push(this.rec.start(this.parts.length + 1));
            this.writeManifest();
            // Each part starts with whoever was already speaking.
            if (this.lastSpeaker) this.track("speakers", this.lastSpeaker);
          }
        }
        if (settling) {
          await this.waker.wait(500);
          continue;
        }
        await session.advance(st);
        if (this.parts.length && now - this.parts[0].started.getTime() > cfg.maxDurationMs) {
          this.event("max_duration_hit");
          return "ended";
        }
      } else if (this.rec.alive) {
        // Recording, but not cleanly in the meeting: Zoom reconnecting,
        // footer vanished, renderer stalled. Ride it out briefly.
        troubleSince ??= now;
        if (now - troubleSince > cfg.reconnectGraceMs) {
          this.event("feed_lost", { state: st });
          return "interrupted";
        }
      } else {
        // Not recording yet: first join, or a rejoin.
        await session.advance(st);
        if (session.needsEmail) {
          // Retrying won't help: the host requires an email and none is set.
          this.event("email_required", { hint: "the host requires an email to join; set CAPTURE_EMAIL to the address to give" });
          return "email_required";
        }
        if (this.parts.length) {
          // Zoom shows the same waiting screen after a meeting ends, so a
          // rejoin that sits here for rejoinWait means it's over.
          waitingSince ??= now;
          if (now - waitingSince > cfg.rejoinWaitMs) {
            this.event("rejoin_timeout");
            return "ended";
          }
        } else if (now > cfg.start.getTime() + cfg.noShowMs) {
          return "not_started";
        }
      }

      // While troubled, check often so the grace window is measured tightly.
      await this.waker.wait(troubleSince !== null ? Math.min(cfg.pollMs, 1_000) : cfg.pollMs);
    }
    return "stopped";
  }
}
