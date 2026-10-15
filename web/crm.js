/* The CRM, as mocked (CRM Prototype): Leads › Pipeline / Tasks / Referrers,
   Clients, the docked lead record and its modals. This file is the shell and
   the pipeline; crm-tasks.js, crm-refs.js, crm-clients.js and crm-lead.js add
   the rest. Everything reads the live API. */
(function () {
  var C = window.CRM = { views: {}, sel: null, meta: { statuses: {}, always: [], parked: [], closed: [] }, lanes: [], staff: [] };
  C.esc = Shell.esc;
  C.api = Shell.api;
  C.each = function (el, sel, fn) { Array.prototype.forEach.call(el.querySelectorAll(sel), fn); };
  C.money = function (c) { return c == null ? '—' : '$' + (Number(c) / 100).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 }); };
  C.dur = function (m) {
    m = Math.max(0, Math.round(Number(m) || 0));
    if (m < 60) return m + 'm';
    if (m < 1440) return Math.floor(m / 60) + 'h' + (m % 60 ? m % 60 + 'm' : '');
    var h = Math.floor((m % 1440) / 60);
    return Math.floor(m / 1440) + 'd' + (h ? h + 'h' : '');
  };
  C.clock = function (d) { var h = d.getHours(), m = d.getMinutes(); return ((h % 12) || 12) + (m ? ':' + String(m).padStart(2, '0') : '') + ' ' + (h < 12 ? 'AM' : 'PM'); };
  C.when = function (d) {
    d = d instanceof Date ? d : new Date(d);
    var t = new Date(); t.setHours(0, 0, 0, 0);
    var dd = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()) - t) / 864e5);
    return (dd === 0 ? 'Today ' : dd === 1 ? 'Tomorrow ' : dd === -1 ? 'Yesterday ' : d.toLocaleDateString('en-US', { weekday: 'short', day: 'numeric', month: 'short' }) + ' ') + C.clock(d);
  };
  C.day = function (v) { return new Date(v).toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: '2-digit' }); };
  C.stamp = function (v) { return v ? C.when(new Date(v)) : ''; };
  C.phone = function (p) { var d = String(p || '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, ''); return d.length === 10 ? '(' + d.slice(0, 3) + ') ' + d.slice(3, 6) + '-' + d.slice(6) : (p || ''); };
  C.kindLabel = function (k) { return { agent: 'Insurance agent', adjuster: 'Adjuster / carrier', dealer: 'Dealer', past_customer: 'Past customer' }[k] || k || ''; };
  C.stepColor = function (s) { return ['var(--dim)', 'var(--acc)', 'oklch(0.76 0.13 55)', 'var(--stopped)'][s] || 'var(--dim)'; };
  C.statusOf = function (k) { return C.meta.statuses[k] || { key: k, label: k, code: '?', tone: 'var(--dim)' }; };
  C.laneOfSource = function (src) {
    var s = String(src || '').toLowerCase();
    return C.lanes.filter(function (l) { return (l.sources || []).indexOf(s) >= 0; })[0] || C.lanes.filter(function (l) { return l.key === 'phone'; })[0] || { key: 'phone', label: 'Phone', statuses: [], ladderMin: [60, 240, 1440] };
  };
  C.person = function (id) { var p = (C.staff || []).filter(function (s) { return s.userId === id; })[0]; return p ? p.name : 'Unassigned'; };
  C.code = function (s) { return '<span style="font:600 9px var(--font);letter-spacing:.05em;padding:1px 0;border-radius:3px;width:46px;text-align:center;flex:none;color:' + s.tone + ';border:1px solid ' + s.tone + '">' + C.esc(s.code) + '</span>'; };
  C.seg = function (items, cur, attr) {
    return '<div style="display:flex;border:1px solid var(--line);border-radius:4px;overflow:hidden;flex:none">' + items.map(function (m) {
      var on = m[0] === cur;
      return '<span ' + attr + '="' + C.esc(m[0]) + '" style="font:400 11.5px var(--font);padding:6px 12px;cursor:pointer;white-space:nowrap;font-variant-numeric:tabular-nums;background:' + (on ? 'var(--acc)' : 'transparent') + ';color:' + (on ? 'var(--bg)' : 'var(--muted)') + '">' + m[1] + '</span>';
    }).join('') + '</div>';
  };
  C.toggle = function (id, on, label) { return '<span id="' + id + '" style="font:400 11.5px var(--font);padding:5px 10px;border-radius:4px;cursor:pointer;white-space:nowrap;border:1px solid ' + (on ? 'var(--acc)' : 'var(--line)') + ';color:' + (on ? 'var(--acc)' : 'var(--muted)') + '">' + (on ? '✓ ' : '') + label + '</span>'; };
  C.loading = function () { return '<div style="padding:18px;font:400 12px var(--font);color:var(--dim)">Loading…</div>'; };
  var toastT = null;
  C.toast = function (t) {
    var el = document.getElementById('crmToast');
    el.innerHTML = '<div style="position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:90;display:flex;align-items:center;gap:14px;padding:11px 16px;background:var(--chip);border:1px solid var(--line);border-radius:6px;box-shadow:0 10px 30px rgba(0,0,0,.4);font:400 12px var(--font)">' + C.esc(t) + '</div>';
    clearTimeout(toastT); toastT = setTimeout(function () { el.innerHTML = ''; }, 3200);
  };
  C.fail = function (e) { C.toast(e && e.message ? e.message : 'Something went wrong.'); };

  /* ------------------------------------------------------------ routing */
  var VIEW = 'pipe';
  C.go = function (v, opts) {
    VIEW = v;
    var hash = v === 'pipe' ? '' : '#' + v;
    if (location.hash !== hash) history.replaceState(null, '', location.pathname + hash);
    Shell.mount({ me: C.me, active: v === 'clients' ? 'clients' : 'leads' });
    C.render(opts);
  };
  C.render = function (opts) {
    var onLeads = VIEW !== 'clients';
    document.getElementById('crmBar').style.display = onLeads ? '' : 'none';
    C.refreshToolbar();
    var body = document.getElementById('crmBody');
    var v = C.views[VIEW] || C.views.pipe;
    var p = v(body, opts || {});
    if (p && p.catch) p.catch(function (e) { body.innerHTML = '<div style="padding:18px;color:var(--stopped);font:400 12px var(--font)">' + C.esc(e.message) + '</div>'; });
    if (C.leadState && C.leadState.id && !document.getElementById('crmLead').innerHTML) C.openLead(C.leadState.id);
  };
  C.paintBody = function () {
    var body = document.getElementById('crmBody');
    if (VIEW === 'pipe') return paintPipe(body);
    if (VIEW === 'tasks' && C.tasksState.D) return C.paintTasks(body);
    if (VIEW === 'refs' && C.refsState.D) return C.views.refs(body);
  };
  C.refresh = function () { if (VIEW === 'pipe') PIPE = null; if (VIEW === 'refs' && C.refsState) C.refsState.D = null; C.render(); };
  C.highlight = function () { if (VIEW === 'pipe' && PIPE) paintPipe(document.getElementById('crmBody')); };
  C.refreshToolbar = function () {
    var bar = document.getElementById('crmBar');
    var subs = [['pipe', 'Pipeline'], ['tasks', 'Tasks'], ['refs', 'Referrers']];
    var mid = VIEW === 'tasks' ? C.tasksToolbar() : VIEW === 'refs' ? C.refsToolbar() : pipeToolbar();
    bar.innerHTML = C.seg(subs, VIEW, 'data-sub') + mid + '<div style="margin-left:auto"></div>' +
      (C.me.caps.manageLeads ? '<span id="crmNew" style="font:500 11px var(--font);color:var(--bg);background:var(--acc);border-radius:4px;padding:7px 14px;cursor:pointer;white-space:nowrap">New lead</span>' : '');
    C.each(bar, '[data-sub]', function (b) { b.addEventListener('click', function () { C.go(b.dataset.sub); }); });
    var nl = bar.querySelector('#crmNew'); if (nl) nl.addEventListener('click', C.newLead);
    if (VIEW === 'tasks') C.wireTasksToolbar(bar); else if (VIEW === 'refs') C.wireRefsToolbar(bar); else wirePipeToolbar(bar);
  };

  /* ------------------------------------------------------------ pipeline (1c) */
  var PIPE = null, P = { scope: 'all', q: '', closed: false, park: false };
  function base() { return PIPE ? PIPE.leads.filter(function (l) { return P.park ? l.parked : (!l.parked && (P.closed || !l.closed)); }) : []; }
  function pipeToolbar() {
    var b = base(), me = C.me.id;
    var n = { all: b.length, mine: b.filter(function (l) { return Number(l.owner_user_id) === me; }).length, un: b.filter(function (l) { return !l.owner_user_id; }).length, esc: b.filter(function (l) { return l.step >= 2; }).length };
    return C.seg([['all', 'All ' + n.all], ['mine', 'Mine ' + n.mine], ['un', 'Unassigned ' + n.un], ['esc', 'Escalated ' + n.esc]], P.scope, 'data-scope') +
      '<input id="pq" value="' + C.esc(P.q) + '" placeholder="Find a name, vehicle, phone or RO…" style="width:240px;background:transparent;border:1px solid var(--line);border-radius:4px;color:var(--text);font:400 11.5px var(--font);padding:6px 10px">' +
      C.toggle('pClosed', P.closed, 'Show closed') + C.toggle('pPark', P.park, 'Parked') +
      '<a href="/leads.html?tab=web" style="font:400 11.5px var(--font);padding:5px 10px;border-radius:4px;border:1px solid var(--line);color:var(--muted);text-decoration:none">Web requests</a>' +
      '<a href="/leads.html?tab=all" style="font:400 11.5px var(--font);padding:5px 10px;border-radius:4px;border:1px solid var(--line);color:var(--muted);text-decoration:none">List</a>';
  }
  function wirePipeToolbar(bar) {
    C.each(bar, '[data-scope]', function (b) { b.addEventListener('click', function () { P.scope = b.dataset.scope; C.refreshToolbar(); paintPipe(document.getElementById('crmBody')); }); });
    var q = bar.querySelector('#pq'); if (q) q.addEventListener('input', function () { P.q = q.value; paintPipe(document.getElementById('crmBody')); });
    var c = bar.querySelector('#pClosed'); if (c) c.addEventListener('click', function () { P.closed = !P.closed; C.refreshToolbar(); paintPipe(document.getElementById('crmBody')); });
    var k = bar.querySelector('#pPark'); if (k) k.addEventListener('click', function () { P.park = !P.park; C.refreshToolbar(); paintPipe(document.getElementById('crmBody')); });
  }
  C.views.pipe = function (el) {
    if (!PIPE) el.innerHTML = C.loading();
    return C.api('/api/pipeline').then(function (d) {
      PIPE = d; C.lanes = d.lanes; C.staff = d.staff;
      C.refreshToolbar(); paintPipe(el);
    });
  };
  function paintPipe(el) {
    if (!PIPE) return;
    var q = P.q.trim().toLowerCase(), me = C.me.id;
    var rows = base().filter(function (l) {
      if (P.scope === 'mine' && Number(l.owner_user_id) !== me) return false;
      if (P.scope === 'un' && l.owner_user_id) return false;
      if (P.scope === 'esc' && l.step < 2) return false;
      if (q && [l.lead_number, l.name, l.phone, l.vehicle_text, l.ro_number].join(' ').toLowerCase().indexOf(q) < 0) return false;
      return true;
    });
    var scrollTops = {}; C.each(el, '[data-lanebody]', function (b) { scrollTops[b.dataset.lanebody] = b.scrollTop; });
    el.innerHTML = '<div style="flex:1;min-height:0;display:grid;grid-template-columns:repeat(' + PIPE.lanes.length + ',minmax(0,1fr))">' + PIPE.lanes.map(function (ln) {
      var list = rows.filter(function (l) { return l.lane === ln.key; }), od = list.filter(function (l) { return l.overdue; }).length;
      return '<div style="display:flex;flex-direction:column;min-height:0;min-width:0;border-right:1px solid var(--line)">' +
        '<div style="flex:none;padding:10px 12px;border-bottom:1px solid var(--line);background:var(--surf);display:flex;flex-direction:column;gap:3px">' +
        '<div style="display:flex;align-items:baseline;gap:8px"><span style="font:600 12.5px var(--font)">' + C.esc(ln.label) + '</span><span style="font:500 12px var(--font);color:var(--muted)">' + list.length + '</span>' +
        (od ? '<span style="margin-left:auto;font:500 11px var(--font);color:var(--stopped)">' + od + ' overdue</span>' : '') + '</div>' +
        '<span style="font:400 10.5px var(--font);color:var(--dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + ln.ladderMin.map(function (m) { return C.dur(m); }).join(' · ') + ' · ' + C.esc(ln.route) + '</span></div>' +
        '<div data-lanebody="' + ln.key + '" style="flex:1;overflow-y:auto">' + (list.length ? list.map(function (l) {
          var s = C.statusOf(l.status), flag, fc;
          if (l.next_appt) { flag = C.when(new Date(l.next_appt)); fc = C.statusOf('appointment_set').tone; }
          else if (l.status === 'in_shop' && l.ro_number) { flag = 'RO ' + l.ro_number; fc = s.tone; }
          else if (l.step) { flag = 'S' + l.step + ' ' + C.dur(l.overMin); fc = C.stepColor(l.step); }
          else { flag = C.dur(l.age_min); fc = 'var(--muted)'; }
          var on = C.sel === l.id, bar = on ? 'var(--acc)' : l.step >= 2 ? C.stepColor(l.step) : 'transparent';
          return '<div data-lead="' + l.id + '" style="display:flex;align-items:center;gap:9px;padding:8px 12px 8px 9px;border-bottom:1px solid var(--whisper);border-left:3px solid ' + bar + ';cursor:pointer;background:' + (on ? 'var(--surf)' : 'transparent') + ';opacity:' + (l.closed ? '.55' : '1') + '">' +
            C.code(s) + '<div style="display:flex;flex-direction:column;gap:2px;min-width:0;flex:1"><span style="font:500 12.5px var(--font);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + C.esc(l.name || l.lead_number) + '</span>' +
            '<span style="font:400 10.5px var(--font);color:' + (l.owner_user_id ? 'var(--dim)' : 'var(--acc)') + ';white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + C.esc(l.owner_name || 'Unassigned') + '</span></div>' +
            '<span style="font:500 11px var(--font);color:' + fc + ';white-space:nowrap;align-self:flex-end;padding-bottom:1px">' + C.esc(flag) + '</span></div>';
        }).join('') : '<div style="padding:14px 12px;font:400 11.5px var(--font);color:var(--dim)">Nothing here.</div>') + '</div></div>';
    }).join('') + '</div>';
    C.each(el, '[data-lanebody]', function (b) { if (scrollTops[b.dataset.lanebody]) b.scrollTop = scrollTops[b.dataset.lanebody]; });
    C.each(el, '[data-lead]', function (b) { b.addEventListener('click', function () { C.openLead(Number(b.dataset.lead)); }); });
  }

  /* ------------------------------------------------------------ boot */
  Shell.api('/api/me').then(function (me) {
    C.me = me;
    if (!me.caps.viewLeads) { document.getElementById('crmBody').innerHTML = '<div style="padding:24px;font:400 12px var(--font);color:var(--dim)">Leads and clients are for the sales desk.</div>'; Shell.mount({ me: me, active: 'leads' }); return; }
    return C.api('/api/pipeline/meta').then(function (m) {
      C.meta = { statuses: m.statuses, always: ['appointment_set', 'no_show', 'in_shop', 'not_repairing'], parked: m.parked, closed: ['in_shop', 'not_repairing'].concat(m.parked) };
      C.lanes = m.lanes;
      var h = location.hash.replace('#', ''), lm = /lead=(\d+)/.exec(location.search + '&' + h);
      if (lm) C.leadState.id = Number(lm[1]);
      C.go(['tasks', 'refs', 'clients'].indexOf(h) >= 0 ? h : 'pipe');
      setInterval(function () { if (!document.hidden && !document.getElementById('crmModal').innerHTML) { if (VIEW === 'pipe') C.views.pipe(document.getElementById('crmBody')); else if (VIEW === 'tasks') C.views.tasks(document.getElementById('crmBody')); } }, 90000);
    });
  }).catch(function (e) { if (e.message !== 'signed out') console.error(e); });
  window.addEventListener('keydown', function (e) { if (e.key === 'Escape') { if (document.getElementById('crmModal').innerHTML) C.closeModal(); else if (C.leadState.id) C.closeLead(); } });
})();
