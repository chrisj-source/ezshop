/**
 * What the shop made on the car.
 *
 * All of it happens here, on the server, for one reason: these figures are owner
 * and accounting only. Nothing is computed in the browser, so a person who may
 * not see the profit never receives the pieces it is made of either.
 *
 * The shape of the arithmetic:
 *
 *   approval
 *     − deductible not collected     (set on the file, not at close)
 *     − promises                     (anything else given away)
 *     − rental the shop carries      (nil when the policy covers it)
 *     − parts cost
 *     − labour, one line per assigned trade
 *     − paint materials
 *     − sublet
 *     − sales pay                    (only when marked payable on this file)
 *   = profit, and profit as a share of the approval
 *
 * PDR is the odd one: it can be a share rather than a figure, and that share can
 * be taken off the approval or off what is left once everything else is paid. It
 * is therefore always calculated last.
 */

import { RowDataPacket } from 'mysql2/promise';
import { tq, tqOne, texec } from '../db/tenant';
import { loadPlan } from './pay';

/** The trades a close-out sheet can ask about, in the order it lists them. */
export const LABOUR_TRADES = ['pdr', 'body', 'paint', 'ri', 'detail'] as const;
export type Trade = typeof LABOUR_TRADES[number];

export type Basis = 'hours' | 'flat' | 'ems' | 'pct';

/** Rental providers, alphabetical, with the shop's own loaner last. */
export const RENTAL_PROVIDERS = ['Avis', 'Budget', 'Enterprise', 'Hertz', 'Loaner'];

export interface LabourEntry {
  positionKey: Trade;
  basis: Basis;
  hours: number;
  rateCents: number;
  ratePct: number;
  pctAfterCosts: boolean;
  costCents: number;
  userId: number | null;
  displayName: string | null;
}

interface FileRow extends RowDataPacket {
  id: number;
  ro_number: string;
  amount_cents: number;
  parts_cost_cents: number;
  sublet_cost_cents: number;
  rental_cost_cents: number;
  rental_provider: string | null;
  rental_covered: number;
  towing_cost_cents: number;
  materials_cost_cents: number;
  materials_flat_cents: number;
  discount_cents: number;
  shortpay_cents: number;
  deductible_cents: number;
  deductible_collect: number;
  deductible_charge_cents: number;
  commission_payable: number;
  total_loss_at: Date | null;
  labor_hours: string;
}

export interface Assigned { positionKey: string; userId: number | null; name: string | null }

async function setting(companyId: number, key: string, fallback: number): Promise<number> {
  const row = await tqOne<RowDataPacket & { setting_value: string }>(companyId,
    'SELECT setting_value FROM shop_settings WHERE setting_key = ?', [key]).catch(() => null);
  const n = Number(row?.setting_value);
  return Number.isFinite(n) ? n : fallback;
}

export async function fileFor(companyId: number, roId: number): Promise<FileRow | null> {
  return tqOne<FileRow>(companyId, `
    SELECT id, ro_number, amount_cents, parts_cost_cents, sublet_cost_cents,
           rental_cost_cents, rental_provider, rental_covered, towing_cost_cents,
           materials_cost_cents, materials_flat_cents, discount_cents, shortpay_cents,
           deductible_cents, deductible_collect, deductible_charge_cents,
           commission_payable, total_loss_at, labor_hours
    FROM repair_orders WHERE id = ?`, [roId]);
}

/** Who is on the car. The close-out sheet is generated from exactly this. */
export async function assignmentsFor(companyId: number, roId: number): Promise<Assigned[]> {
  const rows = await tq<Array<RowDataPacket & { position_key: string; user_id: number | null; display_name: string | null }>>(
    companyId,
    'SELECT position_key, user_id, display_name FROM ro_assignments WHERE ro_id = ?', [roId]);
  return rows
    .filter(r => r.user_id !== null || (r.display_name && r.display_name.trim()))
    .map(r => ({ positionKey: r.position_key, userId: r.user_id, name: r.display_name }));
}

