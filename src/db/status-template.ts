/**
 * The platform status template, ported from the Status Setup design.
 *
 * slot_id is canonical and never changes — automations, reports and the
 * notification router all bind to it. `label` is what a shop may rename.
 */

export type Kind = 'milestone' | 'queue' | 'active' | 'complete';

/** [slot, label, customer label, kind, owner_role, age yellow, age red, follow-up, module] */
export type SlotRow = [string, string, string, Kind, string, string, string, string, string];

export interface LaneDef { key: string; name: string; gate: 'yes' | 'warn' | 'no'; owner: string; mod: string; }

export const LANES: LaneDef[] = [
  { key: 'pdr',        name: 'PDR',        gate: 'yes', owner: 'pdr tech',    mod: 'pdr' },
  { key: 'body',       name: 'Body',       gate: 'yes', owner: 'body tech',   mod: 'body' },
  { key: 'prep',       name: 'Prep',       gate: 'no',  owner: 'paint tech',  mod: 'refinish' },
  { key: 'paint',      name: 'Paint',      gate: 'no',  owner: 'paint tech',  mod: 'refinish' },
  { key: 'reassembly', name: 'Reassembly', gate: 'yes', owner: 'r&i tech',    mod: 'body' },
  { key: 'sublet',     name: 'Sublet',     gate: 'no',  owner: 'parts manager', mod: 'sublet' },
  { key: 'buff',       name: 'Buff',       gate: 'no',  owner: 'paint tech',  mod: 'refinish' },
  { key: 'detail',     name: 'Detail',     gate: 'no',  owner: 'detail tech', mod: 'detail' }
];

/** Where the supplement checkpoint sits inside a lane: index into [awaiting, working, complete] */
const SUPP_AT: Record<string, number> = { pdr: 3, body: 2, paint: 1, reassembly: 2 };

export const LANE_GROUPS = [
  { id: 'pdr',        name: 'PDR',        lanes: ['pdr'],           note: 'The PDR path. Dent work by panel; a car that outgrows it moves to Body with a reason.' },
  { id: 'body',       name: 'Body',       lanes: ['body'],          note: 'Conventional repair. Gated on parts by default.' },
  { id: 'refinish',   name: 'Refinish',   lanes: ['prep', 'paint'], note: 'Prep and paint share a group and a department but keep separate lanes, so a car can sit in prep without blocking the booth.' },
  { id: 'reassembly', name: 'Reassembly', lanes: ['reassembly'],    note: 'Gated on parts — this is where a missing clip stops the file.' },
  { id: 'sublet',     name: 'Sublet',     lanes: ['sublet'],        note: 'A car out at a vendor. The lane says where the car is; the sublet lines on the file say what is owed and to whom.' },
  { id: 'buff',       name: 'Buff',       lanes: ['buff'],          note: '' },
  { id: 'detail',     name: 'Detail',     lanes: ['detail'],        note: '' }
];

const G_INTAKE = {
  id: 'intake', name: 'Intake and authorization',
  note: 'Repair path is selected here — PDR or conventional. The choice seeds the assessment lane and the default production lane order.',
  slots: [
    ['intake.arrived', 'Vehicle Arrived', 'Your vehicle is at the shop', 'milestone', 'front office', '12h', '24h', '', ''],
    ['intake.auth', 'Customer Auth Acquired', 'Repair authorized', 'queue', 'front office', '1d', '2d', '24h', ''],
    ['intake.claim', 'Claim Info Verified', 'Claim details confirmed', 'queue', 'front office', '1d', '2d', '24h', 'insurance']
  ] as SlotRow[]
};

const G_ASSESS = {
  id: 'assess', name: 'Scope, teardown and estimate',
  note: 'Assessment runs once, routed by repair path — scope on the PDR path, teardown on the conventional one. Supplements reuse the same send, approve and review states; a return to teardown is an exception transition that needs a reason.',
  slots: [
    ['assess.awaiting', 'Awaiting Assessment', 'In line for assessment', 'queue', 'production manager', '1d', '2d', '', ''],
    ['assess.scope.awaiting', 'Awaiting Scope', 'In line for assessment', 'queue', 'estimator', '1d', '2d', '', 'pdr'],
    ['assess.scope.working', 'Scoping', 'Being assessed', 'active', 'estimator', '1d', '2d', '', 'pdr'],
    ['assess.scope.complete', 'Scope Complete', 'Assessment done', 'complete', 'estimator', '12h', '24h', '', 'pdr'],
    ['assess.teardown.awaiting', 'Awaiting Teardown', 'In line for teardown', 'queue', 'body tech', '1d', '2d', '', 'body'],
    ['assess.teardown.working', 'In Teardown', 'Being taken apart', 'active', 'body tech', '2d', '3d', '', 'body'],
    ['assess.teardown.complete', 'Teardown Complete', 'Teardown done', 'complete', 'body tech', '12h', '24h', '', 'body'],
    ['est.needed', 'Estimate / Supplement Needed', 'Estimate being written', 'queue', 'estimator', '1d', '2d', '', ''],
    ['est.sent', 'Estimate / Supplement Sent', 'Estimate submitted', 'queue', 'estimator', '8h', '24h', '8h', 'insurance'],
    ['est.awaiting', 'Awaiting Approval', 'Waiting on approval', 'queue', 'estimator', '2d', '4d', '24h', 'insurance'],
    ['est.approved', 'Estimate / Supplement Approved', 'Estimate approved', 'milestone', 'system', '', '', '', ''],
    ['est.review', 'Estimate Review', 'Repair plan being set', 'active', 'estimator', '12h', '24h', '', '']
  ] as SlotRow[]
};

