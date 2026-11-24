# Migration: zoom-capture -> minutes (homelab k3s)

Status: done 2026-11-24 (15:35-15:48 Pacific), steps 1-4 and the redirect. Public host (step 5) held until #5/#6. Images were copied in the registry from `zoom-capture:9d03617`, not rebuilt.

Goal: retire the `zoom-capture` namespace and run the same app as
`minutes`, privately at `minutes.lab.emc2.build` (LAN) and publicly at
`minutes.emc2.build` (through Cloudflare), without losing recordings,
`jobs.json` or the saved Zoom login.

## What's there now

| thing | state |
|---|---|
| namespace | `zoom-capture`, one pod (capture + transcriber), images `9d03617` |
| volume | PVC `data`, 200Gi `csi-rbd-sc` (Ceph RBD), **reclaim policy `Delete`** |
| on the volume | `recordings/` ~3 GB (2 recordings, `jobs.json`, `session.json`), `auth/zoom-auth.json` (refreshed in place, newer than the secret), `models/` ~1.9 GB |
| secrets | `zoom-capture` (HF_TOKEN only), `zoom-auth` (seed login, older copy), `dev-registry-pull`, `zoom-capture-tls` |
| ingress | `zoom.lab.emc2.build`, LAN only (`lan-only` ipAllowList) |
| scheduled | one job, `meeting-20261124-1730` (17:30 Pacific, 2026-11-24) |

**Deleting the namespace deletes the volume and everything on it** (reclaim
policy `Delete`). The plan keeps the Ceph volume and moves it instead of
copying it.

## Approach: rebind the same volume

Set the PV to `Retain`, delete the old namespace (the PV becomes
`Released` and its RBD image stays), clear its `claimRef`, and bind a new
PVC in `minutes` to it by `volumeName`. No copy, nothing re-downloaded,
`jobs.json` and its scheduled jobs carry over. This also removes the reason
CLAUDE.md gives for keeping the old namespace name.

A tarball of `recordings/` + `auth/` is taken first anyway (step 1), so a
mistake in the rebind is recoverable. Models are skipped (re-downloadable).

## Steps

Run between meetings: a deploy stops a running capture, and the
17:30 job on 2026-11-24 must either finish first or be re-checked after.
Never run both deployments at once (two schedulers would both join).

### 0. Build and push the renamed images

    TAG=$(git rev-parse --short HEAD)
    docker buildx build --platform linux/amd64 -t registry.lab.emc2.build/minutes:$TAG --push .
    docker buildx build --platform linux/amd64 -t registry.lab.emc2.build/minutes-transcriber:$TAG --push transcriber

### 1. Stash secrets and data (outside the repo)

Into a dated directory outside the repo, mode 700:
- `kubectl get secret zoom-capture zoom-auth -o yaml` with metadata stripped
  (HF_TOKEN, seed login)
- the **live** `auth/zoom-auth.json` from the pod (newer than the secret)
- `tar` of `/recordings` (with `jobs.json`, `session.json`) and `/auth`
  streamed from the pod
- `kubectl get pv,pvc -o yaml` for the volume (to rebind back if needed)

Not stashed: `zoom-capture-tls` (cert-manager issues new certs for the new
hosts) and `dev-registry-pull` (copied from `trailwave-dev` again).

Check: tarball lists, sizes match `du`, the login file is valid JSON.

### 2. Keep the volume, remove the old deployment

    kubectl patch pv <pv> -p '{"spec":{"persistentVolumeReclaimPolicy":"Retain"}}'
    kubectl -n zoom-capture scale deploy/zoom-capture --replicas=0   # SIGTERM path, 180s grace
    kubectl delete namespace zoom-capture
    kubectl patch pv <pv> --type json -p '[{"op":"remove","path":"/spec/claimRef"}]'   # Released -> Available

Check: PV `Available`, reclaim `Retain`.

### 3. New manifests (`deploy/k8s/minutes.yaml`)

Same pod as today, renamed. Changes from `zoom-capture.yaml`:

- namespace, labels, deployment, service: `minutes`
- images `registry.lab.emc2.build/minutes` and `.../minutes-transcriber`
- PVC `data` with `volumeName: <the old PV>`, same class and size
- secrets `minutes` (from `.env`) and `minutes-zoom-auth` (seed)
- `setup.sh`: `NS=minutes`, new secret names, new URL; kustomization image names
- the init container stays: it only seeds the login when the volume has none
  (it has one), and the chowns are no-ops

Ingresses and middlewares:

| host | middlewares | notes |
|---|---|---|
| `minutes.lab.emc2.build` | `lan-only` (192.168.0.0/16), http->https | full UI, as today |
| `zoom.lab.emc2.build` | redirect to `minutes.lab.emc2.build` | optional, keeps old bookmarks working (utensil-maker pattern) |
| `minutes.emc2.build` | `cloudflare-only` ipAllowList, `ratelimit` keyed on `CF-Connecting-IP`, http->https | see "Public host" below |

All with `cert-manager.io/cluster-issuer: letsencrypt-prod`.

### 4. Apply and verify

    deploy/k8s/setup.sh $TAG

Check:
- PVC `Bound` to the old PV; pod `2/2`
- `/recordings` lists both recordings and `jobs.json` (scheduled jobs still there)
- web UI on `minutes.lab.emc2.build`: recordings play, Zoom login "ok"
  after "Check now"
- transcriber log: models found on the volume, no download
- from outside the LAN, `minutes.lab.emc2.build` is refused

### 5. Public host

**Blocker:** the server has no public/admin split yet (#5, #6). Today's
page and API are the admin UI: anyone who reaches it can make the
signed-in Zoom account join meetings, see the bot's live screen and logs,
and `CAPTURE_WEB_TOKEN` isn't set. So `minutes.emc2.build` must not route
to the app as it is. Options:

1. **Hold the public route until #5/#6 ship (recommended).** Do DNS, the
   cert and the middlewares now; the public Ingress points at nothing or a
   static placeholder; switch it to the app when Phase 1 lands.
2. Interim read-only: Traefik allows only GET/HEAD on `/media/` and
   `/api/recordings` on the public host. Recordings become downloadable but
   there's no page for them (`/` is the admin page), so of little use.
3. Basic auth on the public host (set `CAPTURE_WEB_TOKEN`). Private, not
   public.

DNS and Cloudflare:
- `minutes.emc2.build` currently resolves straight to the home IP (not
  proxied), unlike `utensil` / `music`. Add a **proxied** record in
  Cloudflare, otherwise the `cloudflare-only` allowlist refuses everyone.
- Cloudflare's CDN terms restrict serving video or large files from the
  proxy on non-video plans. For downloads at scale, consider a separate
  DNS-only (unproxied) hostname for `/media/` and the download API, or
  Cloudflare R2 / Stream later. Fine for light use.
- Cache: don't let Cloudflare cache `/api/*`; `/media/*` caching is fine
  for published files (free plan caches files up to 512 MB).

### 6. Clean up

- Remove `deploy/k8s/zoom-capture.yaml`; update `deploy/k8s/README.md` and
  the CLAUDE.md paragraph about keeping the old namespace.
- Leave the PV on `Retain` (safer for this data from now on).
- Keep the stash until the first meeting has been captured on `minutes`.

## Rollback

Before step 2: nothing changed, scale the old deployment back up.
After step 2: scale `minutes` to 0, delete its PVC (PV is `Retain`, data
stays), clear `claimRef`, recreate `zoom-capture` from the stashed
manifests with a PVC bound to the same PV, old images `9d03617`. If the
volume itself is lost: new volume + untar the stash, models re-download.
