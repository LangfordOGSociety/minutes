#!/usr/bin/env bash
# Restore minutes.db and the saved Zoom login from a nightly backup (#31).
# Run from the repo root:
#
#   deploy/k8s/restore.sh                 list backups, newest first
#   deploy/k8s/restore.sh <backup name>   restore that one
#
# Checks the backup inside the running pod first (checksums, sqlite
# integrity), refuses while a capture is running or scheduled within 45 min
# (FORCE=1 skips that), then scales the server to 0, runs `minutes restore`
# in a one-off pod on the same volumes, and scales back to 1. The files it
# replaces stay on the volume as *.before-restore-<time>. Recordings are
# not touched.
set -euo pipefail
cd "$(dirname "$0")/../.."
K="kubectl --context ${KUBE_CONTEXT:-homelab} -n minutes"
NAME="${1:-}"
cli() { $K exec deploy/minutes -c capture -- node /app/dist/index.js "$@"; }

if [ -z "$NAME" ]; then
  cli backup --dir /backups --list | sed 's|^/backups/||'
  exit 0
fi
case "$NAME" in minutes-*) ;; *) echo "not a backup name: $NAME" >&2; exit 2 ;; esac

echo "checking $NAME"
cli backup --verify "/backups/$NAME"

if [ "${FORCE:-0}" != 1 ]; then
  $K port-forward svc/minutes 18080:8080 >/dev/null 2>&1 & pf=$!
  trap 'kill $pf 2>/dev/null || true' EXIT
  sleep 2
  MAX_WAIT_MIN=0 scripts/deploy-guard.sh http://127.0.0.1:18080 || {
    echo "a capture is running or due soon; wait, or FORCE=1 to stop it" >&2; exit 1; }
  kill $pf 2>/dev/null || true
fi

image=$($K get deploy minutes -o jsonpath='{.spec.template.spec.containers[?(@.name=="capture")].image}')
echo "stopping the server"
$K scale deploy/minutes --replicas=0
$K wait --for=delete pod -l app=minutes --timeout=300s

pod="minutes-restore-$(date +%s)"
echo "restoring in $pod ($image)"
$K run "$pod" --image="$image" --restart=Never --quiet --overrides="$(cat <<EOF
{"spec": {
  "imagePullSecrets": [{"name": "ghcr-pull"}],
  "securityContext": {"runAsUser": 1000, "runAsGroup": 1000},
  "containers": [{
    "name": "restore", "image": "$image",
    "command": ["node", "/app/dist/index.js", "restore", "/backups/$NAME",
                "--out", "/recordings", "--auth", "/auth/zoom-auth.json"],
    "volumeMounts": [
      {"name": "recordings", "mountPath": "/recordings"},
      {"name": "data", "mountPath": "/auth", "subPath": "auth"},
      {"name": "backups", "mountPath": "/backups", "readOnly": true}]
  }],
  "volumes": [
    {"name": "data", "persistentVolumeClaim": {"claimName": "data"}},
    {"name": "recordings", "persistentVolumeClaim": {"claimName": "recordings"}},
    {"name": "backups", "persistentVolumeClaim": {"claimName": "backups"}}]
}}
EOF
)"
ok=0
$K wait --for=jsonpath='{.status.phase}'=Succeeded "pod/$pod" --timeout=300s && ok=1
$K logs "$pod" || true
$K delete pod "$pod" --wait=false >/dev/null

echo "starting the server"
$K scale deploy/minutes --replicas=1
$K rollout status deploy/minutes --timeout=10m
[ "$ok" = 1 ] || { echo "restore FAILED; the server is back on the files it had" >&2; exit 1; }
echo "restored $NAME. Check the page, then press Check now for the Zoom login."