/** The rate a tech is on, and how they are paid. */
export async function ratesFor(companyId: number, userIds: number[]): Promise<Map<number, {
  basis: 'hourly' | 'flat' | 'pct'; rateCents: number; ratePct: number; name: string;
}>> {
  if (!userIds.length) return new Map();
  const rows = await tq<Array<RowDataPacket & {
    user_id: number; display_name: string; pay_basis: 'hourly' | 'flat' | 'pct';
    rate_cents: number; rate_pct: string;
  }>>(companyId, `
    SELECT user_id, display_name, pay_basis, rate_cents, rate_pct
    FROM staff WHERE user_id IN (${userIds.map(() => '?').join(',')})`, userIds);
  return new Map(rows.map(r => [r.user_id, {
    basis: r.pay_basis, rateCents: Number(r.rate_cents), ratePct: Number(r.rate_pct),
    name: r.display_name
  }]));
}

/**
 * Hours the EMS import brought over, per trade. Nothing to pull is a real answer.
 *
 * Estimating systems name labour by their own codes, so they are mapped onto the
 * shop's trades here — frame work is body work, refinish is paint. Only the last
 * accepted import counts; a pending one has not been agreed to yet.
 */
export async function emsHoursFor(companyId: number, roId: number): Promise<Record<string, number>> {
  const rows = await tq<Array<RowDataPacket & { labor_type: string | null; hours: string }>>(companyId, `
    SELECT l.labor_type, SUM(l.labor_hours) AS hours
    FROM ems_import_lines l
    JOIN ems_imports i ON i.id = l.import_id
    WHERE i.matched_ro_id = ? AND i.state = 'accepted' AND l.labor_hours > 0
      AND i.id = (SELECT MAX(i2.id) FROM ems_imports i2
                   WHERE i2.matched_ro_id = ? AND i2.state = 'accepted')
    GROUP BY l.labor_type`, [roId, roId]).catch(() => []);

  const out: Record<string, number> = {};
  for (const r of rows) {
    const trade = tradeForLabourCode(r.labor_type);
    if (!trade) continue;
    out[trade] = (out[trade] ?? 0) + (Number(r.hours) || 0);
  }
  return out;
}

/** An estimating system's labour code, in the shop's own terms. */
export function tradeForLabourCode(code: string | null): Trade | null {
  const c = (code ?? '').toUpperCase().replace(/[^A-Z]/g, '');
  if (!c) return null;
  if (/^(RFN|REF|PNT|PAINT|P)$/.test(c)) return 'paint';
  if (/^(BDY|BODY|SHT|SHEET|FRM|FRAME|STR|B)$/.test(c)) return 'body';
  if (/^(RI|RANDI|REMOVE)$/.test(c)) return 'ri';
  if (/^(PDR|DENT|D)$/.test(c)) return 'pdr';
  if (/^(DET|DETAIL|CLN)$/.test(c)) return 'detail';
  /* Mechanical, glass and the rest are sublet or nobody's hours — deliberately
     unmapped rather than guessed onto a trade that would then be paid for them. */
  return null;
}

export interface CostLine { key: string; label: string; note: string; cents: number }

export interface Profit {
  approvalCents: number;
  lines: CostLine[];
  labourCents: number;
  materialsCents: number;
  rentalCents: number;
  salesPayCents: number;
  deductibleGivenCents: number;
  profitCents: number;
  profitPct: number;
  thin: boolean;
}

/** What the customer is not paying of their own deductible. */
export function deductibleGiven(f: FileRow): number {
  const owed = Number(f.deductible_cents) || 0;
  if (!f.deductible_collect) return owed;
  return Math.max(0, owed - (Number(f.deductible_charge_cents) || 0));
}

/** A covered rental is reimbursed, so the shop only carries an uncovered one. */
export function rentalCarried(f: FileRow): number {
  return f.rental_covered ? 0 : Number(f.rental_cost_cents) || 0;
}

/**
 * Price one trade's entry. `hours` and `ems` both come out as hours × rate; the
 * difference is only where the hours came from, which the row records.
 */
