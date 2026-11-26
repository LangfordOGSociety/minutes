export const TIMEOUT = Symbol("timeout");

/** Resolve with p's value, or TIMEOUT if it takes longer than ms. */
export async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | typeof TIMEOUT> {
  let t: NodeJS.Timeout | undefined;
  const timer = new Promise<typeof TIMEOUT>((res) => {
    t = setTimeout(() => res(TIMEOUT), ms);
  });
  try {
    return await Promise.race([p, timer]);
  } finally {
    clearTimeout(t);
  }
}

/**
 * A sleep that can be cut short. The page agent kicks it when the meeting
 * state changes, and the stop handler kicks it on SIGTERM.
 */
export class Waker {
  private waiters = new Set<() => void>();

  kick(): void {
    for (const w of [...this.waiters]) w();
  }

  wait(ms: number): Promise<void> {
    return new Promise((resolve) => {
      let t: NodeJS.Timeout;
      const done = () => {
        clearTimeout(t);
        this.waiters.delete(done);
        resolve();
      };
      t = setTimeout(done, Math.max(0, Math.min(ms, 2 ** 31 - 1)));
      this.waiters.add(done);
    });
  }
}

const LEVELS = { DEBUG: 10, INFO: 20, WARN: 30, ERROR: 40 } as const;
type Level = keyof typeof LEVELS;
const MIN = LEVELS[(process.env.LOG_LEVEL?.toUpperCase() ?? "INFO") as Level] ?? 20;

function fmt(x: unknown): string {
  if (typeof x === "string") return x;
  if (x instanceof Error) return x.stack ?? x.message;
  return JSON.stringify(x);
}

export function logger(name: string) {
  const out = (lvl: Level, msg: string, rest: unknown[]) => {
    if (LEVELS[lvl] < MIN) return;
    const extra = rest.length ? " " + rest.map(fmt).join(" ") : "";
    process.stderr.write(`${new Date().toISOString()} ${lvl.padEnd(5)} ${name.padEnd(8)} ${msg}${extra}\n`);
  };
  return {
    debug: (m: string, ...r: unknown[]) => out("DEBUG", m, r),
    info: (m: string, ...r: unknown[]) => out("INFO", m, r),
    warn: (m: string, ...r: unknown[]) => out("WARN", m, r),
    error: (m: string, ...r: unknown[]) => out("ERROR", m, r),
  };
}

/** Folder/file name for a meeting when none is given: meeting-YYYYMMDD-HHMM (local time). */
export function defaultSlug(start: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `meeting-${start.getFullYear()}${pad(start.getMonth() + 1)}${pad(start.getDate())}` +
    `-${pad(start.getHours())}${pad(start.getMinutes())}`;
}

/** Slugs become directory and file names, so keep them boring. */
export const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;

/** POST a short text alert (ntfy-style) to url, if set. Never throws. `priority` and `tags` are ntfy's headers (ignored by other receivers). */
export async function notify(url: string | null, text: string, o: { priority?: "low" | "default" | "high" | "urgent"; tags?: string } = {}): Promise<void> {
  if (!url) return;
  try {
    await fetch(url, {
      method: "POST", body: text, headers: { "Content-Type": "text/plain", Title: "minutes", ...(o.priority ? { Priority: o.priority } : {}), ...(o.tags ? { Tags: o.tags } : {}) },
      signal: AbortSignal.timeout(10_000),
    });
  } catch (e) { logger("notify").warn("notification failed", e); }
}
