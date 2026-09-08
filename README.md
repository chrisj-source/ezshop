# Easy Shop — server

The decisions, the stack, and the commands to stand up a box tonight.

---

## Shared web host or VPS?

**VPS.** Shared hosting cannot do three things this system needs:

1. **Create databases at runtime.** Database-per-shop means the app issues `CREATE DATABASE` and `GRANT` when you add a company. Shared hosts do not give an application those privileges — you'd be creating every shop by hand in cPanel.
2. **Run a long-lived process.** The app is a persistent server holding a connection pool per tenant. Shared PHP hosting spins up and dies per request; there is nowhere for the pools to live.
3. **Accept the EMS agent's uploads on a schedule** without a request timing out mid-import.

A VPS is also cheaper than it sounds. One box runs the app, MariaDB and TLS.

**Recommended:** Hetzner CX22 (2 vCPU, 4 GB, €4.5/mo) or DigitalOcean 2 GB ($12/mo). Ubuntu 24.04 LTS. Either is far more machine than one shop needs; the headroom is for the tenant connection pools.

---

## Stack

| Layer | Choice | Why |
| --- | --- | --- |
| Runtime | **Node 22 LTS + TypeScript** | One language front to back, so the prototype screens carry over instead of being rewritten. TypeScript matters here because the tenant routing code is the part that must never be wrong. |
| HTTP | **Fastify** | Faster and stricter than Express, with schema validation on every route built in. |
| Database | **MariaDB 11** | Your pick. Drop-in for MySQL 8, better licensing, and `mysqldump` per database is how you'll back up a single shop. |
| Driver | **mysql2** with a pool per tenant | Promise API, prepared statements by default. |
| Sessions | **Signed cookie + session row in the master DB** | No Redis to run or secure. Sessions are cheap to look up and instantly revocable when you switch a company off. |
| Passwords | **argon2id** | Current standard. bcrypt is acceptable; argon2 is better and the library is one line. |
| Frontend | **Vite + React**, screens ported from the prototypes | The prototypes are already React-shaped. Server-rendered pages would mean rewriting all of it. |
| TLS + reverse proxy | **Caddy** | Automatic Let's Encrypt certificates with a three-line config. No certbot cron to forget. |
| Process manager | **systemd** | Already on the box. No pm2 to keep alive. |
| EMS agent | **Node packaged to a single .exe** | Runs as a Windows scheduled task on the shop computer, watches the CCC export folder, uploads new files. |

### On lag

The prototypes hold their data in memory, so they feel instant. Real screens fetch. Three things keep it feeling the same:

- The board loads one payload per view, not one request per row.
- Tenant connection pools stay warm — the second request to a shop never pays connection cost.
- The status/lane/position config is cached in memory per tenant and invalidated on write; it is read on every screen and changes maybe monthly.

One shop with twenty open ROs will not lag. Revisit when a shop has thousands of closed files and the board needs pagination — which it already does client-side.

---

## Tenancy

```
                    ┌─────────────────────┐
   request ────────▶│  master DB          │  who are you, which company,
                    │  easyshop_master    │  is it switched on, what
                    └──────────┬──────────┘  features does it have
                               │ db_name, credentials ref
                               ▼
                    ┌─────────────────────┐
                    │  tenant DB          │  ROs, leads, parts, docs,
                    │  es_extremehail     │  notes, appointments
                    └─────────────────────┘
```

**Identity lives in the master.** Users, memberships and sessions are all master tables — including shop staff, not just owners. This is the one place I'd deviate from your original sketch: splitting logins across two databases means two password tables, two reset flows, and session lookup that must know the tenant before it knows the user. A person who works at two shops becomes impossible. The tenant DB holds work, not people.

Staff *profiles* — employee code, position, which lanes they own — do live in the tenant DB, keyed to the master `user_id`.

**Credentials are never stored in the master in usable form.** `company_databases.secret_ref` holds a *name*, not a password. In production that name resolves against the secret store; on a single VPS it resolves against an env file readable only by the app user. Rotating a shop's password touches one file, not a database row.

---

## Provisioning a box

A fresh Ubuntu 24.04 VPS. Step 1 runs as root; everything after it runs as `easyshop` with `sudo`.

### 0. Before you create the droplet

Have an SSH key on your own machine. Check:

```powershell
type $env:USERPROFILE\.ssh\id_ed25519.pub     # Windows PowerShell
cat ~/.ssh/id_ed25519.pub                      # macOS / Linux
```

Nothing there? `ssh-keygen -t ed25519` and press enter through the prompts.

Create the droplet with **Ubuntu 24.04 LTS**, add that public key during creation, and point a DNS A record at the IP straight away — Caddy needs it resolving in step 4.

### 1. Users and firewall

