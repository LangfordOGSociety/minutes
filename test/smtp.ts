/**
 * A fake SMTP server for tests: speaks enough of the protocol for
 * mail.ts, records each message, and can be told to refuse AUTH.
 */
import net from "node:net";
import type { AddressInfo } from "node:net";
import type { Mailer, Message } from "../src/mail.js";

export interface Received { auth: string | null; from: string; to: string; data: string; commands: string[] }

export async function fakeSmtp(o: { rejectAuth?: boolean; multiline?: boolean } = {}) {
  const got: Received[] = [];
  const server = net.createServer((s) => {
    s.setEncoding("utf8");
    const cur: Received = { auth: null, from: "", to: "", data: "", commands: [] };
    let buf = "", inData = false;
    const say = (l: string) => s.write(l + "\r\n");
    say("220 fake ESMTP ready");
    s.on("data", (d: string) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\r\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (inData) {
          if (line === ".") { inData = false; got.push({ ...cur }); say("250 2.0.0 queued"); }
          else cur.data += line + "\r\n";
          continue;
        }
        cur.commands.push(line.replace(/^(AUTH PLAIN) .*/, "$1 ..."));
        if (/^EHLO /.test(line)) { if (o.multiline) { say("250-fake"); say("250-AUTH PLAIN"); } say("250 OK"); }
        else if (/^AUTH PLAIN /.test(line)) {
          cur.auth = Buffer.from(line.slice(11), "base64").toString("utf8");
          say(o.rejectAuth ? "535 5.7.8 bad credentials" : "235 2.7.0 ok");
        } else if (/^MAIL FROM:/.test(line)) { cur.from = line.slice(10); say("250 ok"); }
        else if (/^RCPT TO:/.test(line)) { cur.to = line.slice(8); say("250 ok"); }
        else if (line === "DATA") { inData = true; say("354 go"); }
        else if (line === "QUIT") { say("221 bye"); s.end(); }
        else say("500 what");
      }
    });
    s.on("error", () => {});
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return { got, url: `smtp://user@127.0.0.1:${port}`, close: () => new Promise<void>((r) => server.close(() => r())) };
}

/** A mailer that only remembers what it was asked to send. */
export class MemoryMailer implements Mailer {
  readonly from = "minutes <minutes@example.com>";
  sent: Message[] = [];
  async send(m: Message): Promise<void> { this.sent.push(m); }
  /** The 6-digit code in the last message to `to`. */
  code(to: string): string | null {
    const m = [...this.sent].reverse().find((x) => x.to === to);
    return m ? /\b(\d{6})\b/.exec(m.subject)?.[1] ?? null : null;
  }
}
