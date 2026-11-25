import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkLink, platformById, platformFor } from "../src/platforms/registry.js";
import { MARKERS, plainPasscode, webClientUrl, zoom } from "../src/platforms/zoom.js";

describe("platform registry", () => {
  it("claims Zoom links and bare meeting IDs", () => {
    for (const l of ["https://zoom.us/j/87093163922", "https://us02web.zoom.us/w/87093163922?pwd=x",
                     "870 9316 3922", "870-9316-3922", "87093163922"]) {
      assert.equal(platformFor(l)?.id, "zoom", l);
    }
    assert.equal(platformById("zoom"), zoom);
  });

  it("refuses links no platform handles", () => {
    for (const l of ["https://evil.example/j/87093163922", "https://zoom.us.evil.example/j/87093163922",
                     "https://notzoom.us/j/87093163922", "javascript:alert(1)", "12345", ""]) {
      assert.throws(() => checkLink(l), /meeting link/, l);
    }
  });

  it("normalizes to https with a meeting ID", () => {
    assert.equal(checkLink(" 870 9316 3922 ").link, "87093163922");
    assert.equal(checkLink("https://zoom.us/j/87093163922?pwd=429539").link, "https://zoom.us/j/87093163922?pwd=429539");
    assert.throws(() => checkLink("http://zoom.us/j/87093163922"), /https/);
    assert.throws(() => checkLink("https://zoom.us/profile"), /meeting ID/);
  });

  it("publicId shows the meeting number, never the passcode", () => {
    assert.equal(zoom.publicId("https://zoom.us/j/87093163922?pwd=secret429539"), "87093163922");
    assert.equal(zoom.publicId("870 9316 3922"), "87093163922");
  });
});

describe("zoom links", () => {
  it("webClientUrl maps /j/, /w/ and bare IDs to the browser client", () => {
    assert.equal(webClientUrl("87093163922"), "https://app.zoom.us/wc/join/87093163922");
    assert.equal(webClientUrl("https://zoom.us/j/87093163922?pwd=429539"), "https://app.zoom.us/wc/join/87093163922?pwd=429539");
    assert.equal(webClientUrl("https://us02web.zoom.us/w/87093163922"), "https://app.zoom.us/wc/join/87093163922");
  });

  it("plainPasscode only returns short typed passcodes", () => {
    assert.equal(plainPasscode("https://zoom.us/j/1?pwd=429539"), "429539");
    assert.equal(plainPasscode("https://zoom.us/j/1?pwd=" + "a".repeat(32)), null);
    assert.equal(plainPasscode("https://zoom.us/j/1"), null);
    assert.equal(plainPasscode("not a url"), null);
  });
});

describe("MARKERS", () => {
  const re = (s: string) => new RegExp(s, "i");
  it("ended matches meetings and webinars", () => {
    for (const t of ["This meeting has been ended by host", "This webinar has been ended by host",
                     "The meeting is over", "The host has removed you from this meeting",
                     "This webinar is no longer available"]) {
      assert.match(t, re(MARKERS.ended), t);
    }
    assert.doesNotMatch("The meeting will begin soon", re(MARKERS.ended));
  });

  it("recording notice: OK is clickable, leave never is", () => {
    assert.match("OK", re(MARKERS.recordingNoticeOk));
    assert.match("Got it", re(MARKERS.recordingNoticeOk));
    assert.doesNotMatch("Leave meeting", re(MARKERS.recordingNoticeOk));
    assert.match("Leave meeting", re(MARKERS.recordingNoticeNever));
  });
});
