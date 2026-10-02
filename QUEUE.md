# Queue

Newest at the top.

## Locations — decided 1 Oct 2026, PARTLY BUILT (a0.8.0)

Built: the group, creating a location from the parent (copies + people), add
people from another location, per-shop sales tax, the parent's read-only bill,
combined-reports grants and a one-location-at-a-time picker on Reports.
Still TO DO: **all locations at once** on Reports (rates recomputed from the
combined rows), **vendors linked across the group**, the **group web form**.

Came up with a shop opening a small pop-up. The pop-up is a **location** of the
parent: its own shop in every way that holds data, joined to the parent for
reports, billing, the web form and the vendor list.

**What does not change**

- **A location is a company.** Own database, own login, own RO numbers, board,
  payroll, leads, schedule, hours, consents and suppressions. Nothing is read
  across databases at run time; what a new location starts with is **cloned**
  into its own database when it is created.
- **Staff are per shop.** Somebody working both is a user in both — one email,
  one password, a role in each — and switches with the chooser that already
  exists (`choose.html`, Account). Pop-up staff see the pop-up only, reports
  included.

**The group**

- New in master: `company_groups` (id, name, parent company) and
  `companies.group_id`. One parent per group. Set up in platform admin — a
  location is provisioned *into* a group, or an existing shop is moved into one.

**Creating a location**

- Provisioned from the parent, not from a blank shop-type template. Cloned into
  the new database at creation: **roles and permissions** (notification routing
  with them), **tech pay setup**, and **labor rates and tax rules** as a
  starting point. After that each is the location's own and edited there —
  nothing syncs back.
- **Add existing people** — a list of the parent's techs and employees to tick
  at creation (and later, from the location's People screen). Ticking makes a
  membership at the location with the same roles and pay setup; it takes a seat
  there. Most techs will not work both, so nobody is ticked by default.
- Not cloned: ROs, clients, **wholesale clients** (per location), leads,
  statuses and lanes, documents, templates, notification wording, hours, the
  funnel.

**Labor rates and sales tax** — per location

- Rates are per location already (they live in the tenant database); a new
  location starts from the parent's and diverges freely.
- **Tax needs more than a rate.** Today it is one `sales_tax_rate` per shop
  (`lib/pay.ts`, `lib/profit.ts`), applied as if everything were taxable.
  States differ: Arkansas and Kansas tax the whole repair; Texas taxes **parts
  and paint/materials only**, not labor. So each shop gets the rate **and what
  it applies to** — parts, paint and materials, labor, sublet — ticked per
  shop. A preset by state fills the ticks; the shop can change them.
- This is needed whether or not a shop has locations — a single Texas shop is
  being over-taxed on labor today wherever the rate is used. Check every reader
  of `sales_tax_rate` before changing it.

**Vendors**

- Each shop keeps its own vendor rows; they are **linked across the group** by a
  shared key, so the vendor screen can say **which locations** use one.
- **Any shop can add or edit a vendor, but can only tick or untick itself.**
  Ticking copies the vendor into that shop's own database; an edit to the
  vendor's details goes to every copy. Unticking runs the same parts-on-order
  check as retiring, against that shop's lines only.
- The vendor picker on parts, sublet and the rest shows only vendors ticked for
  this shop.
- When a location is created, the parent's vendors stay ticked for the
  **parent only** — the location ticks what it uses from the group list.

**Combined reports**

- Every report gets a shop picker: **this shop, another location, or all**.
- **Granted person by person in the parent's settings.** The grant alone is
  enough — the person does not need to be a user at the location, and it costs
  no seat there. It covers reports and nothing else: no board, no files, no RO
  drawer at the location.
- The location's data is read on its own tenant login and merged in the app,
  never by one database reading another. Rates and averages (cycle time,
  margin) are recomputed from the combined rows — never an average of the two
  shops' averages.
- Every combined run writes an `audit_log` row **in each shop it read**, so the
  location's own log shows who looked at it from outside.

**Billing** — BUILT 1 Oct 2026 (master migration 009, `lib/billing.ts`)

- **Shop** $299.99/mo with 5 seats. **Additional location** $99.99/mo with 5
  seats of its own. **Extra seats** in blocks of 5 at $49.99/mo, per location.
- **Seats are per location, not pooled.** A person in two shops takes a seat in
  each. A combined-reports grant takes none.
- `companies.seats` is now derived — plan seats + 5 × `extra_seat_blocks` —
  and only `setBilling` writes it. Platform admin no longer accepts a typed seat
  count.
- Platform admin sets the plan and the blocks per shop, on create and after, and
  shows seats used and the monthly figure.
- **Out of seats warns and allows.** Adding a person over the seat count is not
  refused: the Add sheet says so before saving, and the result says so after.
- Nobody had been charged, so Starter / Growth / Multi-shop are retired. Every
  shop on one moved to **Shop** with enough blocks to keep its seat count —
  **check each shop's blocks in platform admin before the first invoice**,
  because a shop seeded at 20 seats is now billed for 3 blocks.
- Still invoiced by hand — no payment integration.
- Still TO DO: the **read-only summary for the parent's owner** (locations,
  seats used of seats paid, monthly total), once groups exist.

**Web booking**

- Builds the "Several shops behind one form" design below: one snippet on the
  parent's site, **location first**, then that shop's form.
- After the pick, everything is that shop's — its hours, limits, questions,
  accent, and **its own consent wording**, because each shop is the responsible
  party for its own texting. The consent row is written in the shop picked.
- The group form's domain allowlist lives on the group; a shop's own form keeps
  its own.

**Left to work out in build**

- The vendor link key: a `group_vendor_key` on `vendors`, backfilled on the
  parent when the group is made. One `ADD COLUMN` per statement.
- Tax categories need the RO's lines split by category; check that parts,
  paint/materials, labor and sublet totals are all available where tax is
  computed today.
- What a location keeps when it leaves a group: everything — it already has its
  own copies. Only the vendor link is cut.

## Text message updates toggle — decided 18 Sep 2026, TO DO

Settles the consent question left open by the TCPA entry below, and closes it
rather than widening it.

**The shop is the responsible party.** Twilio campaigns are registered on the
shop's own information, wording and privacy/TOS. If a shop contacts somebody it
should not have, that is the shop's to answer for. So consent capture is *not*
being pushed into counter leads, the sales app or EMS imports — that is a
closed question, not an outstanding gap.

**What gets built** is one control in three places — every place a car gets
written:

- **Check-in**, on the shop's side of it. The customer's own check-in page says
  nothing about texting.
- **The sales app**, as the rep writes the opportunity. It carries onto the RO
  when the lead converts.
- **A new RO off the desktop board.** The one that would have been missed: a car
  written straight onto the board passes neither check-in nor sales.

- **It is shop-side only and it is a confirmation**, not a box the customer
  ticks. Turning it on states that the customer consented, and it writes an
  ordinary `consents` row the same as the web form does — kind, wording shown,
  who ticked it, when. Only `captured_by` differs by screen.
- **The wording is the shop's, read server-side**, same rule as the web form.
- **Every message sent under it carries a quick STOP**, appended by the sender
  rather than typed, so it cannot be edited off a message. STOP revokes through
  `suppress()` like everywhere else. Nothing new in the suppression chain.

Mockup: `Text Updates Consent.dc.html` — the three placements, the row they
write, and the outgoing message.

## TCPA consent — BUILT 17 Sep 2026

Shipped the same day as the booking form, because the form was collecting phone
numbers with nothing recording that the customer had agreed to be contacted.
See SERVER-NOTES.md. Two decisions are worth repeating here because they are
the ones somebody will try to reverse:

- **The consent box is never required.** TCPA does not let consent to marketing
  be a condition of the sale, and the shop's own wording promises "consent is
  not a condition of purchase" — a required box makes that a lie on their own
  website. The first draft of this asked for a required box; the wording caught
  it.
- **Transactional consent is implied by booking and dies at delivery.** It
  covers messages about that car and nothing after it has gone. A transactional
  consent that outlived the repair would be a standing permission nobody
  granted.

Still open, and the one that matters: **nobody legal has read it.** The checks
are a reasonable reading of TCPA and the wording came from the shop, not from
counsel. Worth an hour of a lawyer's time before a second shop is onboarded.

The "consent is captured on the web form only" gap recorded here was **settled
18 Sep 2026** — see the entry above. It is the shop's responsibility off the
web form; the only thing we add is a text-updates toggle on check-in and a new
RO.

## Platform integrations — GHL, Votel, WordPress — raised 17 Sep 2026, TO DO

**Not started, and not in the build queue.** Stubs and a direction only. The web
funnel below is what ships; this is where it goes afterwards.

**All three are site and funnel hosts**, not one special case: GoHighLevel,
Votel (a CRM product of the same kind) and WordPress. A shop's site or funnel
lives on one of them.

**For now the snippet is the answer on all three.** Documented per host — a
WordPress page or block, a GHL custom-code block, the same in Votel — rather
than a plugin, a marketplace app, or anything that needs approving by somebody
else. That keeps one thing to build and one thing to break, and it is why the
snippet's constraints (loaded twice, injected late, no globals, no assumed
width) are written as requirements in the entry below rather than as nice-to-haves.

**Free to the shop, and we do not resell any of them.** A shop brings its own
GHL or Votel account; we integrate with what they already pay for.

**Easy Shop is the record.** Whatever else ends up wired, the CRM is the truth
and the platform holds a copy — the same rule as the Google Calendar push, for
the same reason: two systems both believing they own a customer is how a shop
ends up ringing somebody twice.

**Nothing is handed to their automations.** Confirmations, review requests,
follow-up nudges and status updates are our own jobs and stay ours. Their
platform is a place a form lives, not a place our work happens.

### The four directions, when it is time

Each is its own piece of work and they are listed in the order they earn their
keep:

1. **Their form into our leads and scheduler** — already covered by the funnel
   entry below. Nothing extra needed.
2. **Our real availability shown inside their funnel** — the hard one, and the
   valuable one. A funnel page that offers times it has actually checked against
   shop hours, day limits and the public window.
3. **GHL contacts into our clients** — so a shop that has been marketing for a
   year does not start with an empty client list.
4. **Our status changes back out as contact updates** — the marketing side
   knowing a car is finished. Last, because it is the one that can be wrong
   loudest in front of a customer.

### Before any of it

- A **sub-account to test in** exists now, so 2 is testable rather than
  theoretical.
- Votel needs looking at properly; it is named here on the strength of being the
  same kind of product as GHL, and nothing has been checked.
- Whether availability-in-their-funnel is **our snippet inside their page** (it
  already is, so this may be nothing) or **their widget calling our API**, which
  is a public read endpoint and a whole security conversation.

## Web funnels — a form on the shop's own site — BUILT 17 Sep 2026

**Shipped.** See SERVER-NOTES.md for what was built and how. What follows is
the decision record it was built from — kept because the reasoning behind
several of these is not visible in the code.

Mockup: `Web Funnels.dc.html` — the public form on a shop's own page, Admin ›
Web forms, the request queue, and the lead as it lands.

This is the queued *Online forms into Leads* and *Online scheduling into the
scheduler* items, settled together because they are one thing. **It is not the
Zapier or Meta work** and must not wait on it: Zapier bills per task, so a form
on the shop's own site routed through it would meter for nothing. Its own path,
and Zapier pipes in later beside it.

### The form

