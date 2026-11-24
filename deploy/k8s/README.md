# Homelab deployment (k3s)

One pod, two containers (capture + transcriber), one Ceph RBD volume
(`data`: `recordings/`, `models/`, `auth/` as subPaths), on the 24-core
worker `k3s-04` when it fits. Web UI at https://minutes.lab.emc2.build/ (zoom.lab.emc2.build redirects),
LAN only (Traefik `ipAllowList` 192.168.0.0/16), no password unless
`CAPTURE_WEB_TOKEN` is in `.env`.

Resources: capture 1.5-8 CPU / 3-8 GiB (two overlapping captures), transcriber
5-12 CPU / 6-12 GiB with 10 threads, live chunks of 60s, and the final pass
doesn't wait for other captures (`WAIT_FOR_CAPTURES=0`).

## Build and deploy

The nodes are amd64; build on the Mac with buildx and push to the homelab
registry (`docker login registry.lab.emc2.build` once):

    TAG=$(git rev-parse --short HEAD)
    docker buildx build --platform linux/amd64 -t registry.lab.emc2.build/minutes:$TAG --push .
    docker buildx build --platform linux/amd64 -t registry.lab.emc2.build/minutes-transcriber:$TAG --push transcriber
    deploy/k8s/setup.sh $TAG

`setup.sh` creates the namespace, the registry pull secret (copied from
`trailwave-dev`) and the `minutes` secret from `.env`, applies the
manifests with that tag, and copies `auth/zoom-auth.json` onto the volume.
Later deploys: same build, then `setup.sh $TAG` again (it's idempotent and
recopies the login, so skip that step if the cluster's copy is newer).

## Notes

- Never run two schedulers on one Zoom account for the same meeting: the
  laptop's `docker compose` and the cluster each keep their own `jobs.json`.
- `Recreate` strategy and one replica: a rolling update would run two pods
  that both join meetings. A deploy during a capture stops it (SIGTERM
  closes the part and stitches, 180s grace) and the capture does not
  resume, so don't deploy during a meeting.
- Recordings: `kubectl -n minutes cp -c capture <pod>:/recordings/<slug> recordings/<slug>`.
- The volume's PV is `Retain` (since the move from the `zoom-capture`
  namespace, 2026-11-24, see MIGRATION.md): deleting the PVC or namespace
  keeps the data, and `minutes.yaml` binds the PVC to that PV by name.
- Public host `minutes.emc2.build` is not routed yet: it waits for the
  public/admin split (#5, #6). Make its Cloudflare record proxied first.
