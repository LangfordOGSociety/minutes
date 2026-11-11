#!/usr/bin/env bash
# One-time setup of zoom-capture on the homelab cluster, run from the repo root:
#   deploy/k8s/setup.sh [tag]
# Creates the namespace and secrets (values never printed), applies the
# manifests with the given image tag, and copies the saved Zoom login in.
set -euo pipefail
cd "$(dirname "$0")/../.."
K="kubectl --context ${KUBE_CONTEXT:-homelab}"
NS=zoom-capture
TAG="${1:-$(git rev-parse --short HEAD)}"

$K get namespace $NS >/dev/null 2>&1 || $K create namespace $NS

# Pull secret for registry.lab.emc2.build, copied from trailwave-dev.
$K get secret dev-registry-pull -n trailwave-dev -o json | python3 -c '
import json, sys
s = json.load(sys.stdin)
s["metadata"] = {"name": s["metadata"]["name"], "namespace": "zoom-capture"}
print(json.dumps(s))' | $K apply -f -

# App secret from .env: HF_TOKEN, and CAPTURE_WEB_TOKEN / CAPTURE_NOTIFY_URL if set.
set -a; . ./.env; set +a
args=(--from-literal=HF_TOKEN="${HF_TOKEN:-}")
[ -n "${CAPTURE_WEB_TOKEN:-}" ] && args+=(--from-literal=CAPTURE_WEB_TOKEN="$CAPTURE_WEB_TOKEN")
[ -n "${CAPTURE_NOTIFY_URL:-}" ] && args+=(--from-literal=CAPTURE_NOTIFY_URL="$CAPTURE_NOTIFY_URL")
[ -n "${CAPTURE_EMAIL:-}" ] && args+=(--from-literal=CAPTURE_EMAIL="$CAPTURE_EMAIL")
$K create secret generic zoom-capture -n $NS "${args[@]}" --dry-run=client -o yaml | $K apply -f -

# Saved Zoom login (live session tokens). The pod copies it onto its volume
# only when the volume has none; REPLACE_LOGIN=1 overwrites the pod's copy.
if [ -f auth/zoom-auth.json ]; then
  $K create secret generic zoom-auth -n $NS --from-file=zoom-auth.json=auth/zoom-auth.json \
    --dry-run=client -o yaml | $K apply -f -
fi

# Manifests, pinned to this tag.
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
cp deploy/k8s/*.yaml "$tmp"/
sed -i.bak "s/newTag: .*/newTag: \"$TAG\"/" "$tmp/kustomization.yaml"
$K apply -k "$tmp"
$K rollout status deploy/zoom-capture -n $NS --timeout=10m

if [ "${REPLACE_LOGIN:-0}" = 1 ] && [ -f auth/zoom-auth.json ]; then
  pod=$($K get pod -n $NS -l app=zoom-capture -o jsonpath='{.items[0].metadata.name}')
  $K exec -i -n $NS -c capture "$pod" -- sh -c 'umask 077; cat > /auth/zoom-auth.json' < auth/zoom-auth.json
  echo "replaced the pod's Zoom login; press Check now on the page"
fi
echo "open https://zoom.lab.emc2.build/ (LAN only)"
