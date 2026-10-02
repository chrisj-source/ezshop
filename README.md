# a0.8.2 — 2 Oct 2026

Copy each file over the same path under /srv/easyshop (this folder mirrors the
repo root, which is the server tree). SERVER-NOTES.md, CLAUDE.md and QUEUE.md are
project notes.

Contains a0.8.1 (adding statuses), the EMS multi-estimate import, the same-day
in/out date fix, and a0.8.2 (external invoices).

Then:

    npm run migrate          # master 012, tenant 038 and 039
    npm run build && sudo systemctl restart easyshop

Migrate first: /api/config reads statuses.is_custom.

After: platform admin -> Extreme Hail & Collision -> Features -> External invoices
on, then Invoicing database -> Save and test -> Read now.
