/**
 * The API's description (#19): an OpenAPI 3.1 document at
 * /api/v1/openapi.json and a short human page at /api/docs. Hand-written;
 * test/api.test.ts checks every path in it exists on the server and every
 * route the server has is in it, so they can't drift apart.
 */

const stage = ["upcoming", "live", "stitching", "video_ready", "ready", "failed", "not_recorded", "cancelled"];

const meeting = {
  type: "object",
  required: ["id", "title", "start", "stage", "cancelled", "documents", "hasVideo", "hasTranscript", "live"],
  properties: {
    id: { type: "string", description: "The meeting's permanent slug (its page is /m/{id})." },
    title: { type: "string" },
    body: { type: ["string", "null"], description: "The council or committee." },
    start: { type: "string", format: "date-time" },
    end: { type: ["string", "null"], format: "date-time" },
    stage: { type: "string", enum: stage },
    cancelled: { type: "boolean" },
    sourceColor: { type: ["string", "null"], description: "The badge color (#rrggbb) the site shows for this municipality, if one was chosen." },
    source: { type: ["string", "null"], description: "Which municipality or feed the meeting comes from (e.g. Langford Council, Saanich Council); null for one entered by hand." },
    join: { type: ["object", "null"], description: "How to join an upcoming or live meeting. Zoom: its number only, never the passcode. Microsoft Teams: the join link the municipality publishes.", properties: { platform: { type: "string" }, id: { type: ["string", "null"] }, url: { type: "string", format: "uri" } } },
    agendaUrl: { type: ["string", "null"], format: "uri" },
    pageUrl: { type: ["string", "null"], format: "uri", description: "The meeting on the city's own site." },
    streamUrl: { type: ["string", "null"], format: "uri", description: "The city's own live or recorded video page." },
    documents: { type: "array", items: { type: "object", properties: { title: { type: "string" }, type: { type: ["string", "null"] }, url: { type: "string", format: "uri" }, copy: { type: ["string", "null"], description: "Path of this site's stored copy, when there is one" } } } },
    hasVideo: { type: "boolean" },
    hasTranscript: { type: "boolean" },
    poster: { type: ["string", "null"], description: "A frame of the recording, a path on this site." },
    duration: { type: ["integer", "null"], description: "Seconds." },
    live: { type: "boolean" },
  },
};

const change = {
  type: "object",
  properties: {
    at: { type: "string", format: "date-time" },
    kind: { type: "string", enum: ["added", "date_changed", "time_changed", "cancelled", "reinstated", "document_added", "document_changed", "document_removed", "transcript_started", "transcript_done", "transcript_failed"] },
    meeting: { type: "object", properties: { id: { type: "string" }, title: { type: "string" } } },
    from: { type: ["string", "null"], format: "date-time" },
    to: { type: ["string", "null"], format: "date-time" },
    doc: { type: ["object", "null"], properties: { title: { type: "string" }, type: { type: ["string", "null"] }, url: { type: ["string", "null"] } } },
  },
};

const idParam = { name: "id", in: "path", required: true, schema: { type: "string" }, description: "A meeting's id (its slug)." };
const err = { description: "Error", content: { "application/json": { schema: { type: "object", properties: { error: { type: "string" } } } } } };
const ok = (schema: object, description = "OK") => ({ description, content: { "application/json": { schema } } });

