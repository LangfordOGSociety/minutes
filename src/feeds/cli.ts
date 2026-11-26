/**
 * `minutes feed ...`: working on a feed parser without the server (#23).
 *
 *   minutes feed parsers                         what's built in, with each one's config fields
 *   minutes feed test <parser> --config '{"url": "..."}' [--fixture file] [--route part=file]...
 *                                                 run it and print what it detects, offline with fixtures
 *
 * --config is JSON, or @file.json. With no fixtures it fetches for real
 * (once, like a Preview). --fixture answers every request from one file;
 * --route "<part of the url>=<file>" answers matching requests (eScribe:
 * --route GetCalendarMeetings=calendar.json --route Meeting.aspx=agenda.html).
 * --tz and --now (ISO) pin the clock. Warnings are things a parser author
 * should look at before shipping: duplicate ids, a link no platform takes,
 * an odd date. --strict makes them an error (exit 1).
 */
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { shownLink } from "./sync.js";
import { feedContext } from "./context.js";
import { fixtureResolver } from "./fixture.js";
import "./parsers/index.js";
import { parserById, parsers } from "./registry.js";
import { localDateTime } from "./time.js";
import { ConfigError, type DetectedMeeting } from "./types.js";
import { findLink } from "../platforms/registry.js";

/** Things worth a second look in a parser's output. */
export function lint(ms: DetectedMeeting[], now: Date): string[] {
  const w: string[] = [];
  const seen = new Map<string, number>();
  for (const m of ms) seen.set(m.externalId, (seen.get(m.externalId) ?? 0) + 1);
  for (const [id, n] of seen) if (n > 1) w.push(`externalId "${id}" appears ${n} times: it must identify ONE meeting, stably across polls`);
  for (const m of ms) {
    const who = `"${m.title}" (${m.externalId})`;
    if (!m.title.trim()) w.push(`${who}: empty title`);
    if (Number.isNaN(m.start.getTime())) w.push(`${who}: start isn't a valid date`);
    else if (Math.abs(m.start.getTime() - now.getTime()) > 3 * 365 * 86_400_000) w.push(`${who}: start ${m.start.toISOString()} is over 3 years from now (wrong year? wrong timezone?)`);
    if (m.end && m.end.getTime() < m.start.getTime()) w.push(`${who}: ends before it starts`);
    if (m.link && !findLink(m.link)) w.push(`${who}: link isn't one any platform takes (it will be dropped)`);
    if (/pwd=|passcode/i.test(`${m.pageUrl ?? ""} ${m.agendaUrl ?? ""} ${m.streamUrl ?? ""}`)) w.push(`${who}: a public URL carries a passcode`);
    if (m.pageUrl && !/^https?:\/\//i.test(m.pageUrl)) w.push(`${who}: pageUrl isn't http(s)`);
  }
  return w;
}

/** One line per meeting for people. Links show as platform + number, never the passcode. */
export function describe(m: DetectedMeeting, tz: string): string[] {
  const link = m.link ? `${shownLink(m.link)}${/[?&]pwd=/.test(m.link) ? " (passcode found)" : ""}` : "none";
  const head = `${localDateTime(m.start, tz)}  ${m.title}${m.body && m.body !== m.title ? `  [${m.body}]` : ""}${m.cancelled ? "  CANCELLED" : ""}`;
  const more = [`join link: ${link}`, m.streamUrl ? `stream: ${m.streamUrl}` : null, m.agendaUrl ? `agenda: ${m.agendaUrl}` : null,
    m.pageUrl ? `page: ${m.pageUrl}` : null, m.documents ? `documents: ${m.documents.length}` : null].filter(Boolean).join("   ");
  return [head, `    ${more}`];
}

export async function feedCommand(argv: string[], out: (s: string) => void = console.log): Promise<number> {
  const err = (s: string) => { console.error(s); return 1; };
  const [sub, ...rest] = argv;
  if (sub === "parsers") {
    for (const p of parsers()) {
      out(`${p.id}: ${p.label}`);
      out(`  ${p.description}`);
      out(`  config: ${p.fields.map((f) => `${f.name}${f.required ? "*" : ""} (${f.type})`).join(", ")}`);
    }
    return 0;
  }
  if (sub !== "test") return err("usage: minutes feed parsers | minutes feed test <parser> --config <json|@file> [--fixture <file>] [--route <part>=<file>]... [--tz <zone>] [--now <ISO>] [--json] [--strict]");
  const spec = { config: { type: "string" }, fixture: { type: "string" }, route: { type: "string", multiple: true }, tz: { type: "string" }, now: { type: "string" },
    json: { type: "boolean" }, strict: { type: "boolean" } } as const;
  let parsed: ReturnType<typeof parseArgs<{ allowPositionals: true; strict: true; options: typeof spec }>>;
  try { parsed = parseArgs({ args: rest, allowPositionals: true, strict: true, options: spec }); } catch (e) { return err((e as Error).message); }
  const { values: v, positionals } = parsed;
  const parser = positionals[0] ? parserById(positionals[0]) : undefined;
  if (!parser) return err(`unknown parser "${positionals[0] ?? ""}"; built in: ${parsers().map((p) => p.id).join(", ")}`);
  let raw: unknown;
  try {
    const c = String(v.config ?? "{}");
    raw = JSON.parse(c.startsWith("@") ? readFileSync(c.slice(1), "utf8") : c);
  } catch (e) { return err(`--config isn't JSON (or @file.json): ${(e as Error).message}`); }
  let config: unknown;
  try { config = parser.validate(raw); } catch (e) { return err(e instanceof ConfigError ? `config: ${e.message}` : String(e)); }
  const tz = String(v.tz ?? process.env.TZ ?? "America/Vancouver");
  const now = v.now ? new Date(String(v.now)) : new Date();
  if (Number.isNaN(now.getTime())) return err("--now isn't a date");
  let fixtures;
  try { fixtures = v.fixture || v.route?.length ? fixtureResolver({ fallback: v.fixture, routes: v.route }) : undefined; }
  catch (e) { return err((e as Error).message); }
  const ctx = feedContext({ tz, now, label: `feed test ${parser.id}`, fixtures });
  try {
    const r = await parser.fetch(config, ctx);
    if ("notModified" in r) return err("the source said not modified (it shouldn't without a cache): nothing to show");
    const ms = [...r.meetings].sort((a, b) => a.start.getTime() - b.start.getTime());
    const warnings = lint(ms, now);
    if (v.json) {
      out(JSON.stringify({ meetings: ms.map((m) => ({ ...m, start: m.start.toISOString(), end: m.end?.toISOString(), link: shownLink(m.link) })), warnings, log: ctx.lines }, null, 2));
    } else {
      for (const m of ms) for (const l of describe(m, tz)) out(l);
      const withLink = ms.filter((m) => m.link).length, withStream = ms.filter((m) => m.streamUrl).length;
      out(`\n${ms.length} meeting(s): ${withLink} with a join link, ${withStream} with a stream page, ${ms.filter((m) => m.cancelled).length} cancelled`);
      for (const l of ctx.lines) out(`log: ${l}`);
      for (const w of warnings) out(`warning: ${w}`);
    }
    return v.strict && warnings.length ? 1 : 0;
  } catch (e) {
    return err(`the parser failed: ${(e as Error).message}`);
  } finally {
    await ctx.close();
  }
}