**Order matters here.** The account gets a password and a working `sudo`, you prove both work from a second window, and only then does root get locked out. Doing it the other way round leaves you with a box you can log into but can't administer, and the only way back is DigitalOcean's Recovery Console.

As **root**, over SSH:

```bash
adduser easyshop
```

This prompts for a password — set one and write it down. It is what `sudo` will ask for. (Do **not** use `--disabled-password`; an account with no password cannot use `sudo`.)

```bash
usermod -aG sudo easyshop

mkdir -p /home/easyshop/.ssh
cp ~/.ssh/authorized_keys /home/easyshop/.ssh/
chown -R easyshop:easyshop /home/easyshop/.ssh
chmod 700 /home/easyshop/.ssh && chmod 600 /home/easyshop/.ssh/authorized_keys
```

#### Prove it works before locking anything

**Leave this root session open.** In a *second* terminal window:

```bash
ssh easyshop@your.droplet.ip
sudo -v          # enter the password you just set
```

Both must succeed. If the login fails, your key didn't copy — fix it from the still-open root session. If `sudo -v` fails, the password or the group didn't take.

Only once both work, back in the **root** session:

```bash
sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config
sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
sshd -t && systemctl restart ssh
```

`sshd -t` checks the config before the restart — a typo there with no valid session open is how people lose a box.

Then, as `easyshop`:

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80
sudo ufw allow 443
sudo ufw --force enable

sudo apt update && sudo apt upgrade -y
sudo apt install -y fail2ban unattended-upgrades
sudo dpkg-reconfigure -plow unattended-upgrades
```

**Do not skip the SSH lockdown** — a box with password login and a database on it gets found within hours.

#### Two consequences of the lockdown

- **DigitalOcean's browser "Console" stops working.** It logs in as root over SSH, which no longer exists. This is expected. Use your own terminal.
- **Recovery Console still works** — droplet page → Access → Reset Root Password, then Access → Recovery Console. It is a serial terminal, not SSH, so it bypasses all of the above. That is your way back in if you lose your key. Copy-paste is unreliable in that window; type commands by hand.

If you would rather `sudo` never prompted, run this as root *before* the lockdown:

```bash
echo 'easyshop ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/easyshop
chmod 440 /etc/sudoers.d/easyshop
```

Defensible on a key-only box. Set the password anyway — it is what gets you out of trouble in the recovery console.

### 2. MariaDB

```bash
sudo apt install -y mariadb-server
sudo mysql_secure_installation     # set a root password, answer yes to everything else
```

Bind it to localhost only — the app is on the same box, nothing external should reach 3306:

```bash
sudo sed -i 's/^bind-address.*/bind-address = 127.0.0.1/' /etc/mysql/mariadb.conf.d/50-server.cnf
sudo systemctl restart mariadb
```

Create the master database and the application account:

```bash
sudo mysql -u root -p
```
```sql
CREATE DATABASE easyshop_master CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- the app's own account: full rights on master, and the ability to create tenant DBs
CREATE USER 'es_app'@'localhost' IDENTIFIED BY 'PUT_A_LONG_RANDOM_PASSWORD_HERE';
GRANT ALL PRIVILEGES ON easyshop_master.* TO 'es_app'@'localhost';
GRANT ALL PRIVILEGES ON `es\_%`.* TO 'es_app'@'localhost';
GRANT CREATE USER ON *.* TO 'es_app'@'localhost';
FLUSH PRIVILEGES;
```

The `es\_%` wildcard is what lets the app create and use `es_extremehail`, `es_lonestar` and so on without holding rights over the whole server.

### 3. Node

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
node -v      # expect v22.x
```

### 4. Caddy (TLS)

```bash
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
  | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
  | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install -y caddy
```

Now **edit** the config file — this is a path to open in an editor, not a command to run:

```bash
sudo nano /etc/caddy/Caddyfile
```

Replace the whole contents with this, using your real hostname:

```
app.yourdomain.com {
    encode gzip zstd
    reverse_proxy 127.0.0.1:3000
}
```

`Ctrl+O`, Enter, `Ctrl+X` to save and quit. Then:

```bash
sudo systemctl reload caddy
sudo systemctl status caddy
```

Point an A record at the box **before** reloading — Caddy fetches the certificate on reload and fails loudly if DNS isn't there yet.

The site will return 502 until the app is running in step 6. That is correct; nothing is listening on port 3000 yet. What you are checking here is that Caddy started and got a certificate — `sudo journalctl -u caddy -n 30` shows the certificate obtained.

### 5. Code and schema

```bash
cd /srv
sudo git clone https://github.com/chrisj-source/ezshop.git easyshop
sudo chown -R easyshop:easyshop easyshop
cd /srv/easyshop/server

mysql -u es_app -p easyshop_master < db/master.sql
mysql -u es_app -p easyshop_master -e "SHOW TABLES;"     # expect 11 tables
```

