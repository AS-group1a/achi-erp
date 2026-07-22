# Hosting ACHI ERP on Hetzner Cloud

Everything here is one-time setup by whoever owns the Hetzner account. It should
not be an intern: the SSH key and the account are root access to every customer
record, the JWT secret and the database password.

`bootstrap.sh` does the actual work. This document is the decisions around it.

---

## 1. The server

**Type: CPX32** (4 vCPU, 8 GB, 160 GB) — about $42/month, ~$50 with backups.

CPX42 (8 vCPU / 16 GB) also works and costs roughly double. CPX32 is the
defensible default: the app plus Postgres sits around 4–5 GB in practice, and
Hetzner resizes CPU and RAM **in place** (power off, resize, power on — minutes),
so being wrong is a reboot rather than a rebuild.

**Do NOT use the CAX line.** CAX is ARM and it is the cheapest, which is exactly
why people pick it. OCE's CAD/BIM converters are amd64-only `.debs`; on ARM they
return **placeholder geometry instead of failing**. Wrong output that looks
correct is worse than a crash. `bootstrap.sh` warns about this too.

CCX (dedicated vCPU) is ~3x the price and unnecessary for an internal ERP.

- **Image:** Ubuntu 24.04
- **Location:** nearest your users (Falkenstein/Nuremberg for Lebanon/EU)
- **Backups:** yes, tick it (~20% surcharge). See §6 for what they do and do not
  cover.
- **Volume:** no. The local disk is far more than enough, and a Hetzner Volume
  adds a genuinely nasty failure mode — see §7.

## 2. Firewall (Hetzner Cloud Firewall)

Inbound, three rules:

| Port | Protocol | Source            | Why |
|------|----------|-------------------|-----|
| 22   | TCP      | your IPs only     | SSH |
| 80   | TCP      | `0.0.0.0/0`, `::/0` | Let's Encrypt validation + HTTPS redirect |
| 443  | TCP      | `0.0.0.0/0`, `::/0` | the app |

Outbound: leave as default (allow all) — the build needs Docker Hub and PyPI.

**80 must be open to the world**, not just the office. Caddy proves domain
ownership over HTTP and Let's Encrypt validates from its own servers. Restrict
80 and TLS silently fails to renew — you find out 90 days later.

Nothing else needs opening. Postgres declares no `ports:` and the app only uses
`expose: 8080`, so both are reachable **only** from inside the Docker network.
If someone asks to expose 5432 "to check the database", the answer is no; use
`docker compose exec postgres psql`.

**Use the Hetzner firewall, not only `ufw`.** Docker publishes ports by writing
iptables rules that **bypass ufw entirely** — a host that looks closed to
`ufw status` can still have containers exposed. Hetzner's firewall sits outside
the host, so Docker cannot punch through it.

Restricting SSH to a dynamic home IP will eventually lock you out. Hetzner's web
console works regardless of firewall rules and is always the way back in.

## 3. DNS — before you deploy

Point an A record (and AAAA if you use IPv6) at the server IP and let it
propagate **first**. Caddy requests the certificate on startup via HTTP
validation; if DNS is not live yet, it fails and retries with backoff.

## 4. Deploy

```bash
ssh root@<server-ip>
curl -fsSL https://get.docker.com | sh
git clone https://github.com/AS-group1a/achi-erp.git
cd achi-erp/deploy
SITE_ADDRESS=erp.yourdomain.com ./bootstrap.sh
```

IP-only demo with no TLS: `SITE_ADDRESS=:80 ./bootstrap.sh`.

`bootstrap.sh` generates `.env` with fresh secrets, builds the image, starts
Postgres + app + Caddy, waits for health, and installs the ACHI pack. First boot
builds the schema across ~560 tables — allow several minutes. It clones `main`,
so make sure the work you want deployed is merged there.

## 5. Immediately after

1. **Register the first account.** The first registrant becomes admin. Do this
   before anyone else can reach the box.