export function priceEntry(
  entry: { basis: Basis; hours: number; rateCents: number },
): number {
  if (entry.basis === 'flat') return Math.round(entry.hours);
  return Math.round((Number(entry.hours) || 0) * (Number(entry.rateCents) || 0));
}

/**
 * The whole sheet. `entries` is what the desk has punched in — pass the saved
 * rows to read a closed file, or the unsaved ones to preview before closing.
 */
export async function profitFor(
  companyId: number,
  roId: number,
  entries: LabourEntry[]
): Promise<Profit | null> {
  const f = await fileFor(companyId, roId);
  if (!f) return null;

  const approval = Number(f.amount_cents) || 0;
  const given = deductibleGiven(f);
  const rental = rentalCarried(f);
  const matRate = await setting(companyId, 'materials_rate_cents', 4200);
  const thinPct = await setting(companyId, 'thin_profit_pct', 25);

  const byTrade = new Map<string, LabourEntry>(entries.map(e => [e.positionKey, e]));
  const paint = byTrade.get('paint');
  /* Paint hours drive materials. A painter on a flat dollar leaves no hours to
     work from, so the file's own flat figure is used instead. */
  const paintHours = paint && paint.basis !== 'flat' ? Number(paint.hours) || 0 : 0;
  const materials = paint
    ? (paintHours > 0 ? Math.round(paintHours * matRate) : Number(f.materials_flat_cents) || 0)
    : 0;

  /* Everything except PDR, which is a share of what is left and so goes last. */
  let labour = 0;
  const labourLines: CostLine[] = [];
  for (const trade of LABOUR_TRADES) {
    if (trade === 'pdr') continue;
    const e = byTrade.get(trade);
    if (!e) continue;
    labour += e.costCents;
    labourLines.push({
      key: trade,
      label: TRADE_LABEL[trade] + ' cost',
      note: (e.displayName ?? 'Unassigned') +
        (e.basis === 'flat' ? ' — flat' : ` — ${e.hours} hours` + (e.basis === 'ems' ? ', pulled from the estimate' : '')),
      cents: e.costCents
    });
  }

  const pdr = byTrade.get('pdr');
  let pdrCents = 0;
  if (pdr) {
    if (pdr.basis === 'pct') {
      const pct = (Number(pdr.ratePct) || 0) / 100;
      const base = pdr.pctAfterCosts
        ? Math.max(0, approval - given - rental - Number(f.parts_cost_cents) -
            Number(f.sublet_cost_cents) - materials - labour)
        : approval;
      pdrCents = Math.round(base * pct);
    } else {
      pdrCents = pdr.costCents;
    }
    labour += pdrCents;
  }

  /* Sales pay: only when someone is on it and the commission is marked payable
     on this file. A totalled car pays the total-loss amount instead, and that is
     the pay ledger's business, not the profit sheet's. */
  const sales = (await assignmentsFor(companyId, roId)).find(a => a.positionKey === 'sales');
  let salesPay = 0;
  let salesNote = '';
  if (sales && sales.userId && f.commission_payable && !f.total_loss_at) {
    const plan = await loadPlan(companyId, sales.userId);
    if (plan && plan.active) {
      if (plan.mode === 'flat') {
        salesPay = Math.round(approval * (plan.rate_pct / 100));
        salesNote = `${sales.name} — ${plan.rate_pct}% of approval`;
      } else {
        const taxPct = await setting(companyId, 'sales_tax_rate', 0);
        let base = approval;
        for (const d of plan.deductions) {
          if (d === 'parts') base -= Number(f.parts_cost_cents) || 0;
          else if (d === 'sublet') base -= Number(f.sublet_cost_cents) || 0;
          else if (d === 'rental') base -= rental;
          else if (d === 'tax') base -= Math.round(approval * (taxPct / 100));
          else if (d === 'materials') base -= materials;
          else if (d === 'towing') base -= Number(f.towing_cost_cents) || 0;
          else if (d === 'discount') base -= given;
          else if (d === 'shortpay') base -= Number(f.shortpay_cents) || 0;
        }
        salesPay = Math.round(base * (plan.rate_pct / 100));
        salesNote = `${sales.name} — ${plan.rate_pct}% net of costs, marked payable on this file`;
      }
    }
  }

  const lines: CostLine[] = [];
  if (Number(f.deductible_cents) > 0) {
    lines.push({
      key: 'deductible', label: 'Deductible not collected', cents: given,
      note: f.deductible_collect
        ? `Owed ${usd(f.deductible_cents)}, charging ${usd(f.deductible_charge_cents)}`
        : `Not collecting the ${usd(f.deductible_cents)} at all`
    });
  }
  if (Number(f.discount_cents) > 0 && Number(f.deductible_cents) === 0) {
    lines.push({ key: 'promises', label: 'Promises', cents: Number(f.discount_cents), note: 'Given away on this car' });
  }
  lines.push({
    key: 'rental', label: 'Rental cost', cents: rental,
    note: f.rental_provider
      ? `${f.rental_provider} — ${f.rental_covered ? 'covered, so the shop carries none of it' : 'not covered, the shop carries it'}`
      : 'No rental on this file'
  });
  lines.push({
    key: 'parts', label: 'Parts cost', cents: Number(f.parts_cost_cents) || 0,
    note: 'What the shop paid, not what was billed'
  });

  if (pdr) {
    lines.push({
      key: 'pdr', label: 'PDR cost', cents: pdrCents,
      note: pdr.basis === 'pct'
        ? `${pdr.displayName ?? 'Unassigned'} — ${pdr.ratePct}% ${pdr.pctAfterCosts ? 'after costs' : 'of approval'}`
        : `${pdr.displayName ?? 'Unassigned'} — flat`
    });
  }
  lines.push(...labourLines);

  if (paint) {
    lines.push({
      key: 'materials', label: 'Paint materials', cents: materials,
      note: paintHours > 0
        ? `${paintHours} paint hours at ${usd(matRate)}/hr`
        : 'No paint hours — figure entered by hand'
    });
  }
  lines.push({ key: 'sublet', label: 'Sublet', cents: Number(f.sublet_cost_cents) || 0, note: 'Vendor invoices on this file' });
  if (salesPay) lines.push({ key: 'sales', label: 'Sales pay', cents: salesPay, note: salesNote });

  const profit = approval - lines.reduce((n, l) => n + l.cents, 0);
  const pct = approval ? (profit / approval) * 100 : 0;

  return {
    approvalCents: approval,
    lines,
    labourCents: labour,
    materialsCents: materials,
    rentalCents: rental,
    salesPayCents: salesPay,
    deductibleGivenCents: given,
    profitCents: profit,
    profitPct: Math.round(pct * 100) / 100,
    thin: pct < thinPct
  };
}

