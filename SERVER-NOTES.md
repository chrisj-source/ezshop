# a0.8.2 — external invoices — 2 Oct 2026

**The shop's own invoicing database, read hourly.** For Extreme Hail & Collision;
behind a new feature, **External invoices** (`extinv`, master 012), off for every
shop until platform switches it on. Set from platform admin → the shop →
*Invoicing database*, or by the shop's owner in Admin → Shop settings →
*Invoicing database*. A location has its own connection.

- **Read-only.** Only SELECTs; the session is also `SET SESSION TRANSACTION READ
  ONLY`. Give the login SELECT on `invoices`, `payments`, `clients`, `profiles`,
  `companies` and nothing else, and allow it from this server's IP.
- **Password sealed** under `CREDENTIALS_KEY`, never sent back to a screen.
- **What is read** (`lib/extinvoices.ts`), one company id inside the tool:
  generated = `invoices.created_at`; sent = `invoices.sent_at` (the tool's
  `migrate-2026-08e-sent.sql`, marked by hand in its drawer); paid =
  `status = 'paid'`, dated by the last `payments.received_at`. Void is kept and
  never counts. Incremental on `updated_at` with two days' margin; first read is
  everything. Saved to tenant `external_invoices` (039).
- **Tied to a file** by full VIN, else last six of VIN / stock / number against
  the RO number, a supplement's `-2` dropped. A tie made by hand in the drawer
  is `manual` and no read moves it.
- **Shown**: board row mark (Invoiced / Inv sent / Paid — the least-advanced live
  invoice on the file), drawer *Invoices* section (three dates per invoice,
  amounts with the money capability, tie by number), closed files under the
  CRM's own Paid tag. The CRM's payments are untouched; the two are side by side.
- The test on save says whether that copy of the tool has `sent_at` yet.

Deploy: `npm run migrate` (master 012, tenant 039), then build and restart.
Switch *External invoices* on for EHC under Features, then set the connection.

# a0.8.1 — adding statuses — 2 Oct 2026

**Admin → Statuses → + Add status** on any group (needs `admin`). Name, customer
name, kind, owner role, clocks, counts-to-cycle. A lane group asks which lane;
the status takes that lane's module, so switching the lane off takes it off the
board too. Lands at the end of its group, shown. Tenant 038:
`statuses.is_custom`, `created_by`, `created_at`, `sms_templates.slot_id`.

**Slot ids are made once and never change**: `lane.<key>.x.<slug>` inside a lane
(so `laneKeyForSlot` still reads it), `x.<slug>` elsewhere, `_2`… on a clash.
**Never deleted, only hidden** — built-in or added — because history points at
the slot.

**Drag to reorder** any status within its group (`PUT /api/config/statuses/order`).

**Each added status gets its own text**, row in `sms_templates` bound by
`slot_id`, wording seeded from the customer name, **off**. Listed under Text
updates after the built-ins. Switched on, it wins over the lane update on entry
to that status; switched off, the lane update still goes. Renaming the status
renames its text's label.

**Locations**: the add form lists the other shops in the group *where this
person is an admin* (`capsAt` in `middleware/context.ts`, re-checked on the
server). Ticked ones get a copy at the time, same slot id where free; a copy
that does not fit (no such group, lane not there, name taken) is reported and
skipped. No syncing afterwards.

**Platform admin → a shop → Statuses**: support adds one for that shop only
(`POST /api/platform/companies/:id/statuses`), written to `platform_audit` and
the shop's `audit_log` as "(Easy Shop support)". Reorder, hide and wording stay
the shop's, from Admin.

**Same-day in and out.** The file's date edit (`PATCH` dates in `routes/ro.ts`)
compared instants, and the drawer sends completed/picked up as a plain date,
read as midnight — so a car in at 10:30 and out the same day was refused as
"before the date in". Now compared by calendar day in the shop's timezone; a
same-day plain date is stamped no earlier than the date in, so cycle time cannot
go negative.

**EMS import takes several estimates in one drop.** `POST /api/ems/upload`
splits the files by base name (`lib/ems.ts:splitSets`, CCC's `-hash`
duplicates folded in) and parses and imports each set on its own — one
`ems_imports` row, one stored folder, one notification each. Before this every
file went to one parse, which took the first .env/.veh/.ad1 it met and mixed
vehicles into one import. The extension allowlist is checked across the whole
drop before anything is stored. One set still opens straight into review; several
are listed as pending with a line saying how many, and any that could not be read
are named. The response keeps `importId`/`estimate`/`match` when there was one
set, and adds `results[]`.

Deploy: `npm run migrate`, then `npm run build && sudo systemctl restart easyshop`.
`/api/config` selects `is_custom`, so the migration must run first.

# a0.8.0 — status texts, customer communication, locations, sales tax — 1 Oct 2026

**Status update texts.** Admin → *Text updates*: 18 updates, wording ours by
default and the shop's to edit (tenant 037, `sms_templates`, INSERT IGNORE so a
replay never resets wording). Seven on by default; lane updates written but off
(the 4–8 per vehicle in the SMS terms). Bound to slot ids and lane keys in
`lib/sms-status.ts`, fired from `POST /api/ro/:id/status` without being
awaited. Once per file per update (Supplement Needed each time); a refused send
counts. Estimate Sent only before the first approval, Supplement Needed only
after it, Approved only the first time. Quiet when texting is off — no refused
rows on shops without SMS. Length shown per message with the STOP line.

**Customer communication** at the bottom of the file drawer (needs the
customer-contact capability): automatic, desk and inbound texts in one thread,
refusals shown with their reason, a send box when consent allows, a note when
the number replied STOP. Where there is no consent, the shop-side *Text message
updates* confirmation from the 18 Sep decision is offered here — it writes a
transactional `consents` row for that car, `source = 'desk'`, wording copied.

**Replies** land on the file: the open file whose customer has the number, else
the file our last text was about, else no file (Front office is told). Notified
in-app to the targets in Admin → Text updates; defaults file owner (estimator
on the file, else whoever opened it), front office, production manager, owner.
Email follows each person's own setting. `notify({ onlyDirect })` skips the
groups for this event.

**Phone numbers are now ten digits everywhere** — `normalise()` in consent and
suppression drops a leading 1 from an 11-digit number, so Twilio's +1… and a
typed (972) … are one row. A consent or suppression stored as 11 digits before
this will not match; check with
`SELECT destination FROM consents WHERE LENGTH(destination) = 11`.

**Sales tax per shop** (`lib/tax.ts`, Admin → Shop settings → Sales tax): rate
and what it applies to — parts, paint and materials, labor, sublet. Unsaved
shops get their state's preset: **TX parts + materials**, AR and KS everything,
others everything. Used by sales pay's tax deduction (`lib/pay.ts`,
`lib/profit.ts`), which charged the whole approval before. **A Texas shop's
sales pay goes up** on the next reconcile of each file, because less tax comes
off. Nothing else read the rate.

**Locations** (master 011): `company_groups`, `companies.group_id`,
`group_report_grants`. Platform → shop → *Locations* → Create the location:
provisioned on the Additional location plan, joined to the group, the parent's
owner carried across, and copies of the parent's roles + permissions, status
notification grid, reply routing and shop settings (not address/phone). Ticked
people come with roles, trades and pay setup, a seat each. Admin → Shop settings
→ Locations: at the parent, the read-only bill and the combined-reports grants;
anywhere, *Add people from another location*. Reports take `?shop=` for a
location the person is granted; the read is audited in the shop read.

**Not built yet**: reports for *all* locations at once (one location at a time
only), vendors shared across the group, the group web form. Drill-down links in
a report read from another location open this shop's board.

Files: `db/migrations/tenant/036_sms_messages.sql` (rewritten — not yet
deployed), `037_sms_templates.sql`, `db/migrations/master/011_locations.sql`,
`src/lib/sms.ts`, `src/lib/sms-status.ts`, `src/lib/tax.ts`,
`src/lib/locations.ts`, `src/lib/consent.ts`, `src/lib/suppression.ts`,
`src/lib/pay.ts`, `src/lib/profit.ts`, `src/notify.ts`, `src/routes/sms.ts`,
`src/routes/locations.ts`, `src/routes/reports.ts`, `src/routes/ro.ts`,
`src/server.ts`, `web/board.html`, `web/admin.html`, `web/platform.html`,
`web/reports.html`.

# a0.7.3 — per-shop Twilio accounts, texting switch — 1 Oct 2026

**Each shop brings its own Twilio account.** Platform admin → shop → *Text
messaging*: Account SID, Auth Token, then **Save and verify**. Verify calls
Twilio, lists the account's numbers and Messaging Services, and the sender is
picked from that list (a Messaging Service is what a 10DLC campaign hangs on).
The token is sealed with AES-256-GCM under **`CREDENTIALS_KEY`** (new, required
— the server logs `TEXTING IS OFF` at boot without it) and never returned; the
screen shows its last four. Master migration 010 (`company_sms`), tenant 036
(`sms_messages`).

**SMS customer updates** is now available under Features, default off, and
refuses to switch on until the account is verified with a sender. Removing the
account switches it off.

**`lib/sms.ts:sendSms` is the only way out.** Gates, in order: feature on,
account verified, not suppressed, `mayContact` for the purpose. A refusal is a
row in `sms_messages` with its reason. The STOP line is appended by the sender.
Twilio 21610 (already opted out at Twilio) suppresses here too. *Send a test*
skips consent, never suppression.

**Webhooks**: `/api/sms/twilio/inbound/:companyId` and `/status/:companyId`.
Public, form-encoded, refused unless `X-Twilio-Signature` checks against that
shop's token (computed over `APP_URL` + path, so APP_URL must be the public
https URL). STOP words revoke through `suppress()`; START/UNSTOP release — the
customer's own act from their own phone. Replies to STOP/START/HELP are left to
Twilio's Advanced Opt-Out. The inbound URL is shown on the platform screen to
paste into Twilio.

**Not built**: nothing sends automatically yet. Status-change texts need the
per-status wording (QUEUE, *Twilio SMS*), and inbound replies are stored but
not yet matched to a file or notified (`sms.reply`).

Files: `db/migrations/master/010_sms_accounts.sql`,
`db/migrations/tenant/036_sms_messages.sql`, `src/lib/secretbox.ts`,
`src/lib/sms.ts`, `src/routes/sms.ts`, `src/routes/platform.ts`,
`src/server.ts`, `src/config.ts`, `.env.example`, `web/platform.html`.

# a0.7.2 — billing: plans, seat blocks, seat warning — 1 Oct 2026

**Platform admin could not change a shop's plan.** The PATCH accepted
`planCode` but the Account section only displayed it, and the create form never
sent one, so every shop landed on the default. Plan and *extra seat blocks* are
now editable on create and on the shop's Account section, with seats used and
the monthly figure beside them.

**New price list** (master migration 009): Shop $299.99 with 5 seats,
Additional location $99.99 with 5 seats, extra seats in blocks of 5 at $49.99
(`lib/billing.ts`). Starter / Growth / Multi-shop are retired; shops on them
moved to Shop with enough blocks to keep their seat count — review each before
invoicing. `companies.seats` is derived (plan + 5 × blocks) and written only by
`setBilling`; a typed seat count is no longer accepted.

**Out of seats warns, never refuses.** `POST /api/admin/people` adds the person
and returns `seatWarning`; `/api/config/people` returns `seats` to admins so
the Add sheet says so before saving.

Files: `db/migrations/master/009_billing.sql`, `src/lib/billing.ts`,
`src/routes/platform.ts`, `src/routes/admin.ts`, `src/routes/config.ts`,
`src/db/provision.ts`, `src/lib/demo.ts`, `src/scripts/bootstrap.ts`,
`web/platform.html`, `web/admin.html`.

# a0.7.1 — board search, close-out backlog, vendors, EMS numbering — 28 Sep 2026

**Board search could not find picked-up cars.** A car at Picked Up that is not
closed out was hidden unticked (gone rule), with Closed (only closed files were
loaded, and the gone rule still applied) and with Complete (completeSlots works
by board position from Vehicle Ready, and this shop's Picked Up does not sort
after it). 71 files at Extreme Hail DFW. Complete now unions goneSlots; a typed
search skips the stage rules; `?closed=1` returns open plus 90 days of closed;
`GET /api/board/find?q=` searches every file (RO, VIN, plate, claim; tech scope
kept) and the board lists matches not on screen. New *Awaiting close-out*
checkbox with its count.

**Vendors.** Retire was a staged toggle that only saved on *Save vendors*; it
now saves on the tap. `DELETE /api/vendors/:id` sets `deleted_at` (034) and
hides the vendor everywhere; the row stays so old part lines keep the name.
Refused while lines are ordered/partial/backordered with them.

**EMS import.** Create-new used the estimate's RO_ID and attached to any file
already holding that number, closed ones included. Now: last six of the VIN,
refused by name if taken, refused with no VIN. Matching and candidates drop any
file whose VIN disagrees; only a full-VIN hit is preselected; no keys returns
no candidates instead of every open file.

# TCPA consent on the booking form — 17 Sep 2026

The booking form shipped this morning collecting a phone number and promising
contact, with nothing recording that the customer had agreed to it. This is
that record.

## Two kinds, and they are not the same thing

Everything here turns on the distinction, and conflating them is what the
schema exists to prevent.

**Marketing** consent is the ticked box. Express, written, revocable — and
under TCPA it **cannot be a condition of the sale**. So the box is unticked by
default and the booking goes through either way. That is not caution: the
shop's own disclosure says *"Consent is not a condition of purchase"*, and a
required box would make that sentence a lie on the shop's own website. The
first draft of this asked for exactly that, and the wording caught it.

**Transactional** consent is implied by the act of booking, and is narrow:
messages about the car they just booked, and **nothing after it is delivered**.
Written down as its own row rather than assumed, so *why did we text this
person* always has an answer. A transactional consent that outlived the repair
would quietly become a standing permission nobody granted.

Both are recorded on submission. A **decline is recorded too** — "we asked and
they said no" is a different fact from "nobody ever asked", and only one of
them means somebody should ring instead.

## `wording_shown` is the load-bearing column

"They ticked a box" is worth very little. What matters is what the box **said**
at the time, and a shop will reword it over the years.

So the full disclosure text is **copied onto every consent row**, not
referenced. A reference would follow the edit and the record would then
describe something the customer never saw.

Also stored per row: timestamp, IP, user agent, the page URL, which boxes were
ticked, and a JSON copy of the whole submission — so the record stands alone
after the lead is edited, converted, or purged under retention.

The wording is read **server-side from the database**, never taken from the
request body. A client that posts its own disclosure text could otherwise claim
the customer agreed to anything. The browser is trusted for exactly one thing:
whether the box was ticked.

## The shop writes it

Their liability, their words, their shop name in it — which is the main reason
it cannot be ours.

It ships as a **draft with the name blanked** (`______`) and the route refuses
to save it with the blank still in. A genuinely empty box would have been the
other answer, and it is the wrong one: a shop guessing which four phrases we
want, rejected six times, decides the feature is broken. The draft already
contains all four.

Checked **loosely** on save — the four ideas have to be present, any phrasing:

- a way to opt out (must contain STOP; that is the word the carriers act on)
- a way to get help (HELP)
- that message and data rates may apply
- that consent is not a condition of purchase

"Text STOP to quit" passes. "Opt out any time" does not. Refusing anything that
does not match a template would only teach shops to paste words they have not
read.

**The form will not switch on until it passes.** That is the one hard gate
here, and it is not overridable — a shop that turned booking on without going
near the consent tab would be collecting phone numbers against no disclosure at
all, which is the gap that raised this. Switching the form *off* is never
blocked.

## Privacy and terms are the shop's

Their URLs, entered in Admin, validated as real `https://` addresses and
rendered as links on the form. The form sits on their website collecting for
them — they are the controller, so they are the one who has to have said what
they do with it. Easy Shop is named as the processor.

## STOP and unsubscribe revoke consent

One record, both directions. `suppress()` in `lib/suppression.ts` now calls
`revokeConsent()`.

Keeping them apart would have meant a suppression list that stops sending while
the consent table still says the person agreed — and the consent table is the
thing that would be produced if it were ever disputed. Somebody who has said
stop has withdrawn consent; those are not two facts.

The row is marked `revoked_at`, never deleted. What was true in March is still
true about March.

## The gate

`mayContact(companyId, channel, destination, purpose, roId)` in
`lib/consent.ts`, and nowhere else — the same shape as `sendMail` being the
only place the suppression list is checked. A caller that asks its own question
is a caller that gets a different answer from everybody else.

It answers separately for marketing and for a message about a particular car,
and the transactional path checks `delivered_at`/`closed_at` **at read time**
rather than waiting for a sweeper, so a file delivered a minute ago is already
out of scope.

**Consent and suppression are different questions.** Both have to pass. A
person can be in one state and not the other.

## What the desk sees

A mark and a reason, deliberately **not a block**. SMS is not built; when it is,
this is what it inherits. Meanwhile the honest thing is to tell whoever has the
file open that the number cannot be texted and let them ring.

- **Leads › Web requests** — on the row, with the narrow-scope caveat spelled out
- **The file drawer** — `consent` on the `/api/ro/:id` payload

The delivered-file case is worth knowing about: a car that was textable during
the repair shows the mark once it has gone, because that is what the consent
covered.

## Files

- `server/db/migrations/tenant/032_tcpa_consent.sql` — `consents`,
  `funnel_consent`, `funnel_requests.sms_consent` / `consent_id`
- `server/db/tenant.sql` — the same, for a new shop
- `server/src/lib/consent.ts` — the gate, the wording check, recording, revoking
- `server/src/lib/suppression.ts` — STOP/unsubscribe revokes consent
- `server/src/routes/funnel.ts` — the consent block on `/api/f/config`, two
  records written on submission
- `server/src/routes/funnel-admin.ts` — `PUT /api/web-form/consent`, and the
  gate on switching the form on
- `server/src/routes/ro.ts` — the mark on the file
- `server/web/f.js` — the checkbox, the disclosure, the two links
- `server/web/admin.html` — the consent editor and what is missing from it
- `server/web/leads.html` — the mark on a request row

`npm run build && npm run migrate && sudo systemctl restart easyshop`, then
`npm run schema-audit`.

**Any shop already running the booking form will find it refuses to stay live
until its consent wording is saved.** That is deliberate, and it is one screen.

## Still open

- **Nobody legal has read this.** The checks are a reasonable reading of TCPA
  and the wording came from the shop, not from counsel. Worth an hour of a
  lawyer's time before a second shop is onboarded.
- **Consent is only captured on the web form.** Check-in, a counter lead, the
  sales app and an EMS import all take phone numbers and none of them asks.
  That was the decision on 17 Sep 2026 and it is the right first step, but the
  moment SMS ships it becomes the obvious gap.
- **Email is modelled but not asked for.** The `consents` table carries a
  `channel`, and only `sms` rows are written. Booking confirmations ride on
  the transactional footing and the suppression list.
- **No desk route to record consent** given over the phone, which is how a shop
  will actually get most of it.

# Web funnels — a booking form on the shop's own website — 17 Sep 2026

A form the shop pastes into its own site. A customer picks a real time and it
lands in Leads with the appointment attached. Decisions are in QUEUE.md; this
is what shipped.

## The shape of it

Three parts, and the split matters:

- **`web/f.js`** — the snippet. Renders INLINE into the shop's own div, so it
  takes their fonts and colours. Not an iframe: a form that arrives in our
  styling on somebody else's page looks bolted on and converts worse.
- **`/api/f/*`** — public, cross-origin, unauthenticated by necessity. The
  person filling it in is a stranger with no account.
- **Admin › Web form** and **Leads › Web requests** — the desk half, behind
  sign-in.

## The security model, because it is not a session

The key is PUBLIC. It sits in HTML anybody can read, and it authorises nothing.
Three things stand in for a session:

1. **The public key** (`funnel_keys`, MASTER database) says which shop. It has
   to be in master: the snippet posts a key and nothing else, so there is no
   tenant database to look in until it resolves.
2. **The domain allowlist** (`funnel_domains`, per shop) says whether this page
   may speak for that shop. **This is the actual gate** — it is what makes a
   scraped key worthless somewhere else.
3. A honeypot and a per-IP limit keep the volume honest.

Two deliberate inversions of the app's own rules:

- `originOk` in `middleware/security.ts` **exempts `/api/f/`** from the CSRF
  origin check. A foreign Origin is the whole point here. The exemption is safe
  because these routes have a *stricter* check of their own and read no cookie
  — the snippet sends `credentials: 'omit'`.
- A request with **no Origin at all is refused**, which is the opposite of the
  app's rule. There, a missing Origin means curl and the cookie does the work.
  Here there is no cookie, the caller is always a browser on a page, and a
  browser always sends one cross-origin.

`cross-origin-resource-policy` is widened to `cross-origin` **for `/f.js`
only**, by exact path match rather than a prefix — a prefix is how a folder of
internal scripts ends up loadable from anybody's website a year from now.

## Availability: narrower, never wider

`funnel_hours` does not grant time, it removes it. Every window in
`lib/funnel.ts` is an **intersection** with the shop's real hours, so a shop
that shortens its Friday afternoon does not find the public still being offered
four o'clock because a funnel row said so months ago.

A slot is offered only if all of these hold:

- the shop is open that day and that date (`shop_closures` respected)
- the weekday and the date are not blocked to the public
- the hour is inside the narrowed window
- the day's limit for that kind is not used up
- the hour is not already taken
- it is at least `notice_hours` (default 2) from now

That last one exists because **public and desk share one day limit**. Without
it a stranger takes the last slot at 8:55 for a 9:00.

Then the posted time is re-checked against `publicSlots` AND run through
`scheduleGuards` with no override. Two checks rather than one on purpose: a
time that is legal for the desk but outside the public window has come from
somebody editing the request, not from the form.

## A hold is a real appointment

The single decision the rest falls out of: **a held drop-off owns an
`appointments` row from the moment it is submitted.** That is what makes the
hold count against the day's limit, show on the scheduler as a provisional
card, and release by being cancelled.

Nothing had to be taught that a hold exists. Declining cancels the appointment;
lapsing cancels the appointment; both put the hour back.

| purpose | state | what the customer is told |
| --- | --- | --- |
| estimate | `booked` | the time is theirs, email now |
| drop-off | `held` | held for 24h, email now, second email on confirm |

**A decline sends nothing.** That is a phone call, and the customer was never
promised an email for it.

## What a submission creates

A lead, normally — same row the counter writes, `source = 'web_form'`, with
`campaign` and `source_url` on it. Never a repair order.

Three lookups change that, and each one changes behaviour rather than
decorating the row:

- **A returning customer skips the lead.** Matched on phone **and only where
  they have a past file** — a client row alone is not evidence. The request
  still lands in the queue, because nothing else would put it in front of a
  person.
- **Their car is already in the bay** → the request is linked to the file, the
  file gets the red mark a mention gets, and a note says it is usually a
  question rather than new work. **The mark clears by answering it in the
  queue, with no clock** — deliberately unlike a mention, which escalates at 24
  and 48 hours because it waits on one named person.
- **A repeat inside a week** → its own lead, flagged. Somebody asking twice is
  a thing the shop should see, not something to tidy away.

## An unsubscribed address

**Carried, not refused** — the same call `checkin.html` makes, because this is
the customer's own hand on the keyboard. A `suppression_hits` row is written.

What follows is the part that needed care: they will receive nothing, so the
form shows the version of the sentence that promises a **call** rather than one
that promises an email it cannot send. It never says why. That is not the
customer's business on a public page.

## The letters

The wording is the shop's, per event, with merge tokens — not one house email
with a shop name dropped in. Shipped with the three defaults as written on
17 Sep 2026.

The awkward case is an **empty token**, and it is not hypothetical: the shop can
switch the vehicle field off, and `[ vehicle year ]` then has nothing behind it.
Two defences:

- The editor **refuses a token for a field the form is not collecting**, at the
  moment somebody is writing it. That is the real fix.
- `renderLetter` **drops the whole sentence** carrying an empty token. A letter
  that says less beats one with a gap in it.

From line is `Their Shop via Easy Shop` on our verified domain — the shop's
name can only be the display name, because the address has to be one Resend
signed for. Replies go to the shop.

## Accessibility, and the one exception

The form is a **Title III surface** for the same reason `checkin.html` is, so
labels and helper lines use the page's full-strength ink rather than a muted
version: a shop's own muted grey is usually around 3.6:1 on their paper. The
desk screens behind it are internal and are not held to it.

The exception is the accent: **both the accent and the ink on it are the
owner's**, because the form has to match their theme. So it is warn-and-allow,
and the warning **names what actually breaks** — the two failures have
different fixes:

- button text below 4.5:1 → change the ink, and it goes away
- the focus outline below 3:1 on white → **no ink change fixes this**; the
  accent itself has to be darker

Accepting writes an `audit_log` row (who, when, which colours, what they
measured) and is **mentioned nowhere else**: not to the customer, not in the
form's markup, no banner afterwards. A record, not a message.

## Where it runs

WordPress and HighLevel, without being written for either. Both will move a
script tag, run it before its target exists, include it twice, or inject the
block into a tab after load. All four are handled: `f.js` finds its own tag,
watches for its target with a `MutationObserver`, and refuses to mount twice.
One global (`window.EasyShop.form`) on pages already carrying jQuery and
everyone else's code.

**No PHP.** Admin's copy block says so in as many words, because that is the
first question a web person asks.

## Who installs it

Most shops do not run their own site. Admin › Web form produces a **sendable
block** — snippet, what it needs, which domains are allowed — written for
somebody with no Easy Shop login and no context.

## Files

- `server/db/migrations/master/008_funnel_keys.sql` — the public key lookup
- `server/db/migrations/tenant/031_web_funnel.sql` — settings, domains, public
  hours and blocks, fields, requests, letters; `leads.campaign`,
  `leads.source_url`, `repair_orders.web_request_id`; the `web_forms` capability
- `server/db/tenant.sql` — the same, for a new shop
- `server/src/lib/funnel.ts` — key resolution, the allowlist, availability,
  letters, contrast
- `server/src/routes/funnel.ts` — the three public endpoints
- `server/src/routes/funnel-admin.ts` — settings and the queue
- `server/src/jobs/funnel-holds.ts` — lapsing, and holds the hours moved under
- `server/src/middleware/security.ts` — the CORS exemption, CORP, rate bucket
- `server/src/permissions.ts` — `web_forms` / `manageWebForms`
- `server/src/notify.ts`, `server/src/lib/mail.ts` — the `web.request` event
- `server/src/server.ts` — registration and the sweeper
- `server/web/f.js` — the snippet
- `server/web/admin.html` — Admin › Web form
- `server/web/leads.html` — Leads › Web requests

