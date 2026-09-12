import { FastifyInstance } from 'fastify';
import { RowDataPacket } from 'mysql2/promise';
import { tq, tqOne, texec } from '../db/tenant';
import { requireCompany } from '../middleware/context';
import { audit } from '../lib/audit';
import { actorFrom } from './audit';
import {
  METHODS, METHOD_LABEL, Method, balanceFor, checkPayment, duplicateOf,
  paymentsFor, recount
} from '../lib/payments';
import {
  JOB_TYPES, JOB_LABEL, JobType, PlanBasis, flagRowsFor, fileBasis, plansFor, priceFlag
} from '../lib/tech-pay';
import { LABOUR_TRADES, Trade, TRADE_LABEL } from '../lib/profit';

/**
 * Money that arrives, and money that goes out to the floor.
 *
 * Payments: recorded from three places — an open file, the close out, and a
 * closed file that pays later — all of them the same endpoint. Paid is derived
 * from the balance and written by `recount`; nothing else sets it.
 *
 * Flags: a trade is settled while the car is still in the shop. The rows are
 * `ro_labour`, the same table close-out has always written, so closing reads
 * what the shop already agreed instead of asking again.
 */
export async function registerMoney(app: FastifyInstance): Promise<void> {

  function money(cents: number): string {
    return '$' + (cents / 100).toLocaleString('en-US',
      { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  async function roFor(cid: number, id: number): Promise<RowDataPacket | null> {
    return tqOne<RowDataPacket>(cid,
      'SELECT id, ro_number, amount_cents, paid_cents, closed_at FROM repair_orders WHERE id = ?',
      [id]);
  }

  /* ------------------------------------------------------------- payments */

  app.get('/api/ro/:id/payments', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (!ctx.caps.money) return reply.code(403).send({ error: 'Payments are money.' });

    const id = Number((req.params as { id: string }).id);
    const cid = ctx.company!.id;
    const ro = await roFor(cid, id);
    if (!ro) return reply.code(404).send({ error: 'No such repair order' });

    return {
      roNumber: ro.ro_number,
      balance: await balanceFor(cid, id),
      payments: await paymentsFor(cid, id),
      methods: METHODS.map(m => ({ key: m, label: METHOD_LABEL[m] })),
      canRecord: ctx.caps.editMoney
    };
  });

  /**
   * Record one payment. The same number may be used on many files — one
   * insurance draft often pays four — but not twice on the same file, and the
   * message names the payment it collides with rather than saying "duplicate".
   */
  app.post('/api/ro/:id/payments', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (!ctx.caps.editMoney) {
      return reply.code(403).send({ error: 'Recording a payment is the desk’s and accounting’s.' });
    }

    const id = Number((req.params as { id: string }).id);
    const cid = ctx.company!.id;
    const ro = await roFor(cid, id);
    if (!ro) return reply.code(404).send({ error: 'No such repair order' });

    const b = req.body as {
      amountCents?: number; method?: Method; payer?: string;
      reference?: string; note?: string; receivedAt?: string;
    };
    const p = {
      amountCents: Math.round(Number(b.amountCents) || 0),
      method: b.method as Method,
      payer: b.payer === 'insurer' ? 'insurer' as const : 'customer' as const,
      reference: b.reference == null ? null : String(b.reference).trim().slice(0, 64) || null,
      note: b.note == null ? null : String(b.note).trim().slice(0, 255) || null,
      receivedAt: String(b.receivedAt ?? '').slice(0, 10)
    };

    const bad = checkPayment(p);
    if (bad) return reply.code(400).send({ error: bad });

    const clash = await duplicateOf(cid, id, p.method, p.reference);
    if (clash) {
      return reply.code(409).send({
        error: `${METHOD_LABEL[p.method]} ${p.reference} is already recorded on this file, ` +
          `on ${clash.receivedAt} for ${money(clash.amountCents)}. Use a different number, ` +
          'or void that payment first.'
      });
    }

    const res = await texec(cid, `
      INSERT INTO ro_payments
        (ro_id, amount_cents, method, payer, reference, note, received_at,
         recorded_by, recorded_by_name)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, p.amountCents, p.method, p.payer, p.reference, p.note, p.receivedAt,
       ctx.user.id, ctx.user.name]);

    const balance = await recount(cid, id);

    await audit(cid, actorFrom(req), {
      entity: 'payment', entityId: res.insertId, roId: id, action: 'recorded', area: 'Money',
      label: `${money(p.amountCents)} ${METHOD_LABEL[p.method].toLowerCase()} from the ` +
        `${p.payer} on RO ${ro.ro_number}` + (p.reference ? ` — ${p.reference}` : ''),
      detail: { ...p, balanceCents: balance.balanceCents },
      sensitive: true
    });

    return { id: res.insertId, balance, payments: await paymentsFor(cid, id) };
  });

  /**
   * A wrong payment is voided with a reason, not deleted. The row stays, the
   * money comes off the balance, and the audit log keeps both facts.
   */
  app.post('/api/payments/:id/void', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (!ctx.caps.editMoney) return reply.code(403).send({ error: 'Not permitted' });

    const id = Number((req.params as { id: string }).id);
    const cid = ctx.company!.id;
    const reason = String((req.body as { reason?: string })?.reason ?? '').trim().slice(0, 190);
    if (!reason) return reply.code(400).send({ error: 'Say why it is being voided.' });

    const pay = await tqOne<RowDataPacket>(cid,
      'SELECT id, ro_id, amount_cents, method, reference, voided_at FROM ro_payments WHERE id = ?',
      [id]);
    if (!pay) return reply.code(404).send({ error: 'No such payment' });
    if (pay.voided_at) return reply.code(400).send({ error: 'That payment is already void.' });

    await texec(cid,
      'UPDATE ro_payments SET voided_at = NOW(), voided_by = ?, void_reason = ? WHERE id = ?',
      [ctx.user.id, reason, id]);

    const balance = await recount(cid, Number(pay.ro_id));

    await audit(cid, actorFrom(req), {
      entity: 'payment', entityId: id, roId: Number(pay.ro_id), action: 'void', area: 'Money',
      label: `${money(Number(pay.amount_cents))} ` +
        `${METHOD_LABEL[pay.method as Method].toLowerCase()} voided — ${reason}`,
      detail: { reason, balanceCents: balance.balanceCents },
      sensitive: true
    });

    return { balance, payments: await paymentsFor(cid, Number(pay.ro_id)) };
  });

  /* ---------------------------------------------------------- pay plans */

  app.get('/api/staff/:userId/pay-plans', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (!ctx.caps.viewPayPlans) return reply.code(403).send({ error: 'Pay plans are the owner’s.' });

    const userId = Number((req.params as { userId: string }).userId);
    const plans = await plansFor(ctx.company!.id, [userId]);
    const byType = plans.get(userId)!;

    return {
      userId,
      jobTypes: JOB_TYPES.map(t => ({ key: t, label: JOB_LABEL[t] })),
      plans: JOB_TYPES.map(t => byType[t]),
      canEdit: ctx.caps.editPayPlans
    };
  });

  /**
   * Save all three job types at once. They are read together, set together and
   * are meaningless apart — a person half on percentages is not a state anyone
   * means.
   */
  app.put('/api/staff/:userId/pay-plans', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (!ctx.caps.editPayPlans) return reply.code(403).send({ error: 'Not permitted' });

    const userId = Number((req.params as { userId: string }).userId);
    const cid = ctx.company!.id;
    const raw = (req.body as { plans?: unknown[] }).plans;
    if (!Array.isArray(raw)) return reply.code(400).send({ error: 'Nothing to save.' });

    const said: string[] = [];
    for (const r of raw as Array<Record<string, unknown>>) {
      const jobType = String(r.jobType ?? '') as JobType;
      if (!(JOB_TYPES as readonly string[]).includes(jobType)) continue;
      const basis = String(r.basis ?? 'hours') as PlanBasis;
      if (!['pct', 'hours', 'flat'].includes(basis)) continue;

      const pctPaint = Math.max(0, Math.min(100, Number(r.pctPaint) || 0));
      const pctNoPaint = Math.max(0, Math.min(100, Number(r.pctNoPaint) || 0));
      const rateCents = Math.max(0, Math.round(Number(r.rateCents) || 0));

      await texec(cid, `
        INSERT INTO staff_pay_plans
          (user_id, job_type, basis, pct_paint, pct_nopaint, rate_cents, updated_by)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
          basis = VALUES(basis), pct_paint = VALUES(pct_paint),
          pct_nopaint = VALUES(pct_nopaint), rate_cents = VALUES(rate_cents),
          updated_by = VALUES(updated_by)`,
        [userId, jobType, basis, pctPaint, pctNoPaint, rateCents, ctx.user.id]);

      said.push(`${JOB_LABEL[jobType]}: ` + (
        basis === 'pct' ? `${pctPaint}% with paint, ${pctNoPaint}% body only`
          : basis === 'flat' ? `${money(rateCents)} a car`
          : `${money(rateCents)} an hour`));
    }

    const who = await tqOne<RowDataPacket>(cid,
      'SELECT display_name FROM staff WHERE user_id = ?', [userId]);

    await audit(cid, actorFrom(req), {
      entity: 'pay_plan', entityId: userId, action: 'saved', area: 'Money',
      label: `Pay plan for ${who?.display_name ?? 'someone'} — ${said.join('; ')}`,
      detail: { plans: raw },
      sensitive: true
    });

    /* Files already closed keep what they settled on; this is deliberate. */
    return { saved: said.length, note: 'Applies to files closed from here on.' };
  });

  /* ------------------------------------------------------------- flagging */

  app.get('/api/ro/:id/flags', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (!ctx.caps.labourMoney) return reply.code(403).send({ error: 'Labour figures are money.' });

    const id = Number((req.params as { id: string }).id);
    const cid = ctx.company!.id;
    const ro = await roFor(cid, id);
    if (!ro) return reply.code(404).send({ error: 'No such repair order' });

    const { file, rows } = await flagRowsFor(cid, id);
    return {
      roNumber: ro.ro_number,
      closed: !!ro.closed_at,
      jobType: file.jobType,
      jobLabel: JOB_LABEL[file.jobType],
      hasPaint: file.hasPaint,
      paintReason: file.paintReason,
      approvalCents: file.approvalCents,
      partsCostCents: file.partsCostCents,
      pctBaseCents: file.pctBaseCents,
      rows,
      flagged: rows.filter(r => r.flagged).length,
      total: rows.length,
      flaggedCents: rows.filter(r => r.flagged).reduce((a, r) => a + r.amountCents, 0),
      canFlag: ctx.caps.editLabourMoney && !ro.closed_at
    };
  });

  /**
   * Save the flags. Each trade is entered the way it is paid — a percentage of
   * the billed figure, a flat dollar amount, or hours at that person's rate —
   * and the server prices it, so the browser never decides what anybody earns.
   */
  app.put('/api/ro/:id/flags', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (!ctx.caps.editLabourMoney) return reply.code(403).send({ error: 'Not permitted' });

    const id = Number((req.params as { id: string }).id);
    const cid = ctx.company!.id;
    const ro = await roFor(cid, id);
    if (!ro) return reply.code(404).send({ error: 'No such repair order' });
    if (ro.closed_at) {
      return reply.code(400).send({
        error: 'This file is closed. Reopen it to change what was flagged.'
      });
    }

    const file = await fileBasis(cid, id);
    if (!file) return reply.code(404).send({ error: 'No such repair order' });

    const raw = (req.body as { rows?: unknown[] }).rows;
    if (!Array.isArray(raw)) return reply.code(400).send({ error: 'Nothing to save.' });

    const said: string[] = [];
    let flaggedCents = 0;

    for (const r of raw as Array<Record<string, unknown>>) {
      const trade = String(r.positionKey ?? '') as Trade;
      if (!(LABOUR_TRADES as readonly string[]).includes(trade)) continue;

      const flagged = r.flagged === true;
      const basis = String(r.basis ?? 'hours') as PlanBasis;
      if (!['pct', 'hours', 'flat'].includes(basis)) continue;

      const pct = Math.max(0, Math.min(100, Number(r.pct) || 0));
      const hours = Math.max(0, Number(r.hours) || 0);
      const flatCents = Math.max(0, Math.round(Number(r.flatCents) || 0));
      const rateCents = Math.max(0, Math.round(Number(r.rateCents) || 0));
      const userId = r.userId == null ? null : Number(r.userId);
      const displayName = r.displayName == null ? null : String(r.displayName).slice(0, 120);

      const value = basis === 'pct' ? pct : basis === 'flat' ? flatCents : hours;
      const amountCents = priceFlag(basis, value, file, rateCents);

      /* `ro_labour.basis` has carried 'hours' | 'flat' | 'ems' | 'pct' since the
         close-out sheet was built; a flag writes the same three it uses. */
      await texec(cid, `
        INSERT INTO ro_labour
          (ro_id, position_key, basis, hours, rate_cents, rate_pct, pct_after_costs,
           pct_base, cost_cents, user_id, display_name, entered_by,
           flagged_at, flagged_by, flagged_by_name)
        VALUES (?, ?, ?, ?, ?, ?, 0, 'after_parts', ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
          basis = VALUES(basis), hours = VALUES(hours), rate_cents = VALUES(rate_cents),
          rate_pct = VALUES(rate_pct), pct_base = VALUES(pct_base),
          cost_cents = VALUES(cost_cents), user_id = VALUES(user_id),
          display_name = VALUES(display_name),
          flagged_at = VALUES(flagged_at), flagged_by = VALUES(flagged_by),
          flagged_by_name = VALUES(flagged_by_name)`,
        [id, trade, basis === 'flat' ? 'flat' : basis === 'pct' ? 'pct' : 'hours',
         basis === 'flat' ? 0 : hours, rateCents, pct, amountCents,
         userId, displayName, ctx.user.id,
         flagged ? new Date() : null, flagged ? ctx.user.id : null,
         flagged ? ctx.user.name : null]);

      if (flagged) {
        flaggedCents += amountCents;
        said.push(`${TRADE_LABEL[trade]} ${displayName ?? ''} ` + (
          basis === 'pct' ? `${pct}%` : basis === 'flat' ? 'flat' : `${hours} hrs`
        ) + ` = ${money(amountCents)}`);
      }
    }

    const after = await flagRowsFor(cid, id);

    await audit(cid, actorFrom(req), {
      entity: 'repair_order', entityId: id, roId: id, action: 'flagged', area: 'Money',
      label: `Techs flagged on RO ${ro.ro_number} — ` +
        (said.length ? said.join('; ') : 'nothing flagged'),
      detail: { rows: raw, flaggedCents },
      sensitive: true
    });

    return {
      rows: after.rows,
      flagged: after.rows.filter(r => r.flagged).length,
      total: after.rows.length,
      flaggedCents: after.rows.filter(r => r.flagged).reduce((a, r) => a + r.amountCents, 0)
    };
  });

  /**
   * The one-line state the board and the drawer read: how many trades are
   * flagged, and what is still owed. Cheap enough to ask for on every drawer
   * open, which is why it is separate from the grid above.
   */
  app.get('/api/ro/:id/money-state', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    const id = Number((req.params as { id: string }).id);
    const cid = ctx.company!.id;

    const out: Record<string, unknown> = {};
    if (ctx.caps.money) out.balance = await balanceFor(cid, id);
    if (ctx.caps.labourMoney) {
      const { rows } = await flagRowsFor(cid, id);
      out.flags = {
        flagged: rows.filter(r => r.flagged).length,
        total: rows.length,
        cents: rows.filter(r => r.flagged).reduce((a, r) => a + r.amountCents, 0)
      };
    }
    return out;
  });

  /** Everything owed across the shop, for the desk's chase list. */
  app.get('/api/receivables', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (!ctx.caps.money) return reply.code(403).send({ error: 'Not permitted' });

    const rows = await tq<RowDataPacket[]>(ctx.company!.id, `
      SELECT r.id, r.ro_number, r.amount_cents, r.paid_cents, r.close_date,
             r.amount_cents - r.paid_cents AS owed,
             c.name AS customer
        FROM repair_orders r
        LEFT JOIN clients c ON c.id = r.client_id
       WHERE r.voided_at IS NULL
         AND r.amount_cents > r.paid_cents
         AND r.closed_at IS NOT NULL
       ORDER BY r.close_date ASC`);

    return {
      rows: rows.map(r => ({
        id: r.id, roNumber: r.ro_number, customer: r.customer,
        approvalCents: Number(r.amount_cents), paidCents: Number(r.paid_cents),
        owedCents: Number(r.owed), closeDate: String(r.close_date ?? '').slice(0, 10)
      })),
      owedCents: rows.reduce((a, r) => a + Number(r.owed), 0)
    };
  });
}
