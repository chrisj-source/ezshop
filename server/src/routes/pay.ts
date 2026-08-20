import { FastifyInstance } from 'fastify';
import { RowDataPacket } from 'mysql2/promise';
import { mq } from '../db/master';
import { tq, texec, withTenantTx } from '../db/tenant';
import { requireCompany } from '../middleware/context';
import {
  DEDUCTIONS, PAY_WHEN, TRIGGERS, TriggerKey,
  correctTrigger, isoDay, loadPlan, payPeriodEnd,
  periodEndFor, reconcilePerson, targetLines
} from '../lib/pay';

/**
 * Sales pay: the plans, the commission report, and the runs that pay it.
 *
 * The rhythm this is built around: books close on the shop's chosen evening, the
 * report is run the next day, the money goes out after that. Running the report
 * is free and repeatable — a mistake made before the close and found after it
 * costs nothing as long as nobody has been paid. Once a run is paid, its lines
 * are closed for good and anything that moves afterwards comes through as an
 * adjustment on the next report.
 */
export async function registerPay(app: FastifyInstance): Promise<void> {

  const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

  /* ------------------------------------------------------------------ plans */

  app.get('/api/pay/plans', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (!ctx.caps.viewPayPlans) return reply.code(403).send({ error: 'Not permitted' });
    const cid = ctx.company!.id;

    /* Everyone who could carry a file's sales assignment: whoever holds a role
       with the leads capability, plus anyone already named on a plan. */
    const people = await mq<Array<RowDataPacket & { user_id: number; name: string }>>(
      `SELECT DISTINCT u.id AS user_id, u.name
       FROM membership_roles mr
       JOIN users u ON u.id = mr.user_id
       WHERE mr.company_id = ? ORDER BY u.name`, [cid]);

    const capsRows = await tq<Array<RowDataPacket & { role_key: string }>>(cid,
      `SELECT role_key FROM role_caps WHERE cap_key = 'leads' AND can_change = 1`).catch(() => []);
    const salesRoles = new Set(capsRows.map(r => r.role_key));

    const held = await mq<Array<RowDataPacket & { user_id: number; role_key: string }>>(
      'SELECT user_id, role_key FROM membership_roles WHERE company_id = ?', [cid]);
    const rolesOf = new Map<number, string[]>();
    for (const h of held) {
      rolesOf.set(h.user_id, [...(rolesOf.get(h.user_id) ?? []), h.role_key]);
    }

    const plans = await tq<RowDataPacket[]>(cid, `SELECT * FROM pay_plans`);
    const deds = await tq<Array<RowDataPacket & { user_id: number; deduct_key: string }>>(cid,
      'SELECT user_id, deduct_key FROM pay_plan_deductions');

    const endDay = await payPeriodEnd(cid);

    const out = people
      .filter(p => (rolesOf.get(p.user_id) ?? []).some(r => salesRoles.has(r))
        || plans.some(pl => pl.user_id === p.user_id))
      .map(p => {
        const plan = plans.find(pl => pl.user_id === p.user_id);
        return {
          userId: p.user_id,
          name: p.name,
          roles: rolesOf.get(p.user_id) ?? [],
          plan: plan ? {
            mode: plan.mode,
            rate: Number(plan.rate_pct),
            payWhen: plan.pay_when,
            dropOn: !!plan.drop_on,
            dropCents: Number(plan.drop_fee_cents),
            dropRecover: !!plan.drop_recover,
            tlCents: Number(plan.tl_amount_cents),
            tlPayDrop: !!plan.tl_pay_drop,
            active: !!plan.active,
            deductions: deds.filter(d => d.user_id === p.user_id).map(d => d.deduct_key)
          } : null
        };
      });

    return {
      people: out,
      deductions: DEDUCTIONS.map(d => ({ key: d.key, label: d.label, hint: d.hint })),
      payWhen: PAY_WHEN,
      periodEnd: endDay,
      days: DAYS,
      canEdit: ctx.caps.editPayPlans,
      /* Books close that evening; the report runs after. */
      thisPeriod: periodEndFor(new Date(), endDay)
    };
  });

  app.put('/api/pay/plans/:userId', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (!ctx.caps.editPayPlans) return reply.code(403).send({ error: 'Not permitted' });

    const userId = Number((req.params as { userId: string }).userId);
    const b = req.body as {
      mode?: 'net' | 'flat'; rate?: number; payWhen?: TriggerKey;
      dropOn?: boolean; dropCents?: number; dropRecover?: boolean;
      tlCents?: number; tlPayDrop?: boolean; active?: boolean; deductions?: string[];
    };
    const cid = ctx.company!.id;

    const mode = b.mode === 'flat' ? 'flat' : 'net';
    const rate = Math.max(0, Math.min(100, Number(b.rate ?? 0)));
    const payWhen: TriggerKey = PAY_WHEN.some(p => p.key === b.payWhen)
      ? (b.payWhen as TriggerKey) : 'file_closed';
    const deductions = (b.deductions ?? []).filter(d => DEDUCTIONS.some(x => x.key === d));

    await withTenantTx(cid, async (c) => {
      await c.query(`
        INSERT INTO pay_plans
          (user_id, mode, rate_pct, pay_when, drop_on, drop_fee_cents, drop_recover,
           tl_amount_cents, tl_pay_drop, active, updated_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
          mode = VALUES(mode), rate_pct = VALUES(rate_pct), pay_when = VALUES(pay_when),
          drop_on = VALUES(drop_on), drop_fee_cents = VALUES(drop_fee_cents),
          drop_recover = VALUES(drop_recover), tl_amount_cents = VALUES(tl_amount_cents),
          tl_pay_drop = VALUES(tl_pay_drop), active = VALUES(active), updated_by = VALUES(updated_by)`,
        [userId, mode, rate, payWhen, b.dropOn ? 1 : 0, Math.max(0, Math.round(Number(b.dropCents ?? 0))),
         b.dropRecover === false ? 0 : 1, Math.max(0, Math.round(Number(b.tlCents ?? 0))),
         b.tlPayDrop ? 1 : 0, b.active === false ? 0 : 1, ctx.user.id]);

      await c.query('DELETE FROM pay_plan_deductions WHERE user_id = ?', [userId]);
      for (const d of deductions) {
        await c.query('INSERT IGNORE INTO pay_plan_deductions (user_id, deduct_key) VALUES (?, ?)',
          [userId, d]);
      }
    });

    await texec(cid,
      `INSERT INTO audit_log (user_id, user_name, entity, entity_id, action, detail)
       VALUES (?, ?, 'pay_plan', ?, 'saved', ?)`,
      [ctx.user.id, ctx.user.name, userId,
       JSON.stringify({ mode, rate, payWhen, dropOn: !!b.dropOn, deductions })]);

    /* A plan change moves every unpaid line this person has. Paid lines stand,
       and the difference comes through as an adjustment. */
    const files = await reconcilePerson(cid, userId, `pay plan changed by ${ctx.user.name}`);
    return { ok: true, filesReconciled: files };
  });

  app.patch('/api/pay/period', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (!ctx.caps.editPayPlans) return reply.code(403).send({ error: 'Not permitted' });

    const day = String((req.body as { day?: string }).day ?? '').toLowerCase();
    if (!DAYS.includes(day)) return reply.code(400).send({ error: 'Pick a day of the week.' });

    await texec(ctx.company!.id, `
      INSERT INTO shop_settings (setting_key, setting_value) VALUES ('pay_period_end', ?)
      ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)`, [day]);
    await texec(ctx.company!.id,
      `INSERT INTO audit_log (user_id, user_name, entity, action, detail)
       VALUES (?, ?, 'pay_plan', 'period.changed', ?)`,
      [ctx.user.id, ctx.user.name, JSON.stringify({ day })]);

    /* Only unpaid lines are re-dated: a paid period keeps the boundary it was
       paid on. */
    return { ok: true, day, note: 'Unpaid lines will fall into periods ending on ' + day + '.' };
  });

  /* ---------------------------------------------------- one file's arithmetic */

  app.get('/api/ro/:id/pay', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (!ctx.caps.viewPayPlans && !ctx.caps.commissionMoney) {
      return reply.code(403).send({ error: 'Not permitted' });
    }
    const id = Number((req.params as { id: string }).id);
    const cid = ctx.company!.id;

    const { userId, plan, file, lines, deductions, base } = await targetLines(cid, id);
    const stamps = await tq<Array<RowDataPacket & { trigger_key: TriggerKey; fired_at: Date; source: string; corrected_at: Date | null }>>(
      cid, 'SELECT trigger_key, fired_at, source, corrected_at FROM ro_triggers WHERE ro_id = ?', [id]);

    const ledger = await tq<RowDataPacket[]>(cid,
      `SELECT id, kind, amount_cents, earned_at, period_end, paid_at, paid_cents, note
       FROM commission_lines WHERE ro_id = ? ORDER BY earned_at, id`, [id]);

    return {
      salesUserId: userId,
      plan,
      approvalCents: file?.amount_cents ?? 0,
      totalLoss: !!file?.total_loss_at,
      deductions,
      baseCents: base,
      expected: lines,
      ledger,
      triggers: TRIGGERS.map(t => {
        const s = stamps.find(x => x.trigger_key === t.key);
        return {
          key: t.key, label: t.label, fires: t.fires,
          firedAt: s?.fired_at ?? null,
          source: s?.source ?? null,
          corrected: !!s?.corrected_at,
          releases: plan
            ? (t.key === 'arrived' && plan.drop_on ? 'drop'
              : t.key === plan.pay_when && !file?.total_loss_at ? 'commission' : null)
            : null
        };
      })
    };
  });

  /**
   * Fix a stamp somebody fired by mistake — the file dragged into Parts that was
   * never approved. Send `null` to unfire it. The ledger settles behind the fix.
   */
  app.patch('/api/ro/:id/triggers/:key', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (!ctx.caps.editPayPlans) return reply.code(403).send({ error: 'Not permitted' });

    const id = Number((req.params as { id: string }).id);
    const key = (req.params as { key: string }).key as TriggerKey;
    if (!TRIGGERS.some(t => t.key === key)) return reply.code(400).send({ error: 'Unknown trigger' });

    const raw = (req.body as { at?: string | null }).at;
    const at = raw === null || raw === undefined || raw === '' ? null : new Date(raw);
    if (at && isNaN(at.getTime())) return reply.code(400).send({ error: 'That is not a date.' });

    await correctTrigger(ctx.company!.id, id, key, at, { userId: ctx.user.id, userName: ctx.user.name });
    await texec(ctx.company!.id,
      `INSERT INTO ro_notes (ro_id, kind, body, user_id, user_name) VALUES (?, 'auto', ?, ?, ?)`,
      [id, at ? `${key} stamp corrected to ${isoDay(at)}.` : `${key} stamp removed.`,
       ctx.user.id, ctx.user.name]);

    return { ok: true };
  });

  /* ----------------------------------------------------------- the report */

  /**
   * The commission report. Keyed on the pay period, broken down by salesperson,
   * every line showing what released it. Adjustments carried from a period
   * already paid sit in their own block, because that is the thing an owner
   * needs to understand before handing money over.
   */
  app.get('/api/reports/commission', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (!ctx.caps.commissionMoney && !ctx.caps.viewPayPlans) {
      return reply.code(403).send({ error: 'Not permitted' });
    }
    const cid = ctx.company!.id;
    const q = req.query as { period?: string; userId?: string };

    const endDay = await payPeriodEnd(cid);
    const period = q.period && /^\d{4}-\d{2}-\d{2}$/.test(q.period)
      ? q.period : periodEndFor(new Date(), endDay);

    const params: unknown[] = [period];
    let personSql = '';
    if (q.userId) { personSql = 'AND cl.user_id = ?'; params.push(Number(q.userId)); }

    const rows = await tq<RowDataPacket[]>(cid, `
      SELECT cl.id, cl.ro_id, cl.user_id, cl.kind, cl.amount_cents, cl.basis_cents, cl.rate_pct,
             cl.trigger_key, cl.earned_at, cl.period_end, cl.paid_at, cl.paid_cents,
             cl.supersedes_id, cl.note,
             r.ro_number, r.total_loss_at,
             CONCAT_WS(' ', v.year, v.make, v.model) AS vehicle
      FROM commission_lines cl
      JOIN repair_orders r ON r.id = cl.ro_id
      LEFT JOIN vehicles v ON v.id = r.vehicle_id
      WHERE cl.period_end <= ? AND (cl.paid_at IS NULL OR cl.period_end = ?) ${personSql}
      ORDER BY cl.user_id, cl.earned_at, cl.id`, [period, period, ...params.slice(1)]);

    const names = await mq<Array<RowDataPacket & { id: number; name: string }>>(
      `SELECT u.id, u.name FROM users u
       JOIN memberships m ON m.user_id = u.id AND m.company_id = ?`, [cid]);
    const nameOf = new Map(names.map(n => [n.id, n.name]));

    const people = new Map<number, {
      userId: number; name: string;
      lines: RowDataPacket[]; adjustments: RowDataPacket[];
      earnedCents: number; adjustmentCents: number; paidCents: number; owedCents: number;
      files: Set<number>;
    }>();

    for (const r of rows) {
      const uid = Number(r.user_id);
      if (!people.has(uid)) {
        people.set(uid, {
          userId: uid, name: nameOf.get(uid) ?? `User ${uid}`,
          lines: [], adjustments: [], earnedCents: 0, adjustmentCents: 0,
          paidCents: 0, owedCents: 0, files: new Set()
        });
      }
      const p = people.get(uid)!;
      const cents = Number(r.amount_cents);
      p.files.add(Number(r.ro_id));

      if (r.kind === 'adjustment') {
        p.adjustments.push(r);
        p.adjustmentCents += cents;
      } else {
        p.lines.push(r);
        p.earnedCents += cents;
      }
      if (r.paid_at) p.paidCents += Number(r.paid_cents ?? cents);
      else p.owedCents += cents;
    }

    const runs = await tq<RowDataPacket[]>(cid,
      `SELECT id, period_end, run_at, run_by_name, paid_at, total_cents, people
       FROM commission_runs WHERE period_end = ? ORDER BY run_at DESC`, [period]);

    const list = [...people.values()].map(p => ({
      ...p, files: p.files.size,
      /* What actually goes out: this period's lines plus whatever the last one
         got wrong. */
      payoutCents: p.owedCents
    })).sort((a, b) => b.payoutCents - a.payoutCents);

    return {
      period, periodEndDay: endDay,
      people: list,
      totalCents: list.reduce((a, p) => a + p.payoutCents, 0),
      runs,
      paid: runs.some(r => r.paid_at),
      canPay: ctx.caps.editPayPlans
    };
  });

  /**
   * Record that a period was paid. This is the only irreversible act in the pay
   * ledger: from here the lines stand, and a correction becomes an adjustment on
   * the next report rather than a rewrite of this one.
   */
  app.post('/api/pay/runs', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (!ctx.caps.editPayPlans) return reply.code(403).send({ error: 'Not permitted' });

    const b = req.body as { period?: string; pay?: boolean; note?: string };
    const cid = ctx.company!.id;
    const endDay = await payPeriodEnd(cid);
    const period = b.period && /^\d{4}-\d{2}-\d{2}$/.test(b.period)
      ? b.period : periodEndFor(new Date(), endDay);

    const unpaid = await tq<Array<RowDataPacket & { id: number; user_id: number; amount_cents: number }>>(
      cid, `SELECT id, user_id, amount_cents FROM commission_lines
            WHERE paid_at IS NULL AND period_end <= ?`, [period]);

    const total = unpaid.reduce((a, l) => a + Number(l.amount_cents), 0);
    const heads = new Set(unpaid.map(l => l.user_id)).size;

    const run = await texec(cid, `
      INSERT INTO commission_runs (period_end, run_by, run_by_name, paid_at, total_cents, people, note)
      VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [period, ctx.user.id, ctx.user.name, b.pay ? new Date() : null, total, heads, b.note ?? null]);

    if (b.pay && unpaid.length) {
      await texec(cid, `
        UPDATE commission_lines
           SET paid_at = NOW(), paid_cents = amount_cents, run_id = ?
         WHERE paid_at IS NULL AND period_end <= ?`, [run.insertId, period]);
    }

    await texec(cid,
      `INSERT INTO audit_log (user_id, user_name, entity, entity_id, action, detail)
       VALUES (?, ?, 'commission_run', ?, ?, ?)`,
      [ctx.user.id, ctx.user.name, run.insertId, b.pay ? 'paid' : 'run',
       JSON.stringify({ period, totalCents: total, people: heads, lines: unpaid.length })]);

    return {
      ok: true, runId: run.insertId, period, totalCents: total, people: heads,
      lines: unpaid.length,
      note: b.pay
        ? 'Paid. Anything that changes on these files now comes through as an adjustment.'
        : 'Run recorded. Nothing is closed until it is paid — run it again as often as you like.'
    };
  });

  /** What one person is owed, for their own screen. Own figures only. */
  app.get('/api/pay/mine', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    const cid = ctx.company!.id;
    const endDay = await payPeriodEnd(cid);
    const period = periodEndFor(new Date(), endDay);

    const plan = await loadPlan(cid, ctx.user.id);
    if (!plan) return { plan: null, period, lines: [], owedCents: 0 };

    const lines = await tq<RowDataPacket[]>(cid, `
      SELECT cl.kind, cl.amount_cents, cl.earned_at, cl.period_end, cl.paid_at, cl.note,
             r.ro_number, CONCAT_WS(' ', v.year, v.make, v.model) AS vehicle
      FROM commission_lines cl
      JOIN repair_orders r ON r.id = cl.ro_id
      LEFT JOIN vehicles v ON v.id = r.vehicle_id
      WHERE cl.user_id = ? AND cl.period_end <= ?
      ORDER BY cl.earned_at DESC LIMIT 200`, [ctx.user.id, period]);

    const owed = lines.filter(l => !l.paid_at).reduce((a, l) => a + Number(l.amount_cents), 0);
    return { plan, period, lines, owedCents: owed };
  });
}
