# UI evaluation and redesign (2026-11-26)

## What was wrong

Evaluated by reading every page against three audiences.

- **No shared frame.** Each page had its own header. Public pages showed
  "minutes" plus a sign-in link; the account page had no header at all; admin
  and feeds were reached by a link tucked in the top bar. Nobody could tell
  where they were or where else they could go.
- **Public home** listed Upcoming, then a six-control filter block, then
  Recent updates, all in one column. The municipality was a hidden dropdown
  (only shown with 2+ sources) and a grey word inside the sub line of a card.
  Live meetings had no special place. "Recent meetings" was named "Past
  meetings" and sat below the fold behind filters.
- **Account page** was a 380 px sign-in card that also held tokens, alerts,
  password and email confirmation stacked vertically. An embedder had to find
  the share box on one meeting page to learn the embed code exists, and there
  was no embed for "what's coming up" at all.
- **Admin page** was one very long two-column page: schedule form, captures,
  users, tokens, audit log, recordings, in that order. Private data (users,
  audit, tokens) sat between operational controls. Nothing answered "what is
  the app doing right now?": running captures, transcription progress, the
  login state and the review queue were in different corners or other pages.

## Decisions

1. **One header on every page** (`common.ts` `renderMe`, now the site nav):
   brand, Meetings, Search, Embed & API, then Account / Admin / Sign in on the
   right, with the current page marked. Why: the three audiences share
   one app; cross links beat three disconnected sites. Done in one helper so
   pages cannot drift apart. Kept the `#me` element so each page's markup and
   script stay compatible.
2. **Public home leads with municipality.** Chips (All + each source) at the
   top filter upcoming, recent and updates together. Every card carries a
   municipality badge. Order: Live now (only when something is), Upcoming,
   Recent meetings (renamed from Past; filters tucked in the section), then
   updates as a side column on wide screens. Why: the first question is "which
   city's meeting is this"; the second is "what's next / what did I miss".
3. **Account becomes a dashboard for embedders** with tabs, API keys first
   (existing behaviour and element ids kept): *API keys*, *Embed*, *Alerts*,
   *Password*. The Embed tab has a builder for a single meeting (pick from
   recent, options for transcript / chapters / title / theme / start) and for
   the new **upcoming meetings embed** (municipality, body, count, theme),
   with the iframe code, the link, and a live preview. It lives under login
   because the audience is people with keys, but the embeds themselves stay
   public and unauthenticated, as before. The tab is a URL hash
   (`/account#embed`) so it can be linked.
4. **New `/embed/upcoming`** (`pages/embedlist.ts`): a compact list of upcoming
   meetings for other sites' iframes, `?source= &body= &limit= &theme=`. Same
   framing rule as `/embed/<slug>`: the only other page allowed in a frame,
   using `EMBED_ORIGINS`; reads only the public meetings API; links open the
   meeting page in a new tab. Registered before the per-meeting route.
5. **Admin is split into tabs** (hash routes, one `section` group each):
   - *Overview* (default): **Right now** (running and stopping captures with
     Watch, recordings being stitched, transcripts in progress with stage and
     percent, the Zoom login state), **Needs attention** (failed captures,
     failed transcripts, bad login, unhealthy feeds, meetings in review),
     **Coming up** (next scheduled captures), **Recent activity** (last audit
     entries). All from existing endpoints; no new server data.
   - *Captures*: schedule form and the capture list.
   - *Recordings*: the replay / live viewer and recording list.
   - *People & access*: users and API tokens with usage.
   - *Audit log*.
   Feeds keeps its own page and is a link in the tab bar. Why: the private
   data (users, tokens, audit) now has one obvious place, and the thing an
   operator opens the page for, the state of the system, is first.
   Polling is unchanged (5 s) but each tab only renders when visible.

## Not changed

Visual language (colours, type, dark mode), the CSP and String.raw rules, API
shapes, permissions: every route still checks a capability, and nothing new
exposes private data. The embed list uses only public fields.

## Verification

`npm test` (pages tests in Chromium cover sign-in, token flow, public home,
embed framing, admin users) plus new cases for the upcoming embed, the
embed builder and the admin Overview.
