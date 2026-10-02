# Easy Shop — project notes

## Version

The build is at **a0.8.2**. Format is `a<major>.<minor>.<patch>` — `a` for alpha.
Use this in delivery notes and anywhere a version is shown **inside the CRM**.
The public marketing pages (`Landing Page.dc.html`, `About.dc.html`,
`SMS Terms.dc.html`, `Privacy Policy.dc.html`) carry **no build version** —
decided 15 Sep 2026.

## Schema drift

`db/tenant.sql` creates a new shop's database; the numbered migrations are then
replayed over it. The two drift, and that is expected — but two rules follow:

- **Write new tenant migrations one `ADD COLUMN` per statement.** A multi-clause
  `ALTER TABLE` is atomic, so one already-present column discards its siblings.
  That is what broke shop creation on 15 Sep 2026 (`documents.thumb_key`).
  `src/db/alter.ts` now recovers from it per clause, but do not rely on that.
- **`npm run schema-audit`** diffs every shop database against `tenant.sql` and
  `-- --go` adds what is missing. `npm run migrate` cannot fix this class: a
  shop provisioned from a drifted base is recorded at the latest version while
  missing a column. Run the audit after any provisioning change.
- **Any migration that seeds ROWS must use `ON DUPLICATE KEY UPDATE` or
  `INSERT IGNORE`.** Provisioning replays migrations and then seeds the
  shop-type template over the top, so a migration that seeded data with a plain
  INSERT collides with the template — that is what broke shop creation a second
  time on 15 Sep 2026 (the `sublet` lane). The seed now upserts and the template
  wins. Test a provision of all three shop types after touching either side.

## Web funnels

Built 17 Sep 2026. A booking form the shop pastes into its **own** website
(`web/f.js`), feeding Leads and the scheduler. Not the Zapier/Meta work — those
are queued separately and must not be waited on.

- **The public key is public.** It sits in HTML anybody can read and authorises
  nothing. `funnel_domains` — the per-shop Origin allowlist — is the actual
  gate. Never add anything that trusts the key alone.
- **`/api/f/*` is exempt from the CSRF origin check** in
  `src/middleware/security.ts`, because a foreign Origin is the point. It is
  safe only because those routes have a stricter check of their own and read no
  cookie. A request with **no Origin is refused** there — the opposite of the
  app's rule, deliberately.
- **`funnel_hours` narrows, never widens.** Every window is an intersection
  with the shop's real hours, clamped at read time, so changing shop hours can
  never leave the public being offered more than the shop is open.
- **A held drop-off owns a real `appointments` row** from submission. That is
  what makes it count against the day limit and what makes declining or lapsing
  release it. Do not reimplement holds as a separate capacity notion.
- **Public and desk share one day limit**, which is why `notice_hours` exists.
- An **unsubscribed address is carried, not refused** — check-in's rule. The
  form then promises a call rather than an email, and never says why.
- **Both accent and ink are the owner's**, warn-and-allow on contrast. The
  acceptance is an `audit_log` row and is mentioned nowhere else — no banner,
  nothing on the form, nothing to the customer.
- `f.js` must keep surviving WordPress and HighLevel: moved script tag, missing
  target at run time, double include, late injection, one global only.

## TCPA consent

Built 17 Sep 2026, the day after the booking form, because the form was
collecting phone numbers against no disclosure. `consents` is the record;
`lib/consent.ts:mayContact` is the only gate.

- **Two kinds and they are not interchangeable.** `marketing` is the ticked
  box — express, revocable, and **never required**, because TCPA does not let
  consent be a condition of the sale and the shop's own wording says so.
  `transactional` is implied by booking and covers **that car until it is
  delivered**, nothing more. Do not widen it.
- **`wording_shown` is copied onto every row, never referenced.** The shop
  rewords the disclosure over time; a reference would follow the edit and make
  the record describe something the customer never saw.
- **The wording is read server-side.** Never trust a disclosure posted in the
  request body. The browser is trusted only for whether the box was ticked.
