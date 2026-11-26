# Writing a feed parser

A feed parser turns one source (an agenda portal, a calendar, a web page)
into a list of meetings. It fetches and parses and **nothing else**: no
database, no scheduling, no files. Diffing, history, review, dedup and
captures are core code (`src/feeds/sync.ts`), so a parser bug can't cancel
a capture except through what it returns, and the sync guards that too.

Built in: `ical`, `html`, `escribe`, `granicus`, `primegov`
(`minutes feed parsers`). Read the closest one first.

## The interface (`src/feeds/types.ts`)

```ts
export const myParser: FeedParser<Config> = {
  id: "mine", label: "My portal", description: "What it reads.",
  fields: [{ name: "baseUrl", label: "Portal URL", type: "url", required: true }],  // builds the admin form
  validate(c) { const o = cfg.obj(c); return { baseUrl: cfg.url(o, "baseUrl") }; },  // throw ConfigError(field, msg)
  host(c) { return c.baseUrl; },                    // polled one-at-a-time per host
  async fetch(c, ctx) {                              // ctx.http, ctx.page, ctx.tz, ctx.now, ctx.log
    const r = await ctx.http(c.baseUrl + "api/meetings", { conditional: true });
    if (r.notModified) return { notModified: true };
    return { meetings: parse(r.body, ctx) };
  },
};
registerParser(myParser);                            // and import it in parsers/index.ts
```

Use `ctx.http` for every request (User-Agent, 30 s timeout, 8 MB cap, http(s)
only, ETag / Last-Modified when `conditional: true`) and `ctx.page(url)` only
when the page needs JavaScript (headless Chromium). Never `fetch` directly.

## What a meeting is (`DetectedMeeting`)

`externalId`, `title`, `start` are required. Optional: `body` (the council
or committee), `end`, `link`, `pageUrl`, `streamUrl`, `agendaUrl`,
`cancelled`, `documents` (`{title, type?, url}`).

- **`externalId` identifies one meeting, the same on every poll.** The
  source's own id if it has one (eScribe `ID`, iCal `UID`). If it has none,
  hash what doesn't change (granicus: name + start). Never a list position,
  never something that changes when the meeting is edited: a changed id is a
  "removed" and an "added", and loses the history.
- **Times are local wall times.** Sources print "5:30 PM" in the city's zone;
  convert with `zonedTime(tz, y, m, d, h, mi)` (`src/feeds/time.ts`). Ignore
  a hidden epoch if it disagrees with the visible time (Granicus's is 3 h
  off). Take the zone from config if the source can differ from the server's.
- **`link` is a join link for a supported platform, or leave it out.** Run
  free text through `findLink(text)` (`platforms/registry.ts`): it finds a
  Zoom URL, or "Meeting ID ... Passcode ..." and builds one. Links are
  secret once stored; never put one in `pageUrl`, `agendaUrl` or `streamUrl`.
- **`streamUrl`** only when the source says there is a stream (eScribe's
  video link exists for every meeting; use it only when `HasLiveVideo`).
- **`cancelled`** only on evidence (a "cancelled" title, a cancellation
  notice). A "postponement notice" is not a cancellation.
- **`documents`** are everything the source lists; leave it `undefined` if
  the parser doesn't know (then nothing about documents is logged). The URL
  is the identity.
- **No meeting types configured = every meeting.** Filters are opt-in.

## Test it offline, without the server

Save the pages you read as fixtures (`test/fixtures/feeds/<id>/`), then:

```
minutes feed test mine --config '{"baseUrl": "https://portal.example/"}' \
  --route api/meetings=test/fixtures/feeds/mine/list.json \
  --route Meeting.aspx=test/fixtures/feeds/mine/agenda.html \
  --tz America/Vancouver --now 2026-11-25T12:00:00Z
```

`--fixture <file>` answers every request with one file; `--route
<part of "METHOD url">=<file>` answers matching ones (the first match
wins). A request with no fixture fails by name, never a real fetch. `--json`
prints everything, `--strict` exits 1 on warnings. Without fixtures it
fetches for real, once. Links print as platform + meeting number, never with
a passcode. The warnings are the checklist below, automated.

## Checklist

1. `validate` rejects bad config with a message naming the field.
2. Fixtures saved from the real source, trimmed, committed; a
   `test/<id>.test.ts` drives `parser.fetch` through `feedContext({ fixtures })`.
3. `minutes feed test ... --strict` is clean: unique ids, sane dates, no
   passcode in a public URL, links a platform accepts.
4. Run the fetch twice: the second must produce the same ids and, with
   `conditional: true`, a 304 should end the run.
5. A time near midnight, a cancelled meeting, a meeting with no link and
   one with a link all appear in the fixtures.
6. Docs: one paragraph in CLAUDE.md's Layout (what the source is, what you
   learned that isn't obvious), and add the parser to `parsers/index.ts`.

New feeds default to the `review` policy: a person approves each meeting
before anything is captured, so a parser's first mistakes are cheap.