`npm run build && npm run migrate && sudo systemctl restart easyshop`.
Then `npm run schema-audit`, per the provisioning rule.

## Still open

- **Two public keys or a group key** for a shop group sharing one form. Left
  undecided; the group key is better and is more work.
- Tested against a **real WordPress install and a real HighLevel funnel** —
  not done. Both are an afternoon and neither can be reasoned about from here.
- The **third letter** (drop-off confirmed) ships with wording nobody wrote.
- Custom questions can be added but not yet **reordered or edited** after the
  fact; the prompts in Admin are a placeholder for a proper editor.

# A picked-up car is off the board until you ask for it — 17 Sep 2026

A car that has been picked up is gone, and it was still sitting on the board and
counting in the KPI strip. It now only appears when **Complete** is ticked.

## What counts as gone

`goneSlots()` — the **Picked Up** slot and anything past it, less the close
itself, which was already off the board.

**Payment Collected is deliberately not in it.** Money is often taken at the
counter with the car still in the bay, so hiding that status would take a car
still standing in the shop off the board — the opposite of the point.

A shop that renamed Picked Up falls back to the whole delivered band, which is
the same intent one step wider. Hiding nothing at all would be the worse
failure.

## When they come back

Three ways, all of them somebody asking:

- **Complete** ticked — the box already meant "show me the finished ones", and
  it reaches from Vehicle Ready onward, so Picked Up and Paperwork Verified come
  with it.
- **The status filter naming one of those statuses** outright. Asking for Picked
  Up and being shown nothing would be absurd.
- **Closed** ticked, which was already its own answer.

The KPI strip needed nothing: it is computed from the rows actually showing, so
it follows.

The filter description says which it is — *picked-up and closed-out files left
off* rather than the old *closed-out files left off*, which was no longer the
whole truth.

## Files

- `server/web/board.html` — `goneSlots()`, the filter, the description line, and
  a title on the Complete box saying what it reaches

Served off disk — hard refresh, no build.

## Still open

- **Paperwork Verified is now hidden too**, since it is past Picked Up. That is
  right for the board and wrong for accounting, who are the people waiting on
  exactly that status. They reach it through Complete or the status filter for
  now; a saved filter, or their own screen, is the real answer.
- The cycle view's **Delivered heading** now only appears with Complete ticked.
  Correct, but it means the heading is rarely seen — worth checking it still
  reads right when it does.

# The file drawer blinked on every upload — 17 Sep 2026

Uploading files rebuilt the whole drawer, then rebuilt it again on a timer. Up
to **seven full rebuilds** for one upload: `openRo(OPEN)` on success, and
`openRo(OPEN)` every 2.5 seconds after that, six times, whether or not anything
was still being made. Each one refetched the file and rewrote both columns, so
the scroll position, every folded section and anything half-typed went with it.

## One redraw, of the list only

The photo grid and the paperwork rows now live in `#dDocsList`, drawn by
`docsListHtml()`, and an upload rewrites **that container and nothing else** off
`GET /api/ro/:id/media` — an endpoint that already returned exactly this: the
ready rows and a count of what is still pending.

The type select and the dropzone deliberately sit **outside** the container.
Keeping the file input's identity means a redraw cannot lose its listeners or
drop what it is holding.

Tile clicks and the delete buttons are **delegated on the container** rather
than bound per element, so a redraw re-wires nothing and cannot leave a stale
handler behind.

## The poll stops when there is nothing left

It ran its full six regardless. Now it asks, and clears the interval the moment
`pending` reaches zero — which for photos is usually the first ask. Capped at
eight, and it also stops if the drawer has moved to another file.

`refreshDocs()` records which file it was asked about and **does nothing if the
drawer moved on** while the request was in flight, which the old reopen-the-world
approach papered over by rebuilding whatever was open.

## Two things found on the way

- **`drop.textContent = …` deleted the file input.** The input is a child of the
  dropzone, so every place that changed the zone's wording — "Preparing…",
  "Uploading…", and the failure path — removed the input along with the words.
  The success path never showed because the drawer was being rebuilt a moment
  later, which is what hid it. The prompt now has its own `#dropText` span.
- **The failure path retyped the prompt** as "Drop files here, or tap to
  choose", losing the capability-specific wording for someone who cannot see
  paperwork. It is now read off the element once and put back verbatim.

## Files

- `server/web/board.html` — `docsListHtml()`, `#dDocsList`, `refreshDocs()`,
  delegated tile and delete handlers, `#dropText`, the poll's exit condition

Served off disk — hard refresh, no build.

## Still open

- Deleting a document now refreshes the list rather than the drawer, so the
  **Documents count in the drawer header** is updated by hand in `refreshDocs()`.
  Two places that have to agree; worth folding into one reader.
- The same reopen-the-world pattern is still used by every money and date save
  in the drawer (`reopen()`). Those are one rebuild each rather than seven, so
  they blink once — but the drawer redrawing on a saved deductible is the same
  class of thing.

# Open parts for this RO went to the whole list, and RO numbers off the VIN — 17 Sep 2026

## "Open parts for this RO" did not open this RO

The button in the file drawer was `<a href="/parts.html">` — a bare link, with
no idea which file the drawer was on. So it landed on the full list of every
vehicle with or needing parts and the desk had to find the car again, which is
the one thing the button was there to save.

`parts.html` already took `?open=<roId>` and expanded that file directly — the
route back from a repair order opened off a parts line has used it since it was
built. The drawer just never passed it. One line.

The query is cleared with `replaceState` as soon as it is read, so **closing the
modal leaves you on the plain parts screen**, which is where the desk wants to
be next.

**A file with no parts lines is not on that list at all**, so `openFile()` found
nothing and `renderFile()` closed the modal again — a flash, then the full list,
looking exactly like a broken link. It now says which it is: *that file has no
parts on it yet*, in a line above the list and through `Shell.announce`.

## Every open file's number, back onto the last six of the VIN

`npm run ro-numbers` — report; `-- --go` to change; `-- --go --shop 4` for one
shop first. Dry run is the default and `--go` is the only way past it.

The last six of the VIN is the real convention, not a preference: it is what the
EMS import falls back to when an estimate carries no RO number of its own, and
what matching reads back off a file. A file numbered anything else **cannot be
found by an estimate arriving for it**.

**Open files only**, on the canonical predicate
(`close_date IS NULL AND closed_at IS NULL AND voided_at IS NULL`).

- A **closed** file is the shop's business record — its number is on printed
  paperwork, an invoice and a payroll snapshot. Never renamed.
- A **voided** file parks on `VOID-<id>` so its real number goes back in the
  pool immediately. Renaming one would quietly put a released number back in
  use. Excluded by the predicate.
- **No VIN, or under six characters of one**: reported and left alone. A made-up
  number is worse than a wrong one.
- A **collision** — the target already answers to another file, open, closed or
  voided — is reported with the other file named and neither is touched. Two
  open files on the same VIN tail is a real thing (a comeback, a duplicate) and
  it needs a person. `uq_ro_number` would refuse it anyway; this refuses it
  first, by name, so the run does not die on an exception halfway through.

Each change re-reads the row `FOR UPDATE` and **refuses if anything moved
underneath it** — somebody editing the number at the desk while this runs is not
overwritten by what was true when the list was read.

Every change writes **both**: an audit row with before and after, and an auto
note on the file. The number is the thing everybody quotes at each other, so a
silent change to it is indefensible.

The report names the shape of each old number — a longer VIN tail, a plain
sequence — so a run over a shop that was on the last eight reads differently
from one that was on a counter. Worth reading before `--go`.

Idempotent. Run it again and everything reports as already right.

## Files

- `server/web/board.html` — `dParts.href` carries the open RO
- `server/web/parts.html` — `?open=` says so when the file has no lines
- `server/src/scripts/ro-numbers.ts` — new
- `server/package.json` — `npm run ro-numbers`

`npm run build` before the script will run; the two web pages are a hard
refresh.

## Still open

- Nothing **enforces** the convention on the way in. `POST /api/ro` takes
  whatever number is typed, and `details` only checks it is unique. This repairs
  the past; it does not stop it happening again. A default filled from the VIN
  on the create form is probably the answer, rather than a refusal.
- A file whose **VIN is corrected later** keeps the number derived from the old
  one. Re-running the script catches it, which is an argument for running it
  after any EMS import batch.

# 10am refused as outside shop hours, and the booking sheet forgot what you typed — 17 Sep 2026

Two reports off the live scheduler. Unrelated causes.

## A booking at 10am on a Monday was refused

> That time is outside shop hours — the shop is open 08:00 to 17:00 that day.

`shophours.ts` was right. The conversion into it was not. `POST /api/schedule`
stored the typed time as a wall-clock string and then did

```ts
const whenAt = new Date(String(when).replace(' ', 'T'));
```

**An un-suffixed datetime string is parsed in the SERVER's timezone.** The
droplet runs UTC, so `2026-09-21T10:00:00` became 10:00 UTC, which `inZone`
correctly reported as **05:00 in Plano** — before opening. The check then refused
it and quoted the shop's real hours back, which is why the message looked like a
hours problem rather than a clock problem. Every shop west of UTC had the same
hole, sized to its offset: a five-hour window each morning that could not be
booked at all, and an evening window that was accepted silently.

`atShopWallClock(wall, tz)` is now exported from `lib/shophours.ts` and is the
only way a typed time becomes an instant. It reuses the existing `zoned()`
two-step, so it is the same conversion `workingHoursBetween` and `nextOpen`
already trusted — there is now one of them rather than two, one of them wrong.

**Nothing stored was wrong**, and nothing needs repairing: the string written to
`starts_at` was always the wall clock the desk typed. Only the gate in front of
it misread. Overrides recorded against this — `Booked outside shop hours (…)` on
an appointment inside real hours — are wrong as notes, and there is no way to
tell them from genuine ones. Left alone; they are a note, not a figure.

## Changing the appointment type cleared the form

`renderBooking()` rebuilds `dBody.innerHTML` whole, and the field values lived
only in the DOM. So clicking a type — which refetches openings and redraws —
discarded the name, phone, vehicle, time, who and note. The month arrows and
picking a day did the same thing.

Values are now held in `BOOK_DRAFT`, stashed before the redraw and put back
after, so the sheet survives every redraw path rather than just the one that was
reported.

## Files

- `server/src/lib/shophours.ts` — `atShopWallClock()` exported
- `server/src/lib/shoptime.ts` — `wallClock()` now lives here, once
- `server/src/routes/scheduler.ts` — `scheduleGuards()`: hours, daily limit and
  the person's day in one exported function, used by booking and moving
- `server/src/routes/leads.ts` — booking from a lead goes through the same guards
- `server/web/schedule.html` — `BOOK_DRAFT`, `stashDraft()`, `restoreDraft()`;
  `guardBox()` + `move()`, so booking and moving both offer the override
- `server/web/leads.html` — the lead booking drawer offers it too
- `server/web/board.html` — reads the refusal flags rather than the sentence

`npm run build && sudo systemctl restart easyshop` for the TypeScript; the two
web pages are served off disk, so a hard refresh.

## The two doors that skipped the check — closed the same day

**Moving an appointment checked nothing at all.** `PATCH /api/schedule/:id`
wrote `starts_at` and stopped — no hours, no daily limit, no look at the
assigned person's day. So every rule the shop sets was enforced on the way in
and ignored the moment somebody dragged the card: book a legal 9am drop, move it
to 9pm on a Sunday onto a full day over somebody's holiday, and it saved
silently.

**Booking from a lead was a second door into `appointments`** with none of the
checks either.

Rather than write the rules a third time, they are now one exported function:

```ts
scheduleGuards({ cid, tz, kind, when, durationMin,
                 assignedUserId, ignoreApptId, isOwner, override, moving })
```

It reads all of it from where the shop set it — `shop_hours` and
`shop_closures` for the week and its exceptions, `shop_settings.cap_<kind>` for
the daily limit, `employee_time_off` and the person's own bookings for their
day — and returns either the refusal to send back or the sentence to record.
Warn-and-allow throughout, as before; the daily limit stays owner-only to
override. `POST /api/schedule`, `PATCH /api/schedule/:id` and
`POST /api/leads/:id/appointment` all go through it, so there is one answer to
"may this be booked then" instead of three.

**A move ignores its own row** (`ignoreApptId`), or shifting an appointment by
ten minutes would collide with itself and count against its own day's limit.

**The note is appended, not replaced.** A card moved onto somebody's day off and
then moved outside hours has two things worth explaining, and the second must
not erase the first. The sentence says *Moved* rather than *Booked* when it was
a move.

**`wallClock()` existed twice**, identically, in `scheduler.ts` and `leads.ts`.
That is how one of them ended up with checks the other did not have. It is now
in `lib/shoptime.ts` and imported by both.

The front ends were the other half of it: the `outsideHours` 409 had **no
override affordance anywhere** — `schedule.html` fell through to a bare error
line, so the warn-and-allow the server offered could not be taken. Booking and
moving now share one `guardBox()` covering all three refusals, with the clashes
and the next opening listed in it. The lead drawer and the file drawer offer the
same override. All of them now read the `outsideHours` / `full` / `conflict`
flags and `canOverride` rather than matching on the message text — `board.html`
was testing `/outside shop hours/i` against the sentence, and `schedule.html`
decided who could overbook from `ME.caps.admin` instead of what the server said.

## Still open

- `PATCH` cannot change `assignedUserId`, so a move re-checks the person who was
  already on it. Moving the car and handing it to somebody else is two requests.
- Nothing re-checks when a **time-off block is created over existing bookings** —
  that path warns the owner at the time (`POST /api/time-off` returns
  `overrode`), which is the right moment, but a booking made before the block
  and never touched again keeps no record of the clash.
- The lead booking drawer redraws the same way the schedule sheet did; worth
  checking whether it drops typed fields too.

# Customer edits on a file with no client row went nowhere — 16 Sep 2026

Reported: a customer's details would not change, her name was blank, and her RO
number read as something nobody typed. Three things, two causes, no database
corruption.

## The name, and why saving did nothing

`PATCH /api/ro/:id/details` ended its customer block with

```ts
if (custSets.length && ro.client_id) { ...UPDATE clients... }
```

**`client_id` can be NULL.** `POST /api/ro` only writes a client row when a name
was given, and an EMS import can land a file without one. On such a file the
name reads blank — correctly, there is no record — and every correction typed
into the block was accepted, written **nowhere**, answered `{ok:true}`, and the
drawer redrew the same blank field. Typing the name back in did nothing, and
would have done nothing forever.

Now the missing record is **created** from whatever was typed, the file is
pointed at it, and a vehicle row that was sitting there with no owner is adopted
in the same transaction. The auto note says *Customer record created for …* so
the history shows where the record came from.

If the block is saved with no name on a file in that state, it refuses in
words — a customer needs a name, and the record cannot be created without one.

**The drawer now says so before it happens**: a file with no client row carries
a red line above the block explaining that the record does not exist yet and
that saving the name will create it. A blank field that silently discards
writes is worse than an error.

## The RO number

Not corruption either. A **voided** file parks on `VOID-<id>` so its real number
goes back in the pool immediately — `uq_ro_number` still has to hold, so the row
needs some placeholder to sit on. What she was looking at was a voided file.

That is not something to fix in the edit block: bringing the file back from the
void is where a number is chosen, and renaming a voided row would quietly put a
released number back in use. So the endpoint refuses it and names the route.

## The number is editable now, for the ordinary case

A mistyped number was previously uncorrectable anywhere — `ro_number` had no
writer outside creation, void and reopen. `details` now takes `roNumber`:
unique-checked against the other files, refused on a voided file with the
sentence above, and audited like any other field. It sits in a new **File**
block at the top of the drawer, above Customer.

## Files

- `server/src/routes/ro.ts` — the customer block creates the missing record;
  `roNumber` accepted, dup-checked and void-guarded
- `server/web/board.html` — the File block with the number, and the warning on
  a file with no customer record

## Still open

- **How many files are in that state?** Worth a query per shop:
  `SELECT id, ro_number FROM repair_orders WHERE client_id IS NULL AND voided_at IS NULL`.
  They are all showing a blank customer and, until this deploy, silently
  refusing to take one.
- **`POST /api/ro` still allows a file with no customer.** Check-in and the
  lead conversion both always write one; only the manual create and an EMS
  import can skip it. Requiring a name there would stop this at the source.
- **The Clients screen has the same shape of gap** — `PATCH /api/clients/:id`
  is fine, but nothing on that screen reaches a file whose `client_id` is null,
  because such a file has no client to list under.

# A lead can be marked won by hand, and linked to a file that already exists — 16 Sep 2026

Tenant migration `030`. New capability `win_lead`, **owner only** to start with.

The case: the customer turns up and drops the car off, somebody at the desk
opens a file for them, and the lead is stranded. Converting it — the only route
to `won` there was — would write a **second** file for the same car, so the lead
sat in *contacted* being chased for work the shop already had, and the close
rate counted it as neither won nor lost.

## Two routes, one capability

```
POST   /api/leads/:id/win       { roId?, note? }   mark won, optionally link
POST   /api/leads/:id/link-ro   { roId }           link only, state untouched
DELETE /api/leads/:id/link-ro                      unlink (a link, never a conversion)
GET    /api/leads/open-files?q= the picker's list
```

**The file is optional on `win`.** A lead can be genuinely won with no file yet
— the car is booked for next month — and refusing the mark until one exists
would leave it in the follow-up queue. Blank is a real answer, and the button
says so: *No file yet*.

**`PATCH` is gated the same way.** Picking *Won* in the state dropdown is the
same act as the button, so it takes the same tick and writes the same stamps.
Without that the select was the way around the permission. The option is shown
disabled with the reason on it rather than hidden.

## Converted and linked are different facts

`ro_link_kind` records which: *converted* means this lead wrote the file,
*linked* means the file already existed and somebody pointed the lead at it.
The close-rate reader should be able to tell them apart. Every pre-existing
lead carrying a file is backfilled to *converted* — it is the only route that
existed before today.

A link can be undone; **a conversion cannot**. Unpicking a conversion would
leave a repair order with no record of where it came from, so that refusal
names the alternative (void the file). Unlinking leaves the state alone: being
wrong about which file is not being wrong about having won the work.

## One lead per file

`UNIQUE KEY uq_lead_ro (ro_id)` — enforced in the schema, not only in the
route, so two people working two duplicate leads cannot both claim RO 41207.
The picker also omits any file already answering to a lead, and the route
refuses one by name, so nobody picks it and finds out afterwards.

Open files only. A closed or voided file is not somewhere a live lead lands.

## Why owner-only by default

It is the one way to reach `won` without the step the close rate is measured
off, so it starts with the person who owns the numbers and the shop ticks it
outward — estimator and front office are the usual second and third, and
deliberately **not** granted by the migration. Admin → Roles and permissions →
Leads → *Mark a lead won, and link it to an existing file*.

## Files

- `server/db/migrations/tenant/030_lead_manual_win.sql` — new; also in `tenant.sql`
- `server/src/permissions.ts` — `win_lead` / `winLeads`
- `server/src/routes/leads.ts` — the four routes, `openFileForLink`, the
  `PATCH` gate, and `ro_link_kind = 'converted'` on conversion
- `server/web/leads.html` — the *Won without converting* block, the file
  picker, unlink, and the disabled *Won* option

## Still open

- **No way to mark won from the board.** Someone who opens the file at the desk
  is on `board.html`, which is where they would notice the lead — the link has
  to be made from the leads screen for now.
- **The picker lists forty open files, newest first, with a search box the
  route honours and the screen does not yet send.** A big shop will need it.
- **Nothing suggests a match.** Name and phone are on both records; offering
  *this looks like RO 41207* would remove most of the picking.

# Mail has never sent — and the reason was in .env.example — 16 Sep 2026

Resend's dashboard shows one message ever: their own "hello world" test. So no
notification, no password reset and no demo request has ever left the box.

## The cause

**`RESEND_API_KEY` was never documented in `.env.example`**, so it was never
put in `/srv/easyshop/.env`. Neither were `MAIL_FROM`, `MAIL_REPLY_TO` or
`DEMO_TO`.

`config.ts` reads it as `process.env.RESEND_API_KEY ?? ''`, and `sendMail`
then refuses every message with "mail is switched off" — at **send** time, into
a log nobody watches. The box looks healthy. Notifications appear to be sent
(the delivery row is written, state `failed`). Nothing anywhere says the
subsystem is off.

That is the defect. The missing key is a five-minute fix; a whole subsystem that
is off with no announcement is the thing that cost a week of assuming email
worked — including me telling you yesterday that Resend "is set up and working".
It was configured in code and never switched on.

## The fix on the box

```
sudo nano /srv/easyshop/.env
```

```
RESEND_API_KEY=re_xxxxxxxxxxxxxxxxxxxx
MAIL_FROM=donotreply@easyshopauto.com
MAIL_REPLY_TO=admin@easyshopauto.com
DEMO_TO=Contact@stormrsolutions.com
```

`sudo systemctl restart easyshop`. `MAIL_FROM` must be on a domain verified in
Resend or every send is rejected with a different error.

## So it cannot happen silently again

- **`.env.example` documents the whole mail block**, with a line saying plainly
  that nothing sends without the key.
- **The server says so at boot.** `MAIL IS OFF — RESEND_API_KEY is not set` at
  error level, naming what will not work. When it is on, it logs the from,
  reply-to and demo-to addresses so a wrong one is visible immediately.
- **`GET /api/demo-request/health`** reports what is set (key prefix only,
  never the key).
- The platform screen's red banner — *"Email is switched off on this box: no
  RESEND_API_KEY in .env"* — was **already there and already correct**. It is
  only on the platform screen, which an owner never opens. Worth surfacing on
  Admin → Settings too.

## Also

The demo form's 502 now carries the provider's own reason to the browser, in
brackets after the message. Configuration text, not customer data, and it is
what ends the guessing. Remove it once the form has been seen to work.

---

# Book a movement from inside the file — 15 Sep 2026

`npm run build && npm run migrate && sudo systemctl restart easyshop`, then hard
refresh. Tenant migration `029`.

Asked for at the demo. The file drawer has a **Movements** section: what is
booked on this car, and a form to book a **drop off**, **pick up**, **return**
or **out to sublet** without leaving the file.

That is the whole point of it being here. The car, the customer and the phone
number are already on screen, so nothing is re-typed — which is how a pickup
ends up booked against the wrong vehicle.

## Sublet was missing entirely

`pickup` and `return` already existed as appointment kinds. **`sublet` did
not** — even though the board has had a sublet lane since migration 010. So a
car could be *in* sublet with no record of when it went or when it was due
back, which is the one movement where that matters most.

Two new columns:

- **`carrier`** — the transport company on a pickup, the vendor on a sublet.
  Free text rather than a join: a sublet vendor is usually a shop down the road
  that will never be a row in this database, and forcing one would mean nobody
  fills it in.
- **`due_back`** — sublet only. **Null is allowed and shown as "no return
  date"** in red, because a blank reads as "on time", and that is the wrong
  thing to tell somebody about a car sitting at a vendor.

One `ADD COLUMN` per statement, per CLAUDE.md.

## The form answers as it is filled

Rather than eight fields at once: choosing the kind reveals what that kind
needs. A **drop** is the customer arriving, so there is no carrier field at all.
A **pickup** asks who is collecting. Only a **sublet** asks for a return date,
and its carrier field is labelled *Vendor*.

Outside shop hours is a **warning with an override**, not a refusal — the same
behaviour the schedule screen has, and it comes free because this posts to the
same endpoint.

## On the schedule screen

Sublets appear automatically (the kind list comes from `/api/schedule-meta`),
toned muted rather than taking a lane colour — a car at a vendor is neither in
the shop nor with the customer. Cards now show the carrier, and a sublet shows
its return date or says it has none.

## Also: labour → labor

US spelling throughout, which needed care rather than a find-and-replace.

**Changed:** every label and sentence a person reads, and the TypeScript
identifiers (`LABOR_TRADES`, `LaborEntry`, `laborFor`, `suggestLabor`,
`caps.laborMoney`, `caps.editLaborMoney`) plus the `labor` field on the
close-out API, both sides.

**Deliberately not changed:** `ro_labour` (a table) and `labour_money` (a
permission key stored in `role_caps` rows). Renaming those is a migration with
real risk, not a spelling fix, and neither is ever shown to anybody.

Two things worth recording, because a blind replace would have shipped both:

- A half-renamed identifier. The sweep changed `LabourEntry` in the *imports*
  of two route files but not its *declaration* in `lib/profit.ts`. That is a
  build error, which is the good outcome.
- **A silent one.** It renamed `ME.caps.labourMoney` to `laborMoney` in
  `board.html` while the server still sent `labourMoney`. `undefined` is
  falsy, so labor money would have been hidden from **everybody, including the
  owner**, with no error anywhere. Caught by grepping both sides rather than
  trusting the sweep; the property is now renamed on the server too.

Every inline script on all 29 screens re-parsed afterwards. Clean.

## Files

- `server/db/migrations/tenant/029_sublet_appointments.sql` — new; also in
  `tenant.sql`
- `server/src/routes/scheduler.ts` — `sublet` kind, `carrier` and `dueBack`
- `server/src/routes/ro.ts` — `movements` on the file detail
- `server/web/board.html` — the Movements section and `wireMovements`
- `server/web/schedule.html` — carrier and return date on the card, sublet tone
- `server/src/permissions.ts` + 13 others — the spelling pass

## Still open

- **A movement cannot be edited or cancelled from the file** — only booked.
  Cancelled ones are listed struck through, but the × lives on the schedule
  screen.
- **Nothing links a sublet to the board's sublet lane.** Booking one does not
  move the car into that lane, and moving it there does not create the booking.
  They should probably be the same act.
- **No reminder on a sublet that is overdue.** `due_back` is stored and shown;
  nothing watches it. That is a sweep like the mention reminder, and the obvious
  next piece.
- `cap_sublet` defaults to 0 (no limit), which is right — but it now appears in
  the day-limits card with the others, where it may just be noise.

---

# The board drawer threw "d is not defined" — FIXED 15 Sep 2026

Clicking a file broke the drawer. My fault, and worth recording because the
shape of the mistake will recur.

## Why

The drawer is **two functions**: `renderDrawer(d)` builds the markup and has
the payload; `wireDrawer()` attaches the handlers and **takes no arguments**.

I added the @ picker's wiring next to the other handlers — the right place — and
called it with `d.taggable`. `d` only exists in the first function. Every click
on a file threw before the drawer finished.