export const TRADE_LABEL: Record<string, string> = {
  pdr: 'PDR', body: 'Body', paint: 'Paint', ri: 'R&I', detail: 'Detail'
};

function usd(cents: number | string): string {
  return '$' + (Number(cents) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Read back what was punched in. */
export async function labourFor(companyId: number, roId: number): Promise<LabourEntry[]> {
  const rows = await tq<Array<RowDataPacket & {
    position_key: Trade; basis: Basis; hours: string; rate_cents: number; rate_pct: string;
    pct_after_costs: number; cost_cents: number; user_id: number | null; display_name: string | null;
  }>>(companyId, `
    SELECT position_key, basis, hours, rate_cents, rate_pct, pct_after_costs,
           cost_cents, user_id, display_name
    FROM ro_labour WHERE ro_id = ?`, [roId]);
  return rows.map(r => ({
    positionKey: r.position_key, basis: r.basis, hours: Number(r.hours),
    rateCents: Number(r.rate_cents), ratePct: Number(r.rate_pct),
    pctAfterCosts: !!r.pct_after_costs, costCents: Number(r.cost_cents),
    userId: r.user_id, displayName: r.display_name
  }));
}

/**
 * The sheet as it should first appear: a row for every assigned trade, on that
 * tech's own basis and rate, with hours pulled from the estimate where there are
 * any. Whatever the desk has already saved wins over the suggestion.
 */
export async function suggestLabour(companyId: number, roId: number): Promise<LabourEntry[]> {
  const assigned = await assignmentsFor(companyId, roId);
  const trades = assigned.filter(a => (LABOUR_TRADES as readonly string[]).includes(a.positionKey));
  if (!trades.length) return [];

  const rates = await ratesFor(companyId, trades.map(t => t.userId).filter((n): n is number => n !== null));
  const ems = await emsHoursFor(companyId, roId);
  const saved = new Map((await labourFor(companyId, roId)).map(e => [e.positionKey, e]));

  return LABOUR_TRADES.flatMap<LabourEntry>(trade => {
    const a = trades.find(t => t.positionKey === trade);
    if (!a) return [];
    const already = saved.get(trade);
    if (already) return [already];

    const r = a.userId ? rates.get(a.userId) : undefined;
    const emsHours = ems[trade] ?? 0;
    const basis: Basis = trade === 'pdr' && r?.basis === 'pct' ? 'pct'
      : r?.basis === 'flat' ? 'flat'
      : emsHours > 0 ? 'ems' : 'hours';
    const hours = basis === 'flat' ? (r?.rateCents ?? 0) : basis === 'ems' ? emsHours : 0;
    const rateCents = r?.rateCents ?? 0;

    const entry: LabourEntry = {
      positionKey: trade, basis, hours,
      rateCents: basis === 'flat' ? 0 : rateCents,
      ratePct: r?.ratePct ?? 0,
      pctAfterCosts: false,
      costCents: 0,
      userId: a.userId, displayName: a.name ?? r?.name ?? null
    };
    entry.costCents = basis === 'pct' ? 0 : priceEntry(entry);
    return [entry];
  });
}

/** Write the entries and the settled profit. Called as part of closing. */
export async function saveCloseout(
  companyId: number,
  roId: number,
  entries: LabourEntry[],
  actorId: number
): Promise<Profit | null> {
  await texec(companyId, 'DELETE FROM ro_labour WHERE ro_id = ?', [roId]);
  for (const e of entries) {
    await texec(companyId, `
      INSERT INTO ro_labour
        (ro_id, position_key, basis, hours, rate_cents, rate_pct, pct_after_costs,
         cost_cents, user_id, display_name, entered_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [roId, e.positionKey, e.basis, e.hours, e.rateCents, e.ratePct,
       e.pctAfterCosts ? 1 : 0, e.costCents, e.userId, e.displayName, actorId]);
  }

  const p = await profitFor(companyId, roId, entries);
  if (!p) return null;

  const pick = (key: string) => p.lines.find(l => l.key === key)?.cents ?? 0;
  await texec(companyId, `
    INSERT INTO ro_profit
      (ro_id, approval_cents, deductible_given_cents, promises_cents, rental_cents,
       parts_cents, labour_cents, materials_cents, sublet_cents, sales_pay_cents,
       profit_cents, profit_pct, settled_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      approval_cents = VALUES(approval_cents),
      deductible_given_cents = VALUES(deductible_given_cents),
      promises_cents = VALUES(promises_cents), rental_cents = VALUES(rental_cents),
      parts_cents = VALUES(parts_cents), labour_cents = VALUES(labour_cents),
      materials_cents = VALUES(materials_cents), sublet_cents = VALUES(sublet_cents),
      sales_pay_cents = VALUES(sales_pay_cents), profit_cents = VALUES(profit_cents),
      profit_pct = VALUES(profit_pct), settled_by = VALUES(settled_by)`,
    [roId, p.approvalCents, p.deductibleGivenCents, pick('promises'), p.rentalCents,
     pick('parts'), p.labourCents, p.materialsCents, pick('sublet'), p.salesPayCents,
     p.profitCents, p.profitPct, actorId]);

  return p;
}
