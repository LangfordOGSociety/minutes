/**
 * Shared by every browser-based platform. Install it with
 * `ctx.addInitScript(mediaGuard)` as the FIRST init script, before any
 * platform code, in every context that joins a meeting. Together with the
 * container's silent default PulseAudio source this is what keeps audio and
 * video from ever reaching a meeting (CLAUDE.md, "Invariants").
 *
 * Tested in the image (2026-11-05): a guarded track stays disabled after
 * `enabled = true`, its peak level is exactly 0, video and getDisplayMedia
 * get NotAllowedError, same inside iframes.
 */

/**
 * Client-side mute, injected into every frame before Zoom's code runs.
 * Whatever Zoom or its UI does, the page never gets a live microphone,
 * camera or screen: every audio track it asks for is disabled and can't be
 * re-enabled (own `enabled` property shadows the prototype setter; clones
 * stay guarded), video requests are refused, screen share is refused.
 * Incoming meeting audio is untouched: only tracks we hand out are guarded.
 * Self-contained: serialized by addInitScript.
 */
export function mediaGuard(): void {
  const md = navigator.mediaDevices;
  const w = window as unknown as Record<string, unknown>;
  if (!md || w.__ccMediaGuard) return;
  w.__ccMediaGuard = true;
  const guarded = new WeakSet<MediaStreamTrack>();
  const guard = (t: MediaStreamTrack): MediaStreamTrack => {
    t.enabled = false;
    Object.defineProperty(t, "enabled", { get: () => false, set: () => {}, configurable: false });
    guarded.add(t);
    return t;
  };
  const clone = MediaStreamTrack.prototype.clone;
  MediaStreamTrack.prototype.clone = function (this: MediaStreamTrack) {
    const c = clone.call(this);
    return guarded.has(this) ? guard(c) : c;
  };
  const refuse = (what: string) => Promise.reject(new DOMException(what + " disabled by recorder", "NotAllowedError"));
  const gum = md.getUserMedia.bind(md);
  md.getUserMedia = async (c?: MediaStreamConstraints) => {
    if (!c?.audio) return refuse("camera");
    const s = await gum({ audio: c.audio });   // never pass video through
    s.getAudioTracks().forEach(guard);
    return s;
  };
  md.getDisplayMedia = () => refuse("screen share");
}
