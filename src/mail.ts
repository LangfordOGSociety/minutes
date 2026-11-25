/**
 * Outgoing mail (#32): a minimal SMTP submission client on node:tls, so
 * still no runtime deps. One message per connection: greeting, EHLO,
 * AUTH PLAIN, MAIL FROM, RCPT TO, DATA, QUIT.
 *
 * Configured by
 *   SMTP_URL       smtps://user@host:465 (implicit TLS). The password may be
 *                  in the URL (percent-encoded) or in SMTP_PASSWORD.
 *                  smtp://host:port is plain text: tests and local relays only.
 *   SMTP_PASSWORD  overrides the URL's password (keep it in a Secret)
 *   MAIL_FROM      "minutes <minutes@emc2.build>"
 *
 * Homelab: Cloudflare Email Service, smtps://api_token@smtp.mx.cloudflare.net:465
 * with an API token as the password; emc2.build is onboarded for sending.
 * Without SMTP_URL there's no mailer, and sign-up is off.
 */
import { randomBytes } from "node:crypto";
import net from "node:net";
import tls from "node:tls";
import { logger } from "./util.js";

const log = logger("mail");

export interface Message { to: string; subject: string; text: string }

export interface Mailer {
  readonly from: string;
  send(m: Message): Promise<void>;
}

export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;            // implicit TLS (smtps)
  user: string | null;
  password: string | null;
  from: string;               // display form: "name <addr>" or "addr"
  timeoutMs?: number;
  /** Tests only: trust this CA / skip name checks. */
  tls?: tls.ConnectionOptions;
}

export function parseSmtpUrl(url: string, password: string | undefined, from: string): SmtpConfig {
  let u: URL;
  try { u = new URL(url); } catch { throw new Error("SMTP_URL isn't a URL"); }
  if (u.protocol !== "smtps:" && u.protocol !== "smtp:") throw new Error("SMTP_URL must be smtps://... (or smtp:// for a local relay)");
  if (!u.hostname) throw new Error("SMTP_URL has no host");
  addrOf(from);   // validates MAIL_FROM
  return {
    host: u.hostname, port: Number(u.port || (u.protocol === "smtps:" ? 465 : 25)), secure: u.protocol === "smtps:",
    user: u.username ? decodeURIComponent(u.username) : null,
    password: password || (u.password ? decodeURIComponent(u.password) : null),
    from,
  };
}

