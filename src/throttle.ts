/**
 * Optional download speed caps (#36). Off by default (the homelab has
 * 1 Gb/s up); DOWNLOAD_MAX_BPS caps all API downloads together,
 * DOWNLOAD_TOKEN_BPS each token, and a token's own `limits.downloadBps`
 * (the api_tokens.limits column) overrides the per-token default. Plain
 * bytes per second, or with a k / m / g suffix (x1000: "20m" = 20 MB/s).
 *
 * A Bucket paces any number of concurrent downloads that share it; a
 * Paced stream sits between the file and the response, so Range requests
 * work unchanged and the usage log still counts what was written.
 */
import { Transform, type TransformCallback } from "node:stream";

/** "1500000", "1500k", "1.5m", "2g", "" / "0" / undefined = unlimited (0). */
export function parseRate(v: string | number | undefined | null): number {
  if (v === undefined || v === null || v === "") return 0;
  if (typeof v === "number") { if (!Number.isFinite(v) || v < 0) throw new Error(`bad rate: ${v}`); return Math.floor(v); }
  const m = /^\s*(\d+(?:\.\d+)?)\s*([kmg]?)(?:b(?:ps|\/s)?)?\s*$/i.exec(v);
  if (!m) throw new Error(`bad rate: ${v} (bytes per second, or with k, m or g: 20m)`);
  return Math.floor(Number(m[1]) * ({ "": 1, k: 1e3, m: 1e6, g: 1e9 } as Record<string, number>)[m[2].toLowerCase()]);
}

const BURST_MIN = 64 * 1024;

/** A token bucket: `take(n)` resolves when n bytes may be sent. */
export class Bucket {
  private level: number;
  private last: number;
  private queue: Promise<void> = Promise.resolve();

  constructor(readonly rate: number, private now: () => number = Date.now, private sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))) {
    this.level = this.capacity;
    this.last = now();
  }

  /** One second's worth, but at least one chunk, so small caps still move. */
  private get capacity() { return Math.max(this.rate, BURST_MIN); }

  /** Callers are served in order, so concurrent downloads share the rate. */
  take(n: number): Promise<void> {
    const run = async () => {
      this.refill();
      this.level -= n;
      if (this.level < 0) {
        await this.sleep(Math.ceil((-this.level / this.rate) * 1000));
        this.refill();
      }
    };
    const p = this.queue.then(run);
    this.queue = p.catch(() => {});
    return p;
  }

  private refill() {
    const t = this.now();
    this.level = Math.min(this.capacity, this.level + ((t - this.last) / 1000) * this.rate);
    this.last = t;
  }
}

/** A stream that lets bytes through no faster than every bucket allows. */
export function paced(buckets: Bucket[]): Transform {
  return new Transform({
    highWaterMark: BURST_MIN,
    async transform(chunk: Buffer, _enc, cb: TransformCallback) {
      try {
        for (const b of buckets) await b.take(chunk.length);
        cb(null, chunk);
      } catch (e) { cb(e as Error); }
    },
  });
}

/** The buckets a token's download goes through: the global one and the token's own. */
export class Throttle {
  private global: Bucket | null;
  private perToken = new Map<string, Bucket>();

  constructor(private o: { globalBps?: number; tokenBps?: number }) {
    this.global = o.globalBps ? new Bucket(o.globalBps) : null;
  }

  /** Off entirely when nothing is configured (and no token has its own cap). */
  get enabled() { return !!this.global || !!this.o.tokenBps; }

  buckets(tokenId: string, tokenOverrideBps?: number | null): Bucket[] {
    const out: Bucket[] = [];
    if (this.global) out.push(this.global);
    const rate = tokenOverrideBps && tokenOverrideBps > 0 ? tokenOverrideBps : this.o.tokenBps;
    if (rate) {
      let b = this.perToken.get(tokenId);
      if (!b || b.rate !== rate) { b = new Bucket(rate); this.perToken.set(tokenId, b); }
      out.push(b);
    }
    return out;
  }
}
