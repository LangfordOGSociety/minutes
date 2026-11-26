/** Every feed parser, by id. Add a parser here (see docs/modularization-plan.md, Feeds). */
import type { FeedParser } from "./types.js";

const PARSERS: FeedParser<any>[] = [];

export function parsers(): readonly FeedParser<any>[] { return PARSERS; }

export function parserById(id: string): FeedParser<any> | undefined {
  return PARSERS.find((p) => p.id === id);
}

/** Built-ins register at import; tests can add their own. */
export function registerParser(p: FeedParser<any>): void {
  const i = PARSERS.findIndex((x) => x.id === p.id);
  if (i >= 0) PARSERS[i] = p; else PARSERS.push(p);
}