2. **Apply branding** (needs that admin's JWT). The logo and company name live in
   the database, not the image, which is why this is a separate step:
   ```bash
   TOKEN=<jwt> BASE=https://erp.yourdomain.com ../packs/achi-scaffolding/apply-branding.sh
   ```
3. **Back up `deploy/.env` somewhere safe.** It is the only copy of the JWT
   secret and the database password.
4. **Disable SSH password login** once your key works — `PasswordAuthentication
   no` in `/etc/ssh/sshd_config`, then `systemctl restart ssh`. Test the key in a
   second terminal before closing the first. Hetzner IPs get scanned within
   minutes of coming up.
5. **Point an uptime check at `/api/health`.** There is no monitoring in this
   product — no metrics endpoint, no Sentry.

## 6. Backups — you need both kinds

**Hetzner backups** (the checkbox) are automatic whole-server snapshots, 7
retained. Worth having. But understand them:

- They are **crash-consistent disk images** taken while Postgres is running, not
  clean database dumps. Postgres normally recovers by replaying its WAL, but
  "normally" is not what you want to discover mid-incident.
- Restoring rolls back the **entire server**. You cannot extract one table.
- They live in the **same Hetzner account** — no protection against a
  compromised or closed account.

**So also run `pg_dump`, off-box, on cron:**

```bash
docker compose exec -T postgres pg_dump -U oce openconstructionerp | gzip > backup-$(date +%F).sql.gz
```

This is the one that saves you when somebody deletes a month of call logs and
you need *those rows* — not last Tuesday's whole machine.

**Restore it once, on purpose, before you need it.** An untested backup is a
belief, not a backup. This is the single most common way small teams lose data
while believing they had backups.

Note: the built-in "backup" module is **not** a backup. It exports ~20 of ~560
tables, scoped to one user.

## 7. Why no Hetzner Volume

The local disk (160 GB on CPX32) is years of headroom, and a Volume is network
storage — slower for Postgres, and it adds this failure mode:

If the volume is not mounted when Docker starts — a reboot where `fstab` was
slow — Docker does not error. It **creates fresh empty directories** and the app
boots with an empty database. It looks exactly like total data loss. It is not,
but it is a frightening hour, and self-inflicted.

If you ever do need one, the trigger will be site-survey photos (up to 25 MB
each, stored in the `appdata` volume) rather than the database. Add it when free
space drops under ~30%: attach, format `ext4`, mount via `fstab` **with
`nofail`**, bind-mount `appdata` onto it, then verify a reboot actually remounts
it before trusting it.

## 8. Upgrading OCE

This is not a fork. The image installs `openconstructionerp` from PyPI and
copies `modules/achi` in beside upstream's modules, so upgrades are:

```bash
# edit OCE_VERSION in deploy/.env, then
docker compose up -d --build
```

The build asserts our module is still discovered and **fails loudly** if not, so
a bad upgrade breaks at build time instead of shipping an app with no Call Log.

Two cautions. Upstream ships ~2.9 releases/day and its version numbers carry no
compatibility signal (10.9.0 → 11.9.0 in six days) — pin it, never track latest.
And the theme overrides target upstream's internal CSS variables, so after any
bump **load the page and look at it**; a broken override degrades to OCE's
default blue rather than erroring.

## 9. AI (later)

Nothing to plan for. OCE already supports Anthropic, OpenAI, Gemini, DeepSeek,
Groq, Mistral and Ollama, configured through the app's settings — an API key,
not a project. It calls the provider over HTTPS, so it does not change the
server sizing.

Do **not** self-host a model on these servers. CPX is *shared* vCPU and
inference pins every core at 100%, which is what Hetzner's fair-use policy
exists to catch; and if memory runs short the OOM killer takes the largest
process, which may be Postgres. Self-hosting needs a GPU box at several times
this budget to produce worse output than an API key costing a few dollars a
month.

The real question is not technical: using it sends customer names, numbers and
enquiry details to that provider. That is an owner's decision — check their
retention and training terms first.

## 10. If the build fails

The Docker build has not been exercised in CI, so the first real build happens
on the server. If it fails:

```bash
docker compose logs app          # app boot, module loading, schema creation
docker compose logs caddy        # TLS/certificate problems
docker compose ps                # what is actually running
```

Schema errors on first boot are usually a module declaring an index twice
(`DuplicateTableError` aborts startup for the *whole* app, not one module).
Certificate errors are almost always DNS not pointing at the server yet, or
port 80 closed.
