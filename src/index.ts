// Set the timezone before any Date is created so "2026-11-16T19:00" means
// 7pm local, not 7pm wherever the container thinks it is.
process.env.TZ ??= "America/Vancouver";

import { existsSync } from "node:fs";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { login } from "./login.js";
import { serve } from "./serve.js";
import { Capture, type Config } from "./runner.js";
import type { Encoder } from "./recorder.js";
import { SLUG_RE, defaultSlug } from "./util.js";
import { platformFor } from "./platforms/registry.js";
import type { CaptureMethod } from "./platforms/types.js";

const USAGE = `usage: minutes --link <zoom link or id> --start <ISO datetime> [options]
       minutes login --auth <file>   sign in once in a browser window, save the session
       minutes check-login [--auth <file>]   is the saved session still signed in? (refreshes it)
       minutes serve [--port 8080] [--auth <file>] [--max-jobs 2]
                                          web interface: schedule meetings, replay recordings
                                          (env CAPTURE_WEB_TOKEN sets a password)

  --auth <file>            Zoom session from "login" (env CAPTURE_AUTH). Needed
                           when Zoom blocks anonymous web-client joins.
  --slug <name>            output folder/file name (default meeting-YYYYMMDD-HHMM)
  --name <display name>    name shown in Zoom (default "Recorder")
                           (env CAPTURE_EMAIL: typed only if the host
                           requires an email to join; the host sees it)
  --out <dir>              default /recordings
  --method <screen|stream> how to capture, default: the platform's first
  --lead-min <n>           join this early, default 15
  --no-show-min <n>        give up if not started by start+n, default 120
  --rejoin-wait-min <n>    after a drop, waiting room this long = ended, default 10
  --reconnect-grace-s <n>  ride out Zoom's own reconnect, default 45
  --max-hours <n>          hard cap, default 6
  --fps <n>                default 30 (env CAPTURE_FPS)
  --quality <n>            CRF/QP/CQ, default 23 (env CAPTURE_QUALITY)
  --encoder <x264|vaapi|nvenc>  default x264 (env CAPTURE_ENCODER)`;

function fail(msg: string): never {
  console.error(`${msg}\n\n${USAGE}`);
  process.exit(2);
}

