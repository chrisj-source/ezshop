/* Clients (3b), as mocked: the list of everyone who came through Leads on the
   left, the full client page on the right — contact, where they came from,
   vehicles and ROs, the referral fee, what they have sent us, and the
   timeline from the lead. Wholesale and insurance accounts stay on their own
   screen (clients.html). */
(function () {
  var C = window.CRM;
  var S = { q: '', sel: null, D: null };
  C.clientsState = S;
  C.views.clients = function (el, opts) {
    if (opts && opts.lead) S.sel = opts.lead;
    if (!S.D) el.innerHTML = C.loading();
    return C.api('/api/crm/clients').then(function (d) {
      S.D = d;
      if (opts && opts.client) { var m = d.clients.filter(function (c) { return c.clientId === opts.client; })[0]; if (m) S.sel = m.leadId; }
      paint(el);
    });
  };
  var LAB = 'font:600 8.5px var(--font);letter-spacing:.13em;text-transform:uppercase;color:var(--acc2)';
  function paint(el) {
    var q = S.q.trim().toLowerCase();
    var rows = S.D.clients.filter(function (c) { return !q || c.q.indexOf(q) >= 0; });
    if (!S.sel && rows.length) S.sel = rows[0].leadId;
    el.innerHTML = '<div style="flex:1;min-height:0;display:grid;grid-template-columns:340px minmax(0,1fr)">' +
      '<div style="border-right:1px solid var(--line);display:flex;flex-direction:column;min-height:0;background:var(--surf)">' +
      '<div style="padding:12px 14px;border-bottom:1px solid var(--line);display:flex;flex-direction:column;gap:8px;flex:none">' +
      '<div style="display:flex;align-items:baseline;gap:8px"><span style="font:600 13px var(--font)">Clients</span><span style="font:400 11px var(--font);color:var(--dim)">' + S.D.clients.length + ' from leads</span>' +
      '<a href="/clients.html" style="margin-left:auto;font:400 11px var(--font);color:var(--acc2)">Wholesale &amp; insurance</a></div>' +
      '<input id="cq" value="' + C.esc(S.q) + '" placeholder="Find a name, vehicle, phone or RO…" style="background:var(--bg);border:1px solid var(--line);border-radius:4px;color:var(--text);font:400 11.5px var(--font);padding:6px 10px"></div>' +
      '<div id="clist" style="flex:1;overflow-y:auto">' + rows.map(function (r) {
        var on = r.leadId === S.sel;
        return '<div data-csel="' + r.leadId + '" style="padding:9px 14px 9px 11px;border-left:3px solid ' + (on ? 'var(--acc)' : 'transparent') + ';background:' + (on ? 'var(--bg)' : 'transparent') + ';border-bottom:1px solid var(--whisper);cursor:pointer;display:flex;align-items:center;gap:10px">' +
          '<div style="display:flex;flex-direction:column;gap:2px;min-width:0"><span style="font:500 12.5px var(--font)">' + C.esc(r.name) + '</span><span style="font:400 10.5px var(--font);color:var(--dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + C.esc(r.sub) + '</span></div>' +
          '<span style="margin-left:auto;font:600 9px var(--font);letter-spacing:.06em;padding:1px 5px;border-radius:3px;flex:none;color:' + r.tone + ';border:1px solid ' + r.tone + '">' + r.tag + '</span></div>';
      }).join('') + (rows.length ? '' : '<div style="padding:16px 14px;font:400 12px var(--font);color:var(--dim)">Nobody matches.</div>') + '</div></div>' +
      '<div id="cdet" style="overflow-y:auto;padding:24px 32px 40px"></div></div>';
    var cq = el.querySelector('#cq');
    cq.addEventListener('input', function () { var p = cq.selectionStart; S.q = cq.value; paint(el); var n = el.querySelector('#cq'); n.focus(); n.setSelectionRange(p, p); });
    C.each(el, '[data-csel]', function (b) { b.addEventListener('click', function () { S.sel = Number(b.dataset.csel); paint(el); }); });
    if (S.sel) detail(el.querySelector('#cdet'), S.sel, rows.filter(function (r) { return r.leadId === S.sel; })[0]);
  }
  function detail(box, leadId, row) {
    box.innerHTML = C.loading();
    C.api('/api/customer-record?lead=' + leadId).then(function (d) {
      var l = d.lead || {}, tag = row ? [row.tag, row.tone] : ['', 'var(--dim)'];
      var since = d.files.length ? 'Customer since ' + C.day(d.files[d.files.length - 1].opened_at) + ' · ' + d.files.length + ' file' + (d.files.length === 1 ? '' : 's')
        : l.state === 'lost' || l.status === 'not_repairing' ? 'Lost' + (l.lostReason ? ' · ' + l.lostReason : '') : 'No file yet';
      var veh = d.files.length ? d.files : [{ vehicle: l.vehicle, vin: '', ro_number: null, status_label: l.state === 'lost' ? 'Lost lead' : 'No RO' }];
      var h = '<div style="max-width:1000px;display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:28px">' +
        '<div style="display:flex;flex-direction:column;gap:22px">' +
        '<div style="display:flex;flex-direction:column;gap:6px"><div style="display:flex;align-items:center;gap:10px"><span style="font:500 22px var(--font)">' + C.esc(d.name || 'Customer') + '</span>' +
          '<span style="font:600 9px var(--font);letter-spacing:.08em;text-transform:uppercase;padding:2px 6px;border-radius:3px;color:' + tag[1] + ';border:1px solid ' + tag[1] + '">' + tag[0] + '</span></div>' +
          '<span style="font:400 12px var(--font);color:var(--muted)">' + C.esc(since) + '</span>' +
          '<div style="display:flex;gap:8px;padding-top:6px"><span data-lead="' + leadId + '" style="font:500 11px var(--font);color:var(--text);border:1px solid var(--line);border-radius:4px;padding:6px 11px;cursor:pointer">Lead record</span>' +
          (row && row.lost && C.me.caps.manageLeads ? '<span id="cReopen" style="font:500 11px var(--font);color:var(--acc);border:1px solid var(--acc);border-radius:4px;padding:6px 11px;cursor:pointer">Reopen as a lead</span>' : '') + '</div></div>' +
        '<div style="display:grid;grid-template-columns:90px minmax(0,1fr);gap:8px 12px;font:400 12px var(--font)">' +
          '<span style="color:var(--dim)">Phone</span><span>' + C.esc(C.phone(d.phone) || '—') + '</span>' +
          '<span style="color:var(--dim)">Email</span><span>' + C.esc(d.email || '—') + '</span>' +
          '<span style="color:var(--dim)">Came from</span><span>' + C.esc([l.lane || l.source, l.campaign, d.referral ? 'referred by ' + d.referral.referrer.name : ''].filter(Boolean).join(' · ') || '—') + '</span>' +
          '<span style="color:var(--dim)">Lead in</span><span>' + C.esc((l.receivedAt ? C.day(l.receivedAt) : '—') + ' · ' + (l.owner || 'Unassigned')) + (l.leadToRoHours != null ? ' <span style="color:var(--dim)">· RO in ' + C.dur(l.leadToRoHours * 60) + '</span>' : '') + '</span></div>' +
        '<div style="display:flex;flex-direction:column;gap:8px"><div style="' + LAB + '">Vehicles and ROs</div>' +
          '<div style="display:grid;grid-template-columns:minmax(0,1fr) 80px 90px;border:1px solid var(--line);border-radius:6px;overflow:hidden;font:400 12px var(--font)">' +
          ['Vehicle', 'RO', 'State'].map(function (x) { return '<span style="padding:8px 12px;background:var(--surf);font:600 8.5px var(--font);letter-spacing:.13em;text-transform:uppercase;color:var(--dim)">' + x + '</span>'; }).join('') +
          veh.map(function (f) {
            return '<div style="padding:9px 12px;display:flex;flex-direction:column;gap:2px;border-top:1px solid var(--whisper)"><span>' + C.esc(f.vehicle || '—') + '</span><span style="font:400 10.5px var(--font);color:var(--dim);letter-spacing:.04em">' + C.esc(f.vin || '') + '</span></div>' +
              (f.ro_number ? '<a href="/board.html?ro=' + f.id + '" title="Open the file on the board" style="padding:9px 12px;font-variant-numeric:tabular-nums;color:var(--acc);text-decoration:underline;text-underline-offset:3px;border-top:1px solid var(--whisper)">' + C.esc(f.ro_number) + '</a>' : '<span style="padding:9px 12px;color:var(--dim);border-top:1px solid var(--whisper)">—</span>') +
              '<span style="padding:9px 12px;color:var(--muted);border-top:1px solid var(--whisper)">' + C.esc(f.voided_at ? 'Voided' : f.closed_at ? 'Picked up' : f.status_label || '—') + '</span>';
          }).join('') + '</div></div>';
      if (d.referral) h += '<div style="display:flex;flex-direction:column;gap:6px"><div style="' + LAB + '">Referral fee</div><span style="font:400 12px var(--font)">' +
        C.esc(d.referral.referrer.name) + (d.referral.feeCents != null && !d.referral.noFee ? ' · ' + C.money(d.referral.feeCents) : d.referral.noFee ? ' · no fee' : '') + '</span><span style="font:400 11px var(--font);color:var(--dim)">' + C.esc(d.referral.label) + '</span></div>';
      if (d.sent) h += '<div style="display:flex;flex-direction:column;gap:6px"><div style="display:flex;align-items:baseline;gap:10px"><div style="' + LAB + '">Referrals sent</div><span style="font:400 11px var(--font);color:var(--dim)">' + d.sent.count + (d.sent.paidThisYearCents != null ? ' · ' + C.money(d.sent.paidThisYearCents) + ' paid this year' : '') + '</span></div>' +
        d.sent.list.map(function (s) {
          return '<div data-lead="' + s.leadId + '" style="display:flex;gap:8px;padding:6px 0;border-bottom:1px solid var(--whisper);cursor:pointer;font:400 12px var(--font)"><span style="font-weight:500">' + C.esc(s.customer || '—') + '</span><span style="color:var(--dim)">' + C.esc(s.vehicle || '') + '</span><span style="margin-left:auto;color:var(--muted)">' + C.esc(s.label) + (s.feeCents != null && s.state !== 'no_fee' ? ' · ' + C.money(s.feeCents) : '') + '</span></div>';
        }).join('') + '</div>';
      h += '</div><div style="display:flex;flex-direction:column;gap:2px"><div style="display:flex;align-items:baseline;gap:10px;padding-bottom:6px"><div style="' + LAB + '">Timeline, from the lead</div><span style="font:400 11px var(--font);color:var(--dim)">' + d.timeline.length + ' entries</span></div>' +
        d.timeline.map(function (e) {
          var file = e.src === 'files';
          return '<div style="display:flex;gap:10px;padding:8px 10px;border:' + (file ? '1px solid var(--whisper)' : '1px solid transparent') + ';border-radius:5px"><span style="width:7px;height:7px;border-radius:50%;margin-top:5px;flex:none;background:' + (file ? 'oklch(0.76 0.10 185)' : 'var(--acc)') + '"></span>' +
            '<div style="display:flex;flex-direction:column;gap:2px;min-width:0"><div style="display:flex;gap:8px;font:400 10.5px var(--font);color:var(--dim)"><span>' + C.esc(C.stamp(e.at)) + '</span><span>' + C.esc(e.who || '') + '</span><span style="color:var(--acc2)">' + (file ? 'File' : 'Lead') + '</span></div>' +
            '<span style="font:400 12px/1.45 var(--font);text-wrap:pretty">' + C.esc(e.text) + '</span></div></div>';
        }).join('') + (d.timeline.length ? '' : '<div style="font:400 12px var(--font);color:var(--dim)">Nothing yet.</div>') + '</div></div>';
      box.innerHTML = h;
      C.each(box, '[data-lead]', function (b) { b.addEventListener('click', function () { C.openLead(Number(b.dataset.lead)); }); });
      var ro = box.querySelector('#cReopen');
      if (ro) ro.addEventListener('click', function () {
        C.api('/api/leads/' + leadId + '/reopen', { method: 'POST' }).then(function () { C.toast('Reopened — it is back in the pipeline.'); S.D = null; C.render(); }).catch(C.fail);
      });
    }).catch(function (e) { box.innerHTML = '<div style="color:var(--stopped);font:400 12px var(--font)">' + C.esc(e.message) + '</div>'; });
  }
})();
