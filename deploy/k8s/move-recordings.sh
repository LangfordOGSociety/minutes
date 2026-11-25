#!/usr/bin/env bash
# One-time move to the split layout (2026-11): recordings from the `data`
# RBD volume to the `recordings` CephFS volume, and the transcriber out of
# the web pod into `minutes-transcriber` on k3s-07's GPU. Run from the repo
# root once the commit's images exist (CI built them):
#
#   deploy/k8s/move-recordings.sh sha-<commit>
#
# Refuses while a capture is running or due within 45 min (FORCE=1 skips
# that). The web site is down for the copy (seconds to minutes: it's the
# size of recordings/). The old copy stays on `data` under recordings/
# until you delete it; nothing is removed.
set -euo pipefail
cd "$(dirname "$0")/../.."
TAG="${1:?usage: move-recordings.sh <image tag, e.g. sha-abc123>}"
CTX="${KUBE_CONTEXT:-homelab}"
k() { kubectl --context "$CTX" -n minutes "$@"; }

if k get deployment minutes-transcriber >/dev/null 2>&1; then
  echo "minutes-transcriber already exists: already moved"; exit 0
fi

if [ "${FORCE:-0}" != 1 ]; then
  k port-forward svc/minutes 18080:8080 >/dev/null 2>&1 & pf=$!
  trap 'kill $pf 2>/dev/null || true' EXIT
  sleep 2
  MAX_WAIT_MIN=0 scripts/deploy-guard.sh http://127.0.0.1:18080 || {
    echo "a capture is running or due soon; wait, or FORCE=1" >&2; exit 1; }
  kill $pf 2>/dev/null || true
fi

echo "creating the new volumes"
kubectl --context "$CTX" kustomize deploy/k8s | python3 -c '
import sys, yaml
docs = [d for d in yaml.safe_load_all(sys.stdin) if d and d["kind"] == "PersistentVolumeClaim"
        and d["metadata"]["name"] in ("recordings", "transcriber-models")]
print(yaml.safe_dump_all(docs))' | kubectl --context "$CTX" apply -f -
k wait --for=jsonpath='{.status.phase}'=Bound pvc/recordings pvc/transcriber-models --timeout=180s

echo "stopping the web pod"
k scale deploy/minutes --replicas=0
k wait --for=delete pod -l app=minutes --timeout=300s

pod="minutes-move-$(date +%s)"
echo "copying recordings in $pod"
k run "$pod" --image=busybox:1.36.1 --restart=Never --quiet --overrides='{"spec": {
  "containers": [{"name": "move", "image": "busybox:1.36.1",
    "command": ["sh", "-c", "set -e; cp -a /old/. /new/; for d in /old /new; do echo \"$d $(find $d -type f | wc -l) files $(du -sk $d | cut -f1) KiB\"; done; [ \"$(cd /old && find . -type f | sort | xargs md5sum | md5sum)\" = \"$(cd /new && find . -type f | sort | xargs md5sum | md5sum)\" ] && echo SAME"],
    "volumeMounts": [{"name": "data", "mountPath": "/old", "subPath": "recordings"},
                     {"name": "recordings", "mountPath": "/new"}]}],
  "volumes": [{"name": "data", "persistentVolumeClaim": {"claimName": "data"}},
              {"name": "recordings", "persistentVolumeClaim": {"claimName": "recordings"}}]}}'
k wait --for=jsonpath='{.status.phase}'=Succeeded "pod/$pod" --timeout=1800s || true
out=$(k logs "$pod")
echo "$out"
k delete pod "$pod" --wait=false >/dev/null
if ! grep -q '^SAME$' <<<"$out"; then
  echo "copy didn't verify; starting the web pod again on the old layout" >&2
  k scale deploy/minutes --replicas=1
  exit 1
fi

echo "applying the new layout ($TAG)"
deploy/k8s/setup.sh "$TAG"
k rollout status deploy/minutes-transcriber --timeout=20m

for pvc in recordings transcriber-models; do
  pv=$(k get pvc "$pvc" -o jsonpath='{.spec.volumeName}')
  kubectl --context "$CTX" patch pv "$pv" -p '{"spec":{"persistentVolumeReclaimPolicy":"Retain"}}' >/dev/null
  echo "$pvc: PV $pv set to Retain"
done
echo "done. The pre-move copy is still on the data volume under recordings/."
