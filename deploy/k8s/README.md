# Homelab deployment (k3s)

Two Deployments:

- `minutes`: web site, scheduler, captures; streams the video to viewers.
  On the 24-core worker `k3s-04` when it fits. Zoom login on the `data`
  RBD volume (`auth/`).
- `minutes-transcriber`: WhisperX on `k3s-07`'s Radeon 8060S (gfx1151)
  through ROCm, image `minutes-transcriber-rocm` (`transcriber/Dockerfile.rocm`).
  Shares the GPU with Ollama via `devic.es/amd-gpu` (homelab
  `infra/generic-device-plugin`: `/dev/kfd` + the render node, 2 slots; the
  pod adds the render group, gid 110, no privileged mode). MIOpen is off
  (`TORCH_MIOPEN=0`): its runtime-compiled batch-norm kernel fails on
  gfx1151. Model cache on its own RBD volume, `transcriber-models`.

Both mount `recordings` (CephFS, ReadWriteMany): video parts, stitched
videos, transcripts, `minutes.db`. Measured on the 2026-11-24 meeting (45.8
min): the three transcription steps took 3.0 min on the GPU vs 70 min on
k3s-04's CPU (`transcriber/bench.py`, see "Benchmark" below).

Web UI at https://minutes.lab.emc2.build/ (zoom.lab.emc2.build redirects),
LAN only (Traefik `ipAllowList` 192.168.0.0/16). Capture admin needs an
admin account; create the first one in the pod:

    kubectl -n minutes exec deploy/minutes -c capture -- node /app/dist/index.js user add --admin you@example.com

Resources: capture 1.5-8 CPU / 3-8 GiB (two overlapping captures);
transcriber 2-12 CPU / 8-16 GiB plus one GPU slot, live chunks of 60s, and
the final pass doesn't wait for captures (`WAIT_FOR_CAPTURES=0`). The 8 GiB
request also covers the models' GPU memory, which on this APU is system RAM
the cgroup doesn't see; Ollama's request was lowered from 88 to 80 GiB to
make room (homelab `apps/ollama`).

### Moving to this layout (once)

Before 2026-11-25 the transcriber was a second container in `minutes` and
recordings lived on `data`. After the commit that introduced the split is
merged and CI has built its images, with nothing recording:

    deploy/k8s/move-recordings.sh sha-<commit>

It creates `recordings` and `transcriber-models`, stops the web pod,
copies `recordings/` to CephFS and checks every file's checksum, applies
the manifests (`setup.sh`), waits for the transcriber, and sets both new
PVs to `Retain`. The old copy stays on `data` under `recordings/` until
you delete it. Until the move, releases keep deploying the old layout
(release.yml handles both).

### Benchmark

`transcriber/bench.py` times speech-to-text, alignment and speaker
separation on one audio file with the service's settings (in both images:
`python /app/bench.py audio.wav <slug> out.json`, `BENCH_DEVICE=cuda` for
the GPU, `BENCH_MIOPEN=0` on gfx1151). 2026-11-25, 45.8 min meeting:

| | k3s-04 CPU | k3s-07 CPU | k3s-07 GPU |
|---|---|---|---|
| transcribe | 2012 s | 323 s | 58 s |
| align | 417 s | 103 s | 26 s |
| diarize | 1780 s | 519 s | 93 s |
| total | 70 min | 15.7 min | 3.0 min |

Same segments and speakers; 98.8% of words identical GPU vs CPU (two CPU
runs agree on 98.9%).

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
- Backups (#31): the server backs up `minutes.db` and the saved login
  nightly after 03:00 to the `backups` PVC (CephFS, separate from the
  RBD `data` volume, mounted only in the capture container), 14 days.
  `deploy/k8s/restore.sh` lists them; `deploy/k8s/restore.sh <name>`
  verifies it in the running pod, refuses during or just before a capture
  (`FORCE=1` overrides), scales to 0, restores in a one-off pod, scales
  back. After the PVC is first created, make its PV `Retain` like `data`:

      kubectl -n minutes get pvc backups -o jsonpath='{.spec.volumeName}' |
        xargs -I{} kubectl patch pv {} -p '{"spec":{"persistentVolumeReclaimPolicy":"Retain"}}'

  It's the same Ceph cluster as `data`: this covers a bad migration, a
  deleted or corrupted database and a lost RBD image, not losing Ceph.
- Recordings: `kubectl -n minutes cp -c capture <pod>:/recordings/<slug> recordings/<slug>`.
- The volume's PV is `Retain` (since the move from the `zoom-capture`
  namespace, 2026-11-24, see MIGRATION.md): deleting the PVC or namespace
  keeps the data, and `minutes.yaml` binds the PVC to that PV by name.
- Mail (#32): sign-up and reset codes go out through Cloudflare Email
  Service as `minutes@emc2.build` (`smtp.mx.cloudflare.net:465`, user
  `api_token`), like Alertmanager's alerts. Put a Cloudflare API token with
  Email Sending in `.env` as `SMTP_PASSWORD` and run `setup.sh`; the pod
  reads `SMTP_URL` and `SMTP_PASSWORD` from the `minutes` secret, and mail
  stays off without them. Check it:

      kubectl -n minutes exec deploy/minutes -c capture -- node /app/dist/index.js mail-test you@example.com

- Public host `minutes.emc2.build` (`public.yaml`, #6): the public site
  (published recordings, transcripts, live drafts, sign-in). `/admin` and
  `/api/admin` aren't routed there; admin is on the LAN host only. Rate
  limited (20/s, burst 100). The app trusts X-Forwarded-For only from the
  pod network (`TRUSTED_PROXIES`), so sign-in limits apply per real client.
  Switching from the old hand-applied `public-share.yaml` (once, after #6
  deploys): delete its cert-only Ingress and Certificate, then apply:

      kubectl -n minutes delete ingress minutes-public-share
      kubectl -n minutes delete certificate minutes-public-tls
      kubectl apply -k deploy/k8s   # or setup.sh

  The new `minutes-public` Certificate reuses the `minutes-public-tls`
  secret, so TLS doesn't drop.
