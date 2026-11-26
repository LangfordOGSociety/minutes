/**
 * Messages to the operator (CAPTURE_NOTIFY_URL, an ntfy-style endpoint):
 * the things you'd otherwise find out by looking.
 *
 *   a capture started                 (so you know it joined)
 *   a capture finished, and how       (ended, or what went wrong, in words)
 *   a capture that hasn't started 10 minutes after its meeting did
 *   a transcript ready, or failed     (with the public link)
 *
 * Each message is sent once: ops_notified remembers what was sent, so a
 * restart doesn't repeat it, and the first look at the transcripts after
 * this ships only records the existing ones (no flood about old meetings).
 * Nothing in a message is secret: titles, outcomes, the public page's
 * address. Never the meeting link, its passcode or a recording's files.
 */
import type { DB } from "./db.js";
import type { Job, JobEvent } from "./jobs.js";
import { logger } from "./util.js";

const log = logger("ops");

type Notifier = (text: string, o?: { priority?: "low" | "default" | "high" | "urgent"; tags?: string }) => Promise<void>;

/** The runner's outcome, in words for a person. `bad` = needs a look. */
export function describeOutcome(job: Pick<Job, "status" | "outcome" | "error">, platform: string): { text: string; bad: boolean } {
  const o = job.outcome ?? "";
  switch (o) {
    case "ended": return { text: "the meeting ended and was stitched into one video", bad: false };
    case "not_started": return { text: "it never started (the meeting didn't begin, or couldn't be joined, in time)", bad: true };
    case "blocked": return { text: `${platform} refused it (a bot check or a sign-in requirement)`, bad: true };
    case "invalid_link": return { text: "the link isn't a meeting (invalid or unavailable)", bad: true };
    case "email_required": return { text: "the meeting wants an email address to join and none is set", bad: true };
    case "ended_after_interruption": return { text: "it ended after an interruption: check the video for gaps", bad: true };
    case "stopped": return { text: "it was stopped by hand", bad: false };
  }
  if (job.status === "failed") return { text: job.error ? `it failed: ${job.error}` : "it failed", bad: true };
  if (job.status === "stopped") return { text: "it was stopped by hand", bad: false };
  return { text: o ? `outcome: ${o}` : "it finished", bad: !!o && o !== "ended" };
}

const minutes = (a?: string, b?: string) => (a && b ? Math.max(0, Math.round((Date.parse(b) - Date.parse(a)) / 60_000)) : null);

export class Ops {
  constructor(private db: DB, private o: { notify: Notifier; site: string; titleOf(job: Job): string; platformOf(job: Job): string }) {}

  /** True the first time for a key (and records it). */
  private once(key: string, now = new Date()): boolean {
    return Number(this.db.prepare("INSERT OR IGNORE INTO ops_notified (key, at) VALUES (?, ?)").run(key, now.toISOString()).changes) > 0;
  }

  private link(slug: string): string { return this.o.site ? ` ${this.o.site}/m/${encodeURIComponent(slug)}` : ""; }

  /** A capture event -> a message (once). */
  job(e: JobEvent): void {
    const { job } = e, title = this.o.titleOf(job);
    try {
      if (e.kind === "started") {
        if (this.once(`job:${job.id}:started`)) void this.o.notify(`Recording started: ${title}.`, { priority: "low", tags: "red_circle" });
      } else if (e.kind === "overdue") {
        if (this.once(`job:${job.id}:overdue`)) {
          const late = minutes(job.start, new Date().toISOString());
          void this.o.notify(`Not recording yet: ${title} was due ${late ?? "several"} min ago and the capture hasn't started${job.status === "queued" ? " (waiting for a free slot)" : ""}. Check /admin.`, { priority: "high", tags: "warning" });
        }
      } else if (this.once(`job:${job.id}:finished`)) {
        const d = describeOutcome(job, this.o.platformOf(job)), len = minutes(job.launchedAt, job.endedAt);
        void this.o.notify(`${d.bad ? "Recording problem" : "Recording finished"}: ${title}${len !== null ? `, ${len} min` : ""}: ${d.text}.${d.bad ? " Check /admin." : ""}`,
          d.bad ? { priority: "high", tags: "warning" } : { priority: "default", tags: "white_check_mark" });
      }
    } catch (err) { log.warn("couldn't send an operator message", err); }
  }

  /**
   * Look at the recordings' transcript status: tell once when one is ready
   * or has failed. The first call ever only records what's already there.
   */
  transcripts(recs: { slug: string; title: string; transcript: { status: string; error: string | null } | null; public: boolean }[]): void {
    const seeded = !!this.db.prepare("SELECT 1 FROM ops_notified WHERE key = 'seeded:transcripts'").get();
    for (const r of recs) {
      const s = r.transcript?.status;
      if (s !== "done" && s !== "failed") continue;
      if (!this.once(`transcript:${r.slug}:${s}`) || !seeded) continue;
      void this.o.notify(s === "done" ? `Transcript ready: ${r.title}.${r.public ? this.link(r.slug) : ""}` : `Transcription FAILED: ${r.title}: ${r.transcript?.error ?? "unknown error"}. Check the transcriber.`,
        s === "done" ? { priority: "default", tags: "page_facing_up" } : { priority: "high", tags: "warning" });
    }
    if (!seeded) this.once("seeded:transcripts");
  }
}