- **A snippet the shop embeds**, not a page we host. It renders **inline into
  their div**, so it takes their fonts and colours rather than arriving in ours.
  Nothing in it may assume a width — the column belongs to their layout.
- **One form, two purposes**: an estimate, or a drop-off.
- **Fields**: name, phone, email, year/make/model, insurance company, claim
  number, what happened, and how they would rather be contacted. **Email is
  required** — both confirmations go there, and a booking the customer has no
  record of is worse than one more field.
- **One form per shop**, with a **campaign tag on the link**, so one landing
  page can be told from another.
- **Honeypot and a rate limit per IP.** Nothing on the form describes either —
  a line telling the customer about a hidden field tells the robot too.
- **Public key in the snippet plus a domain allowlist** the owner sets. The key
  is readable by anyone viewing the page; the allowlist is what makes a scraped
  one useless.
- **WCAG 2.1 AA**, for the same reason `checkin.html` is. See CLAUDE.md.

### Booked, or requested

- **An estimate is booked outright.** The time is theirs and the desk sees it
  appear.
- **A drop-off is requested**, and **the slot is held for 24 hours**. A held
  slot **counts against the day's limit** — otherwise two people hold the same
  Tuesday morning.
- **On expiry the slot is released and the desk is told it lapsed.** The lead
  stays, to chase.
- **The customer is emailed on booked and on confirmed. Nothing else.** A
  declined or lapsed request is a phone call from the shop, not an email.

### What the public may book

- **The shop's real hours and day limits**, narrowed by a **public window** the
  owner sets: a weekly pattern plus dated exceptions. Blocking a day for the
  public does not close the shop, and the desk can still book anything.
- Closures and holidays are **read from the shop calendar**, not set here —
  un-ticking a holiday is not something this screen should be able to undo.
- **Hourly slots.**
- **Public and desk share one day limit** — first come, first served.
- **Nothing inside two hours of now.** Without it a stranger takes the last slot
  at 8:55 for a 9:00.

### What it creates

- **Normally a lead**, the same row the counter writes, with the appointment
  hanging off it. The follow-up clock, the owner and the estimate path are
  unchanged; the only new thing is where the row came from. **Never a repair
  order** — somebody at the shop opens the file when the car turns up.
- **A returning customer skips the lead.** Matched on **phone, and only where
  they have a past file** — a client row alone is not enough. The request is
  attached to their record and still **lands in the request queue** like
  everyone else, because nothing else would put it in front of a person.
  Confirming it **books the appointment and asks whether to open a file**.
- **A submission against a car with an open file is told loudly**: a
  notification to the owner and front office, and the **red mark on the file**
  that a mention gets. It is usually a question, not new work. **The mark clears
  by answering it in the queue** — no clock, unlike a mention.
- **A duplicate raises its own lead, flagged as a repeat.** Somebody asking
  twice is a thing the shop should see, not something to tidy away.

### Where the desk works it

- **A tab on Leads**, not its own screen.
- **Confirm, move or decline**, with what is holding a slot and how long is left
  on it. Confirming books it properly — hours, the day's limit and the person's
  own day checked the same as a desk booking (`scheduleGuards`), and it pushes
  to the shared Google calendar. Declining releases the slot and leaves the lead.
- **Owner, front office, and anyone who can manage leads.**
- **Notified on arrival**: owner, front office, and whoever it is assigned to.
  One notification event, so it obeys the suppression list like everything else.

### Reporting

- **Its own per-campaign report**: leads, work won, and dollars. A campaign
  field that does not reach Reporting is decoration.
- **Dollars are the closed amount**, dated by the **close date** — when the
  money actually landed.

### Settings

Its own Admin tab, **Web forms**: the snippet to copy, the public key and its
allowlist, which purposes are offered, the hold length, and the public window.

### The customer's own details, and who they turn out to be

- **Name, phone and email can never be removed** from the field list. A lead
  with no way to reach anybody is not a lead.
- **The shop builds the rest of the list** — picking from ours, reordering, and
  adding **its own questions**: short text, pick-one-from-a-list, or yes/no.
  Different questions per purpose, because *do you need a rental* matters on a
  drop-off and not on an estimate.
- **A custom question is always optional.** Required fields are ours alone — a
  shop that makes six of its own required has built a form nobody finishes.
- **Custom answers are their own rows on the lead**, and are **copied onto the
  file as a note when it converts.** The file keeps its own fields; the answers
  travel as the record of what was asked.

### Several shops behind one form

- **Locations are separate shops already** — two databases, two keys — and the
  form routes between them. **Configured in platform admin**: one group, the
  shops in it, one snippet. The group itself is defined under *Locations*
  (1 Oct 2026) at the top of this file.
- **Location first.** Nothing else is shown until they pick, because hours,
  limits and the public window all belong to a particular shop.

### Sending

- **From "Bonham Collision (via Easy Shop)", replies go to the shop.** The
  from-address has to be on our Resend-verified domain, so the shop's name can
  only be the display name — Zocdoc's arrangement.
- **The wording is the shop's, per event, with merge tokens.** Not one house
  email with a shop name dropped in — the shop writes each one and we fill the
  blanks. Short, with a line saying how to reach the shop to change it.

  **Estimate booked** — the default, as written 17 Sep 2026:

  > Thank you [ First Name ] for reaching out to schedule an estimate
  > appointment for [ appointment date ] at [ appointment time ]. We look
  > forward to evaluating the damage and creating a plan to return your vehicle
  > to pre-loss condition.

  **Drop-off requested** — the default:

  > Thank you [ first name ] for scheduling an appointment to drop off your
  > [ vehicle year ] [ vehicle make ] [ vehicle model ]. Our office will be
  > confirming your appointment soon. Please expect an email or phone call to
  > confirm.

  **Drop-off confirmed** is the third and nobody has written it yet.

  Tokens, from those two: first name, appointment date, appointment time,
  vehicle year, vehicle make, vehicle model. Shop name and address as well,
  since a shop will want them.

  **A token with no value is the thing to get right.** The shop can remove the
  vehicle field from the form, so `[ vehicle year ]` can legitimately be empty
  and *"drop off your   ."* is what arrives. Either the whole sentence carrying
  an empty token is dropped, or the editor refuses a token for a field the form
  is not collecting — the second is better, because it tells the shop at the
  moment they are writing rather than at the moment a customer reads it.
- **An unsubscribed address is carried, not refused** — the form is the
  customer's own hand, the same call as check-in, and it writes a
  `suppression_hits` row. **The form then shows a neutral line** — *we will call
  to confirm* — rather than promising an email that will never arrive. It never
  says why, because the reason is not the customer's business on a public page.

### The rest, settled

- **The two-hour notice and the 24-hour hold are shop settings**, beside the day
  limits.
- **A held slot whose hours change underneath it is flagged in the queue as
  conflicting** and left for a person. Neither releasing it nor honouring it
  silently is defensible when the shop has changed its mind after promising.
- **A rate-limited submission sees a generic "try again in a minute."** A robot
  reads whatever a person reads.
- **Included wherever Leads and the Scheduler are** — not sold separately.
- **`source` is "Web form"**, alongside the campaign tag and the page it was
  submitted from. Reporting reads all three.
- **The owner sets the accent colour and the ink on it** in Admin, so the form
  matches their theme. The accent carries the **submit button, the selected day
  and time, and the field focus rings**; everything else stays neutral and
  inherited.

### The one tension, on purpose

Both the accent **and the ink on it** are the owner's to pick — the form has to
match their theme easily, and a shop that cannot set its own text colour will
fight the thing forever. So it is **warn-and-allow**: the owner is told when a
pair fails contrast and may use it anyway.

That sits against the AA rule in CLAUDE.md, which this form is held to — and the
warning is where our part ends. A shop that was told and proceeded has made its
own choice about its own public page.

**The acceptance is logged for our records** — who, when, which colours, what
they measured — as an ordinary audit row. It is never mentioned anywhere else:
not to the customer, not in the form's markup, and not as a banner or reminder
to the shop afterwards. It is a record, not a message.

The warning **names what actually breaks** — the ink on the button, or the focus
ring against a pale ground (3:1 for a UI component) — rather than saying "this
may be hard to read". A warning nobody can act on is decoration.

### Who actually installs it

**Most shops are not running their own site.** Whoever does — an agency, a
nephew, a platform reseller — is the person who pastes the snippet, and they
never see the CRM. So Admin has to produce something sendable: the snippet, the
domain to allowlist, and what the page needs, in one block that can go in an
email to a web person who has no Easy Shop login and no context.

**It must run on WordPress and HighLevel** without being wired for either.
Neither is an integration; both are just places this has to work. What that
means in practice, and what will actually break if it is ignored:

- **A page builder that strips or reorders `script` tags.** The snippet cannot
  assume it runs after its own target div exists, or that it runs once.
- **Loaded twice** — two blocks on one page, or a builder duplicating the
  embed. It must no-op the second time rather than draw two forms.
- **Injected after page load**, into a tab or accordion that was not in the DOM
  when the script ran.
- **No global collisions.** These platforms carry jQuery and a pile of other
  people's code; nothing may be assumed absent and nothing of ours may be
  global beyond one namespaced object.
- **The container's width is theirs**, which is already the rule.

**PHP is not required and the instructions must not claim it is.** The snippet
is a script tag and our API — there is no server-side component on the shop's
host, so a page that renders at all can run it. Raised 17 Sep 2026 because most
hosting has PHP anyway; worth a line in the instructions saying plainly that
nothing needs enabling, since that is the question a web person will ask.

### Still to work out in build

- Whether a shop group's **snippet exposes both public keys** or a group key
  that resolves server-side. Still undecided. The group key is better and is
  more work; two keys in public HTML means a scraped pair, which the domain
  allowlist already blunts.
- The **third email** (drop-off confirmed) ships with wording nobody wrote.
- Testing on a **real WordPress install and a real HighLevel funnel** before
  this is called done. Both are an afternoon and neither can be reasoned about
  from here.
- Custom questions can be added but not **reordered or edited** afterwards.
- The **multi-shop form** (location first, platform admin) is designed above.
  A shop asked on 1 Oct 2026 — it is now part of *Locations*, at the top.
- `Web Funnels.dc.html` borrowed the example site's brown by hand for the
  selected day and the button. The shipped form takes the owner's accent and
  ink instead; the mockup is now behind the build.

## Marking a lead won by hand — 16 Sep 2026

**Done** — see SERVER-NOTES. Capability `win_lead`, owner only by default,
tickable per role. Decisions recorded there: the file is optional on a manual
win, converted and linked are kept apart by `ro_link_kind`, a link can be
undone and a conversion cannot, and one file answers to one lead.

## Zapier — Facebook and Instagram funnels — 15 Sep 2026

Raised as the next thing to wire in. **Not started.**

Lead ads from Facebook and Instagram arriving as leads in the shop, through
Zapier rather than Meta's API directly. That is the right call to start with:
Meta's Lead Ads API needs an app review, a business verification and a page
access token per shop, and Zapier already holds all of that. The cost is a
per-shop Zapier subscription and a dependency on somebody else's uptime.

### What it needs from us

**An inbound endpoint** — `POST /api/intake/lead`, authenticated by a per-shop
key rather than a session, because Zapier has no user. That key is the whole
security model, so: generated per shop, revocable from the admin screen, shown
once, and stored hashed the way the EMS agent token already is.

It writes the same lead row the counter writes, so the follow-up clock, the
owner, the estimate path and the onboarding clock all work unchanged. The only
new thing is where the row came from.

