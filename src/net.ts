/**
 * Internet-facing details (#6): which client address to believe, security
 * headers, and a CSP that allows exactly the page's own inline script.
 */
import { createHash } from "node:crypto";
import type http from "node:http";
import { BlockList, isIP } from "node:net";

const plain = (ip: string) => ip.replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/, "");

/**
 * X-Forwarded-For / -Proto are believed only when the connection comes from
 * a configured proxy (TRUSTED_PROXIES, comma-separated IPs or CIDRs).
 * Anyone else can send those headers, so otherwise the socket address wins.
 */
export class Proxies {
  private list = new BlockList();
  readonly size: number;

  constructor(spec: string | undefined) {
    let n = 0;
    for (const raw of (spec ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
      const [addr, bits] = raw.split("/");
      const ip = plain(addr);
      const fam = isIP(ip);
      if (!fam) throw new Error(`TRUSTED_PROXIES: not an address: ${raw}`);
      const type = fam === 6 ? "ipv6" : "ipv4";
      if (bits === undefined) this.list.addAddress(ip, type);
      else {
        const b = Number(bits);
        if (!Number.isInteger(b) || b < 0 || b > (fam === 6 ? 128 : 32)) throw new Error(`TRUSTED_PROXIES: bad prefix: ${raw}`);
        this.list.addSubnet(ip, b, type);
      }
      n++;
    }
    this.size = n;
  }

  trusted(ip: string): boolean {
    const p = plain(ip);
    const fam = isIP(p);
    return fam !== 0 && this.list.check(p, fam === 6 ? "ipv6" : "ipv4");
  }

  /** The client: walk X-Forwarded-For from the right past our own proxies. */
  clientIp(req: http.IncomingMessage): string {
    const sock = plain(req.socket.remoteAddress ?? "");
    if (!this.trusted(sock)) return sock || "?";
    const hops = String(req.headers["x-forwarded-for"] ?? "").split(",").map((s) => plain(s.trim())).filter(Boolean);
    for (let i = hops.length - 1; i >= 0; i--) {
      if (!isIP(hops[i])) return sock;   // garbage: don't believe any of it
      if (!this.trusted(hops[i])) return hops[i];
    }
    return hops[0] ?? sock;
  }

  /** https as seen by the browser (behind a TLS-terminating proxy). */
  https(req: http.IncomingMessage): boolean {
    if ((req.socket as { encrypted?: boolean }).encrypted) return true;
    if (!this.trusted(req.socket.remoteAddress ?? "")) return false;
    return String(req.headers["x-forwarded-proto"] ?? "").split(",").pop()?.trim() === "https";
  }
}

/** On every response. */
export const SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "same-origin",
  "X-Frame-Options": "DENY",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), display-capture=(), payment=(), usb=()",
};

/** CSP for one of our pages: its inline scripts by hash, nothing else. */
export function pageCsp(html: string, frameAncestors = "'none'"): string {
  const hashes = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
    .map((m) => `'sha256-${createHash("sha256").update(m[1]).digest("base64")}'`);
  return [
    "default-src 'none'",
    `script-src ${hashes.join(" ") || "'none'"}`,
    "style-src 'unsafe-inline'",   // inline <style> and per-speaker colour attributes
    "img-src 'self' blob: data:",
    "media-src 'self'",
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'self'",
    `frame-ancestors ${frameAncestors}`,
  ].join("; ");
}

/**
 * Who may frame /embed/<meeting> (EMBED_ORIGINS): "*" (the default: it's a
 * public, read-only page with no sign-in and no actions, so framing it
 * exposes nothing), "none", or origins separated by spaces or commas:
 * https://openlangford.ca, https://*.openlangford.ca. Returns a CSP
 * frame-ancestors value. Every other page stays un-frameable.
 */
export function embedAncestors(spec: string | undefined): string {
  const list = (spec ?? "").split(/[\s,]+/).filter(Boolean);
  if (!list.length || (list.length === 1 && list[0] === "*")) return "*";
  if (list.length === 1 && list[0].toLowerCase() === "none") return "'none'";
  for (const o of list) {
    if (!/^https?:\/\/(\*\.)?[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:\d{1,5})?$/i.test(o)) throw new Error(`EMBED_ORIGINS: not an origin: ${o}`);
  }
  return list.join(" ");
}
