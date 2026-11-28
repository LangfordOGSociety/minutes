# Scaling to thousands of meetings

Measured with `test/scale.test.ts` (3000 meetings, each with a recording folder, on a laptop):

| | before | after |
|---|---|---|
| a public listing | ~400 ms | 1-5 ms (a kept snapshot), ~50 ms when it has to be rebuilt |
| a video range request (`/media`) | ~380 ms | 1-3 ms |
| first build after a start | ~1.2 s | ~0.7 s, once |

## What was slow

Every public request, and every range request of a video, called `listRecordings()` and
`publicSite()`. They read each recording folder (manifest, status, about ten `existsSync`
calls), scanned every job once per recording, ran one query per meeting for its feed and
documents, and did all of it synchronously, so one visitor stalled everyone else.

## What changed

1. **Snapshots** (`serve.ts snapshot()`): the recordings list and the public model are built
   once and kept until a meeting or a capture changes (`Meetings.version`, `Scheduler.version`),
   until any write request has been served (`epoch`), or after `snapshotMs` (default 5 s, for
   changes the app can't see: the capture, the transcriber, and the clock moving a meeting's
   stage). Tests run with `snapshotMs: 0`. Everything in a snapshot is read-only.
2. **Scheduler indexes** (`jobsOf`, `jobBySlug`, `activeSlugs`): jobs by meeting and by folder
   name, rebuilt only after a job is added, changed or removed. No more `jobs.filter` per
   recording or per meeting.
3. **Bounded queries**: the admin's meeting lists are indexed SQL (`Meetings.from`, `recent`,
   `pendingReview`; migration 18), and the admin page asks for the latest captures and
   recordings with "Show more" (`?limit=`, total in `X-Total-Count`). The public listing is
   filtered and paged from the snapshot, not in SQL, because a meeting's stage (upcoming,
   live, ready, failed...) is derived from its jobs, its folder and the clock, and is not
   stored. That costs a scan of the in-memory list per request: microseconds for thousands.
4. **Folder reads are remembered** (`recordings.ts`): what a recording folder says is kept in
   memory with a signature (mtimes of the folder, `manifest.json` and `transcript.status.json`),
   so a pass over every folder is three `stat` calls each and only a changed folder is read
   again. It is not a database table on purpose: the capture and the transcriber (other
   processes) write those files, so a copy in the database would need the same checks, and the
   files stay the source of truth.
5. **Background passes yield**: the transcript search index runs in slices of about 40 ms
   (`Search.sync(items, now, budgetMs)`, `more`), the transcription history and operator
   messages skip recordings that have not changed since the last pass, and the operator-message
   check remembers what it has already sent.

## Still true

- One pod, one owner of `minutes.db` and the scheduler. Jobs are all in memory (kilobytes each).
- The first scan after a start reads every folder once, on the main thread.
- If the public site ever needs more than this: put a cache or CDN in front of the read-only
  pages, or persist each meeting's stage so the listing can be paged in SQL.