### What has to be decided

- **`source`.** `SOURCES` currently has 'website' and 'other'. A funnel lead
  wants its own value, and probably a `campaign` field beside it — otherwise a
  shop cannot tell which ad is producing, and that is the entire reason for
  doing this. That field has to reach Reporting or it is decoration.
- **Which clock.** A funnel lead is not a sales write-up, but it is closer to
  one than to a walk-in: somebody filled a form and expects a call. Probably its
  own hours figure beside `sales_onboard_red_hours`.
- **Deduplication.** The same person fills the form twice, or an ad runs on both
  platforms. Match on phone within some window, and merge rather than refuse.
- **Rubbish.** Lead ads attract a lot of it. A quarantine state, or at least a
  source filter on the leads screen, so a bad week of spam does not bury the
  real ones.
- **The unsubscribe list.** A funnel lead carrying a suppressed address must be
  carried and reported, not refused — same as the EMS import and a lead
  conversion. `refuseEmail` is for desk typing; this is not that.
- **Rate limiting**, because the endpoint is public and keyed.

### Worth doing at the same time

The queued *Online forms into Leads* item is the same endpoint with a different
caller. Build the intake path once and let Zapier be one client of it, rather
than two doors into the same table.

## Tagging somebody in a note — BUILT a0.6.0, 15 Sep 2026

Built. `SERVER-NOTES.md` has the receipt. Kept as the record of what was decided.

Raised in a demo. Write a note on a file, tag a person in it, and they get it in
their inbox — plus a mark on the file so the floor can see it needs somebody's
attention.

The inbox and the delivery machinery already exist: a mention is one more
`notify()` event with the tagged person as a direct recipient, which is what
`directUserIds` was built for. The new parts are the marker and the rules around
it.

### The mark

A red warning triangle on the board row and on the file, the same treatment
total loss already gets (red, inset edge) so it reads as "look at this" without
inventing a new visual language. It has to carry a count when more than one
mention is open, or a file with five unanswered mentions looks the same as one
with one.

**What clears it — decided 15 Sep 2026.** The tagged person opens the file
**and leaves a note**. Opening alone does not clear it: "I saw it" is not "I
dealt with it", and a marker that clears on a glance is a marker nobody trusts.
The note is the evidence, and it is already the thing the next person reads.

That means the clear is per mention, not per file: two people tagged means two
marks, and each clears when that person writes. The file's marker goes when the
last one does.

**And it is timed.** Two days to answer.

- **At 24 hours**, if the mention is still open, notify three parties: the
  person who was tagged (again), **the person who tagged them**, and the shop
  **owner(s)**. Telling only the tagged person again is what a reminder does;
  telling the asker is what stops them assuming it was handled; telling the
  owner is what makes it a shop problem rather than a private one.
- **At 48 hours** the mention is overdue. Still open, still marked, and now
  visible as overdue rather than merely waiting — the owner's list is where
  that belongs.

**The clock is ACTUAL hours, not shop hours** — decided 15 Sep 2026, the same
call as the sales onboarding clock. A Friday evening mention hits 24 hours on
Saturday and that is the point; a clock that waits for Monday is not a reminder.

Still open: whether 24/48 are shop settings (they should be, beside the lead
follow-up days and `sales_onboard_red_hours`), and whether an overdue mention
escalates again at 72 hours or stops nagging and sits on a list.

### Decisions still open

- **Who can be tagged**: anyone at the shop, or only people who could see that
  file anyway? A technician tagged on a file they cannot open is a dead end, so
  the picker should offer only people whose role lets them see it.
- **Who can tag**: anyone who can write a note, presumably.
- **Does a mention override notification preferences?** Somebody typing your
  name is not the same as the board chattering, so a mention should probably
  reach you even with status changes switched off. It must still respect the
  suppression list — an unsubscribed address gets the in-app copy and no email,
  which is already how `sendMail` behaves.
- **Syntax and storage**: `@` with a picker, and the note stores the user id
  rather than the typed name, so renaming somebody does not break old notes.
- Does a mention on a **closed** file still notify? Probably yes, and probably
  without the marker, since the board row is gone.
- Whether a mention shows on the **cycle/print** views, or screen only.

## Scheduling sublets and pickups from the file drawer — 15 Sep 2026

Also from the demo. Today the scheduler is its own screen and the sublet lines
live on the file, so booking the van for Tuesday means leaving the file you are
looking at. Three bookings should be makeable from the drawer:

1. **Sublet out** — and back. A sublet line already has a vendor and dates; this
   puts those dates on the schedule as real appointments instead of text.
2. **Return / pickup** — the customer collecting, which is the one the front
   office is asked about most.
3. **Drop-off**, for a car booked in but not yet arrived.

### What it should also do, since the pieces exist

- **Moving a sublet booking should stamp the sublet line**, and moving the file
  to *At Sublet* should offer to book the return. The sublet lane and the sublet
  lines currently track the same trip in two places that do not talk.
- **Push to the shared Google calendar**, which is live — so a sublet booked
  from the drawer appears on the shop calendar the same as a desk booking.
- **Respect the day limits and the time-off layer** already in the scheduler,
  including the conflict list and the override, rather than writing a second
  booking path that skips them.

### Open

- Does a sublet booking belong to the **vendor** as a resource? Two cars out to
  the same vendor on the same day may be fine or may not; the shop knows.
- What happens to the booking when the file is **voided or closed** — cancelled,
  or left as history?
- Whether a pickup booking should **notify the customer** once SMS is live, and
  whether that is the same wording as *Vehicle Ready*.
- Whether these appear as their own appointment **types** on the schedule with
  their own colours, or reuse what is there.

## Unsubscribe — the whole chain — BUILT a0.6.0, 15 Sep 2026

Built. `SERVER-NOTES.md` has the receipt. Kept here as the record of what was
decided and why.

**The four decisions**, all settled 15 Sep 2026:

- **Per shop**, because each shop is its own controller. Hard bounces and
  complaints go platform-wide instead — an address that does not exist is not a
  shop's call, and sending again costs every shop its reputation.
- **No transactional exemption.** *If they unsubscribe, they unsubscribe*, reset
  links included. The consequence is real and accepted: that person cannot reset
  their own password, so an owner sets it or they re-subscribe first.
- **Re-subscribing is the customer's**, on the public page, on a link they hold.
  There is no desk route to it.
- **One suppression table with a channel column**, so STOP and unsubscribe are
  not two systems.

**Keyed on the destination, not a customer row** — that was the load-bearing
detail. Otherwise editing a client, deleting one, or re-importing an estimate
quietly un-blocks the address.

**Checked in `sendMail` and nowhere else**, since every send goes through it. A
refusal is recorded as `suppressed`, not `failed`, because `failed` invites the
retry that must never happen.

**Refuse where the desk types, carry-and-report where it arrives otherwise** —
check-in is the customer's own hand, a lead conversion is a car being taken in,
and an estimate is authoritative about the claim but not about consent. All
three write a `suppression_hits` row.

Still open: nothing displays the state on the file (the desk finds out by
typing); no bounce webhook writes to the platform list; no screen for releasing
a platform suppression; `suppression_hits` is written but never read.

## Intake, scheduling and SMS — to be piped in — 15 Sep 2026

Raised while writing the landing page, extended the same day with the messaging
work below. None of it is started. The first three are named on the landing page
under *Coming next* rather than described as live — if any of them ships the copy
moves up into the module list. The shared shop calendar was in this band and came
out of it: it is live.

### Online forms into Leads

A public form on the shop's own site posts into the shop's Leads. Same lead
record the counter writes, so the follow-up clock, the owner and the estimate
path are unchanged — the only new thing is where the row came from.

To decide: whether the form is hosted by us (a per-shop URL, like `checkin.html`)
or a snippet the shop embeds; how the shop is identified without exposing a
tenant id; spam handling; whether a form submission notifies immediately or joins
the normal follow-up clock; and what `source` values Leads grows (counter, phone,
online form, funnel).

### Leads from funnels

Same intake path, different origin — an ad or landing funnel posting in. Needs a
campaign/source field on the lead so the shop can tell what a funnel is actually
producing, and that field has to reach Reporting or it is decoration.

### Online scheduling into the scheduler

Customer picks a slot themselves and it lands on the shop's schedule. This is the
one with real conflicts to solve: which slots are offered (day limits already
exist), how double-booking is prevented between a public request and the desk
booking at the same moment, whether a request is provisional until someone
confirms it, and what the customer sees back.

### Google Calendar for the shared shop calendar — LIVE

Owner connects through Google sign-in on the settings screen, picks the calendar
that receives appointments, and bookings, moves and cancellations are pushed to
it. Needs `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` set. Push only; nothing is
read back.

Confirmed live 15 Sep 2026, so it is off the landing page's *Coming next* band.
Still to check when online scheduling lands: that an appointment booked by a
customer pushes the same way a desk-booked one does.

### Twilio SMS

Customer-facing status messages over SMS. The status routing grid already decides
who a status change notifies internally, and the wording is meant to match the
customer-facing email, so those ship together.

**Decided 15 Sep 2026:**

- **A number per shop.** Each shop gets its own Twilio number rather than every
  shop sending from a shared one. The point is blast radius: one shop sending too
  many messages gets *that* number flagged, not every shop on the platform. It
  also means the shop is the sender the customer sees.
- **Frequency is four to eight messages per vehicle.** Sent on real status
  changes, so a job waiting on parts or a supplement sits at the top of that
  range. This is the figure published on `SMS Terms.dc.html` and the figure the
  carrier registration is held to — if real sends come in above it, the page
  changes before the sending does.
- **Still open:** whether the sender named to the customer is *always* the shop,
  or set per shop. The terms page currently says "set per shop", which is the
  softer of the two. A carrier reviewer will hold the registration to whichever
  version ships, so this needs pinning before submission.

**BUILT 1 Oct 2026.** a0.7.3: per-shop credentials, sender, verify, test send,
STOP/START webhook, the send gate. a0.8.0: status update texts (Admin › Text
updates), the drawer's Customer communication thread, replies matched to the
file and notified. Mockup: `Customer Texts.dc.html`. Still open: the text
updates toggle at check-in and in the sales app (it is on the file drawer now).

**Before it can go live** Twilio wants published consent language: how a number is
collected, what messages it will receive, STOP/HELP handling, and a privacy and
unsubscribe page to point at. Written in `SMS Terms.dc.html` — two details still
outstanding, the assigned number and a registered address for Storm Rider
Solutions. Also needs: an opt-out flag per customer that survives a re-import,
STOP handling wired to it, and per-shop number provisioning at shop creation.

### Direct messages to the customer — 15 Sep 2026

Not just automated status updates: the desk should be able to send a customer a
message directly, from the file, while their vehicle is active.

**Decided:** it is **two-way**. Sent and received directly into the file — the
customer's reply lands on the file, not in a separate inbox somebody has to watch,
so the thread reads as one conversation alongside the automated status updates.

**STOP means everything stops.** A customer who has sent STOP receives no further
messages of any kind — not status updates, not a direct message from the desk,
not a review request. The opt-out is one flag and it governs all sending. The
desk needs to see that flag on the file, and the send control needs to be visibly
unavailable rather than failing silently when someone tries.

To decide: what "active" means exactly — an open file, or anything not yet
closed; who may send (front office and owner, presumably, but a tech texting a
customer directly is the thing to think about); whether a free-typed message is
throttled the way automated sends are; and what happens to an inbound message on
a file that has already closed.