- **A decline is recorded.** "Asked and said no" is not "never asked".
- **Rows are never deleted or edited** — revoking sets `revoked_at`.
- **STOP and unsubscribe revoke consent**, through `suppress()`. One record,
  both directions.
- **Consent and suppression are different questions** and both must pass.
- **The booking form will not switch on** until the shop's wording saves, which
  checks loosely for STOP, HELP, rates and not-a-condition. Not overridable.
- **The desk gets a mark, not a block.** SMS is unbuilt; this is what it will
  inherit.
- **The shop is the responsible party off the web form.** Decided 18 Sep 2026.
  Twilio campaigns are registered on the shop's own information, wording and
  privacy/TOS, so a shop that contacts somebody it should not have is answering
  for that itself. We do not chase consent capture into check-in, counter leads,
  the sales app or EMS imports — that is deliberately closed, not a gap.
- **What we do add instead**: a *text message updates* toggle, **shop-side only**,
  in all three places a car gets written — check-in (the desk's side of it, not
  the customer's page), the sales app, and a **new RO off the desktop board**.
  It is the shop confirming the customer agreed, never a box the customer ticks.
  Turning it on writes an ordinary `consents` row the same way the web form
  does; only `captured_by` differs by screen. Every message sent under it
  carries a short STOP line, and STOP revokes through `suppress()` like
  everywhere else. Mocked in `Text Updates Consent.dc.html`.

## Internal notes

Built 18 Sep 2026, on top of tagging. A note whose first two characters are
`#` and a **space** is internal (`ro_notes.internal`). Detected server-side in
`POST /api/ro/:id/notes` and in the note that rides along with a status change —
both, or the flag would mean two things in two boxes.

- **The space is load-bearing.** `# call the owner` is internal; `#1204 came in`
  is an RO number and an ordinary note. Do not loosen this to a bare `#`.
- **The hash stays in the stored text.** It is how the note reads as internal to
  the people who can see it, and the drawer draws those with a dashed edge.
- **Who can read one: the `internal_notes` capability, the author, or anybody
  tagged in that one note.** The tag is the grant, and it grants that note only
  — there is no wider "shared with" notion and none should be added.
- **Everybody else is shown nothing at all.** No placeholder, no count, no gap.
  The rows never leave the server. A greyed "1 hidden note" line tells the floor
  exactly what it was not meant to know.
- **A tag on an internal note is in-app only** (`notify({appOnly})`). An email
  would put restricted text in an inbox, outside every check that restricted it.
- Writing one still clears your own red mark — writing is answering, whatever
  the note's audience.
- Seeded to owner, accounting, and roles already holding `admin` or `perms`.
  Deliberately **not** estimator or front office: the shop ticks it outward
  itself.

**Note export** is `GET /api/ro/:id/notes.txt` — one file, oldest first, plain
text in the browser to select and copy. **Internal notes are never in it**,
whoever exports and whatever they can read on screen: a flat block of text gets
forwarded and nothing about it can enforce who reads it next. It does not say
how many were withheld, for the same reason there is no placeholder. Every
export writes an `audit_log` row through `audit` (not `auditRead`, which folds
repeats within the hour — right for opening a screen, wrong for taking a copy).

## Tech flags and the pay week

Rebuilt 30 Sep 2026 (migration 035). **The flag date is the only thing that
decides which payroll week a flag pays on** — not Vehicle Ready, not Picked Up,
not the close. The flag modal takes a date (today by default, never the future)
so old files can be put right; flagging works on closed files too and
re-settles their profit.

- **Payroll reads `ro_flag_entries`, not `ro_labour`.** `ro_labour` is the figure
  a trade stands at; the entries are each change to it, dated. A week pays the
  sum of the entries whose `counts_at` falls in it. All of it goes through
  `lib/flags.ts:syncFlagLedger`.
- **Partial flag** is a per-trade checkbox. It pays what is entered now; flagging
  the rest later (or closing) pays only the difference, on that week.
- **A re-save never moves a flag.** A row keeps its date unless its figure
  changes or a different date is given. Re-stamping every row on save is what
  used to drag last week's flags into this week.
- **A typed date in a paid week is refused**; an automatic one (close, or today
  after the week was paid) rolls to the next open week. Paid weeks are never
  rewritten.
- The migration backfilled paid runs and open flags. It **does not claw back**
  a trade that was paid more than it now stands at — that is left for a person.

## Shop hours and closures

Built 15 Sep 2026. `shop_hours` is the ordinary week (one row per weekday, 0 =
Sunday); `shop_closures` is the dated exception list, where `kind = 'hours'`
is a half day. All of it goes through `src/lib/shophours.ts` — do not compute
working time in SQL, because elapsed working hours means walking the days and
summing each open window, and a `TIMESTAMPDIFF` cannot do it.

- **Holiday dates are computed** (`src/lib/holidays.ts`), never stored. What is
  stored is which holidays a shop observes, keyed by name so it survives into
  next year.
- **`source` separates holiday rows from manual ones.** Un-ticking a holiday
  must never delete a date somebody typed themselves.
- Everything is in the **shop's** timezone, off the company record.
- The scheduler warns-and-overrides on a time outside hours rather than
  refusing outright, and records the override on the appointment.

## Mail

Resend, over HTTPS. **`RESEND_API_KEY` must be in `/srv/easyshop/.env`** — it
was missing until 16 Sep 2026 and nothing had ever sent, because the key was
never documented in `.env.example`. The server now logs `MAIL IS OFF` at boot
when it is absent; do not remove that. `MAIL_FROM` must be on a Resend-verified
domain. `DEMO_TO` is where the marketing site's demo requests land and is
deliberately not `MAIL_REPLY_TO`.

## Text messaging

Built 1 Oct 2026, a0.7.3. **Each shop's own Twilio account** (`company_sms` in
master), set in platform admin. The Auth Token is sealed under
`CREDENTIALS_KEY` and never sent back to a screen — do not add a "show token".
`lib/sms.ts:sendSms` is the only way a text leaves, and it runs feature,
verified account, suppression and `mayContact`, in that order; do not add a
second sender. Twilio's webhooks are authorised by signature alone, against
that shop's token — never accept one unsigned.

