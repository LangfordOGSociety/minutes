#!/usr/bin/env bash
# Waits until no capture is running or about to start, so a deploy never
# lands during a meeting (Recreate: a restart stops the capture, and it does
# not resume). Used by .github/workflows/release.yml before the rollout.
#
#   scripts/deploy-guard.sh [api-base]
#
# Busy = any job running / stopping / queued, or scheduled to start within
# WINDOW_MIN minutes (default 45: covers the join lead time and a margin),
# from GET /api/status (servers before it: GET /api/jobs).
# Polls every POLL_S seconds for up to MAX_WAIT_MIN minutes, then fails.
# If the server can't be reached at all, it says so and allows the deploy:
# the server may be down, and the deploy may be the fix. Any HTTP answer it
# can't read counts as busy.
#
# Needs curl and jq (both on the ARC runner image).
set -euo pipefail
API="${1:-http://minutes.minutes.svc.cluster.local:8080}"
WINDOW_MIN="${WINDOW_MIN:-45}"
POLL_S="${POLL_S:-60}"
MAX_WAIT_MIN="${MAX_WAIT_MIN:-240}"
deadline=$(( $(date +%s) + MAX_WAIT_MIN * 60 ))

busy() {
  local out code body
  # Only a server that can't be reached at all lets the deploy through (it
  # may be down, and the deploy may be the fix). Any answer we can't read
  # counts as busy: a server that answers may be recording.
  if ! out=$(curl -sS --max-time 15 -w '\n%{http_code}' "$API/api/status?within=$WINDOW_MIN"); then
    echo "API unreachable at $API; deploying anyway (the server may be down)."
    return 1
  fi
  code=${out##*$'\n'}
  body=${out%$'\n'*}
  if [ "$code" = 404 ]; then
    # A server from before /api/status: its job list is still open.
    if ! body=$(curl -fsS --max-time 15 "$API/api/jobs"); then
      echo "old server, and its job list didn't answer; treating as busy"
      return 0
    fi
    local found
    found=$(jq -r --argjson win "$((WINDOW_MIN * 60))" '
      .[] | select(
        (.status == "running" or .status == "stopping" or .status == "queued")
        or (.status == "scheduled"
            and ((.start | sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601) - now) < $win)
      ) | "\(.status) \(.slug) start \(.start)"' <<<"$body") || { echo "unreadable job list; treating as busy"; return 0; }
    [ -z "$found" ] && return 1
    echo "$found"
    return 0
  fi
  if [ "$code" != 200 ]; then
    echo "status API answered $code; treating as busy"
    return 0
  fi
  local b
  b=$(jq -r 'if .busy == false then "no" elif .busy == true then "yes: \(.running) running/queued, next start \(.nextStart // "none")" else error("bad") end' <<<"$body") \
    || { echo "unreadable status; treating as busy"; return 0; }
  [ "$b" = no ] && return 1
  echo "$b"
  return 0
}

while busy; do
  if [ "$(date +%s)" -ge "$deadline" ]; then
    echo "still busy after ${MAX_WAIT_MIN} min; not deploying. Re-run the Release workflow later (or with force)."
    exit 1
  fi
  echo "capture running or starting within ${WINDOW_MIN} min; waiting ${POLL_S}s"
  sleep "$POLL_S"
done
echo "no capture running or due within ${WINDOW_MIN} min; OK to deploy."