### Review requests on delivery — 15 Sep 2026

Two messages, not one, and the second only goes if the first gets a yes.

**Step one**, 24 to 48 hours after the vehicle is marked delivered — a yes-or-no
question:

> We appreciate your business and would like to make sure the process is 5 star
> worthy.

**Step two**, only on a yes:

> We are glad your experience was 5 star. Please leave us a review on Google
> (url here).

That shape is the point: the shop asks before it asks. A customer who says no
never gets the review link, and the shop finds out there is a problem instead of
watching a one-star review arrive.

Needs a **delayed send** rather than the immediate-on-event path everything else
uses: a scheduled job reading the delivery stamp, not a hook on the status
change. The delay inside that 24–48 hour window should be a shop setting. It also
needs **inbound reply parsing** for step one — a yes/no answer arriving as a text,
which means handling everything that is not a clean yes or no.

To decide: what a **no** does beyond suppressing the link — whether it notifies
the owner, opens something on the file, or is just recorded; what an unparseable
reply does; how long step one waits for an answer before it gives up; where the
shop's review URL is held (a shop setting, one per location); whether a request
is suppressed outright on a file that went badly — reopened, comeback, unpaid
balance; whether it obeys the same consent as status updates or needs its own,
since carriers treat a review request as closer to marketing than to service
messaging; and that it is never sent twice for one vehicle.

## Close-out labour block — the clutter — BUILT 12 Sep 2026

Mocked in `Close Out.dc.html`. Six columns for three facts, and the first two
collide: **Chuy Alverez (also body)Paint**.

- **Trade joins the name as a chip**, and the other trades they work drop to the
  quiet line under it, so a long name cannot run into a column.
- **The rate column goes.** It read "—" on most rows. The rate becomes the
  sentence under the name — *6.2 hrs at $34.50*, *12.5% of $4,582.19* — which
  also says how the cost was arrived at.
- **Figure and cost sit together**: you type on the left, the money lands beside
  it, instead of two columns apart with a unit floating between.
- **Basis becomes a select.** A percentage is open to every trade now, so there
  are four options; three buttons was already tight.
- **A row flagged on the floor says so**, so the desk knows which figures it is
  confirming rather than entering.
- **A missing rate reads as English** — "enter a figure, or set one on his person
  sheet" — rather than red "none set" in a column nobody reads.

The rest of the window — paint materials, deductible, rental, sales pay and the
profit strip — stacks the same way and is still to be worked through.


## Flagging techs before close — BUILT a0.3.0, 12 Sep 2026

A *Flag techs* button in the file drawer and a line on the file saying which
trades are flagged and which are not. One row per trade, only where somebody is
assigned; each entered as a percentage, a flat dollar figure, or hours. Close
out reads the flags rather than asking at the worst possible moment; an
unflagged trade warns and does not block. Mocked in
`People and Tech Pay.dc.html`, receipt in `SERVER-NOTES.md`.

Still open: what counts as *has paint* is currently paint labour on the estimate
or a painter flagged with hours; whether sublet should come out at cost the way
parts do.

## People screen, and paying techs a percentage — BUILT a0.3.0, 12 Sep 2026

Mocked in `People and Tech Pay.dc.html`. Two things in one item: the People
screen is unreadable, and tech pay needs a percentage basis it does not have.

### The screen

Every person's row renders all eight role chips and all nine trade chips whether
they are held or not — seventeen buttons per row, of which two or three are on.
That is the clutter.

- **The row states what is true**: name and sign-in, primary role with the rest
  as "and technician", trades as words, and the pay plan in a line.
- **Editing moves into a sheet** opened on the person, with Details, Access and
  Pay as tabs. *Add someone* opens the same sheet empty — the wide add panel at
  the top of the screen goes.
- **Sign-in code, password reset and remove** move under a ⋯ on the row. Rare
  and dangerous, and they do not belong sitting in every row.
- Filter chips across the top: everyone, technicians, office, sales, no pay
  plan, removed.

### Pay plans

Pay is set **per job type**, because the shop pays differently by job type. Each
row is either a flag rate on hours or a percentage of what was billed, and a
percentage carries two figures — **with paint** and **body only**.

George, a body tech, as the worked case:

| Job type | Basis |
| --- | --- |
| Wholesale | 12.5% with paint, 25% body only |
| Retail and insurance | flag hours at $32.00 |
| Cash quote | same as wholesale — 12.5% / 25% |

**The percentage runs off the approved amount after any parts we bought come out
at cost.** A $450 wholesale car with no parts pays $56.25 at 12.5%. A $6,482.19
file carrying $1,900.00 of parts at cost runs 12.5% off $4,582.19 and pays
$572.77. Cash quote defaults to the wholesale figures and can be set separately.

### At close out

The close-out sheet gains a technician pay block: **one row per trade** — body,
PDR, paint, detail, R&I — **and only where someone is assigned**. No two techs
of the same trade on one file, so no splitting. Each row shows the person, the
basis in words ("Wholesale with paint · 12.5% of $4,582.19"), and the figure,
which is **proposed and editable**. A tick commits it to that person's payroll
week at the close date. A tech with no plan for that job type is flagged, not
silently paid nothing. The basis line at the top of the block states what the
percentages are running off, so the number is never a mystery.

A closed file **keeps the plan it was settled on** — changing a percentage later
does not move money on a file that is already closed.

To work out in build: what counts as **has paint** — any paint labour line at
all, or paint hours above a floor; whether **sublet comes out at cost** the way
bought parts do, since the rule as given names parts only; whether a percentage
tech is paid the same when another trade on the file is unassigned; and where
the existing Hr / Flat labour rate on the person row ends up once plans exist.

## Recording payments on a file — BUILT a0.3.0, 12 Sep 2026

Mocked in `File Payments.dc.html`. Paid stops being a flag someone sets and
becomes the balance reaching zero.

**A payment is a row** — amount, method, payer, received date, reference number,
who recorded it — against the file. Built on the same table the invoicing port
will use, so a receipt can sit against an RO, an invoice, or both.

**Methods**: check, cash, card, insurance draft / EFT, write-off / discount.
A check or a draft **requires its number**; cash, card and a write-off have no
number field. Every payment takes an optional note.

**The number may repeat across files but not on the same file.** One insurance
draft often pays four ROs. Entering it twice on one RO is the mistake the rule
catches, and the message names the payment it collides with.

**Who pays** is recorded per payment — customer or insurer.

**Who may record**: owner, admin, front office, accounting.

**One modal, three ways in.**

1. While the file is open: a *Record payment* button on the file detail. The
   modal opens over the file drawer; the file detail itself never takes payment
   input, it only shows the record.
2. Closing out: mark **paid** and close, and if a balance is still showing the
   modal opens for the rest. **Save and add another** keeps it open for the next
   check — the whole stack is entered in one sitting and nothing is written
   until *Record and close file*. Mark it **unpaid** and the file closes with no
   modal at all.
3. After close: a closed file with anything owing carries the same button.
   Recording the last of it marks the file paid.

**The close date never moves for a payment.** Money landing in October against a
file booked to September leaves the booking where it is; the payment carries its
own received date.

**On the file detail**, payments are their own section beside parts and sublet: a
fill bar split insurer / customer, the receipts as rows with method, reference
and who recorded them, and what is still out.

To work out in build: what the balance is owed against — approval amount alone,
or approval plus approved supplements; whether the 382 paid rows in the live
data get a payment row each or are left as a bare flag; whether a wrong amount
voids with a reason and an audit row the way void works elsewhere; whether
recording a payment moves the file to the Payment Collected status or that stays
hand-set.

## Estimate written on a lead — BUILT a0.2.9, 10 Sep 2026

Shipped. See SERVER-NOTES.md for what went in. Kept here as the record of what
was decided and why.

Mockup: `Leads Mobile.dc.html` turn 2, four phones — the list, a lead with a
quote, the write screen, and a lead with no quote following up as normal.

The shape of the day: they walk in, the info goes in as a lead, an estimate gets
written at the counter, and someone chases it days later. More often than not
that is what a lead is. A lead with no estimate still has to chase the same way.

**Two states, not one.** `estimate_written` is the one written here at the
counter; `estimate_sent` is the insurer one. They join New, Contacted, Appraisal
booked, Won, Lost.

**Cash-pay stops at written.** Only insurance work reaches sent, so *Mark
estimate sent* is offered only when the payer is insurance; a cash lead is told
it stops at written.

**The amount lives on `estimate_written` and is required.** Marking it written
asks for the figure and will not save without one. `estimate_sent` carries no
amount of its own. The write screen also fills *Written on* with today's date,
editable for an estimate written earlier, and takes an optional note.

**Re-quoting overwrites.** The latest figure is the number; the previous one goes
to the activity log as its own entry ("Quote changed from $3,150 to $4,280").

**The follow-up clock does not change.** Same days whether or not an estimate
exists — a written quote does not chase sooner or later.

**On convert, quoted stays separate from approved.** The figure rides along as
the lead's own number rather than filling the RO's approval amount, so the two
can be compared later.

**Two KPIs change.** In go a money close rate (won dollars over quoted dollars)
and a count of quotes with no follow-up logged; average quote replaces average
first reply, unanswered stays. **A lost lead's quote stays in the quoted total** —
it is a lost quote worth counting.

**Open, from the mockup:** the new state label needs 92px in the list's State
cell so Age drops to 46px, and the row now carries a *Not chased* tag competing
with the existing *Follow up* tag in the same cell — probably one or the other,
not both. The phone header rework (about 350px before the first lead, the
`.leadkpis` band that never got `shell.css`'s 760px hide, Leads reachable only
through More) is still open and untouched by this.

## Who a status change messages — BUILT a0.2.9, 10 Sep 2026

Shipped. See SERVER-NOTES.md. Kept here as the record of the mapping.

Mockup: `Permissions.dc.html` turn 2 — Admin › Notifications. A grid, statuses
down and ten targets across, every cell a tick. The mapping below is what ships
as the default; a shop reticks it.

**Ten targets, in two kinds.** Six are roles — Owner, Production manager, Parts
manager, Estimator, Front office, Accounting. Four are *the person assigned on
this file*: assigned tech, assigned PDR tech, assigned painter, assigned detail.
The assigned four never message everyone in a trade, only whoever is on the car.
A person holding several roles is messaged once.

**The mapping, as decided:**

