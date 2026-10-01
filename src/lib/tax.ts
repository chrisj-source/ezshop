import { RowDataPacket } from 'mysql2/promise';
import { mqOne } from '../db/master';
import { texec, tqOne } from '../db/tenant';

/**
 * Sales tax, per shop: the rate and what it applies to.
 *
 * States differ on what a repair's tax falls on. Arkansas and Kansas tax the
 * whole repair; Texas taxes parts and paint/materials, not labor. Until
 * 1 Oct 2026 there was one rate applied to the whole approval everywhere, which
 * over-taxed a Texas shop's labor wherever the figure was used (sales pay's tax
 * deduction). Each shop now ticks the categories; a shop that has never saved
 * them gets its state's preset.
 */

export type TaxPart = 'parts' | 'materials' | 'labor' | 'sublet';
export const TAX_PARTS: TaxPart[] = ['parts', 'materials', 'labor', 'sublet'];

/** Presets by state. Anything not listed starts as "everything" — check it. */
export const STATE_PRESETS: Record<string, TaxPart[]> = {
  TX: ['parts', 'materials'],
  AR: ['parts', 'materials', 'labor', 'sublet'],
  KS: ['parts', 'materials', 'labor', 'sublet']
};

export interface TaxRule { rate: number; applies: TaxPart[]; preset: boolean; state: string | null }

async function get(companyId: number, key: string): Promise<string | null> {
  const r = await tqOne<RowDataPacket & { setting_value: string }>(companyId,
    'SELECT setting_value FROM shop_settings WHERE setting_key = ?', [key]).catch(() => null);
  return r ? r.setting_value : null;
}

export async function taxRule(companyId: number): Promise<TaxRule> {
  const rate = Number(await get(companyId, 'sales_tax_rate') ?? 0) || 0;
  const raw = await get(companyId, 'sales_tax_applies');
  const co = await mqOne<RowDataPacket & { state: string | null }>('SELECT state FROM companies WHERE id = ?', [companyId]);
  const state = co?.state ? String(co.state).toUpperCase() : null;
  if (raw) {
    const list = String(raw).split(',').map(s => s.trim()).filter((s): s is TaxPart => TAX_PARTS.includes(s as TaxPart));
    return { rate, applies: list, preset: false, state };
  }
  return { rate, applies: (state && STATE_PRESETS[state]) || TAX_PARTS.slice(), preset: true, state };
}

export async function saveTaxRule(companyId: number, rate: number, applies: TaxPart[]): Promise<void> {
  const clean = TAX_PARTS.filter(p => applies.includes(p));
  for (const [k, v] of [['sales_tax_rate', String(rate)], ['sales_tax_applies', clean.join(',')]]) {
    await texec(companyId, `INSERT INTO shop_settings (setting_key, setting_value) VALUES (?, ?)
      ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)`, [k, v]);
  }
}

/** The pieces of a file the tax can fall on, in cents. */
export interface TaxBase { approval: number; parts: number; materials: number; sublet: number }

/**
 * Tax on a file. Everything ticked is the old figure, approval × rate,
 * unchanged. Otherwise the ticked pieces are summed; labor is what is left of
 * the approval once parts, materials and sublet are out.
 */
export function taxOn(rule: TaxRule, b: TaxBase): number {
  if (!rule.rate || !rule.applies.length) return 0;
  if (TAX_PARTS.every(p => rule.applies.includes(p))) return Math.round(b.approval * (rule.rate / 100));
  const labor = Math.max(0, b.approval - b.parts - b.materials - b.sublet);
  const base = (rule.applies.includes('parts') ? b.parts : 0)
    + (rule.applies.includes('materials') ? b.materials : 0)
    + (rule.applies.includes('sublet') ? b.sublet : 0)
    + (rule.applies.includes('labor') ? labor : 0);
  return Math.round(base * (rule.rate / 100));
}

/** Parts at their sale price on the file — what the customer is charged and taxed on. */
export async function partsSaleCents(companyId: number, roId: number, fallback: number): Promise<number> {
  const r = await tqOne<RowDataPacket & { c: number | null }>(companyId, `
    SELECT SUM(price_cents * qty) AS c FROM parts_lines WHERE ro_id = ? AND state <> 'not_needed'`, [roId]).catch(() => null);
  const c = Number(r?.c ?? 0);
  return c > 0 ? c : fallback;
}
