/* Leads › Tasks (5a), as mocked. Unassigned pinned left; By person groups the
   columns under team bands that fold to totals; By team is one column per
   team. Cards are made by the system; Callback by logging a touch. */
(function () {
  var C = window.CRM;
  var KIND = { handout: ['Hand out', '#d9a441'], first_call: ['First call', 'oklch(0.80 0.13 80)'], callback: ['Callback', 'oklch(0.74 0.10 245)'],
    chase_quote: ['Chase quote', 'oklch(0.74 0.12 310)'], confirm_appt: ['Confirm appt', 'oklch(0.76 0.13 150)'], reschedule: ['Reschedule', 'oklch(0.76 0.13 55)'] };
  var S = { mode: 'person', q: '', only: false, fold: {} };
  C.tasksState = S;

  function due(t) {
    var ms = new Date(t.due).getTime() - Date.now();
    if (ms < 0) return { t: C.dur(-ms / 6e4) + ' over', c: 'var(--stopped)' };
    var d = new Date(t.due);
    if (d.toDateString() === new Date().toDateString()) return { t: C.clock(d), c: 'var(--acc)' };
    return { t: C.when(d), c: 'var(--dim)' };
  }
  function card(t, withOwner, unassigned) {
    var k = KIND[t.kind] || [t.kind, 'var(--dim)'], d = due(t), sel = C.sel === t.leadId;
    var h = '<div data-open="' + t.leadId + '" style="margin:0 8px 6px;padding:8px 9px;background:' + (sel ? 'var(--chip)' : 'var(--surf)') + ';border-radius:5px;border-left:3px solid ' + k[1] + ';cursor:pointer;display:flex;flex-direction:column;gap:3px">' +
      '<div style="display:flex;gap:6px;align-items:baseline"><span style="font:600 9px var(--font);letter-spacing:.08em;text-transform:uppercase;color:' + k[1] + '">' + C.esc(k[0]) + (unassigned ? ' · ' + C.esc(t.laneLabel || '') : '') + '</span>' +
      (t.step >= 2 ? '<span style="font:600 9px var(--font);color:var(--stopped)">S' + t.step + '</span>' : '') +
      '<span style="margin-left:auto;font:500 10.5px var(--font);color:' + d.c + '">' + C.esc(d.t) + '</span></div>' +
      '<span style="font:500 12px var(--font)">' + C.esc(t.name || t.leadNumber) + '</span>' +
      '<span style="font:400 10.5px var(--font);color:var(--dim)">' + C.esc([t.vehicle, t.note].filter(Boolean).join(' · ') || t.leadNumber) + '</span>';
    if (withOwner) h += '<span style="font:500 10.5px var(--font);color:var(--acc2)">' + C.esc(C.person(t.userId)) + '</span>';
    if (unassigned && S.D.canHandOut) h += '<div data-stop="1" style="padding-top:3px"><select data-ho="' + t.leadId + '" style="width:100%;background:var(--bg);border:1px solid var(--acc);border-radius:4px;color:var(--acc);font:400 11px var(--font);padding:4px 6px"><option value="">Hand to…</option>' +
      S.D.staff.map(function (s) { return '<option value="' + s.userId + '">' + C.esc(s.name) + '</option>'; }).join('') + '</select></div>';
    if (t.kind === 'callback' && !unassigned) h += '<span data-done="' + t.callbackId + '" data-stop="1" style="align-self:flex-start;font:500 10.5px var(--font);color:var(--done);border:1px solid var(--done);border-radius:4px;padding:2px 8px;margin-top:2px">Done</span>';
    return h + '</div>';
  }
  function counts(list, uids) {
    var od = 0, today = 0, now = Date.now(), td = new Date().toDateString();
    list.forEach(function (t) { var x = new Date(t.due); if (x.getTime() < now) od++; else if (x.toDateString() === td) today++; });
    var done = 0; (uids || []).forEach(function (u) { done += Number(S.D.done[u] || 0); });
    return { od: od, today: today, done: done };
  }

  C.tasksToolbar = function () {
    var D = S.D, all = D ? D.tasks : [], c = D ? counts(all, D.people.map(function (p) { return p.userId; })) : { od: 0, today: 0, done: 0 };
    return C.seg([['person', 'By person'], ['team', 'By team']], S.mode, 'data-tmode') +
      '<input id="tq" value="' + C.esc(S.q) + '" placeholder="Find a person or team…" style="width:200px;background:transparent;border:1px solid var(--line);border-radius:4px;color:var(--text);font:400 11.5px var(--font);padding:6px 10px">' +
      C.toggle('tonly', S.only, 'Only people with overdue') +
      '<div style="display:flex;gap:14px;margin-left:6px;min-width:0;overflow:hidden">' +
      [[c.od, 'overdue', 'var(--stopped)'], [c.today, 'due today', 'var(--acc)'], [c.done, 'done today', 'var(--done)'], [D ? D.tasks.filter(function (t) { return !t.userId; }).length : 0, 'to hand out', 'var(--acc2)']].map(function (k) {
        return '<div style="display:flex;align-items:baseline;gap:6px"><span style="font:500 15px var(--font);font-variant-numeric:tabular-nums;color:' + k[2] + '">' + k[0] + '</span><span style="font:400 10.5px var(--font);color:var(--dim)">' + k[1] + '</span></div>';
      }).join('') + '</div>';
  };
  C.wireTasksToolbar = function (bar) {
    C.each(bar, '[data-tmode]', function (b) { b.addEventListener('click', function () { S.mode = b.dataset.tmode; C.render(); }); });
    var q = bar.querySelector('#tq'); if (q) q.addEventListener('input', function () { S.q = q.value; C.paintBody(); });
    var o = bar.querySelector('#tonly'); if (o) o.addEventListener('click', function () { S.only = !S.only; C.render(); });
  };

  C.views.tasks = function (el) {
    if (!S.D) { el.innerHTML = C.loading(); }
    return C.api('/api/tasks').then(function (d) {
      S.D = d; C.staff = d.staff;
      d.tasks.forEach(function (t) { var ln = C.laneOfSource(t.source); t.laneLabel = ln ? ln.label : ''; });
      paint(el);
      C.refreshToolbar();
    });
  };
  function paint(el) {
    var D = S.D, q = S.q.trim().toLowerCase();
    var un = D.tasks.filter(function (t) { return !t.userId; });
    var mine = function (u) { return D.tasks.filter(function (t) { return t.userId === u; }); };
    var teams = {}, order = [];
    D.people.forEach(function (p) { var k = p.teamId ? 't' + p.teamId : 'none'; if (!teams[k]) { teams[k] = { name: p.team || 'No team', mgr: p.manager || '', people: [] }; order.push(k); } teams[k].people.push(p); });
    var h = '<div style="flex:1;min-height:0;display:flex;overflow-x:auto;overflow-y:hidden">' +
      '<div style="position:sticky;left:0;z-index:5;flex:none;width:270px;height:100%;background:var(--bg);border-right:1px solid var(--line);box-shadow:6px 0 14px rgba(0,0,0,.25);display:flex;flex-direction:column">' +
      '<div style="padding:10px 12px;background:var(--surf);border-bottom:1px solid var(--line);flex:none;display:flex;flex-direction:column;gap:3px"><div style="display:flex;align-items:baseline;gap:8px"><span style="font:600 12.5px var(--font);color:var(--acc)">Unassigned</span><span style="font:500 12px var(--font);color:var(--muted)">' + un.length + '</span></div><span style="font:400 10.5px var(--font);color:var(--dim)">Hand each to a rep from the card</span></div>' +
      '<div style="flex:1;overflow-y:auto;padding-top:8px">' + (un.length ? un.map(function (t) { return card(t, false, true); }).join('') : '<div style="padding:12px;font:400 11.5px var(--font);color:var(--dim)">Everything is handed out.</div>') + '</div></div>';
    var shown = 0;
    order.forEach(function (k) {
      var tm = teams[k];
      var people = tm.people.filter(function (p) {
        if (q && (p.name + ' ' + tm.name).toLowerCase().indexOf(q) < 0) return false;
        if (S.only && !mine(p.userId).some(function (t) { return new Date(t.due).getTime() < Date.now(); })) return false;
        return true;
      });
      if (!people.length) return;
      shown++;
      var all = []; people.forEach(function (p) { all = all.concat(mine(p.userId)); });
      var c = counts(all, people.map(function (p) { return p.userId; }));
      var odc = c.od ? 'var(--stopped)' : 'var(--dim)';
      if (S.mode === 'person') {
        var folded = !!S.fold[k];
        h += '<div style="flex:none;height:100%;display:flex;flex-direction:column;border-right:1px solid var(--line)">' +
          '<div data-fold="' + k + '" style="flex:none;display:flex;align-items:baseline;gap:8px;padding:6px 12px;background:var(--chip);cursor:pointer;white-space:nowrap;border-bottom:1px solid var(--line)">' +
          '<span style="font:500 11px var(--font);color:var(--muted)">' + (folded ? '▸' : '▾') + '</span><span style="font:600 11.5px var(--font)">' + C.esc(tm.name) + '</span><span style="font:400 10.5px var(--font);color:var(--dim)">' + C.esc(tm.mgr ? tm.mgr + ' · ' : '') + people.length + ' people</span><span style="font:500 10.5px var(--font);color:' + odc + '">' + c.od + ' overdue</span></div>' +
          '<div style="flex:1;min-height:0;display:flex">';
        if (folded) {
          h += '<div data-fold="' + k + '" style="width:150px;padding:14px 12px;display:flex;flex-direction:column;gap:6px;cursor:pointer;font:400 11.5px var(--font);color:var(--muted)"><span style="color:' + odc + '">' + c.od + ' overdue</span><span>' + c.today + ' due today</span><span style="color:var(--done)">' + c.done + ' done today</span><span style="color:var(--dim);font-size:10.5px">Folded. Click to open.</span></div>';
        } else people.forEach(function (p) {
          var list = mine(p.userId), pc = counts(list, [p.userId]);
          h += '<div style="flex:none;width:240px;display:flex;flex-direction:column;border-right:1px solid var(--whisper)">' +
            '<div style="flex:none;padding:8px 12px;border-bottom:1px solid var(--whisper);display:flex;flex-direction:column;gap:3px">' +
            '<span style="font:500 12px var(--font);white-space:nowrap">' + C.esc(p.name) + (p.userId === C.me.id ? '<span style="color:var(--acc2)"> · you</span>' : '') + '</span>' +
            '<div style="display:flex;gap:10px;font:400 10.5px var(--font);color:var(--dim);font-variant-numeric:tabular-nums"><span style="color:' + (pc.od ? 'var(--stopped)' : 'var(--dim)') + '">' + pc.od + ' overdue</span><span>' + pc.today + ' today</span><span style="color:var(--done)">' + pc.done + ' done</span></div></div>' +
            '<div style="flex:1;overflow-y:auto;padding-top:8px">' + (list.length ? list.map(function (t) { return card(t, false, false); }).join('') : '<div style="padding:4px 12px;font:400 11px var(--font);color:var(--dim)">Clear.</div>') + '</div></div>';
        });
        h += '</div></div>';
      } else {
        all.sort(function (a, b) { return a.due < b.due ? -1 : 1; });
        h += '<div style="flex:none;width:280px;height:100%;display:flex;flex-direction:column;border-right:1px solid var(--line)">' +
          '<div style="flex:none;padding:8px 12px;border-bottom:1px solid var(--line);background:var(--chip);display:flex;flex-direction:column;gap:3px"><span style="font:600 12px var(--font)">' + C.esc(tm.name) + '</span>' +
          '<div style="display:flex;gap:10px;font:400 10.5px var(--font);color:var(--dim)"><span>' + C.esc(tm.mgr) + '</span><span style="color:' + odc + '">' + c.od + ' overdue</span><span>' + c.today + ' today</span><span style="color:var(--done)">' + c.done + ' done</span></div></div>' +
          '<div style="flex:1;overflow-y:auto;padding-top:8px">' + all.map(function (t) { return card(t, true, false); }).join('') + '</div></div>';
      }
    });
    if (!shown) h += '<div style="padding:24px;font:400 12px var(--font);color:var(--dim)">Nobody matches.</div>';
    el.innerHTML = h + '</div>';
    C.each(el, '[data-fold]', function (b) { b.addEventListener('click', function () { S.fold[b.dataset.fold] = !S.fold[b.dataset.fold]; paint(el); }); });
    C.each(el, '[data-stop]', function (b) { b.addEventListener('click', function (e) { e.stopPropagation(); }); });
    C.each(el, '[data-ho]', function (s) {
      s.addEventListener('change', function () {
        if (!s.value) return;
        C.api('/api/leads/' + s.dataset.ho + '/handout', { method: 'POST', body: JSON.stringify({ userId: Number(s.value) }) })
          .then(function () { C.toast('Handed out.'); C.render(); }).catch(C.fail);
      });
    });
    C.each(el, '[data-done]', function (b) {
      b.addEventListener('click', function () { C.api('/api/callbacks/' + b.dataset.done + '/done', { method: 'POST' }).then(function () { C.render(); }).catch(C.fail); });
    });
    C.each(el, '[data-open]', function (b) { b.addEventListener('click', function () { C.openLead(Number(b.dataset.open)); }); });
  }
  C.paintTasks = paint;
})();
