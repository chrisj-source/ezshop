import { RowDataPacket } from 'mysql2/promise';
import { mexec, mqOne } from '../db/master';
import { tq, texec, forgetTenant } from '../db/tenant';
import { provisionCompany } from '../db/provision';
import { hashPassword, randomPassword } from '../auth/password';
import { config } from '../config';

/**
 * The demo shop.
 *
 * Bob's Body Barn in Testingville, Texas — collision and hail, two PDR techs,
 * four body, two paint, one detail who also preps and buffs. Mostly insurance,
 * a few dealer cars, a few cash-pay. It is a **real shop on the live box**: a
 * visitor can check a car in, upload a photo, order a part, close a file. That
 * is the point — a demo you cannot touch proves nothing.
 *
 * Which is also why it is wiped back to the seed every night at 2am Central,
 * and from a button on the platform screen. Anything a visitor did goes with
 * the reset.
 *
 * Two safeguards worth naming:
 *
 *  - Every destructive step here is gated on `companies.is_demo`. A company
 *    without that flag cannot be reset by this code at all, whatever id is
 *    passed in — so this can never be pointed at a real shop.
 *  - The seed is deterministic in shape but dated relative to now, so the board
 *    always looks like a shop mid-week rather than a museum.
 */

export const DEMO_SLUG = 'demo';
const TESTER_EMAIL = 'tester@bobsbodybarn.demo';

export interface DemoRow extends RowDataPacket {
  id: number; slug: string; name: string; is_demo: number; demo_reset_at: Date | null;
}

export async function demoCompany(): Promise<DemoRow | null> {
  return mqOne<DemoRow>(
    'SELECT id, slug, name, is_demo, demo_reset_at FROM companies WHERE is_demo = 1 LIMIT 1');
}

/** The demo shop, provisioned if this box has never had one. */
export async function ensureDemo(actorUserId: number | null): Promise<DemoRow> {
  const existing = await demoCompany();
  if (existing) return existing;

  const clash = await mqOne<RowDataPacket>('SELECT id FROM companies WHERE slug = ?', [DEMO_SLUG]);
  if (clash) {
    await mexec('UPDATE companies SET is_demo = 1 WHERE id = ?', [clash.id]);
    return (await demoCompany())!;
  }

  await provisionCompany({
    slug: DEMO_SLUG,
    name: "Bob's Body Barn",
    city: 'Testingville',
    state: 'TX',
    timezone: 'America/Chicago',
    shopType: 'both',
    planCode: 'trial',
    seats: 20,
    ownerName: 'Bob Barnes',
    ownerEmail: 'bob@bobsbodybarn.demo',
    ownerPassword: randomPassword(),
    actorUserId: actorUserId ?? undefined
  });

  const made = await mqOne<RowDataPacket>('SELECT id FROM companies WHERE slug = ?', [DEMO_SLUG]);
  await mexec("UPDATE companies SET is_demo = 1, status = 'active' WHERE id = ?", [made!.id]);
  return (await demoCompany())!;
}

/* ------------------------------------------------------------------ people */

/** The floor, in the shape the shop was described: 2 PDR, 4 body, 2 paint, 1 detail. */
const CREW: Array<{ name: string; role: string; trade: string | null; rateCents: number }> = [
  { name: 'Bob Barnes',      role: 'owner',              trade: null,     rateCents: 0 },
  { name: 'Denise Okafor',   role: 'front_office',       trade: null,     rateCents: 0 },
  { name: 'Ray Whitlock',    role: 'estimator',          trade: null,     rateCents: 0 },
  { name: 'Marisol Vance',   role: 'parts_manager',      trade: null,     rateCents: 0 },
  { name: 'Trey Alvarado',   role: 'production_manager', trade: null,     rateCents: 0 },
  { name: 'Kyle Doheny',     role: 'salesperson',        trade: null,     rateCents: 0 },
  { name: 'Manny Ruiz',      role: 'technician',         trade: 'pdr',    rateCents: 0 },
  { name: 'Dale Pruitt',     role: 'technician',         trade: 'pdr',    rateCents: 0 },
  { name: 'George Godina',   role: 'technician',         trade: 'body',   rateCents: 3200 },
  { name: 'Chuy Alverez',    role: 'technician',         trade: 'body',   rateCents: 3200 },
  { name: 'Cesario Mendez',  role: 'technician',         trade: 'body',   rateCents: 3000 },
  { name: 'Wade Kessler',    role: 'technician',         trade: 'body',   rateCents: 3000 },
  { name: 'Kell Fisher',     role: 'technician',         trade: 'paint',  rateCents: 3450 },
  { name: 'Otis Barrow',     role: 'technician',         trade: 'paint',  rateCents: 3300 },
  { name: 'Ana Bermudez',    role: 'technician',         trade: 'detail', rateCents: 2200 }
];