- **Status texts bind to slot ids and lane keys** (`lib/sms-status.ts`), never
  labels. Once per file per update; a refused send counts. Quiet when the
  shop's texting is off — do not log refusals for a shop without SMS.
- **The wording is the shop's** (`sms_templates`). The STOP line is appended by
  the sender and refused in the editor. Seeds are INSERT IGNORE.
- **A reply goes to the file**, then to the people in `sms_reply_routing`, and
  only them (`notify({ onlyDirect })`). File owner = the estimator on the file,
  else whoever opened it.
- **Phone numbers are ten digits** in `consents`, `suppressions` and
  `sms_messages`. Both `normalise()`s drop a leading 1.

## Locations and tax

Built 1 Oct 2026, a0.8.0. A location is a company with `group_id`; the group
holds the parent, the combined-reports grants and nothing else. **Nothing is
read across databases at run time except a granted report**, and that read is
audited in the shop that was read. A new location gets *copies* of the parent's
roles, permissions, routing and settings at creation and owns them afterwards —
do not add syncing. Seats are per location; a grant takes none.
Sales tax is per shop: rate plus what it applies to (`lib/tax.ts`). Texas is
parts and materials, not labor. Every reader of tax goes through `taxOn`.

## Added statuses

Built 2 Oct 2026, a0.8.1 (`lib/statuses.ts`, tenant 038). Admin adds from the
shop; platform support adds for **one shop only**.

- **Hidden, never deleted** — added or built-in. A file's history points at the slot.
- **Slot ids are made once**: `lane.<key>.x.<slug>` in a lane, `x.<slug>` elsewhere.
  Keep the `lane.<key>.` prefix — `laneKeyForSlot` reads it.