/** The OpenAPI document. `server` is this site's address ("" = relative). */
export function openApi(server: string): object {
  return {
    openapi: "3.1.0",
    info: {
      title: "minutes API",
      version: "1",
      description: "Public meetings, their recordings and transcripts. Reading the meeting list, details, status and file list needs no token. " +
        "Downloading files needs an API token (create one on your account page). Anything playable in a browser can be saved by anyone: " +
        "tokens are for tracking and fair use of bulk access, not for protecting files.",
    },
    servers: [{ url: server || "/" }],
    security: [{}, { bearer: [] }],
    components: { securitySchemes: { bearer: { type: "http", scheme: "bearer", description: "mnt_<prefix>_<secret>, from /account. Scope `download` is needed for file downloads." } } },
    paths: {
      "/api/v1/meetings": {
        get: {
          summary: "List meetings", operationId: "listMeetings",
          parameters: [
            { name: "scope", in: "query", schema: { type: "string", enum: ["upcoming", "past"], default: "upcoming" } },
            { name: "body", in: "query", schema: { type: "string" }, description: "Only this body (council, committee), as named in `bodies`." },
            { name: "source", in: "query", schema: { type: "string" }, description: "Only this municipality or feed, as named in `sources`." },
            { name: "from", in: "query", schema: { type: "string", format: "date" }, description: "On or after this local day." },
            { name: "to", in: "query", schema: { type: "string", format: "date" }, description: "On or before this local day." },
            { name: "q", in: "query", schema: { type: "string" }, description: "Words in the title or body." },
            { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 200, default: 50 } },
            { name: "offset", in: "query", schema: { type: "integer", minimum: 0, default: 0 } },
          ],
          responses: { 200: ok({ type: "object", properties: { meetings: { type: "array", items: meeting }, total: { type: "integer" }, bodies: { type: "array", items: { type: "string" } }, sources: { type: "array", items: { type: "string" } } } }) },
        },
      },
      "/api/v1/meetings/{id}": {
        get: {
          summary: "A meeting, its recording and its history", operationId: "getMeeting", parameters: [idParam],
          responses: { 200: ok({ allOf: [meeting, { type: "object", properties: { recording: { type: ["object", "null"] }, startedAt: { type: ["string", "null"] }, history: { type: "array", items: change } } }] }), 404: err },
        },
      },
      "/api/v1/meetings/{id}/status": {
        get: {
          summary: "Where a meeting is: stage and transcription progress", operationId: "getMeetingStatus", parameters: [idParam],
          responses: { 200: ok({ type: "object", properties: { stage: { type: "string", enum: stage }, hasVideo: { type: "boolean" }, hasTranscript: { type: "boolean" }, live: { type: "boolean" },
            transcript: { type: ["object", "null"], properties: { status: { type: "string" }, stage: { type: ["string", "null"] }, progress: { type: ["integer", "null"] } } } } }), 404: err },
        },
      },
      "/api/v1/meetings/{id}/files": {
        get: {
          summary: "The files of a meeting's recording", operationId: "listFiles", parameters: [idParam],
          responses: { 200: ok({ type: "array", items: { type: "object", properties: { name: { type: "string" },
            kind: { type: "string", enum: ["video", "subtitles", "subtitles-srt", "transcript-text", "transcript-json", "zoom-captions", "thumbnail", "video-smaller"] }, height: { type: "integer", description: "For video-smaller: the picture height (720, 480, 360...)." }, bytes: { type: "integer" }, url: { type: "string" } } } }), 404: err },
        },
      },
      "/api/v1/meetings/{id}/files/{name}": {
        get: {
          summary: "Download a file (token with the download scope)", operationId: "downloadFile", security: [{ bearer: [] }],
          description: "Supports HTTP Range requests. Counted against your token's usage.",
          parameters: [idParam, { name: "name", in: "path", required: true, schema: { type: "string" } }],
          responses: { 200: { description: "The file" }, 206: { description: "Part of the file (Range)" }, 401: err, 403: err, 404: err, 429: err },
        },
      },
      "/api/v1/search": {
        get: {
          summary: "Search what was said: passages of public transcripts", operationId: "search",
          description: "Words must all appear (the last may be a prefix); put a phrase in quotes. Results are ~30 second passages, best match first, with the matched words flagged. `url` opens the meeting at that second.",
          parameters: [
            { name: "q", in: "query", required: true, schema: { type: "string", maxLength: 200 } },
            { name: "body", in: "query", schema: { type: "string" } },
            { name: "source", in: "query", schema: { type: "string" }, description: "Only this municipality, as named in `sources`." },
            { name: "from", in: "query", schema: { type: "string", format: "date" } },
            { name: "to", in: "query", schema: { type: "string", format: "date" } },
            { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 50, default: 20 } },
            { name: "offset", in: "query", schema: { type: "integer", minimum: 0, default: 0 } },
          ],
          responses: { 200: ok({ type: "object", properties: { query: { type: "string" }, terms: { type: "array", items: { type: "string" } }, total: { type: "integer" },
            hits: { type: "array", items: { type: "object", properties: { meeting: { type: "object", properties: { id: { type: "string" }, title: { type: "string" }, body: { type: ["string", "null"] }, start: { type: "string", format: "date-time" } } },
              t: { type: "integer", description: "Seconds into the video." }, speaker: { type: ["string", "null"] }, url: { type: "string" },
              parts: { type: "array", description: "The snippet in order; `hit` parts are the matched words.", items: { type: "object", properties: { text: { type: "string" }, hit: { type: "boolean" } } } } } } } } }) },
        },
      },
      "/api/v1/changes": {
        get: {
          summary: "Recent changes: announcements, moves, cancellations, new documents", operationId: "listChanges",
          parameters: [{ name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 100, default: 30 } }],
          responses: { 200: ok({ type: "array", items: change }) },
        },
      },
      "/api/v1/me": {
        get: { summary: "Check your token", operationId: "me", security: [{ bearer: [] }],
          responses: { 200: ok({ type: "object", properties: { prefix: { type: "string" }, label: { type: "string" }, scopes: { type: "array", items: { type: "string" } },
            expiresAt: { type: ["string", "null"] }, canDownload: { type: "boolean" } } }), 401: err } },
      },
      "/api/v1/openapi.json": { get: { summary: "This document", operationId: "openapi", responses: { 200: { description: "OpenAPI 3.1" } } } },
    },
  };
}