/** Cash-pay customers, dealers and carriers. The dealers are invented. */
const CLIENTS = [
  { kind: 'insurance', name: 'State Farm',              drp: 1 },
  { kind: 'insurance', name: 'Progressive',             drp: 0 },
  { kind: 'insurance', name: 'Allstate',                drp: 0 },
  { kind: 'wholesale', name: 'Lone Star Ford',          type: 'dealer', terms: 'Net 30' },
  { kind: 'wholesale', name: 'Caprock Chevrolet',       type: 'dealer', terms: 'Net 30' },
  { kind: 'wholesale', name: 'Bluebonnet Hail Co',      type: 'hail',   terms: 'Per event' },
  { kind: 'retail',    name: 'Marilyn Teague' },
  { kind: 'retail',    name: 'Hector Salas' },
  { kind: 'retail',    name: 'Priya Raman' },
  { kind: 'retail',    name: 'Wes Cotton' },
  { kind: 'retail',    name: 'Janelle Brooks' },
  { kind: 'retail',    name: 'Sam Ortiz' }
];

const VEHICLES = [
  [2023, 'Ford', 'F-150', 'Oxford White', 'JHT4471'],
  [2021, 'Chevrolet', 'Silverado 1500', 'Summit White', 'BKR9903'],
  [2022, 'Toyota', 'RAV4', 'Blueprint', 'LPN2210'],
  [2019, 'Honda', 'Accord', 'Modern Steel', 'CWR8812'],
  [2020, 'Jeep', 'Grand Cherokee', 'Velvet Red', 'TTX5540'],
  [2024, 'Kia', 'Telluride', 'Ebony Black', 'RRM1180'],
  [2018, 'Nissan', 'Altima', 'Gun Metallic', 'DKF3327'],
  [2022, 'Ram', '1500', 'Billet Silver', 'VNE7741'],
  [2021, 'Subaru', 'Outback', 'Autumn Green', 'PQS2094'],
  [2023, 'Hyundai', 'Tucson', 'Amazon Gray', 'HGB6613'],
  [2017, 'GMC', 'Sierra 1500', 'Onyx Black', 'MLC4408'],
  [2022, 'Mazda', 'CX-5', 'Soul Red', 'ZTR7729']
];

function vin(i: number): string {
  /* Not a real VIN — 17 characters, no I, O or Q, and stable per car. */
  const body = '1FTFW1E5' + String(100000 + i * 7919).slice(0, 6);
  return (body + 'XKKF83421').slice(0, 17).toUpperCase();
}

function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

function dayOnly(n: number): string {
  return daysAgo(n).slice(0, 10);
}

/* ------------------------------------------------------------------- reset */

export interface DemoResetResult {
  companyId: number;
  files: number;
  leads: number;
  people: number;
  testerPassword: string | null;
  note: string;
}

/**
 * Wipe the demo shop's work and put the seed back. The company, its statuses
 * and its settings survive — this is the work, not the shop.
 */
export async function resetDemo(actorUserId: number | null): Promise<DemoResetResult> {
  const demo = await ensureDemo(actorUserId);
  const cid = Number(demo.id);

  const guard = await mqOne<RowDataPacket>(
    'SELECT is_demo FROM companies WHERE id = ?', [cid]);
  if (!guard || guard.is_demo !== 1) {
    throw new Error('That company is not the demo shop. Refusing.');
  }

  await wipe(cid);
  const seeded = await seed(cid);

  await mexec('UPDATE companies SET demo_reset_at = NOW() WHERE id = ?', [cid]);

  return {
    companyId: cid,
    ...seeded,
    note: `Bob's Body Barn is back to the seed — ${seeded.files} files, ${seeded.leads} leads.`
  };
}

