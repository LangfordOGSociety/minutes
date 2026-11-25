/**
 * Nightly backups of the server's state: minutes.db (VACUUM INTO, a
 * consistent copy taken while the server runs) and the saved login
 * (auth/zoom-auth.json). Recordings are out of scope: large, and the city
 * publishes its own copy.
 *
 * Each backup is a folder <dir>/minutes-YYYY-MM-DD_HHMM (local time):
 *   minutes.db          the database
 *   zoom-auth.json      saved login, mode 600 (live session tokens)
 *   backup.json         when, schema version, row counts, sha256 per file
 * It's written to a hidden temp folder, checked (sqlite integrity_check,
 * schema, hashes), then renamed into place, so a listed backup is always a
 * complete and checked one.
 *
 * The directory holds live session tokens: never serve it, never put it
 * anywhere public.
 */
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync,
  statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { DB } from "./db.js";
import { logger } from "./util.js";

const log = logger("backup");

export const NAME_RE = /^minutes-(\d{4})-(\d{2})-(\d{2})_(\d{2})(\d{2})$/;
const DB_FILE = "minutes.db";
const AUTH_FILE = "zoom-auth.json";
const MANIFEST = "backup.json";

export interface BackupManifest {
  createdAt: string;
  schema: number;
  counts: Record<string, number>;
  files: { name: string; bytes: number; sha256: string }[];
}

export interface BackupInfo { name: string; path: string; manifest: BackupManifest }

const pad = (n: number) => String(n).padStart(2, "0");
/** Local date and time (process TZ), for names people read. */
const stamp = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}`;
const dayOf = (name: string) => NAME_RE.exec(name)?.slice(1, 4).join("-") ?? null;

function sha256(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

/** Open a database file read-only and check it: integrity, schema, rows. */
function inspectDb(file: string): { schema: number; counts: Record<string, number> } {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const ic = db.prepare("PRAGMA integrity_check").all() as { integrity_check: string }[];
    if (ic.length !== 1 || ic[0].integrity_check !== "ok") {
      throw new Error(`integrity check failed: ${ic.map((r) => r.integrity_check).join("; ").slice(0, 500)}`);
    }
    const schema = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all() as { name: string }[]).map((r) => r.name);
    const counts: Record<string, number> = {};
    for (const t of tables) counts[t] = (db.prepare(`SELECT count(*) AS n FROM "${t.replace(/"/g, '""')}"`).get() as { n: number }).n;
    return { schema, counts };
  } finally {
    db.close();
  }
}

/** Take a backup now. `auth` may be null or missing (no saved login yet). */
export function backupNow(db: DB, dir: string, auth: string | null, now = new Date()): BackupInfo {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  let name = `minutes-${stamp(now)}`;
  for (let i = 2; existsSync(path.join(dir, name)); i++) name = `minutes-${stamp(now)}-${i}`;
  const tmp = path.join(dir, `.tmp-${name}`);
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { mode: 0o700 });
  try {
    const dbCopy = path.join(tmp, DB_FILE);
    db.exec(`VACUUM INTO '${dbCopy.replace(/'/g, "''")}'`);
    chmodSync(dbCopy, 0o600);
    if (auth && existsSync(auth)) {
      copyFileSync(auth, path.join(tmp, AUTH_FILE));
      chmodSync(path.join(tmp, AUTH_FILE), 0o600);
    }
    const { schema, counts } = inspectDb(dbCopy);
    const files = readdirSync(tmp).sort().map((f) => ({ name: f, bytes: statSync(path.join(tmp, f)).size, sha256: sha256(path.join(tmp, f)) }));
    const manifest: BackupManifest = { createdAt: now.toISOString(), schema, counts, files };
    writeFileSync(path.join(tmp, MANIFEST), JSON.stringify(manifest, null, 1) + "\n", { mode: 0o600 });
    const final = path.join(dir, name);
    renameSync(tmp, final);
    const rows = Object.entries(counts).map(([t, n]) => `${t} ${n}`).join(", ");
    log.info(`backup ${name}: schema ${schema}, ${rows}${files.some((f) => f.name === AUTH_FILE) ? ", saved login" : ", no saved login"}`);
    return { name, path: final, manifest };
  } catch (e) {
    rmSync(tmp, { recursive: true, force: true });
    throw e;
  }
}

/** Re-check a backup folder against its manifest. Throws on any mismatch. */
export function verifyBackup(folder: string): BackupManifest {
  const mf = path.join(folder, MANIFEST);
  if (!existsSync(mf)) throw new Error(`${folder} has no ${MANIFEST}: not a finished backup`);
  const manifest = JSON.parse(readFileSync(mf, "utf8")) as BackupManifest;
  if (!manifest.files.some((f) => f.name === DB_FILE)) throw new Error(`backup has no ${DB_FILE}`);
  for (const f of manifest.files) {
    const p = path.join(folder, f.name);
    if (!existsSync(p)) throw new Error(`${f.name} is missing`);
    if (sha256(p) !== f.sha256) throw new Error(`${f.name} doesn't match its checksum`);
  }
  const { schema } = inspectDb(path.join(folder, DB_FILE));
  if (schema !== manifest.schema) throw new Error(`schema ${schema}, manifest says ${manifest.schema}`);
  return manifest;
}

