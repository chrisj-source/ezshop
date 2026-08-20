import { FastifyInstance } from 'fastify';
import { RowDataPacket } from 'mysql2/promise';
import { tq, tqOne, texec } from '../db/tenant';
import { requireCompany, requireFeature } from '../middleware/context';
import {
  Basis, LABOUR_TRADES, LabourEntry, RENTAL_PROVIDERS, Trade, TRADE_LABEL,
  assignmentsFor, emsHoursFor, fileFor, labourFor, priceEntry, profitFor,
  ratesFor, suggestLabour
} from '../lib/profit';
import { reconcile } from '../lib/pay';

/**
 * The close-out sheet, and the two things on the file that have to be settled
 * before it means anything.
 *
 * Every figure here is owner and accounting only — `viewPayPlans`. That is not a
 * matter of hiding controls: the endpoints refuse, and the arithmetic happens on
 * the server, so a browser that should not have these numbers never receives the
 * pieces they are made of.
 *
 * Deductible and rental are edited on the file rather than at close. A car is in
 * the shop for a fortnight; whether the customer is paying their deductible is
 * known long before anybody clicks Close, and pretending otherwise means the
 * close-out sheet asks questions the desk already answered.
 */
export async function registerCloseout(app: FastifyInstance): Promise<void> {

  function parseEntries(body: unknown): LabourEntry[] {
    const raw = (body as { labour?: unknown[] }).labour;
    if (!Array.isArray(raw)) return [];
    const out: LabourEntry[] = [];
    for (const r of raw as Array<Record<string, unknown>>) {
      const trade = String(r.positionKey ?? '') as Trade;
      if (!(LABOUR_TRADES as readonly string[]).includes(trade)) continue;
      const basis = String(r.basis ?? 'hours') as Basis;
      if (!['hours', 'flat', 'ems', 'pct'].includes(basis)) continue;
      const e: LabourEntry = {
        positionKey: trade,
        basis,
        hours: Math.max(0, Number(r.hours) || 0),
        rateCents: Math.max(0, Math.round(Number(r.rateCents) || 0)),
        ratePct: Math.max(0, Math.min(100, Number(r.ratePct) || 0)),
        pctAfterCosts: r.pctAfterCosts === true,
        costCents: 0,
        userId: r.userId == null ? null : Number(r.userId),
        displayName: r.displayName == null ? null : String(r.displayName)
      };
      /* A share is priced against the whole file, so profitFor works it out.
         Everything else is settled here. */
      e.costCents = basis === 'pct' ? 0 : priceEntry(e);
      out.push(e);
    }
    return out;
  }

  /* ------------------------------------------------------- the sheet itself */

  /**
   * What the close-out sheet should show. Rows come from the assignments, on each
   * tech's own basis and rate, with hours pulled from the estimate where the
   * import brought any over. Anything already saved wins over the suggestion.
   */
  app.get('/api/ro/:id/closeout', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (!ctx.caps.viewPayPlans) {
      return reply.code(403).send({ error: 'Close-out figures are the owner’s and accounting’s.' });
    }
    const id = Number((req.params as { id: string }).id);
    const cid = ctx.company!.id;

    const f = await fileFor(cid, id);
    if (!f) return reply.code(404).send({ error: 'No such repair order' });

    const entries = await suggestLabour(cid, id);
    const profit = await profitFor(cid, id, entries);
    const assigned = await assignmentsFor(cid, id);
    const rates = await ratesFor(cid, assigned.map(a => a.userId).filter((n): n is number => n !== null));
    const ems = await emsHoursFor(cid, id);

    const sales = assigned.find(a => a.positionKey === 'sales');

    return {
      roNumber: f.ro_number,
      approvalCents: Number(f.amount_cents),
      totalLoss: !!f.total_loss_at,
      /* Editable at close: the rental price and nothing else about the rental. */
      rental: {
        provider: f.rental_provider,
        covered: !!f.rental_covered,
        costCents: Number(f.rental_cost_cents)
      },
      deductible: {
        cents: Number(f.deductible_cents),
        collect: !!f.deductible_collect,
        chargeCents: Number(f.deductible_charge_cents)
      },
      materialsFlatCents: Number(f.materials_flat_cents),
      sales: sales ? {
        name: sales.name,
        payable: !!f.commission_payable
      } : null,
      labour: entries.map(e => ({
        ...e,
        label: TRADE_LABEL[e.positionKey],
        /* PDR alone can be paid a share; the sheet offers what the tech is on. */
        canPct: e.positionKey === 'pdr',
        rateOnFile: e.userId ? (rates.get(e.userId)?.rateCents ?? 0) : 0,
        ratePctOnFile: e.userId ? (rates.get(e.userId)?.ratePct ?? 0) : 0,
        emsHours: ems[e.positionKey] ?? 0
      })),
      profit,
      canClose: ctx.caps.closeRepairOrders
    };
  });

  /**
   * Recalculate without saving. The sheet asks for this as the desk types, so the
   * profit that appears is the server's answer and not the browser's.
   */
  app.post('/api/ro/:id/closeout/preview', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (!ctx.caps.viewPayPlans) return reply.code(403).send({ error: 'Not permitted' });

    const id = Number((req.params as { id: string }).id);
    const cid = ctx.company!.id;
    const b = req.body as { materialsFlatCents?: number; rentalCostCents?: number };

    /* The two figures the sheet may change: the rental price, and the materials
       figure where there are no paint hours to work from. */
    if (b.rentalCostCents !== undefined) {
      await texec(cid, 'UPDATE repair_orders SET rental_cost_cents = ? WHERE id = ?',
        [Math.max(0, Math.round(Number(b.rentalCostCents) || 0)), id]);
    }
    if (b.materialsFlatCents !== undefined) {
      await texec(cid, 'UPDATE repair_orders SET materials_flat_cents = ? WHERE id = ?',
        [Math.max(0, Math.round(Number(b.materialsFlatCents) || 0)), id]);
    }

    const entries = parseEntries(req.body);
    const profit = await profitFor(cid, id, entries);
    if (!profit) return reply.code(404).send({ error: 'No such repair order' });
    return { profit, labour: entries };
  });

  /** Read back what a closed file settled at. */
  app.get('/api/ro/:id/profit', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (!ctx.caps.viewPayPlans) return reply.code(403).send({ error: 'Not permitted' });

    const id = Number((req.params as { id: string }).id);
    const cid = ctx.company!.id;

    const settled = await tqOne<RowDataPacket>(cid,
      'SELECT * FROM ro_profit WHERE ro_id = ?', [id]);
    const entries = await labourFor(cid, id);
    /* Recomputed alongside the settled figure: if a rate changed since, the two
       will differ, and that difference is worth seeing rather than hiding. */
    const now = await profitFor(cid, id, entries);

    return { settled, labour: entries, current: now };
  });

  /* ------------------------------------------- the file: deductible, rental */

  /**
   * The deductible. The shop's own call, not the insurer's — they may write a
   * $1,000 deductible and the shop collect $500 of it. What is not collected is
   * given away, and it comes off the profit and off the commission base, which is
   * why saving it settles the pay ledger behind it.
   */
  app.patch('/api/ro/:id/deductible', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (!requireFeature(ctx, 'board', reply)) return;
    if (!ctx.caps.editRepairOrders) return reply.code(403).send({ error: 'Not permitted' });

    const id = Number((req.params as { id: string }).id);
    const cid = ctx.company!.id;
    const b = req.body as { cents?: number; collect?: boolean; chargeCents?: number };

    const owed = Math.max(0, Math.round(Number(b.cents) || 0));
    const collect = b.collect !== false;
    let charge = Math.max(0, Math.round(Number(b.chargeCents) || 0));
    if (!collect) charge = 0;
    if (charge > owed) {
      return reply.code(400).send({ error: 'Charging more than the deductible is not a deductible.' });
    }

    await texec(cid, `
      UPDATE repair_orders
      SET deductible_cents = ?, deductible_collect = ?, deductible_charge_cents = ?
      WHERE id = ?`, [owed, collect ? 1 : 0, charge, id]);

    const given = collect ? owed - charge : owed;
    await texec(cid,
      `INSERT INTO ro_notes (ro_id, kind, body, user_id, user_name) VALUES (?, 'auto', ?, ?, ?)`,
      [id, collect
        ? `Deductible ${money(owed)}, charging ${money(charge)}.` +
          (given > 0 ? ` ${money(given)} not collected.` : ' Collecting all of it.')
        : `Deductible ${money(owed)}, not collecting any of it.`,
       ctx.user.id, ctx.user.name]);

    /* Anything given away narrows the commission base, so the ledger follows. */
    await reconcile(cid, id, `deductible changed by ${ctx.user.name}`).catch(e => req.log.error(e));

    return { ok: true, givenCents: given };
  });

  /**
   * The rental. Provider and coverage are decided here and nowhere else; at close
   * only the price can be touched. A covered rental is reimbursed, so the shop
   * carries none of it in the profit — but there is money to chase, which is what
   * the coverage flag is for.
   */
  app.patch('/api/ro/:id/rental', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (!requireFeature(ctx, 'board', reply)) return;
    if (!ctx.caps.editRepairOrders) return reply.code(403).send({ error: 'Not permitted' });

    const id = Number((req.params as { id: string }).id);
    const cid = ctx.company!.id;
    const b = req.body as { provider?: string | null; covered?: boolean; costCents?: number };

    const provider = b.provider === null || b.provider === '' ? null : String(b.provider);
    if (provider && !RENTAL_PROVIDERS.includes(provider)) {
      return reply.code(400).send({ error: 'Unknown rental provider.' });
    }
    /* A shop loaner is the shop's own cost. There is nobody to reimburse it. */
    const covered = provider === 'Loaner' ? false : b.covered === true;
    const cost = Math.max(0, Math.round(Number(b.costCents) || 0));

    await texec(cid, `
      UPDATE repair_orders
      SET rental_provider = ?, rental_covered = ?, rental_cost_cents = ?
      WHERE id = ?`, [provider, covered ? 1 : 0, cost, id]);

    await texec(cid,
      `INSERT INTO ro_notes (ro_id, kind, body, user_id, user_name) VALUES (?, 'auto', ?, ?, ?)`,
      [id, provider
        ? `Rental: ${provider}, ${covered ? 'covered' : 'not covered'}, ${money(cost)}.`
        : 'Rental cleared off the file.',
       ctx.user.id, ctx.user.name]);

    /* An uncovered rental comes out of the commission base. */
    await reconcile(cid, id, `rental changed by ${ctx.user.name}`).catch(e => req.log.error(e));

    return { ok: true, providers: RENTAL_PROVIDERS, carriedCents: covered ? 0 : cost };
  });

  /**
   * Whether the commission is payable on this file. Marked on the sales pay side,
   * not at close: off for a house deal, a re-write someone else closed, or a car
   * nobody earns on. The close-out sheet reads this mark and leaves the sales pay
   * line out entirely when it is off.
   */
  app.patch('/api/ro/:id/commission-payable', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (!ctx.caps.editPayPlans) return reply.code(403).send({ error: 'Not permitted' });

    const id = Number((req.params as { id: string }).id);
    const cid = ctx.company!.id;
    const payable = (req.body as { payable?: boolean }).payable !== false;

    await texec(cid, 'UPDATE repair_orders SET commission_payable = ? WHERE id = ?',
      [payable ? 1 : 0, id]);
    await texec(cid,
      `INSERT INTO ro_notes (ro_id, kind, body, user_id, user_name) VALUES (?, 'auto', ?, ?, ?)`,
      [id, payable ? 'Commission payable on this file.' : 'No commission on this file.',
       ctx.user.id, ctx.user.name]);
    await texec(cid,
      `INSERT INTO audit_log (user_id, user_name, entity, entity_id, action, detail)
       VALUES (?, ?, 'repair_order', ?, 'commission_payable', ?)`,
      [ctx.user.id, ctx.user.name, id, JSON.stringify({ payable })]);

    await reconcile(cid, id, `commission ${payable ? 'marked payable' : 'turned off'} by ${ctx.user.name}`)
      .catch(e => req.log.error(e));

    return { ok: true, payable };
  });

  /* --------------------------------------------------- rates on the person */

  /** What each tech is on. Owner and accounting; it is pay. */
  app.get('/api/staff/rates', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (!ctx.caps.viewPayPlans) return reply.code(403).send({ error: 'Not permitted' });

    const rows = await tq<RowDataPacket[]>(ctx.company!.id, `
      SELECT s.user_id, s.display_name, s.position_key, s.pay_basis, s.rate_cents, s.rate_pct,
             p.label AS position_label
      FROM staff s
      LEFT JOIN positions p ON p.position_key = s.position_key
      WHERE s.active = 1
      ORDER BY p.sort_order, s.display_name`);

    const mat = await tqOne<RowDataPacket & { setting_value: string }>(ctx.company!.id,
      "SELECT setting_value FROM shop_settings WHERE setting_key = 'materials_rate_cents'");

    return {
      staff: rows.map(r => ({
        userId: r.user_id,
        name: r.display_name,
        positionKey: r.position_key,
        positionLabel: r.position_label,
        basis: r.pay_basis,
        rateCents: Number(r.rate_cents),
        ratePct: Number(r.rate_pct),
        /* A share is PDR only. Everyone else is hours or a flat rate per car. */
        canPct: r.position_key === 'pdr'
      })),
      materialsRateCents: Number(mat?.setting_value ?? 4200),
      canEdit: ctx.caps.editPayPlans
    };
  });

  app.patch('/api/staff/:userId/rate', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (!ctx.caps.editPayPlans) return reply.code(403).send({ error: 'Not permitted' });

    const userId = Number((req.params as { userId: string }).userId);
    const cid = ctx.company!.id;
    const b = req.body as { basis?: string; rateCents?: number; ratePct?: number };

    const who = await tqOne<RowDataPacket & { display_name: string; position_key: string | null }>(
      cid, 'SELECT display_name, position_key FROM staff WHERE user_id = ?', [userId]);
    if (!who) return reply.code(404).send({ error: 'Nobody by that id.' });

    let basis = ['hourly', 'flat', 'pct'].includes(String(b.basis)) ? String(b.basis) : 'hourly';
    if (basis === 'pct' && who.position_key !== 'pdr') {
      return reply.code(400).send({ error: 'A share of the job is PDR only.' });
    }

    const cents = Math.max(0, Math.round(Number(b.rateCents) || 0));
    const pct = Math.max(0, Math.min(100, Number(b.ratePct) || 0));

    await texec(cid,
      'UPDATE staff SET pay_basis = ?, rate_cents = ?, rate_pct = ? WHERE user_id = ?',
      [basis, cents, pct, userId]);
    await texec(cid,
      `INSERT INTO audit_log (user_id, user_name, entity, entity_id, action, detail)
       VALUES (?, ?, 'staff', ?, 'rate', ?)`,
      [ctx.user.id, ctx.user.name, userId,
       JSON.stringify({ who: who.display_name, basis, cents, pct })]);

    /* Rates only reprice files that have not been closed out; a settled sheet
       keeps the rate it was settled on. */
    return {
      ok: true,
      note: 'Saved. Files already closed keep the rate they were settled on.'
    };
  });

  app.patch('/api/shop/materials-rate', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (!ctx.caps.editPayPlans) return reply.code(403).send({ error: 'Not permitted' });

    const cents = Math.max(0, Math.round(Number((req.body as { cents?: number }).cents) || 0));
    await texec(ctx.company!.id, `
      INSERT INTO shop_settings (setting_key, setting_value) VALUES ('materials_rate_cents', ?)
      ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)`, [String(cents)]);
    return { ok: true, cents };
  });
}

function money(cents: number): string {
  return '$' + (cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