export const API_DOCS_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>minutes API</title>
<meta name="description" content="Read public meetings, recordings and transcripts programmatically.">
<link rel="icon" href="data:,">
<style>
:root { --bg: #f6f5f2; --ink: #1d1c1a; --muted: #6b6862; --line: #e4e1da; --accent: #2f5bd3; --code: #ffffff; color-scheme: light; }
@media (prefers-color-scheme: dark) { :root { --bg: #141413; --ink: #ecebe7; --muted: #9a978f; --line: #2e2d2a; --accent: #7c9cff; --code: #1d1d1b; color-scheme: dark; } }
body { margin: 0; background: var(--bg); color: var(--ink); font: 15px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 760px; margin: 0 auto; padding: 24px 16px 56px; }
h1 { font-size: 24px; margin: 0 0 4px; } h2 { font-size: 17px; margin: 28px 0 6px; }
p, li { overflow-wrap: anywhere; } a { color: var(--accent); }
.lead { color: var(--muted); margin-top: 0; }
pre { background: var(--code); border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px; overflow-x: auto; font-size: 13px; line-height: 1.45; }
code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .92em; }
table { border-collapse: collapse; width: 100%; font-size: 14px; } td, th { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--line); vertical-align: top; }
td:first-child { white-space: nowrap; }
@media (max-width: 640px) {
  table, tbody, tr, td { display: block; }
  tr:first-child { display: none; }
  tr { border-bottom: 1px solid var(--line); padding: 6px 0; }
  td { border: 0; padding: 2px 0; white-space: normal !important; }
  td:first-child { font-weight: 600; }
}
.note { border-left: 4px solid var(--accent); padding: 4px 12px; background: var(--code); border-radius: 0 8px 8px 0; }
</style>
</head>
<body>
<main>
<p><a href="/">&larr; minutes</a></p>
<h1>minutes API</h1>
<p class="lead">Public meetings, their recordings and transcripts, as JSON. Version 1, read-only. Machine-readable: <a href="/api/v1/openapi.json">openapi.json</a>.</p>

<h2>Who needs a token</h2>
<p>Reading meetings, their status, history and file lists needs <b>no token</b>. <b>Downloading files</b> does. Create one on your <a href="/account">account page</a> (you need an account with a confirmed email; up to 5 active tokens). The token is shown once; keep it like a password. Revoke it there if it leaks.</p>
<div class="note"><p>Anything that plays in a browser can be saved by anyone. Tokens are for <b>tracking and fair use of bulk access</b>, not for protecting files. Please be kind to the server: download what you need once, and use <code>Range</code> to resume.</p></div>

<h2>Endpoints</h2>
<table>
<tr><th>GET</th><th></th></tr>
<tr><td><code>/api/v1/meetings</code></td><td>List: <code>scope=upcoming|past</code>, <code>body</code>, <code>source</code> (municipality), <code>from</code>, <code>to</code> (local days), <code>q</code>, <code>limit</code> (200 max), <code>offset</code>. Returns <code>{meetings, total, bodies, sources}</code>.</td></tr>
<tr><td><code>/api/v1/meetings/{id}</code></td><td>One meeting with its recording and its history (announced, moved, cancelled, documents).</td></tr>
<tr><td><code>/api/v1/meetings/{id}/status</code></td><td>Stage (<code>upcoming</code>, <code>live</code>, <code>stitching</code>, <code>video_ready</code>, <code>ready</code>, <code>failed</code>, <code>not_recorded</code>, <code>cancelled</code>) and transcription progress. Small enough to poll.</td></tr>
<tr><td><code>/api/v1/meetings/{id}/files</code></td><td>The recording's files: video, subtitles (VTT, SRT), transcript (text, JSON), Zoom captions.</td></tr>
<tr><td><code>/api/v1/meetings/{id}/files/{name}</code></td><td><b>Download</b> (token with the <code>download</code> scope). Supports <code>Range</code>.</td></tr>
<tr><td><code>/api/v1/search</code></td><td>Search every public transcript: <code>q</code> (words must all appear; "quoted phrase"), <code>body</code>, <code>source</code> (the municipality), <code>from</code>, <code>to</code>, <code>limit</code>, <code>offset</code>. Returns passages with the matched words flagged and a <code>url</code> that opens the meeting at that second.</td></tr>
<tr><td><code>/api/v1/changes</code></td><td>Recent changes across meetings.</td></tr>
<tr><td><code>/api/v1/me</code></td><td>Check your token: label, scopes, expiry.</td></tr>
</table>
<p>The <code>id</code> is a meeting's permanent slug, the same as its page <code>/m/{id}</code>. A meeting only has files once it's been recorded.</p>

<h2>Examples</h2>
<pre>curl "$SITE/api/v1/meetings?scope=past&amp;limit=5"

curl "$SITE/api/v1/meetings/langford-council-2026-12-08/files"

curl -H "Authorization: Bearer $TOKEN" -OJ \\
  "$SITE/api/v1/meetings/langford-council-2026-12-08/files/langford-council-2026-12-08.transcript.json"

# resume a partial download
curl -H "Authorization: Bearer $TOKEN" -C - -OJ "$SITE/api/v1/meetings/{id}/files/{name}"</pre>

<h2>From a web page</h2>
<p>Reads are open to any website (CORS <code>*</code>), including <code>Range</code> and the <code>Authorization</code> header, so a page on another site can list meetings, play a recording in a <code>&lt;video&gt;</code> from <code>/media/...</code>, or fetch files. To just show a recording, the <a href="/api/docs#embed">embed</a> is simpler.</p>

<h2 id="embed">Embedding a recording</h2>
<pre>&lt;iframe src="$SITE/embed/{id}?transcript=1" width="640" height="640" allow="fullscreen" allowfullscreen&gt;&lt;/iframe&gt;</pre>
<p>Options: <code>transcript=1</code>, <code>chapters=1</code>, <code>title=0</code>, <code>t=90</code>, <code>theme=light|dark</code>. <code>/oembed?url=&lt;meeting link&gt;</code> serves oEmbed JSON.</p>

<h2>Errors and limits</h2>
<ul>
<li><code>401</code> a token is needed, or the one you sent is invalid, expired or revoked.</li>
<li><code>403</code> the token lacks the <code>download</code> scope, or the account's email isn't confirmed.</li>
<li><code>404</code> no such meeting or file (hidden meetings are 404).</li>
<li><code>429</code> (later) a rate limit, with <code>Retry-After</code> in seconds. None are enforced yet, but write clients to honour it.</li>
</ul>
<p>Your usage (requests and data per day, your most downloaded files) is on your account page.</p>
</main>
</body>
</html>
`.replace(/\$SITE/g, "https://YOUR-SITE");
