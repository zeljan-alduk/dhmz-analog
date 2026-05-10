# Deployment — VPS commands and paths

## Connection

```bash
ssh -i ~/.ssh/id_ed25519 ubuntu@135.125.161.96
```

The user does NOT have an `aldo-vps` ssh-config alias. Always use the
explicit `-i` form. Passwordless sudo is configured for the `ubuntu` user.

## Container topology

| Container | Project | Network attach | Public port? |
|---|---|---|---|
| `transit-nginx` | slovenia-transit | `slovenia-transit_default` | **80, 443** (TLS edge) |
| `dhmz-web` | dhmz-analog | `slovenia-transit_default` | no |
| `dhmz-backend` | dhmz-analog | `slovenia-transit_default` | no |
| `aldo-*` (4) | aldo-ai | `slovenia-transit_default` + `aldo-ai_*` | no |
| `transit-*` (5) | slovenia-transit | `slovenia-transit_default` | no |

Reachability for `transit-nginx`: by container name on the shared network
(`http://dhmz-web:80`, `http://dhmz-backend:8000`).

**Don't touch** the `aldo-*` or `transit-*` containers — see
`/Users/aldo/Documents/ai/VPS_BRIEFING_FOR_NEW_APP.md`.

## Filesystem layout

```
/opt/dhmz-analog/
  ├── docker-compose.yml      # dhmz-web (nginx:alpine)
  └── out/                    # static export rsynced from local

/opt/dhmz-backend/
  ├── docker-compose.yml      # dhmz-backend (FastAPI)
  ├── Dockerfile
  ├── requirements.txt
  ├── app/                    # bind-mounted as /app/app:ro (live reload)
  │   ├── main.py extract.py calibrate.py geometry.py schemas.py
  └── templates/              # bind-mounted as /app/templates:ro
      └── barograph.png       # 60 MB reference, loaded once at startup

/opt/slovenia-transit/nginx/conf.d/zzz-dhmz-aldo-tech.conf
                              # edge nginx config — both upstreams + TLS
```

## Frontend deploy (every code change)

```bash
# Build locally
npm run build

# Sync to VPS (deletes stale files)
rsync -avz --delete -e "ssh -i ~/.ssh/id_ed25519" \
  out/ ubuntu@135.125.161.96:/opt/dhmz-analog/out/
```

`dhmz-web` serves `/opt/dhmz-analog/out/` via a read-only volume mount.
No restart needed — files are picked up immediately.

## Backend deploy

### Code-only change (most common)

```bash
rsync -avz -e "ssh -i ~/.ssh/id_ed25519" \
  backend/app/ ubuntu@135.125.161.96:/opt/dhmz-backend/app/

ssh -i ~/.ssh/id_ed25519 ubuntu@135.125.161.96 \
  'cd /opt/dhmz-backend && sudo docker compose restart'
```

Bind mount means no rebuild. Container restart is ~3 s.

### Dockerfile / requirements.txt change

```bash
rsync -avz -e "ssh -i ~/.ssh/id_ed25519" \
  backend/ ubuntu@135.125.161.96:/opt/dhmz-backend/

ssh -i ~/.ssh/id_ed25519 ubuntu@135.125.161.96 \
  'cd /opt/dhmz-backend && sudo docker compose up -d --build'
```

### Add a new template

```bash
# 1. Copy template
rsync -avz -e "ssh -i ~/.ssh/id_ed25519" \
  /path/to/<chart-type>.png \
  ubuntu@135.125.161.96:/opt/dhmz-backend/templates/<chart-type>.png

# 2. Restart so module-load picks it up
ssh -i ~/.ssh/id_ed25519 ubuntu@135.125.161.96 \
  'cd /opt/dhmz-backend && sudo docker compose restart'

# 3. Verify
ssh -i ~/.ssh/id_ed25519 ubuntu@135.125.161.96 \
  'sudo docker logs dhmz-backend 2>&1 | grep template'
```

## Edge nginx (rare)

Config at `/opt/slovenia-transit/nginx/conf.d/zzz-dhmz-aldo-tech.conf`.
Bind-mounted into `transit-nginx` (slovenia-transit project).

```bash
# Edit on VPS, then:
ssh -i ~/.ssh/id_ed25519 ubuntu@135.125.161.96 \
  'sudo docker exec transit-nginx nginx -t && \
   sudo docker exec transit-nginx nginx -s reload'
```

The `client_max_body_size 100m` and `proxy_read_timeout 120s` on `/api/`
are required — frontend now sends FULL-RESOLUTION uploads to the backend
(the 4000-px cap was removed in favour of two-tier preview/full-res). A
9992×3956 reference scan encodes to ~78 MB base64, and a rotated full-res
PNG can run higher still.

> **If you're upgrading from a deploy with `50m`**: edit
> `/opt/slovenia-transit/nginx/conf.d/zzz-dhmz-aldo-tech.conf`, bump to
> `100m`, then `sudo docker exec transit-nginx nginx -t && sudo docker
> exec transit-nginx nginx -s reload`. Without this, `/api/extract-trace`
> and `/api/calibrate-grid` will return 413 on full-res scans.

## TLS

Cert at `/etc/letsencrypt/live/dhmz.aldo.tech/` (volume in transit-certbot).
Renewal runs automatically via slovenia-transit's certbot. To re-issue:

```bash
ssh -i ~/.ssh/id_ed25519 ubuntu@135.125.161.96 \
  'sudo docker run --rm \
    -v slovenia-transit_certbot-etc:/etc/letsencrypt \
    -v slovenia-transit_certbot-var:/var/lib/letsencrypt \
    -v slovenia-transit_webroot:/var/www/certbot \
    certbot/certbot certonly --webroot -w /var/www/certbot \
    -d dhmz.aldo.tech \
    --email info@aldo.tech --agree-tos --non-interactive'
```

## Verification after any change

```bash
# Public health probes
curl -sI https://dhmz.aldo.tech/ | head -1                # 200
curl -s https://dhmz.aldo.tech/api/health                  # {"status":"ok"}

# Container status
ssh -i ~/.ssh/id_ed25519 ubuntu@135.125.161.96 \
  'sudo docker ps --format "table {{.Names}}\t{{.Status}}" | sort'

# Don't break ai.aldo.tech
curl -sI https://ai.aldo.tech/ | head -1                   # 200
```