/** Finished backups, newest first. */
export function listBackups(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((n) => n.startsWith("minutes-") && existsSync(path.join(dir, n, MANIFEST))).sort().reverse();
}

/** Delete backups from more than keepDays days ago (by the date in the
 *  name), and leftover temp folders. Never deletes the newest backup. */
export function pruneBackups(dir: string, keepDays: number, now = new Date()): string[] {
  const cutoff = new Date(now.getFullYear(), now.getMonth(), now.getDate() - keepDays);
  const keepFrom = stamp(cutoff).slice(0, 10);
  const all = listBackups(dir);
  const removed: string[] = [];
  for (const n of all.slice(1)) {
    const day = dayOf(n.replace(/-\d+$/, ""));
    if (day && day < keepFrom) {
      rmSync(path.join(dir, n), { recursive: true, force: true });
      removed.push(n);
    }
  }
  for (const n of readdirSync(dir)) {
    if (n.startsWith(".tmp-minutes-")) rmSync(path.join(dir, n), { recursive: true, force: true });
  }
  if (removed.length) log.info(`removed ${removed.length} old backup(s): ${removed.join(", ")}`);
  return removed;
}

/**
 * Put a backup back. The server must be stopped (it holds minutes.db open
 * and would overwrite the restored login). The current files are kept next
 * to the originals as *.before-restore-<stamp>, never deleted.
 */
export function restoreBackup(folder: string, out: string, auth: string | null, now = new Date()): string[] {
  const manifest = verifyBackup(folder);
  const suffix = `.before-restore-${stamp(now)}`;
  const done: string[] = [];
  const dbFile = path.join(out, DB_FILE);
  const hasAuth = !!auth && manifest.files.some((f) => f.name === AUTH_FILE);
  // Copy everything next to its target first, so a failed copy (disk full)
  // leaves the current files in place; then only renames.
  mkdirSync(out, { recursive: true });
  copyFileSync(path.join(folder, DB_FILE), `${dbFile}.restoring`);
  if (hasAuth) {
    mkdirSync(path.dirname(auth), { recursive: true, mode: 0o700 });
    copyFileSync(path.join(folder, AUTH_FILE), `${auth}.restoring`);
    chmodSync(`${auth}.restoring`, 0o600);
  }
  for (const ext of ["", "-wal", "-shm"]) {
    if (existsSync(dbFile + ext)) renameSync(dbFile + ext, dbFile + ext + suffix);
  }
  renameSync(`${dbFile}.restoring`, dbFile);
  done.push(`${dbFile} (schema ${manifest.schema})`);
  if (hasAuth) {
    if (existsSync(auth)) renameSync(auth, auth + suffix);
    renameSync(`${auth}.restoring`, auth);
    done.push(auth);
  }
  return done;
}

export interface NightlyOpts {
  dir: string;
  auth: string | null;
  keepDays: number;
  atHour: number;                 // local hour; the first check after it backs up
  notifyUrl: string | null;
}

/** Once a day, at or after atHour local time, unless today's backup exists.
 *  A failure notifies once and is retried hourly. */
export class NightlyBackup {
  private timer?: NodeJS.Timeout;
  private lastTry = 0;
  private failing = false;

  constructor(private o: NightlyOpts, private db: DB, private notify: (text: string) => Promise<void>) {}

  start(): void {
    this.timer = setInterval(() => this.tick(), 10 * 60_000);
    this.timer.unref();
    this.tick();
  }

  stop(): void { if (this.timer) clearInterval(this.timer); }

  /** Exposed for tests. Never throws: it runs from a timer, and an
   *  exception there would take the server (and any capture) down. */
  tick(now = new Date()): BackupInfo | null {
    if (now.getHours() < this.o.atHour) return null;
    if (this.failing && now.getTime() - this.lastTry < 60 * 60_000) return null;
    try {
      const today = stamp(now).slice(0, 10);
      if (listBackups(this.o.dir).some((n) => dayOf(n.replace(/-\d+$/, "")) === today)) return null;
      this.lastTry = now.getTime();
      const b = backupNow(this.db, this.o.dir, this.o.auth, now);
      pruneBackups(this.o.dir, this.o.keepDays, now);
      if (this.failing) void this.notify("minutes backup OK again.");
      this.failing = false;
      return b;
    } catch (e) {
      this.lastTry = now.getTime();
      log.error("backup failed", e);
      if (!this.failing) void this.notify(`minutes backup failed: ${(e as Error).message}`.slice(0, 500));
      this.failing = true;
      return null;
    }
  }
}