/**
 * Everything a visitor can touch. The order is children first; foreign keys are
 * switched off for the duration anyway, because the point is a clean floor
 * rather than a careful one.
 */
const WIPE_TABLES = [
  'ro_payments', 'ro_labour', 'ro_profit', 'ro_assignments', 'parts_lines',
  'sublet_lines', 'ro_notes', 'supplements', 'documents', 'ems_lines', 'ems_imports',
  'lead_events', 'leads', 'appointments', 'commission_lines', 'payroll_run_cars',
  'payroll_run_people', 'payroll_runs', 'notifications', 'notification_deliveries',
  'repair_orders', 'vehicles', 'clients', 'audit_log'
];

async function wipe(cid: number): Promise<void> {
  await texec(cid, 'SET FOREIGN_KEY_CHECKS = 0');
  for (const table of WIPE_TABLES) {
    /* A table this box does not have yet is not an error — the seed is written
       against the schema as it grows, not as it was. */
    await texec(cid, `DELETE FROM ${table}`).catch(() => undefined);
  }
  await texec(cid, 'SET FOREIGN_KEY_CHECKS = 1');
}

/* -------------------------------------------------------------------- seed */

async function seed(cid: number): Promise<{
  files: number; leads: number; people: number; testerPassword: string | null;
}> {
  const people = await seedPeople(cid);
  const clients = await seedClients(cid);
  const statuses = await tq<RowDataPacket[]>(cid, `
    SELECT s.slot_id, s.label, s.kind, g.sort_order AS g, s.sort_order AS s
      FROM statuses s JOIN status_groups g ON g.group_id = s.group_id
     WHERE s.visible = 1 AND s.is_terminal = 0
     ORDER BY g.sort_order, s.sort_order`);

  const files = await seedFiles(cid, people, clients, statuses);
  const leads = await seedLeads(cid, people);
  const testerPassword = await ensureTester(cid);

  return { files, leads, people: people.length, testerPassword };
}

interface Person { userId: number; name: string; role: string; trade: string | null; rateCents: number }

/**
 * The crew. People live in the master database and work in the tenant, so each
 * one is a user, a membership and a staff row. They are reused across resets —
 * wiping the floor should not orphan the board's own names.
 */
async function seedPeople(cid: number): Promise<Person[]> {
  const out: Person[] = [];

  for (const c of CREW) {
    const email = c.name.toLowerCase().replace(/[^a-z]+/g, '.') + '@bobsbodybarn.demo';
    let user = await mqOne<RowDataPacket>('SELECT id FROM users WHERE email = ?', [email]);
    if (!user) {
      const res = await mexec(
        `INSERT INTO users (email, password_hash, name, status) VALUES (?, ?, ?, 'active')`,
        [email, await hashPassword(randomPassword()), c.name]);
      user = { id: res.insertId } as RowDataPacket;
    }
    const userId = Number(user.id);

    await mexec(
      `INSERT INTO memberships (user_id, company_id, role, position_key, status)
       VALUES (?, ?, ?, ?, 'active')
       ON DUPLICATE KEY UPDATE role = VALUES(role), position_key = VALUES(position_key),
         status = 'active'`,
      [userId, cid, c.role, c.trade]);

    /* The multi-role table as well. Seeding only `memberships.role` is what
       left the demo shop with an empty `membership_roles`, and therefore a
       pay-plan screen with nobody on it and a commission report with nothing in
       it. The nightly reset runs this, so the demo has to be right here rather
       than relying on the backfill migration. */
    await mexec(
      `INSERT IGNORE INTO membership_roles (user_id, company_id, role_key)
       VALUES (?, ?, ?)`, [userId, cid, c.role]).catch(() => undefined);

    await texec(cid, `
      INSERT INTO staff (user_id, display_name, position_key, pay_basis, rate_cents, active)
      VALUES (?, ?, ?, 'hourly', ?, 1)
      ON DUPLICATE KEY UPDATE display_name = VALUES(display_name),
        position_key = VALUES(position_key), rate_cents = VALUES(rate_cents), active = 1`,
      [userId, c.name, c.trade, c.rateCents]);

    /* Trades a tech works, where the table exists. */
    if (c.trade) {
      await texec(cid,
        `INSERT IGNORE INTO staff_positions (user_id, position_key) VALUES (?, ?)`,
        [userId, c.trade]).catch(() => undefined);
    }

    /* A percentage plan on the two body techs, so the demo shows both ways of
       paying somebody rather than one. */
    if (c.trade === 'body' && (c.name === 'George Godina' || c.name === 'Chuy Alverez')) {
      for (const jt of ['wholesale', 'cash']) {
        await texec(cid, `
          INSERT INTO staff_pay_plans (user_id, job_type, basis, pct_paint, pct_nopaint, rate_cents)
          VALUES (?, ?, 'pct', 12.5, 25, 0)
          ON DUPLICATE KEY UPDATE basis = 'pct', pct_paint = 12.5, pct_nopaint = 25`,
          [userId, jt]).catch(() => undefined);
      }
      await texec(cid, `
        INSERT INTO staff_pay_plans (user_id, job_type, basis, rate_cents)
        VALUES (?, 'insurance', 'hours', ?)
        ON DUPLICATE KEY UPDATE basis = 'hours', rate_cents = VALUES(rate_cents)`,
        [userId, c.rateCents]).catch(() => undefined);
    }

    out.push({ userId, name: c.name, role: c.role, trade: c.trade, rateCents: c.rateCents });
  }

  return out;
}