`OPEN` holds the open file's **id**, not its payload, so there was nothing for
the wiring to read.

## Fix

A module-level `DTL`, set at the top of `renderDrawer`, holding the detail the
drawer is currently showing. The picker reads `(DTL && DTL.taggable) || []`.

That is now the place for anything else the wiring needs out of the payload —
which is the general answer, not a patch for this one call.

## What I added to catch it next time

Every inline script on every screen is now syntax-and-scope checked by parsing
it with `new Function` before shipping. It found this class immediately, and
`npm run build` never would have: **`web/*` is served straight off disk and
never passes through tsc**, so a browser-side mistake has no compiler between
me and the shop. Six screens checked, all clean.

(One apparent failure on `index.html` was the JSON-LD block being parsed as
JavaScript. Separated by type: the JSON-LD parses as JSON, the inline script
parses as JS.)

## Files

- `server/web/board.html` — `DTL`, set in `renderDrawer`, read by the picker

## The lesson worth keeping

`server/web/*` has no build step. That is its virtue — edit and refresh — and
its risk: nothing type-checks it. Anything I add to a screen gets parsed before
it ships from now on.

---

# One clock for a quiet lead — 15 Sep 2026

`npm run build && npm run migrate && sudo systemctl restart easyshop`, then hard
refresh. Tenant migration `028`.

Two settings described the same thing:

    lead_followup_days   the on-screen flag     3
    lead_chase_hours     the automatic message  72

At their defaults they are the same moment — which is why 72 was chosen. But a
shop changing one and not the other would get a row that turns red on Tuesday
and a message that goes out on Thursday, with no way to tell which was "the"
setting. A support call waiting to happen.

**`lead_chase_hours` is now the only one.** The flag and the message read it.

Hours rather than days because the sales clock is already in hours (12), and a
shop should be able to say "one working day" without inventing a fraction.

## Migrating a shop that had customised it

A shop that had set its own days figure keeps its own number, converted × 24.
A shop that never touched it lands on 72 either way — the conversion is skipped
where the value is still the old default of 3, so nobody gets "moved" to where
they already were.

`lead_followup_days` is **left in the table rather than dropped**. It costs one
row, and deleting a setting an older build still reads is how a rolled-back
deploy turns into a shop with no follow-up flag at all. Nothing reads it now
except as a fallback for a database that has not taken 028 yet.

## The screen reads better for it

The list was showing "due in 0 days" for anything under twenty-four hours,
which is the kind of thing people stop reading. Now:

| Left | Reads |
| --- | --- |
| 0 h | due now |
| 6 h | due in 6 hours |
| 23 h | due in 23 hours |
| 30 h | due in 2 days |

Hours under a day, days above it. Same for the tooltip on a flagged row —
"Quiet for 14 hours" rather than "Quiet for 0 days".

**A sales-app lead waiting on its onboarding call now says so**: the tag reads
**Needs a call** rather than Follow up, because "quiet" is the wrong word for a
lead where somebody promised to ring.

## Settings

Admin → Settings → Lead follow-up is now one field, **Hours of silence before
flagging**, with a line saying it both turns the row red and sends the message,
that 72 is three days, and that a sales write-up uses its own shorter figure
under Sales write-ups. Validated 1–2160 (ninety days).

## Files

- `server/db/migrations/tenant/028_lead_clock.sql` — new
- `server/src/routes/leads.ts` — `chaseHours`, `quiet_hours` on both queries,
  `followup_due_in_hours`
- `server/web/leads.html` — `dueIn` / `quietFor`, the onboarding tag
- `server/web/admin.html` — the field, in hours
- `server/src/routes/config.ts` — validation
- `server/db/tenant.sql` — the old setting marked superseded

## Still open

- `followup_due_in` (days) is still sent alongside the hours figure for
  anything that reads it. Nothing in the app does any more; worth removing once
  it is certain.
- The **sales** figure still lives under Sales write-ups rather than beside
  this one. Two places to look for two clocks is arguably right, but it is
  worth a cross-reference on the Lead follow-up card.

---

# Automatic chase messages on a quiet lead — 15 Sep 2026

`npm run build && npm run migrate && sudo systemctl restart easyshop`.
Tenant migration `027`.

The leads screen has always **flagged** a quiet lead. Nothing ever **told**
anybody — which means the flag only worked for somebody already looking at the
screen, who is the person least likely to need telling. This is the telling.

## Two clocks

| Lead | Silence before the message |
| --- | --- |
| Written on the **sales screen** | **12 hours** |
| Everything else | **72 hours** |

Both on the actual clock, not shop hours — the same call as the onboarding
clock and the mention reminder.

The sales figure reuses `sales_onboard_red_hours`, so the number that turns the
row red and the number that sends the message are **one setting**. Two knobs
that mean nearly the same thing is how a shop ends up with a red row and no
message, or the reverse. The general one is `lead_chase_hours`, **72 by default** — which is the same
three days the on-screen flag already uses, so the row turning red and the
message going out are the same moment. That was the point of choosing 72 over
48: the two numbers no longer drift.

## Who is told

The person who **owns** the lead, and **front office**.

The owner because it is theirs. Front office because a lead with no owner, or
an owner who is off this week, still has to be somebody's problem rather than
nobody's — which is exactly the case where a lead is lost.

If a lead has no owner and the shop has no front office, nothing is sent and
the lead is left for the next sweep rather than the message going nowhere.

## What stops the clock

**Quiet means quiet since the last contact**, not since the lead arrived —
`last_followup_at` where somebody has chased it, `received_at` otherwise.

Three things stop it, and each already meant "handled" elsewhere in the app:

- **marking it chased**,
- **booking an appointment** — being booked *is* the follow-up, which is how
  the on-screen flag has always behaved; nagging about a lead that is on the
  calendar is how a notification gets muted,
- **writing a note on it**. This one needed fixing while I was here: a note
  already counted as first contact but did not touch `last_followup_at`, so
  somebody could write up a phone call and still be told the lead had gone
  quiet.

A snoozed lead and a won or lost lead are skipped.

## Sent once per silence

`chase_notified_at` is stamped, and **cleared by any of the three above**. So
the message is per stretch of silence rather than per lead: chase it, let it go
quiet again, and it earns a fresh message — but it never repeats hourly.

Hourly sweep, first pass two minutes after boot so a restart does not skip an
hour.

## Files

- `server/db/migrations/tenant/027_lead_chase.sql` — new; also in `tenant.sql`
- `server/src/jobs/leadchase.ts` — new
- `server/src/routes/leads.ts` — the three resets, including the note fix
- `server/src/notify.ts`, `server/src/lib/mail.ts` — the `lead.chase` event,
  its own email switch, on by default
- `server/src/server.ts` — starts the sweep

## Still open

- **Two settings still describe "quiet", but they now agree.**
  `lead_followup_days` (3) and `lead_chase_hours` (72) are the same moment at
  their defaults. A shop that changes one and not the other will still see them
  drift — one hours-based setting the screen also reads is the real fix.
- **No settings UI** for `lead_chase_hours`. It is a `shop_settings` row and
  the Lead follow-up card is the obvious home for it.
- **Nothing escalates.** One message and then silence until somebody acts;
  there is no second nudge and no owner summary the way mentions have.
- The message goes to the in-app inbox and to email for anyone who has that
  event switched on. There is no digest — ten quiet leads is ten messages.

---

# The @ picker — 15 Sep 2026

`npm run build && sudo systemctl restart easyshop`, then hard refresh the board.
No migration.

Type **@** in a note and a list appears. `@chr` narrows to Chris Johnson.
`@ChrisJ` tags you directly.

## Handles

Every person gets a no-space handle: **@ChrisJ**, @BobB, @DeniseO, @RayW.

The space is the reason. "@Ray Whitlock, can you look" reads fine to a person
and is ambiguous to a parser the moment a comma or a second name follows.
A handle has no space, so there is nothing to guess.

**First name plus as much of the surname as it takes to be unique at that
shop.** One Chris gives `@ChrisJ`. A second Chris J makes both grow a letter —
`@ChrisJoh` and `@ChrisJon` — rather than one becoming Chris2, because a handle
should still look like the person's name. Generated per shop from that shop's
own people, so nobody's handle depends on a stranger at another shop.

Full names still work for anyone who types them, and an unambiguous first name
still works.

## The picker

Watches the word at the caret and opens only on an **@ that starts a word** —
the same rule the server uses to decide what is a tag. Checked:

| Typing | Picker |
| --- | --- |
| `Call @` | opens, everyone |
| `Call @chr` | opens, filtered |
| `(@chr` | opens |
| `email bob@chr` | **stays shut** |
| `note@shop.com` | **stays shut** |
| `Called them @ 3pm` | stays shut |

Matching is prefix-first and ordered so **Enter is safe**: exact handle, then
handle prefix, then name prefix, then any word of the name, then anywhere.
`chr` finds Chris; `god` finds George Godina; `ch` offers Chris and Chuy in a
stable order.

Keyboard throughout — arrows to move, Enter or Tab to pick, Escape to dismiss.
**Enter only picks while the list is open**, so somebody writing a paragraph
still gets a newline. The list uses `mousedown` rather than `click` because the
textarea must not lose focus first.

It inserts the handle and a trailing space, leaving the caret after it, so
tagging two people in a row is just typing.

## Files

- `server/src/lib/mentions.ts` — `handlesFor`, handles on `Taggable`, handle
  matching in `findMentions`
- `server/web/board.html` — `wireTagPicker`, the list markup and its styling

## Still open

- **The picker is on the board's note box only.** The lead screen and the
  quick-note field elsewhere do not have it, and `taggable` is only shipped on
  the RO detail. Both are the same two lines once the list is in the payload.
- **No avatars or roles in the list** — just handle and name. Fine for nine
  people; a shop with forty would want the role beside the name.
- Handles are computed per request rather than stored. Cheap, and it means a
  rename fixes them everywhere — but a handle can change under somebody when a
  new starter collides with them, and old notes keep the old text.

---

# Tagging somebody in a note — BUILT a0.6.0, 15 Sep 2026

`npm run build && npm run migrate && sudo systemctl restart easyshop`, then hard
refresh the board. Tenant migration `026`.

Type **@** and a name in a note. They get it in their inbox, and the file
carries a red triangle until they reply.

## How it clears — the decision that makes or breaks it

**Opening the file does not clear it. Writing a note does.**

"I saw it" is not "I dealt with it", and a marker that clears on a glance is one
nobody trusts — which turns it into decoration, and then into something people
filter out. The note is also the answer the next person reads, so the evidence
and the clear are the same act.

**One row per tagged person, not per file.** Two people tagged is two marks,
each clearing when that person writes; the file's triangle goes when the last
one does. A per-file flag could not say "Ray answered, Denise has not".
`cleared_note_id` records which note did it, so the history reads as a question
and an answer.

## Matching names

Done against the shop's actual people rather than a pattern, because real names
have spaces: `@Ray Whitlock` is one person, and `@\w+` would find "Ray" and
stop. Longest names are tried first so `@Ray Whitlock` is not caught by a
shorter `@Ray`.

A first name alone works **only when it identifies one person at that shop**.
Two people called Ray means `@Ray` tags neither — better that somebody notices
nothing happened than that the wrong Ray is tagged silently.

Twelve cases checked, including the two that would have been embarrassing:

| Note | Tags |
| --- | --- |
| `@Denise please check` | Denise Okafor |
| `@Ray needs to see this` (two Rays) | nobody |
| `@Ray Whitlock needs to see this` | Ray Whitlock |
| `email bob@example.com about it` | **nobody** — an address is not a tag |
| `parts@shop.com and @Marisol` | Marisol Vance only |
| `@Denises car` | nobody — bounded, not a prefix match |
| `@Bob Barnes and @Bob` | Bob Barnes once |

Only people who can reach the file are taggable: tagging somebody into a screen
they cannot open is a dead end that looks exactly like being ignored.

You are never tagged by your own note.

## The reminder, at 24 hours

Three people, as decided: the person tagged **again**, **the person who tagged
them** — otherwise they assume it was handled and find out days later — and the
shop **owner(s)**, which is what makes it a shop problem rather than a private
one between two people.

**Actual elapsed hours**, per your call: a Friday evening tag needs answering on
Saturday, and a clock that waits for Monday is not a reminder.

Sent **once**. `reminded_at` is stamped, and at the 48-hour mark the file reads
as overdue rather than sending more mail — nagging past the point of usefulness
is how people learn to filter a sender. Both figures are shop settings
(`mention_remind_hours`, `mention_overdue_hours`).

Runs hourly in-process, with a pass 90 seconds after boot so a restart does not
skip an hour.

## On the screens

- **Board row**: a red ⚠ with a count when more than one. Placed among the
  flags but reading differently on purpose — it is a request to a person, not a
  fact about the car, and it is the only flag that clears by somebody acting.
- **File drawer**: a *Waiting on a reply* block above the customer details —
  who tagged whom, how long ago, red past 24 hours — and a line saying a note
  clears it and opening does not.
- **Note box**: placeholder and hint explain `@`, with one-click chips for the
  first ten people so nobody has to remember spelling.
- **Account**: *Somebody tags me in a note* is its own email switch, **on by
  default** — unlike the board chatter, because somebody typed your name.

## Files

- `server/db/migrations/tenant/026_mentions.sql` — new; also in `tenant.sql`
- `server/src/lib/mentions.ts` — matching, raising, clearing, counting
- `server/src/jobs/mentions.ts` — the 24-hour sweep
- `server/src/routes/ro.ts` — raises on write, clears on answer, exposes both
- `server/src/routes/board.ts` — one count query per page, not per row
- `server/src/notify.ts`, `server/src/lib/mail.ts` — the new event
- `server/src/server.ts` — starts the sweep
- `server/web/board.html` — the triangle, the waiting block, the tag chips

## Still open

- **No autocomplete while typing.** The chips insert a name; typing `@` does
  not open a picker. That is the obvious next improvement and it is a screen
  job, not a server one.
- **Leads cannot be tagged**, only repair orders. The table is keyed on
  `ro_id`; leads would need their own or a polymorphic key.
- **A closed file still shows the triangle** if a tag was never answered. It
  should probably clear on close, or at least stop counting.
- **Nothing surfaces the overdue list.** 48 hours marks a file overdue in the
  drawer, but there is no "everything overdue" view for an owner — which is
  where they would actually look.
- The mention email uses the standard letter; it does not quote the note with
  the name highlighted, which would read better.

---

# The demo form did nothing — FIXED 15 Sep 2026

Reported: clicking **Send it** on the landing page had no effect.

## Why

It was a `mailto:` link. `location.href = 'mailto:…'` **does nothing at all**
when the browser has no mail client registered — and it fails **silently**. No
error, no console message, no visible change. The visitor concludes it sent and
leaves.

That is a bad bug on any page and an unacceptable one on the single form the
site exists to collect. It was my call and it was the wrong one: I chose it
because "no endpoint, nothing stored, nothing to breach" reads well in a privacy
policy, and traded away the form working.

The JavaScript was fine, incidentally — I checked the handler was firing before
changing anything. The click was landing; the mailto was going nowhere.

## Now

`POST /api/demo-request` — public and unauthenticated by necessity, since the
whole point is that the sender has no account — sending through the same Resend
path everything else uses.

The page gets a real result either way: *"Thanks — that reached us"*, or the
error **plus the phone number**, because somebody who could not send a form
should be told the thing they can act on rather than about our mail provider.
The button disables and says "Sending…" so a slow connection does not look like
the old silence.

**Still nothing is stored.** No table, no row, nothing to breach — the request
is an email to the inbox and no more, so the privacy position is unchanged. If
these ever need tracking they should become leads somewhere real, not a table
nobody reads.

Three details:

- **Reply-to is the sender's address**, so hitting reply in the inbox answers
  the customer rather than the robot.
- **A honeypot field**, hidden by the stylesheet and filled only by bots, which
  is cheaper than a captcha and costs a shop owner on a phone nothing. A caught
  bot gets a cheerful 200 — telling it that it was detected only teaches
  whoever wrote it.
- **Validation asks for one way to reach them**, an email or a phone. A message
  with neither is not a lead.

## Copy that had to change with it

`terms.html` said the form "opens an email in your own mail program". It now
says what it does. The privacy policy needed no change — it never described the
mechanism, only that nothing is stored, which is still true.

## Checked

Posted a filled form with `fetch` stubbed: it hits `/api/demo-request` with the
right JSON, shows the success line, clears the fields, and the honeypot is
off-screen.

## Files

- `server/src/routes/demo.ts` — new
- `server/src/server.ts` — registers it
- `server/web/index.html` — posts instead of mailto, honeypot, result line
- `server/web/site.css` — `.formmsg`
- `server/web/terms.html` — the corrected sentence

## Still open

- **The form needs JavaScript.** With it off there is no submit at all — the
  phone number and email address on the page are the fallback, which is honest
  but not the same as a working form. A no-JS `<form method="post">` posting to
  the same endpoint would fix it and needs a redirect target.
- **No rate limit specific to this endpoint.** It is in the general `write`
  bucket, which is something, but a form that sends mail deserves its own
  tighter limit before somebody finds it.
- **A failed send is logged and lost.** If Resend is down the request is gone;
  the visitor is told to call, but nothing retries and nothing is queued.

---

# Time-based scheduling, holidays and half days — 15 Sep 2026

`npm run build && npm run migrate && sudo systemctl restart easyshop`.
Tenant migration `025`.

## An appointment at 9am now means 9am

The scheduler checked the **day** and never the **hour**. A drop could be booked
for 9pm on a Tuesday, or for Christmas Day, and it was taken happily — the day
limit was the only gate.

`POST /api/schedule` now checks the time against the shop's hours and the
closure list, and says which it failed:

> That time is outside shop hours — the shop is open 08:00 to 12:00 that day.

**Warn and override, not refuse.** Same shape as the person-conflict check
beside it: shops genuinely do take a car in early as a favour, and a scheduler
that makes that impossible gets worked around with a sticky note instead. The
override is recorded on the appointment, merged into the same `override_note`
as a person clash so the day can be explained later from one field.

The refusal carries `nextOpen`, so the screen can offer the next real slot
rather than only saying no.

## Closures: a weekly pattern plus the dates that ignore it

`shop_hours` is the ordinary week. `shop_closures` is one row per date that
does not follow it — because the Fourth of July is not a Saturday.

`kind = 'closed'` overrides the day entirely; `kind = 'hours'` replaces its
window, which is how **Christmas Eve becomes eight-to-noon** rather than
all-or-nothing. That case is the reason the feature is shaped this way.

## Holidays are computed, not stored

`lib/holidays.ts` works out fourteen dates for any year: the federal set, plus
the day after Thanksgiving, both Eves and New Year's Eve, plus **Good Friday**
(computed properly — plenty of Texas shops take it, and it is the one date here
that is not "the nth weekday of a month").

A stored table of dates would need refilling every year and would be wrong the
year somebody forgot. Verified against 2026 and 2027: MLK 19 Jan / 18 Jan,
Memorial 25 May / 31 May, Thanksgiving 26 Nov / 25 Nov, Good Friday 3 Apr /
26 Mar.

**What is stored is which holidays the shop observes**, keyed by a name that
survives into next year (`christmas_eve`, not a date). Tick Thanksgiving once
and next year it is offered already ticked on the right Thursday.

**Nothing is observed by default.** A shop that works Thanksgiving should not
have to un-tick it, and guessing somebody's calendar is worse than asking once.

### The separation that matters

`source` splits holiday rows from manual ones. Un-ticking a holiday deletes
only the holiday row — a Tuesday in March somebody closed for a funeral is
theirs and survives. Saving next year's holidays cannot wipe it either, because
the manual rewrite is scoped to the year being edited.

## The settings screen

Two new cards on the reference rail:

- **Shop hours** — seven days, open and close, an Open/Closed chip that greys
  the times when shut.
- **Holidays & closures** — the year's fourteen with an Observed chip and a
  Closed/Half-day select each (times appear only for a half day), a year
  stepper, and a free list underneath for anything else.

## Checked before shipping

The arithmetic was exercised rather than assumed, including the awkward cases:

| | |
| --- | --- |
| Christmas Eve 09:00 | open |
| Christmas Eve 14:00 | closed (half day) |
| Wed 16:00 → Thu 11:00 over the Eve | 4.00 working hours |
| Thu 24th 08:00 → Mon 28th 09:00 | 5.00 (4 Eve + 0 Christmas/weekend + 1 Monday) |
| Christmas Day, all day | 0.00 |
| Sat 31 Oct → Mon 2 Nov, clocks go back | 1.00 |

## Files

- `server/db/migrations/tenant/025_shop_closures.sql` — new; also in `tenant.sql`
- `server/src/lib/holidays.ts` — new
- `server/src/lib/shophours.ts` — `Calendar`, `shopCalendar`, `dayWindow`,
  `closedReason`; the other functions now take a calendar rather than a week
- `server/src/routes/scheduler.ts` — the time check on booking
- `server/src/routes/config.ts` — `GET`/`PUT /api/config/closures`
- `server/src/routes/leads.ts` — the onboarding clock uses the calendar
- `server/web/admin.html` — both cards

## Still open

- **Only NEW bookings are checked.** `PATCH /api/schedule/:id` can still drag an
  appointment to 9pm. Same call, same helper — it just needs adding.
- **The schedule screen does not draw closures.** A holiday looks like an
  ordinary empty day until you try to book it, which is a worse way to find out
  than seeing it greyed with its label.
- **No lunch breaks.** One window per day; a shop that shuts 12–1 cannot say so.
- **The capacity screen still reads `closed_days`**, which the settings screen
  now writes from `shop_hours` on save. It works, but it should read the table
  and the setting should retire.
- **Closures do not affect the drop-capacity count** — a holiday still shows as
  a bookable day there with its full limit.

---

# Shop hours, for real — 15 Sep 2026

`npm run build && npm run migrate && sudo systemctl restart easyshop`.
Tenant migration `024`.

Yesterday's setting that did nothing now does something.

## What existed, and why it was not enough

The shop knew which **days** it was shut — `closed_days`, a comma-separated
list of day names — and nothing about what **time** it opened. That was enough
for the drop-capacity screen, which only counts days, and useless for anything
measuring elapsed working time.

It also could not express "we shut at noon on Saturday", which is a normal thing
for a shop to do.

## `shop_hours`

One row per weekday: `dow` (0 = Sunday, matching `DAYOFWEEK() - 1`),
`open_time`, `close_time`, `closed`. Seeded Monday–Friday 8–5.

**A closed day keeps its times.** A shop that shuts Saturdays for the winter
gets its hours back in spring rather than retyping them — which is also why the
close-after-open check only applies to a day that is actually open.

The migration carries `closed_days` across in both directions, so a shop that
had already marked Saturday a working day keeps it. The settings screen writes
`closed_days` back on every save, because the capacity screen still reads it
and two answers that disagree is worse than one that is slightly redundant.

## `lib/shophours.ts`

A library, not a SQL expression, because **elapsed working time between two
instants means walking the days and adding up the overlap with each day's open
window**. There is no honest way to do that in a `TIMESTAMPDIFF`.

Everything works in the **shop's** timezone, off the company record. A shop in
Plano and a droplet in New York are an hour apart for part of the year, and
"open at 8" means eight o'clock where the cars are. Zone handling goes through
`Intl`, which is the only thing that gets daylight saving right without a table
of transitions.

Walking day by day is deliberate rather than lazy: a month is thirty
iterations, and the clever closed-form version is wrong across a DST boundary.

Checked before wiring, including the boundary:

| Span | Working hours |
| --- | --- |
| Tue 09:00 → Tue 15:00 | 6.00 |
| Tue 16:00 → Wed 09:00 | 2.00 |
| Fri 16:00 → Sat 10:00 | 1.00 (Saturday closed) |
| Fri 16:00 → Mon 09:00 | 2.00 |
| Mon 08:00 → Fri 17:00 | 45.00 |
| Sat 31 Oct → Mon 2 Nov (clocks go back) | 1.00 |

Backwards spans and identical instants return zero rather than something
negative or enormous.

## Wired in

- **The onboarding clock** honours `sales_onboard_clock = 'shop'`. Measured once
  per request rather than per row: the week is one query and the arithmetic is
  local.
- **The Clock dropdown is enabled**, because the option now means something.
- **Admin → Settings → Shop hours** — seven rows, open and close times, an
  Open/Closed chip per day that greys the times when shut. Its own endpoint
  (`GET`/`PUT /api/config/hours`) rather than more key/value settings: seven
  days with three fields each is a table, and squeezing it into a
  comma-separated string is how `closed_days` ended up unable to say "noon on
  Saturday".
- Validation refuses a close time at or before the open time, with the day
  named, and checks all seven **before writing any**, so a bad Thursday cannot
  leave Monday to Wednesday saved.

## Also: the schema audit checks for missing TABLES

`npm run schema-audit` compared columns within tables the database already had,
so a whole missing table was invisible — exactly the shape of bug it exists to
catch. It now reports them and points at `npm run migrate`. Reported, not
created: a missing table means a migration did not run, and guessing at one is
not the fix.

## Files

- `server/db/migrations/tenant/024_shop_hours.sql` — new; also in `tenant.sql`
- `server/src/lib/shophours.ts` — new
- `server/src/routes/config.ts` — the hours endpoints
- `server/src/routes/leads.ts` — `applyShopClock`, on both lead reads
- `server/web/admin.html` — the Shop hours card
- `server/src/scripts/schema-audit.ts` — missing-table check

## Still open

- **The scheduler does not use the times yet.** It still refuses only on day
  limits and closed days; booking a drop for 9pm on a Tuesday is still allowed.
  That is the next use of this library and the reason it was built.
- **No per-day breaks** (a lunch hour), and no holidays. A holiday calendar is
  the obvious next gap — the fourth of July is not a Saturday.
- **Overnight shifts** cannot be expressed, and the validator says so plainly
  rather than accepting something it would then measure as negative.
- `closed_days` is now derived from `shop_hours` on save but still read
  directly by the capacity screen. Worth pointing that screen at the table and
  retiring the setting.

---

# Settings UI for the sales rules — 15 Sep 2026

`npm run build && sudo systemctl restart easyshop`, then hard refresh
`admin.html`. No migration — the rows already exist from 023.

Admin → Settings gains a **Sales write-ups** card, on the same reference rail as
Tech visibility, Day limits, Lead follow-up and Google Calendar.

Four controls:

- **Require the customer's address** — on/off chip
- **Require a drop-off day** — on/off chip
- **Hours before an un-chased sales lead goes red** — a number, 1 to 168
- **Clock** — actual hours

