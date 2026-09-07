#!/usr/bin/env bash
# Hourly per-database backup. One dump per shop, so restoring one never
# touches another. Copy these off the box — a backup on the same disk is not
# a backup.
set -euo pipefail

source /srv/easyshop/server/.env

STAMP=$(date +%F-%H%M)
DEST=/var/backups/easyshop/$STAMP
mkdir -p "$DEST"

for DB in $(mysql -u "$DB_USER" -p"$DB_PASSWORD" -N -e "SHOW DATABASES LIKE 'es\\_%'") "$MASTER_DB"; do
  mysqldump -u "$DB_USER" -p"$DB_PASSWORD" --single-transaction --quick "$DB" \
    | gzip > "$DEST/$DB.sql.gz"
done

find /var/backups/easyshop -maxdepth 1 -type d -mtime +14 -exec rm -rf {} +
echo "$(date -Is) backed up $(ls "$DEST" | wc -l) databases to $DEST"