interface Client { id: number; kind: string; name: string }

async function seedClients(cid: number): Promise<Client[]> {
  const out: Client[] = [];
  for (const c of CLIENTS as Array<Record<string, unknown>>) {
    const res = await texec(cid, `
      INSERT INTO clients (kind, wholesale_type, name, phone, city, state, terms, is_drp, active)
      VALUES (?, ?, ?, ?, 'Testingville', 'TX', ?, ?, 1)`,
      [c.kind, c.type ?? null, c.name,
       '(940) 555-0' + String(100 + out.length).slice(-3),
       c.terms ?? null, c.drp ?? 0]);
    out.push({ id: res.insertId, kind: String(c.kind), name: String(c.name) });
  }
  return out;
}

/**
 * The board. Cars spread across whatever statuses this shop actually has, so
 * the seed does not carry a hard-coded slot id that a renamed board would break
 * — every file lands on a real status, whatever the shop calls it.
 */
async function seedFiles(
  cid: number, people: Person[], clients: Client[], statuses: RowDataPacket[]
): Promise<number> {
  const techs = (trade: string) => people.filter(p => p.trade === trade);
  const carriers = clients.filter(c => c.kind === 'insurance');
  const dealers = clients.filter(c => c.kind === 'wholesale');
  const retail = clients.filter(c => c.kind === 'retail');

  let made = 0;

  for (let i = 0; i < VEHICLES.length; i++) {
    const [year, make, model, color, plate] = VEHICLES[i] as [number, string, string, string, string];

    /* Nine live cars, three closed ones with money on them. */
    const closed = i >= 9;
    const wholesale = i === 3 || i === 7 || i === 11;
    const cash = i === 5 || i === 10;
    const client = wholesale ? dealers[i % dealers.length]
      : cash ? retail[i % retail.length]
      : retail[i % retail.length];
    const carrier = wholesale || cash ? null : carriers[i % carriers.length];

    const veh = await texec(cid, `
      INSERT INTO vehicles (client_id, vin, year, make, model, color, plate, plate_state, mileage)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'TX', ?)`,
      [client.id, vin(i), year, make, model, color, plate, 20000 + i * 4137]);

    const slot = statuses.length
      ? statuses[Math.min(statuses.length - 1, Math.floor((i / VEHICLES.length) * statuses.length))]
      : null;

    const amount = 180000 + i * 94500;
    const partsCost = i % 3 === 0 ? 0 : 42000 + i * 11000;
    const openedAt = daysAgo(28 - i);

    const ro = await texec(cid, `
      INSERT INTO repair_orders
        (ro_number, client_id, vehicle_id, insurer_client_id, ro_type, repair_path,
         status_slot, amount_cents, parts_cost_cents, deductible_cents, deductible_collect,
         claim_number, labor_hours, opened_at, promised_at,
         closed_at, close_date, paid, paid_cents)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        '24-' + String(1180 + i * 3),
        client.id, veh.insertId, carrier?.id ?? null,
        wholesale ? 'wholesale' : 'repair',
        i % 4 === 0 ? 'pdr' : 'conventional',
        closed ? (statuses[statuses.length - 1]?.slot_id ?? null) : (slot?.slot_id ?? null),
        amount, partsCost,
        carrier ? 50000 : 0, carrier ? 1 : 0,
        carrier ? 'CLM-' + (8840000 + i * 137) : null,
        14 + i, openedAt, dayOnly(-(3 + (i % 5))),
        closed ? daysAgo(6 - (i - 9) * 2) : null,
        closed ? dayOnly(6 - (i - 9) * 2) : null,
        0, 0
      ]);
    const roId = ro.insertId;
    made++;

    /* Who is on it. One tech per trade, which is the rule everywhere else. */
    const assign: Array<[string, Person | undefined]> = [
      ['body', techs('body')[i % Math.max(1, techs('body').length)]],
      ['paint', i % 3 === 0 ? undefined : techs('paint')[i % Math.max(1, techs('paint').length)]],
      ['pdr', i % 4 === 0 ? techs('pdr')[i % Math.max(1, techs('pdr').length)] : undefined],
      ['detail', i % 5 === 0 ? techs('detail')[0] : undefined],
      ['sales', people.find(p => p.role === 'salesperson')]
    ];
    for (const [pos, who] of assign) {
      if (!who) continue;
      await texec(cid,
        `INSERT INTO ro_assignments (ro_id, position_key, user_id, display_name)
         VALUES (?, ?, ?, ?)`, [roId, pos, who.userId, who.name]);
    }

    /* Parts: some received, some on order, one back-ordered per few cars. */
    if (!closed) {
      const lines = [
        ['Bumper cover, front', 'HC3Z-17D957-A', 'oem', 1, 64200, 41300, i % 3 === 0 ? 'need' : 'ordered'],
        ['Headlamp assembly, RH', 'JL3Z-13008-K', 'aftermarket', 1, 38900, 22100, i % 4 === 0 ? 'backordered' : 'received'],
        ['Grille', 'FL3Z-8200-BA', 'used', 1, 24600, 9800, 'received']
      ];
      for (const [desc, pn, type, qty, price, cost, state] of lines) {
        await texec(cid, `
          INSERT INTO parts_lines
            (ro_id, description, part_number, part_type, qty, price_cents, cost_cents, state,
             ordered_at, eta, gating)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
          [roId, desc, pn, type, qty, price, state === 'need' ? 0 : cost, state,
           state === 'need' ? null : daysAgo(9 - (i % 5)),
           state === 'need' ? null : dayOnly(-(2 + (i % 4)))]).catch(() => undefined);
      }
    }

    /* Closed files carry flagged labor, a settled profit and real receipts. */
    if (closed) {
      const body = techs('body')[i % Math.max(1, techs('body').length)];
      const paint = techs('paint')[i % Math.max(1, techs('paint').length)];
      const pctBase = Math.max(0, amount - partsCost);

      if (body) {
        const isPct = wholesale || cash;
        await texec(cid, `
          INSERT INTO ro_labour
            (ro_id, position_key, basis, hours, rate_cents, rate_pct, pct_base, cost_cents,
             user_id, display_name, flagged_at, flagged_by_name)
          VALUES (?, 'body', ?, ?, ?, ?, 'after_parts', ?, ?, ?, ?, 'Trey Alvarado')`,
          [roId, isPct ? 'pct' : 'hours', isPct ? 0 : 12.4, body.rateCents,
           isPct ? 12.5 : 0,
           isPct ? Math.round(pctBase * 0.125) : Math.round(12.4 * body.rateCents),
           body.userId, body.name, daysAgo(8 - (i - 9) * 2)]).catch(() => undefined);
      }
      if (paint) {
        await texec(cid, `
          INSERT INTO ro_labour
            (ro_id, position_key, basis, hours, rate_cents, cost_cents,
             user_id, display_name, flagged_at, flagged_by_name)
          VALUES (?, 'paint', 'hours', 6.2, ?, ?, ?, ?, ?, 'Trey Alvarado')`,
          [roId, paint.rateCents, Math.round(6.2 * paint.rateCents),
           paint.userId, paint.name, daysAgo(8 - (i - 9) * 2)]).catch(() => undefined);
      }

      /* Two paid in full, one still owed — so the chase list has something on
         it and the closed board shows both states. */
      const owing = i === 10;
      const insurerPart = carrier ? Math.round(amount * 0.78) : 0;
      const customerPart = amount - insurerPart - (owing ? 99917 : 0);

      if (insurerPart > 0) {
        await texec(cid, `
          INSERT INTO ro_payments
            (ro_id, amount_cents, method, payer, reference, received_at, recorded_by_name)
          VALUES (?, ?, 'draft', 'insurer', ?, ?, 'Denise Okafor')`,
          [roId, insurerPart, '447' + (1980 + i), dayOnly(7 - (i - 9) * 2)]).catch(() => undefined);
      }
      if (customerPart > 0) {
        await texec(cid, `
          INSERT INTO ro_payments
            (ro_id, amount_cents, method, payer, reference, received_at, recorded_by_name)
          VALUES (?, ?, ?, 'customer', ?, ?, 'Denise Okafor')`,
          [roId, customerPart, i % 2 ? 'check' : 'cash',
           i % 2 ? String(10400 + i) : null, dayOnly(6 - (i - 9) * 2)]).catch(() => undefined);
      }

      const paidCents = insurerPart + Math.max(0, customerPart);
      await texec(cid,
        `UPDATE repair_orders SET paid_cents = ?, paid = ?, paid_at = ? WHERE id = ?`,
        [paidCents, paidCents >= amount ? 1 : 0,
         paidCents >= amount ? daysAgo(6) : null, roId]);
    }

    await texec(cid, `
      INSERT INTO ro_notes (ro_id, kind, body, user_name)
      VALUES (?, 'auto', ?, 'System')`,
      [roId, closed ? 'File closed and booked.' : 'Vehicle checked in.']).catch(() => undefined);
  }

  return made;
}