function parse(): Config {
  const env = process.env;
  const { values: v } = parseArgs({
    options: {
      link: { type: "string" },
      start: { type: "string" },
      slug: { type: "string" },
      name: { type: "string", default: env.CAPTURE_NAME ?? "Recorder" },
      out: { type: "string", default: env.CAPTURE_OUT ?? "/recordings" },
      method: { type: "string" },
      "lead-min": { type: "string", default: "15" },
      "no-show-min": { type: "string", default: "120" },
      "rejoin-wait-min": { type: "string", default: "10" },
      "reconnect-grace-s": { type: "string", default: "45" },
      "max-hours": { type: "string", default: "6" },
      "poll-s": { type: "string", default: "3" },
      "retry-base-s": { type: "string", default: "5" },
      "retry-max-s": { type: "string", default: "60" },
      fps: { type: "string", default: env.CAPTURE_FPS ?? "30" },
      quality: { type: "string", default: env.CAPTURE_QUALITY ?? "23" },
      encoder: { type: "string", default: env.CAPTURE_ENCODER ?? "x264" },
      auth: { type: "string", default: env.CAPTURE_AUTH },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
  });
  if (v.help) { console.log(USAGE); process.exit(0); }
  if (!v.link) fail("--link is required");
  if (!v.start) fail("--start is required");

  const start = new Date(v.start);
  if (Number.isNaN(start.getTime())) fail(`can't parse --start ${v.start}`);

  if (v.auth && !existsSync(v.auth)) fail(`--auth file not found: ${v.auth}`);

  const encoder = v.encoder as Encoder;
  if (!["x264", "vaapi", "nvenc"].includes(encoder)) fail(`unknown encoder ${encoder}`);

  const num = (k: string, x: string | undefined) => {
    const n = Number(x);
    if (!Number.isFinite(n) || n < 0) fail(`--${k} must be a number`);
    return n;
  };
  const slug = v.slug ?? defaultSlug(start);
  if (!SLUG_RE.test(slug)) fail(`--slug must be letters, digits, '.', '_' or '-': ${slug}`);

  const platform = platformFor(v.link);
  if (!platform) fail(`no platform handles that link: ${v.link.replace(/([?&]pwd=)[^&]+/, "$1<hidden>")}`);
  const method = (v.method ?? platform.methods[0]) as CaptureMethod;
  if (!platform.methods.includes(method)) fail(`--method must be one of ${platform.methods.join(", ")} for ${platform.label}`);

  return {
    link: v.link,
    method,
    start,
    slug,
    tz: env.TZ!,
    out: v.out!,
    displayName: v.name!,
    auth: v.auth ?? null,
    email: env.CAPTURE_EMAIL?.trim() || null,
    debug: /^(1|true|yes)$/i.test(env.CAPTURE_DEBUG ?? ""),
    display: env.DISPLAY ?? ":99",
    sink: env.CAPTURE_SINK ?? "zoom",
    width: num("width", env.CAPTURE_WIDTH ?? "1920"),
    height: num("height", env.CAPTURE_HEIGHT ?? "1080"),
    fps: num("fps", v.fps),
    quality: num("quality", v.quality),
    encoder,
    vaapiDevice: env.CAPTURE_VAAPI_DEVICE ?? "/dev/dri/renderD128",
    leadMs: num("lead-min", v["lead-min"]) * 60_000,
    noShowMs: num("no-show-min", v["no-show-min"]) * 60_000,
    rejoinWaitMs: num("rejoin-wait-min", v["rejoin-wait-min"]) * 60_000,
    reconnectGraceMs: num("reconnect-grace-s", v["reconnect-grace-s"]) * 1_000,
    maxDurationMs: num("max-hours", v["max-hours"]) * 3_600_000,
    pollMs: num("poll-s", v["poll-s"]) * 1_000,
    retryBaseMs: num("retry-base-s", v["retry-base-s"]) * 1_000,
    retryMaxMs: num("retry-max-s", v["retry-max-s"]) * 1_000,
  };
}

if (process.argv[2] === "login") {
  const { values } = parseArgs({
    args: process.argv.slice(3),
    options: { auth: { type: "string", default: process.env.CAPTURE_AUTH ?? "auth/zoom-auth.json" } },
    strict: true,
  });
  process.exit(await login(values.auth!));
}

if (process.argv[2] === "check-login") {
  const { values } = parseArgs({
    args: process.argv.slice(3),
    options: { auth: { type: "string", default: process.env.CAPTURE_AUTH ?? "auth/zoom-auth.json" } },
    strict: true,
  });
  const { checkLogin } = await import("./session.js");
  const r = await checkLogin(values.auth!);
  console.log(`${r.state}: ${r.detail}`);
  process.exit(r.state === "ok" ? 0 : 1);
}

if (process.argv[2] === "serve") {
  const env = process.env;
  const { values: v } = parseArgs({
    args: process.argv.slice(3),
    options: {
      port: { type: "string", default: env.CAPTURE_PORT ?? "8080" },
      host: { type: "string", default: env.CAPTURE_HOST ?? "0.0.0.0" },
      out: { type: "string", default: env.CAPTURE_OUT ?? "/recordings" },
      auth: { type: "string", default: env.CAPTURE_AUTH },
      name: { type: "string", default: env.CAPTURE_NAME ?? "Recorder" },
      "lead-min": { type: "string", default: "15" },
      "no-show-min": { type: "string", default: "120" },
      "max-jobs": { type: "string", default: env.CAPTURE_MAX_JOBS ?? "2" },
    },
    strict: true,
  });
  const n = (k: string, x: string | undefined, min = 0) => {
    const r = Number(x);
    if (!Number.isFinite(r) || r < min) fail(`--${k} must be a number >= ${min}`);
    return r;
  };
  if (v.auth && !existsSync(v.auth)) fail(`--auth file not found: ${v.auth}`);
  if (!v.auth) console.error("warning: no --auth session; Zoom blocks anonymous web-client joins (see `minutes login`)");
  const entry = fileURLToPath(new URL("./index.js", import.meta.url));
  process.exit(await serve({
    host: v.host!, port: n("port", v.port, 1), token: env.CAPTURE_WEB_TOKEN || null, tz: env.TZ!,
    out: v.out!, auth: v.auth ?? null, defaultName: v.name!,
    leadMs: n("lead-min", v["lead-min"]) * 60_000, noShowMs: n("no-show-min", v["no-show-min"]) * 60_000,
    maxConcurrent: n("max-jobs", v["max-jobs"], 1),
    width: n("width", env.CAPTURE_WIDTH ?? "1920", 1), height: n("height", env.CAPTURE_HEIGHT ?? "1080", 1),
    session: {
      refreshMs: n("CAPTURE_LOGIN_REFRESH_H", env.CAPTURE_LOGIN_REFRESH_H ?? "24", 1) * 3_600_000,
      preflightMs: n("CAPTURE_LOGIN_PREFLIGHT_H", env.CAPTURE_LOGIN_PREFLIGHT_H ?? "2", 0) * 3_600_000,
      notifyUrl: env.CAPTURE_NOTIFY_URL || null,
    },
  }, entry));
}

const capture = new Capture(parse());
let signals = 0;
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    if (++signals > 1) process.exit(130); // second Ctrl-C: bail without stitching
    capture.requestStop();
  });
}
capture.run().then(
  (code) => process.exit(code),
  (e) => { console.error(e); process.exit(1); },
);