| Status | Messages |
| --- | --- |
| Vehicle Arrived | Owner, Production manager, Front office |
| Customer Auth Acquired | Front office |
| Claim Info Verified | Front office |
| Awaiting Assessment | Owner, Production manager |
| Awaiting Scope | Estimator |
| Scoping | Estimator |
| Scope Complete | Production manager, Front office |
| Awaiting Teardown | Production manager, assigned tech |
| In Teardown | Production manager, assigned tech |
| Teardown Complete | Production manager, Estimator |
| Estimate / Supplement Needed | Estimator |
| Estimate / Supplement Sent | Front office |
| Awaiting Approval | Front office |
| Estimate / Supplement Approved | Estimator, Front office |
| Estimate Review | Estimator |
| Parts Needed | Parts manager |
| Parts Ordered | Production manager |
| Awaiting Parts | Production manager, assigned tech |
| Parts Backordered | Production manager, assigned tech |
| Awaiting PDR | Production manager, assigned PDR tech |
| Working PDR | Production manager |
| PDR Complete | Production manager |
| Awaiting Body | Production manager, assigned tech |
| Working Body | Production manager, assigned tech |
| Body Complete | Production manager |
| Awaiting Prep | Production manager, assigned painter, assigned detail |
| Working Prep | Production manager, assigned painter, assigned detail |
| Prep Complete | Production manager, assigned painter, assigned detail |
| Awaiting Paint | Production manager, assigned painter |
| Working Paint | Production manager, assigned painter |
| Paint Complete | Production manager |
| Awaiting Reassembly | Production manager, assigned tech |
| Working Reassembly | Production manager, assigned tech |
| Reassembly Complete | Production manager |
| Awaiting / At / Working / Complete Sublet | Production manager |
| Awaiting Buff | Production manager, assigned detail |
| Working Buff | Production manager, assigned detail |
| Buff Complete | Production manager |
| Awaiting / Working / Complete Detail | Production manager |
| Initial Wash | nobody |
| QC | Owner, Production manager |
| Final Detail | Owner, Production manager |
| Final QC | Owner, Production manager |
| Payment Verified | Front office, Accounting |
| Customer Contacted | Owner, Front office |
| Customer Scheduled | Owner, Front office |
| Vehicle Ready | Owner, Production manager, Front office |
| Payment Collected | Owner, Front office |
| Picked Up | Owner, Front office |
| Paperwork Verified | Owner, Front office, Accounting |
| File Closed | Owner, Accounting |

**The per-lane supplement checkpoints** route the same in every lane: Supplement
Needed → Estimator; Supplement Sent → Production manager, Front office;
Supplement Approved → Production manager plus Estimator in PDR and Body, plus
Front office in Refinish, Production manager alone in Reassembly. The checkpoint
sits at a different point in each lane (after PDR Complete, before Body Complete,
before Working Paint, before Reassembly Complete) — the routing grid draws it
where it actually sits.

**One status deliberately messages nobody**: Initial Wash.

**To work out in build:** whether the four assigned targets fall back to the
lane's role owner when nobody is assigned; whether a shop reticking this gets a
preset per shop type the way roles do; whether these rows live beside
`role_caps` or in their own `status_routes` table keyed on `slot_id` (slot_id is
canonical, so routing should bind to it, not to the label); and how this meets
the existing `NOTIF_GROUPS` in `db/status-template.ts`, which ships a parallel
position-and-event router that this grid supersedes for `status.change`.

**Settled in the build:** the grid governs `status.change` once the shop has any
routing row at all; `NOTIF_GROUPS` stays and keeps the other seven events. Zero
rows for a status means nobody, which is why the question is asked of the table
rather than of each status.

## Parts detail — the modal, not the drop-down — BUILT a0.2.9, 10 Sep 2026

Shipped. See SERVER-NOTES.md. Kept here as the record of the decisions.

Mockups: `Parts Detail A.dc.html` and `Parts Detail B.dc.html`. The implemented
version expands the lines inline under the row in `parts.html`, which is the
thing being replaced.

**It is a modal over the list.** Both mockups are; they differ in how the lines
are arranged. A is one scrolling table with group bars; B puts the four stages on
a left rail and shows one stage at a time. B is the one being carried forward.

**Grouped by status**, not flat: To order / On order / Back order / Received.
Every group heading carries its line count, its dollar total, the oldest ETA or
days waiting, and its batch action. Received is open like the rest.

**Eleven columns stay on the row** — part, part #, type, qty received of ordered,
vendor, status, order #, ETA, list, cost, PP — at 36px rows. The clutter
complaint was the flat list, price-and-cost stacked in one cell, and the row
rhythm; not the column count.

**Cost is not known until the order goes in.** A to-order line reads "at order"
in the cost column with no PP. Footer totals read *Cost so far*, parts profit is
computed on priced lines only, and a note says how many lines are unpriced and
why (not ordered yet vs. ordered with no cost entered).

**Part type is editable, and the estimate's type is carried alongside it.** The
EMS import supplies what the estimate calls for; the shop may order something
else — OEM on the estimate, aftermarket bought, or the reverse. Each line keeps
both. Where they differ the row shows the estimate's type beside the ordered one,
and the type menu heads with the estimate and marks that option "on estimate".

**Per-line action is the status cell.** Click a line's status to advance it —
Needed opens the order dialog, Ordered marks it received. No field of buttons on
every row. Ticking lines and using the bottom bar does the same in bulk.

**The order dialog** is where vendor, order number, ETA and cost are set. One
vendor and one order number per order; a mixed order runs twice. Per line it
offers oem / a/m / used with the estimate's type solid-outlined, a cost-each
field with live PP, and totals for list, cost and profit. It will not confirm
until every line has a cost.

**Modal header actions:** Add part, Costs, Print pull sheet, Copy VIN, Copy all
lines, Order all to-order lines. **Footer totals:** list, cost, parts profit,
lines received of total.

**To work out in build:** whether the estimate's type lives on the parts line as
its own column (`type_estimated` beside `type_ordered`) or is read back off
`ems_imports` each time; whether ordering from two vendors at once is worth a
grouped dialog after all; and whether cost entered in the dialog needs the
existing money capability check the receive path already has.

## Per-tenant database logins — built a0.2.7 — 30 Aug 2026

Code is in. What is left is yours to run, in order:

1. `openssl rand -base64 32` → `TENANT_MASTER_SECRET` in .env, and a copy in a
   password manager off the box.
2. `npm run tenant-creds` (dry run), then `--go --shop <test shop>`, then revert
   that one to prove rollback, then `--go` for the rest.
3. `npm run tenant-creds -- --audit` until every shop reads DERIVED.
4. **Then** `REVOKE ALL PRIVILEGES ON \`es_%\`.* FROM '<DB_USER>'@'localhost'` —
   this is the step that closes finding 08. Everything else only prepares for it.
5. Later, separately: remove the `DEFAULT` fallback in `config.tenantSecret`.
   Until then it is the rollback path.
6. Add "recreate the tenant logins" to the restore drill.

Still not decided: whether `.env` gets encrypted inside the nightly backup, or
stays plaintext in a private bucket with the secret in a password manager. Both
defensible — see the plan document.

## Accessibility — the internal pages — 30 Aug 2026

Done in a0.2.6: shared chrome (contrast via `--dim`, landmarks, skip link,
`Shell.announce`) and board.html (age no longer colour-only, drawer is a real
dialog with focus return, placeholder-only inputs labelled).

Per-page work left, roughly in traffic order. Each is an hour or two: label the
placeholder-only inputs, make dialogs real dialogs with focus return, call
`Shell.announce` where results are drawn, and give any colour-coded state a
second cue.

1. parts.html — the pull sheets and the inline cost fields
2. closed.html / clients.html — long tables, sortable headers need `aria-sort`
3. payroll.html / pay.html — money tables, and the run dialog
4. leads.html — the follow-up drawer
5. admin.html / permissions.html — the permission grid needs real table semantics
6. reports.html — charts need a text equivalent or a data table
7. messages.html, schedule.html, import.html, platform.html
8. Drag-to-reorder anywhere needs a keyboard route (2.1.1)

`sales.html` is excluded — desktop-artifacted on purpose per CLAUDE.md.

## Out of the security audit, round two — 30 Aug 2026

Answers given, work done in a0.2.5: allowlist narrowed to six types, security
headers, retention (10-year limit, 1-year archival, dry-run), daily session idle
expiry, tenant TLS, access logging, error-handler and IPv6 fixes, check-in page
to WCAG 2.1 AA, cookie disclaimer.

**Yours, not mine — this week:**

1. Attach an encrypted Block Storage Volume and move `STORAGE_DIR` onto it.
   Droplet local disks are not encrypted at rest; Volumes are. Highest-value
   half hour on this list.
2. Switch DigitalOcean backups from weekly to **daily** (7 copies kept instead
   of 4 weekly). Weekly means up to 7 days of loss.
3. **Restore one, once, and write down the date.** Untested backup = belief.
4. Read a `retention_runs` dry-run row, then set `RETENTION_ENABLED=1`.
5. Note: Droplet backups do **not** cover Volumes, and are deleted with the
   Droplet. Once storage moves to a Volume it needs its own snapshots, and one
   offsite copy (nightly per-tenant `mysqldump` to Spaces) covers the rest.

**Still queued, in order:**

1. **Processor terms (DPA) in the shop agreement.** Largest single risk
   reduction left, and it is a document.
2. Fill the brackets in `Privacy Policy.dc.html` and publish.
3. Nightly offsite `mysqldump` per tenant.
4. **TOTP** for platform owner and any role holding `admin`, `perms` or
   `wholesale_clients`. Roughly a day: storage + enrolment + second step +
   platform-owner reset. Not required for technicians.
5. Per-tenant database credentials (retire the `DEFAULT` fallback to the app's
   own DB password).
6. Deletion and export **on request** — the sweeper covers the clock, not a
   customer asking today.
7. Nonce CSP (needs a pass over every page in `server/web`).
8. Internal pages' accessibility — shared chrome done in a0.2.6; per-page work
   tracked in its own section above.

## Out of the security audit — 30 Aug 2026

Fixed in a0.2.4: upload content-type hole, security headers/CSP, rate limiting,
`trustProxy`, session idle expiry. Remaining, in the order I would do them:

1. **Encrypt the disk and test a restore.** Neither is code. The backup is
   undocumented and has never been restored from, which means it is not a backup
   yet. Do these before anything below.
2. **Retention and deletion — needs one decision from you.** How long after a
   file closes do its photos and customer contact details stay? How long after a
   shop cancels does their tenant database stay? Nothing is ever deleted today,
   and every state privacy law grants deletion rights the shop will pass to us.
   Once the windows are set: a sweeper, a per-customer delete, and an export.
3. **Processor terms with shops.** The policy is written; the contract that names
   Easy Shop a processor and the shop a controller is not. This is the single
   biggest exposure and it is a document, not a feature.
4. **Analytics consent plumbing.** Cookie Preferences mockup is built. Wire it
   before the first analytics tag ships, not after.
5. **TOTP for admin, accounting and owner roles.**
6. **Check-in page to WCAG 2.1 AA.** The one page a shop's customer touches; the
   only real Title III surface. Internal pages are an employment/accommodation
   question and can follow.
7. **Audit reads and exports, not just writes.** Today a curious employee can
   read every customer record and page through payroll without a trace.

## EMS import — overwrite, and the contact details — 24 Aug 2026, BUILT (a0.2.2)

Migration `014_ems_contact_overwrite.sql`.

**It overwrites now.** The apply path filled blanks only — `COALESCE` on every
field — so a file kept the approval amount and the deductible from whatever draft
was imported first. What a shop puts on an initial estimate is a guess; what comes
back approved is the answer, and a supplement is more authoritative still. Accepting
an import replaces the approval amount, labour hours, deductible, claim number,
policy number, date of loss, adjuster, vehicle details and customer contact with
what the estimate says.

Two things it deliberately does not do:

- **It never blanks a field the estimate is silent about.** A missing value in the
  file is not an instruction to erase what the desk typed.
- **It never moves `approved_at`.** The commission ledger dates its line from that
  stamp, so a re-import must not shift when a salesperson got paid.

**Nothing is overwritten quietly.** Every field that moves is recorded three times:
a row in `ems_import_changes` (scoped to the import, so the screen can show what
the last one did), an audit row with before and after, and a line on the file's
own note. The confirm screen says what overwrite means before you tick it, and the
result line names the fields that moved before it navigates away.

