/** The real server on a random port, and a small cookie-keeping client. */
import type { AddressInfo } from "node:net";
import { createApp } from "../src/serve.js";
import type { HasAfter } from "./helpers.js";

export async function startApp(t: HasAfter, out: string, extra: Record<string, unknown> = {}) {
  const app = createApp({
    host: "127.0.0.1", port: 0, tz: "America/Vancouver", secureCookie: true,
    out, auth: null, defaultName: "Recorder", leadMs: 0, noShowMs: 30 * 60_000, maxConcurrent: 1, width: 1280, height: 720,
    session: { refreshMs: 86_400_000, preflightMs: 0, notifyUrl: null }, backup: null, thumbnails: false, docMirror: false, snapshotMs: 0, ...extra,
  }, "/nonexistent/index.js");
  await new Promise<void>((r) => app.server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  t.after(() => app.close());
  return { app, base };
}

/** A tiny client that keeps one session cookie. */
export class Client {
  cookie = "";
  constructor(readonly base: string) {}
  async req(method: string, p: string, body?: unknown, headers: Record<string, string> = {}) {
    const h: Record<string, string> = { ...headers };
    if (this.cookie) h.cookie = this.cookie;
    if (body !== undefined) h["content-type"] = "application/json";
    const r = await fetch(this.base + p, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual" });
    const set = r.headers.get("set-cookie");
    if (set) this.cookie = /Max-Age=0/.test(set) ? "" : set.split(";")[0];
    const text = await r.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: r.status, json, text, headers: r.headers, setCookie: set };
  }
  get(p: string) { return this.req("GET", p); }
  post(p: string, body: unknown = {}) { return this.req("POST", p, body); }
  login(email: string, password: string) { return this.post("/api/login", { email, password }); }
}
