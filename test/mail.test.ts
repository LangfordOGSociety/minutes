import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SmtpMailer, addrOf, buildMessage, mailerFromEnv, parseSmtpUrl } from "../src/mail.js";
import { fakeSmtp } from "./smtp.js";

describe("mail config", () => {
  it("parses SMTP_URL; the password can come from SMTP_PASSWORD", () => {
    const c = parseSmtpUrl("smtps://api_token@smtp.mx.cloudflare.net:465", "tok", "minutes <minutes@emc2.build>");
    assert.deepEqual({ ...c }, { host: "smtp.mx.cloudflare.net", port: 465, secure: true, user: "api_token", password: "tok", from: "minutes <minutes@emc2.build>" });
    assert.equal(parseSmtpUrl("smtps://u:p%40ss@h", undefined, "a@b.co").password, "p@ss");
    assert.equal(parseSmtpUrl("smtps://h", undefined, "a@b.co").port, 465);
    assert.throws(() => parseSmtpUrl("https://h", undefined, "a@b.co"), /smtps/);
    assert.throws(() => parseSmtpUrl("smtps://h", undefined, "nope"), /not an email address/);
    assert.equal(mailerFromEnv({}), null);
    assert.throws(() => mailerFromEnv({ SMTP_URL: "smtps://h" }), /MAIL_FROM/);
  });

  it("addresses: bare or with a name, never with line breaks", () => {
    assert.equal(addrOf("minutes <minutes@emc2.build>"), "minutes@emc2.build");
    assert.equal(addrOf("a@b.co"), "a@b.co");
    assert.throws(() => addrOf("a@b.co\r\nBcc: x@y.co"), /line breaks/);
    assert.throws(() => addrOf("<>"), /not an email/);
  });

  it("builds a UTF-8 message with encoded headers, refuses header injection", () => {
    const m = buildMessage("minutes <minutes@emc2.build>", { to: "x@example.com", subject: "Café code: 123456", text: "Hé\nline 2\n.dot" });
    const [head, body] = m.split("\r\n\r\n");
    assert.match(head, /^From: minutes <minutes@emc2\.build>\r\nTo: x@example\.com\r\nSubject: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=\r\n/);
    assert.match(head, /Message-ID: <[0-9a-f]{24}@emc2\.build>/);
    assert.equal(Buffer.from(body.replace(/\r\n/g, ""), "base64").toString("utf8"), "Hé\r\nline 2\r\n.dot");
    assert.throws(() => buildMessage("a@b.co", { to: "x@example.com", subject: "hi\r\nBcc: y@example.com", text: "" }), /line breaks/);
  });
});

describe("SmtpMailer against a fake server", () => {
  it("sends: EHLO, AUTH PLAIN, envelope, data, QUIT", async (t) => {
    const s = await fakeSmtp({ multiline: true });
    t.after(s.close);
    const m = new SmtpMailer(parseSmtpUrl(s.url, "secret", "minutes <minutes@emc2.build>"));
    await m.send({ to: "x@example.com", subject: "Your minutes code: 123456", text: "Enter it." });
    assert.equal(s.got.length, 1);
    assert.equal(s.got[0].auth, "\0user\0secret");
    assert.equal(s.got[0].from, "<minutes@emc2.build>");
    assert.equal(s.got[0].to, "<x@example.com>");
    assert.deepEqual(s.got[0].commands, ["EHLO emc2.build", "AUTH PLAIN ...", "MAIL FROM:<minutes@emc2.build>", "RCPT TO:<x@example.com>", "DATA", "QUIT"]);
    assert.match(s.got[0].data, /^From: minutes <minutes@emc2\.build>\r\n/);
  });

  it("fails clearly on bad credentials or a dead server", async (t) => {
    const s = await fakeSmtp({ rejectAuth: true });
    t.after(s.close);
    await assert.rejects(new SmtpMailer(parseSmtpUrl(s.url, "wrong", "a@b.co")).send({ to: "x@example.com", subject: "s", text: "t" }),
      /SMTP AUTH: 535 5\.7\.8 bad credentials/);
    assert.equal(s.got.length, 0);
    await assert.rejects(new SmtpMailer({ ...parseSmtpUrl("smtp://127.0.0.1:9", undefined, "a@b.co"), timeoutMs: 2000 })
      .send({ to: "x@example.com", subject: "s", text: "t" }), /ECONNREFUSED|closed/);
  });
});