- **Its text is off until the shop switches it on**, because of the 4–8 a vehicle
  in the SMS terms. Bound by `sms_templates.slot_id`, not `SLOT_TRIGGER`.
- **Copied to a location only at the time it is added**, only where the person is
  an admin there. No syncing afterwards — same rule as locations.

## External invoices

Built 2 Oct 2026, a0.8.2 (`lib/extinvoices.ts`, master 012, tenant 039). Reads a
shop's own invoicing tool database hourly for generated / sent / paid.

- **Read-only, always.** Never add a write to that database — it is the shop's
  live invoicing system, hosted elsewhere.
- **One shop per connection**, its own company id in the tool. Locations get their
  own; nothing is read across the group.
- **Feature `extinv` is off by default** and switched on per shop by platform. The
  owner may set the connection once it is on.
- A manual tie (`match_how = 'manual'`) is never moved by a later read.

## Retention

Decided 30 Aug 2026: a closed file is kept forever as a record; personal data has
a **ten-year** outer limit; files drop to **archival at one year**. Implemented in
`server/src/jobs/retention.ts`, and **dry-run until `RETENTION_ENABLED=1`** is set.
The accounting shell (RO number, dates, amounts, labour) is never purged — it is
the shop's business record. Wholesale and insurance clients are never purged.

## Database logins

Each shop has its own database (`es_<slug>`) — always has. Since a0.2.7 each also
has its own MariaDB login (`es_t<id>`), read/write only, scoped to that one
database. Passwords are **derived** from `TENANT_MASTER_SECRET`, never stored.
Migrations run on the admin connection, which is why tenant logins have no DDL
rights. A row whose `secret_ref` is `DERIVED` fails loudly if the secret is
missing — do not add a fallback to the shared login.

## Known and deliberate

- **`checkin.html` is held to WCAG 2.1 AA and the rest of the app is not.** It is
  the only page a shop's *customers* touch, so it is the only Title III surface.
  Internal pages are an employment/accommodation question. Do not "tidy" the
  accessibility markup out of check-in, and do not assume it applies elsewhere.
- **The web-funnel form inherits that standard**, for the same reason — decided
  17 Sep 2026. It is a public page on the shop's own domain, filled in by
  customers, so it is a Title III surface and check-in's rule applies to it:
  4.5:1 on every label and helper line, not just the body copy. The muted ink of
  the *shop's* own site is usually not good enough — `#8a8178` on paper reads
  3.66:1 and was caught at exactly that, on labels at 10.5px. The desk screens
  behind it (the request queue, the settings, the lead) are internal and are not
  held to it.
  Two things follow from the form being public:
  - **Nothing on it explains its own defences.** The honeypot is never described
    in the markup or the copy. A line telling the customer there is a hidden
    field a robot fills in tells the robot too.
  - **It renders inline into the shop's own div**, so it inherits their fonts and
    colours. Nothing in it may assume a width — the column belongs to their
    layout, and fixed-width controls wrap into nonsense at the first breakpoint
    we never see.
- **Inside the CRM, only strictly necessary cookies are used** (`es_sid`), and
  there is still no analytics of any kind on a shop's own screens. No banner is
  shown there because none is required. Do not add measurement to the
  application without raising it first — a shop's screens are not measured.
- **The marketing pages carry Google Tag Manager (`GTM-T5BC9MZ6`), and it is
  opt-IN.** Added 15 Sep 2026, which reversed the earlier "these pages set
  nothing" position. Four things must stay true:
  - `web/consent.js` is the *only* thing that loads GTM. It does not load until
    somebody clicks Allow. Consent Mode defaults are set to denied before
    anything else runs, so a tag added in the GTM web UI later still cannot fire
    without consent. Do not paste Google's raw snippet into a page — that is
    what the file exists to prevent.
  - **Global Privacy Control is honoured without asking**, because
    `privacy.html` promises it. A GPC browser never sees the banner.
  - The choice lives in `localStorage` under `es_consent`, not a cookie.
  - Decline is one click and the same size as Allow.
  - CSP is widened for Google's hosts **on the public pages only**
    (`src/middleware/security.ts`). The CRM must never inherit that.
