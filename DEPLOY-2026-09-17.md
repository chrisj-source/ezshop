# Deploy — 17 September 2026

Everything changed today, in the order to do it. Five TypeScript files (one new)
and four web pages.

## 1. Put the files in place

Paths are relative to the repo root — which IS the server tree, per
`github.md`. The live install is `/srv/easyshop`.

**TypeScript — needs a build:**

| File | What changed |
| --- | --- |
| `src/lib/shophours.ts` | `atShopWallClock()` added and exported |
| `src/lib/shoptime.ts` | `wallClock()` moved here from two route files |
| `src/routes/scheduler.ts` | `scheduleGuards()`; the move path checks hours, limits and conflicts; `Kind` exported |
| `src/routes/leads.ts` | booking from a lead goes through the same guards; local `wallClock()` removed |
| `src/scripts/ro-numbers.ts` | **new** — the RO number repair |
| `package.json` | `npm run ro-numbers` |

**Web — served straight off disk, no build:**

| File | What changed |
| --- | --- |
| `web/schedule.html` | the booking sheet keeps what you typed; `guardBox()`; moving an appointment offers the override |
| `web/leads.html` | the lead booking drawer offers the override |
| `web/board.html` | "Open parts for this RO" opens that RO; the drawer no longer blinks on upload; booking reads the refusal flags |
| `web/parts.html` | `?open=` says so when the file has no parts lines |

## 2. Build and restart

```
cd /srv/easyshop
npm run build && sudo systemctl restart easyshop
```

Then a **hard refresh** in the browser for the four web pages (Ctrl-Shift-R).
Nothing under `web/` needs a restart, but the pages are cached.

## 3. Repair the RO numbers

Read the dry run before you let it write anything.

```
npm run ro-numbers                     # report only — changes nothing
npm run ro-numbers -- --shop 4         # report one shop
npm run ro-numbers -- --go --shop 4    # do one shop first
npm run ro-numbers -- --go             # the rest
```

The bare `--` matters: without it npm keeps the flag and the script stays in
report mode.

**What to look for in the dry run.** Each line reads
`OLDNUMBER → NEWNUMBER   vehicle · customer`, and says what shape the old number
was — *was a longer VIN tail*, *was a plain sequence*. A shop that turns out to
be on a counter rather than a VIN is a conversation, not a repair, so stop and
look if you see a lot of those.

Two things it reports and refuses to touch:

- **COLLISION** — the last six of that VIN already answers to another file. Two
  open files on one VIN tail is a comeback or a duplicate; it needs a person.
- **NO VIN** — nothing to derive from. A made-up number is worse than a wrong
  one.

It only touches **open** files (`close_date IS NULL AND closed_at IS NULL AND
voided_at IS NULL`). Closed files keep their number because it is on paperwork,
an invoice and a payroll snapshot; voided files park on `VOID-<id>` so their real
number is already back in the pool.

Every change writes an audit row and an auto note on the file, so the shop can
see what moved and when. It is idempotent — run it again and everything reports
as already right.

## 4. Check the four fixes

- **10am on a Monday books.** The scheduler was refusing every morning hour up
  to the shop's UTC offset — five hours for Plano. Book one.
- **Change the appointment type mid-form.** The name, phone, vehicle, time and
  note stay where they are. Same for the month arrows and picking a day.
- **Drag an appointment to 9pm.** It now refuses with the override offered,
  instead of saving silently. Same for a full day and somebody's time off.
- **Upload three photos to a file.** The drawer should redraw once, not seven
  times, and your scroll position should survive it.
- **"Open parts for this RO"** should open that RO's parts, not the whole list.
  Closing the modal leaves you on the list, which is intended.

## Nothing here needs a migration

No schema change today. `npm run migrate` is not required, and neither is
`npm run schema-audit`.

## What is still open

Recorded at the end of each entry in `SERVER-NOTES.md`:

- A move cannot reassign the appointment — moving the car and handing it to
  somebody else is two requests.
- Nothing enforces the VIN convention on the way *in*. `POST /api/ro` still
  takes whatever number is typed. Prefilling it from the VIN on the create form
  is the likely fix; today's script only repairs the past.
- Every money and date save in the drawer still rebuilds it once (`reopen()`).
  One blink rather than seven, but the same class of thing.
