# Homelab deployment (k3s)

One pod, two containers (capture + transcriber), one Ceph RBD volume
(`data`: `recordings/`, `models/`, `auth/` as subPaths), on the 24-core
worker `k3s-04` when it fits. Web UI at https://minutes.lab.emc2.build/ (zoom.lab.emc2.build redirects),
LAN only (Traefik `ipAllowList` 192.168.0.0/16), no password unless
`CAPTURE_WEB_TOKEN` is in `.env`.

Resources: capture 1.5-8 CPU / 3-8 GiB (two overlapping captures), transcriber
5-12 CPU / 6-12 GiB with 10 threads, live chunks of 60s, and the final pass
doesn't wait for other captures (`WAIT_FOR_CAPTURES=0`).

## Build and deploy (GitHub Actions)

Every push to `main` deploys, the same way as belay:

1. `ci.yml` `check` (TypeScript build, shell/Python syntax, kustomize
   render) and `images` (both images to `ghcr.io/langfordogsociety/`, tag
   `sha-<commit>`, amd64, layer cache in `buildcache` tags) run side by side.
2. Once both pass, `release.yml` retags the images `main`, then
   **waits until no capture is running or due within 45 min**
   (`scripts/deploy-guard.sh`, up to 4h), then
   `kubectl set image ... :sha-<commit>` and waits for the rollout; a
   failed rollout is undone.

Push-to-main jobs run on `minutes-arc-runners`, the repo's own runner scale
set in the cluster (homelab repo, `infra/actions-runner-controller`); pull
requests run on GitHub's runners and never deploy. The deploy uses the
`github-deploy` ServiceAccount (`github-deploy.yaml`: images and rollouts in
this namespace only), whose token is the repo secret `KUBERNETES_SECRET`.
Without that secret, images are still built but nothing deploys.

Manual deploy of any commit with built images: Actions -> Release -> Run
workflow (pick the commit's ref; `force` skips the meeting guard and stops a
running capture).

## First-time setup

`setup.sh [tag]` (default tag `main`) creates the namespace, the GHCR pull
secret (copied from `belay`) and the `minutes` secret from `.env`, applies
the manifests and the `github-deploy` RBAC, and seeds `auth/zoom-auth.json`
onto the volume if it has none. It's idempotent; routine deploys don't need
it. After a fresh namespace, re-set the repo secret:

    kubectl -n minutes get secret github-deploy-token -o yaml | gh secret set KUBERNETES_SECRET -R LangfordOGSociety/minutes

## Notes

- Never run two schedulers on one Zoom account for the same meeting: the
  laptop's `docker compose` and the cluster each keep their own `minutes.db`.
- `Recreate` strategy and one replica: a rolling update would run two pods
  that both join meetings. A deploy during a capture stops it (SIGTERM
  closes the part and stitches, 180s grace) and the capture does not
  resume. The release workflow waits for captures; a manual `setup.sh`
  doesn't, so check the page first.
- Recordings: `kubectl -n minutes cp -c capture <pod>:/recordings/<slug> recordings/<slug>`.
- The volume's PV is `Retain` (since the move from the `zoom-capture`
  namespace, 2026-11-24, see MIGRATION.md): deleting the PVC or namespace
  keeps the data, and `minutes.yaml` binds the PVC to that PV by name.
- Public host `minutes.emc2.build` is not routed yet: it waits for the
  public/admin split (#5, #6). Make its Cloudflare record proxied first.