`db/tenant.sql` is never run by hand. The app runs it against each new tenant database when a company is provisioned.

### 6. App

Everything from here runs in `/srv/easyshop/server`.

```bash
cd /srv/easyshop/server
cp .env.example .env
nano .env
```

Fill in four things:

| Key | Value |
| --- | --- |
| `DB_PASSWORD` | the `es_app` password from step 2 |
| `COOKIE_SECRET` | run `openssl rand -hex 32` and paste the output |
| `EMS_AGENT_TOKEN_SALT` | run `openssl rand -hex 32` again — a different value |
| `APP_URL` | `https://` and your real hostname |

Then lock it down and build:

```bash
chmod 600 .env
sudo mkdir -p /srv/easyshop-storage && sudo chown easyshop:easyshop /srv/easyshop-storage

npm install
npm run build
```

Create the platform owner and your shop. This is interactive — it asks for your
name, email, shop name and a short slug, then prints a temporary password:

```bash
npm run bootstrap
```

The slug becomes the database name (`extremehail` → `es_extremehail`), so keep
it short, lowercase and permanent. Write the temporary password down; you set a
real one at first sign-in.

Now the service — `sudo nano /etc/systemd/system/easyshop.service`:

```ini
[Unit]
Description=Easy Shop
After=network.target mariadb.service

[Service]
Type=simple
User=easyshop
WorkingDirectory=/srv/easyshop/server
EnvironmentFile=/srv/easyshop/server/.env
ExecStart=/usr/bin/node dist/server.js
Restart=always
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ReadWritePaths=/srv/easyshop-storage

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now easyshop
sudo journalctl -u easyshop -f      # watch it boot, Ctrl+C to stop watching
```

Check it:

```bash
curl -s localhost:3000/api/health
```

Expect `{"ok":true,"db":true,...}`. Then open `https://your-domain` in a browser and sign in with the email and temporary password `npm run bootstrap` printed.

**When you pull new code from me:**

```bash
cd /srv/easyshop && git pull
cd server && npm install && npm run build
sudo systemctl restart easyshop
```

### 7. Backups — do this before Monday, not after

```bash
sudo mkdir -p /var/backups/easyshop && sudo chown easyshop:easyshop /var/backups/easyshop
```

Create the backup script — `nano /srv/easyshop/server/scripts/backup.sh`, then `chmod +x` it:

```bash
#!/usr/bin/env bash
set -euo pipefail
source /srv/easyshop/server/.env
STAMP=$(date +%F-%H%M)
DEST=/var/backups/easyshop/$STAMP
mkdir -p "$DEST"
for DB in $(mysql -u es_app -p"$DB_PASSWORD" -N -e "SHOW DATABASES LIKE 'es\\_%'") easyshop_master; do
  mysqldump -u es_app -p"$DB_PASSWORD" --single-transaction --quick "$DB" | gzip > "$DEST/$DB.sql.gz"
done
find /var/backups/easyshop -maxdepth 1 -type d -mtime +14 -exec rm -rf {} +
```

Hourly, via cron as `easyshop` (`crontab -e`):

```
0 * * * * /srv/easyshop/server/scripts/backup.sh >> /var/log/easyshop-backup.log 2>&1
```

Per-database dumps are the whole point of this tenancy model — restoring one shop never touches another. **Copy these off the box.** A backup on the same disk as the database is not a backup; add `rclone` to Backblaze B2 or S3 once the rest is running.

---

## Environment

Create `.env.example` in the repo (and copy it to `.env` on the box):

```
NODE_ENV=production
PORT=3000
APP_URL=https://app.yourdomain.com

DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=es_app
DB_PASSWORD=
MASTER_DB=easyshop_master

# tenant DB credentials resolve by secret_ref -> TENANT_SECRET_<REF>
TENANT_SECRET_DEFAULT=

COOKIE_SECRET=            # 64 random hex chars: openssl rand -hex 32
SESSION_DAYS=14

EMS_AGENT_TOKEN_SALT=     # openssl rand -hex 32
```

`chmod 600 .env` and keep it out of git.

---

## Order of work

| | |
| --- | --- |
| **Thu** | Box provisioned, MariaDB up, master schema loaded, TLS working, app boots and serves a login page. Company provisioning: create a shop, its database, its owner login. |
| **Fri** | Statuses, positions and staff. The board and the RO drawer against real data. |
| **Sat** | EMS import screen and the file agent. Load your open ROs. |
| **Sun** | Parts, documents, notes. Whatever breaks on Saturday. |
| **Mon** | You use it. Everything not finished is switched off per company on the platform screen, so the shop never sees a half-built page. |

Leads, scheduler, clients and reports come after Monday. They are already designed; wiring them is additive.
