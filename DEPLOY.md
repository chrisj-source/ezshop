# Deploying Easy Shop

Start to finish, on a fresh Ubuntu 24.04 box. `README.md` explains why the stack
is what it is; this is the order of commands. `INSTALL-MEDIA.md` covers only the
photo and PDF tools — steps 6 and 7 here — so you do not need both open unless
something in the media chain misbehaves.

Read the whole of step 2 before you run any of it. It is the one place where
doing things out of order can lock you out of the box.

**What you need in hand:** a domain name, an SSH key on your own machine, and a
VPS with 2 vCPU and 4 GB (Hetzner CX22 or DigitalOcean 2 GB is plenty).

---

## 1. The box

Create the server with **Ubuntu 24.04 LTS**, add your SSH public key during
creation, and point a DNS A record at its IP straight away — Caddy needs the name
resolving in step 5.

```bash
ssh-keygen -t ed25519 -C "you@yourmachine"   # only if you have no key yet
cat ~/.ssh/id_ed25519.pub                    # this is what you paste in
```

## 2. Users and the firewall

Run this as root. The account gets a password and working `sudo`, you prove both
from a second window, and only then does root get locked out.

```bash
adduser easyshop                 # set a real password
usermod -aG sudo easyshop
rsync --archive --chown=easyshop:easyshop ~/.ssh /home/easyshop
ufw allow OpenSSH && ufw allow 80 && ufw allow 443 && ufw enable
```

**Leave this root session open.** In a second terminal:

```bash
ssh easyshop@your.server.ip
sudo whoami                      # must print: root
```

Only once that works, back in the root session:

```bash
sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config
sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
systemctl restart ssh
```

Then, as `easyshop`:

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y fail2ban unattended-upgrades
sudo dpkg-reconfigure -plow unattended-upgrades
```

Two consequences: your provider's browser console stops working (it logs in as
root over SSH), and password login is gone everywhere. Both are intended. Keep
the `easyshop` password anyway — it is what gets you out of trouble in the
provider's recovery console.

## 3. MariaDB

```bash
sudo apt install -y mariadb-server
sudo mysql_secure_installation      # set a root password, yes to everything else
sudo sed -i 's/^bind-address.*/bind-address = 127.0.0.1/' /etc/mysql/mariadb.conf.d/50-server.cnf
sudo systemctl restart mariadb
```

The app account, and the wildcard that lets it create one database per shop:

```bash
sudo mysql
```

```sql
CREATE USER 'easyshop_app'@'localhost' IDENTIFIED BY 'a-long-random-password';
GRANT ALL PRIVILEGES ON `easyshop_master`.* TO 'easyshop_app'@'localhost';
GRANT ALL PRIVILEGES ON `es\_%`.* TO 'easyshop_app'@'localhost';
GRANT CREATE, DROP ON *.* TO 'easyshop_app'@'localhost';
FLUSH PRIVILEGES;
EXIT;
```

Keep that password — it goes in `.env` twice, as `DB_PASSWORD` and as
`TENANT_SECRET_DEFAULT`.

## 4. Node 22

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
node -v            # v22.x
```

## 5. Caddy, for TLS

```bash
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
  | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
  | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install -y caddy
```

`sudo nano /etc/caddy/Caddyfile`, replacing everything in it:

```
app.yourshop.com {
    encode zstd gzip
    reverse_proxy 127.0.0.1:3000 {
        # An EMS import or a batch of photos can take a while.
        transport http {
            read_timeout 300s
        }
    }
    request_body {
        max_size 30MB
    }
}
```

```bash
sudo systemctl restart caddy
curl -I https://app.yourshop.com      # 502 is correct — nothing is listening yet
```

A 502 with a valid certificate means Caddy is right and it is waiting for the
app. `sudo journalctl -u caddy -n 40` if the certificate did not issue — it is
almost always DNS not yet resolving.

## 6. Redis, and the media tools

These are what make thumbnails, decode iPhone photos and render PDF pages.
`INSTALL-MEDIA.md` has the detail and the notes for other distributions.

```bash
sudo apt install -y redis-server mupdf-tools libheif-examples
sudo systemctl enable --now redis-server

redis-cli ping          # PONG
mutool -v               # a version
heif-convert --help     # usage
```

If `libheif-examples` is not found, try `libheif-tools` — either provides
`heif-convert`, which is the only binary the app calls.

None of the three is strictly required. Without Redis, thumbnails are made
during the upload. Without `mutool`, PDFs get a plain glyph and cannot be paged.
Without `heif-convert`, an iPhone HEIC uploads but stays a HEIC with no
thumbnail.

## 7. The code

```bash
sudo mkdir -p /srv/easyshop /srv/easyshop-storage
sudo chown -R easyshop:easyshop /srv/easyshop /srv/easyshop-storage
cd /srv/easyshop
# clone, rsync, or scp the repo here so that this file is /srv/easyshop/server/DEPLOY.md
cd server
npm install
```

`npm install` is where `sharp` arrives — the resizer. If it cannot fetch a
prebuilt binary for your architecture it says so; then:

```bash
sudo apt install -y build-essential libvips-dev
npm install --build-from-source sharp
```

Now the environment:

```bash
cp .env.example .env
nano .env
```

Fill in, at a minimum:

```
APP_URL=https://app.yourshop.com
DB_USER=easyshop_app
DB_PASSWORD=the-password-from-step-3
TENANT_SECRET_DEFAULT=the-password-from-step-3
COOKIE_SECRET=      # openssl rand -hex 32
STORAGE_DIR=/srv/easyshop-storage
REDIS_URL=redis://127.0.0.1:6379
```

```bash
openssl rand -hex 32        # paste as COOKIE_SECRET
chmod 600 .env
```

Then build and load the schema:

```bash
npm run build
sudo mysql < db/master.sql        # the master database, once
npm run migrate                   # every numbered migration, master and tenant
```

`db/tenant.sql` is never run by hand — the app runs it against each new shop
database as that shop is provisioned.

## 8. The service

```bash
npm run bootstrap
```

That creates the first shop and its owner login, and prints a temporary
password. Change it at first sign-in.

`sudo nano /etc/systemd/system/easyshop.service`:

```ini
[Unit]
Description=Easy Shop
After=network.target mariadb.service redis-server.service

[Service]
Type=simple
User=easyshop
WorkingDirectory=/srv/easyshop/server
EnvironmentFile=/srv/easyshop/server/.env
ExecStart=/usr/bin/node dist/server.js
Restart=always
RestartSec=3
StandardOutput=journal
StandardError=journal

# The app only needs its own tree and the storage directory.
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ReadWritePaths=/srv/easyshop-storage

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now easyshop
sudo systemctl status easyshop
```

The thumbnail worker runs inside this same service — there is no second unit to
keep alive.

Check the start-up line that reports the media tools:

```bash
sudo journalctl -u easyshop -n 30 | grep 'media tools'
# media tools — sharp: yes, heif-convert: yes, mutool: yes
```

Anything reading `no` there is something from step 6 that did not take. Admin →
Storage shows the same list in the app.

Now open `https://app.yourshop.com` and sign in.

## 9. Existing documents

Only relevant if you are upgrading a box that already has uploads on it.
Everything uploaded before the thumbnail work has no thumbnail:

```bash
cd /srv/easyshop/server
npm run backfill-thumbs
```

With Redis up it queues the work and returns at once — watch
`sudo journalctl -u easyshop -f` as it drains. Safe to run again; it only touches
what is still waiting.

## 10. Backups, before Monday

```bash
sudo mkdir -p /srv/backups && sudo chown easyshop:easyshop /srv/backups
nano /srv/easyshop/backup.sh
```

```bash
#!/usr/bin/env bash
set -euo pipefail
source /srv/easyshop/server/.env
STAMP=$(date +%F)
OUT=/srv/backups/$STAMP
mkdir -p "$OUT"

# One dump per database, so a single shop can be restored on its own.
for DB in $(mysql -u"$DB_USER" -p"$DB_PASSWORD" -N -e \
  "SHOW DATABASES LIKE 'easyshop_master'; SHOW DATABASES LIKE 'es\\_%'"); do
  mysqldump -u"$DB_USER" -p"$DB_PASSWORD" --single-transaction "$DB" | gzip > "$OUT/$DB.sql.gz"
done

# Documents and photos. Rendered PDF pages are a cache and are skipped.
tar -czf "$OUT/storage.tar.gz" -C /srv easyshop-storage

find /srv/backups -maxdepth 1 -type d -mtime +14 -exec rm -rf {} +
```

```bash
chmod +x /srv/easyshop/backup.sh
crontab -e
```

```
15 2 * * * /srv/easyshop/backup.sh >> /srv/backups/backup.log 2>&1
```

Then get those off the box — rclone to object storage, or a pull from somewhere
else. A backup that lives only on the machine it backs up is not a backup.

---

## Updating an existing box

```bash
cd /srv/easyshop/server
git pull                     # or rsync the new code over
npm install                  # only if package.json changed
npm run build
npm run migrate              # safe to run when there is nothing to do
sudo systemctl restart easyshop
sudo journalctl -u easyshop -n 30
```

`npm run migrate` applies only what a database has not seen, and reports each
step, so running it every deploy is correct.

## When something is wrong

| Symptom | Look here |
| --- | --- |
| 502 from Caddy | `sudo systemctl status easyshop`, then `sudo journalctl -u easyshop -n 60` |
| Certificate did not issue | DNS not resolving yet. `sudo journalctl -u caddy -n 40` |
| `Missing required env var` on start | `.env` is incomplete, or systemd is not reading it — check `EnvironmentFile` |
| Sign-in works, board is empty | The shop has no repair orders yet, or the tenant database was never migrated: `npm run migrate` |
| Thumbnails never appear | `redis-cli ping`, then the `media tools` line in the log |
| PDFs show a plain glyph | `mutool -v` — `mupdf-tools` is missing |
| iPhone photos show a glyph | `heif-convert --help` — `libheif-examples` is missing |
| Uploads fail at about 25 MB | Caddy's `max_size`, and the 25 MB per-file limit in `src/server.ts` |
| Disk filling up | Admin → Storage. Photos are what grows; rendered PDF pages are a cache and clear themselves after thirty days |

## What is running on the box

| | |
| --- | --- |
| `caddy` | TLS and the reverse proxy, port 80 and 443 |
| `easyshop` | The app and the thumbnail worker, on 127.0.0.1:3000 |
| `mariadb` | The master database and one per shop, 127.0.0.1 only |
| `redis-server` | The thumbnail queue, 127.0.0.1 only |

Only Caddy is reachable from outside.