**Overwrite is a tick, defaulted on.** Unticking it gives the old fill-blanks
behaviour for a shop that wants it.

**Contact and insurance are pulled properly.** The parser was already reading the
customer's phone, insurer, policy, claim and deductible out of `.ad1` and then
dropping most of it — `ems_imports` kept only `customer_name`. Now stored and
shown: phone, second phone (`OWNR_PH2`), email, address, insurer phone
(`INS_CO_PH1`), adjuster phone and email (`CLM_CT_PH` / `CLM_CT_EM`). New columns
on `clients` (`phone2`) and `repair_orders` (`adjuster_phone`, `adjuster_email`).

**Email, honestly:** CCC 2.01 has no email field in `.ad1` — neither reference set
carries one under any name. The parser tries ten candidate names for the later
writers that do have one and keeps whatever it finds; a file without one shows
"not in this file" rather than a blank, and the parse warns when there is neither
phone nor email. Until a shop's writer supplies it, email is still asked for at the
counter. If you have an estimate set from your own CCC that shows an email address,
send it and I will name the field exactly.

**Still open:** reconciliation proper — a line-by-line diff of a re-import against
what is already on the file, with parts lines matched rather than skipped by
description. Today parts import once and a re-import skips what already exists.

## Queue run — 24 Aug 2026 · a0.2.1

Three fixes, one small feature. `SERVER-NOTES.md` has the receipt.

- Board Complete filter (below).
- `config.ts` ordered statuses by `sort_order` alone, so the Status Setup screen
  interleaved groups. Now `ORDER BY g.sort_order, s.sort_order`, as the board does.
- Parts: cost per line on receive, and a Costs drawer for invoices that turn up
  after the part.
- Parts pull sheet: a third mode.

**Swept for the same bug** across `server/src` and `server/web`. Everything else
comparing `sort_order` either scopes it to one table where it is genuinely
shop-wide (lanes, positions, features, plans, `staff_positions`) or already pairs
it with the group (`board.ts`, `reports.ts` status-load). Those two were the only
wrong ones. This class is closed.

Still not started: **EMS import reconciliation** — matching, diffing and accepting
with a preview screen. It needs decisions before it can be built, not code.
**Invoicing** remains set aside.

## Parts pull sheets — printing what is received — 24 Aug 2026, BUILT

The sheet printed two modes, To order and Ordered. It prints three.

- **Received** is its own document with its own columns: qty ordered, qty actually
  received with any shortfall flagged, the date received, the invoice number, and
  cost where the person may see it. It ends with **Checked in by / Date** signature
  lines, because that is the sheet somebody signs.
- **A partially received line appears on both On order and Received** on purpose —
  part of it is in the building and the rest is still owed.
- Scope, per-line ticks (remembered per mode) and one-page-per-vehicle are
  unchanged. "Ordered" is relabelled **On order**.

## Parts — cost when the invoice arrives — 24 Aug 2026, BUILT

Two ways in, both on the Parts tab rather than the file drawer.

- **On receive.** A cost-each field per line in the receive drawer, prefilled with
  whatever the line carried. Blank changes nothing. `bulk-receive` takes
  `costCents` per line, refuses it without the money capability, and writes an
  audit row when a cost actually moves.
- **After receipt.** A **Costs** button per file, and a **cost** button on every
  received or partial line, both opening one drawer with list and cost per line
  plus an invoice number. Only changed fields are written. The per-line button
  focuses that line, so a stack of invoices is type, tab, type.
- **Add part** is now always available on an open file — the action row previously
  only appeared when there was something to order or receive, so a file with
  nothing on it had no door to an endpoint that already existed.

## Board — Complete filter shows cars that are not complete — 24 Aug 2026, FIXED

`server/web/board.html`, `completeSlots()`. Reported off the live board: ticking
**Complete** returned Working Paint, Awaiting Paint, Body Complete, Final QC and
Awaiting Approval alongside Vehicle Ready.

**The cause.** `statuses.sort_order` restarts at 1 inside every group —
`provision.ts` resets its `sub` counter per group — so it orders slots *within*
their group and carries no meaning across the board. `completeSlots()` compared it
shop-wide: it found Vehicle Ready (4th in the Ready group, so `sort_order` 4) and
returned every status anywhere with `sort_order >= 4`. That is why the filter
looked selective rather than broken — it dropped the first three slots of each
group and kept the rest. Awaiting Approval is 10th in Scope/Teardown, Final QC 4th
in Wash and QC, so both passed.

**The fix.** Compare board position, not slot order. Board position is the pair
(group's position in `GROUPS`, slot's `sort_order` within it), flattened to
`groupIndex * 1000 + sortOrder`. Complete is every status at or past Vehicle
Ready's board position, which is Vehicle Ready plus the whole Delivered group —
matching the definition: every step except return is done.

**Fallbacks**, since a shop may rename Vehicle Ready: the last `complete` slot in
the `ready` group, then `kind = 'complete'` alone.

**Still to check** — the same shop-wide `sort_order` comparison may exist
elsewhere. Worth grepping for `sort_order` used as a board-wide ordinal in
reports, the cycle view and the payroll/close-out cutoffs before calling this
class of bug closed.

Web-only change. Hard refresh, no build.

## Audit log — 21 Aug 2026, BUILT (a0.2.0)

`Audit Log.dc.html`. One shop-wide screen, a new tab on the Admin strip after
Storage. Owner and managers only, behind a permission tick like anything else.

**Why it exists.** The notes on a file say what someone chose to write down. The
audit log says what actually happened to the record whether anyone noted it or
not — a deductible edited, a document pulled, a part quietly marked received.

**Decided:**

- **Append only.** Nothing in it can be edited or deleted, ever. Written in the
  same transaction as the change it records, so a failed write leaves no entry and
  an entry can never exist without its write.
- **Opens on today, newest first.** Search plus filters on person, area and span
  (today / 7 days / 30 days / this year / everything). The screen loads today
  first and reaches back as far as it is asked to; nothing is aged out.
- **Full record per row.** Collapsed: time, person, area, file, what changed, and
  whether a note came with it. Expanded: field-level was → now, the note text (or
  "nothing was written with this change"), entry id, event key, the person's role
  **at the time**, the record id, and the source — web, mobile, EMS import, system.
- **Sensitive rows are tinted red** with the inset red edge, the same treatment
  total loss gets on the board: money, deletes and voids, permission and setup
  changes. A Sensitive-only toggle filters to them.
- **Logged:** field edits, parts order/receive/return, money and estimates,
  documents, deletes and voids, permission and setup changes, messages sent.
- **A Note column on every row**, and a count in the header of how many of the
  entries shown came with no note — that is the manager's entry point.
- Export from the screen. "Everything this person did" jumps from any entry to
  that person filtered.

Still open: whether the same log should be reachable from inside a file as a tab,
or stay shop-wide only.

## Messages — 21 Aug 2026, BUILT (a0.2.0)

`Messages.dc.html`. The existing header panel stays as the way in from any screen,
with New / Old tabs and delete added; a full screen sits behind it for the rest.

- **View, delete, new only, old only.** Bulk select on the full screen, delete on
  the row in both. Deleting hides the row from that person's list; the record
  stays for the audit log.
- **One row per recipient, not one per event.** A parts arrival on 24188 with
  three subscribers is three rows, each with its own read and deleted state. Read,
  deleted and every send attempt hang off that row, so email and SMS become extra
  delivery attempts on a message that already exists rather than a parallel
  system. The detail pane shows that delivery record per channel.
- **No message carries its own action.** Open the file lifts the board drawer over
  the inbox; edits save to the record and the audit log and put you back on the
  message list where you were.

## Payroll — 21 Aug 2026, BUILT (a0.2.0)

The non-sales week, on its own Admin tab. `Payroll.dc.html` and
`Pay Sheet Print.dc.html` were the mockups; `SERVER-NOTES.md` has the build.

- **The week closes on a day and a time the shop sets** — Wednesday 4:00 pm by
  default, so cheques can be cut that evening. A file counts if it was *marked*
  closed before the cutoff (`closed_at`, not the adjustable books date).
  Anything later sits under Missed the cutoff and pays next week, once.
- **Per car reads the close-out** and nothing else. The basis is per car, not per
  person: a flat price where the file agreed one, hours at the tech's rate
  otherwise, both from `ro_labour`. Hours only count on the hourly cars.
- **Salary hides every per-car figure on the server** — the rows come back with
  the money nulled. The car list stays; what those cars would have paid does not
  exist on the sheet.
- **Sales is excluded.** Anyone on an active pay plan is paid there.
- **Marking a period paid snapshots it**, and a paid period reprints from the
  snapshot. Corrections land on the next period.
- Prints one sheet or all of them, signature lines and the missed-cutoff list
  included.

Still open: whether a tech who did two trades on one car should read as two lines
(it does now) or one, and whether the sheet should carry an employee number and a
year-to-date figure.

## Queue run — 20 Aug 2026 · a0.1.15

Built and packaged together, as one build: the close-out profit sheet, labour
rates on the person, deductible and rental on the file, the commission-payable
mark, reopen from the Closed screen, the filtered KPI strip, and the three
clocks (cycle in-to-ready, rental in-to-picked-up, A/R picked-up-to-paid).
`SERVER-NOTES.md` is the file-by-file receipt.

Not started: **EMS import reconciliation** — matching, diffing and accepting
with a preview screen. Nothing is recorded about it beyond that line.

**Invoicing is set aside** at your say-so, decisions intact below.

## Sales pay plans — 19 Aug 2026, BUILT

Commission is one number typed on a person today. It becomes a pay plan.

**Pick a salesperson, then pick how they are paid.** Two bases:

- **Net of costs.** Commission comes off the approval amount less whatever the
  shop takes out first. What comes out is a tick list, per person: parts cost,
  sublet cost, rental, sales tax liability, paint materials, towing, discount and
  deductible assistance. Then a percentage of what is left.
- **Flat off approval.** A percentage of the approval amount and nothing
  deducted.

**Drop fee.** Optional, per person, a dollar amount, **paid out when the vehicle
drops off** — not at approval, not at close. It is an advance against the
commission: when the commission is paid, the drop fee comes out of it so nobody
is paid twice. **Toggleable per person** — recover it from the commission, or let
them keep the drop fee and take the full commission on top.

**Commission is paid at one of three events:** Approval, Car gone, File closed.

**Total losses pay their own amount and no commission.** A totalled car never
earns a percentage of anything — the shop's total-loss amount is the whole of it.
A shop that pays $250 on a total loss pays that. The drop fee already paid comes
out of it — $250 total loss against a $150 drop still owes $100; a $500 drop
against a $250 total loss **deducts $250** from that person's pay report. A tick
box per plan, **pay the drop regardless**, keeps the drop fee out of the reckoning
and pays the total loss amount on top of it. A file that already paid a commission
on approval and then totals has that commission reversed on the next report, with
the total-loss amount in its place.

**The pay period is a company-wide setting**, not per person: the last day of the
period — Monday, Tuesday, whichever. Reports run off it.

The rhythm this has to survive: books close Tuesday evening, the report runs
Wednesday, money is paid Friday. A mistake made Tuesday and found Wednesday is
no harm as long as the report can be re-run.