Each carries the sentence explaining what it does and why, in the same voice as
the rest of the page. The card states plainly that these apply to the sales
screen only: a car at the door is never blocked for a missing address, and a
phone lead still needs only a name and a number.

## Validation, because a key/value table invites bad values

`PATCH /api/config/settings` accepted any key with any value and wrote it
straight in. That is the right shape for an open settings table and the wrong
shape for correctness: `"twelve"` is not `12`, and the screen reading it would
quietly fall back to its own default forever. Nobody would see an error; the
setting would simply not work.

There is now a rules table for the keys whose shape is knowable — flags must be
`0`/`1`, integers must be whole and in range, enums must be one of their values
— covering the four new keys plus `lead_followup_days`,
`lead_appointment_window_days` and `tech_sees_own_only`.

Two deliberate choices:

- **Unknown keys pass through unvalidated.** Several screens write their own
  keys and refusing an unknown one would break them for the sake of tidiness.
- **Everything is checked before anything is written**, so a bad figure in one
  field cannot leave the other five saved and the screen half-right.

Checked against eighteen cases: `12` accepted, ` 24 ` accepted and trimmed,
`twelve` / `12.5` / `0` / `169` each refused with the reason and the field name,
`cap_drop` and `materials_rate_cents` still pass through.

## One thing I fixed about my own work

`sales_onboard_clock` can hold `'shop'`, and **nothing implements it** — the
hours come from a plain `TIMESTAMPDIFF`, so choosing shop hours would change
nothing at all. That is the exact class of bug I have been flagging all day: a
control that looks like it does something.

So the option is **offered but disabled**, labelled "not built yet", and the
reason is written at the place the value is read. The key stays in the schema
because it records the decision; the screen just will not let anybody pick a
value that lies. Implementing it means asking the scheduler for the shop's open
days — the same source the day limits already use.

## Files

- `server/web/admin.html` — the Sales write-ups card, the rail entry, one
  shared on/off chip handler (the next toggle is now markup only), the save body
- `server/src/routes/config.ts` — `SETTING_RULES` and `checkSetting`
- `server/src/routes/leads.ts` — the comment recording that 'shop' is inert

## Still open

- **The other settings have no validation entries** — `cap_*`,
  `materials_rate_cents`, `thin_profit_pct`, `pay_period_end`,
  `sales_tax_rate`. They pass through as before. Adding them is a line each and
  worth doing next time somebody is in this file.
- **Shop-hours clock**, as above.
- The leads list still says "quiet" rather than "needs an onboarding call".

---

# Customer address on the screens, and the sales screen's own rules — 15 Sep 2026

`npm run build && npm run migrate && sudo systemctl restart easyshop`, then hard
refresh. Tenant migration `023`.

## Where the address is asked for, and where it is not

| Screen | Address | Why |
| --- | --- | --- |
| **Sales** | **Required** (street, city, ZIP) | Somebody is stood in front of the customer with a phone. The car is expected, the shop may have to collect it, and the onboarding call goes out against this record. |
| **Check-in** | Optional | A car at the door must NEVER be blocked because nobody asked for a ZIP. This is the one place in the system where stopping the flow costs more than the missing field. |
| **Leads** | Optional | A phone lead often has a name and a number and nothing else. Refusing it would push people to invent an address. |
| **Board / file** | Shown, not required | Plenty of wholesale vehicles have no retail customer at all. |

That asymmetry is the whole design. It is the same field with three different
levels of insistence, set by where somebody is standing when they type it.

## The sales screen

**Address required**, and **a drop booked or self-delivery ticked**. Both were
already half-enforced in the browser; both are now enforced on the server as
well, because the screen is a phone in a parking lot and the request is the
thing that has to be right.

Both are **shop settings**, not constants —`sales_require_address` and
`sales_require_drop`. A shop that sells differently switches them off without a
deploy. They ride to the screen on the existing `/api/sales/capacity` call
rather than costing a second request on a phone.

The step-one copy changes with the setting, so the screen explains why it is
asking rather than just refusing.

## The onboarding clock

A lead written on the sales screen goes **red at 12 hours** if nobody has logged
contact. The normal lead clock is three DAYS; this one is hours, because the
lead is waiting on a call that should already have happened.

**Actual elapsed hours, not shop hours** — your call, and the reasoning is
recorded in the migration: a Friday evening sale needs the call on Saturday, and
a clock that politely waits for Monday defeats the point. Kept as a setting
(`sales_onboard_clock`) so the decision stays visible and reversible rather
than buried in code.

`sales_onboard_red_hours` is the figure, owner-settable like the rest.

Two details worth knowing:

- **A booked drop does not stop the clock.** Deliberate: the appointment is the
  car arriving, the call is the shop making sure it does. Only somebody marking
  the lead chased clears it.
- **The signal is `last_followup_at`, not `first_reply_at`.** The sales route
  stamps `first_reply_at` at creation (the rep *did* speak to them), so that
  column can never indicate onboarding. `last_followup_at` is only ever set by
  a human marking the lead chased.

The clock runs alongside the normal follow-up rule rather than replacing it; a
row is red for whichever fires first, and `followup_reason` says
`'onboarding'` so the screen can word it properly.

## Seeing it, and changing it

Two ticks, not one: `cust_contact` **see** and **change**. Accounting can read
an address and must not rewrite it; the file drawer now refuses a contact edit
from a role with see-only, rather than accepting it and silently discarding it.

The drawer decides what to draw by asking **whether the field arrived** rather
than repeating a permission check in the browser — the server strips the columns
in `scrubCustomer`, so absence is the honest test. A role without the
capability gets a plain line saying the details are not shown for their role,
which is better than an empty block that looks broken.

## Files

- `server/db/migrations/tenant/023_sales_rules.sql` — new; also in `tenant.sql`
- `server/src/routes/sales.ts` — validation, the address on the insert, rules on
  the capacity response
- `server/src/routes/leads.ts` — the onboarding clock in `FollowupCfg` and
  `markFollowup`, the two columns it reads
- `server/src/routes/ro.ts` — address on the detail query, scrubbed; the four
  new patch columns, guarded by `editCustomerContact`
- `server/src/routes/checkin.ts` — stores the address when given
- `server/web/sales.html` — the fields, `whoMissing()`, both gates, the rules
- `server/web/leads.html` — email and address on the new-lead form
- `server/web/checkin.html` — an optional address fieldset, labelled optional
- `server/web/board.html` — the drawer's customer block

## Still open

- **The board's row and column picker** do not offer the address as a column
  yet. The data is on every row (and stripped for roles without the tick); only
  the drawer displays it.
- **The leads list does not draw the onboarding state.** `onboard_red`,
  `onboard_hours_left` and `followup_reason: 'onboarding'` are all on the row —
  the row goes red today because `needs_followup` is set, but it says "quiet"
  rather than "needs an onboarding call", which is the more useful sentence.
- **No settings UI for the four new keys.** They are rows in `shop_settings`;
  Admin → Settings needs the fields, and until then they are a SQL statement.
- **The 24-hour mention reminder is not built** — only recorded in QUEUE.md.
  Same clock decision applies (actual hours).
- A lead's address is personal data and the **retention sweeper only knows about
  repair orders**. A lead that never converts keeps its address indefinitely.

---

# Customer address, the transporter role, and who may see contact details — 15 Sep 2026

From the demo. `npm run build && npm run migrate && sudo systemctl restart easyshop`.

Tenant migration `022`. Also folded into `db/tenant.sql` so a new shop is not
created without it.

## Address was already half there

`clients` has carried address, city, state and zip since the beginning, and the
EMS import has filled them since migration 014 — so a repair order already knew
where the customer lived, and CCC One / Mitchell estimates already supply it.
Two things were missing: a **lead** had nowhere to put it, and nothing on the
board **showed** it.

Both done. A lead now takes an address at the counter, it travels with the
conversion onto the client record, and the board row carries it.

**One name trap worth knowing about**, because it would have been a bad bug:
`leads.state` is already the lead's status enum. The US state column on a lead
is therefore **`addr_state`**, and the conversion maps `leads.addr_state` →
`clients.state`. Had it been called `state`, the contact scrub below would have
stripped every lead's status for anyone without the capability, and the leads
screen would have gone blank rather than merely private.

## `cust_contact` — its own capability

The customer's address, city, zip, phone and email, wherever they appear: board,
file, lead.

Granted by default to **owner**, **front office** (see and change),
**accounting** (see only) and **transporter** (see only) — the four you named,
plus the lead's own creator, below.

Deliberately NOT granted to estimator, production manager, parts manager,
salesperson or technician. A production manager sees every car in the shop and
has no reason to know where its owner lives. Any shop that disagrees ticks it on
the permissions screen; that is what the screen is for.

**Enforced on the server, in `scrubCustomer`** — the same shape as the existing
`scrubMoney`. Hiding fields in the browser only would mean the data was sent and
then politely not drawn; anyone reading the network tab would have it. The board
query selects the columns once for everybody and the gate strips them on the way
out, so there is one query rather than two shapes to keep in step.

What it strips: `address`, `city`, `addr_state`, `zip`, `phone`, `phone2`,
`email` and their `customer_`-prefixed spellings. What it deliberately keeps:
the customer's **name** (a board row with no name is unusable, and a name is not
the thing being protected), and `insurer_phone` / `adjuster_phone` /
`adjuster_email`, which are not personal details and are governed by
`paperwork`.

### The lead's creator always sees their own lead

Enforced in `routes/leads.ts`, not in the capability: they typed the address in,
so a screen that took it back off them would be lying about what they had just
entered. It is their **own** leads only — a salesperson still cannot read the
address on somebody else's.

## The transporter role

Rank 75, between salesperson and technician: not a management role, and it
should not outrank sales in the pickers.

Sees the **board** (whole board, not just assigned work), the **schedule**,
**leads read-only**, and the **customer contact details** — which is the whole
reason the role exists. Plus notes, so a driver can record that nobody was home.

Has **no money capability of any kind** and no hours. That is expressed by
absence: no row means no. It also does not get `edit_ro` (they report to the
desk rather than correcting the file), `any_status` (moving a car in the world
is not moving it on the board), `paperwork`, or `assign`.

`own_only` is `'none'` on purpose. "Only their own work" would leave a
transporter seeing nothing, because nothing is assigned to a transporter — they
read the board and the schedule to find out what needs moving.

A matching `transport` **position** is seeded too, so a transporter can be
picked for a run the way a trade is picked for a car.

## Files

- `server/db/migrations/tenant/022_customer_address_transporter.sql` — new
- `server/db/tenant.sql` — the same, folded in
- `server/src/permissions.ts` — `cust_contact` in `CAP_DEFS`, the two `Caps`
  fields, the legacy role map, the new `transporter` entry, and `scrubCustomer`
- `server/src/routes/board.ts` — selects and emits the contact fields, scrubbed
- `server/src/routes/leads.ts` — address on create and patch, carried on
  conversion, scrubbed with the creator exception

## Still open

- **The screens have not been touched.** The data and the gate are in; the
  board's column picker, the file drawer's customer block and the lead form
  still need the fields adding, and the permissions screen will show the new
  tick automatically from `CAP_DEFS`.
- **The audit log does not record reading an address.** Reads are already a
  known gap (audit item 7), and this is the field where it matters most.
- **Retention**: a lead's address is personal data and the retention sweeper
  only knows about repair orders. A lead that never converts keeps its address
  indefinitely today.
- Whether the transporter should see a **phone number on the board row** at a
  glance or have to open the file. Currently the row carries it.

---

# Sales pay was dead on every provisioned shop — FIXED 15 Sep 2026

Reported from a demo: pay plans screen empty, commission report empty, closing a
file flagged no salesperson, and no plan could be set for anybody.

**Four symptoms, one cause.** Not four bugs.

`npm run build && npm run migrate && sudo systemctl restart easyshop`. The
migration is what repairs the existing shops.

## The cause

`GET /api/pay/plans` built its list of candidate salespeople from
`membership_roles` alone:

```sql
SELECT DISTINCT u.id, u.name FROM membership_roles mr
  JOIN users u ON u.id = mr.user_id WHERE mr.company_id = ?
```

**Nothing writes `membership_roles` except the admin People screen.** The
provisioner writes `memberships.role` for the owner it creates. The demo seeder
writes `memberships.role` for all sixteen of its crew — including Kyle Doheny,
the salesperson. Neither touches the newer table.

So on the demo shop that query returned **nobody**, and the rest follows
mechanically: no people on the screen → no plan can be created → no
`sales_commissions` row can be written → the commission report has nothing →
closing a file appears to flag nobody. Every symptom reported, from one empty
SELECT.

`membership_roles` arrived with master migration 002 and every read of it was
written with a fallback to the old `memberships.role` column —
`middleware/context.ts` has always had one, which is exactly why sign-in,
permissions and the whole board looked healthy while pay was dead. `pay.ts` was
the one reader with no fallback.

## Three fixes, because a fallback is not a repair

1. **`routes/pay.ts` now reads both**, the same way context.ts does: the people
   list comes off `memberships` (with `membership_roles` joined), and the roles
   map falls back to `memberships.role` for anybody with no rows in the new
   table. This makes the screen work immediately, before any migration.

2. **`db/migrations/master/007_membership_roles_backfill.sql`** — makes the data
   right instead of leaning on the fallback forever. One INSERT IGNORE that adds
   a `membership_roles` row from `memberships.role` for every active member who
   has none. Safe to run twice; a shop that has used the People screen already
   has correct rows and is untouched.

   This matters beyond pay: `routes/roles.ts` counts holders per role from that
   table (so the roles admin was showing zero people against every role), and
   `routes/config.ts` reads it for the status-owner pickers.

3. **Both seeders now write it.** `createOwner` in `db/provision.ts` and the
   crew loop in `lib/demo.ts`. The demo one matters particularly because the
   nightly reset re-seeds, so without it the demo would break again tomorrow
   morning even after the backfill.

## What to check after deploying

On the demo shop: Admin → Pay plans should list Bob Barnes, Denise Okafor, Ray
Whitlock and **Kyle Doheny** (the salesperson). Set Kyle a plan, close a file
with him assigned as sales, then run the commission report for that period.

Worth knowing: a commission only lands when the file's **pay trigger** has
fired — approval, car gone, or file closed, per the plan. A file closed before
Kyle had a plan will not retro-pay; the ledger dates from the stamp. Close a
fresh one to test rather than reopening an old one.

## Files

- `server/src/routes/pay.ts` — reads both tables, with the fallback documented
- `server/db/migrations/master/007_membership_roles_backfill.sql` — new
- `server/src/db/provision.ts` — the owner gets a `membership_roles` row
- `server/src/lib/demo.ts` — the crew and the tester get theirs

## Still open

- **`membership_roles` has no writer outside the admin screen and two seeders.**
  Anything that creates a person in future has to remember both tables. The
  honest fix is one `setMembership()` helper that owns both, and deleting the
  direct INSERTs — worth doing before the next screen creates a user.
- **`memberships.role` should eventually go.** It is an eight-value ENUM from
  before roles were the shop's own, it cannot hold a custom role, and every
  reader now needs two code paths. Retiring it is a migration plus a sweep of
  the fallbacks.
- **`npm run schema-audit` would not have caught this** — it compares columns,
  and this was missing *rows*. It also does not yet check for missing TABLES.
  Both are worth adding; queued.

---

# Google Tag Manager, consent, and IndexNow — 15 Sep 2026

`npm run build && sudo systemctl restart easyshop` (the CSP change is server
code), then hard refresh. After deploying: `npm run indexnow`.

## This reversed a published position, so the copy changed in the same commit

Before today the marketing pages set nothing, `privacy.html` said so **in
bold**, and every footer read "No cookies. No tracking." GTM makes all three
false the moment it loads. The rule already recorded in CLAUDE.md was that the
consent plumbing ships *with* the analytics rather than after it, so:

- `privacy.html#cookies` is rewritten. It now opens "Nothing is set on these
  pages unless you say yes", names Google Analytics and Tag Manager, says what
  Analytics records, and explains the storage choice.
- The footer line is now "Analytics only with your say-so."
- Every page gained a **Cookie choices** control in the footer that reads the
  live state — *Analytics: on* / *Analytics: off* — and toggles it.

Shipping the tag without those edits would have left a privacy policy that
contradicted the page it was on.

## Opt in, not opt out

`web/consent.js` is the only thing that loads GTM, and **it does not load until
somebody clicks Allow.**

Consent Mode with denied defaults is the conventional choice, and it is in here
too — but on its own it still loads Google's script and still makes a request on
first paint. This site told people it set nothing; the honest upgrade keeps that
true for anyone who does not say yes. The Consent Mode signals are set anyway,
before anything else runs, so a tag added in the GTM web UI later inherits a
denied default instead of firing freely. Two defences, because the container is
edited by a human in a browser and this file is not.

**Do not paste Google's raw snippet into a page.** That is what this file exists
to prevent.

## Four details worth keeping

- **Global Privacy Control is honoured without being asked.** `privacy.html`
  already promised exactly that, so a GPC browser is treated as a refusal and
  never sees the banner. A promise on a policy page the code does not keep is
  worse than no promise.
- **The choice is in `localStorage`, not a cookie.** Storing a refusal in a
  cookie means setting a cookie on somebody who just declined cookies. It is
  defensible as strictly necessary; it is not a good look.
- **Decline is one click and the same size as Allow.** A decline hidden behind a
  second screen is a dark pattern and, under several state laws, not valid
  consent.
- **Withdrawing actually withdraws.** GTM cannot be unloaded once it is in the
  page, so turning it off updates consent, deletes the `_ga`/`_gid`/`_gcl`/
  `_uet` family across the bare and dotted domain forms, and reloads so nothing
  carries on in memory.

Verified both paths in the browser: declined → no `gtm.js` request at all,
nothing stored but the refusal. Allowed → `gtm.js?id=GTM-T5BC9MZ6` loads,
consent goes `default` then `update`, footer reads *Analytics: on*.

## CSP is widened for the public pages ONLY

`csp()` now takes a flag. The marketing pages get
`script-src`/`img-src`/`connect-src`/`frame-src` allowances for
googletagmanager.com and the Analytics hosts. **The CRM does not.** Every screen
behind sign-in holds a shop's customer records, and "no third-party script can
load" is worth more there than analytics is anywhere.

`frame-ancestors 'none'` is unchanged on both — that governs being framed, which
is never wanted. `frame-src` is what GTM's noscript iframe needs.

## The noscript iframe was deliberately left out

Google's step 2 is an `<iframe>` after `<body>` for browsers without
JavaScript. It is not included, because there is no consent hook on it: with no
JavaScript there is no banner, so including it would fire a tag at somebody who
was never asked and could not answer. A visitor with JavaScript off is not
measured. That is the correct trade.

## IndexNow — `npm run indexnow`

```
npm run indexnow                    # every URL in the sitemap
npm run indexnow -- /about.html     # just what changed
```

One POST that Bing, Yandex, Seznam and Naver all share. Ownership is proved by
`web/8f9828247dc98d8c08b11cf37d19258f.txt` — the script discovers the key by
finding the single `<hex>.txt` in `web/`, so rotating it means dropping in a new
file rather than editing code. Generate your own at bing.com/indexnow if you
prefer; replace the file and it is picked up. It is on the public allowlist so
Bing can actually fetch it.

**Google does not participate in IndexNow.** Its Indexing API only accepts job
postings and livestreams, so there is no honest way to push an ordinary
marketing page to Google — Google finds it by crawling, which the sitemap
serves. Anything selling "instant Google indexing" is selling something. What
this does buy is Bing, and therefore a large share of the AI answer engines that
lean on Bing's index, which is the AEO half of what you asked for.

The script refuses a batch containing a URL on another host rather than letting
the API reject the lot, and explains 403 / 422 / 429 in plain terms.

## Files

- `server/web/consent.js` — new. The gate, the banner, the footer control, GPC
- `server/web/site.css` — consent bar styling, both grounds
- `server/web/{index,about,privacy,sms-terms,terms}.html` — consent script,
  footer control, corrected claim
- `server/web/privacy.html` — cookies section rewritten
- `server/src/middleware/security.ts` — CSP per page kind, `/consent.js` and the
  key file on the allowlist
- `server/src/scripts/indexnow.ts`, `server/package.json` — new script
- `server/web/8f9828247dc98d8c08b11cf37d19258f.txt` — IndexNow key
- `server/web/robots.txt` — allows `consent.js`, notes the IndexNow split

## Still open

- **Nothing is configured inside GTM yet.** The container loads; whether GA4 is
  in it is a decision made in Google's web UI, not here. Put GA4 in and nothing
  else — the policy page now says no advertising or remarketing tags are
  configured, and adding one makes that false.
- **Analytics consent is not wired to the application.** `Cookie
  Preferences.dc.html` was mocked for the CRM; it is still a mockup, and the CRM
  still has no analytics, which is why it is not needed yet.
- **No Search Console or Bing Webmaster Tools property.** IndexNow submits
  blind until the domain is verified in Bing Webmaster Tools; verify it so you
  can see what was accepted.
- **`indexnow` is not automatic.** It wants to run on deploy — one line in
  whatever pulls and restarts.

---

# New shop failed again: `Duplicate entry 'sublet' for key 'PRIMARY'` — FIXED 15 Sep 2026

Second failure of the same family, one step further along. The `thumb_key` fix
worked; provisioning got past the migrations and fell over on the seed.

`npm run build && sudo systemctl restart easyshop`, then create the shop again.
The previous attempts left nothing behind — provisioning rolls back on failure
(drops the database, drops the tenant login, deletes the company row), so the
`drusa` slug is free.

## What happened

Provisioning runs in this order: create the database from `tenant.sql`, replay
every tenant migration, **then** seed lanes and statuses from the shop-type
template.

Migration 010 does not only add schema — it **seeds data**: the `sublet` lane,
the `lane_sublet` status group and its four statuses. It had to, because it was
adding the sublet lane to shops that already existed.

Then the template seeds the lanes for a Collision-and-PDR shop, which include
sublet, with a plain `INSERT`. `lanes.lane_key` is the primary key.
`Duplicate entry 'sublet' for key 'PRIMARY'`.

Note the shape: the migration's own inserts were written carefully with
`ON DUPLICATE KEY UPDATE`, so replaying them is safe. The seed that runs after
them was not, because when it was written nothing ran before it.

## Fix 1 — the seed upserts, and the template wins

Every insert in `seedTenant` is now `INSERT ... ON DUPLICATE KEY UPDATE` across
lanes, status groups and statuses.

**Overwriting rather than ignoring is the deliberate choice.** For a new shop the
template is the authority — it knows the shop type; a migration written for
existing shops does not. It also keeps `sort_order` coherent: migration 010
appends sublet at whatever the end happened to be, while the template places it
where that shop type wants it. Ignoring the collision would have left the lane
in the wrong position on the board.

## Fix 2 — the same atomicity trap, for data

`db/alter.ts` gained `splitInsertRows`. A multi-row
`INSERT ... VALUES (a),(b),(c)` is atomic exactly like a multi-clause ALTER: one
duplicate row rejects all of them, the tolerance swallows the error, and the
rows that were *not* already present never land.

That matters because migration 011 seeds `role_caps` as one INSERT of ~86 rows
and `tenant.sql` seeds most of the same rows. On a duplicate, the statement is
now retried row by row, so the ones that are genuinely new apply.

The splitter handles a trailing `ON DUPLICATE KEY UPDATE` (it rides along on
every row), parentheses and commas inside string literals, and returns null for
`INSERT ... SELECT` — migration 018 seeds its routing rows as a
`SELECT ... UNION ALL` chain and must never be split.

**Checked for real gaps** while I was in there: I diffed the `roles`,
`role_caps`, `positions` and `shop_settings` rows in `tenant.sql` against
migration 011. The key sets are identical — 011 only restates them with fuller
`note` text. So no shop is missing a permission row. The fix prevents a future
gap rather than repairing a current one.

## Files

- `server/src/db/provision.ts` — `seedTenant` upserts lanes, status groups and
  statuses
- `server/src/db/alter.ts` — `splitInsertRows`, wired into `runTolerant`

## Still open — the ordering is the real smell

Seeding after replaying migrations is backwards, and both of these failures come
from it. A migration that seeds data has to be idempotent against a template
that has not run yet, and the template has to be idempotent against migrations
that have. Every new data-seeding migration is another chance to get that wrong.

The cleaner shape is: create the schema, **seed the template**, then replay
migrations — which is the order a live shop actually experienced. I have not
changed it, because migration 018 seeds `status_routes` keyed on slot ids and
would then find the statuses already present rather than absent, and working
through which of the twenty migrations depend on that order is a bigger job than
this bug. Worth doing deliberately rather than under a shop-creation outage.

Until then: **any migration that seeds rows must use `ON DUPLICATE KEY UPDATE`
or `INSERT IGNORE`**, and provisioning a shop of each of the three shop types is
the test that catches it.

---

# schema-audit read a comment as a column — FIXED 15 Sep 2026

First run on the box reported `repair_orders.declared` missing on both shops:

```
DRIFT es_extremehaildfw  (v21) — 1 column(s) missing
        repair_orders.declared  twice here, which is why provisioning a new shop failed. */
```

That is not a column. `tenant.sql` carries a **block comment inside the
`repair_orders` body** — a note from the earlier duplicate-`deductible_cents`
fix — and my parser only skipped `--` line comments. Its second line,
"declared twice here, which is why provisioning a new shop failed. */", parsed
as a column named `declared` with that prose as its type.

Two fixes, because a script that writes DDL has to fail safe:

1. **Block comments are stripped** (`/\*[\s\S]*?\*\/`) before anything reads the
   text, line comments still per line.
2. **A definition must begin with a real column type** — BIGINT, VARCHAR, ENUM,
   DATETIME and the rest. This is defence in depth: with the comments stripped
   the gate now rejects nothing, but it makes the whole class impossible,
   because prose does not start with BIGINT. A line this script misreads can no
   longer become an ALTER.

Re-checked against `tenant.sql`: **618 columns across 50 tables, no
`declared`, and nothing rejected by the type gate.** The count was 619 before
— the extra one was the phantom.

## Also: the flag never reached the script

`npm run schema-audit --go` runs in report mode. npm keeps `--go` for itself;
the script needs the bare separator:

```
npm run schema-audit -- --go
```

Lucky, given the parser was wrong — it would have tried to add a `declared`
column to both live databases. The script now prints the exact command in its
own output so the mistake cannot repeat.

## What to expect on the next run

Both shops are at v21, so they have already run migrations 002 through 021 —
which means they genuinely have all seven columns that had drifted out of
`tenant.sql`. **The audit should report `ok` for both.** If it reports drift
after this, that is a real finding.

