import { FastifyInstance } from 'fastify';
import { RowDataPacket } from 'mysql2/promise';
import { tq, texec, tqOne, withTenantTx } from '../db/tenant';
import { requireCompany } from '../middleware/context';
import { audit, moneyStr } from '../lib/audit';
import { actorFrom } from './audit';
import {
  CarRow, DAYS, buildPeriod, crew, currentPeriod, earnedOf, hoursOf,
  linesBetween, payrollSettings, periodEndOnOrAfter, runFor
} from '../lib/payroll';

/**
 * The payroll screen: the non-sales week.
 *
 * Everything on it is pay, so everything is behind `viewPayPlans` — the same
 * gate as the close-out figures and the sales plans. Changing how somebody is
 * paid needs `editPayPlans`.
 *
 * The one rule worth restating here: a salaried person's sheet carries no
 * per-car figure at all. Not hidden in the browser — never sent. What their cars
 * would have paid by the hour is nobody's business, including theirs.
 */
export async function registerPayroll(app: FastifyInstance): Promise<void> {

  app.get('/api/payroll', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (!ctx.caps.viewPayPlans) {
      return reply.code(403).send({ error: 'Payroll is the owner’s and accounting’s.' });
    }
    const cid = ctx.company!.id;
    const q = req.query as { end?: string };

    const { closeDay, cutoff } = await payrollSettings(cid);
    const end = /^\d{4}-\d{2}-\d{2}$/.test(q.end ?? '')
      ? (q.end as string)
      : (await currentPeriod(cid)).end;
    const period = buildPeriod(end, closeDay, cutoff);

    const people = await crew(cid);
    const run = await runFor(cid, end);
    const paid = !!run?.paid_at;

    /* A paid period is read back from its own snapshot: rates and modes may have
       moved since, and what was paid is what was paid. */
    const lines = paid
      ? await snapshotLines(cid, Number(run!.id))
      : await linesBetween(cid, period.fromAt, period.cutoffAt);

    /* What closed after the cutoff and is therefore next week's. Only shown up
       to now, so a future period does not pretend to know. */
    const rolledEnd = nowStamp();
    const rolled = rolledEnd > period.cutoffAt
      ? await linesBetween(cid, period.cutoffAt, rolledEnd)
      : new Map<number, CarRow[]>();

    const snapPeople = paid
      ? await tq<RowDataPacket[]>(cid,
          'SELECT * FROM payroll_run_people WHERE run_id = ?', [Number(run!.id)])
      : [];

    const out = people.map(p => {
      const snap = snapPeople.find(s => Number(s.user_id) === p.userId);
      const mode = snap ? (snap.pay_mode as 'per_car' | 'salary') : p.payMode;
      const salary = snap ? Number(snap.salary_cents) : p.salaryCents;
      const cars = lines.get(p.userId) ?? [];
      const earned = earnedOf(cars);
      return {
        userId: p.userId,
        name: p.name,
        positionKey: p.positionKey,
        positionLabel: p.positionLabel,
        payMode: mode,
        salaryCents: salary,
        rateCents: p.rateCents,
        cars: cars.length,
        hours: hoursOf(cars),
        flatCars: cars.filter(c => c.basis === 'flat' || c.basis === 'pct').length,
        /* Salary: the car list travels, the money does not. */
        earnedCents: mode === 'salary' ? null : earned,
        totalCents: mode === 'salary' ? salary : earned,
        rolled: (rolled.get(p.userId) ?? []).length
      };
    });

    return {
      period: {
        ...period,
        days: DAYS,
        paidAt: run?.paid_at ?? null,
        runAt: run?.run_at ?? null,
        runBy: run?.run_by_name ?? null,
        isCurrent: end === periodEndOnOrAfter(new Date(), closeDay)
      },
      people: out,
      totalCents: out.reduce((n, p) => n + p.totalCents, 0),
      canEdit: ctx.caps.editPayPlans,
      note: paid
        ? 'This period is paid. The sheets are what was paid; a correction lands on the next period.'
        : 'Nothing is paid yet. Running the sheet is free and repeatable until it is.'
    };
  });

  /** One person's sheet — the car list, and the money only if they earn per car. */
  app.get('/api/payroll/person/:userId', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (!ctx.caps.viewPayPlans) return reply.code(403).send({ error: 'Not permitted' });

    const cid = ctx.company!.id;
    const userId = Number((req.params as { userId: string }).userId);
    const q = req.query as { end?: string };

    const { closeDay, cutoff } = await payrollSettings(cid);
    const end = /^\d{4}-\d{2}-\d{2}$/.test(q.end ?? '') ? (q.end as string) : (await currentPeriod(cid)).end;
    const period = buildPeriod(end, closeDay, cutoff);

    const person = (await crew(cid)).find(p => p.userId === userId);
    if (!person) return reply.code(404).send({ error: 'Nobody on payroll by that id.' });

    const run = await runFor(cid, end);
    const paid = !!run?.paid_at;
    const snap = paid
      ? await tqOne<RowDataPacket>(cid,
          'SELECT * FROM payroll_run_people WHERE run_id = ? AND user_id = ?',
          [Number(run!.id), userId])
      : null;

    const mode: 'per_car' | 'salary' = snap ? (snap.pay_mode as 'per_car' | 'salary') : person.payMode;
    const salary = snap ? Number(snap.salary_cents) : person.salaryCents;

    const all = paid ? await snapshotLines(cid, Number(run!.id)) : await linesBetween(cid, period.fromAt, period.cutoffAt);
    const cars = all.get(userId) ?? [];

    const nowAt = nowStamp();
    const rolled = nowAt > period.cutoffAt
      ? (await linesBetween(cid, period.cutoffAt, nowAt)).get(userId) ?? []
      : [];

    const salaried = mode === 'salary';

    return {
      person: {
        userId, name: person.name, positionLabel: person.positionLabel,
        payMode: mode, salaryCents: salary, rateCents: person.rateCents
      },
      period: { ...period, paidAt: run?.paid_at ?? null },
      /* The shape of a row changes with the mode, because a salaried sheet has
         no money on it to send. */
      cars: cars.map(c => ({
        roId: c.roId, roNumber: c.roNumber, vehicle: c.vehicle, client: c.client,
        closedAt: c.closedAt, positionKey: c.positionKey, totalLoss: c.totalLoss,
        basis: salaried ? null : c.basis,
        hours: c.basis === 'flat' || c.basis === 'pct' ? null : c.hours,
        rateCents: salaried ? null : (c.basis === 'flat' || c.basis === 'pct' ? null : c.rateCents),
        costCents: salaried ? null : c.costCents
      })),
      rolled: rolled.map(c => ({
        roNumber: c.roNumber, vehicle: c.vehicle, closedAt: c.closedAt
      })),
      summary: {
        cars: cars.length,
        hourlyCars: cars.filter(c => c.basis !== 'flat' && c.basis !== 'pct').length,
        flatCars: cars.filter(c => c.basis === 'flat' || c.basis === 'pct').length,
        hours: hoursOf(cars),
        earnedCents: salaried ? null : earnedOf(cars),
        totalCents: salaried ? salary : earnedOf(cars)
      },
      canEdit: ctx.caps.editPayPlans
    };
  });

  /* ------------------------------------------------- how a person is paid */

  app.patch('/api/payroll/person/:userId', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (!ctx.caps.editPayPlans) return reply.code(403).send({ error: 'Not permitted' });

    const cid = ctx.company!.id;
    const userId = Number((req.params as { userId: string }).userId);
    const b = req.body as { mode?: string; salaryCents?: number };

    const before = await tqOne<RowDataPacket>(cid,
      'SELECT display_name, pay_mode, salary_cents FROM staff WHERE user_id = ?', [userId]);
    if (!before) return reply.code(404).send({ error: 'Nobody by that id.' });

    const mode = b.mode === 'salary' ? 'salary' : 'per_car';
    const salary = Math.max(0, Math.round(Number(b.salaryCents) || 0));

    await texec(cid, 'UPDATE staff SET pay_mode = ?, salary_cents = ? WHERE user_id = ?',
      [mode, salary, userId]);

    await audit(cid, actorFrom(req), {
      entity: 'staff', entityId: userId, action: 'payroll_mode', area: 'Payroll',
      label: `${before.display_name} — paid ${mode === 'salary' ? 'salary ' + moneyStr(salary) : 'by the car'}`,
      changes: [
        { field: 'Pay mode', from: String(before.pay_mode), to: mode },
        { field: 'Salary', from: moneyStr(Number(before.salary_cents)), to: moneyStr(salary) }
      ]
    });

    return {
      ok: true, mode, salaryCents: salary,
      note: mode === 'salary'
        ? 'Per-car figures are off this person’s sheet from now on. Periods already paid keep what they paid.'
        : 'Paid on what each file was costed at in close-out.'
    };
  });

  /* ------------------------------------------------------------ the period */

  app.patch('/api/payroll/period', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (!ctx.caps.editPayPlans) return reply.code(403).send({ error: 'Not permitted' });

    const cid = ctx.company!.id;
    const b = req.body as { day?: string; cutoff?: string };
    const was = await payrollSettings(cid);

    const day = String(b.day ?? was.closeDay).toLowerCase();
    if (!DAYS.includes(day)) return reply.code(400).send({ error: 'Pick a day of the week.' });
    const cutoff = String(b.cutoff ?? was.cutoff);
    if (!/^\d{1,2}:\d{2}$/.test(cutoff)) return reply.code(400).send({ error: 'Cutoff wants a time like 16:00.' });

    for (const [k, v] of [['payroll_close_day', day], ['payroll_cutoff', cutoff]] as const) {
      await texec(cid, `
        INSERT INTO shop_settings (setting_key, setting_value) VALUES (?, ?)
        ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)`, [k, v]);
    }

    await audit(cid, actorFrom(req), {
      entity: 'payroll', action: 'period_changed', area: 'Payroll',
      label: `Payroll week now closes ${day} at ${cutoff}`,
      changes: [
        { field: 'Close day', from: was.closeDay, to: day },
        { field: 'Cutoff', from: was.cutoff, to: cutoff }
      ]
    });

    return {
      ok: true, day, cutoff,
      note: 'Periods already paid keep the boundary they were paid on.'
    };
  });

  /* ---------------------------------------------------------------- paying */

  /**
   * Settle a period. The sheets are snapshotted as they stand — people, modes,
   * salaries and every costed car — so a paid period can be reprinted exactly
   * even after a rate changes or somebody moves onto a salary.
   */
  app.post('/api/payroll/run', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (!ctx.caps.editPayPlans) return reply.code(403).send({ error: 'Not permitted' });

    const cid = ctx.company!.id;
    const b = req.body as { end?: string; pay?: boolean };
    const { closeDay, cutoff } = await payrollSettings(cid);
    const end = /^\d{4}-\d{2}-\d{2}$/.test(b.end ?? '') ? (b.end as string) : (await currentPeriod(cid)).end;
    const period = buildPeriod(end, closeDay, cutoff);

    const existing = await runFor(cid, end);
    if (existing?.paid_at) {
      return reply.code(400).send({ error: 'That period is already paid. Corrections go on the next one.' });
    }

    const people = await crew(cid);
    const lines = await linesBetween(cid, period.fromAt, period.cutoffAt);

    let total = 0, counted = 0;

    await withTenantTx(cid, async (c) => {
      await c.query(`
        INSERT INTO payroll_runs (period_end, cutoff_at, run_by, run_by_name, total_cents, people)
        VALUES (?, ?, ?, ?, 0, 0)
        ON DUPLICATE KEY UPDATE cutoff_at = VALUES(cutoff_at), run_at = CURRENT_TIMESTAMP,
          run_by = VALUES(run_by), run_by_name = VALUES(run_by_name)`,
        [end, period.cutoffAt, ctx.user.id, ctx.user.name]);

      const [row] = await c.query<RowDataPacket[]>(
        'SELECT id FROM payroll_runs WHERE period_end = ?', [end]);
      const runId = Number((row as RowDataPacket[])[0].id);

      await c.query('DELETE FROM payroll_run_people WHERE run_id = ?', [runId]);
      await c.query('DELETE FROM payroll_run_cars WHERE run_id = ?', [runId]);

      for (const p of people) {
        const cars = lines.get(p.userId) ?? [];
        const earned = earnedOf(cars);
        const owed = p.payMode === 'salary' ? p.salaryCents : earned;
        if (!cars.length && !owed) continue;

        await c.query(`
          INSERT INTO payroll_run_people
            (run_id, user_id, display_name, pay_mode, salary_cents, cars, hours, total_cents)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [runId, p.userId, p.name, p.payMode, p.salaryCents, cars.length, hoursOf(cars), owed]);

        for (const car of cars) {
          await c.query(`
            INSERT INTO payroll_run_cars
              (run_id, user_id, ro_id, position_key, basis, hours, rate_cents, cost_cents)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [runId, p.userId, car.roId, car.positionKey, car.basis, car.hours,
             car.rateCents, car.costCents]);
        }

        total += owed;
        counted += 1;
      }

      await c.query(
        `UPDATE payroll_runs SET total_cents = ?, people = ?, paid_at = ? WHERE id = ?`,
        [total, counted, b.pay ? new Date() : null, runId]);
    });

    await audit(cid, actorFrom(req), {
      entity: 'payroll', action: b.pay ? 'period_paid' : 'period_run', area: 'Payroll',
      label: `Payroll ${b.pay ? 'paid' : 'run'} for the week ending ${end} — ${moneyStr(total)} across ${counted} people`,
      detail: { end, cutoffAt: period.cutoffAt, total, people: counted }
    });

    return {
      ok: true, end, totalCents: total, people: counted, paid: !!b.pay,
      note: b.pay
        ? 'Paid. These sheets are now what was paid; anything that moves lands on the next period.'
        : 'Run saved. Nothing is paid until you say so.'
    };
  });

  app.get('/api/payroll/runs', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (!ctx.caps.viewPayPlans) return reply.code(403).send({ error: 'Not permitted' });
    const rows = await tq<RowDataPacket[]>(ctx.company!.id, `
      SELECT id, period_end, cutoff_at, run_at, run_by_name, paid_at, total_cents, people
      FROM payroll_runs ORDER BY period_end DESC LIMIT 40`);
    return { runs: rows };
  });

  /** A paid period's cars, read back from the snapshot rather than recomputed. */
  async function snapshotLines(cid: number, runId: number): Promise<Map<number, CarRow[]>> {
    const rows = await tq<Array<RowDataPacket & {
      user_id: number; ro_id: number; position_key: string; basis: CarRow['basis'];
      hours: string; rate_cents: number; cost_cents: number;
      ro_number: string; closed_at: string; year: number | null; make: string | null;
      model: string | null; client: string | null; total_loss_at: Date | null;
    }>>(cid, `
      SELECT pc.user_id, pc.ro_id, pc.position_key, pc.basis, pc.hours, pc.rate_cents,
             pc.cost_cents, r.ro_number, r.closed_at, r.total_loss_at,
             v.year, v.make, v.model, c.name AS client
      FROM payroll_run_cars pc
      JOIN repair_orders r ON r.id = pc.ro_id
      LEFT JOIN vehicles v ON v.id = r.vehicle_id
      LEFT JOIN clients c ON c.id = r.client_id
      WHERE pc.run_id = ?
      ORDER BY r.closed_at DESC`, [runId]);

    const out = new Map<number, CarRow[]>();
    for (const r of rows) {
      const car: CarRow = {
        roId: r.ro_id, roNumber: r.ro_number,
        vehicle: [r.year || '', r.make || '', r.model || ''].join(' ').trim() || '—',
        client: r.client, closedAt: String(r.closed_at), positionKey: r.position_key,
        basis: r.basis, hours: Number(r.hours) || 0, rateCents: Number(r.rate_cents) || 0,
        costCents: Number(r.cost_cents) || 0, totalLoss: !!r.total_loss_at
      };
      out.set(r.user_id, [...(out.get(r.user_id) ?? []), car]);
    }
    return out;
  }
}

function nowStamp(): string {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0') + ' ' +
    String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0') + ':00';
}
