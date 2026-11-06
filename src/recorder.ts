/**
 * ffmpeg capture of the Xvfb display + PulseAudio sink.
 *
 * Each continuous stretch of recording is a Part, written as MKV because
 * Matroska stays recoverable if ffmpeg is killed mid-write. MP4 doesn't.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream } from "node:fs";
import path from "node:path";
import { TIMEOUT, logger, withTimeout } from "./util.js";

const log = logger("recorder");

export type Encoder = "x264" | "vaapi" | "nvenc";

export interface Part {
  index: number;
  file: string;        // absolute path
  started: Date;
  ended: Date | null;
  exitCode: number | null;
}

export interface RecorderOpts {
  outdir: string;
  display: string;
  sink: string;
  width: number;
  height: number;
  fps: number;
  quality: number;     // CRF for x264, QP for vaapi, CQ for nvenc
  encoder: Encoder;
  vaapiDevice: string;
}

export class Recorder {
  private proc: ChildProcess | null = null;
  private exited: Promise<number | null> | null = null;
  private exitedAt: Date | null = null; // when ffmpeg actually went away
  current: Part | null = null;

  constructor(private o: RecorderOpts) {}

  get alive(): boolean {
    return this.proc !== null && this.proc.exitCode === null && this.proc.signalCode === null;
  }

  private args(file: string): string[] {
    const { o } = this;
    const q = String(o.quality);
    const pre: string[] = [];
    let video: string[];
    switch (o.encoder) {
      case "vaapi": // Intel/AMD iGPU. Needs --device /dev/dri.
        pre.push("-vaapi_device", o.vaapiDevice);
        video = ["-vf", "format=nv12,hwupload", "-c:v", "h264_vaapi", "-qp", q];
        break;
      case "nvenc": // Nvidia. Needs the nvidia container runtime.
        video = ["-c:v", "h264_nvenc", "-preset", "p4", "-rc", "vbr", "-cq", q, "-pix_fmt", "yuv420p"];
        break;
      default:
        video = ["-c:v", "libx264", "-preset", "veryfast", "-crf", q, "-pix_fmt", "yuv420p"];
    }
    return [
      "-hide_banner", "-nostats", "-loglevel", "warning", "-y",
      ...pre,
      "-thread_queue_size", "1024",
      "-f", "x11grab", "-draw_mouse", "0",
      "-framerate", String(o.fps),
      "-video_size", `${o.width}x${o.height}`,
      "-i", `${o.display}.0`,
      "-thread_queue_size", "1024",
      "-f", "pulse", "-i", `${o.sink}.monitor`,
      ...video,
      "-g", String(o.fps * 2),
      "-af", "aresample=async=1",
      "-c:a", "aac", "-b:a", "128k",
      // Matroska buffers a whole cluster (up to ~5s) in memory before
      // writing it. 1s clusters + flushing every packet means a hard crash
      // loses about a second instead of everything since the last cluster.
      "-flush_packets", "1",
      "-cluster_time_limit", "1000",
      "-f", "matroska", file,
    ];
  }

  start(index: number): Part {
    if (this.alive) throw new Error("recorder already running");
    this.finalize(); // covers ffmpeg having died on its own

    const file = path.join(this.o.outdir, `part_${String(index).padStart(3, "0")}.mkv`);
    const ffLog = createWriteStream(file.replace(/\.mkv$/, ".ffmpeg.log"), { flags: "a" });
    const proc = spawn("ffmpeg", this.args(file), { stdio: ["pipe", "ignore", "pipe"] });
    proc.stderr?.pipe(ffLog);
    this.exitedAt = null;
    this.exited = new Promise((resolve) => {
      proc.once("exit", (code) => {
        if (this.proc === proc) this.exitedAt = new Date();
        resolve(code);
      });
      proc.once("error", (err) => {
        log.error("ffmpeg failed to start", err);
        if (this.proc === proc) this.exitedAt = new Date();
        resolve(-1);
      });
    });
    this.proc = proc;
    this.current = { index, file, started: new Date(), ended: null, exitCode: null };
    log.info(`recording part ${index} -> ${path.basename(file)} (${this.o.encoder})`);
    return this.current;
  }

  /** Graceful stop: 'q' lets ffmpeg flush and close the file cleanly. */
  async stop(timeoutMs = 20_000): Promise<void> {
    const proc = this.proc;
    const exited = this.exited;
    if (proc && exited && this.alive) {
      try { proc.stdin?.end("q"); } catch { /* pipe already closed */ }
      if ((await withTimeout(exited, timeoutMs)) === TIMEOUT) {
        log.warn("ffmpeg didn't exit cleanly, terminating");
        proc.kill("SIGTERM");
        if ((await withTimeout(exited, 5_000)) === TIMEOUT) {
          proc.kill("SIGKILL");
          await exited;
        }
      }
    }
    this.finalize();
  }

  private finalize(): void {
    const p = this.current;
    if (p && p.ended === null) {
      p.ended = this.exitedAt ?? new Date();
      p.exitCode = this.proc?.exitCode ?? (this.exitedAt ? -1 : null);
      log.info(`part ${p.index} closed (exit ${p.exitCode})`);
    }
  }
}
