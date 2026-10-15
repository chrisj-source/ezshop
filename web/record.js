/* The customer record (2b / 3a / 3b). One renderer, used by record.html (full
   page) and by the board, which opens it over itself from the Owner cell.
   Not an iframe: the app is never framed (security.ts). */
(function () {
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function fmt$(c) { return '$' + (Number(c || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function at(v) { if (!v) return '—'; var d = new Date(v); return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' }) + ' ' + d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }); }
  function dur(h) { if (h == null) return '—'; return h < 48 ? h + 'h' : Math.round(h / 24) + 'd'; }
  var L = 'font:600 8.5px var(--font);letter-spacing:.12em;text-transform:uppercase;color:var(--dim)';
  var S = 'font:600 8.5px var(--font);letter-spacing:.12em;text-transform:uppercase;color:var(--acc2);margin:18px 0 8px';

  function render(el, query) {
    el.innerHTML = '<div style="padding:18px;font:400 12px var(--font);color:var(--dim)">Loading…</div>';
    return fetch('/api/customer-record?' + query, { credentials: 'same-origin' }).then(function (r) {
      return r.json().then(function (d) { if (!r.ok) throw new Error(d.error || 'Could not load'); return d; });
    }).then(function (d) {
      var l = d.lead, F = 'all';
      var hi = function (k, v) { return '<div style="min-width:110px"><div style="' + L + '">' + k + '</div><div style="font:500 13px var(--font);margin-top:4px">' + v + '</div></div>'; };
      var head = '<div style="padding:18px 20px;border-bottom:1px solid var(--line)">' +
        '<div style="font:500 19px var(--font)">' + esc(d.name || 'Customer') + '</div>' +
        '<div style="font:400 11.5px var(--font);color:var(--muted);margin-top:4px">' + esc([d.phone, d.email].filter(Boolean).join(' · ')) + '</div>' +
        '<div style="display:flex;gap:22px;flex-wrap:wrap;margin-top:14px">' +
          (l ? hi('Came in', esc(l.lane || l.source) + (l.campaign ? ' · ' + esc(l.campaign) : '')) + hi('Owner', esc(l.owner || 'Unassigned')) +
            hi('Lead to RO', dur(l.leadToRoHours)) + (l.estimateCents != null ? hi('Estimate', fmt$(l.estimateCents)) : '') +
            hi('Lead', '<a href="/leads.html?lead=' + l.id + '" style="color:var(--acc2)">' + esc(l.number) + '</a>') : hi('Came in', 'No lead — starts at check-in')) +
          (d.referral ? hi('Referral', esc(d.referral.referrer.name) + '<div style="font:400 10.5px var(--font);color:var(--dim);margin-top:2px">' + esc(d.referral.label) +
            (d.referral.feeCents != null && !d.referral.noFee ? ' · ' + fmt$(d.referral.feeCents) : '') + '</div>') : '') +
        '</div></div>';
      var path = '';
      if (l && l.path.length) {
        path = '<div style="padding:12px 20px;border-bottom:1px solid var(--whisper);display:flex;gap:4px;flex-wrap:wrap">' + l.path.map(function (s) {
          var on = s.key === l.status;
          return '<span style="font:500 10.5px var(--font);padding:4px 8px;border-radius:4px;border:1px solid ' + (on ? s.tone : 'var(--line)') +
            ';color:' + (on ? s.tone : 'var(--dim)') + (on ? ';background:var(--whisper)' : '') + '">' + esc(s.label) + '</span>';
        }).join('') + (l.state === 'lost' ? '<span style="font:500 10.5px var(--font);color:var(--stopped);padding:4px 8px">Lost' + (l.lostReason ? ' · ' + esc(l.lostReason) : '') + '</span>' : '') + '</div>';
      }
      var side = '';
      if (l && l.ladder) side += '<div style="' + S + '">Ladder</div><div style="font:400 11.5px var(--font);color:var(--muted)">Step 1 owner at ' + l.ladder[0] +
        'h · step 2 managers at ' + l.ladder[1] + 'h · step 3 owner at ' + l.ladder[2] + 'h' + (l.escStep ? '<div style="color:var(--stopped);margin-top:3px">At step ' + l.escStep + ' now</div>' : '') + '</div>';
      if (d.appointments.length) side += '<div style="' + S + '">Appointments</div>' + d.appointments.map(function (a) {
        return '<div style="font:400 11.5px var(--font);padding:4px 0;' + (a.cancelled_at ? 'color:var(--dim);text-decoration:line-through' : '') + '">' + esc(at(a.starts_at)) + ' · ' + esc(a.kind || '') + (a.assigned ? ' · ' + esc(a.assigned) : '') + '</div>';
      }).join('');
      side += '<div style="' + S + '">Files · ' + d.files.length + '</div>' + (d.files.length ? d.files.map(function (f) {
        return '<a href="/board.html?ro=' + f.id + '" style="display:block;padding:7px 0;border-bottom:1px solid var(--whisper);color:inherit;text-decoration:none">' +
          '<div style="font:500 12px var(--font);color:var(--acc2)">RO ' + esc(f.ro_number) + '</div><div style="font:400 10.5px var(--font);color:var(--dim)">' +
          esc([f.vehicle, f.status_label, f.closed_at ? 'picked up' : ''].filter(Boolean).join(' · ')) + '</div></a>';
      }).join('') : '<div style="font:400 11.5px var(--font);color:var(--dim)">No files yet.</div>');
      var tl = function () {
        var rows = d.timeline.filter(function (t) { return F === 'all' || t.src === F; });
        return '<div style="display:flex;gap:4px;margin:0 0 8px">' + [['all', 'All'], ['lead', 'Lead'], ['files', 'Files']].map(function (x) {
          return '<button data-tf="' + x[0] + '" style="font:400 11px var(--font);padding:4px 10px;border-radius:4px;cursor:pointer;border:1px solid ' + (F === x[0] ? 'var(--acc)' : 'var(--line)') + ';background:transparent;color:' + (F === x[0] ? 'var(--acc)' : 'var(--dim)') + '">' + x[1] + '</button>';
        }).join('') + '</div>' + (rows.length ? rows.map(function (t) {
          return '<div style="padding:7px 0;border-bottom:1px solid var(--whisper)"><div style="font:400 12px var(--font)">' + esc(t.text) + '</div>' +
            '<div style="font:400 10.5px var(--font);color:var(--dim);margin-top:2px">' + esc(at(t.at)) + (t.who ? ' · ' + esc(t.who) : '') + ' · ' + (t.src === 'lead' ? 'Lead' : 'File') + '</div></div>';
        }).join('') : '<div style="font:400 11.5px var(--font);color:var(--dim)">Nothing yet.</div>');
      };
      el.innerHTML = head + path + '<div style="display:grid;grid-template-columns:minmax(0,1.6fr) minmax(0,1fr);gap:24px;padding:0 20px 30px">' +
        '<div><div style="' + S + '">Timeline</div><div id="crTl"></div></div><div>' + side + '</div></div>';
      var paint = function () {
        el.querySelector('#crTl').innerHTML = tl();
        Array.prototype.forEach.call(el.querySelectorAll('[data-tf]'), function (b) { b.addEventListener('click', function () { F = b.dataset.tf; paint(); }); });
      };
      paint();
    }).catch(function (e) { el.innerHTML = '<div style="padding:18px;font:400 12px var(--font);color:var(--stopped)">' + esc(e.message) + '</div>'; });
  }
  window.CustomerRecord = { render: render };
})();
