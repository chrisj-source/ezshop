import { FastifyInstance, FastifyReply } from 'fastify';
import { RowDataPacket } from 'mysql2/promise';
import { tq, tqOne, texec } from '../db/tenant';
import { requireCompany } from '../middleware/context';
import { audit } from '../lib/audit';
import { actorFrom } from './audit';
import {
  REFERRER_KINDS, W9_LIMIT_CENTS, createReferrer, digits10, matchPeople, mayEditFee,
  referrals, referrerById, yearTotals
} from '../lib/referrals';

const err = (reply: FastifyReply, e: unknown) => {
  const x = e as Error & { code?: number };
  return reply.code(typeof x.code === 'number' ? x.code : 500).send({ error: x.message });
};

export async function registerReferrers(app: FastifyInstance): Promise<void> {

  app.get('/api/referrer-kinds', async () => ({ kinds: REFERRER_KINDS }));

  /** Find a referrer by name, company, phone or email. */
  app.get('/api/referrers', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (!ctx.caps.viewLeads) return reply.code(403).send({ error: 'Not permitted' });
    const q = String((req.query as { q?: string }).q ?? '').trim().toLowerCase();
    const ph = digits10(q);
    const rows = await tq<RowDataPacket[]>(ctx.company!.id, `
      SELECT f.id, f.kind, f.name, f.company, f.phone, f.email, f.city, f.default_fee_cents, f.payee_default,
             f.client_id, f.w9_on_file,
             (SELECT COUNT(*) FROM leads l WHERE l.referrer_id = f.id AND l.deleted_at IS NULL) AS sent
      FROM referrers f
      WHERE f.active = 1 AND (? = '' OR LOWER(f.name) LIKE ? OR LOWER(COALESCE(f.company,'')) LIKE ?
                              OR LOWER(COALESCE(f.email,'')) LIKE ? OR (? <> '' AND f.phone = ?))
      ORDER BY f.name LIMIT 30`, [q, `%${q}%`, `%${q}%`, `%${q}%`, ph, ph]);
    const money = !!(ctx.caps.money || ctx.caps.salesManager);
    return { referrers: rows.map(r => money ? r : { ...r, default_fee_cents: null }) };
  });

  /** Already a client / already a referrer / possible match. */
  app.get('/api/referrers/match', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (!ctx.caps.viewLeads) return reply.code(403).send({ error: 'Not permitted' });
    const q = req.query as { phone?: string; email?: string; name?: string; address?: string };
    return matchPeople(ctx.company!.id, q);
  });

  app.post('/api/referrers', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (!ctx.caps.manageLeads) return reply.code(403).send({ error: 'Not permitted' });
    try {
      const b = (req.body ?? {}) as Parameters<typeof createReferrer>[1];
      if (!mayEditFee(ctx.caps)) { b.defaultFeeCents = undefined; }
      const r = await createReferrer(ctx.company!.id, b, ctx.user.id);
      if (!r.existed) await audit(ctx.company!.id, actorFrom(req), { entity: 'referrer', entityId: r.id, action: 'referrer_created',
        area: 'Lead', label: 'Referrer added', changes: [{ field: 'Referrer', from: null, to: String(b.name ?? 'from client') }] });
      return { ok: true, ...r };
    } catch (e) { return err(reply, e); }
  });

  /** One referrer: details, the referrals they sent, the year's totals and the W-9 state. */
  app.get('/api/referrers/:id', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (!ctx.caps.viewLeads) return reply.code(403).send({ error: 'Not permitted' });
    const cid = ctx.company!.id, id = Number((req.params as { id: string }).id);
    const f = await referrerById(cid, id);
    if (!f) return reply.code(404).send({ error: 'No such referrer' });
    const money = !!(ctx.caps.money || ctx.caps.salesManager);
    const list = await referrals(cid, 'l.referrer_id = ?', [id]);
    const t = await yearTotals(cid, id);
    return {
      referrer: money ? f : { ...f, default_fee_cents: null },
      referrals: list.map(r => ({ leadId: r.lead_id, leadNumber: r.lead_number, customer: r.customer, vehicle: r.vehicle,
        roId: r.ro_id, roNumber: r.ro_number, state: r.state.key, label: r.state.label, payee: r.state.payee,
        feeCents: money ? r.state.feeCents : null })),
      totals: money ? t : null,
      w9Warn: money && !f.w9_on_file && t.paidCents + t.owedCents > W9_LIMIT_CENTS
    };
  });

  app.patch('/api/referrers/:id', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (!ctx.caps.manageLeads) return reply.code(403).send({ error: 'Not permitted' });
    const cid = ctx.company!.id, id = Number((req.params as { id: string }).id);
    const b = (req.body ?? {}) as Record<string, unknown>;
    const sets: string[] = [], vals: unknown[] = [];
    const put = (col: string, v: unknown) => { sets.push(`${col} = ?`); vals.push(v); };
    for (const [k, col] of [['name', 'name'], ['company', 'company'], ['email', 'email'], ['address', 'address'],
      ['city', 'city'], ['addrState', 'addr_state'], ['zip', 'zip'], ['note', 'note']] as const) {
      if (b[k] !== undefined) put(col, String(b[k] ?? '').trim() || null);
    }
    if (b.phone !== undefined) put('phone', digits10(b.phone) || null);
    if (b.kind !== undefined) {
      if (!REFERRER_KINDS.some(k => k.key === b.kind)) return reply.code(400).send({ error: 'Unknown type' });
      put('kind', b.kind);
    }
    if (b.payeeDefault !== undefined) put('payee_default', String(b.payeeDefault ?? '').trim() || null);
    if (b.defaultFeeCents !== undefined || b.w9OnFile !== undefined || b.active !== undefined) {
      if (!mayEditFee(ctx.caps)) return reply.code(403).send({ error: 'Only sales managers and money roles can change that.' });
      if (b.defaultFeeCents !== undefined) put('default_fee_cents', b.defaultFeeCents === null ? null : Math.max(0, Math.round(Number(b.defaultFeeCents))));
      if (b.w9OnFile !== undefined) put('w9_on_file', b.w9OnFile ? 1 : 0);
      if (b.active !== undefined) put('active', b.active ? 1 : 0);
    }
    if (!sets.length) return { ok: true };
    await texec(cid, `UPDATE referrers SET ${sets.join(', ')} WHERE id = ?`, [...vals, id]);
    await audit(cid, actorFrom(req), { entity: 'referrer', entityId: id, action: 'referrer_changed', area: 'Lead',
      label: 'Referrer changed', changes: Object.keys(b).map(k => ({ field: k, from: null, to: k === 'defaultFeeCents' ? 'changed' : String(b[k]) })) });
    return { ok: true };
  });

  /**
   * The fee on one referral lead: Fee / No fee, the amount, the payee (dealer),
   * and the total-loss decision. After the lead is written, sales managers and
   * money roles only. Never once it is paid.
   */
  app.patch('/api/leads/:id/referral', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    const cid = ctx.company!.id, id = Number((req.params as { id: string }).id);
    const b = (req.body ?? {}) as { referrerId?: number; noFee?: boolean; feeCents?: number; payee?: string | null; tlDecision?: 'pay' | 'none' };
    const [cur] = await referrals(cid, 'l.id = ?', [id]);
    const lead = await tqOne<RowDataPacket>(cid, 'SELECT id, referrer_id, lead_number FROM leads WHERE id = ?', [id]);
    if (!lead) return reply.code(404).send({ error: 'No such lead' });
    if (cur?.state.key === 'paid') return reply.code(409).send({ error: 'That referral has been paid. It cannot be changed.' });
    const sets: string[] = [], vals: unknown[] = [], notes: string[] = [];
    if (b.referrerId !== undefined) {
      if (!ctx.caps.manageLeads) return reply.code(403).send({ error: 'Not permitted' });
      if (!(await referrerById(cid, Number(b.referrerId)))) return reply.code(400).send({ error: 'No such referrer' });
      sets.push('referrer_id = ?'); vals.push(Number(b.referrerId)); notes.push('Referrer changed');
    }
    if (b.noFee !== undefined || b.feeCents !== undefined || b.payee !== undefined || b.tlDecision !== undefined) {
      if (!mayEditFee(ctx.caps)) return reply.code(403).send({ error: 'Only sales managers and money roles can change the fee.' });
    }
    if (b.noFee !== undefined) { sets.push('referral_no_fee = ?'); vals.push(b.noFee ? 1 : 0); notes.push(b.noFee ? 'Referral set to no fee' : 'Referral fee switched on'); }
    if (b.feeCents !== undefined) { sets.push('referral_fee_cents = ?'); vals.push(Math.max(0, Math.round(Number(b.feeCents) || 0))); notes.push('Referral fee changed'); }
    if (b.payee !== undefined) { sets.push('referral_payee = ?'); vals.push(String(b.payee ?? '').trim() || null); notes.push('Referral payee changed'); }
    if (b.tlDecision !== undefined) {
      if (b.tlDecision !== 'pay' && b.tlDecision !== 'none') return reply.code(400).send({ error: 'Pick one.' });
      if (!cur || cur.state.key !== 'held') return reply.code(409).send({ error: 'Only a total loss waiting on a decision can be decided.' });
      sets.push('referral_tl_decision = ?', 'referral_tl_by = ?', 'referral_tl_at = NOW()'); vals.push(b.tlDecision, ctx.user.name);
      notes.push(b.tlDecision === 'pay' ? 'Total loss: referral fee to be paid' : 'Total loss: no referral fee');
    }
    if (!sets.length) return { ok: true };
    await texec(cid, `UPDATE leads SET ${sets.join(', ')} WHERE id = ?`, [...vals, id]);
    await texec(cid, `INSERT INTO lead_events (lead_id, kind, body, user_id, user_name) VALUES (?, 'auto', ?, ?, ?)`,
      [id, notes.join('. ') + '.', ctx.user.id, ctx.user.name]);
    await audit(cid, actorFrom(req), { entity: 'lead', entityId: id, action: 'referral_changed', area: 'Money',
      label: `Referral on lead ${lead.lead_number}`, changes: notes.map(n => ({ field: 'Referral', from: null, to: n })) });
    return { ok: true };
  });

  /**
   * The payout list: one line per referral. Owed (earned, not paid), held
   * total losses, and what was paid recently. Money roles only.
   */
  app.get('/api/referrals/payouts', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (!ctx.caps.money) return reply.code(403).send({ error: 'Not permitted' });
    const cid = ctx.company!.id;
    const list = await referrals(cid, `(l.referral_no_fee = 0 OR l.id IN (SELECT lead_id FROM referral_payouts))
      AND (p.id IS NULL OR p.paid_at >= DATE_SUB(NOW(), INTERVAL 90 DAY))`, []);
    const keep = list.filter(r => ['owed', 'held', 'paid'].includes(r.state.key));
    const w9: Record<number, boolean> = {};
    for (const id of [...new Set(keep.map(r => r.referrer_id))]) {
      const f = await referrerById(cid, id);
      const t = await yearTotals(cid, id);
      w9[id] = !f?.w9_on_file && t.paidCents + t.owedCents > W9_LIMIT_CENTS;
    }
    return {
      lines: keep.map(r => ({
        leadId: r.lead_id, leadNumber: r.lead_number, customer: r.customer, vehicle: r.vehicle,
        roId: r.ro_id, roNumber: r.ro_number, referrerId: r.referrer_id, referrer: r.referrer_name, kind: r.referrer_kind,
        payee: r.state.payee, feeCents: r.state.feeCents, state: r.state.key, label: r.state.label,
        earnedAt: r.state.earnedAt, payDate: r.state.payDate, paidAt: r.paid_at, method: r.paid_method, reference: r.paid_reference,
        w9Warn: !!w9[r.referrer_id]
      })).sort((a, b) => String(a.payDate ?? '9999').localeCompare(String(b.payDate ?? '9999')))
    };
  });

  app.post('/api/referrals/:leadId/paid', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (!ctx.caps.money) return reply.code(403).send({ error: 'Not permitted' });
    const cid = ctx.company!.id, id = Number((req.params as { leadId: string }).leadId);
    const b = (req.body ?? {}) as { method?: string; reference?: string; note?: string };
    const [r] = await referrals(cid, 'l.id = ?', [id]);
    if (!r) return reply.code(404).send({ error: 'No such referral' });
    if (r.state.key !== 'owed') return reply.code(409).send({ error: `Not payable: ${r.state.label}.` });
    if (!r.state.feeCents) return reply.code(400).send({ error: 'The fee is $0. Set the amount on the lead first.' });
    await texec(cid, `
      INSERT INTO referral_payouts (lead_id, referrer_id, ro_id, amount_cents, payee, earned_at, pay_date, method, reference, note, paid_by, paid_by_name)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, r.referrer_id, r.ro_id, r.state.feeCents, r.state.payee, r.state.earnedAt, r.state.payDate,
       String(b.method ?? '').slice(0, 40) || null, String(b.reference ?? '').slice(0, 60) || null,
       String(b.note ?? '').slice(0, 255) || null, ctx.user.id, ctx.user.name]);
    await audit(cid, actorFrom(req), { entity: 'lead', entityId: id, action: 'referral_paid', area: 'Money',
      label: `Referral fee paid — lead ${r.lead_number}`, changes: [{ field: 'Paid to', from: null, to: r.state.payee }] });
    return { ok: true };
  });
}