const G_PARTS = {
  id: 'parts', name: 'Parts',
  note: 'Parts run before the first production lane and stay live for the rest of the file — a supplement sends it back to Parts Needed. Any lane with its gate on waits here.',
  slots: [
    ['parts.needed', 'Parts Needed', 'Parts being sourced', 'queue', 'parts', '12h', '1d', '', ''],
    ['parts.ordered', 'Parts Ordered', 'Parts on order', 'queue', 'parts', '1d', '2d', '24h', ''],
    ['parts.awaiting', 'Awaiting Parts', 'Waiting on parts', 'queue', 'parts', '2d', '5d', '24h', ''],
    ['parts.backordered', 'Parts Backordered', 'Parts delayed', 'queue', 'parts', '2d', '4d', '24h', '']
  ] as SlotRow[]
};

const G_TAIL = [
  {
    id: 'qa', name: 'Wash and QC',
    note: 'Initial wash and QC run before the vehicle is called ready; final detail and final QC run after any rework.',
    slots: [
      ['qa.wash', 'Initial Wash', 'Being washed', 'active', 'detail tech', '12h', '1d', '', 'detail'],
      ['qa.qc', 'QC', 'In quality check', 'queue', 'production manager', '12h', '1d', '', ''],
      ['qa.detail', 'Final Detail', 'Being detailed', 'active', 'detail tech', '1d', '2d', '', 'detail'],
      ['qa.qc.final', 'Final QC', 'Final quality check', 'queue', 'production manager', '12h', '1d', '', '']
    ] as SlotRow[]
  },
  {
    id: 'ready', name: 'Ready', note: '',
    slots: [
      ['ready.payment', 'Payment Verified', 'Payment confirmed', 'queue', 'front office', '1d', '2d', '', ''],
      ['ready.contacted', 'Customer Contacted', 'We called you', 'queue', 'front office', '12h', '1d', '24h', ''],
      ['ready.scheduled', 'Customer Scheduled', 'Pickup scheduled', 'milestone', 'front office', '1d', '2d', '', ''],
      ['ready.vehicle', 'Vehicle Ready', 'Ready for pickup', 'complete', 'front office', '1d', '3d', '48h', '']
    ] as SlotRow[]
  },
  {
    id: 'deliver', name: 'Delivered',
    note: 'Delivery and close out. Paperwork and file close sit outside cycle time.',
    slots: [
      ['deliver.payment', 'Payment Collected', 'Payment received', 'queue', 'front office', '1d', '2d', '', ''],
      ['deliver.pickup', 'Picked Up', 'Vehicle delivered', 'milestone', 'front office', '2d', '4d', '', ''],
      ['close.paperwork', 'Paperwork Verified', '', 'queue', 'front office', '2d', '5d', '', ''],
      ['close.file', 'File Closed', '', 'complete', 'front office', '3d', '7d', '', '']
    ] as SlotRow[]
  }
];

/**
 * Sublet does not follow the awaiting / working / complete shape: a car waits to
 * go, goes, is worked on, and then rests until somebody moves it along. At
 * Sublet is the one lane status that does not count toward cycle time — the car
 * is off site and the day is not the shop's.
 */
const SUBLET_SLOTS: SlotRow[] = [
  ['lane.sublet.awaiting', 'Awaiting Sublet', 'Waiting on outside work', 'queue', 'parts manager', '1d', '2d', '', 'sublet'],
  ['lane.sublet.at', 'At Sublet', 'Out for outside work', 'queue', 'parts manager', '2d', '4d', '', 'sublet'],
  ['lane.sublet.working', 'Working Sublet', 'Outside work under way', 'active', 'parts manager', '2d', '4d', '', 'sublet'],
  ['lane.sublet.complete', 'Sublet Complete', 'Outside work done', 'complete', 'parts manager', '1d', '2d', '', 'sublet']
];

/** Statuses that do not count toward cycle time, by slot. */
export const OFF_CLOCK_SLOTS = ['lane.sublet.at'];

