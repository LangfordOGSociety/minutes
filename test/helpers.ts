import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/** A fresh temp dir, removed when the test ends. */
/** Anything with an after() hook: a TestContext, or a suite's own list. */
export interface HasAfter { after(fn: () => unknown): unknown }

export function tmpDir(t: HasAfter, prefix = "minutes-test-"): string {
  const d = mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  return d;
}

/** Is this command on PATH? Tests that need it skip without it, except in
 *  CI (CI=true), where a missing tool is a failure, not a skip. */
export function need(cmd: string): string | false {
  try {
    execFileSync(cmd, ["-version"], { stdio: "ignore" });
    return false;
  } catch {
    if (process.env.CI) throw new Error(`${cmd} is required in CI`);
    return `${cmd} not installed`;
  }
}

export const inDays = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString();
