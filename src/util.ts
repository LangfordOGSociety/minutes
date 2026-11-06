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