## Unrelated, but noticed

`package.json` says version `0.2.8` while the build is a0.6.0 — the terminal
banner reads `easyshop@0.2.8`. Cosmetic, but it is the number npm prints on
every script run, so it is worth correcting.

## Files

- `server/src/scripts/schema-audit.ts` — block comments stripped, type gate
  added, usage text corrected

---

# New shop failed: `Unknown column 'thumb_key' in 'documents'` — FIXED 15 Sep 2026

Reported from the platform screen creating *Dents Or Us - San Antonio*. Nobody
could create a shop. Three separate defects, all in the same seam.

`npm run build && npm run migrate && sudo systemctl restart easyshop`, then
**`npm run schema-audit`** (see below).

## What actually happened

`db/tenant.sql` creates the database; the numbered migrations are then replayed
over it, tolerating anything already present. That is what covers the drift
between the base file and the migrations.

The hole: **a multi-clause `ALTER TABLE` is atomic.** Migration 002 adds four
columns in one statement — `thumb_key`, `width`, `height`, `is_image`. Three of
those four had been folded back into `tenant.sql` over time. So on a fresh
database MySQL rejected the whole ALTER with *Duplicate column name 'width'*,
and **`thumb_key` was never added**. The tolerance matched "Duplicate column"
and swallowed it. Provisioning carried on.

Migration 008 then does `ADD COLUMN thumb_state ... AFTER thumb_key` →
*Unknown column 'thumb_key' in 'documents'*, which the tolerance does **not**
match, so it threw. That is the message on the screen.

The error was honest and pointed at the wrong migration: 008 named the symptom,
002 caused it.

## Fix 1 — tolerance per clause, not per statement

New `server/src/db/alter.ts`. When a statement fails with an already-present
error and it is a multi-clause ALTER, it is split into one ALTER per clause and
each is tried alone: the duplicates skip, the genuinely missing ones land.

The splitter scans rather than splitting on a comma regex, because commas inside
`ENUM('a','b')` and inside `COMMENT 'one, two'` are not separators. Checked
against migration 002's statement (4 clauses), 008's enum-and-comment statement
(2), and 018's mixed MODIFY/ADD (3).

Used by both replay paths — `db/provision.ts` and `scripts/migrate.ts` — which
had two copies of the same too-narrow tolerance. The master path is untouched:
one database tracked by one version never partially applies.

## Fix 2 — the base file, audited rather than guessed

Rather than add the one column, I diffed every `ADD COLUMN` in every tenant
migration against `tenant.sql`. **Seven columns had drifted**, not one:

- `documents.thumb_key` (002)
- `documents.thumb_state`, `thumb_tries`, `rotation`, `page_count` (008)
- `repair_orders.archived_at`, `purged_at` (016 — retention)

All seven are now in `tenant.sql`, with `ix_doc_pending` and
`ix_ro_retention`. A re-run of the diff is clean.

Note what the retention pair means: a shop provisioned recently had no
`archived_at` or `purged_at`, so the retention sweeper would have failed on it
the moment it was switched on. That was a second live bug sitting behind the
first one.

## Fix 3 — `npm run schema-audit`, because migrate cannot repair this

A shop provisioned with the drifted base file is **recorded at the latest schema
version while missing a column**. `npm run migrate` only runs migrations newer
than the recorded version, so it will never revisit it — and there is no
migration to write, because every other database already has the column.

So the repair is a comparison, not a migration:

```
npm run schema-audit          # report
npm run schema-audit -- --go  # add what is missing
```

It reads what `tenant.sql` declares, reads `information_schema` per shop, and
adds the difference. Idempotent. **It only ever ADDs** — never drops, never
retypes. A column the database has and the base file does not is reported and
left alone, because that is far likelier to be a migration the base file has not
caught up with than something to delete.

Run it once now against every shop. It is also the check to run after any future
provisioning change.

## Files

- `server/src/db/alter.ts` — new: `runTolerant`, `splitAlterClauses`
- `server/src/db/provision.ts` — uses it; reports when the base file had drifted
- `server/src/scripts/migrate.ts` — uses it
- `server/src/scripts/schema-audit.ts` — new
- `server/db/tenant.sql` — seven columns and two indexes folded back in; one
  wrapped column definition put on a single line
- `server/package.json` — the `schema-audit` script

## Still open

- **The drift audit is not automatic.** It lives in this note and in the script;
  nothing runs it on deploy. A one-line CI step or a check at boot would turn
  this from a thing somebody remembers into a thing that cannot recur.
- **`splitStatements` is duplicated** in `provision.ts` and `migrate.ts` with
  slightly different regexes. They should be one function, in `alter.ts`, next
  to the thing that consumes them.
- Migration 002's statement is still written as one four-column ALTER. It is now
  harmless, but the pattern is the trap — new migrations are better written one
  `ADD COLUMN` per statement.

---

# Cookies, terms of use, and the parent company — 15 Sep 2026

Web-only except the allowlist line. `npm run build && sudo systemctl restart easyshop`
for that; the pages themselves are just files.

## No banner, on purpose

**The marketing pages set no cookies at all.** No local storage, no analytics, no
pixels, no third-party trackers. `es_sid` only exists once somebody signs in to
the application, and it is strictly necessary, so it needs no consent either.

So there is no consent banner, and adding one would be the wrong move: a banner
on a site that sets nothing implies tracking that is not happening, and it asks
for consent there is nothing to consent to. What protects you is **saying so
plainly, in writing, where a regulator or a plaintiff's lawyer would look** —
which is what changed:

- `privacy.html#cookies` now opens with the statement in bold and explains why
  there is no banner.
- **One third-party resource is disclosed honestly**: the Inter typeface from
  Google Fonts. Google receives the request for the font files including your IP
  address, as it would for any image loaded from another site, and sets no
  cookie. That disclosure is the kind of omission that gets sites sued in the EU;
  it costs one sentence.
- Every page footer carries a **Cookies** link straight to that section, and the
  footer's own base line reads "No cookies. No tracking. Why." — the claim is
  visible on every page rather than buried.

If analytics ever ships, the consent plumbing ships *with* it, not after. That
was already the standing decision and it is now written on the public page too.

## terms.html — new

A website terms of use, which the site did not have. It covers the exposure a
marketing page actually carries:

- **This site is marketing material, not an offer, contract, quotation or
  warranty.** Where it differs from a shop's signed agreement, the agreement
  governs. That sentence is the one doing most of the work.
- Feature descriptions describe the product **as at the effective date**, and
  anything under *Coming next* is explicitly not available and not promised by a
  date. That matters because the landing page names four unbuilt things.
- **Screenshots are illustrative, not a specification**, and may show sample data.
- **The demo form** is plain email, is not secure, and should not carry customer
  records — said on the page rather than assumed.
- **Third-party names** (CCC One, Mitchell, Resend, Twilio, Google) are their
  owners' marks; naming them describes what Easy Shop works with and claims no
  affiliation or endorsement.
- Warranty disclaimer and limitation of liability, with the carve-out that
  nothing limits liability that cannot lawfully be limited or rights under a
  visitor's own state law.
- **Governing law Texas, venue Collin County** — Plano is in Collin County.

`terms.html` is on the indexable allowlist, in `robots.txt` and in the sitemap
(now five URLs).

**This is not legal advice and I am not a lawyer.** It is a careful,
conventional set of terms written to match what this site actually does, which
is a much better starting point than a generator's template — but have a Texas
attorney read it before you rely on it. The same still goes for the privacy
policy, and the processor terms (DPA) in the shop agreement remain the largest
single item outstanding on the audit queue.

## Storm Rider Solutions is referenced throughout

You are about to link here from stormrsolutions.com, so the relationship is now
stated on this side too — which is what makes the two sites one entity to a
crawler rather than two strangers:

- Footer on all five pages: "Built and supported by Storm Rider Solutions LLC",
  linked, and the copyright line linked.
- `privacy.html` names the operator with the domain in the "Who we are" clause.
- `terms.html` names it as the operator.
- **Structured data**: the `Organization` node on the home page gained
  `sameAs: ["https://stormrsolutions.com"]` and a `parentOrganization`. That is
  the machine-readable half — it lets Google and an answer engine resolve *Easy
  Shop*, *Storm Rider Solutions* and *Chris Johnson* to one organisation, so
  reputation earned by either domain counts toward both.

When you add the link on stormrsolutions.com, point it at
`https://easyshopauto.com/` (not a deep link) and use the product name in the
anchor text — "Easy Shop — automotive production management" rather than "click
here". Anchor text is one of the few ranking signals you control outright.

## Files

- `server/web/terms.html` — new
- `server/web/privacy.html` — cookies section rewritten, Google Fonts disclosed,
  operator linked
- `server/web/index.html` — Organization `sameAs` / `parentOrganization`
- all five public pages — footer legal links and the no-tracking line
- `server/web/robots.txt`, `server/web/sitemap.xml`
- `server/src/middleware/security.ts` — `/terms.html` on the allowlist

---

# Search terms — 15 Sep 2026

Terms asked for: *auto collision, auto hail, auto CRM, automotive service
solution, production management, automotive production management*. Worked into
`server/web` in the places that carry weight, and deliberately not into the
places that would read as stuffing.

- **Title and description** on `index.html` now lead with *Automotive
  Production Management & CRM for Collision and Hail Repair*, and the
  description names auto collision, auto hail and automotive service solution in
  a sentence rather than a list.
- **`keywords` on the SoftwareApplication node**, with the requested terms plus
  the ones a shop would actually search adjacent to them — PDR, paintless dent
  repair, repair order management, body shop management software.
  `applicationSubCategory` became *Automotive production management software and
  auto CRM*, which is the phrase that decides what category of thing a model
  thinks this is.
- **Hail is claimed honestly.** The product already ships Collision, Hail and
  Combination presets, a PDR lane and PDR technician trades — so *auto hail* is
  a description, not a keyword bolted on. A feature bullet now says the three
  shop types get their own lane and status sets, and the board copy names PDR in
  the stage list.
- **Two section kickers reworded** to *Production management* and *Automotive
  production management*, which puts the phrase in real headings instead of only
  in `<meta>`.
- **The shared footer blurb** on all four pages now reads "Automotive production
  management and CRM for auto collision, auto hail and mechanical repair shops",
  so every page carries the terms once in body text.
- **About** picks up auto collision and auto hail in its title, description,
  Person schema and the *Who it's for* block.

What was deliberately NOT done: no keyword list in a `<meta name="keywords">`
tag (ignored since roughly 2009 and a spam signal to some crawlers), no repeated
phrases in the H1, and no hidden text. The FAQ answers were left word-for-word
identical to the `FAQPage` schema — rewording them for keywords would break the
match, which is the one schema mistake that carries a penalty.

Still the biggest lever, and still not code: a Search Console property, and
listing profiles on Capterra, G2 and Software Advice, which is where
"automotive CRM" searches actually land.

---

# The marketing site, and cloaking the CRM — 15 Sep 2026

The landing page, About and the two legal pages now exist as **real static HTML
in `server/web`**, not as design mockups. That was the necessary part: the
mockups render client-side, and a crawler that has to run JavaScript to find your
copy is a crawler that ranks you below a shop with a plain HTML page.

No migration. `npm run build && sudo systemctl restart easyshop` (the build is
only needed for the `security.ts` change; the pages themselves are served
straight off disk).

## The sign-in page moved

**`index.html` is now the landing page. The CRM sign-in is `signin.html`.**

The root has to be the marketing page — it is the URL that gets linked, shared
and ranked. Fourteen files referenced `/` as "go to sign in" (every screen's
`if (!me.company)` redirect, `shell.js`'s 401 handler, both sign-out buttons,
`reset.html`, `set-password.html`, `choose.html`, `platform.html`); all of them
now point at `/signin.html`. Nothing else about authentication changed.

If a bookmark or a link to `/` exists in the wild it now lands on the marketing
page rather than the sign-in form, which is the right failure — there is a
**Sign in** button in the header.

## Cloaking

Every page used to be served `noindex, nofollow, noarchive`, which was correct
when every page was a shop's private records. `src/middleware/security.ts` now
carries an explicit **allowlist** — `/`, `/index.html`, `/about.html`,
`/privacy.html`, `/sms-terms.html`, `/site.css`, `/robots.txt`,
`/sitemap.xml`, `/favicon.ico` and anything under `/img/`. Those get
`index, follow, max-image-preview:large, max-snippet:-1`. **Everything else
stays cloaked**, so a new CRM screen is invisible to crawlers by default and a
new marketing page has to be added to the list on purpose.

Two pages are public but deliberately **not** indexed: `checkin.html` (a shop's
intake form) and `unsubscribe.html` (reached from a signed link). Being
reachable without a sign-in is not the same as wanting to be found.

`robots.txt` says the same thing, but the **header is what enforces it** —
`robots.txt` only asks. Keep the two in step.

## SEO, page by page

- **One `<h1>` per page**, real `<h2>` section headings, `<nav>`/`<main>`/
  `<article>`/`<footer>` landmarks, and a skip link.
- **Title and meta description written per page**, leading with what a shop owner
  would actually type: *modular shop management software for collision and auto
  repair*, not a slogan.
- **Canonical URL** on all four, absolute, on `https://easyshopauto.com`.
- **Open Graph and Twitter card** so a link pasted into a text or a Facebook
  group renders with the board screenshot rather than a grey box.
- **Real image files with real alt text.** The nine screenshots were living as
  base64 inside a design file; they are now `server/web/img/*.webp` (9-68 KB
  each), width and height attributed so nothing shifts as they load, `loading="lazy"`
  below the fold and `fetchpriority="high"` on the hero.
- **One stylesheet**, `site.css`, carrying Nocturne's tokens as plain values.
  No build step, no framework, nothing to hydrate.
- `sitemap.xml` and `robots.txt`, with the sitemap referenced from robots.

## AEO — the answer-engine half

This is what gets the product quoted rather than just listed:

- **`FAQPage` JSON-LD on the landing page**, with all five questions and answers
  matching the visible copy **word for word**. Mismatched schema is worse than
  none — it is a manual-action risk, and the answers are the part an AI assistant
  lifts verbatim.
- **`SoftwareApplication`** with `applicationCategory: BusinessApplication`, a
  twelve-item `featureList` naming every module, and `audience` set to collision
  and automotive repair shops. That list is how a model answers "which shop
  systems do wholesale accounts".
- **`Organization`** with the founder, the phone, the email and Plano, TX —
  entity grounding, so *Easy Shop*, *Storm Rider Solutions* and *Chris Johnson*
  resolve to one thing.
- **`AboutPage` with a `Person` `mainEntity`** on About, carrying the
  seventeen-years-in-the-industry detail as structured data.
- The FAQ answers are written as **complete standalone sentences** rather than
  continuations of the question, because that is the form an assistant can quote
  without repair.

## Files

- `server/web/index.html` — the landing page (was the sign-in page)
- `server/web/signin.html` — the sign-in page, moved here
- `server/web/about.html`, `privacy.html`, `sms-terms.html` — new
- `server/web/site.css` — new, the marketing stylesheet
- `server/web/img/*.webp` — nine screenshots and the shop photo, extracted
- `server/web/robots.txt`, `server/web/sitemap.xml` — new
- `server/src/middleware/security.ts` — the public allowlist
- fourteen `web/*` files repointed from `/` to `/signin.html`

## Still open

- **`easyshopauto.com` is hard-coded** in the canonical, Open Graph and sitemap
  URLs. If the marketing site ends up on a different domain than the app, those
  four files and `robots.txt` need the real one.
- **No favicon.** It is on the allowlist and referenced by browsers; it does not
  exist yet.
- **The DC mockups at the project root are now the second copy.** `Landing
  Page.dc.html`, `About.dc.html`, `SMS Terms.dc.html` and
  `Privacy Policy.dc.html` are where the design was worked out; `server/web` is
  what ships. Edit the shipped ones, or they will drift.
- **Nothing is verified against Google or Bing yet** — no Search Console
  property, so no sitemap submission and no crawl data. That is the first step
  toward actually climbing, and it is an afternoon of clicking rather than code.
- **No blog or comparison pages.** Ranking in "automotive CRM" listings is
  mostly earned with pages that answer specific questions — CCC One importing,
  wholesale billing, technician pay. The schema groundwork is in; the pages are
  not written.
- **No third-party listing profiles.** Capterra, G2 and Software Advice are where
  those searches actually land; they are directory submissions, not SEO.

---

# Unsubscribe — a0.6.0, 15 Sep 2026

The whole chain, built in one go: a link at the bottom of every automated
email, a public page that actually unsubscribes, a suppression list the mail
layer obeys, and the CRM refusing an unsubscribed address when somebody tries
to type it in.

Two migrations. Run:
`npm run build && npm run migrate && sudo systemctl restart easyshop`.

## The decisions this was built on

Settled 15 Sep 2026, and each one is written into the code where it applies:

- **Per shop, not platform-wide.** Each shop is its own controller, so an
  address that unsubscribed from one shop has not unsubscribed from another it
  does business with. Hard bounces and spam complaints are the exception and go
  platform-wide, because an address that does not exist is nobody's decision to
  override and sending to it again costs every shop its sending reputation.
- **No transactional exemption.** *If they unsubscribe, they unsubscribe* —
  password resets included. This has a real consequence, deliberately: a person
  who unsubscribes cannot receive a reset link. An owner sets their password
  for them, or they re-subscribe first. The message says exactly that rather
  than reading as a delivery fault.
- **Re-subscribing is the customer's**, never a desk tick. It happens on the
  public page, on a link the person is holding, which is what makes it their
  consent.
- **One list, two channels.** Unsubscribe and STOP are the same fact about the
  same kind of thing, so it is one table with a `channel` column. When Twilio
  goes live, STOP writes a row here and nothing else changes.

## Where the check lives

**`server/src/lib/mail.ts`, inside `sendMail`, and nowhere else.** Every send in
the application goes through that function, so it is the only place that can
promise an unsubscribed address is never written to. Putting the check in each
caller would mean the one caller somebody forgets is the one that breaks the
promise.

A refusal is **not** a failure. It does not touch the fail streak — the provider
is working perfectly, and five refusals in a row is not an outage. It comes back
as `{ ok: false, suppressed: true }` and lands on the message's delivery record
as its own state, `suppressed`, rather than `failed`. That distinction matters:
`failed` invites a retry, and a retry is the one thing that must never happen
to a suppressed address.

## Keyed on the address, not the customer

`suppressions.destination` is the email (lowercased, trimmed) or the number
(digits only). It is **not** a foreign key to `clients`.

This is the part that would have been easy to get wrong. If the suppression hung
off a client row, then editing the record, deleting it, or re-importing an
estimate that recreates the customer would quietly un-block the address. Keyed
on the address itself, none of those touch it.

Rows are never deleted. Re-subscribing sets `released_at`, so "has this address
ever unsubscribed" stays answerable — which is the question that gets asked when
somebody wonders why they stopped hearing from the shop.

## The link

Signed, not stored. The person clicking it usually has no account and must not
need one, so the link carries the shop, the channel and the destination, plus an
HMAC over those three under `COOKIE_SECRET`. Nothing to look up, nothing to
expire, nothing to enumerate, and no token table to keep in step with a customer
record that might change underneath it.

It also goes out as **`List-Unsubscribe` and `List-Unsubscribe-Post`** headers,
so Gmail and Outlook draw their own native Unsubscribe control. A message that
offers one is markedly less likely to be marked as spam than one where the only
way out is a footer link — this is deliverability work as much as compliance
work.

## The page

`server/web/unsubscribe.html`, public, no sign-in. Held to the same
accessibility bar as `checkin.html`, because it is the other page a shop's
*customer* touches and therefore the other Title III surface.

One click unsubscribes. No confirmation step and no preference maze — the
person came to make it stop. The address is **masked** on the page (`ch••••@…`):
the link can end up in a browser history, a support ticket or a screenshot, and
there is no reason to print somebody's whole address back at them.

It also tells the truth about what stopping means: the repair is unaffected, the
shop will call instead, and being told the vehicle is ready does not depend on
email.

A bounced address gets a different page — there is nothing for the person to
switch off, and re-subscribing is refused with a reason.

## The CRM half

Where an address is **typed by the desk**, it is refused with a sentence naming
what happened and when:

> chris@example.com unsubscribed on 3 Sep 2026 and cannot be emailed. It can go
> back on only if the customer re-subscribes themselves.

Not "invalid email" — that is the error that costs somebody twenty minutes and a
phone call on a perfectly valid address. Guarded in `clients.ts` (create and
edit), `ro.ts` (new file and file edit) and `leads.ts` (new lead). Each returns
409 with `field: 'email'` so the screen can mark the right input.

Where the address arrives **some other way**, it is carried and recorded rather
than refused, because refusing would block real work:

- **Check-in** — the customer's own hand on the keyboard. The address is theirs
  to give, so it is stored; the suppression stands, so they are not emailed.
  Refusing would block a check-in over a mail preference.
- **Converting a lead** — the car is being taken in. The address travels onto
  the file and simply never receives anything.
- **An estimate import** — the import is authoritative about the claim, not
  about consent. If the estimate carries an unsubscribed address the email field
  is dropped from that import's field list and reported on the new `heldBack`
  array beside everything that did move. Every other field overwrites as normal.

Every one of those writes a `suppression_hits` row, so a shop asking "why was
he never told" has an answer instead of a mystery.

## Files

- `server/db/migrations/master/006_suppressions.sql` — `platform_suppressions`
- `server/db/migrations/tenant/021_suppressions.sql` — `suppressions`,
  `suppression_hits`, and `suppressed` added to the delivery state enum
- `server/db/master.sql`, `server/db/tenant.sql` — schema of record
- `server/src/lib/suppression.ts` — new. The list, the signed links, the
  `refuseEmail` message, and `suppressedForUser` for the reset path
- `server/src/lib/mail.ts` — the check inside `sendMail`, the footer link,
  the List-Unsubscribe headers
- `server/src/notify.ts` — passes the shop and the link; records `suppressed`
- `server/src/routes/unsubscribe.ts` — new. Public, unauthenticated by design
- `server/src/auth/routes.ts` — a reset link is not sent to an unsubscribed
  address, checked before the token is minted
- `server/src/routes/clients.ts`, `ro.ts`, `leads.ts` — refuse the entry
- `server/src/routes/checkin.ts`, `ems.ts` — carry and report
- `server/src/server.ts` — registers the public routes
- `server/web/unsubscribe.html` — new

## Still open

- **Nothing shows the state on the file yet.** The desk finds out by trying to
  type the address. A line on the customer block saying "unsubscribed 3 Sep" is
  the obvious next piece, so somebody does not promise a customer an email that
  will never arrive.
- **No bounce webhook.** `platform_suppressions` exists and is obeyed, but
  nothing writes to it automatically — Resend's webhook is still the job that
  was deferred when email shipped. Until it lands, a hard bounce is a manual row.
- **No platform screen for the list.** Releasing a platform suppression is a
  SQL statement today.
- **`suppression_hits` is written but never read.** It wants a line on the
  audit screen or a small report; right now it is only evidence after the fact.
- The hit rows in `checkin.ts`, `leads.ts` and `ems.ts` are written on a
  separate connection from the surrounding transaction, so they survive a
  rollback. That is the behaviour I want — the attempt happened — but it is
  worth knowing rather than discovering.

---

# Email triggers, per event — 12 Sep 2026

One switch for "email me" was the wrong shape, and you spotted it before it
shipped to anybody. Eight kinds of notification go through `notify()` and they
are nowhere near equal: an assignment is worth an interruption, a status change
on somebody else's car is not. Left as one switch, the honest response is to
turn it off — and then the useful ones stop arriving too.

Master migration `005_email_events.sql`. Run:
`npm run build && npm run migrate && sudo systemctl restart easyshop`, then hard
refresh `account.html`.

## What you can set

A row per event under Account, each with a plain note about how often it fires:

| Event | Fires when | How often |
| --- | --- | --- |
| A car is assigned to me | somebody puts your name on a file | a few a week |
| A supplement is approved or denied | the carrier answers | a few a month |
| A file goes red | a car sits past the age you set | a few a month |
| A customer texts back | a reply lands on a file | a few a week |
| A part is late | an ETA passes with nothing received | a few a week |
| A part is flagged to go back | somebody marks a line for return | a few a month |
| Parts arrive | a line is received at the desk | many a day |
| A car changes status | any move you are routed for | many a day |

**Absent means off.** Switching email on turns on the first four — the ones
about you or about something going wrong — and leaves the rest to you. The two
marked *many a day* start off, which is the spam you were worried about.

**Status changes carry a scope the others do not need**: every car, or only the
ones you are assigned to. That is the difference between a handful a day and the
whole board.

Turning every event off switches email off outright, rather than leaving a
switch that says on and sends nothing.

The fifteen-minute throttle still applies on top of all of it, so a bad
afternoon is capped whatever is ticked.

## Files

`server/db/migrations/master/005_email_events.sql`, `server/db/master.sql`,
`server/src/lib/mail.ts`, `server/src/notify.ts`, `server/src/auth/routes.ts`,
`server/web/account.html`.

---

# Server build — a0.5.0, 12 Sep 2026

Email. Master migration `004_email.sql` (safe to run twice).

Run: `npm run build && npm run migrate && sudo systemctl restart easyshop`.
Add to `/srv/easyshop/.env` first:

    RESEND_API_KEY=re_...           # the rotated key, not the one pasted in chat
    MAIL_FROM=donotreply@easyshopauto.com
    MAIL_REPLY_TO=admin@easyshopauto.com

## How mail leaves

**Resend, over its HTTPS API.** Not Postfix, and not SMTP — same provider, same
verified domain, same DKIM signature, but no dependency to install on a live
box, no local queue to babysit and no TLS handshake to debug at 6am. If you
would rather have SMTP through `smtp.resend.com`, it is a small swap; say so.

A DigitalOcean droplet sending for itself was never the right answer: port 25 is
blocked by default, and a fresh IP with a generic PTR lands in spam even when it
is not refused outright.

**The From line names the shop**: *Bob's Body Barn via Easy Shop
&lt;donotreply@easyshopauto.com&gt;*, so somebody who works at two shops knows which
one is talking, while the address stays the one verified domain. Replies go to
`admin@`, which forwards to contact@stormrsolutions.com — nothing on the droplet
receives, so that forwarding is a DNS matter, not an app one.

## What sends

