# Adding a meeting platform

A platform knows which links it handles and how to open a **capture
session** for one. The runner (`src/runner.ts`) only drives a session
through `State` and records what it shows, so everything platform-specific
stays in `src/platforms/<id>.ts`. Zoom is the reference (`zoom.ts`).

## Files and registration

1. `src/platforms/<id>.ts`: a `Platform` and its `CaptureSession`.
2. Add it to `PLATFORMS` in `registry.ts`. Links no platform claims are
   refused, so that list is also the **link allowlist** for the signed-in
   browser: make `match` strict (host and path), not "contains".
3. Tests (below) and a paragraph in CLAUDE.md.

## The interface (`src/platforms/types.ts`)

```ts
interface Platform {
  id: string; label: string;
  methods: CaptureMethod[];            // "screen" (browser on Xvfb) and/or "stream" (ffmpeg on a URL); first is the default
  savedLogin: boolean;                 // true only if it uses the kept-alive saved login (Zoom)
  match(link): boolean;                // cheap, no I/O
  normalize(link): string;             // canonical link; throw an Error with a message for the user
  publicId(link): string;              // what may be shown: the meeting number, never the passcode
  publicUrl?(link): string | undefined;// the link without its secret parts, for admins
  extractLink?(text): string | undefined; // find a join link in an agenda's free text (feeds)
  create(link, opts): CaptureSession;
}
interface CaptureSession {
  open(); close(); state(): Promise<State>; advance(state); dump(dir, label);
  needsEmail: boolean; onChange; onSpeaker; onCaption;
  input?(): RecorderInput;             // stream sessions: the URL to record (called at the start of every part)
}
```

`State` is the shared enum every platform maps its screens onto: `loading`,
`prejoin`, `waiting`, `in_meeting`, `reconnecting`, `ended`, `blocked` (the
platform refused us: bot check, sign-in required), `invalid`, `dead`. The
runner starts recording at `in_meeting`, rejoins as a new part after a drop,
and stops at `ended`. `state()` must be cheap (it runs on every wake-up);
call `onChange` when something changes so the runner doesn't wait for its
poll. `advance(state)` does what moves things along (click Join, dismiss a
notice) and **must never send audio or video**.

## A screen platform (a browser)

- Install `mediaGuard()` (`platforms/guard.ts`) as the **first** init script in
  every context, before any platform code. It disables every microphone
  track the page gets, refuses camera and screen share. Never grant the
  camera permission. Default PulseAudio source stays `silence.monitor`.
- Put every page-specific text and selector in one `MARKERS` table at the top
  of the file, each entry commented with **where and when it was seen**
  (`seen live 2026-11-24, Langford webinar`) or `best guess, NOT seen live`.
  Page text changes without notice; a fix should be one line in `MARKERS`.
- Classify in the page (`pageAgent`, serialized with `addInitScript`, so
  self-contained: no outer references) and test the classifier on saved HTML.
- `dump()` writes a screenshot and each frame's HTML (`CAPTURE_DEBUG=1`).
  Dumps become fixtures.

## A stream platform

`input()` returns `{ kind: "stream", args }`: the ffmpeg input arguments for
the URL (`-c copy` where possible). The scheduler gives such jobs no Xvfb
display or sink. Map the source's live status onto `State` (`waiting` before
it starts, `in_meeting` while live, `ended` after). Parts and stitching are
the same as for a screen capture.

## Tests (no meeting needed)

- `match` / `normalize` / `publicId` on real links, including ones that must
  be refused (other hosts, look-alikes, a link with credentials).
- The classifier against saved HTML for **every screen** you've seen
  (prejoin, waiting, in meeting, ended, blocked, invalid); add a case whenever
  a live page breaks a marker.
- Media safety in Chromium, like `test/guard.test.ts`: peak level exactly 0
  with an unguarded control that is audible, video and screen share refused.
- Stream: a fake binary in `scripts/` (like `fake-ffmpeg.sh`) driving the
  state mapping and a part boundary.

## What only a live meeting can show

Say so in CLAUDE.md under "Still untested live", and don't enable the
platform for a feed until each has been run against a throwaway meeting:
how anonymous join behaves (name field, lobby, a tenant that blocks it), what
"ended" looks like, whether a bot check fires from the homelab IP, that
`in_meeting` is not reported while still in a lobby, and a measured
**audio peak of 0** in the image. A first real meeting is a test, so run it
on one you can lose.
