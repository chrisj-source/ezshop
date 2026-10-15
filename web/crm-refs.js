/* Leads › Referrers (7a), as mocked: KPI band, the referrer table, and the
   440px detail with fees, usual payee and the leads they sent. */
(function () {
  var C = window.CRM;
  var KINDS = { agent: 'Insurance agent', adjuster: 'Adjuster / carrier', dealer: 'Dealer', past_customer: 'Past customer' };
  var S = { type: 'all', q: '', sort: 'owed', sel: null, D: null, det: null };
  C.refsState = S;

  C.refsToolbar = function () {
    return C.seg([['all', 'All'], ['agent', 'Agents'], ['adjuster', 'Adjusters'], ['dealer', 'Dealers'], ['past_customer', 'Past customers']], S.type, 'data-rtype') +
      '<input id="rq" value="' + C.esc(S.q) + '" placeholder="Find a referrer or company…" style="width:200px;background:transparent;border:1px solid var(--line);border-radius:4px;color:var(--text);font:400 11.5px var(--font);padding:6px 10px">' +
      '<select id="rsort" style="background:var(--bg);border:1px solid var(--line);border-radius:4px;color:var(--text);font:400 11.5px var(--font);padding:5px 8px">' +
      [['owed', 'Owed first'], ['sent', 'Most sent'], ['last', 'Last sent']].map(function (o) { return '<option value="' + o[0] + '"' + (S.sort === o[0] ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('') + '</select>' +
      (C.me.caps.money ? '<a href="/referrals.html" style="font:400 11.5px var(--font);padding:5px 10px;border-radius:4px;border:1px solid var(--line);color:var(--muted);text-decoration:none">Payout list</a>' : '');
  };
  C.wireRefsToolbar = function (bar) {
    C.each(bar, '[data-rtype]', function (b) { b.addEventListener('click', function () { S.type = b.dataset.rtype; C.render(); }); });
    var q = bar.querySelector('#rq'); if (q) q.addEventListener('input', function () { S.q = q.value; C.paintBody(); });
    var s = bar.querySelector('#rsort'); if (s) s.addEventListener('change', function () { S.sort = s.value; C.paintBody(); });
  };

  C.views.refs = function (el) {
    if (!S.D) el.innerHTML = C.loading();
    return C.api('/api/referrers/summary').then(function (d) { S.D = d; paint(el); });
  };
  function rows() {
    var q = S.q.trim().toLowerCase();
    var r = S.D.rows.filter(function (x) {
      if (S.type !== 'all' && x.kind !== S.type) return false;
      if (q && [x.name, x.company, x.phone, x.email].join(' ').toLowerCase().indexOf(q) < 0) return false;
      return true;
    });
    r.sort(function (a, b) {
      if (S.sort === 'sent') return b.sent - a.sent;
      if (S.sort === 'last') return String(b.last || '').localeCompare(String(a.last || ''));
      return (b.owedCents || 0) - (a.owedCents || 0) || b.sent - a.sent;
    });
    return r;
  }
  var GRID = 'display:grid;grid-template-columns:minmax(0,1fr) 130px 52px 84px 88px 88px 88px 84px;';
  function paint(el) {
    var D = S.D, k = D.kpis, list = rows();
    if (!S.sel && list.length) S.sel = list[0].id;
    var kp = [['Referrers', k.referrers, 'var(--text)'], ['Leads sent', k.sent, 'var(--text)'], ['Became ROs', k.won, 'var(--text)'], ['Close rate', k.rate + '%', 'var(--text)']];
    if (D.money) kp.push(['Owed', C.money(k.owedCents), k.owedCents ? 'var(--acc)' : 'var(--dim)'], ['Paid this year', C.money(k.paidCents), 'var(--text)']);
    kp.push(['W-9 needed', k.w9, k.w9 ? 'var(--stopped)' : 'var(--dim)']);
    var h = '<div style="display:flex;align-items:stretch;flex:none;background:var(--surf);border-bottom:1px solid var(--line)">' + kp.map(function (x) {
      return '<div style="display:flex;flex-direction:column;justify-content:center;padding:10px 18px;border-right:1px solid var(--whisper)"><div style="font:600 8.5px var(--font);letter-spacing:.13em;text-transform:uppercase;color:var(--acc2);margin-bottom:5px;white-space:nowrap">' + x[0] + '</div><div style="font:500 16px/1 var(--font);font-variant-numeric:tabular-nums;color:' + x[2] + '">' + x[1] + '</div></div>';
    }).join('') + '</div>' +
      '<div style="flex:1;min-height:0;display:grid;grid-template-columns:minmax(0,1fr) 440px">' +
      '<div style="overflow-y:auto;min-width:0"><div style="' + GRID + 'position:sticky;top:0;background:var(--bg);border-bottom:1px solid var(--line);font:600 8.5px var(--font);letter-spacing:.13em;text-transform:uppercase;color:var(--dim)">' +
      '<span style="padding:9px 18px">Referrer</span><span style="padding:9px 8px">Type</span><span style="padding:9px 8px;text-align:right">Sent</span><span style="padding:9px 8px;text-align:right">Won</span><span style="padding:9px 8px;text-align:right">On leads</span><span style="padding:9px 8px;text-align:right">Owed</span><span style="padding:9px 8px;text-align:right">Paid</span><span style="padding:9px 18px 9px 8px;text-align:right">Last</span></div>' +
      (list.length ? list.map(function (r) {
        var on = r.id === S.sel;
        return '<div data-rsel="' + r.id + '" style="' + GRID + 'align-items:center;border-bottom:1px solid var(--whisper);cursor:pointer;background:' + (on ? 'var(--surf)' : 'transparent') + ';box-shadow:inset 3px 0 0 ' + (on ? 'var(--acc)' : r.w9Warn ? 'var(--stopped)' : 'transparent') + '">' +
          '<div style="padding:9px 18px;display:flex;flex-direction:column;gap:2px;min-width:0"><span style="font:500 12.5px var(--font);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + C.esc(r.name) + (r.clientId ? ' <span style="font:600 8px var(--font);letter-spacing:.08em;color:var(--acc2);border:1px solid var(--acc2);border-radius:3px;padding:1px 4px">CLIENT</span>' : '') + '</span><span style="font:400 10.5px var(--font);color:var(--dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + C.esc(r.company || r.phone || '') + '</span></div>' +
          '<span style="padding:0 8px;font:400 11px var(--font);color:var(--muted)">' + C.esc(KINDS[r.kind] || r.kind) + '</span>' +
          '<span style="padding:0 8px;text-align:right;font:500 12px var(--font);font-variant-numeric:tabular-nums">' + r.sent + '</span>' +
          '<span style="padding:0 8px;text-align:right;font:400 12px var(--font);font-variant-numeric:tabular-nums;color:var(--muted)">' + r.won + '</span>' +
          '<span style="padding:0 8px;text-align:right;font:400 12px var(--font);font-variant-numeric:tabular-nums;color:var(--muted)">' + r.open + '</span>' +
          '<span style="padding:0 8px;text-align:right;font:500 12px var(--font);font-variant-numeric:tabular-nums;color:' + (r.owedCents ? 'var(--acc)' : 'var(--dim)') + '">' + (r.owedCents == null ? '—' : C.money(r.owedCents)) + '</span>' +
          '<span style="padding:0 8px;text-align:right;font:400 12px var(--font);font-variant-numeric:tabular-nums;color:var(--muted)">' + (r.paidCents == null ? '—' : C.money(r.paidCents)) + '</span>' +
          '<span style="padding:0 18px 0 8px;text-align:right;font:400 11px var(--font);color:var(--dim);white-space:nowrap">' + (r.last ? C.day(r.last) : '—') + '</span></div>';
      }).join('') : '<div style="padding:28px 18px;font:400 12px var(--font);color:var(--dim)">No referrer matches. Referrers are added from a referral lead.</div>') +
      '</div><div id="rdet" style="border-left:1px solid var(--line);background:var(--surf);overflow-y:auto"></div></div>';
    el.innerHTML = '<div style="flex:1;min-height:0;display:flex;flex-direction:column">' + h + '</div>';
    C.each(el, '[data-rsel]', function (b) { b.addEventListener('click', function () { S.sel = Number(b.dataset.rsel); paint(el); }); });
    if (S.sel) detail(el.querySelector('#rdet'), S.sel);
  }
  function detail(box, id) {
    var r = S.D.rows.filter(function (x) { return x.id === id; })[0];
    if (!r) { box.innerHTML = ''; return; }
    C.api('/api/referrers/' + id).then(function (d) {
      var f = d.referrer, can = !!(C.me.caps.salesManager || C.me.caps.money), money = d.totals != null;
      var lab = 'font:600 8.5px var(--font);letter-spacing:.13em;text-transform:uppercase;color:var(--acc2)';
      var fees = money ? [['Owed', C.money(d.totals.owedCents), d.totals.owedCents ? 'var(--acc)' : 'var(--dim)'], ['Paid this year', C.money(d.totals.paidCents), 'var(--text)'],
        ['Usual fee', f.default_fee_cents != null ? C.money(f.default_fee_cents) : 'None set', 'var(--text)'], ['W-9', f.w9_on_file ? 'On file' : (d.w9Warn ? 'Needed — over $600' : 'Not on file'), f.w9_on_file ? 'var(--done)' : d.w9Warn ? 'var(--stopped)' : 'var(--dim)']] : [];
      var h = '<div style="padding:18px 20px 16px;display:flex;flex-direction:column;gap:5px;border-bottom:1px solid var(--line)">' +
        '<span style="font:500 18px var(--font)">' + C.esc(f.name) + '</span>' +
        '<span style="font:400 12px var(--font);color:var(--muted)">' + C.esc([KINDS[f.kind], f.company].filter(Boolean).join(' · ')) + '</span>' +
        '<div style="display:flex;gap:14px;flex-wrap:wrap;font:400 11.5px var(--font);color:var(--muted);padding-top:4px"><span>' + C.esc(C.phone(f.phone)) + '</span><span>' + C.esc(f.email || '') + '</span>' +
        (f.client_id ? '<span data-client="' + f.client_id + '" style="color:var(--acc2);cursor:pointer">Also a client</span>' : '') + '</div></div>';
      if (money) {
        h += '<div style="padding:16px 20px;display:flex;flex-direction:column;gap:10px;border-bottom:1px solid var(--line)"><div style="' + lab + '">Fees</div>' +
          '<div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px 16px">' + fees.map(function (x) {
            return '<div style="display:flex;flex-direction:column;gap:3px"><span style="font:400 10.5px var(--font);color:var(--dim)">' + x[0] + '</span><span style="font:500 15px var(--font);font-variant-numeric:tabular-nums;color:' + x[2] + '">' + C.esc(x[1]) + '</span></div>';
          }).join('') + '</div>';
        if (can) h += '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap"><span style="font:400 11.5px var(--font);color:var(--muted)">Usual fee</span><input id="fFee" type="number" min="0" step="0.01" value="' + (f.default_fee_cents != null ? (f.default_fee_cents / 100).toFixed(2) : '') + '" style="width:90px;background:var(--bg);border:1px solid var(--line);border-radius:4px;color:var(--text);font:400 12px var(--font);padding:5px 8px">' +
          (f.kind === 'dealer' ? '<span style="font:400 11.5px var(--font);color:var(--muted)">Usually paid to</span><input id="fPayee" list="fPayees" value="' + C.esc(f.payee_default || '') + '" placeholder="GM, service director…" style="width:150px;background:var(--bg);border:1px solid var(--line);border-radius:4px;color:var(--text);font:400 12px var(--font);padding:5px 8px"><datalist id="fPayees">' + r.payees.map(function (p) { return '<option value="' + C.esc(p) + '">'; }).join('') + '</datalist>' : '') +
          '<label style="display:flex;gap:5px;align-items:center;font:400 11.5px var(--font);color:var(--muted)"><input type="checkbox" id="fW9"' + (f.w9_on_file ? ' checked' : '') + '> W-9 on file</label>' +
          '<span id="fSave" style="font:500 11px var(--font);color:var(--acc);border:1px solid var(--acc);border-radius:4px;padding:5px 10px;cursor:pointer">Save</span></div>';
        h += '<div style="font:400 11px/1.5 var(--font);color:var(--dim);text-wrap:pretty">' + (f.kind === 'dealer' ? 'A dealer fee may go to the GM, the service director or whoever sent it; set it per referral below. ' : 'Paid to the referrer. ') +
          'Earned when the car is picked up, paid the Friday after, Wednesday cut-off. Paid on the referral payout list.</div></div>';
      }
      h += '<div style="padding:16px 20px 24px;display:flex;flex-direction:column"><div style="display:flex;align-items:baseline;gap:10px;padding-bottom:6px"><div style="' + lab + '">Leads sent</div><span style="font:400 11px var(--font);color:var(--dim)">' + d.referrals.length + ' sent · ' + d.referrals.filter(function (x) { return x.roId; }).length + ' became ROs</span></div>' +
        (d.referrals.length ? d.referrals.map(function (l) {
          var st = C.statusOf(l.pipeStatus || (l.roId ? 'in_shop' : 'fresh'));
          var sc = l.state === 'paid' ? 'var(--done)' : l.state === 'owed' ? 'var(--acc)' : l.state === 'held' ? 'var(--stopped)' : 'var(--muted)';
          var dealer = f.kind === 'dealer' && can && ['open', 'owed_pickup', 'owed', 'held'].indexOf(l.state) >= 0 && l.state !== 'no_fee';
          return '<div data-open="' + l.leadId + '" style="display:flex;flex-direction:column;gap:4px;padding:9px 6px;border-bottom:1px solid var(--whisper);cursor:pointer;border-radius:4px">' +
            '<div style="display:flex;align-items:center;gap:8px;min-width:0">' + C.code(st) +
            '<span style="font:500 12px var(--font);white-space:nowrap">' + C.esc(l.customer || '—') + '</span>' +
            '<span style="font:400 11px var(--font);color:var(--dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0">' + C.esc(l.vehicle || '') + '</span>' +
            '<span style="margin-left:auto;font:500 12px var(--font);font-variant-numeric:tabular-nums">' + (l.state === 'no_fee' ? '—' : l.feeCents != null ? C.money(l.feeCents) : '') + '</span></div>' +
            '<div style="display:flex;gap:8px;padding-left:54px;font:400 11px var(--font);flex-wrap:wrap"><span style="color:var(--dim)">' + C.esc(l.leadNumber) + (l.roNumber ? ' · RO ' + C.esc(l.roNumber) : '') + '</span><span style="color:' + sc + '">' + C.esc(l.label) + '</span></div>' +
            (f.kind === 'dealer' && l.state !== 'no_fee' ? '<div data-stop="1" style="display:flex;align-items:center;gap:6px;padding-left:54px;font:400 11px var(--font);color:var(--dim)">To ' +
              (dealer ? '<input data-payee="' + l.leadId + '" list="fPayees" value="' + C.esc(l.payee || '') + '" style="background:transparent;border:1px solid var(--line);border-radius:4px;color:' + (l.payee !== (f.payee_default || f.name) ? 'var(--acc2)' : 'var(--muted)') + ';font:400 11px var(--font);padding:2px 6px;width:150px">' : '<span style="color:var(--muted)">' + C.esc(l.payee || '') + '</span>') +
              (l.payee && f.payee_default && l.payee !== f.payee_default ? '<span>not the usual</span>' : '') + '</div>' : '') + '</div>';
        }).join('') : '<div style="padding:10px 0;font:400 12px var(--font);color:var(--dim)">Nothing sent yet.</div>') + '</div>';
      box.innerHTML = h;
      C.each(box, '[data-stop]', function (b) { b.addEventListener('click', function (e) { e.stopPropagation(); }); });
      C.each(box, '[data-open]', function (b) { b.addEventListener('click', function () { C.openLead(Number(b.dataset.open)); }); });
      C.each(box, '[data-client]', function (b) { b.addEventListener('click', function () { C.go('clients', { client: Number(b.dataset.client) }); }); });
      C.each(box, '[data-payee]', function (i) {
        i.addEventListener('change', function () {
          C.api('/api/leads/' + i.dataset.payee + '/referral', { method: 'PATCH', body: JSON.stringify({ payee: i.value }) }).then(function () { C.toast('Payee saved.'); }).catch(C.fail);
        });
      });
      var sv = box.querySelector('#fSave');
      if (sv) sv.addEventListener('click', function () {
        var body = { w9OnFile: box.querySelector('#fW9').checked, defaultFeeCents: box.querySelector('#fFee').value === '' ? null : Math.round(Number(box.querySelector('#fFee').value) * 100) };
        if (box.querySelector('#fPayee')) body.payeeDefault = box.querySelector('#fPayee').value;
        C.api('/api/referrers/' + id, { method: 'PATCH', body: JSON.stringify(body) }).then(function () { C.toast('Saved.'); S.D = null; C.render(); }).catch(C.fail);
      });
    }).catch(function (e) { box.innerHTML = '<div style="padding:18px;color:var(--stopped)">' + C.esc(e.message) + '</div>'; });
  }
})();