/** Leads: some chased, some gone quiet, a couple quoted. */
async function seedLeads(cid: number, people: Person[]): Promise<number> {
  const rep = people.find(p => p.role === 'salesperson');
  const rows: Array<[string, string, string, string, string, number | null, number, number | null]> = [
    ['phone',    'new',              'Dana',    'Mireles', '2019 Chevy Malibu · rear quarter',   null,   0, null],
    ['website',  'contacted',        'Owen',    'Petrakis', '2021 Tesla Model 3 · door ding',    null,   2, 1],
    ['walk-in',  'estimate_written', 'Rosa',    'Delgado', '2016 Ford Escape · hail, full roof', 284500, 4, 3],
    ['referral', 'estimate_sent',    'Curtis',  'Yancey',  '2022 GMC Acadia · left front',       612000, 9, 7],
    ['google',   'contacted',        'Ilene',   'Mbeki',   '2020 Honda CR-V · bumper',           null,  12, 11],
    ['phone',    'new',              'Grant',   'Sowell',  '2018 Ram 2500 · bed and box',        null,   1, null],
    ['sales app','estimate_written', 'Tasha',   'Renner',  '2023 Kia Sportage · hail',           196000, 6, 5]
  ];

  let n = 0;
  for (let i = 0; i < rows.length; i++) {
    const [source, state, first, last, vehicleText, cents, age, replied] = rows[i];
    await texec(cid, `
      INSERT INTO leads
        (lead_number, source, state, payer, first_name, last_name, phone, vehicle_text,
         estimate_cents, estimate_written_at, owner_user_id, received_at, first_reply_at,
         last_followup_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        'L-' + String(2400 + i * 3), source, state,
        cents && i % 2 === 0 ? 'insurance' : 'cash',
        first, last, '(940) 555-0' + String(200 + i).slice(-3), vehicleText,
        cents, cents ? daysAgo(age) : null,
        rep?.userId ?? null, daysAgo(age),
        replied == null ? null : daysAgo(replied),
        replied == null ? null : daysAgo(replied)
      ]).catch(() => undefined);
    n++;
  }
  return n;
}

/* ------------------------------------------------------------------ tester */

/**
 * The shared Tester login. One account, on the demo shop, as an owner — the
 * demo is meant to be walked end to end, and a tour that cannot reach half the
 * screens is not a tour. Its password is rotated before each demo from the
 * platform screen.
 */
async function ensureTester(cid: number): Promise<string | null> {
  const existing = await mqOne<RowDataPacket>('SELECT id FROM users WHERE email = ?', [TESTER_EMAIL]);
  let userId: number;
  let password: string | null = null;

  if (existing) {
    userId = Number(existing.id);
  } else {
    password = randomPassword();
    const res = await mexec(
      `INSERT INTO users (email, password_hash, name, status, must_change_pw)
       VALUES (?, ?, 'Tester', 'active', 0)`,
      [TESTER_EMAIL, await hashPassword(password)]);
    userId = res.insertId;
  }

  await mexec(
    `INSERT INTO memberships (user_id, company_id, role, status)
     VALUES (?, ?, 'owner', 'active')
     ON DUPLICATE KEY UPDATE role = 'owner', status = 'active'`,
    [userId, cid]);
  await mexec(
    `INSERT IGNORE INTO membership_roles (user_id, company_id, role_key)
     VALUES (?, ?, 'owner')`, [userId, cid]).catch(() => undefined);

  await texec(cid, `
    INSERT INTO staff (user_id, display_name, position_key, active)
    VALUES (?, 'Tester', 'office', 1)
    ON DUPLICATE KEY UPDATE display_name = 'Tester', active = 1`, [userId]).catch(() => undefined);

  return password;
}

/** Rotate the Tester password. Generated unless one is typed, shown once. */
export async function setDemoTesterPassword(
  wanted: string | null
): Promise<{ companyId: number; email: string; password: string }> {
  const demo = await demoCompany();
  if (!demo) throw new Error('There is no demo shop on this box yet. Reset the demo first.');

  const user = await mqOne<RowDataPacket>('SELECT id FROM users WHERE email = ?', [TESTER_EMAIL]);
  if (!user) throw new Error('The Tester login does not exist yet. Reset the demo first.');

  const password = wanted ?? randomPassword();
  await mexec('UPDATE users SET password_hash = ?, must_change_pw = 0 WHERE id = ?',
    [await hashPassword(password), user.id]);

  return { companyId: Number(demo.id), email: TESTER_EMAIL, password };
}

/* --------------------------------------------------------------- the clock */

let timer: NodeJS.Timeout | null = null;

/**
 * The nightly reset, at the shop's own small hour. Checked every fifteen
 * minutes rather than scheduled to the second: a box that was asleep or
 * restarting at 2am still gets its reset, and a reset that already ran today
 * is skipped.
 */
export function startDemoReset(log: { info: (o: unknown, m?: string) => void; error: (o: unknown, m?: string) => void }): void {
  if (!config.demo.scheduled || timer) return;

  const tick = async (): Promise<void> => {
    try {
      const demo = await demoCompany();
      if (!demo) return;

      const now = new Date();
      const hour = Number(new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/Chicago', hour: 'numeric', hour12: false
      }).format(now));
      if (hour !== config.demo.resetHour) return;

      const last = demo.demo_reset_at ? new Date(demo.demo_reset_at) : null;
      if (last && now.getTime() - last.getTime() < 6 * 3600 * 1000) return;

      const out = await resetDemo(null);
      forgetTenant(out.companyId);
      log.info({ demo: out }, 'demo shop reset');
    } catch (e) {
      log.error({ err: e }, 'demo reset failed');
    }
  };

  timer = setInterval(() => { void tick(); }, 15 * 60 * 1000);
  timer.unref();
}

export function stopDemoReset(): void {
  if (timer) { clearInterval(timer); timer = null; }
}
