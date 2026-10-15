/* The lead record, docked (2a) or full page (2b), and the three modals: New
   lead, Mark lost, Book a drop-off. As mocked. */
(function () {
  var C = window.CRM;
  var L = { id: null, full: false, comp: null, cb: null, d: null };
  C.leadState = L;
  var REASONS = ['Price', 'Went to another shop', 'Insurance totalled it', 'Changed mind, no repair', 'Could not reach', 'Other'];
  var LAB = 'font:600 8.5px var(--font);letter-spacing:.13em;text-transform:uppercase;color:var(--acc2)';
  var INP = 'background:var(--bg);border:1px solid var(--line);border-radius:4px;color:var(--text);font:400 12.5px var(--font);padding:7px 9px';
  var FLD = 'display:flex;flex-direction:column;gap:5px;font:400 11px var(--font);color:var(--dim)';

  C.openLead = function (id) { L.id = id; L.comp = null; C.sel = id; draw(); C.highlight && C.highlight(); };
  C.closeLead = function () { L.id = null; C.sel = null; var h = document.getElementById('crmLead'); if (h) h.innerHTML = ''; C.highlight && C.highlight(); };

  function host() { return document.getElementById('crmLead'); }
  function draw() {
    var el = host(); if (!el || !L.id) return;
    if (!L.d || L.d.lead.id !== L.id) el.innerHTML = shell('<div style="padding:20px">' + C.loading() + '</div>');
    C.api('/api/leads/' + L.id).then(function (d) { L.d = d; paint(); }).catch(function (e) { el.innerHTML = shell('<div style="padding:20px;color:var(--stopped)">' + C.esc(e.message) + '</div>'); });
  }
  function shell(inner) {
    return '<div style="position:absolute;top:0;right:0;bottom:0;width:' + (L.full ? '100%' : '500px') + ';max-width:100%;background:var(--surf);border-left:1px solid var(--line);box-shadow:-10px 0 24px rgba(0,0,0,.35);display:flex;flex-direction:column;z-index:20">' + inner + '</div>';
  }
  function paint() {
    var d = L.d, l = d.lead, ln = C.laneOfSource(l.source), st = C.statusOf(l.pipe_status || (l.ro_id ? 'in_shop' : ln.statuses[0]));
    var name = [l.first_name, l.last_name].filter(Boolean).join(' ') || l.lead_number;
    var detail = d.referral ? 'from ' + d.referral.referrer.name : (l.campaign || l.lead_number);
    var appt = (d.appointments || []).filter(function (a) { return !a.cancelled_at && new Date(a.starts_at) >= new Date(); })[0];
    var cb = (d.callbacks || [])[0];
    var lost = l.state === 'lost';
    var acts = [['call', 'Log call'], ['email', 'Log email'], ['note', 'Note']];
    var b = function (k, t, tone) { return '<span data-act="' + k + '" style="font:500 11px var(--font);padding:6px 11px;border-radius:4px;cursor:pointer;white-space:nowrap;border:1px solid ' + (tone || 'var(--line)') + ';color:' + (tone || 'var(--text)') + ';background:' + (L.comp === k ? 'var(--chip)' : 'transparent') + '">' + t + '</span>'; };
    var actH = acts.map(function (a) { return b(a[0], a[1]); }).join('') +
      (!l.ro_id && !lost ? b('book', appt ? 'Move drop-off' : 'Book drop-off', 'var(--acc)') + b('convert', 'Open RO', 'oklch(0.76 0.13 150)') + b('lost', 'Mark lost', 'var(--stopped)') : '') +
      (lost ? b('reopen', 'Reopen', 'var(--acc)') : '');
    var comp = '';
    if (L.comp) {
      var title = { call: 'Log a call', email: 'Log an email', note: 'Add a note' }[L.comp];
      var cbs = [['2h', 'In 2 hours'], ['tom', 'Tomorrow 9 AM'], ['2d', 'In 2 days'], ['', 'None']];
      comp = '<div style="display:flex;flex-direction:column;gap:8px;padding:12px;background:var(--bg);border:1px solid var(--line);border-radius:6px">' +
        '<span style="' + LAB + '">' + title + '</span>' +
        '<textarea id="lcText" rows="3" placeholder="' + (L.comp === 'call' ? 'What was said' : L.comp === 'email' ? 'What was sent or received' : 'Start with # and a space for an internal note') + '" style="background:var(--surf);border:1px solid var(--line);border-radius:4px;color:var(--text);font:400 12px/1.45 var(--font);padding:8px 10px;resize:vertical"></textarea>' +
        '<div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap"><span style="font:400 11px var(--font);color:var(--dim)">Callback</span>' + cbs.map(function (c) {
          var on = (L.cb || '') === c[0];
          return '<span data-cb="' + c[0] + '" style="font:400 11px var(--font);padding:4px 9px;border-radius:4px;cursor:pointer;border:1px solid ' + (on ? 'var(--acc)' : 'var(--line)') + ';color:' + (on ? 'var(--acc)' : 'var(--muted)') + '">' + c[1] + '</span>';
        }).join('') + '</div>' +
        '<div style="display:flex;gap:8px;align-items:center"><span style="font:400 10.5px var(--font);color:var(--dim)">Resets the escalation clock.</span><span data-act="cancelComp" style="margin-left:auto;font:500 11px var(--font);color:var(--dim);cursor:pointer;padding:6px 8px">Cancel</span><span id="lcSave" style="font:500 11px var(--font);color:var(--bg);background:var(--acc);border-radius:4px;padding:6px 14px;cursor:pointer">Save</span></div></div>';
    }
    var stOpts = ln.statuses.filter(function (k) { return (ln.off || []).indexOf(k) < 0; }).concat(C.meta.always || [], C.meta.parked || []);
    if (stOpts.indexOf(st.key) < 0) stOpts.unshift(st.key);
    var grid = '<div style="display:grid;grid-template-columns:84px minmax(0,1fr);gap:9px 12px;align-items:center;font:400 12px var(--font)">' +
      '<span style="color:var(--dim)">Owner</span><div style="display:flex;align-items:center;gap:8px;min-width:0"><select id="lOwner" style="background:var(--bg);border:1px solid var(--line);border-radius:4px;color:var(--text);font:400 12px var(--font);padding:5px 8px;max-width:200px"><option value="">Unassigned</option>' +
        (C.staff || []).map(function (s) { return '<option value="' + s.userId + '"' + (Number(l.owner_user_id) === s.userId ? ' selected' : '') + '>' + C.esc(s.name) + '</option>'; }).join('') + '</select>' +
        (!l.owner_user_id ? '<span style="font:400 11px var(--font);color:var(--acc)">Hand it to a rep</span>' : '') + '</div>' +
      '<span style="color:var(--dim)">Status</span><select id="lSt"' + (l.ro_id ? ' disabled' : '') + ' style="justify-self:start;background:var(--bg);border:1px solid var(--line);border-radius:4px;color:var(--text);font:400 12px var(--font);padding:5px 8px">' +
        stOpts.map(function (k) { var s = C.statusOf(k); return '<option value="' + k + '"' + (k === st.key ? ' selected' : '') + '>' + C.esc(s.label) + '</option>'; }).join('') + '</select>' +
      '<span style="color:var(--dim)">Phone</span><span>' + (l.phone ? '<a href="tel:' + C.esc(l.phone) + '" style="color:var(--text)">' + C.esc(C.phone(l.phone)) + '</a>' : '—') + '</span>' +
      '<span style="color:var(--dim)">Email</span><span style="overflow:hidden;text-overflow:ellipsis">' + C.esc(l.email || '—') + '</span>' +
      '<span style="color:var(--dim)">Vehicle</span><span>' + C.esc(l.vehicle_text || '—') + '</span>' +
      '<span style="color:var(--dim)">What</span><span>' + C.esc(l.damage_note || '—') + '</span>' +
      '<span style="color:var(--dim)">RO</span><span>' + (l.ro_id ? '<a href="/board.html?ro=' + l.ro_id + '" style="color:var(--acc);text-decoration:underline;text-underline-offset:3px">' + C.esc(l.ro_number) + '</a>' : '—') + '</span></div>';
    var extra = '';
    if (appt) extra += '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:10px 12px;border:1px solid var(--line);border-radius:6px;font:400 12px var(--font)"><span style="' + LAB + '">Drop-off</span><span>' + C.esc(C.when(new Date(appt.starts_at))) + '</span>' +
      '<span data-cancel="' + appt.id + '" style="margin-left:auto;font:500 11px var(--font);color:var(--stopped);cursor:pointer">Cancel appointment</span></div>';
    if (cb) extra += '<div style="font:400 12px var(--font);color:' + (new Date(cb.due_at) < new Date() ? 'var(--stopped)' : 'var(--acc)') + '">Callback ' + C.esc(C.when(new Date(cb.due_at))) + (cb.note ? ' · ' + C.esc(cb.note) : '') + '</div>';
    if (lost) extra += '<div style="font:400 12px var(--font);color:var(--stopped)">Lost: ' + C.esc(l.lost_reason || '—') + '</div>';
    var lad = ln.ladderMin || [60, 240, 1440], q = Number(l.quiet_hours || 0) * 60, stopped = !!appt || !!l.ro_id || lost || (C.meta.closed || []).indexOf(st.key) >= 0;
    var step = stopped ? 0 : q >= lad[2] ? 3 : q >= lad[1] ? 2 : q >= lad[0] ? 1 : 0;
    var who = [d.ownerName || 'Lead owner', ln.step2Who || 'Sales managers', 'Owner'];
    var steps = '<div style="display:flex;flex-direction:column;gap:8px"><div style="' + LAB + '">' + C.esc(ln.label) + ' ladder</div><div style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:6px">' +
      [0, 1, 2].map(function (i) {
        var hit = step > i, cur = step === i + 1, c = C.stepColor(i + 1);
        return '<div style="padding:7px 9px;border-radius:5px;border:1px solid ' + (hit ? c : 'var(--line)') + ';background:' + (cur ? 'var(--bg)' : 'transparent') + ';display:flex;flex-direction:column;gap:2px;min-width:0"><span style="font:600 10.5px var(--font);color:' + (hit ? c : 'var(--muted)') + '">Step ' + (i + 1) + ' · ' + C.dur(lad[i]) + '</span><span style="font:400 10.5px var(--font);color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + C.esc(who[i]) + '</span></div>';
      }).join('') + '</div><span style="font:500 11.5px var(--font);color:' + (stopped ? 'var(--dim)' : step ? C.stepColor(step) : 'var(--muted)') + '">' +
      (stopped ? 'Clock stopped — ' + (l.ro_id ? 'in the shop' : appt ? 'booked' : lost ? 'lost' : st.label.toLowerCase()) : 'Quiet ' + C.dur(q) + (step < 3 ? ' · step ' + (step + 1) + ' in ' + C.dur(lad[step] - q) : ' · at the owner')) + '</span></div>';
    var ref = '';
    if (d.referral) {
      var r = d.referral, lock = !r.canEdit;
      ref = '<div style="display:flex;flex-direction:column;gap:8px"><div style="' + LAB + '">Referral</div>' +
        '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;font:400 12px var(--font)"><span data-goref="1" style="color:var(--acc2);cursor:pointer">' + C.esc(r.referrer.name) + '</span><span style="color:var(--dim)">' + C.esc(C.kindLabel(r.referrer.kind)) + '</span><span style="color:var(--muted)">' + C.esc(r.label) + '</span></div>' +
        (r.feeCents !== null ? '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;font:400 12px var(--font)">' +
          '<label style="display:flex;gap:5px;align-items:center;color:var(--muted)"><input type="checkbox" id="lNoFee"' + (r.noFee ? ' checked' : '') + (lock ? ' disabled' : '') + '> No fee</label>' +
          '<span style="color:var(--dim)">Fee $</span><input id="lFee" type="number" min="0" value="' + (r.feeCents ? (r.feeCents / 100) : '') + '"' + (lock || r.noFee ? ' disabled' : '') + ' style="width:80px;' + INP + ';font-size:12px;padding:5px 8px">' +
          (r.referrer.kind === 'dealer' ? '<span style="color:var(--dim)">to</span><input id="lPayee" value="' + C.esc(r.payee || '') + '"' + (lock ? ' disabled' : '') + ' style="width:150px;' + INP + ';font-size:12px;padding:5px 8px">' : '') +
          (!lock ? '<span id="lRefSave" style="font:500 11px var(--font);color:var(--acc);cursor:pointer">Save</span>' : '') + '</div>' : '') +
        (r.state === 'held' && r.canEdit ? '<div style="display:flex;gap:8px;align-items:center;font:400 12px var(--font)">Total loss — pay the fee?<span data-tl="pay" style="font:500 11px var(--font);color:var(--acc);border:1px solid var(--acc);border-radius:4px;padding:4px 9px;cursor:pointer">Pay it</span><span data-tl="none" style="font:500 11px var(--font);color:var(--muted);border:1px solid var(--line);border-radius:4px;padding:4px 9px;cursor:pointer">No fee</span></div>' : '') + '</div>';
    }
    var tl = (d.events || []);
    var tlH = '<div style="display:flex;align-items:baseline;gap:10px;padding-bottom:6px"><div style="' + LAB + '">Timeline</div><span style="font:400 11px var(--font);color:var(--dim)">' + tl.length + ' entries</span></div>' +
      tl.map(function (e) {
        var auto = e.kind === 'auto';
        return '<div style="display:flex;gap:10px;padding:8px 10px;border:' + (auto ? '1px solid transparent' : '1px solid var(--whisper)') + ';border-radius:5px"><span style="width:7px;height:7px;border-radius:50%;margin-top:5px;flex:none;background:' + (auto ? 'var(--dim)' : String(e.body || '').indexOf('# ') === 0 ? 'oklch(0.74 0.12 310)' : 'var(--acc)') + '"></span>' +
          '<div style="display:flex;flex-direction:column;gap:2px;min-width:0"><div style="display:flex;gap:8px;font:400 10.5px var(--font);color:var(--dim);flex-wrap:wrap"><span>' + C.esc(C.stamp(e.created_at)) + '</span><span>' + (auto ? 'System' : 'Touch') + '</span><span>' + C.esc(e.user_name || '') + '</span></div>' +
          '<span style="font:400 12px/1.45 var(--font);text-wrap:pretty">' + C.esc(e.body) + '</span></div></div>';
      }).join('');
    var cols = L.full ? '440px minmax(0,1fr)' : 'minmax(0,1fr)';
    host().innerHTML = shell(
      '<div style="flex:none;padding:14px 20px;border-bottom:1px solid var(--line);display:flex;align-items:flex-start;gap:12px"><div style="display:flex;flex-direction:column;gap:5px;min-width:0">' +
      '<div style="display:flex;align-items:center;gap:10px"><span style="font:500 18px var(--font)">' + C.esc(name) + '</span>' + C.code(st) + '</div>' +
      '<span style="font:400 11.5px var(--font);color:var(--muted)">' + C.esc(ln.label + ' · ' + detail) + '</span></div>' +
      '<div style="margin-left:auto;display:flex;gap:6px;flex:none"><span data-act="full" style="font:500 11px var(--font);color:var(--dim);border:1px solid var(--line);border-radius:4px;padding:5px 10px;cursor:pointer">' + (L.full ? 'Dock' : 'Full page') + '</span>' +
      '<span data-act="close" style="font:500 13px var(--font);color:var(--dim);border:1px solid var(--line);border-radius:4px;padding:3px 9px;cursor:pointer">×</span></div></div>' +
      '<div style="flex:1;overflow-y:auto"><div style="display:grid;grid-template-columns:' + cols + ';max-width:' + (L.full ? '1240px' : 'none') + ';margin:0 auto">' +
      '<div style="padding:16px 20px 22px;display:flex;flex-direction:column;gap:18px;min-width:0"><div style="display:flex;gap:6px;flex-wrap:wrap">' + actH + '</div>' + comp + grid + extra + steps + ref + '</div>' +
      '<div style="padding:16px 20px 30px;display:flex;flex-direction:column;gap:2px;min-width:0;border-top:' + (L.full ? 'none' : '1px solid var(--line)') + ';border-left:' + (L.full ? '1px solid var(--line)' : 'none') + '">' + tlH + '</div></div></div>');
    wire();
  }
  function after(msg) { if (msg) C.toast(msg); draw(); C.refresh(); }
  function wire() {
    var el = host(), l = L.d.lead;
    C.each(el, '[data-act]', function (b) {
      b.addEventListener('click', function () {
        var a = b.dataset.act;
        if (a === 'close') return C.closeLead();
        if (a === 'full') { L.full = !L.full; return paint(); }
        if (a === 'cancelComp') { L.comp = null; return paint(); }
        if (a === 'call' || a === 'email' || a === 'note') { L.comp = a; L.cb = a === 'call' ? 'tom' : ''; paint(); var t = el.querySelector('#lcText'); if (t) t.focus(); return; }
        if (a === 'book') return C.book(L.d);
        if (a === 'lost') return lostModal(L.d);
        if (a === 'convert') return convert(L.d);
        if (a === 'reopen') return C.api('/api/leads/' + l.id + '/reopen', { method: 'POST' }).then(function () { after('Reopened.'); }).catch(C.fail);
      });
    });
    C.each(el, '[data-cb]', function (b) { b.addEventListener('click', function () { var t = el.querySelector('#lcText').value; L.cb = b.dataset.cb; paint(); el.querySelector('#lcText').value = t; }); });
    var sv = el.querySelector('#lcSave');
    if (sv) sv.addEventListener('click', function () {
      var text = el.querySelector('#lcText').value.trim(), kind = L.comp;
      var label = { call: 'Called', email: 'Email', note: '' }[kind];
      if (!text && kind === 'note') return C.toast('The note is empty.');
      var body = (label ? label + (text ? ': ' : '.') : '') + text;
      var due = null, n = new Date();
      if (L.cb === '2h') due = new Date(n.getTime() + 2 * 36e5);
      if (L.cb === 'tom') { due = new Date(n.getFullYear(), n.getMonth(), n.getDate() + 1, 9, 0); }
      if (L.cb === '2d') due = new Date(n.getTime() + 2 * 864e5);
      var p = due ? C.api('/api/leads/' + l.id + '/callback', { method: 'POST', body: JSON.stringify({ dueAt: due.toISOString(), note: text, how: label || 'Note' }) })
        : C.api('/api/leads/' + l.id + '/notes', { method: 'POST', body: JSON.stringify({ body: body }) });
      p.then(function () { L.comp = null; after('Logged.'); }).catch(C.fail);
    });
    var ow = el.querySelector('#lOwner');
    ow.addEventListener('change', function () {
      var url = ow.value && (C.me.caps.salesManager || C.me.caps.admin) ? '/api/leads/' + l.id + '/handout' : '/api/leads/' + l.id;
      var p = url.indexOf('handout') > 0 ? C.api(url, { method: 'POST', body: JSON.stringify({ userId: Number(ow.value) }) })
        : C.api(url, { method: 'PATCH', body: JSON.stringify({ ownerUserId: ow.value ? Number(ow.value) : null }) });
      p.then(function () { after('Owner changed.'); }).catch(C.fail);
    });
    var st = el.querySelector('#lSt');
    if (st) st.addEventListener('change', function () {
      if (st.value === 'appointment_set') { st.value = L.d.lead.pipe_status || ''; return C.book(L.d); }
      if (st.value === 'not_repairing') { return lostModal(L.d); }
      C.api('/api/leads/' + l.id + '/pipe', { method: 'POST', body: JSON.stringify({ status: st.value }) }).then(function () { after('Status changed.'); }).catch(C.fail);
    });
    C.each(el, '[data-cancel]', function (b) {
      b.addEventListener('click', function () {
        if (!window.confirm('Cancel this appointment?')) return;
        C.api('/api/schedule/' + b.dataset.cancel, { method: 'DELETE' }).then(function () { after('Appointment cancelled. The day has the space back.'); }).catch(C.fail);
      });
    });
    var rs = el.querySelector('#lRefSave');
    if (rs) rs.addEventListener('click', function () {
      var body = { noFee: el.querySelector('#lNoFee').checked };
      if (!body.noFee && el.querySelector('#lFee').value !== '') body.feeCents = Math.round(Number(el.querySelector('#lFee').value) * 100);
      if (el.querySelector('#lPayee')) body.payee = el.querySelector('#lPayee').value;
      C.api('/api/leads/' + l.id + '/referral', { method: 'PATCH', body: JSON.stringify(body) }).then(function () { after('Referral saved.'); }).catch(C.fail);
    });
    var nf = el.querySelector('#lNoFee'); if (nf) nf.addEventListener('change', function () { el.querySelector('#lFee').disabled = nf.checked; });
    C.each(el, '[data-tl]', function (b) { b.addEventListener('click', function () { C.api('/api/leads/' + l.id + '/referral', { method: 'PATCH', body: JSON.stringify({ tlDecision: b.dataset.tl }) }).then(function () { after('Decided.'); }).catch(C.fail); }); });
    C.each(el, '[data-goref]', function (b) { b.addEventListener('click', function () { C.refsState.sel = L.d.referral.referrer.id; C.go('refs'); }); });
  }

  /* ------------------------------------------------------------ modals */
  function modal(width, inner) {
    var m = document.getElementById('crmModal');
    m.innerHTML = '<div data-mx="1" style="position:fixed;inset:0;background:rgba(5,8,14,.62);display:grid;place-items:center;z-index:60"><div data-mstop="1" style="width:' + width + ';max-width:96vw;max-height:90vh;overflow-y:auto;background:var(--surf);border:1px solid var(--line);border-radius:8px;box-shadow:0 20px 50px rgba(0,0,0,.5);padding:22px 24px;display:flex;flex-direction:column;gap:14px">' + inner + '</div></div>';
    m.querySelector('[data-mx]').addEventListener('click', function (e) { if (e.target.dataset.mx) C.closeModal(); });
    C.each(m, '[data-close]', function (b) { b.addEventListener('click', C.closeModal); });
    return m;
  }
  C.closeModal = function () { document.getElementById('crmModal').innerHTML = ''; };

  function lostModal(d) {
    var l = d.lead, name = [l.first_name, l.last_name].filter(Boolean).join(' ') || l.lead_number;
    var m = modal('420px', '<span style="font:500 17px var(--font)">Mark ' + C.esc(name) + ' lost</span>' +
      '<label style="' + FLD + '">Reason<select id="mReason" style="' + INP + '"><option value="">Pick one…</option>' + REASONS.map(function (r) { return '<option>' + r + '</option>'; }).join('') + '</select></label>' +
      '<label style="' + FLD + '">Note, optional<textarea id="mNote" rows="2" style="' + INP + ';resize:vertical"></textarea></label>' +
      '<div style="display:flex;gap:8px;justify-content:flex-end"><span data-close="1" style="font:500 11px var(--font);color:var(--dim);padding:7px 10px;cursor:pointer">Cancel</span><span id="mGo" style="font:500 11px var(--font);color:var(--bg);background:var(--stopped);border-radius:4px;padding:7px 14px;cursor:pointer">Mark lost</span></div>');
    m.querySelector('#mGo').addEventListener('click', function () {
      var r = m.querySelector('#mReason').value, note = m.querySelector('#mNote').value.trim();
      if (!r) return C.toast('Pick a reason.');
      C.api('/api/leads/' + l.id, { method: 'PATCH', body: JSON.stringify({ state: 'lost', lostReason: r }) })
        .then(function () { return C.api('/api/leads/' + l.id + '/pipe', { method: 'POST', body: JSON.stringify({ status: 'not_repairing' }) }); })
        .then(function () { return note ? C.api('/api/leads/' + l.id + '/notes', { method: 'POST', body: JSON.stringify({ body: 'Marked lost: ' + r + '. ' + note }) }) : null; })
        .then(function () { C.closeModal(); after('Marked lost. It stays on the client list and can be reopened.'); }).catch(C.fail);
    });
  }

  function convert(d) {
    var l = d.lead;
    var m = modal('420px', '<span style="font:500 17px var(--font)">Open an RO</span>' +
      '<span style="font:400 12px var(--font);color:var(--muted)">The RO number is the last six of the VIN.</span>' +
      '<label style="' + FLD + '">VIN<input id="cVin" style="' + INP + ';text-transform:uppercase;letter-spacing:.04em" maxlength="17"></label>' +
      '<label style="' + FLD + '">RO number<input id="cRo" style="' + INP + '"></label>' +
      '<div style="display:flex;gap:8px;justify-content:flex-end"><span data-close="1" style="font:500 11px var(--font);color:var(--dim);padding:7px 10px;cursor:pointer">Cancel</span><span id="cGo" style="font:500 11px var(--font);color:var(--bg);background:var(--acc);border-radius:4px;padding:7px 14px;cursor:pointer">Open RO</span></div>');
    var vin = m.querySelector('#cVin'), ro = m.querySelector('#cRo');
    vin.addEventListener('input', function () { var v = vin.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); vin.value = v; if (v.length >= 6) ro.value = v.slice(-6); });
    m.querySelector('#cGo').addEventListener('click', function () {
      if (!ro.value.trim()) return C.toast('An RO number is required.');
      C.api('/api/leads/' + l.id + '/convert', { method: 'POST', body: JSON.stringify({ roNumber: ro.value.trim(), vin: vin.value.trim() || undefined }) })
        .then(function (r) { C.closeModal(); after('RO ' + ro.value.trim() + ' opened. Now a customer.'); if (r && r.roId) setTimeout(function () { if (window.confirm('Open the file on the board?')) location.href = '/board.html?ro=' + r.roId; }, 50); }).catch(C.fail);
    });
  }

  /* Book a drop-off: the next eight working days, hourly 8 to 5, each slot
     showing who is already in it; the day limit is the shop's drop cap. */
  C.book = function (d, override) {
    var l = d.lead, name = [l.first_name, l.last_name].filter(Boolean).join(' ') || l.lead_number;
    var cur = (d.appointments || []).filter(function (a) { return !a.cancelled_at && new Date(a.starts_at) >= new Date(); })[0];
    var from = new Date(); var iso = function (x) { return x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0'); };
    C.api('/api/schedule?from=' + iso(from) + '&days=14').then(function (s) {
      var cap = Number(s.capacity.drop || 6), days = [], x = new Date(from);
      while (days.length < 8) { if (x.getDay() !== 0 && x.getDay() !== 6) days.push(new Date(x)); x.setDate(x.getDate() + 1); }
      var pick = null;
      var render = function () {
        var h = '<div style="display:flex;align-items:baseline;gap:12px"><span style="font:500 17px var(--font)">Book a drop-off</span><span style="font:400 12px var(--font);color:var(--muted)">' + C.esc(name + ' · ' + (l.vehicle_text || '')) + '</span>' +
          (cur ? '<span style="font:400 11.5px var(--font);color:var(--dim)">Now ' + C.esc(C.when(new Date(cur.starts_at))) + '</span>' : '') + '<span data-close="1" style="margin-left:auto;color:var(--dim);cursor:pointer;font:500 14px var(--font)">×</span></div>' +
          '<div style="display:grid;grid-template-columns:repeat(8,minmax(0,1fr));gap:6px">' + days.map(function (day) {
            var key = iso(day), used = (s.used[key] || {}).drop || 0, full = used >= cap;
            var appts = s.appointments.filter(function (a) { return iso(new Date(a.starts_at)) === key && a.kind === 'drop'; });
            var slots = [];
            for (var hr = 8; hr <= 16; hr++) {
              var at = new Date(day.getFullYear(), day.getMonth(), day.getDate(), hr, 0), past = at < new Date();
              var here = appts.filter(function (a) { return new Date(a.starts_at).getHours() === hr; });
              var on = pick && pick.getTime() === at.getTime(), dis = past || (full && !on);
              slots.push('<div data-slot="' + at.getTime() + '"' + (dis ? ' data-dis="1"' : '') + ' style="padding:5px 6px;border-radius:4px;border:1px solid ' + (on ? 'var(--acc)' : 'var(--line)') + ';background:' + (on ? 'var(--chip)' : dis ? 'transparent' : 'var(--bg)') + ';cursor:' + (dis ? 'default' : 'pointer') + ';display:flex;flex-direction:column;gap:1px;min-height:30px;box-sizing:border-box;opacity:' + (dis ? '.45' : '1') + '">' +
                '<span style="font:500 11px var(--font);color:' + (on ? 'var(--acc)' : 'var(--text)') + '">' + C.clock(at) + '</span><span style="font:400 9.5px var(--font);color:var(--dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + C.esc(here.map(function (a) { return a.customer_name || a.lead_number || ''; }).join(', ')) + '</span></div>');
            }
            return '<div style="display:flex;flex-direction:column;gap:4px;min-width:0"><div style="padding:6px 4px;text-align:center;display:flex;flex-direction:column;gap:2px;border-bottom:1px solid var(--line)"><span style="font:500 12px var(--font)">' + day.toLocaleDateString('en-US', { weekday: 'short', day: 'numeric' }) + '</span>' +
              '<span style="font:400 10.5px var(--font);color:' + (full ? 'var(--stopped)' : 'var(--dim)') + '">' + (full ? 'Full' : (cap - used) + ' left') + '</span></div>' + slots.join('') + '</div>';
          }).join('') + '</div>' +
          '<div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap"><span style="font:400 11px var(--font);color:var(--dim)">Day limit ' + cap + ' drop-offs, shared with the web booking form and the RO board.</span>' +
          '<select id="bWho" style="' + INP + ';font-size:11.5px;padding:5px 8px"><option value="">Assigned to…</option>' + (C.staff || []).map(function (p) { return '<option value="' + p.userId + '"' + (Number(l.owner_user_id) === p.userId ? ' selected' : '') + '>' + C.esc(p.name) + '</option>'; }).join('') + '</select>' +
          '<span style="margin-left:auto;font:500 12px var(--font)">' + (pick ? C.esc(C.when(pick)) : 'Pick a slot') + '</span>' +
          '<span id="bGo" style="font:500 11.5px var(--font);color:var(--bg);background:var(--acc);border-radius:4px;padding:8px 16px;cursor:pointer;opacity:' + (pick ? 1 : .4) + '">Book</span></div>';
        var m = modal('1060px', h);
        C.each(m, '[data-slot]', function (b) { if (!b.dataset.dis) b.addEventListener('click', function () { pick = new Date(Number(b.dataset.slot)); render(); }); });
        m.querySelector('#bGo').addEventListener('click', function () { if (pick) go(false, m); });
      };
      var go = function (ov, m) {
        var p = function (n) { return String(n).padStart(2, '0'); };
        var body = { startsAt: iso(pick) + ' ' + p(pick.getHours()) + ':' + p(pick.getMinutes()) + ':00', kind: 'drop', durationMin: 30, override: ov,
          assignedUserId: m.querySelector('#bWho').value ? Number(m.querySelector('#bWho').value) : undefined };
        var pre = cur ? C.api('/api/schedule/' + cur.id, { method: 'DELETE' }) : Promise.resolve();
        pre.then(function () { return C.api('/api/leads/' + l.id + '/appointment', { method: 'POST', body: JSON.stringify(body) }); })
          .then(function () { C.closeModal(); after((cur ? 'Drop-off moved to ' : 'Drop-off booked for ') + C.when(pick) + '.'); })
          .catch(function (e) {
            var x = e.data || {};
            if ((x.outsideHours || x.full || x.conflict) && x.canOverride && window.confirm((e.message || 'Outside the rules') + '\n\nBook it anyway?')) return go(true, m);
            C.fail(e);
          });
      };
      render();
    }).catch(C.fail);
  };

  /* New lead, as mocked: source tabs, the fields, referrer and fee for a
     referral, and where it goes. Matching on phone/email against referrers and
     clients happens when a new referrer is typed. */
  C.newLead = function () {
    var N = { src: 'phone', ref: '', newRef: false };
    var SRC = [['website', 'Internet'], ['walk-in', 'Walk-in'], ['phone', 'Phone'], ['referral', 'Referral'], ['sales app', 'Field sales']];
    C.api('/api/referrers').then(function (rd) {
      var refs = rd.referrers;
      var render = function () {
        var keep = {}; var mm = document.getElementById('crmModal');
        ['nName', 'nPhone', 'nEmail', 'nVeh', 'nVin', 'nNote', 'nCamp', 'nFee', 'nPayee', 'rName', 'rPhone', 'rEmail', 'rCompany', 'rKind', 'nRep'].forEach(function (k) { var e = mm.querySelector('#' + k); if (e) keep[k] = e.value; });
        var lane = C.laneOfSource(N.src), f = refs.filter(function (r) { return String(r.id) === String(N.ref); })[0];
        var h = '<div style="display:flex;align-items:center"><span style="font:500 18px var(--font)">New lead</span><span data-close="1" style="margin-left:auto;color:var(--dim);cursor:pointer;font:500 14px var(--font)">×</span></div>' +
          C.seg(SRC, N.src, 'data-nsrc') +
          '<div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px">' +
          '<label style="' + FLD + '">Name<input id="nName" style="' + INP + '"></label><label style="' + FLD + '">Phone<input id="nPhone" style="' + INP + '"></label>' +
          '<label style="' + FLD + '">Email<input id="nEmail" style="' + INP + '"></label><label style="' + FLD + '">Vehicle<input id="nVeh" placeholder="2021 Honda CR-V" style="' + INP + '"></label>' +
          '<label style="' + FLD + '">VIN, if you have it<input id="nVin" style="' + INP + ';text-transform:uppercase"></label>' +
          (N.src === 'website' ? '<label style="' + FLD + '">Campaign<input id="nCamp" placeholder="Google Ads · Hail, Plano" style="' + INP + '"></label>' : '') +
          (N.src === 'sales app' ? '<label style="' + FLD + '">Written by<select id="nRep" style="' + INP + '">' + (C.staff || []).map(function (s) { return '<option value="' + s.userId + '"' + (s.userId === C.me.id ? ' selected' : '') + '>' + C.esc(s.name) + '</option>'; }).join('') + '</select></label>' : '') + '</div>';
        if (N.src === 'referral') {
          h += '<div style="display:grid;grid-template-columns:minmax(0,2fr) 90px minmax(0,1fr);gap:12px">' +
            '<label style="' + FLD + '">Referrer<select id="nRef" style="' + INP + '"><option value="">Pick one…</option>' + refs.map(function (r) { return '<option value="' + r.id + '"' + (String(r.id) === String(N.ref) ? ' selected' : '') + '>' + C.esc(r.name + (r.company ? ' · ' + r.company : '') + ' · ' + C.kindLabel(r.kind)) + '</option>'; }).join('') + '<option value="new"' + (N.newRef ? ' selected' : '') + '>New referrer…</option></select></label>' +
            '<label style="' + FLD + '">Fee $<input id="nFee" type="number" min="0" placeholder="' + (f && f.default_fee_cents != null ? (f.default_fee_cents / 100) : '') + '" style="' + INP + '"></label>' +
            ((f && f.kind === 'dealer') || (N.newRef && keep.rKind === 'dealer') ? '<label style="' + FLD + '">Paid to<input id="nPayee" placeholder="' + C.esc((f && f.payee_default) || 'GM, service director…') + '" style="' + INP + '"></label>' : '<span></span>') + '</div>' +
            '<label style="display:flex;gap:6px;align-items:center;font:400 11.5px var(--font);color:var(--muted)"><input type="checkbox" id="nNoFee"> No fee on this one</label>';
          if (N.newRef) h += '<div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;padding:12px;border:1px solid var(--line);border-radius:6px">' +
            '<label style="' + FLD + '">Type<select id="rKind" style="' + INP + '">' + [['agent', 'Insurance agent'], ['adjuster', 'Adjuster / carrier'], ['dealer', 'Dealer'], ['past_customer', 'Past customer']].map(function (k) { return '<option value="' + k[0] + '">' + k[1] + '</option>'; }).join('') + '</select></label>' +
            '<label style="' + FLD + '">Referrer name<input id="rName" style="' + INP + '"></label><label style="' + FLD + '">Their phone<input id="rPhone" style="' + INP + '"></label>' +
            '<label style="' + FLD + '">Their email<input id="rEmail" style="' + INP + '"></label><label style="' + FLD + ';grid-column:1/-1">Company / agency<input id="rCompany" style="' + INP + '"></label>' +
            '<div id="rMatch" style="grid-column:1/-1"></div></div>';
        }
        h += '<label style="' + FLD + '">Note<textarea id="nNote" rows="2" style="' + INP + ';resize:vertical"></textarea></label>' +
          '<div style="display:flex;align-items:center;gap:12px;padding-top:4px;border-top:1px solid var(--line)"><span style="font:400 11.5px var(--font);color:var(--muted);padding-top:12px">Goes to ' + C.esc(N.src === 'sales app' ? 'the rep who wrote it' : (lane.route || 'sales managers, round robin').toLowerCase()) + '</span>' +
          '<span id="nGo" style="margin-left:auto;margin-top:12px;font:500 11.5px var(--font);color:var(--bg);background:var(--acc);border-radius:4px;padding:8px 16px;cursor:pointer">Create lead</span></div>';
        var m = modal('620px', h);
        Object.keys(keep).forEach(function (k) { var e = m.querySelector('#' + k); if (e) e.value = keep[k]; });
        C.each(m, '[data-nsrc]', function (b) { b.addEventListener('click', function () { N.src = b.dataset.nsrc; render(); }); });
        var rs = m.querySelector('#nRef'); if (rs) rs.addEventListener('change', function () { N.newRef = rs.value === 'new'; N.ref = N.newRef ? '' : rs.value; render(); });
        var rk = m.querySelector('#rKind'); if (rk) rk.addEventListener('change', render);
        var check = function () {
          var q = 'phone=' + encodeURIComponent(m.querySelector('#rPhone').value) + '&email=' + encodeURIComponent(m.querySelector('#rEmail').value) + '&name=' + encodeURIComponent(m.querySelector('#rName').value);
          C.api('/api/referrers/match?' + q).then(function (x) {
            var box = m.querySelector('#rMatch'), out = [];
            x.referrers.forEach(function (r, i) { out.push('<div style="padding:8px;border:1px solid var(--acc2);border-radius:6px;font:400 12px var(--font)"><b>Already a referrer</b> — ' + C.esc(r.name) + ' <span data-use="' + i + '" style="color:var(--acc);cursor:pointer;margin-left:6px">Use them</span></div>'); });
            if (!x.referrers.length) x.clients.forEach(function (c, i) { out.push('<div style="padding:8px;border:1px solid var(--acc2);border-radius:6px;font:400 12px var(--font)"><b>Person already exists</b> — ' + C.esc(c.name) + (c.address ? ', ' + C.esc(c.address) : '') + '. Convert to referrer? <span data-conv="' + i + '" style="color:var(--acc);cursor:pointer;margin-left:6px">Yes</span> <span data-not="1" style="color:var(--dim);cursor:pointer;margin-left:6px">Not the same person</span></div>'); });
            box.innerHTML = out.join('');
            C.each(box, '[data-use]', function (b) { b.addEventListener('click', function () { var r = x.referrers[Number(b.dataset.use)]; refs.push(r); N.ref = r.id; N.newRef = false; render(); }); });
            C.each(box, '[data-conv]', function (b) { b.addEventListener('click', function () {
              C.api('/api/referrers', { method: 'POST', body: JSON.stringify({ fromClientId: x.clients[Number(b.dataset.conv)].id }) }).then(function (r) { return C.api('/api/referrers?q=' + encodeURIComponent(x.clients[Number(b.dataset.conv)].name)).then(function (q2) {
                refs = q2.referrers.concat(refs); N.ref = r.id; N.newRef = false; C.toast('Converted — their details came across from the client list.'); render(); }); }).catch(C.fail); }); });
            C.each(box, '[data-not]', function (b) { b.addEventListener('click', function () { box.innerHTML = ''; }); });
          }).catch(function () {});
        };
        ['#rPhone', '#rEmail'].forEach(function (k) { var e = m.querySelector(k); if (e) e.addEventListener('blur', check); });
        m.querySelector('#nGo').addEventListener('click', function () {
          var nm = m.querySelector('#nName').value.trim().split(/\s+/), first = nm.length > 1 ? nm.slice(0, -1).join(' ') : '', last = nm[nm.length - 1] || '';
          var body = { firstName: first || undefined, lastName: last || undefined, phone: m.querySelector('#nPhone').value.trim() || undefined, email: m.querySelector('#nEmail').value.trim() || undefined,
            vehicleText: [m.querySelector('#nVeh').value.trim(), m.querySelector('#nVin').value.trim().toUpperCase()].filter(Boolean).join(' · ') || undefined,
            damageNote: m.querySelector('#nNote').value.trim() || undefined, source: N.src,
            campaign: m.querySelector('#nCamp') ? m.querySelector('#nCamp').value.trim() || undefined : undefined };
          if (N.src === 'sales app' && m.querySelector('#nRep')) body.ownerUserId = Number(m.querySelector('#nRep').value);
          if (N.src === 'referral') {
            var noFee = m.querySelector('#nNoFee').checked, fee = m.querySelector('#nFee').value;
            body.referral = { noFee: noFee, feeCents: noFee || fee === '' ? undefined : Math.round(Number(fee) * 100), payee: m.querySelector('#nPayee') ? m.querySelector('#nPayee').value.trim() || undefined : undefined };
            if (N.newRef) body.referral.newReferrer = { kind: m.querySelector('#rKind').value, name: m.querySelector('#rName').value.trim(), phone: m.querySelector('#rPhone').value.trim(), email: m.querySelector('#rEmail').value.trim(), company: m.querySelector('#rCompany').value.trim() };
            else if (N.ref) body.referral.referrerId = Number(N.ref);
          }
          C.api('/api/leads', { method: 'POST', body: JSON.stringify(body) }).then(function (r) {
            C.closeModal(); C.toast('Lead created.'); C.refresh(); C.openLead(r.id);
          }).catch(C.fail);
        });
      };
      modal('620px', ''); render();
    }).catch(C.fail);
  };
})();
