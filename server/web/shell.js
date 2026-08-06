/**
 * Shared chrome: navigation, the inbox bell, sign-out.
 *
 * Every page calls Shell.mount({ active: 'board' }) once /api/me has come
 * back, and gets navigation filtered to what that company has switched on
 * and what that role may see.
 */
window.Shell = (function () {
  var ME = null;

  var NAV = [
    { key: 'board',    href: '/board.html',    label: 'Board',    feature: 'board' },
    { key: 'parts',    href: '/parts.html',    label: 'Parts',    feature: 'parts',   cap: 'manageParts' },
    { key: 'leads',    href: '/leads.html',    label: 'Leads',    feature: 'leads',   cap: 'manageLeads' },
    { key: 'schedule', href: '/schedule.html', label: 'Schedule', feature: 'sched' },
    { key: 'import',   href: '/import.html',   label: 'Import',   feature: 'ems',     cap: 'acceptImports' },
    { key: 'reports',  href: '/reports.html',  label: 'Reports',  feature: 'reports', cap: 'viewReports' },
    { key: 'sales',    href: '/sales.html',    label: 'Sales',    feature: 'msales',  cap: 'manageLeads' },
    { key: 'checkin',  href: '/checkin.html',  label: 'Check-in', feature: 'mcheck' },
    { key: 'admin',    href: '/admin.html',    label: 'Admin',    feature: 'board',   cap: 'admin' }
  ];

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function api(path, opts) {
    return fetch(path, Object.assign({
      headers: { 'content-type': 'application/json' }
    }, opts || {})).then(function (r) {
      if (r.status === 401) { location.href = '/'; throw new Error('signed out'); }
      return r.json().then(function (j) {
        if (!r.ok) throw new Error(j.error || 'Request failed');
        return j;
      });
    });
  }

  function when(iso) {
    if (!iso) return '';
    var d = new Date(iso), now = new Date();
    var mins = Math.round((now - d) / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return mins + 'm ago';
    if (mins < 1440) return Math.round(mins / 60) + 'h ago';
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }

  function mount(opts) {
    ME = opts.me;
    var active = opts.active;

    var nav = document.getElementById('nav');
    if (nav) {
      nav.innerHTML = NAV.filter(function (n) {
        if (n.feature && ME.features.indexOf(n.feature) < 0) return false;
        if (n.cap && !ME.caps[n.cap]) return false;
        return true;
      }).map(function (n) {
        return '<a href="' + n.href + '" class="navlink' + (n.key === active ? ' sel' : '') + '">' +
          esc(n.label) + '</a>';
      }).join('');
    }

    var bell = document.getElementById('bell');
    if (bell) {
      bell.innerHTML =
        '<button class="bellbtn" id="bellBtn" aria-label="Notifications">' +
        '<span class="bellglyph">Inbox</span><span class="badge" id="bellBadge" hidden>0</span></button>' +
        '<div class="inbox" id="inbox" hidden>' +
        '<div class="inboxhead"><div class="inboxtitle">Notifications</div>' +
        '<button class="markall" id="markAll">Mark all read</button></div>' +
        '<div class="inboxlist" id="inboxList"></div></div>';

      document.getElementById('bellBtn').addEventListener('click', function (e) {
        e.stopPropagation();
        var box = document.getElementById('inbox');
        if (box.hidden) { box.hidden = false; loadInbox(); }
        else box.hidden = true;
      });
      document.addEventListener('click', function (e) {
        var box = document.getElementById('inbox');
        if (box && !box.hidden && !box.contains(e.target) && e.target.id !== 'bellBtn') box.hidden = true;
      });
      document.getElementById('markAll').addEventListener('click', function (e) {
        e.stopPropagation();
        var unread = Number(document.getElementById('bellBadge').textContent || 0) > 0;
        api('/api/inbox/mark-all', { method: 'POST', body: JSON.stringify({ read: unread }) })
          .then(loadInbox).then(refreshCount);
      });

      refreshCount();
      setInterval(refreshCount, 45000);
    }

    var who = document.getElementById('who');
    if (who) who.textContent = ME.user.name + (ME.roleLabel ? ' · ' + ME.roleLabel : '');

    var co = document.getElementById('coName');
    if (co && ME.company) co.textContent = ME.company.name;

    var out = document.getElementById('signout');
    if (out) out.addEventListener('click', function () {
      api('/api/auth/logout', { method: 'POST' }).then(function () { location.href = '/'; });
    });

    var plat = document.getElementById('platformLink');
    if (plat && ME.isPlatformOwner) plat.hidden = false;

    if (ME.impersonating) {
      var banner = document.createElement('div');
      banner.className = 'impbanner';
      banner.textContent = 'You are inside ' + ME.company.name +
        ' as the platform owner. Everything you do is recorded.';
      document.body.insertBefore(banner, document.body.firstChild);
    }
  }

  function refreshCount() {
    return api('/api/inbox/count').then(function (d) {
      var b = document.getElementById('bellBadge');
      if (!b) return;
      b.textContent = d.unread;
      b.hidden = d.unread === 0;
    }).catch(function () {});
  }

  function loadInbox() {
    var list = document.getElementById('inboxList');
    list.innerHTML = '<div class="inboxempty">Loading…</div>';
    return api('/api/inbox').then(function (d) {
      var mark = document.getElementById('markAll');
      if (mark) mark.textContent = d.unread ? 'Mark all read' : 'Mark all unread';

      if (!d.items.length) {
        list.innerHTML = '<div class="inboxempty">Nothing yet.</div>';
        return;
      }
      list.innerHTML = d.items.map(function (n) {
        return '<div class="inboxrow' + (n.read_at ? ' read' : '') + '" data-id="' + n.id +
          '" data-ro="' + (n.ro_id || '') + '">' +
          '<div class="inboxdot"></div>' +
          '<div class="inboxbody"><div class="inboxt">' + esc(n.title) + '</div>' +
          '<div class="inboxb">' + esc(n.body) + '</div>' +
          '<div class="inboxm">' + when(n.created_at) + '</div></div>' +
          '<button class="flip" data-read="' + (n.read_at ? 1 : 0) + '">' +
          (n.read_at ? 'Unread' : 'Read') + '</button></div>';
      }).join('');

      Array.prototype.forEach.call(list.querySelectorAll('.flip'), function (b) {
        b.addEventListener('click', function (e) {
          e.stopPropagation();
          var row = b.closest('.inboxrow');
          api('/api/inbox/' + row.dataset.id + '/read', {
            method: 'POST', body: JSON.stringify({ read: b.dataset.read !== '1' })
          }).then(loadInbox).then(refreshCount);
        });
      });

      Array.prototype.forEach.call(list.querySelectorAll('.inboxrow'), function (row) {
        row.addEventListener('click', function () {
          var ro = row.dataset.ro;
          api('/api/inbox/' + row.dataset.id + '/read', {
            method: 'POST', body: JSON.stringify({ read: true })
          }).then(function () {
            if (ro) location.href = '/board.html?ro=' + ro;
            else { loadInbox(); refreshCount(); }
          });
        });
      });
    });
  }

  return { mount: mount, api: api, esc: esc, when: when, refreshCount: refreshCount };
})();