**So what was paid has to be tracked, not just what is owed.** When a report is
run and a car is marked paid, that figure is recorded against the file and the
person. If the commission then changes — a corrected trigger, a re-cut approval,
a file that paid on approval and moved — the difference lands on the next report
as its own line, positive or negative, and moves that salesperson's total. No
silent restatement of a period already paid.

**Reports break down by salesperson.**

**Back-end triggers.** These pay points need real events stamped on the file,
and the commission report reads the stamps rather than guessing from status
history:

| Trigger | Fires when |
| --- | --- |
| Vehicle arrived | the car is dropped off — releases the drop fee |
| Approval | the file leaves Awaiting Approval for Parts |
| Car gone | the vehicle is delivered |
| File closed | the file is closed |

Each stamp is what puts that vehicle's money onto the commission report, and
dates the line. A file whose trigger has not fired is not on the report yet.
Checks fire on the event, immediately — the same stamps carry the SMS work later,
so they are worth building properly now rather than as a reporting side effect.

**To work out in build:** whether plans are named and reusable across people or
always per-person; whether a plan change applies to files already open or only to
files taken after it; whether a trigger can be corrected by hand and who may do
it; whether sales tax liability is a rate the shop sets once or a figure per
file; who may see and edit pay plans (owner and accounting, presumably); and how
a mid-file salesperson change splits the commission.

## Total loss — 19 Aug 2026, BUILT

A way to mark a vehicle a total loss, and have the board say so loudly.

- **Marked on the file.** A car the insurer totals is not a repair any more, but
  it is still sitting in the shop and still has to be handled.
- **It sorts to the top.** Total loss is its own lane above Body, numbered `00`,
  so every totalled car groups at the head of the board.
- **Red on the board**, and a tag at the end of the row.
- **Off the technicians' lists.** A tech no longer sees the car in their own
  work. The assignments stay on the file — nobody is unassigned, the car is just
  not theirs to work.

**Who** — owner and estimator.

**Sales pay.** A total loss pays the shop's total-loss amount instead of a
commission, netted against any drop fee already paid — see *Sales pay plans*.

**To work out in build:** whether it is a status
slot at `00` or a flag like void that overrides the lane; what happens to parts
already on order; whether the cycle clock pauses; whether a totalled file still
closes through the normal close flow and how it lands on the closed report.

## Shop-configurable permissions — decided 19 Aug 2026, BUILT

Today permissions are eight fixed roles and fifteen hard-coded capabilities in
`src/permissions.ts`, with one shop-settable knob (`techSeesOwnOnly`). A shop
gets to define its own roles instead.

**The model.** Fully custom: a shop defines every role, and we ship a starter
set. What a person may do stays the union of every role they hold — rank never
overrules the union.

- **Owner and Technician are locked** and cannot be deleted. Owner because the
  scheduler, Google Calendar and platform checks key off it; Technician because
  the lane rules hang off it — trades stay welded to that role.
- **Both can be relabelled.** A shop that says Boss, or PDR Tech, says it.
  Technician can also be *granted* extra capabilities — money, reports — even
  though the role itself is locked.
- **The other six ship as editable rows**: rename, retick, delete.
- **Adding a role asks** blank or copy an existing one.
- **A shop may have several owners.** Only the shop's original owner adds or
  removes owners.

**What a role ticks.** The fifteen capabilities we already have, renamed into
plain English. See / Change is split only where it matters — money, parts cost,
reports — one tick everywhere else.

- **Money is three ticks**, not one: RO totals; parts cost and margin;
  commission. Commission is all-or-nothing, own included — no tick, no sight of
  your own number.
- **Labour hours is its own tick**, separate from money — a tech sees the hours
  on a car without seeing what it bills.
- **Labour money is its own tick**: labour hours, paint and PDR figures
  together. Every technician gets it, whatever their trade — no need to split
  the ticks by trade, which the locked Technician role could not carry anyway.

**Money defaults, by role:**

| Role | Sees |
| --- | --- |
| Owner | Everything |
| Estimator | All money |
| Parts manager | Parts money |
| Technician (any trade) | Labour hours, paint and PDR figures |
- **"Only sees work assigned to them"** is one tick per role, replacing
  `techSeesOwnOnly`. It covers leads, repair orders and the schedule alike, and
  narrows any report the role can see to their own work. A role with nothing
  naturally assigned to it — Accounting — ignores the tick.
- **Rank is a number the owner sets per role.** It picks the primary (the title
  shown, and who notifications treat the person as) and orders roles in every
  dropdown and on the people screen. Ties are allowed and break by name.

**Presets: Collision, Hail, Combination.** Picked at setup. They differ by role
list — Hail has no body or paint techs, it has PDR techs and adjusters;
Combination is Collision plus the hail roles — and each preset sets the status
board too. A preset can be re-applied to a running shop, but it only adds what is
missing and never deletes what the shop has built.

**Editing.** Saves immediately; anyone signed in picks the change up on their
next page load. Every change writes an audit row — who, when, what.

**Denial.** Navigation hides what you cannot see; in-page actions stay visible
but disabled. At sign-in a person lands on the Board if they can see it,
otherwise their first permitted screen.

**Plans stay a separate layer.** The subscription decides what the shop has;
permissions decide who inside it gets it. Anything off-plan does not appear in
the matrix at all — Dents Or Us, invoicing-only, sees no board rows to tick.

**The screen.** A grid — roles down, capabilities across — that expands a role
in place when clicked.

**To work out in build:** deleting a role moves its holders to a role picked
during the delete, so the delete flow needs that picker — and statuses that name
the deleted role as their owner need the same treatment. Whether relabelling a
locked role changes it everywhere old audit rows recorded the key.

## Queue run — 18 Aug 2026

The three items below are built: one migration
(`010_close_and_sublet.sql`), the close endpoints, the closed board and report,
the sublet lane, the shop-wide sublet list under the board, and lead soft
delete. `SERVER-NOTES.md` is the file-by-file receipt. Run
`npm run build && npm run migrate && sudo systemctl restart easyshop`.

## Closing a file — 18 Aug 2026, BUILT

Today a file's money never lands anywhere. Closing puts the dollar amount on the
books, takes the car off the production schedule, and makes closed files their own
reportable board.

**Who** — owner, admin, front office.

**The process**, in order:

1. Click **Close file**.
2. It checks there is an approval amount. No amount, no close.
3. Mark it **paid** or **not paid**. (Taking payments proper comes later; this is
   the flag only.)
4. Set the **close date**, defaulting to today.

Then the file comes off the production schedule and appears on **Closed files**.

**The close date is editable after the fact.** Changing it moves the file into
whatever day, week and month you mark it — that is the point of it being manual.
A car finished in April and paid in May can be booked to either.

**Closed files board.** Sorts like the normal board. A paid / not paid / all
dropdown so unpaid files can be pulled up and chased. Unpaid state is visible on
the row, not hidden behind a filter. Adjustable by date range.

**Reporting.** Closed is its own generatable report, keyed on close date rather
than any production date.

To work out in build: whether an unpaid closed file still counts as revenue on the
closed report or sits in a separate column; whether closing is reversible and who
may reopen; what happens to a file closed with parts still on order.

## Sublet as a production lane — 18 Aug 2026, BUILT

Sublet becomes a lane on the production schedule with its own statuses, so a car
out at sublet is visible on the board rather than parked in whatever status it
held when it left.

Statuses, in order:

- Awaiting Sublet
- At Sublet
- Working Sublet
- Sublet Complete

This is alongside the sublet line editing already built on the file (see *Sublet
and vendors* below) — that tracks the money and the vendor; this tracks where the
car is.

To work out in build: where the lane sits in the lane order, whether the four
statuses are shop-configurable like the rest, and whether moving a file to At
Sublet stamps the sublet line's out date automatically.

## Delete a lead — 18 Aug 2026, BUILT

No way to remove a lead today. Needed at minimum for duplicates from a failed
save. Who may delete, whether it is a soft delete like void, and whether a
converted lead can be deleted at all are open.

## Lead follow-up — 14 Aug 2026, BUILT

Configurable days of silence before a lead is flagged, checked against the
calendar; book an appointment from the lead; mark it chased to reset the clock.
Also fixed the AGE column, which called a lead taken yesterday "today".
`SERVER-NOTES.md` has the detail.

Still open: whether a flagged lead should also raise an inbox notification for
its owner, or stay a mark on the screen.

## Invoicing under Easy Shop — decided 14 Aug 2026, not yet built

The existing PHP tool (`uploads/`, hosted separately) is a finished product:
per-company profiles with four numbering schemes, revisions with snapshots,
payments, statements, aging, the QuickBooks export with its netting and file
splitting, the byte-pinned E-Car sheet, and a PWA. The port carries all of it.

Decided:

- **Port into Easy Shop.** One sign-in, one client directory. The PHP app keeps
  running until the new one is proven — nothing is switched off, and its live
  database stays where it is.
- **Navigation.** Board → an Invoicing button → invoicing with its own top nav
  (its existing sections) and a way back to the CRM. An invoicing-only
  subscriber lands straight in it.
- **Subscriptions.** Someone may pay ~$10/month for invoicing alone and must see
  only that. Platform admin — controlling what each shop can see and use — is
  the next piece after this, not part of it.
- **Retail lines** are the eight categories: body, PDR, paint, paint materials,
  parts, sublet, discount / deductible assistance, total. Prefilled from the file
  where it has a figure, editable on the invoice.
- **The retail split comes from the EMS import**, which already codes every line
  by type — body, paint, paint materials, mechanical, sublet, parts. Total by
  code. No descriptions read, no AI, no tokens.
- **Parts at list price** on retail and insurance, not what the shop paid. Both
  are already on every parts line.
- **Cash-pay retail** is manual, and may carry lines with no figures and one
  total. `invoice_items.cost_cents` is already nullable and prints a blank cell.
- **Wholesale** is free-form: description plus amount, against a client.
  Descriptions are remembered, prices never — the same door costs more when it
  fights you.
- **No line suggestions** from the estimate. Typing from a saved list is faster.
- **E-Car** carries across exactly as it draws today. Their reader matches on the
  layout.
- **All of the collections side** comes over: payments, statements, aging.
- **QuickBooks export** carries, and includes retail this time.
- **Who can invoice:** front office, estimator, owner.
- **Numbering** carries as built: sequence, manual, vin6, vin8, prefix tokens,
  yearly reset, locked profiles.

Live data, from the real dump (`uploads/u284225393_invoicing.sql` — the first one
sent was a stale copy):

| | |
| --- | --- |
| invoices | 551 — 544 Extreme Hail & Collision, 7 Dents Or Us |
| line items | 2,260, of which **312 carry no figure** |
| payments | 391 |
| revisions | 33 |
| clients | 17, with 25 aliases |
| profiles | 5 across two companies |
| users | 5 |
| status | 169 open, 382 paid, none void |

Three things that follow:

- **A real importer**, not hand-entry. Numbers are the identity
  (`company_id + profile_id + number` is unique), so the importer keys on those
  and never renumbers. Revision snapshots are historical JSON and travel
  verbatim, old ids and all.
- **Two live tenants already.** Dents Or Us is the invoicing-only subscriber in
  the flesh, so the tiering is not hypothetical — it has to work on day one.
- **A line with no figure is normal**, not an edge case: 14% of every line ever
  written. The renderer treats a blank cost as a first-class case, which is what
  the $1,300-no-breakdown invoice needs.

## Sublet and vendors — 14 Aug 2026