function laneSlots(key: string): SlotRow[] {
  if (key === 'sublet') return SUBLET_SLOTS;
  const l = LANES.find(x => x.key === key)!;
  const base: SlotRow[] = [
    [`lane.${key}.awaiting`, `Awaiting ${l.name}`, `In line for ${l.name.toLowerCase()}`, 'queue', l.owner, '1d', '2d', '', l.mod],
    [`lane.${key}.working`, `Working ${l.name}`, `${l.name} in progress`, 'active', l.owner, '2d', '4d', '', l.mod],
    [`lane.${key}.complete`, `${l.name} Complete`, `${l.name} done`, 'complete', l.owner, '12h', '24h', '', l.mod]
  ];
  const at = SUPP_AT[key];
  if (at === undefined) return base;
  const p = `lane.${key}.supp.`;
  const cp: SlotRow[] = [
    [`${p}needed`, 'Supplement Needed', 'Additional work found', 'active', 'estimator', '12h', '1d', '', 'insurance'],
    [`${p}sent`, 'Supplement Sent', 'Submitted to insurance', 'queue', 'estimator', '8h', '24h', '8h', 'insurance'],
    [`${p}approved`, 'Supplement Approved', 'Approved', 'milestone', 'system', '', '', '', 'insurance']
  ];
  return [...base.slice(0, at), ...cp, ...base.slice(at)];
}

export type ShopType = 'pdr' | 'collision' | 'both' | 'detail';

/** Which lanes a shop type starts with, and whether it deals with insurance. */
export const TEMPLATES: Record<ShopType, { lanes: string[]; insurance: boolean }> = {
  pdr:       { lanes: ['pdr', 'sublet', 'detail'], insurance: true },
  collision: { lanes: ['body', 'prep', 'paint', 'reassembly', 'sublet', 'buff', 'detail'], insurance: true },
  both:      { lanes: ['pdr', 'body', 'prep', 'paint', 'reassembly', 'sublet', 'buff', 'detail'], insurance: true },
  detail:    { lanes: ['detail'], insurance: false }
};

export interface SeedGroup { id: string; name: string; note: string; laneKey: string | null; slots: SlotRow[]; }

/** Build the full status list for a shop type, in board order. */
export function buildTemplate(shopType: ShopType): { groups: SeedGroup[]; lanes: LaneDef[] } {
  const t = TEMPLATES[shopType];
  const keep = (rows: SlotRow[]) => rows.filter(r => !(r[8] === 'insurance' && !t.insurance));

  const groups: SeedGroup[] = [
    { id: G_INTAKE.id, name: G_INTAKE.name, note: G_INTAKE.note, laneKey: null, slots: keep(G_INTAKE.slots) },
    { id: G_ASSESS.id, name: G_ASSESS.name, note: G_ASSESS.note, laneKey: null, slots: keep(G_ASSESS.slots) },
    { id: G_PARTS.id, name: G_PARTS.name, note: G_PARTS.note, laneKey: null, slots: keep(G_PARTS.slots) }
  ];

  const seen = new Set<string>();
  for (const key of t.lanes) {
    const lg = LANE_GROUPS.find(g => g.lanes.includes(key));
    if (!lg || seen.has(lg.id)) continue;
    seen.add(lg.id);
    const live = lg.lanes.filter(k => t.lanes.includes(k));
    const slots = live.flatMap(k => laneSlots(k));
    groups.push({ id: `lane_${lg.id}`, name: lg.name, note: lg.note, laneKey: live[0], slots: keep(slots) });
  }

  for (const g of G_TAIL) groups.push({ id: g.id, name: g.name, note: g.note, laneKey: null, slots: keep(g.slots) });

  return { groups, lanes: LANES.filter(l => t.lanes.includes(l.key)) };
}

/** '12h' | '2d' | '' -> hours */
export function toHours(v: string): number | null {
  if (!v) return null;
  const m = /^(\d+)([hd])$/.exec(v.trim());
  if (!m) return null;
  return m[2] === 'd' ? Number(m[1]) * 24 : Number(m[1]);
}

/** Groups the notification router ships with. */
export const NOTIF_GROUPS: Array<{ name: string; note: string; positions: string[]; events: string[] }> = [
  { name: 'Parts desk',      note: 'Anything that moves a part',        positions: ['parts'],           events: ['parts.arrived', 'parts.late', 'status.change'] },
  { name: 'Front office',    note: 'Customer-facing traffic',           positions: ['office', 'sales'], events: ['sms.reply', 'status.change'] },
  { name: 'PDR bench',       note: 'Dent lanes only',                   positions: ['pdr'],             events: ['assign.file', 'status.change'] },
  { name: 'Body shop',       note: 'Disassembly, body, awaiting body',  positions: ['body'],            events: ['assign.file', 'status.change'] },
  { name: 'Paint and buff',  note: 'Prep, paint, buff',                 positions: ['paint'],           events: ['assign.file', 'status.change'] },
  { name: 'Reassembly',      note: 'R&I lanes only',                    positions: ['ri'],              events: ['assign.file', 'status.change'] },
  { name: 'Detail and wash', note: 'Wash, final detail',                positions: ['detail'],          events: ['assign.file'] },
  { name: 'Estimating',      note: 'Insurance decisions and stalls',    positions: ['est'],             events: ['supp.decision', 'age.red', 'status.change'] },
  { name: 'Owner escalation',note: 'Only what is stuck',                positions: ['prod'],            events: ['age.red'] }
];
