#!/usr/bin/env bash
# Waits until no capture is running or about to start, so a deploy never
# lands during a meeting (Recreate: a restart stops the capture, and it does
# not resume). Used by .github/workflows/release.yml before the rollout.
#
#   scripts/deploy-guard.sh [api-base]
#
# Busy = any job running / stopping / queued, or scheduled to start within
# WINDOW_MIN minutes (default 45: covers the join lead time and a margin).
# Polls every POLL_S seconds for up to MAX_WAIT_MIN minutes, then fails.
# If the API can't be reached, it says so and allows the deploy: the server
# may be down, and the deploy may be the fix.
#
# Needs curl and jq (both on the ARC runner image).
set -euo pipefail
API="${1:-http://minutes.minutes.svc.cluster.local:8080}"
WINDOW_MIN="${WINDOW_MIN:-45}"
POLL_S="${POLL_S:-60}"
MAX_WAIT_MIN="${MAX_WAIT_MIN:-240}"
deadline=$(( $(date +%s) + MAX_WAIT_MIN * 60 ))

busy() {
  local json
  if ! json=$(curl -fsS --max-time 15 "$API/api/jobs"); then
    echo "jobs API unreachable at $API; deploying anyway (the server may be down)."
    return 1
  fi
  local found
  found=$(jq -r --argjson win "$((WINDOW_MIN * 60))" '
    .[] | select(
      (.status == "running" or .status == "stopping" or .status == "queued")
      or (.status == "scheduled"
          and ((.start | sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601) - now) < $win)
    ) | "\(.status) \(.slug) start \(.start)"' <<<"$json")
  [ -z "$found" ] && return 1
  echo "$found"
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