- **Sublet is editable on the file.** The drawer was a read-only list; it now
  adds a line (service, vendor, cost), moves it Scheduled → Out → Returned →
  Invoiced from a dropdown, and removes one. Moving it out or back stamps that
  date if nobody typed one. Every state change writes a note, and the file's
  sublet figure recomputes from its lines. Parts, estimators and managers only.
- **Vendors admin screen.** New tab: add, rename, retype, retire. Retiring keeps
  every order that already names the vendor and only stops offering the name.
  Shows how many part lines each has ever carried and how many are out now.
  Sublet vendors are typed rather than picked, so names typed on files but absent
  from the list are offered as one-tap additions, and the list fills the
  suggestions when someone types one.

## Photos, PDFs and the viewer — 13 Aug 2026, BUILT

Server-side conversion (libvips + mupdf), a Redis queue, our own PDF viewer, one
sequence with photos before paperwork. `SERVER-NOTES.md` has the file list and
the caveats; `server/INSTALL-MEDIA.md` is the install on the box.

Paperwork is office, owner and production manager only — a new `viewPaperwork`
capability. Techs never see a PDF, typed or not, and cannot upload one.

`server/DEPLOY.md` is the full box deployment, start to finish.

## Built

### Roles, trades, parts ordering, colour — 13 Aug 2026

Prototype in `RO Board.dc.html`, and then built for real in `server/` — two
migrations, the permission core, the people and parts endpoints, and the admin,
board and parts screens. `SERVER-NOTES.md` is the file-by-file receipt.
`npm run build && npm run migrate`.

- **Several roles per person.** The role control is now a list of roles held, and
  what you may see and do is the union of all of them. The highest-ranked role is
  the primary — what you are called and who gets notified. A tech who also holds a
  management role sees the whole board: the manager role wins over the shop's
  "techs see only their cars" setting, which now only shows for tech-only users.
- **Trades are a set.** New People & trades panel on the board: tick every trade a
  person works. They are then offered in each of those assignment dropdowns — with
  "(also Paint)" beside the name so you know who you are pulling from another lane
  — the technician picker shows their lanes, and one person can hold body and paint
  on the same car.
- **"Needs tech".** PDR alone is a complete file — a hail car pulled
  by one tech needs nobody else. Once body or paint is on the car it wants both:
  body and PDR still needs a painter, PDR and paint still needs a body tech. The
  flag also now shows in the prototype's board rows.
- **Parts ordering.** The order modal takes an order or invoice number alongside the
  vendor, price and ETA, applied to every line you tick — one order, one supplier.
  Receiving stamps the received date and takes a short count; a short line stays on
  order for what is still owed. The parts list gained Order # and PP columns, ETA
  turns red with the days late, and short lines carry a flag.
- **Parts profit.** Margin on list — (list − cost) ÷ list — as a total per RO on the
  parts screen and per line in the RO's parts detail. Lines under 20% read red and
  the RO says how many. Money roles and parts staff only.
- **Parts cost comes from the parts lines.** What you paid overwrites the estimate's
  parts figure on the RO money block; typing over it by hand still wins.
- **The RO from a parts line.** The RO number opens the repair order over the parts
  screen with your normal edit rights, so the parts desk can read the file without
  leaving the list.
- **Last 8 of the VIN** on the expanded parts line and in the order modal, with a
  copy button that copies all 17.
- **Car colour** after the model on the Cycle card, and on the app's Cycle row and
  mobile card so it prints with the list. The Table view already carried it.

On the server side: roles live in `membership_roles`, trades in `staff_positions`,
both seeded from the columns they replace, and every read falls back to the old
column so the app runs either side of the migration. Receiving a short line sets
`qty_received` and leaves the line `partial` — still owed — rather than adding a
column. The ordered price recomputes `repair_orders.parts_cost_cents` on every
parts write.

Still open: whether the 20% parts-margin threshold is a shop setting rather than
the constant it is now, in `src/routes/parts.ts`. Whether someone is offered "Needs tech" files in a lane
they hold but rarely work.

### Printing, technician filter, complete, needs-a-tech — 12 Aug 2026

No migration. Board only, Table and Cycle.

- **Print list** button prints exactly what is filtered on screen — same rows,
  chrome stripped, landscape letter, with the shop name, what the list is
  filtered by in words, the count and the time printed across the top. A ruled
  write-in column is added on paper only. Cycle keeps the progression bars and
  its lane grouping; Table prints whatever columns are on screen.
- **Technician picker** beside the stage filter, grouped by position. Picked, the
  board shows only files assigned to that person, their own lanes first — a
  painter gets prep, paint and buff from the same lane map the server enforces
  with. Their cars that have moved past their lanes group under "Elsewhere in
  the shop" instead of disappearing. A technician signing in lands on their own
  work.
- **Needs a tech.** Any file with no body tech and no paint tech carries a gold
  "Needs tech" flag on the board and in print, and "Needs a tech" is its own
  option in the picker so the whole unassigned list can be pulled up at once.
- **Complete** checkbox beside Closed: shows only files at Vehicle Ready or past
  it (falls back to complete-kind statuses if no status is named that).
- **Status dropdown** now reads on the shop's own colours — lane headings in
  gold, options on the dark ground, instead of white on grey.

### Everything queued through 12 Aug — 12 Aug 2026

Ten items, one migration (`006_scheduling_and_ems.sql`). Run
`npm run build && npm run migrate`.

**Scheduler**

- *Cancelling did nothing.* `Shell.api` declared a JSON content type on every
  request including bodiless DELETEs, which Fastify refuses with an empty-body
  error carrying no `error` field — so the promise rejected with nothing to
  read and both cancel paths had no `.catch`. Requests now only declare a body
  when they have one, non-JSON failures surface their real text, and both cancel
  buttons show what went wrong instead of sitting there.
- *Employee time off.* Own layer on the schedule, owner only: date ranges, or
  hours within a day, hatched into each day column. Conflicts in both directions
  (blocking over booked work, booking onto someone off or double-booking them)
  raise a list of what collides with an override; overrides are recorded on the
  appointment and in the audit log. Bookings can now name who they are for.
- *Google Calendar, push only.* Owner connects once through Google sign-in on
  the settings screen — no password typed or shared — then picks which calendar
  receives appointments. Bookings, moves and cancellations are pushed; nothing
  is read back. Needs `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` in the
  server's `.env`; until they are set the card says so rather than offering a
  dead button.

**The board and the drawer**

- *Mobile is option 1b.* Below 760px the top bar is one 44px row, the nav is a
  five-tab bottom bar (Board, Schedule, Parts, Clients, More — everything else
  and sign-out live under More), filters are one scrolling row of chips, and the
  KPI band is replaced by a sticky count line above the cards. + New RO stayed in
  the chip row rather than moving into More: it is used too often to hide.
- *Per-block Save buttons are gone.* Save dates, Save money, Save assignments and
  the three fact-block Saves all removed; every edit commits through the existing
  close-guard when the drawer closes. The helper lines each block explained
  itself with stayed.
- *Sections fold.* Every block heading in the drawer collapses. Open by default,
  shut stays shut per section across files and sessions, and folding never stops
  an edit — the fields are still there and still saved on close.
- *Void moved.* Last thing in the drawer, right-aligned, under a rule.
- *Salesperson dropdown.* Each position now lists only staff who hold it, plus
  whoever is already on the file so an old assignment is never dropped on save.
- *Cycle view overlap.* Rows size to their content with the vehicle line clamped
  to two lines; lane headers stick while the lane scrolls under them.

**Elsewhere**

- *EMS carries the insurance.* `ems_imports` now keeps carrier, policy number,
  deductible, date of loss, adjuster and estimator — plus colour, plate and
  mileage — and accepting an import resolves the carrier to an insurance client
  (creating it if new) and fills anything blank on the file. Values already set
  by the desk are left alone.
- *Settings reference links.* Tech visibility / Day limits / Google Calendar now
  filter the settings page the way the rail filters statuses and lanes.

Still open: whether a file with uncleared parts returns can be reopened.

### Editable customer, vehicle and insurance — 11 Aug 2026

The three fact blocks on the drawer are now inputs for anyone with
`editRepairOrders`, one save per block, all landing on `PATCH /api/ro/:id/details`.
Blank clears a value; every change writes a note and an audit row naming what
changed. The customer block edits the client record itself, not a copy. Typing a
carrier that does not exist yet creates it as an insurance client, so a file
imported without one can be fixed in place. Voided files stay read-only.


### Void a repair order — 11 Aug 2026

Owner only in the current role set (`VOID_RO` in `permissions.ts` — widen that list
rather than the endpoint if production managers should void too). Void is its own
flag on the file, not a status and not a hold. Parts still on paper are cancelled,
ordered parts are flagged for return onto a returns list on the parts screen, the
number is released, and the file leaves the board and every report except the new
Voided report. Reopen is the same record renumbered: whoever reopens picks the slot
and whether the parts come back, the days it sat voided come off days in shop, and
the client still sees one entry.

Still open from the spec: whether a file with uncleared returns should be blocked
from reopening. Today it is allowed.

<details>
<summary>The spec as decided</summary>

#### Void a repair order

No way to kill a file today — an RO opened by mistake, a duplicate, or a customer
who never showed stays on the board forever. Decided 11 Aug 2026:

**Voiding**

- Owner and admin only. Reason required, from a pick list — Duplicate, Opened by
  mistake, Customer never showed — with free text always available.
- Void is its own flag on the file, separate from status and from hold. Not a
  status slot, not a suspend: the file keeps the slot it was in, the flag takes it
  off the board.
- Every parts line is cancelled. Anything already ordered is flagged for return:
  the parts desk gets an inbox notification and a returns list on the parts screen
  that stays until each line is cleared.
- The RO number is released and can be reused immediately.
- No other notification — the void is in the status history and the audit log with
  who, when and why. (The parts return notice above is the one exception.)
- Off the production and revenue reports. Counted in its own admin report: what
  gets voided, why, and by whom.

**Reopening**

- Owner and admin. Same record, renumbered — void and reopen are states the file
  passes through, not a new file.
- Takes the next number in the normal sequence, since the old one may already be
  in use. Searching the old number finds whichever file holds it now; the voided
  file is reachable by its new number and through the client's history.
- Whoever reopens picks the status it lands in, and is asked whether the cancelled
  parts lines come back.
- Everything travels with it: documents and photos, notes, status history, the
  original date in, approval amount, insurance and claim details.
- The cycle clock pauses at void and resumes at reopen — a file voided for three
  weeks does not come back three weeks old. Original date in stays as written.
- The client's history shows one entry, the live file, with the void folded into
  its history.
- Still counted in the void report, separately, as reopened.

**Left to work out in build**

- Where the flag lives on `repair_orders` — a `voided_at` / `voided_by` /
  `void_reason` trio beside `hold_since`, and how the board query excludes it.
- The clock pause needs the same treatment as hold in the cycle-time report, which
  currently measures against `opened_at`.
- Whether a voided file with an uncleared return can be reopened before the parts
  desk has closed the returns out.

</details>

## Adding statuses — done a0.8.1, 2 Oct 2026

Decided 2 Oct 2026: admin permission adds on the shop side; platform adds to one
shop (support), not the template. Hide only, never delete, built-ins included.
Pick a group (and lane, in a lane group), lands at the end, drag to reorder any
status. Each gets its own text, off until switched on. A parent may also add it
to its locations at the same time.
