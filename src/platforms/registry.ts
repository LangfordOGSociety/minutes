/**
 * All platforms, and link -> platform. Links that no platform claims are
 * refused, so a link field can never point the signed-in browser at an
 * arbitrary site.
 */
import type { Platform } from "./types.js";
import { zoom } from "./zoom.js";

export const PLATFORMS: readonly Platform[] = [zoom];

export function platformFor(link: string): Platform | undefined {
  return PLATFORMS.find((p) => p.match(link));
}

export function platformById(id: string): Platform | undefined {
  return PLATFORMS.find((p) => p.id === id);
}

/** The first supported join link in free text (feeds), canonical. */
export function findLink(text: string): string | undefined {
  for (const p of PLATFORMS) {
    const l = p.extractLink?.(text);
    if (l) { try { return p.normalize(l); } catch { /* not valid after all */ } }
  }
  return undefined;
}

/** Validate a link: its platform and canonical form. Throws an Error with a
 *  message fit for the user. */
export function checkLink(link: string): { platform: Platform; link: string } {
  const s = link.trim();
  const platform = platformFor(s);
  if (!platform) {
    throw new Error(`link must be a meeting link for ${PLATFORMS.map((p) => p.label).join(" or ")} (or a Zoom meeting ID)`);
  }
  return { platform, link: platform.normalize(s) };
}
