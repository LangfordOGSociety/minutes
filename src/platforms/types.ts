/**
 * The seam between the runner and a meeting platform.
 *
 * A Platform knows which links it handles, how to clean one up, what part of
 * it is safe to show (the link itself is secret: it carries the passcode),
 * and how to open a CaptureSession. The runner drives a session through
 * State and records whatever it shows; everything platform-specific (page
 * markers, join flow, sign-in) stays inside the platform's own file.
 *
 * Adding a platform: implement both interfaces in src/platforms/<id>.ts and
 * add it to PLATFORMS in registry.ts. A browser platform must install
 * mediaGuard() (guard.ts) as its first init script.
 */

import type { RecorderInput } from "../recorder.js";

/** What the runner sees. Every platform maps its own screens onto these. */
export enum State {
  LOADING = "loading",           // page coming up / unrecognised screen
  PREJOIN = "prejoin",           // name entry or preview
  WAITING = "waiting",           // waiting for host, webinar not started
  IN_MEETING = "in_meeting",
  RECONNECTING = "reconnecting", // in meeting, the platform says the connection is bad
  ENDED = "ended",
  BLOCKED = "blocked",           // the platform refused us (bot check, sign-in required)
  INVALID = "invalid",           // the link/ID doesn't point at a meeting
  DEAD = "dead",                 // browser or page gone
}

/** How a platform's meetings are recorded. "screen" is a browser on an Xvfb
 *  display recorded with x11grab + the job's PulseAudio sink (Zoom).
 *  "stream" pulls a media URL with ffmpeg (YouTube); the scheduler gives
 *  such jobs no display or sink. */
export type CaptureMethod = "screen" | "stream";

export interface SessionOpts {
  method: CaptureMethod;    // one of the platform's methods
  displayName: string;      // the name the bot joins as
  width: number;
  height: number;
  auth: string | null;      // saved login (Playwright storage state), if the platform uses one
  email: string | null;     // typed only when the meeting requires one
}

export interface CaptureSession {
  open(): Promise<void>;
  close(): Promise<void>;
  /** Current classification. Cheap; called on every wake-up. */
  state(): Promise<State>;
  /** Do whatever moves things along from this state (click Join, dismiss a
   *  notice, turn captions on). Must never send audio or video. */
  advance(state: State): Promise<void>;
  /** Debug dump (screenshot + HTML) as <dir>/<label>.*. Never throws. */
  dump(dir: string, label: string): Promise<void>;
  /** The meeting wants an email to join and none was given. */
  needsEmail: boolean;
  /** Called on any state change the session notices (wakes the runner). */
  onChange: (state: string) => void;
  /** Active speaker changed ("" = none shown). */
  onSpeaker: (name: string) => void;
  /** Caption text changed ("" = cleared). */
  onCaption: (text: string) => void;
  /** What to record once IN_MEETING. Leave it out for a screen session
   *  (the runner records its display and sink); a stream session returns
   *  the URL it resolved in open(). Called at the start of every part. */
  input?(): RecorderInput;
}

export interface Platform {
  id: string;                         // stored in meetings.platform
  label: string;
  methods: CaptureMethod[];           // first is the default
  /** Uses the saved login (auth/zoom-auth.json) kept alive by session.ts. */
  savedLogin: boolean;
  /** Does this link (or bare id) belong to this platform? Cheap, no I/O. */
  match(link: string): boolean;
  /** Validated, canonical link. Throws an Error with a user-facing message. */
  normalize(link: string): string;
  /** What may be shown for this link (e.g. the meeting number). */
  publicId(link: string): string;
  create(link: string, o: SessionOpts): CaptureSession;
}