**Notification email, off by default.** Everyone already gets the in-app copy;
this is the one that also leaves the building, and nobody gets it until they
switch it on under Account. At most one every fifteen minutes per person — a
busy afternoon on the board can raise a dozen notifications, and a dozen emails
about them is how somebody decides to ignore all of them. Every attempt, sent or
failed, lands on the message's own delivery record, so "was he told" has one
answer in one place.

**Password resets**, both ways in:

- *Forgot your password?* on the sign-in screen. It answers the same whether the
  address exists or not — telling somebody which addresses are real is not a
  favour worth doing.
- *Send a reset link* from the People screen, for an owner or admin. Better than
  reading a temporary password down the phone: nothing is said aloud, nothing is
  written on a card, and the link dies in an hour. The temporary-password path
  stays for anyone with no email address.

The link is one use, an hour long, and the database keeps only its hash. Setting
a password ends every session that account had.

## When it breaks

Five failures in a row is an outage; one bad address is not. The counter resets
on the first success. **The alert is not an email** — telling somebody that
email is broken by email is a joke that writes itself — it is a
`mail.failing` row in the platform log and a red bar across the platform screen,
which also says plainly when there is no key on the box at all.

Bounces are recorded, not acted on: a bouncing address stays switched on until
somebody decides otherwise.

## Files

`server/db/migrations/master/004_email.sql`, `server/db/master.sql`,
`server/src/config.ts`, `server/src/lib/mail.ts`, `server/src/notify.ts`,
`server/src/auth/routes.ts`, `server/src/routes/admin.ts`,
`server/src/routes/platform.ts`, `server/src/middleware/context.ts`,
`server/web/reset.html` (new), `server/web/index.html`, `server/web/account.html`,
`server/web/platform.html`.

## Not in this build

Customer-facing mail — status updates to the vehicle owner — is deliberately
absent. That copy is the same wording SMS will use, and it should ship with SMS
rather than twice. Invoices and statements wait for the invoicing port.

---

# Fix — a new shop was built from a schema that had drifted, 12 Sep 2026

The demo shop provisioned, seeded and appeared on the board, and then every
file drawer on it 500'd: **Unknown column 'is_image' in 'SELECT'**.

`documents.is_image` arrived in tenant migration 002 and was never folded back
into `tenant.sql`. Existing shops have it — they were migrated. A new shop is
built from the base file alone, so it did not. The same was true of
`deductible_cents`, declared twice in that file, which is what stopped the
provision before this.

Two fixes, because one of them is the actual problem:

- **`tenant.sql` brought back in step**: `documents` gains `source_mime`,
  `width`, `height`, `is_image`, `is_pdf` and the image index; the duplicate
  `deductible_cents` on `repair_orders` is gone.
- **Provisioning now replays every tenant migration** over the newly created
  database, skipping what the base file already provided. `tenant.sql` is the
  schema as somebody remembered to write it down; the migrations are the schema
  as it actually grew, and only one of those two is guaranteed complete. A new
  shop now lands at the same `schema_version` as every other one, whatever the
  base file forgot — so this class of bug cannot come back.

To fix the demo shop that is already half-built, either press **Reset now**
after this build (provisioning is skipped — the company exists — so run
`npm run migrate` first to bring `es_demo` up), or drop it and let Reset now
rebuild it from scratch:

    mysql -e "DROP DATABASE IF EXISTS es_demo; \
              DELETE FROM easyshop_master.company_databases \
               WHERE company_id = (SELECT id FROM easyshop_master.companies WHERE slug='demo'); \
              DELETE FROM easyshop_master.companies WHERE slug='demo';"

`npm run build && npm run migrate && sudo systemctl restart easyshop`.

---

# Server build — a0.4.0, 12 Sep 2026

Platform roles, a break-glass root account, and the demo shop. Master migration
`003_platform_roles_demo.sql` (safe to run twice).

Run: `npm run build && npm run migrate && sudo systemctl restart easyshop`.

## Root, and why it is switched off

`users.platform_role` is `none` | `admin` | `root`. Everyone who held
`is_platform_owner` becomes an **admin**; the flag stays and is kept in step, so
nothing that reads it had to change.

**Root cannot sign in unless `ROOT_ENABLED=1` is set in `.env` and the service
restarted.** Knowing root's password is not enough to reach it from the
internet — the door is opened at the box, by you, deliberately. With the flag
off, an attempt is refused *and written to the platform audit* as
`root.refused`, so a password that leaked announces itself.

When it is on:

- every sign-in writes `root.signin` with the address it came from;
- the platform screen carries a red banner naming the account for the whole
  session, and a reminder to switch it back off;
- root can do everything an admin can, **plus** manage platform admins, delete a
  shop, and reset any shop owner's password.

Root is created from the box and nowhere else — no screen can make one:

    npm run platform -- root  you@example.com "Your Name"
    npm run platform -- admin chrisj@stormrsolutions.com "Chris J"
    npm run platform -- list

## Platform admins

Everything except the two things above. Concretely: they can create shops,
suspend and un-suspend them, flip features, enter a shop, and reset a shop
owner's password. They cannot see or manage other admins — an admin who could
make an admin is an admin who could keep themselves in after being removed —
and they cannot delete a shop. **Deleting asks for the slug to be typed**, and
is root's alone; suspending is reversible and is the admin's tool.

## New shops, from the screen

`POST /api/platform/companies` has existed since the platform screen did;
nothing on the screen called it. There is a **New shop** form now: name, slug,
city, state, shop type, seats, owner name and email. It provisions the database,
seeds the board from the shop type, creates the owner and shows their first
password once.

## The demo shop

**Bob's Body Barn**, Testingville, Texas — collision and hail. Two PDR techs,
four body, two paint, one detail who also preps and buffs, plus the office.
Mostly insurance with a few dealer cars (Lone Star Ford, Caprock Chevrolet,
Bluebonnet Hail Co) and a few cash-pay.

It is a **real shop on the live box**: a visitor can check a car in, upload a
photo, order a part, close a file. A demo you cannot touch proves nothing.

- Seeded with twelve cars — nine live across the board's own statuses, three
  closed with real receipts against them, one of those still owing so the chase
  list has something on it. Parts on order, received and back-ordered; seven
  leads at different stages; flagged labour on the closed files, so payroll has
  a week in it.
- **Reset at 2am Central every night**, and from **Reset now** on the platform
  screen. Anything a visitor did goes with it.
- Every destructive step is gated on `companies.is_demo`. A company without
  that flag cannot be reset by this code whatever id is passed in, so it can
  never be pointed at a real shop.
- The shared login is **tester@bobsbodybarn.demo**, an owner of that shop so the
  whole app is reachable. **New Tester password** on the platform screen
  generates one and shows it once — rotate it before each demo.
- The seed reads the shop's own statuses rather than naming slots, so a renamed
  board still seeds correctly.

## Files

`server/db/migrations/master/003_platform_roles_demo.sql`, `server/db/master.sql`,
`server/src/config.ts`, `server/src/middleware/context.ts`,
`server/src/auth/routes.ts`, `server/src/auth/password.ts`,
`server/src/lib/demo.ts`, `server/src/routes/platform.ts`,
`server/src/scripts/platform.ts`, `server/src/server.ts`,
`server/web/platform.html`, `server/package.json`.

## Still to do

The demo's own guard rails — capping uploads, wiping them on reset, and marking
demo data as demo on every screen — are **not** in this build. The nightly reset
clears the work; a visitor can still upload as much as they like between resets.
Worth doing before the link goes to anybody you do not know.

---

# Close-out labour block, rebuilt — 12 Sep 2026

Queued as clutter, and it was: six columns for three facts, with Tech and Trade
colliding on any long name — *Chuy Alverez (also body)Paint*.

Three columns now: **who**, **paid on**, **cost**.

- The **trade is a chip beside the name**, and the other trades they work drop to
  the line underneath, so nothing can run into anything.
- The **rate column is gone.** It read "—" on most rows. The rate is now part of
  a sentence that also says how the figure was reached: *6.2 hrs at $34.50*,
  *12.5% of $4,582.19, after parts at cost*.
- **Figure and cost sit together** — you type on the left, the money is beside
  it, rather than two columns apart with a unit floating between them.
- **Basis is a select.** A percentage is open to every trade now, so there are
  four options; three buttons was already tight. PDR still offers its two.
- A row **flagged on the floor** says so, so the desk knows what it is confirming
  rather than entering.
- A missing rate reads as English — *no rate set — enter a flat figure, or set
  one on their person sheet*.

Web only: hard refresh `board.html`. No build, no migration.

---

# Fix — Status messages grid, 12 Sep 2026

The grid 500'd on every load. The query behind it was written against column
names the schema never had: `s.module`, `s.enabled`, `g.id`, `g.name` and
`g.lane_key`.

The real shape, for the record: a status carries its own `lane_key` and
`module_tags`, hides behind `visible` rather than `enabled`, and a status group
is keyed by `group_id` with its title in `label` — there is no `id` and no
`name` on that table. The endpoint now selects those and aliases them to what
the screen already expects, so nothing on the page changed.

`npm run build && sudo systemctl restart easyshop`. No migration —
`019`/`020` are unaffected, and `status_routes` itself was always fine.

---

# Fix — the audit log, 12 Sep 2026

The reader 500'd on every load and the screen said "Something went wrong."

**`sensitive` is a reserved word in MariaDB.** The header's tally query aliased a
column `AS sensitive` unquoted, which is a syntax error. It has been wrong since
the audit log shipped; what changed is that this shop's MariaDB build is the one
that refuses it. Quoted now.

**The reader no longer dies with it.** Each piece of the read runs on its own: if
the main query fails, the entries come back through a simpler one with no joins
and no `detail`, and the header says which part failed and what the database
said. An audit log drawing fewer columns beats one that cannot draw — and the
reason is now readable without SSH.

`npm run build && sudo systemctl restart easyshop`, hard refresh `audit.html`.
No migration.

---

# Fix — a flagged tech showed as zero at close, 12 Sep 2026

Reported off a real file: a tech flagged on RO 002719, then close-out offered
`$0.00` for him as though nothing had been flagged at all. Three faults behind
it, all the same shape — the flag and the close-out sheet did not agree on how a
figure is stored.

- **A flat dollar lives in `ro_labour.hours`.** That is the close-out sheet's own
  convention — `priceEntry` reads a flat row straight out of `hours` — and the
  flag wrote the amount to `cost_cents` instead, leaving `hours` at zero. The
  sheet then recomputed the row as nothing. The flag now writes the figure where
  the sheet reads it, and reads it back from there.
- **A percentage was PDR's alone.** The sheet offered % only to PDR, so a body
  tech flagged at 12.5% came back as hours with nothing in them. Any trade on a
  percentage now gets the % option — PDR still gets `$` and `%` only, because
  its share is of the whole job — and the sheet prices it live against the
  approval net of parts at cost.
- **A percentage row saved as zero.** `saveCloseout` wrote `cost_cents = 0` for
  every percentage row, PDR's being the only one the profit sheet priced later.
  Every other trade is priced before the row is written, so payroll reads a
  figure rather than a zero.

The sheet also now **says which rows were already flagged**, and by whom, so a
figure that came from the floor is visible as such.

Web and server: `npm run build && sudo systemctl restart easyshop`, hard refresh
`board.html`. No migration. **Anything flagged before this fix should be
re-flagged** — the rows carry the amount in the wrong column and will keep
reading zero until they are written again.

---

# Server build — a0.3.1, 12 Sep 2026

Follow-up to a0.3.0, same day: payments become three permissions, a payment can
be corrected, and the reference field follows the method. Migration
`020_payment_permissions.sql` (safe to run twice).

## Three permissions, not one

Seeing what has been paid, taking a payment, and changing one after the fact are
three different answers in a shop. Roles & permissions now carries:

| Capability | See | Change |
| --- | --- | --- |
| Payments on a file | see the balance and the receipts | record a payment |
| Edit or void a payment | correct or void one already recorded | — |

Seeded so nobody loses a screen they had this morning: owner everything;
accounting takes and edits; front office takes; estimator reads; and anyone who
could already see repair-order totals can at least see the balance. Everything
else is ticks on the Permissions screen.

## Correcting a payment

`PATCH /api/payments/:id` — amount, method, payer, reference, note, received
date. The correction is a **change with a before and an after in the audit log**,
not a delete and a re-entry: the figure that was wrong is part of the record.
The one-number-per-file rule still holds, except that a payment may keep its own
number. Edit is on each receipt in the file drawer and on each line in the
closed board's Adjust dialog, so a wrong figure on a paid file can still be
fixed.

## The reference field follows the method

| Method | Field | Required |
| --- | --- | --- |
| Check | Check number | yes |
| Insurance draft / EFT | Draft number | yes |
| Card | Transaction ID | no |
| Cash | none — note only | — |
| Write-off / discount | none — note only | — |

Every payment keeps the optional note. The labels and the required flag come
from the server with the method list, so the drawer and the closed board cannot
drift apart on them.

---

# Server build — a0.3.0, 12 Sep 2026

Three queued items built together: recording payments against a file, paying
technicians a percentage by job type, and flagging techs before the close. One
migration, `019_payments_pay_plans_flags.sql`.

Run: `npm run build && npm run migrate && sudo systemctl restart easyshop`, then
hard refresh `board.html`, `closed.html` and `admin.html`.

## Payments — paid is the balance now

`ro_payments`, one row per receipt: amount, method, payer, received date,
reference, note, who recorded it. `repair_orders.paid_cents` caches the live
sum and `paid` follows it, written by `recount()` in `server/src/lib/payments.ts`
and by nothing else.

- **The number rule is the database's.** A stored generated column `ref_key`
  (`method:reference`, NULL when there is no number or the row is void) under a
  unique index on `(ro_id, ref_key)`. One draft can pay four files; the same
  draft twice on one file is refused, and the message names the payment it
  collides with rather than saying "duplicate".
- **Check and insurance draft require their number**; cash, card and write-off
  have no number field at all. Every payment takes an optional note.
- **One modal, three ways in.** `board.html` grew a Payments section in the file
  drawer with a Record payment button; the close path opens the same modal when
  the file is marked closed with a balance showing, where **Save and add
  another** keeps it open for the next check; `closed.html`'s Adjust dialog
  carries the same form for a closed file that pays later.
- **The close no longer asks paid or not paid.** `POST /api/ro/:id/close`
  derives it, and the `paid` toggle is gone from both the drawer and the Adjust
  dialog. A `paid` in the body is ignored rather than overwriting the receipts.
- **The close date never moves for a payment.** Money landing in October against
  a file booked to September leaves the booking alone; the payment carries its
  own received date.
- **Voiding, not deleting.** A wrong payment is voided with a reason; the row
  stays, the money comes off the balance, and both facts are in the audit log.
- Files already flagged paid by hand keep the flag and get `paid_cents =
  amount_cents`. No receipts were invented for them — that would put money in
  the record nobody took.

## Pay plans, per job type

`staff_pay_plans`, one row per person per job type: wholesale, retail and
insurance, cash quote. Each is a percentage, a flag rate, or a flat figure, and
a percentage carries two numbers — with paint and body only.

**The percentage runs off the approved amount after any parts we bought come out
at cost.** A $450 wholesale car with no parts pays $56.25 at 12.5%; a $6,482.19
file carrying $1,900 of parts runs 12.5% off $4,582.19 and pays $572.77. Sublet
is not deducted — the rule as given names parts.

Job type is **derived, not stored**: a wholesale client makes it wholesale, a
carrier or a claim makes it insurance, anything else is cash. **Has paint** means
paint labour on the estimate or a painter flagged with hours — an assignment
that never worked does not halve a body tech's pay.

The migration seeds every person's three job types from the rate they were
already on, so nothing moves until somebody sets a percentage.

## Flagging, before the close

`ro_labour` — the table close-out has always written — gained `flagged_at`,
`flagged_by`, `flagged_by_name` and `pct_base`. A trade is now settled while the
car is still in the shop, and `suggestLabour` already prefers a saved row, so
the close-out sheet reads what the shop agreed instead of asking again.

- **One row per trade, and only where somebody is assigned.** No two techs of a
  trade on one file, so nothing splits and there are no empty rows to tick past.
- Each row is entered the way it is paid — **% / $ / hrs** — starting on
  whatever the plan says and changeable for this file alone. The server prices
  it; the browser never decides what anyone earns.
- The drawer shows the state without opening anything: how many trades are
  flagged, what that comes to, and a warning while any are not.
- A closed file keeps what it settled on. Changing a percentage later does not
  move money on a file that already booked.
- `profit.ts` now prices a percentage row for **any** trade, not only PDR.

## Flagging is what puts money on payroll

Payroll used to date a line by `repair_orders.closed_at`: a car only paid once
its file closed. That is wrong now that flagging exists — a file can sit unclosed
for weeks waiting on an insurance draft, and the tech who finished it in March
should not be paid in May.

- `linesBetween` in `server/src/lib/payroll.ts` now windows on
  `ro_labour.flagged_at` and requires it to be set. `closed_at` is no longer a
  condition at all, so **an open file's flagged trades appear on this week's
  sheet**.
- **Closing flags what it settles.** `saveCloseout` stamps `flagged_at` on every
  row it writes, so "flag at close" lands the same way "flag on the floor" does.
  A row that was **already** flagged keeps its original flag time — closing a
  March car in May does not drag March's money into May's period.
- The payroll sheet dates each line by the flag and marks a car still in the
  shop **in shop**, so a sheet with unclosed cars on it reads honestly.
- A paid period is still read back from its snapshot, untouched.

## The People screen

Every row rendered all eight role chips and all nine trade chips whether held or
not — seventeen buttons per person, of which two or three were on.

- The row states what is true: name and sign-in, primary role with the rest as
  "and technician", trades as words, and pay in a line.
- Editing moved into a **person sheet** — Details, Access, Pay — and *Add
  someone* opens the same sheet empty. The wide add panel is gone.
- Sign-in code, password reset and remove are one tap behind a ⋯ on the row.
- Filter chips across the top, including **No pay plan**, which is the list
  worth chasing after this build.
- `GET /api/staff/rates` now carries each person's plans so the list can
  summarise pay without a request per row.

## Files

`server/db/migrations/tenant/019_payments_pay_plans_flags.sql`,
`server/db/tenant.sql`, `server/src/lib/payments.ts`, `server/src/lib/tech-pay.ts`,
`server/src/lib/profit.ts`, `server/src/routes/money.ts`,
`server/src/routes/closed.ts`, `server/src/routes/closeout.ts`,
`server/src/server.ts`, `server/web/board.html`, `server/web/closed.html`,
`server/web/admin.html`.

## Still open, deliberately

Whether the balance should be owed against the approval plus approved
supplements rather than the approval alone. Whether recording a payment should
move the file to Payment Collected. Whether sublet comes out at cost the way
parts do. And the 382 paid rows in the live data still carry a bare flag with no
receipts behind them.

---

# Server build — a0.2.9, 10 Sep 2026

Three queued items built together: an estimate written on a lead, a routing grid
for who a status change messages, and the parts detail as a modal with cost
entered at order. One migration.

```
npm run build && npm run migrate && sudo systemctl restart easyshop
```

`server/web/*` is served off disk — leads, parts and permissions each need a hard
refresh in the browser after the copy.

## 1 · Estimate written on a lead

The shape of the day this is for: they walk in, the details go in as a lead, an
estimate is written at the counter, and somebody chases it days later. A lead
with no estimate has to chase exactly the same way, so none of the follow-up
machinery changed.

**Two states, not one.** `estimate_written` is the estimate written here and it
carries the figure; `estimate_sent` is the insurer's and carries no amount of its
own. **Cash-pay stops at written** — only insurance work reaches sent, so the
lead now records who is paying (`leads.payer`, cash by default). *Mark estimate
sent* only appears on an insurance lead; a cash one says it stops here. The state
dropdown hides Estimate sent on a cash-pay lead rather than offering it and then
refusing the change, and the endpoint refuses it either way.

**The amount is required.** `POST /api/leads/:id/estimate` takes the figure in
the same request that sets the state; `PATCH` refuses `estimate_written` on a
lead with no `estimate_cents`, which is why the state option is disabled and
reads "needs an amount" until there is one. Written-on defaults to today and is
editable — an estimate written Friday may not be entered until Monday.

**Re-quoting overwrites.** The latest figure is the number the shop works from;
the one it replaced becomes a `lead_events` row of the new `estimate` kind
("Quote changed from $3,150 to $4,280") and an audit entry. There is no second
number to reconcile.

**On convert, quoted stays apart from approved.** The figure goes onto the file
as a note saying so, and deliberately does not fill the approval amount. They are
different numbers and the only way to compare them later is to keep them apart
now.

**Two KPIs changed.** In: a **money close rate** (won dollars over quoted
dollars) and **quotes not chased** — written, still live, and no follow-up logged
*since the quote existed*; chasing before it does not count. Average quote
replaces average first reply; unanswered stays. **A lost lead's quote stays in
the quoted total** — it is a lost quote, and dropping it would flatter the rate.

A **Quoted** tab joins the state tabs. The row's *Not chased* tag only shows when
nothing else is speaking in that cell: a quote and a chase together were two
stacked pills in a 46px row on a phone.

Mockup: `Leads Mobile.dc.html` turn 2.

## 2 · Who a status change messages

**`status_routes`** — one row per status per recipient, keyed on `slot_id`
because slot ids are canonical: renaming a status must not move who hears about
it. Edited at **Roles & permissions › Status messages**, a grid of every status
on the shop's board against ten targets.

**Two kinds of target.** Six are roles (owner, production manager, parts manager,
estimator, front office, accounting) and message everyone holding the role. Four
are **the person assigned on this file** — tech (body or R&I), PDR tech, painter,
detail — and message that person only. An unassigned trade messages nobody rather
than falling back to everyone who could have done the work. A person holding
several roles is messaged once.

**A status with no rows messages nobody, deliberately** — `qa.wash` ships that
way and is the only one. That is why "has this shop configured routing?" is asked
of the table as a whole and never per status: while `status_routes` is empty the
old `NOTIF_GROUPS` router still runs, and the moment any row exists the grid
governs `status.change`, zero rows included.

`NOTIF_GROUPS` is not removed and still seeds: it carries the other seven events
(parts arrivals, stalls, SMS replies). Only `status.change` is taken over.

Saving replaces the table inside one transaction, so a save cannot half-apply.
Deleting a role moves its routes to the role its people were moved to — an
INSERT IGNORE then a delete, because the primary key would collide where the
destination is already routed on that status.

The shipped defaults live twice on purpose: as SQL in migration 018 for shops
that already exist, and as `DEFAULT_ROUTES` in `lib/status-routes.ts` for new
shops and for *Reset to default*. Both are joined against the shop's own
`statuses`, so a PDR-only shop gets no `lane.body.*` routes.

Mockup: `Permissions.dc.html` turn 2.

## 3 · Parts detail — the modal, and cost at order

**The drop-down is gone.** Clicking a file opens its lines as a modal over the
list. Seventeen lines expanded under the row pushed every other file off screen,
and arrived flat.

**Four stages on a rail** — To order, On order (ordered and partial), Back order,
Received — each with its count, list total, and the one thing worth knowing about
that stage (oldest ETA, lines past ETA, last arrival). The pane shows one stage.
The file opens on the first stage with work in it rather than always on To order.

**Eleven columns at 36px**: part, part #, type, qty received of ordered, vendor,
status, order #, ETA, list, cost, PP. The complaint was never the column count.

**Cost is not known until the order goes in.** A to-order line reads *at order*;
an ordered line nobody has costed reads *cost pending*. The rail's totals read
**Cost so far**, parts profit is computed on priced lines only, and a note says
how many lines are unpriced and why. `bulk-order` now takes a cost per line
(gated on `caps.money`, audited per line), and the order screen will not confirm
until every line has one — for a desk without money capabilities the order still
goes through and the cost is typed later by somebody who can.

**The estimate's type is kept beside the ordered one.**
`parts_lines.part_type_estimated` is what the estimate called for; `part_type` is
what is being bought. The EMS import fills both and only ever writes the
estimated column; the desk changes the ordered one, on the row or in the order
screen, where the estimate's type is marked "on the estimate". Where they differ
the row shows *est oem* beside the type. Existing lines were seeded estimated =
ordered, so "differs from the estimate" means something from here rather than
flagging the back catalogue.

**Per-line action is the status cell.** Click a Needed line's status and the
order screen opens for that line alone; click an ordered one and it is received.
Ticking lines and using the bottom bar does the same in bulk — several lines to
receive go through the receive screen, which is where short counts and the
invoice number are recorded.

One vendor and one order number per order. A mixed order runs twice, and the
screen says so.

## Files

- `db/migrations/tenant/018_estimate_routing_part_type.sql` — the lead's estimate
  columns and payer, the `estimate` event kind, `status_routes` and its seed,
  `parts_lines.part_type_estimated`
- `db/tenant.sql` — the same shape for a shop provisioned fresh
- `src/lib/status-routes.ts` — new: the targets, the defaults, recipient
  resolution, the transactional save
- `src/notify.ts` — `slotId` on the input; `status.change` routes off the grid
  when the shop has one; the write half split into `deliver()`
- `src/routes/ro.ts` — passes the slot on the status-change notification
- `src/routes/notifications.ts` — `GET/PUT /api/status-routing`,
  `POST /api/status-routing/defaults`
- `src/routes/roles.ts` — a deleted role's routes follow its people
- `src/db/provision.ts` — a new shop gets routing rows from the first file
- `src/routes/leads.ts` — the two states, payer, `POST /api/leads/:id/estimate`,
  the money summary, the quoted note on convert
- `src/routes/parts.ts` — `part_type_estimated` in and out, per-line cost and
  type on `bulk-order`
- `src/routes/ems.ts` — the import fills the estimated type
- `web/leads.html` — the estimate block, the payer, the Quoted tab, the KPIs
- `web/parts.html` — the file modal, and the order screen's costs and types
- `web/permissions.html` — the Status messages grid

## Worth checking after the migration

```sql
-- Statuses nobody hears about. One is expected (Initial Wash).
SELECT s.slot_id, s.label FROM statuses s
 LEFT JOIN status_routes r ON r.slot_id = s.slot_id
 WHERE s.enabled = 1 AND r.slot_id IS NULL;

-- Lines whose ordered type differs from the estimate, now that both are kept.
SELECT COUNT(*) FROM parts_lines
 WHERE part_type_estimated IS NOT NULL AND part_type <> part_type_estimated;
```

## Still open

Whether the assigned four should fall back to the lane's role owner when nobody
is assigned (today: nobody is messaged). Whether a shop reticking the grid should
get a preset per shop type the way roles do. Whether the *Not chased* tag and the
*Follow up* tag should ever both show. Whether ordering from two vendors at once
deserves a grouped screen rather than running the order twice.