const ADDR = /^[^\s@<>"(),;:\\]+@[^\s@<>"(),;:\\]+\.[^\s@<>"(),;:\\]+$/;

/** The bare address in "Name <addr>" or "addr". Throws if there isn't one. */
export function addrOf(v: string): string {
  if (/[\r\n]/.test(v)) throw new Error("line breaks in an address");
  const m = /<([^<>]+)>\s*$/.exec(v);
  const a = (m ? m[1] : v).trim();
  if (!ADDR.test(a)) throw new Error(`not an email address: ${v}`);
  return a;
}

/** RFC 2047 for a header value that isn't plain ASCII. */
const encodeHeader = (s: string) => /^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, "utf8").toString("base64")}?=`;

/** "Name <addr>" with the name encoded if needed. */
function fromHeader(from: string): string {
  const m = /^(.*?)\s*<([^<>]+)>\s*$/.exec(from);
  if (!m || !m[1]) return addrOf(from);
  const name = m[1].replace(/^"|"$/g, "");
  return `${/^[\w .-]*$/.test(name) ? name : encodeHeader(name)} <${addrOf(from)}>`;
}

export function buildMessage(from: string, m: Message, now = new Date()): string {
  for (const v of [m.to, m.subject]) if (/[\r\n]/.test(v)) throw new Error("line breaks in a header");
  const to = addrOf(m.to);
  const domain = addrOf(from).split("@")[1];
  const body = Buffer.from(m.text.replace(/\r?\n/g, "\r\n"), "utf8").toString("base64").replace(/.{76}/g, "$&\r\n");
  return [
    `From: ${fromHeader(from)}`,
    `To: ${to}`,
    `Subject: ${encodeHeader(m.subject)}`,
    `Date: ${now.toUTCString().replace("GMT", "+0000")}`,
    `Message-ID: <${randomBytes(12).toString("hex")}@${domain}>`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "Auto-Submitted: auto-generated",
    "",
    body,
  ].join("\r\n");
}

/** Reads SMTP replies (multi-line "250-..." ending in "250 ...") off a socket. */
class Replies {
  private buf = "";
  private waiters: ((r: { code: number; text: string } | Error) => void)[] = [];
  private queue: ({ code: number; text: string } | Error)[] = [];
  private lines: string[] = [];

  constructor(sock: net.Socket) {
    sock.setEncoding("utf8");
    sock.on("data", (d: string) => {
      this.buf += d;
      let i;
      while ((i = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, i).replace(/\r$/, "");
        this.buf = this.buf.slice(i + 1);
        this.lines.push(line);
        if (/^\d{3}(?!-)/.test(line)) {
          this.push({ code: Number(line.slice(0, 3)), text: this.lines.map((l) => l.slice(4)).join("\n") });
          this.lines = [];
        }
      }
      if (this.buf.length > 64 * 1024) this.push(new Error("SMTP reply too long"));
    });
    const fail = (e: Error) => this.push(e);
    sock.on("error", fail);
    sock.on("close", () => this.push(new Error("SMTP connection closed")));
  }

  private push(r: { code: number; text: string } | Error) {
    const w = this.waiters.shift();
    if (w) w(r); else this.queue.push(r);
  }

  next(): Promise<{ code: number; text: string }> {
    const r = this.queue.shift();
    if (r) return r instanceof Error ? Promise.reject(r) : Promise.resolve(r);
    return new Promise((resolve, reject) => this.waiters.push((x) => (x instanceof Error ? reject(x) : resolve(x))));
  }
}

export class SmtpMailer implements Mailer {
  readonly from: string;
  constructor(private c: SmtpConfig) { this.from = c.from; }

  async send(m: Message): Promise<void> {
    const data = buildMessage(this.c.from, m);
    const to = addrOf(m.to);
    const sock: net.Socket = this.c.secure
      ? tls.connect({ host: this.c.host, port: this.c.port, servername: this.c.host, ...this.c.tls })
      : net.connect({ host: this.c.host, port: this.c.port });
    sock.setTimeout(this.c.timeoutMs ?? 30_000, () => sock.destroy(new Error("SMTP timed out")));
    const replies = new Replies(sock);
    const expect = async (codes: number[], what: string) => {
      const r = await replies.next();
      if (!codes.includes(r.code)) throw new Error(`SMTP ${what}: ${r.code} ${r.text.split("\n").pop()}`.slice(0, 300));
      return r;
    };
    const cmd = (line: string) => sock.write(line + "\r\n");
    try {
      await expect([220], "greeting");
      cmd(`EHLO ${addrOf(this.c.from).split("@")[1]}`);
      await expect([250], "EHLO");
      if (this.c.user) {
        cmd("AUTH PLAIN " + Buffer.from(`\0${this.c.user}\0${this.c.password ?? ""}`, "utf8").toString("base64"));
        await expect([235], "AUTH");
      }
      cmd(`MAIL FROM:<${addrOf(this.c.from)}>`);
      await expect([250], "MAIL FROM");
      cmd(`RCPT TO:<${to}>`);
      await expect([250, 251], "RCPT TO");
      cmd("DATA");
      await expect([354], "DATA");
      // Dot-stuffing: a line starting with "." gets another.
      sock.write(data.replace(/(^|\r\n)\./g, "$1..") + "\r\n.\r\n");
      await expect([250], "message");
      cmd("QUIT");
      await replies.next().catch(() => null);   // 221; the message is already accepted
      log.info(`sent "${m.subject}" to ${to.replace(/^(.).*(@.*)$/, "$1***$2")}`);
    } finally {
      sock.end();
      sock.destroy();
    }
  }
}

/** The mailer from the environment, or null (mail off). Throws on bad config. */
export function mailerFromEnv(env: NodeJS.ProcessEnv): Mailer | null {
  if (!env.SMTP_URL) return null;
  if (!env.MAIL_FROM) throw new Error("SMTP_URL is set but MAIL_FROM isn't");
  return new SmtpMailer(parseSmtpUrl(env.SMTP_URL, env.SMTP_PASSWORD, env.MAIL_FROM));
}