- `terms.html` is the **website** terms of use, not the shop service agreement.
  Its load-bearing clause is that the site is marketing material and the shop's
  signed agreement governs where the two differ. Governing law Texas, venue
  Collin County.
- **`sales.html` is mobile-only.** Decided 12 Sep 2026. Above 900px the screen is
  replaced by a line saying it is a phone screen and where to go instead — Leads
  and the board carry everything a lead becomes. The cut is width, not user
  agent, so a small window gets the real screen. Do not re-add a desktop layout
  for the write-one form.

## Unsubscribe and STOP

One suppression list, two channels, built a0.6.0. Four decisions that must not
be quietly reversed:

- **Per shop** (`suppressions` in each tenant DB); **platform-wide only for hard
  bounces and complaints** (`platform_suppressions` in master).
- **No transactional exemption.** An unsubscribed address gets no password reset
  either. A person in that state needs an owner to set their password, or has to
  re-subscribe first. Do not add a carve-out for "important" mail.
- **Re-subscribing is the customer's**, through `unsubscribe.html` on a signed
  link they hold. There is deliberately no desk route to it.
- **Keyed on the destination, never a `clients.id`** — otherwise editing a
  client or re-importing an estimate un-blocks the address.

The check lives in `sendMail` (`src/lib/mail.ts`) and nowhere else. A refused
send is state `suppressed`, not `failed`; nothing may retry it.

`checkin.html`, a lead conversion and an EMS import deliberately **carry** an
unsubscribed address rather than refusing it, and write a `suppression_hits`
row. The desk screens refuse it. Both behaviours are intentional — see
SERVER-NOTES.

## Invoicing
Being ported from the separate PHP app (`uploads/`, hosted elsewhere, still live).
Decisions are recorded in `QUEUE.md`. Wholesale input is **one text field with
shortcuts** — not a line grid. Read `uploads/app.js` for how input actually works
before building any of it.

## Working notes

- `server/` is the real application. `*.dc.html` at the project root are mockups.
- **An RO number is the last six of the VIN** — in the app and in every mockup.
  Never invent a sequential RO number (`RO 1207`) in sample data.
- **The marketing site ships from `server/web`, not from the mockups.**
  `index.html` is the landing page, `about.html`, `privacy.html` and
  `sms-terms.html` alongside it, styled by `site.css`. The root-level
  `Landing Page.dc.html`, `About.dc.html`, `SMS Terms.dc.html` and
  `Privacy Policy.dc.html` are where the design was worked out — edit the
  shipped copies or the two will drift.
- **The CRM sign-in is `signin.html`**, not `/`. Moved 15 Sep 2026 so the
  landing page could own the root. Everything that redirects to sign-in points
  there.
- **Only the marketing pages are indexable.** `src/middleware/security.ts` holds
  an explicit allowlist; everything else is served `noindex`. `checkin.html` and
  `unsubscribe.html` are public but deliberately cloaked. Keep `robots.txt` in
  step with the allowlist — the header is what enforces it.
- **`easyshopauto.com` is hard-coded** in canonical/OG/sitemap URLs.
- **`npm run indexnow`** pushes changed URLs to Bing and the other IndexNow
  participants after a deploy; ownership is the `<32-hex>.txt` file in `web/`.
  **Google does not participate in IndexNow** — it finds changes from the
  sitemap, so anything claiming to push instantly to Google is wrong.
- `server/web/*` is served straight off disk — no build, no restart, just the file
  and a hard refresh. Anything under `server/src/` needs
  `npm run build && sudo systemctl restart easyshop`.
- `QUEUE.md` holds queued work and decisions; `SERVER-NOTES.md` is the build
  receipt per shipped item.