---

# Server build — a0.2.8, 7 Sep 2026

Closed and delivered files coming off the board properly. Three bugs, one root
cause: "open" was defined as `closed_at IS NULL` in nine places, and
`closed_at` is the pickup stamp, not the close.

**One definition of open.** `close_date` is the books date and the flag for
"closed properly" (migration 010); `closed_at` is the moment the car left. A
file with the books date and no pickup stamp — imported history, anything
back-filled, anything closed before 010 — passed `closed_at IS NULL` and sat on
the open board for good. Open is now `close_date IS NULL AND closed_at IS NULL
AND voided_at IS NULL`, everywhere:

- `server/src/routes/board.ts` — the board list, the assignments query, and
  `/api/board/summary`, so the KPI strip stops counting them. The Closed
  checkbox now matches on either stamp and windows on
  `COALESCE(close_date, DATE(closed_at))`.
- `server/src/routes/reports.ts` — the shared open-only scope, the stalled and
  on-hold list, both status-load joins, the unapproved list, and all four
  `open_files` counts.
- `server/src/routes/ems.ts` — the four estimate-to-RO matchers (RO number, VIN,
  VIN tail, claim number), so an EMS import cannot attach to a closed file.

The board row payload also carries `closeDate`, `closedAt` and `paid` now: the
cycle view groups on them, and it was reading fields that were never sent.

**What the Complete checkbox hides.** It was a positive filter only — tick it and
you saw complete files, leave it and they were mixed into the board. Now the
close itself is off the board unless asked for: File Closed and anything a shop
has marked terminal (`closingSlots()`). It comes back with Complete ticked, with
that group picked, or with one of its statuses picked. Vehicle Ready and the
delivered statuses are **not** hidden — the car is finished or gone, but the file
is still open work, and hiding it is how a car gets forgotten in the lot.

**Ready and Delivered are their own lanes on the cycle view.** Neither carries a
`lane_key`, so both were reading as "Not in a production lane", which is true and
useless. They now get headings after the production lanes, in the order a car
leaves: **Ready** (the Vehicle Ready group — done, still here), **Delivered**
(past Vehicle Ready, not a closing slot — gone, file open), **Closed** (only
present when Closed is ticked). Total loss still forces lane 00 whatever the
status. The print caption says "closed-out files left off".

No migration. Nothing added to the schema and no column meaning changed —
`close_date` is being read where it always should have been.

**Deploy:**

```
npm run build && sudo systemctl restart easyshop
```

`server/web/board.html` is served off disk, so it needs a hard refresh in the
browser and nothing more.

**Worth checking on each shop, before the restart** — this says how many files
the old predicate was leaking onto the board:

```sql
SELECT COUNT(*) FROM repair_orders
WHERE close_date IS NOT NULL AND closed_at IS NULL AND voided_at IS NULL;
```

---

# Server build — a0.2.7, 30 Aug 2026

One database login per shop. Closes the second half of audit finding 08 — see
`Per-Tenant Credentials Plan.dc.html` for the reasoning and the decisions.

The state before this: `provisionCompany` never created a MariaDB login at all.
Every `company_databases` row carried `db_user = config.db.user`, so one login
opened every shop's database. The per-shop credential the master schema
anticipated had never been built.

**`server/src/lib/tenant-credentials.ts`** (new) — derivation and grants.
Passwords are HMAC-SHA256 over `es-tenant:v1:<companyId>` keyed by
`TENANT_MASTER_SECRET`, base64url, 40 chars. Derived, never stored: nothing to
keep in sync and no secret-writing step at provision time. Company **id**, not
slug — a shop can be renamed. The `v1` prefix is what makes rotation later a
bump rather than a redesign. Login name `es_t<id>`, host `localhost` for
loopback databases and `%` otherwise (off-box already gets forced TLS from
a0.2.5). Grants: SELECT, INSERT, UPDATE, DELETE, EXECUTE on that one database.
No CREATE/ALTER/DROP — migrations keep running on the admin connection, so an
injected statement cannot rewrite the schema it runs against.
`verifyTenantLogin` asks three questions: reads its own database, refused on
another, refused on DDL.

**`server/src/db/tenant.ts`** — pool password now comes from `tenantPassword()`.
A row reading `DERIVED` with no master secret **throws**, naming the shop and
the fix, rather than falling back to the shared login. That was a deliberate
call: a silent fallback is how a half-finished migration looks finished.

**`server/src/db/provision.ts`** — new shops get their own login inside the same
sequence that creates the database, and the login joins the rollback path. Falls
back to the shared login only when no master secret is set, so a box mid-migration
can still take on a shop.

**`server/src/scripts/tenant-creds.ts`** (new) — `npm run tenant-creds`.
Dry run by default; `--go` acts, `--shop <id>` narrows, `--audit` reports who is
on what and re-proves the fences, `--revert --shop <id>` puts one shop back.
Per shop: create, grant, **verify, then** repoint — so a shop is never pointed at
an untested login. Stops at the first failure; shops after it are untouched.

**`server/.env.example`** — `TENANT_MASTER_SECRET`, plus the vars added in
a0.2.5/a0.2.6 that were never written down: `SESSION_IDLE_DAYS`, `DB_SSL`,
`RETENTION_*`.

No migration. `secret_ref` is already `VARCHAR(64)`; `DERIVED` is just a value.

**Deploy, in this order:**

```
openssl rand -base64 32          # put it in .env as TENANT_MASTER_SECRET
                                 # and in a password manager, off the box
npm run build && sudo systemctl restart easyshop
npm run tenant-creds             # dry run — reads only, changes nothing
npm run tenant-creds -- --go --shop <your test shop>
#   open that shop's board, then:
npm run tenant-creds -- --revert --shop <same> --go   # prove rollback works
npm run tenant-creds -- --go     # the rest, one at a time
npm run tenant-creds -- --audit
```

**Then the step that actually closes the finding** — only once `--audit` shows
every shop on `DERIVED`:

```
REVOKE ALL PRIVILEGES ON \`es_%\`.* FROM '<DB_USER>'@'localhost';
FLUSH PRIVILEGES;
```

Everything before that only prepares for it. Removing the `DEFAULT` fallback in
`config.tenantSecret` is a separate, later change — until then it is the rollback
path and has to keep working.

**Note for the restore drill:** a dump restored onto a rebuilt box needs the
logins recreated too, not just the data loaded — `npm run tenant-creds -- --go`
does it. Without that the drill passes while the real thing fails.

---

# Server build — a0.2.6, 30 Aug 2026

Internal-pages accessibility, starting with the shared chrome. Answers to 08 and
09 are in `Encryption and Backups Runbook.dc.html` — commands, not prose.

**`server/web/shell.css`** — `--dim` moved from #7f8ca4 (about 4.3:1 on the
ground, under the 4.5:1 small text needs) to #9aa6bc (about 5.9:1). One variable,
every page: sub-labels, column subtitles, hints, the tab bar, the inbox. Still
reads as the quiet step below `--muted`. Added `.sr-only`, `.skiplink` and an
`[aria-invalid]` border.

**`server/web/shell.js`** — `landmarks()` runs on every `Shell.mount`: `role=banner`
on the bar, `role=navigation` + label on the nav, `aria-current="page"` on the
selected link, and the page's existing body element promoted to `role=main` with
a "Skip to content" link as the first tab stop. No page restructuring — twenty
pages of divs get labelled where they are. Also `Shell.announce(text)` and one
shared `role=status` live region, because every screen writes results by
replacing innerHTML, which announces nothing.

**`server/web/board.html`** — days-in-shop was colour alone (1.4.1), which is the
board's whole point for a colourblind writer: `AGE_WORD` now rides along with the
colour ("12d of 10 late") in cards and as `.sr-only` in the table. The drawer
claimed `role="dialog"` and toggled `aria-hidden="false"` on a visible element,
which is a no-op that reads as a fix: it is now `aria-modal` + `aria-labelledby`,
genuinely hidden when shut, focus moves to it on open and returns to whatever
opened it on close. Eleven placeholder-only inputs in the drawer and the filter
bar got `aria-label`. `say()` announces.

**Not done, and it is the larger half:** the other pages' own controls. parts,
payroll, pay, leads, closed, clients, admin, reports, messages, schedule and the
platform screens each have their own placeholder-as-label inputs, their own
dialogs and their own silent updates. The shared fixes above cover contrast,
landmarks and the skip link everywhere; per-page work is per page. `sales.html`
stays untouched per CLAUDE.md.

Deploy: `server/web/*` is served off disk — copy the files and hard refresh. No
build, no migration, no restart.

---

# Server build — a0.2.5, 30 Aug 2026

Second security pass. The rest of the audit's code findings, plus retention and
the check-in page's accessibility.

**`server/db/migrations/tenant/016_retention.sql`** — `repair_orders.archived_at`
and `purged_at`, plus a `retention_runs` table so every pass leaves a receipt.

**`server/src/jobs/retention.ts`** (new) — the decision: forever as a record, ten
years as the outer limit, archival at one. Archive at 12 months drops thumbnails
and rendered pages (a cache, remade on demand — reversible). Purge at 10 years
removes documents from disk, clears claim/policy/adjuster columns, and clears a
retail customer's contact details when no unpurged file remains. Wholesale and
insurance clients are never touched. The accounting shell always stays.
**Dry-run until `RETENTION_ENABLED=1`** — both passes log what they would delete
into `retention_runs`. Read one before switching it on. Runs daily.

**`server/src/lib/storage.ts`** — `ALLOWED_EXT` narrowed to the six the shop
asked for: jpg, jpeg, png, heic (+heif), gif, pdf. HEIC is accepted but not in
`PREVIEWABLE`, so it downloads rather than rendering; the viewer uses its JPEG
thumbnail as before. **Behaviour change:** xls/xlsx/doc/docx/txt/csv/zip are no
longer accepted as documents. Separate `EMS_EXT` list for estimate sets.

**`server/src/routes/ems.ts`** — estimate uploads now check `emsExtAllowed`.
They were the one path with no list at all.

**`server/src/config.ts`, `db/master.ts`, `db/tenant.ts`** — `SESSION_IDLE_DAYS`
default 1 (your call: daily). `DB_SSL=1` for TLS to MySQL everywhere, and a
tenant whose `db_host` is not loopback gets TLS with cert verification whether or
not anyone set it. Retention config block.

**`server/src/lib/audit.ts`** — new `Access` area and `auditRead()`. Records who
opened payroll, an individual pay sheet, the revenue report, and the client list.
Debounced in SQL to one entry per person, per view, per hour — the board polls,
and a row per poll would make the log unreadable. Wired into `payroll.ts`,
`reports.ts`, `clients.ts`; `Access` added to the reader's area filter.

**`server/src/server.ts`** — the error handler no longer logs the raw error
object. Fastify hangs the request off a thrown error and `log.error(err)` walked
into it, putting request bodies — customer names, phone numbers — into journald.
Now message, stack, route and ids only.

**`server/src/auth/session.ts`** — `ipToBuffer` expands `::` properly instead of
stripping colons and right-padding, which recorded a wrong address for every
abbreviated IPv6. A wrong address in a session record is worse than none.

**`server/web/checkin.html`** — to WCAG 2.1 AA, being the one page a shop's own
customers touch. `maximum-scale=1` dropped from the viewport (blocked pinch zoom,
a straight 1.4.4 failure). Skip link and `<main>`. Step titles are `<h2>`, focus
moves to them on step change and the step is announced. Progress bar has a text
equivalent; the bar itself is `aria-hidden`. Pay and job choices are real
radiogroups with arrow-key navigation and `aria-checked`, and the selected one
carries a check mark, not just a border colour. `alert()` validation replaced
with an `role="alert"` region plus `aria-invalid` and focus on the offending
field. Photos are a labelled list with meaningful `alt`. Scan hints, decode
output and the result are live regions. Supporting text moved from `--dim`
(~4.3:1, fails) to `--muted` (~7.4:1) on this page only.

**Deliberately not done:** gating the static pages behind a session. Empty
shells, nothing leaks but field names, and a public-page allowlist is how you
lock yourself out on a Sunday. `noindex` covers what mattered.

**`COOKIE_SECRET` rotation, written down as promised:** changing it invalidates
every signed cookie, so every user at every shop is signed out at once and has
to sign in again. No data loss, no other effect. Do it out of hours, and only
deliberately.

Deploy: `npm run build && npm run migrate && sudo systemctl restart easyshop`.
Retention stays dry-run until you add `RETENTION_ENABLED=1`.

---

# Server build — a0.2.4, 30 Aug 2026

Security pass out of the audit. Three of the four fixable-in-code findings.

**`server/src/middleware/security.ts`** (new) — security headers on every
response, a CSRF origin check on writes, and an in-process rate limiter.
Dependency-free: one Node process on one box, so a Map is the right size. CSP
has to allow `'unsafe-inline'` for script because every page in `server/web`
carries inline handlers — so it blocks third-party script, framing, off-site
form posts and outbound `<img>` beacons, but is not an XSS backstop. Buckets:
auth 20/15min, writes 240/min, reads 1200/min, per IP, static files uncounted.
`x-robots-tag: noindex` everywhere; `no-store` on `/api/`.

**`server/src/lib/storage.ts`** — `ALLOWED_EXT` at the door and a much shorter
`PREVIEWABLE` list (jpg/png/webp/gif/pdf only) for what may render in a
browser. `serveAs()` derives the response type from the extension *this server*
assigned at upload; `extOfKey()` reads it back off the storage key.

**`server/src/routes/documents.ts`** — the critical fix. The download route was
echoing `doc.mime_type` (client-supplied) with `inline`, so an .html or .svg
uploaded as a photo ran as script on the app origin with the session cookie
attached; `nosniff` does not help when the type is declared rather than sniffed.
Now: type from `serveAs()`, anything not previewable goes out as an
octet-stream attachment, and uploads of disallowed extensions 415 (draining the
part first so the request does not hang).

**`server/src/server.ts`** — `trustProxy` narrowed from `true` to the loopback
addresses. It was letting anything that could reach the port forge the IP the
audit log records and the limiter counts.

**`server/src/auth/session.ts`, `config.ts`** — idle expiry. `SESSION_IDLE_DAYS`
(default 5) signs out a session with no activity, independent of the 14-day
absolute expiry. A tablet on a shop bench no longer stays signed in for a
fortnight because nobody closed the tab.

Not in this build, from the audit: encryption at rest, tested restore, retention
and deletion (needs a decision on windows), TOTP, the check-in page's
accessibility work. All in QUEUE.md.

Deploy: `npm run build && sudo systemctl restart easyshop`. No migration.

---

# Server build — a0.2.3, 29 Aug 2026

Wholesale accounts get their own permission.

**`server/db/migrations/tenant/015_wholesale_client_permission.sql`** — seeds the
new `wholesale_clients` capability on for the owner role, `accounting`, and any
role that already holds `admin` or `perms`, so nobody doing it today loses it.

