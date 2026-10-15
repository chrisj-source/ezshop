/* Leads › Web requests, in the CRM's own layout: requests from the shop's
   website booking form. A held drop-off owns a real appointment from the
   moment it is submitted; Confirm books it and tells the customer, Decline
   releases the slot and leaves the lead to ring. */
(function () {
  var C = window.CRM;
  var S = { tab: 'waiting', D: null };
  C.webState = S;
  C.webToolbar = function () {
    return C.seg([['waiting', 'Waiting' + (S.D ? ' ' + S.D.waiting : '')], ['closed', 'Lapsed and declined'], ['all', 'Everything']], S.tab, 'data-wtab') +
      (S.D && S.D.expiring ? '<span style="font:500 11px var(--font);color:var(--stopped)">' + S.D.expiring + ' hold' + (S.D.expiring === 1 ? '' : 's') + ' running out</span>' : '');
  };
  C.wireWebToolbar = function (bar) {
    C.each(bar, '[data-wtab]', function (b) { b.addEventListener('click', function () { S.tab = b.dataset.wtab; S.D = null; C.render(); }); });
  };
  C.views.web = function (el) {
    if (!S.D) el.innerHTML = C.loading();
    return C.api('/api/web-requests?tab=' + S.tab).then(function (d) { S.D = d; C.refreshToolbar(); paint(el); });
  };
  var GRID = 'display:grid;grid-template-columns:minmax(0,1fr) 190px 150px 230px;';
  var TH = 'padding:9px 12px;font:600 8.5px var(--font);letter-spacing:.13em;text-transform:uppercase;color:var(--dim)';
  function tag(t, c) { return '<span style="font:600 9px var(--font);letter-spacing:.05em;padding:1px 6px;border-radius:3px;color:' + c + ';border:1px solid ' + c + ';white-space:nowrap">' + t + '</span>'; }
  function paint(el) {
    var D = S.D;
    var h = '<div style="flex:1;min-height:0;overflow-y:auto"><div style="' + GRID + 'position:sticky;top:0;background:var(--bg);border-bottom:1px solid var(--line);z-index:2">' +
      '<span style="' + TH + ';padding-left:18px">Customer</span><span style="' + TH + '">Asked for</span><span style="' + TH + '">Hold</span><span style="' + TH + ';text-align:right;padding-right:18px">Answer</span></div>';
    if (!D.requests.length) h += '<div style="padding:28px 18px;font:400 12px var(--font);color:var(--dim)">' + (S.tab === 'waiting' ? 'Nothing waiting. Requests arrive the moment somebody submits the form on your website.' : 'Nothing here.') + '</div>';
    h += D.requests.map(function (r) {
      var tone = r.state === 'held' ? 'var(--acc)' : r.state === 'confirmed' || r.state === 'booked' ? 'var(--done)' : 'var(--dim)';
      var mins = Number(r.hold_minutes), expiring = r.state === 'held' && r.hold_minutes != null && mins < 240;
      var hold = r.state === 'held' ? (mins <= 0 ? 'expired' : C.dur(mins) + ' left') : r.state === 'booked' ? 'on the schedule' : r.state === 'confirmed' ? 'confirmed' : r.state === 'declined' ? 'slot released' : 'lapsed';
      var tags = [];
      if (r.ro_number) tags.push('<a href="/board.html?ro=' + Number(r.ro_file_id) + '" style="text-decoration:none">' + tag('CAR IS HERE · RO ' + C.esc(r.ro_number), 'var(--stopped)') + '</a>');
      if (r.client_id && !r.lead_id) tags.push(tag('RETURNING', 'var(--move)'));
      if (r.conflicted_at) tags.push(tag('CLASH', 'var(--stopped)'));
      var lines = [];
      if (r.what_happened) lines.push('<span style="font:400 11.5px/1.45 var(--font);color:var(--text)">' + C.esc(r.what_happened) + '</span>');
      if (r.answers && r.answers.length) lines.push('<span style="font:400 11px var(--font);color:var(--muted)">' + r.answers.map(function (a) { return C.esc(a.label) + ': ' + C.esc(a.value); }).join(' · ') + '</span>');
      if (Number(r.suppressed)) lines.push('<span style="font:400 11px var(--font);color:var(--stopped)">That address has unsubscribed, so nothing was emailed. They were told you would call.</span>');
      if (r.sms_consent != null) lines.push(Number(r.sms_consent) === 1 ? '<span style="font:400 11px var(--font);color:var(--done)">Agreed to be texted.</span>'
        : '<span style="font:400 11px var(--font);color:var(--stopped)">Asked and did not agree to texts. Ring them, and messages about this appointment only.</span>');
      var act;
      if (!D.canAnswer || r.answered_at) act = '<span style="font:400 11px var(--font);color:var(--dim)">' + (r.answered_at ? 'answered' + (r.answered_name ? ' by ' + C.esc(r.answered_name) : '') : 'read only') + '</span>';
      else if (r.state === 'lapsed' || r.state === 'declined') act = r.lead_id ? '<span data-wlead="' + r.lead_id + '" style="font:500 11px var(--font);color:var(--text);border:1px solid var(--line);border-radius:4px;padding:6px 11px;cursor:pointer">Open the lead</span>' : '';
      else act = '<span data-wact="confirm" data-wid="' + r.id + '" style="font:500 11px var(--font);color:var(--bg);background:var(--acc);border-radius:4px;padding:6px 12px;cursor:pointer">Confirm</span>' +
        '<span data-wact="decline" data-wid="' + r.id + '" style="font:500 11px var(--font);color:var(--stopped);border:1px solid var(--stopped);border-radius:4px;padding:6px 11px;cursor:pointer">Decline</span>' +
        (r.ro_number ? '<span data-wact="note" data-wid="' + r.id + '" style="font:500 11px var(--font);color:var(--muted);border:1px solid var(--line);border-radius:4px;padding:6px 11px;cursor:pointer">Just answered it</span>' : '');
      return '<div style="' + GRID + 'align-items:start;border-bottom:1px solid var(--whisper);box-shadow:inset 3px 0 0 ' + tone + ';opacity:' + (r.state === 'lapsed' ? '.65' : '1') + '">' +
        '<div style="padding:11px 12px 11px 18px;display:flex;flex-direction:column;gap:4px;min-width:0">' +
          '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap"><span' + (r.lead_id ? ' data-wlead="' + r.lead_id + '"' : '') + ' style="font:500 12.5px var(--font);' + (r.lead_id ? 'cursor:pointer' : '') + '">' + C.esc(r.name || 'No name') + '</span>' + tags.join('') + '</div>' +
          '<span style="font:400 10.5px var(--font);color:var(--dim)">' + C.esc([r.vehicle_text || 'Vehicle not given', C.phone(r.phone), r.email].filter(Boolean).join(' · ')) + '</span>' + lines.join('') + '</div>' +
        '<div style="padding:11px 12px;display:flex;flex-direction:column;gap:3px"><span style="font:500 12px var(--font);color:' + tone + '">' + (r.purpose === 'drop' ? 'Drop-off' : 'Estimate') + '</span><span style="font:400 11.5px var(--font);color:var(--muted)">' + C.esc(C.when(new Date(String(r.starts_at).replace(' ', 'T')))) + '</span></div>' +
        '<div style="padding:11px 12px;display:flex;flex-direction:column;gap:3px"><span style="font:500 12px var(--font);color:' + (expiring ? 'var(--stopped)' : 'var(--muted)') + '">' + C.esc(hold) + '</span><span style="font:400 10.5px var(--font);color:var(--dim)">' + C.esc(r.campaign || 'no campaign tag') + '</span></div>' +
        '<div style="padding:10px 18px 10px 12px;display:flex;gap:6px;justify-content:flex-end;flex-wrap:wrap">' + act + '</div></div>';
    }).join('');
    h += '<div style="font:400 11px/1.6 var(--font);color:var(--dim);padding:12px 18px">Confirming books it properly and tells the customer. Declining releases the slot and leaves the lead — ring them. Nothing is emailed on a decline; that is a phone call.</div></div>';
    el.innerHTML = h;
    C.each(el, '[data-wlead]', function (b) { b.addEventListener('click', function () { C.openLead(Number(b.dataset.wlead)); }); });
    C.each(el, '[data-wact]', function (b) {
      b.addEventListener('click', function () {
        if (b.dataset.wact === 'decline' && !window.confirm('Release the slot and leave the lead open to chase?')) return;
        C.api('/api/web-requests/' + b.dataset.wid + '/' + b.dataset.wact, { method: 'POST' })
          .then(function () { C.toast(b.dataset.wact === 'confirm' ? 'Confirmed — on the schedule, and the customer is told.' : b.dataset.wact === 'decline' ? 'Declined. The slot is free; ring them.' : 'Marked answered.'); S.D = null; C.render(); })
          .catch(C.fail);
      });
    });
  }
})();