**`server/src/permissions.ts`** — new capability `wholesale_clients` ("Create and
edit wholesale accounts") in its own **Clients** section, with the caps field
`manageWholesaleClients`. Added to the legacy `accounting` list for shops that
have not run migration 011.

**`server/src/routes/clients.ts`** — `mayWrite(caps, kind)`: a wholesale account
needs `admin` or `manageWholesaleClients`; retail and carriers still take
`editRepairOrders`. The PATCH now reads `kind` alongside `platform_locked` so it
can check the account it is actually editing. 403s say who to ask. Switching an
account off is still admin-only.

**`server/web/clients.html`** — `canWrite(kind)` mirrors the server check: New
account hides on the wholesale tab for people without it, and the drawer opens
read-only with a line saying accounting sets these up.

**`Permissions.dc.html`** — the mockup carries the new row and Accounting's tick.

Deploy: `npm run build && npm run migrate && sudo systemctl restart easyshop`.

---

# Server build — a0.2.2, 24 Aug 2026

EMS import overwrites, and pulls the contact details it was already reading.

**`server/db/migrations/tenant/014_ems_contact_overwrite.sql`** — contact and
insurance columns on `ems_imports`; `clients.phone2`; `repair_orders.adjuster_phone`
and `.adjuster_email`; new table `ems_import_changes` (import_id, ro_id, target,
field, label, old_value, new_value).

**`server/src/lib/ems.ts`** — `customerPhone2`, `customerEmail` (ten candidate
field names, since CCC 2.01 has none), `insurerPhone`, `adjusterPhone`,
`adjusterEmail`. New warning when a set carries no way to reach the customer.

**`server/src/routes/ems.ts`** — new `applyFields()` helper: reads the current
row, skips fields the estimate is silent about, honours `overwrite`, writes
`ems_import_changes` rows and one `auditIn` entry per target, returns what moved.
The three `COALESCE` blocks (money, vehicle, insurance) are replaced by calls to
it, plus a new customer-contact block. `approved_at` is still `COALESCE`d — the
commission ledger dates from it. `deductible_waived` only ever turns on. The
create-new path now carries phone, email and address onto the client, and the
adjuster's contact onto the RO. `/accept` returns `changed`; the detail endpoint
returns `changes`.

**`server/web/import.html`** — a "Customer and insurance, off the estimate" block
on the review pane; `Customer contact details` and `Overwrite what is on the file`
ticks (both on) with the overwrite explained in words; the result line names the
fields that moved; an accepted import shows what it overwrote.

Deploy: `npm run build && npm run migrate && sudo systemctl restart easyshop`.

---

# Server build — a0.2.1, 24 Aug 2026

Parts cost entry, the parts pull sheet's received mode, and two `sort_order`
fixes.

**`server/web/parts.html`** — Add part always on the action row, wired to the
existing `POST /api/ro/:id/parts`. Cost-each per line in the receive drawer.
New `openCosts()` drawer, reached from a per-file **Costs** button and a per-line
**cost** button on received and partial lines; writes only changed fields through
`PATCH /api/parts/:id`. Pull sheet gains a **Received** mode with its own columns
(got / received date / invoice, shortfall in red) and signature lines; "Ordered"
relabelled "On order".

**`server/src/routes/parts.ts`** — `bulk-receive` accepts `costCents` per line,
gated on `caps.money`, `COALESCE`d so blank leaves the line alone, with an audit
row when the cost changes. Needs the build.

**`server/web/board.html`** — `completeSlots()` compares board position
(group index, then slot order) instead of `sort_order` shop-wide. Fallbacks for a
renamed Vehicle Ready: last `complete` slot in the `ready` group, then `kind`.

**`server/src/routes/config.ts`** — the statuses load joins `status_groups` and
orders by `g.sort_order, s.sort_order`; select list qualified to `s.`. Needs the
build.

Deploy: `npm run build && sudo systemctl restart easyshop`. No migration.

---

# Server build — a0.2.0, 21 Aug 2026

BUILT. Payroll for the non-sales week, the audit log as a readable screen, and
messages you can filter and delete. One migration. Run:

    npm run build && npm run migrate && sudo systemctl restart easyshop

Files touched:

- `db/migrations/tenant/013_payroll_audit_messages.sql` — `deleted_at` and
  `dispatch_state` on `notifications`; `notification_deliveries`; nine columns and
  four indexes on `audit_log` with the old rows backfilled; `pay_mode` and
  `salary_cents` on `staff`; `payroll_runs`, `payroll_run_people`,
  `payroll_run_cars`; the two payroll settings; the `audit` capability for owner
- `db/tenant.sql` — the same, for a shop provisioned fresh
- `src/lib/audit.ts` — new: the write helper, `auditIn` for transactions, `diff`
- `src/lib/payroll.ts` — new: the period arithmetic and the costed lines
- `src/routes/audit.ts` — new: reading the log, and `actorFrom`
- `src/routes/payroll.ts` — new: the sheets, the modes, the period, the runs
- `src/routes/notifications.ts` — filters, per-person delete, delivery record
- `src/notify.ts` — writes the in-app delivery row with every message
- `src/permissions.ts` — the `audit` capability
- `src/routes/ro.ts`, `parts.ts`, `documents.ts`, `leads.ts` — audit rows with
  area, label and field-level before/after
- `src/server.ts` — registers both new route files
- `web/payroll.html`, `web/audit.html`, `web/messages.html` — new screens
- `web/admin.html` — Payroll and Audit log in the tab strip
- `web/shell.js` — New/Old/All tabs, delete, and a link out, in the bell panel

## 1 · Payroll — the non-sales week

**Admin › Payroll.** Sales keeps its own screen and its own period; this is
everyone else. Somebody on an active sales pay plan is left off this screen
entirely, because paying them in both places is the mistake worth designing out.

**The week closes on a day and at a time the shop picks** — Wednesday at 4:00 pm
by default, so cheques can be cut that evening. Both are settings
(`payroll_close_day`, `payroll_cutoff`) and changing them is an audited change.

A file counts for the week if it was **marked closed** before the cutoff:
`closed_at`, the moment somebody clicked Close, not `close_date`, which is the
books date and can be moved by hand. Anything closed after the cutoff appears
under **Missed the cutoff** on the sheet and pays the following week, once.

**Nothing on this screen works out what a car should pay.** That was settled at
close and lives in `ro_labour`. Payroll reads those rows and adds them up, so a
wrong figure is fixed on the file and the sheet follows.

**The basis is per car, not per person.** The same body tech can have a flat
price agreed on one file and hours at their rate on the next; `ro_labour.basis`
says which, the sheet shows it in a Basis column, and hours are only counted on
the cars actually paid by the hour — so the hours figure and the money always
agree.

**Salary hides every per-car figure, on the server.** A salaried person's rows
come back with `basis`, `rateCents` and `costCents` as null. Not a hidden
column: what their cars would have paid by the hour is never sent. The car list
still travels, because the sheet is still what they did that week.

**Runs.** Marking a period paid snapshots it — people, modes, salaries and every
costed car — into `payroll_run_*`, and a paid period is read back from that
snapshot rather than recomputed. Re-running before payment is free; after it, a
correction lands on the next period rather than rewriting one that was paid.

**Printing** is the same data laid out for paper — white ground, black ink, one
page per person, signature lines, and the missed-cutoff list so a tech can see
why a car is not on their sheet. Print one sheet or all of them; Print all
fetches every sheet fresh so nothing prints stale.

## 2 · The audit log

**Admin › Audit log**, behind its own capability (`audit`) so a shop can hand a
manager the log without the rest of Admin. Owner holds it already.

The table is not new — we have been writing to it since the beginning. What it
lacked was everything a reader needs, which migration 013 adds: the role held
**at the time**, an area to filter on, a human label, field-level
`changes` as `[{field, from, to}]`, the note left with the change, a
`sensitive` mark, and the source. Old rows are backfilled from what their entity
implies, and the read query derives area and label in SQL as well, so a writer
that has not been moved onto the helper yet still reads correctly.

**Append only.** There is no write endpoint and no delete endpoint. `auditIn`
writes inside the transaction that makes the change, so a failed write leaves no
entry and an entry cannot exist without its write.

**It opens on today, newest first**, with search and filters on person, area and
span, and a Sensitive-only toggle. Money, deletes and voids, permission and
payroll changes are tinted red down the row — the treatment total loss gets on
the board. The header counts how many of the entries shown came with **no note**,
which is the manager's actual entry point: the notes say what somebody chose to
write down, the log says what happened either way.

Paging is by id rather than offset, because the log only grows at the head and a
cursor cannot skip or repeat a row the way an offset can.

Instrumented this round with area, label and before/after: file field edits,
parts line edits and deletes, document deletes, lead edits, payroll changes and
message deletes. Everything else still writes its older-shaped row and reads
fine.

## 3 · Messages

The bell panel keeps its place as the way in from any screen and gains **New /
Old / All**, delete on the row, and a link to the full screen. `/messages.html`
is the rest: the same three filters, search, tick-select for bulk delete or bulk
mark-read, "delete everything read", and a reading pane.

**One row per recipient, which is what `notifications` always was.** A parts
arrival with three subscribers is three rows. Read and deleted state belong to
the row, so one person clearing their copy does nothing to the other two.

**Deleting destroys nothing.** `deleted_at` is set, the list stops showing it,
and the audit log keeps the send.

**`notification_deliveries`** is the groundwork for SMS and email: every attempt
to put a message in front of somebody, in-app included, is a row against the
message. When a shop switches email on it becomes another delivery on a message
that already exists rather than a second system beside it. The reading pane shows
all three channels with "off" as a real answer.

**No message carries its own action.** The reading pane offers Open the file and
nothing else; whatever needs doing is done on the file.

---

# Server build — a0.1.15, 20 Aug 2026

BUILT. The close-out profit sheet, plus the five smaller items that were waiting
on it. One migration. Run:

    npm run build && npm run migrate && sudo systemctl restart easyshop

Files touched:

- `db/migrations/tenant/012_closeout_profit.sql` — labour rates on `staff`;
  deductible, rental provider/coverage, commission-payable and the flat materials
  figure on `repair_orders`; `ro_labour`; `ro_profit`; two shop settings
- `src/lib/profit.ts` — new: the whole arithmetic, server-side only
- `src/routes/closeout.ts` — new: the sheet, the preview, the deductible, the
  rental, the commission mark, the rates
- `src/routes/closed.ts` — closing saves the sheet in the same request
- `src/routes/board.ts` — cycle stops at ready; rental days; the extra columns
- `src/server.ts` — registers the close-out routes
- `web/board.html` — the close-out modal, deductible and rental on the drawer,
  the sales-pay mark, the filtered KPI strip
- `web/admin.html` — labour rates per person, the paint-materials rate, Roles and
  Sales pay in the tab strip
- `web/closed.html` — reopen from the adjust dialog, A/R and rental days
- `web/pay.html`, `web/permissions.html` — scroll
- `web/shell.js` — Roles and Sales pay out of the main nav

## 1 · The close-out sheet

Closing a file now opens a sheet showing what the car made. It is generated from
the assignments: nobody on a trade, nothing on the sheet. Body, paint, R&I and
detail take hours, a flat dollar, or the EMS estimate's own hours — the estimating
system's labour codes are mapped onto the shop's trades (refinish is paint, frame
is body; mechanical and glass are deliberately left unmapped rather than guessed
onto a trade that would then be paid for them). PDR takes a dollar or a share, and
a share can come off the approval or off what is left once everything else is
paid, which is why PDR is always calculated last.

**Every figure is owner and accounting only** (`viewPayPlans`). Not hidden
controls: the endpoints refuse, and the arithmetic runs on the server, so a
browser that should not have the profit never receives the pieces it is made of.
Anyone else closing a file gets no sheet at all — the close goes straight through,
because withholding the figures should not stop them doing the job.

The sheet asks the server to recalculate as the desk types (debounced), so what
appears on screen is the server's answer, never the browser's.

`ro_labour` keeps what was punched in, including the rate used, so a rate change
next month does not rewrite what last month made. `ro_profit` keeps the settled
figure for the same reason; `GET /api/ro/:id/profit` returns both it and a fresh
calculation, because if they differ that is worth seeing rather than hiding.

## 2 · Deductible and rental live on the file

Both are settled in the drawer while the car is in the shop. A car sits for a
fortnight — whether the customer is paying their deductible is known long before
anyone clicks Close.

- **Deductible** is what they owe against what the shop is charging. They may
  write $1,000 and the shop collect $500; the $500 difference is given away and
  comes off the profit **and** the commission base, so saving it settles the pay
  ledger behind it.
- **Rental** is provider (Avis, Budget, Enterprise, Hertz, Loaner — alphabetical,
  loaner last) plus coverage plus cost. A covered rental is reimbursed, so the
  shop carries none of it in the profit and the coverage flag is what says there
  is money to chase. A loaner can never be covered — there is nobody to reimburse
  it. At close **only the price** can be touched.
- **Commission payable** is a per-file mark on the drawer's sales pay block, for a
  house deal or a car nobody earns on. Off, and the sheet leaves the sales pay
  line out entirely.

## 3 · Labour rates on the person

Admin › People carries a rate per tech: per hour, flat per car, or a share — and a
share is PDR only, refused for anyone else. The shop's paint-materials rate per
paint hour sits under the list. A car with no paint hours takes a flat materials
figure on the sheet instead.

## 4 · The five that were waiting

- **Reopen a closed file** from the Closed screen's adjust dialog. The control
  existed only in the board drawer's closed branch, which nothing could reach.
- **The board's KPI strip follows the filters** — filter to a body tech and all
  seven figures are that tech's, on the server's own definitions.
- **Three clocks.** Cycle is in-to-ready and stops when the car is marked ready;
  the closed board and report read the ready date the file already carries, so
  every historical file is corrected without a backfill. Rental is in-to-picked-up.
  A/R is picked-up-to-paid, still running while the money is out, owner and
  accounting only and stripped server-side.
- **Roles and Sales pay** moved out of the main nav into Admin's tab strip.
- **Scroll** on Sales pay and Roles.

Still open: whether the commission-payable mark should default from the plan
rather than per file; whether a covered rental should instead be deducted in full
with the reimbursement landing later as income; whether PDR's "after costs"
should come off before the other labour.

# Server build — queue run, 19 Aug 2026 (a0.1.14)

BUILT. Shop-configurable permissions, sales pay plans with a commission ledger,
and total loss. One migration. Run:

    npm run build && npm run migrate && sudo systemctl restart easyshop

Files touched:

- `db/migrations/tenant/011_permissions_pay_total_loss.sql` — the `roles` and
  `role_caps` tables and their seed, total-loss columns, five cost columns a pay
  plan can deduct, `ro_triggers`, `pay_plans`, `pay_plan_deductions`,
  `commission_lines`, `commission_runs`, two shop settings
- `src/permissions.ts` — rewritten: capabilities are rows, not constants
- `src/lib/pay.ts` — new: period maths, plan loading, the trigger stamps and the
  ledger reconcile
- `src/routes/roles.ts` — new: the roles grid, add/rename/rank/own-only, ticks,
  delete-with-move, presets
- `src/routes/pay.ts` — new: plans, the period day, one file's arithmetic, trigger
  correction, the commission report, runs
- `src/routes/totalloss.ts` — new: mark, lift, and the head-of-board list
- `src/middleware/context.ts` — loads the shop's role rows and derives caps
- `src/routes/ro.ts` — trigger firing on status moves and on typed dates,
  `canTotalLoss`, `canUnclose` off its own capability
- `src/routes/closed.ts` — the close stamp carries the close date; un-close
  removes it; un-close is a capability now, not an owner check
- `src/routes/board.ts` — the synthetic `00` lane, total-loss fields, totalled
  cars out of a technician's own list
- `src/routes/admin.ts` — people can hold the shop's own roles, not a fixed eight
- `src/auth/routes.ts` — role labels come from the shop
- `src/server.ts`, `web/shell.js` — register the routes, Sales pay and Roles in the nav
- `web/permissions.html` — new: the roles grid, expanding in place
- `web/pay.html` — new: pay plans and the commission report
- `web/board.html` — lane 00 red at the head of the board, the Total loss flag,
  the total-loss block on the file

## 1 · Permissions

Roles were eight constants and fifteen hard-coded capability lists. They are now
rows: `roles` (label, rank, lock, own-only, custom) and `role_caps` (one row per
role per capability, `can_see` and `can_change`). `capsFromRows()` is the union
of every role held; `legacyRoleRows()` / `legacyCapRows()` carry the old lists so
a tenant that has not run 011 still works.

- **Owner and Technician are locked.** Owner because the platform, the scheduler
  and the calendar key off `owner`; Technician because the lane rules hang off
  trades. Both renameable. The owner's ticks are refused by the endpoint AND
  forced true in `capsFromRows`, so there is no path to a reduced owner.
- **Only the shop's original owner** — earliest owner membership — may touch the
  Owner role.
- **Money is four capabilities**: RO totals, parts cost and margin, labour
  (hours, paint and PDR — on for technicians by default), commission. See/Change
  splits on money, leads, paperwork, reports and pay plans; one tick elsewhere.
- **`own_only`** replaces the `tech_sees_own_only` setting, which is migrated
  across and then left in place. It is per role, and the wider role wins.
- **Deleting a role** moves its holders to a role picked in the dialog and
  repoints any status that named it as owner. `memberships.role` is still an
  eight-value ENUM, so `enumSafePrimary()` keeps that column legal while
  `membership_roles` carries the truth.
- **Presets** (Collision / Hail / Combination) only ever ADD roles. A shop that
  has built its own board keeps it.

## 2 · Sales pay

Four stamps per file in `ro_triggers` — arrived, approval, car gone, file closed —
fired on the event itself: arrival when the file is opened or moved to
`intake.arrived`, approval when it leaves `est.awaiting` or reaches
`est.approved`, car gone at `deliver.pickup`, file closed by the close endpoint
with **the close date as the stamp**. Slot ids are canonical, so renaming a status
does not move the money. Existing files were back-filled from their dates.

`commission_lines` is the ledger, one row per event per file, and the report
reads nothing else. `reconcile()` rebuilds a file's lines whenever a trigger
fires or a plan changes, with one rule: **a paid line is never rewritten.** The
difference lands as an `adjustment` row dated into the current period. That is
what makes the Tuesday-close / Wednesday-report / Friday-pay rhythm safe — the
report can be re-run all day, and only `POST /api/pay/runs` with `pay: true`
closes anything.

- **A totalled car earns `tl_amount_cents` and no commission at all**, less any
  drop fee already paid unless `tl_pay_drop` is on. A $500 drop against a $250
  total loss is a $250 deduction, which the ledger carries as a negative line.
- **The drop fee is money out at arrival**, recovered from the commission when
  that pays (`drop_recover`) or kept on top of it.
- **`pay_period_end`** is a shop setting, never per person.
- **Trigger correction:** typing the approved or delivered date on the file, or
  moving a close date, re-stamps the trigger and settles the ledger behind it.

Still open: whether a plan change should apply only to files taken after it
(today it re-checks 18 months of unpaid lines); whether the sales tax deduction
should read a per-file figure rather than the shop rate; how a mid-file
salesperson change splits the commission.

## 3 · Total loss

`total_loss_at` / `_by` / `_note` on `repair_orders` — a flag like void, not a
status. **The board synthesises lane `00` from the flag**, so a shop
reconfiguring its status board cannot break it, the file keeps the slot it was
sitting in, and the assignments stay exactly where they were: the car leaves the
technicians' lists without anybody being unassigned. Owner and estimator
(`total_loss` capability). Parts already on order are reported, not cancelled —
the parts desk decides.

# Server build — queue run, 18 Aug 2026 (a0.1.13)

BUILT. Closing a file, sublet as a production lane, and deleting a lead. One
migration. Run:

    npm run build && npm run migrate && sudo systemctl restart easyshop

Files touched:

- `db/migrations/tenant/010_close_and_sublet.sql` — close columns, the sublet lane
  and its four statuses, lead soft-delete columns
- `db/tenant.sql` — the same shape for a fresh install (and the 009 columns, which
  were missing from it)
- `src/db/status-template.ts` — the sublet lane, its four slots, `OFF_CLOCK_SLOTS`
- `src/permissions.ts` — `closeRepairOrders` (owner, accounting, front office)
- `src/routes/closed.ts` — new: close-check, close, adjust, un-close, the closed
  board, the closed report, and `GET /api/sublets`
- `src/routes/ro.ts` — the file detail carries `canClose` and `closeBlockers`
- `src/routes/leads.ts` — `DELETE /api/leads/:id`, restore, deleted excluded from
  the list and the summary
- `src/routes/reports.ts`, `src/routes/sales.ts` — deleted leads out of the
  lead reports and the rep's own list
- `src/routes/board.ts` — `close_date` and `paid` on board rows
- `src/server.ts`, `web/shell.js` — register the routes, Closed in the nav
- `web/closed.html` — new: the closed board and the closed report
- `web/board.html` — the close block on the file, Sublets needed under the lanes
- `web/leads.html` — delete and restore, Show deleted

## 1 · Closing a file

`closed_at` already took a file off the board and the dates block calls it "date
picked up", so closing got its own columns rather than overloading it:
`close_date` (the books date), `closed_by`, `paid`, `paid_at`. **`close_date` is
the flag for a properly closed file** — the closed board and the report read it and
nothing else, so a file whose `closed_at` was set by a terminal status does not
appear on the books.

- **Who:** owner, accounting, front office (`CLOSE_RO` in `permissions.ts` — widen
  that list, not the endpoint).
- **The guard blocks, it does not warn.** No approval amount, parts lines still on
  order, or a sublet not returned all refuse the close and say which. The file
  drawer shows the same list before you try, from `closeBlockers` on the detail.
- **Paid is a flag, not a payment.** Taking payments proper is still queued. An
  unpaid file closes and shows unpaid on the board so it can be chased.
- **The close date is editable afterwards** from the closed board, and moving it
  re-books the file into that month, week and day. That is `PATCH /api/ro/:id/close`;
  every change writes a note and an audit row.
- **Un-closing is owner only** (`DELETE /api/ro/:id/close`) — it takes money back
  off the books and puts the car back on the schedule.
- **The board:** flat list by default, sorted by close date, with paid / unpaid /
  all and a Group by payment toggle. Unpaid tints the whole row and carries an
  Unpaid tag. Sorting a grouped list sorts inside each group.
- **The report** is its own screen with four cuts — month, week, salesperson,
  insurance vs cash-pay — keyed on close date. Unpaid is a column rather than a
  subtraction, so the books and the chase list read off one figure.

Still open: whether an unpaid closed file counts as revenue or sits apart; what
happens to a file closed with parts still on order (today it cannot be); whether
front office should be able to un-close.

## 2 · Sublet as a production lane

A lane like body and paint, sitting after Reassembly and before Buff, with four
statuses: Awaiting Sublet, At Sublet, Working Sublet, Sublet Complete. Sublet
Complete is a resting state — somebody moves the car on by hand.

- **At Sublet is the one status that does not count toward cycle time** — the car
  is off site and the day is not the shop's. `counts_toward_cycle = 0`, and
  `OFF_CLOCK_SLOTS` names it for anything else that needs to know.
- The migration inserts the lane and group in order and shifts the ones after it,
  so an existing shop's board keeps its shape. Fresh installs get it from
  `TEMPLATES` — every shop type except detail-only.
- **Sublets needed**, under the cycle lanes: every live sublet line in the shop on
  the board's own column grid — service, vendor, state, out and back, cost. Lines
  waiting to be sent are tinted and a line with no vendor carries "name one".
  Clicking a row opens that file. Invoiced lines drop off. Same records the file's
  sublet block edits (`GET /api/sublets`).

Still open: where the lane sits for a PDR-only shop (it is after PDR today);
whether moving a car to At Sublet should stamp the sublet line's out date.

## 3 · Deleting a lead

Soft, like a void. `deleted_at` / `deleted_by` / `delete_reason`; off the list
and out of the response clock, with the record, its notes and its history kept.

- **A converted lead cannot be deleted** — it belongs to an RO. It can only be
  marked lost.
- Restorable from **Show deleted** on the leads screen.
- Deleted leads are out of the leads summary, both lead reports and the sales
  app's own list — every count that fed off them was updated, not just the list.
- Lead numbers are never reused: the sequence still counts deleted rows.

Still open: whether a deleted lead should age out of the database at all, and who
beyond `manageLeads` should be able to delete.

---

# Server build — queue run, 13 Aug 2026

BUILT. Every item below is now in the server: two migrations, the permission
core, the request context, the people and parts endpoints, and the three screens
that read them. Run:

    npm install && npm run build && npm run migrate

Files touched:

- `db/migrations/master/002_membership_roles.sql` — roles a person holds
- `db/migrations/tenant/007_staff_positions.sql` — trades a person works
- `src/permissions.ts` — capsForRoles, primaryRole, lanesFor, canMoveTo, needsTech
- `src/middleware/context.ts` — ctx.roles / ctx.positionKeys, caps as a union
- `src/routes/admin.ts`, `src/routes/config.ts`, `src/auth/routes.ts` — role and
  trade sets in and out
- `src/routes/parts.ts` — bulk-order, bulk-receive with short counts, PP% per file
- `src/routes/ro.ts`, `src/notify.ts` — lane checks and notifications across trades
- `web/admin.html`, `web/board.html`, `web/parts.html` — the screens

Both migrations seed from the existing single columns, and every read falls back
to `memberships.role` / `staff.position_key` if a database has not migrated yet,
so the app runs either side of the migration.

## 1 · One person, several roles

One migration. `user_roles (user_id, role_key)` seeded from `users.role`; keep the
old column for one release and read from the join table.

- `permissions.ts`: capability resolution becomes a union — a user has a capability
  if ANY role they hold grants it. Every `role === 'x'` comparison in the codebase
  becomes a set test.
- Primary role = the highest-ranked role held, in the existing ROLES order (Owner
  first). It is what the user is labelled as, and who `notify.ts` treats them as for
  position-based notifications. Do not store it; derive it.
- Board: the shop's "techs see only their cars" setting applies only when
  Technician is the ONLY role held. A tech who also holds a management role sees
  the whole board — the manager role wins.
- The role switcher stays useful as a preview of what a role sees.

## 2 · Multiple trades per person

`staff_positions (user_id, position_key)` seeded from each person's current
`position_key`, as the queue called for — not a comma list in the existing column.

- Assignment dropdowns per lane query `staff_positions`, plus whoever is already on
  the file so an old assignment is never dropped on save.
- `canMoveTo` allows a move if the lane is in ANY of the person's trades.
- The technician filter shows the union of their lanes; cars past those lanes still
  group under "Elsewhere in the shop".
- One person may hold two trades on the same car (body and paint) — allowed.
- Ordering of a person's trades is the lane order; the first is what they are
  listed under. No separate primary-trade column.
- Open: whether someone is offered "Needs tech" files in a lane they work but
  rarely — the prototype offers them in every lane they hold.

## 3 · "Needs tech" rule — DONE (`web/board.html`)

PDR alone is a complete file — a hail car pulled by one tech needs nobody else. Once
body or paint is on the car it is a collision repair and wants both trades: body and
PDR still needs a painter, PDR and paint still needs a body tech. No trade at all
needs a tech. The board flag, the print list and the picker option all read the one
helper. Confirm the reporting side matches if it computes this separately.

## 4 · Car colour — DONE (`web/board.html`)

Colour was already on the Table view's vehicle sub-line. Added after the model on
the Cycle row and on the mobile card, so it prints with the list (print is
`window.print()` over the same DOM).

## 5 · Parts ordering

Columns on the parts line: `vendor_id`, `order_number`, `eta`, `ordered_at`,
`received_at`, `short_qty`, `part_type`, `list_cents`, `cost_cents`.

- `vendors` table (name, kind: OEM / A-M / Recy / Sublet, active). One list, reached
  from Admin and from the parts screen — the same rows, not two lists.
- Order action takes a SET of line ids plus one vendor, one order number and one
  ETA: a single order to one supplier is how it actually happens. Stamps
  `ordered_at` = today and moves the lines to Ordered.
- Receive stamps `received_at` and `short_qty`. A line with a short count stays on
  order for what is still owed — partial arrivals are the normal case.
- A line past its ETA is flagged the way stalled files are on the board.
- Parts cost on the RO is recomputed from the live lines on every parts write and
  overwrites the estimate's parts figure. The estimate's original number stays in
  the estimate record; only the RO money block moves.

## 6 · Parts profit (PP%)

Derived, never stored: `(list − cost) / list` over the open lines — margin on list.
Shown as a total per RO on the parts screen (and per line in the RO's parts
detail). Visible to money capabilities plus parts staff. Lines under 20% are
flagged; make the threshold a shop setting rather than a constant.

## 7 · Parts → the RO drawer, and the last 8 of the VIN

- The RO number on a parts line opens the existing RO drawer over the parts screen,
  with the user's normal edit rights (not read-only). Closing returns to the same
  parts list, scroll position and open RO.
- The last 8 of the VIN shows on the expanded parts line and in the order modal —
  it is what gets read over the phone — with a control that copies all 17. The full
  VIN is the title attribute.


---

# Photos, PDFs and the viewer — 13 Aug 2026

BUILT, server-side, as chosen: libvips and mupdf on the box, a Redis queue, and
our own viewer. `INSTALL-MEDIA.md` is the file to follow on the server.

    npm install && npm run build && npm run migrate && npm run backfill-thumbs

## What it does

Every photo and every PDF gets a thumbnail, made on the server rather than
trusted to the browser. HEIC is decoded and **replaced** by a JPEG — the HEIC is
deleted, so the photo opens anywhere in ten years. Page one of a PDF is rendered
as its thumbnail. The work runs on a queue behind the upload, so the upload
returns as soon as the bytes are down.

A tile does not appear until its thumbnail is ready, so the toast is what
confirms the upload; the drawer then re-reads a few times over the next fifteen
seconds and the tiles arrive on their own.

The viewer is one modal over one sequence — photos first, then paperwork, each in
upload order. Side arrows move between documents; a multi-page PDF gets its own
page arrows in the bar, so turning a page never walks off the file being read.
Left/right change document, up/down turn pages, Escape closes. Rotate, zoom to
fill, download and open-in-a-new-tab are in the bar. Rotation is saved as an
angle on the record and applied on display — the file on disk stays exactly as
the camera wrote it, which matters for an intake photo.

Pages past the first are rendered when someone turns to them and kept for thirty
days after they were last opened, then dropped and re-rendered on demand. Admin
counts that cache apart from the documents, because it is disk you can throw
away.

## Rules it enforces

- A technician can upload photos, not paperwork — a PDF from a tech is refused
  with a plain message, and the file is removed.
- The document type is read from the file: an image is a photo, a PDF is
  paperwork. The drawer's type dropdown now leads with "set the type from the
  file" and only overrides when someone picks something.
- Money documents are **absent** from a tech's sequence, not locked — the arrows
  never land on a door they cannot open.

## Files

- `db/migrations/tenant/008_document_derivatives.sql` — thumb state, tries,
  rotation, page count, source mime, is_pdf, and the `document_pages` cache
- `src/lib/media.ts` — sharp, heif-convert and mutool, each optional, with a
  probe the app and Admin both read
- `src/queue.ts` — Redis and BullMQ, three tries backing off; the worker runs in
  the app process, so there is one service to start and watch
- `src/jobs/derivatives.ts` — the job itself
- `src/jobs/page-cache.ts` — the thirty-day sweep, every twelve hours
- `src/routes/documents.ts` — upload, serve, `?page=N`, rotate, rethumb,
  `/api/ro/:id/media`, `/api/media-tools`, storage counts
- `src/scripts/backfill-thumbs.ts` — `npm run backfill-thumbs`
- `web/board.html` — the grid and the viewer
- `web/admin.html` — what this box can make, and the page cache
- `INSTALL-MEDIA.md`, `.env.example` — the box

## Paperwork is the office's

Settled after the first pass: a PDF is not a technician's business at all, typed
or untyped. A new `viewPaperwork` capability covers owner, accounting, estimator,
production manager, parts manager and front office — everyone but a technician
and a salesperson. It gates three things:

- PDFs are **absent** from the RO drawer and the viewer sequence for anyone
  without it, alongside the money-document rule.
- Serving a PDF, or any page of one, is refused outright.
- Uploading one is refused, and the file removed — the drop zone reads "drop
  photos here" and the file picker only offers images.

That closes the untyped-estimate hole from the other side: the guess no longer
has to be right, because a technician cannot reach a PDF whatever it is typed as.

## Caveats
- Nothing here was type-checked or run — `npm run build` before deploying.
- Rotation applies via CSS transform, so a rotated photo prints rotated in the
  browser but downloads unrotated. That follows from keeping the original.


---

# Lead follow-up, and the age bug — 14 Aug 2026 (a0.1.12)

    npm run build && npm run migrate && sudo systemctl restart easyshop

## The age bug

The AGE column read "today" for a lead taken yesterday. `ageText` floored
elapsed hours over 24, so a lead entered at 4pm yesterday was 18 hours old the
next morning and rounded to zero days. Age is a calendar measure, not an elapsed
one: the server now sends `age_days` as `DATEDIFF(CURDATE(), DATE(received_at))`
and the column reads today / yesterday / Nd. `age_hours` stays, because the
never-answered mark genuinely is an elapsed-time question.

## Follow-up

A lead nobody has touched needs chasing. A lead with something on the calendar
does not — being booked *is* the follow-up. So the flag is: quiet for N days,
still live, and nothing on the schedule for them inside the window.

- **N is the shop's number**, in Admin → Shop settings → Lead follow-up, with the
  booking window beside it. Three days and thirty days by default.
- **The flag is computed, never stored**, so changing N re-flags everything on the
  next load instead of waiting for each lead to be touched.
- **"Followed up"** on the lead records who, how and when, and resets the clock
  for another N days. It also fills `first_reply_at` if this was the first touch.
- **"Book…"** adds an appointment to the calendar from the lead without leaving
  it. The appointment carries `lead_id`, which is what suppresses the flag; the
  lead moves to Appraisal booked if it was still New or Contacted.
- The row shows one of three marks and nothing otherwise: **Follow up** (due),
  **Booked**, **Held**. A lead quietly inside its window says nothing.
- New **Follow up** filter tab, and the header count says how many to chase.
- The detail panel shows every appointment for the lead, including ones further
  out than the window — it should not pretend a booking is not there.

## Files

- `db/migrations/tenant/009_lead_followup.sql` — `leads.last_followup_at`,
  `leads.followup_snooze_until`, an index on `appointments (lead_id, starts_at)`,
  two `lead_events` kinds, and the two settings
- `src/routes/leads.ts` — `age_days`, `quiet_days`, `next_appointment`, the
  computed flag, `POST /api/leads/:id/followup`, `POST /api/leads/:id/appointment`
- `web/leads.html` — the corrected age, the tags, the filter, the two actions
- `web/admin.html` — the two settings under Shop settings

`appointments.lead_id` already existed with its foreign key, so the calendar link
needed no schema work beyond the index.


---

# Fix — appointment times drifting, 11 Sep 2026

A drop off saved for 9:00 came back reading something else, and re-saving it did
not hold. The time was being converted twice.

**What was happening.** The column is a DATETIME and both pools run `timezone:
'Z'`, so the driver treats the stored value as UTC. The booking routes handed it
a JS `Date` built from the browser's `YYYY-MM-DDTHH:MM` string, which Node
parsed in the *server process's* zone and the driver then converted to UTC on
the way in. Reading it back, the same value came out as an ISO string ending in
`Z` and `new Date()` in the browser shifted it again, by the *viewer's* offset.
Two conversions against two different zones, neither of them the shop's, so the
saved time moved and kept moving.

**The rule now: an appointment is a clock face, not an instant.** 9:00 at the
counter is 9:00 whatever zone the server or the browser runs in.

- `wallClock()` in `scheduler.ts` and `leads.ts` normalises the booking to
  `YYYY-MM-DD HH:MM:SS` and passes it to MySQL **as a string** — the driver
  leaves strings alone, so what is written is what was typed. Both the POST and
  the PATCH go through it, as does booking from a lead. `sales.ts` already wrote
  a plain string and was already right.
- `Shell.wall()` reads the digits back out and builds a local `Date` from them,
  so rendering never re-zones. `schedule.html` uses it for the day bucket, the
  card time, the past/upcoming test, the drawer heading and the *Move it* date
  and time fields; `leads.html` for `stamp()` and the next-appointment test;
  `sales.html` for the drop off date.
- `isoDay()` server-side now reads the stored day off the value rather than
  re-deriving it through the process zone; `localDay()` is the separate helper
  for dates this process made itself (today, the capacity strip).

**Existing rows were written shifted and stay shifted.** The fix stops the drift,
it does not undo it. Set the time once after deploying and it will stick; a
booking that still reads wrong is carrying the old converted value. There is no
back-fill, because the offset a given row was written under is not recorded and
guessing it would move correct rows too.

**Google Calendar is untouched.** `gcal.ts` still reads `starts_at` as an
instant, so a pushed event lands at the clock face interpreted as UTC. That was
true before this change and is a separate job — it needs the shop's zone from
`companies.timezone` to build a real instant.

Web files only for the display half — hard refresh `schedule.html`, `leads.html`
and `sales.html`. The route changes need `npm run build && sudo systemctl restart
easyshop`. No migration.


---

# Fix — removing a parts line, 11 Sep 2026

`DELETE /api/parts/:id` has been there since the modal went in; nothing in the
modal called it. So the parts detail could add, order, receive and re-type a
line but never drop one, which is a problem the moment an estimate import lands
the same part twice.

**The \u00d7 at the end of a row.** It ticks that one line and puts the batch bar
into its confirm, so removing one line and removing six ask the same question in
the same place. Ticking lines and hitting *Remove…* is the same path. Needs
`manageParts`, which is what the endpoint already enforces.

**The confirm says which case it is.** Lines still to order get "this cannot be
undone"; anything already ordered or received says so and warns that its cost
comes off the file, because that is money that has left the building. The
endpoint writes a `part_deleted` audit row and recomputes the file's parts cost
either way, so a removal is recoverable as a record even though the line is not.

Web only — hard refresh `parts.html`. No build, no migration.
