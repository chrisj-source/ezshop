/**
 * Shared chrome: navigation, the inbox bell, sign-out.
 *
 * Every page calls Shell.mount({ active: 'board' }) once /api/me has come
 * back, and gets navigation filtered to what that company has switched on
 * and what that role may see.
 */
window.Shell = (function () {
  var ME = null;
  /* The panel opens on what is new, which is what the bell is counting. */
  var INBOX_FILTER = 'new';

  var NAV = [
    { key: 'board',    href: '/board.html',    label: 'Board',    feature: 'board' },
    { key: 'parts',    href: '/parts.html',    label: 'Parts',    feature: 'parts',   cap: 'manageParts' },
    { key: 'leads',    href: '/leads.html',    label: 'Leads',    feature: 'leads',   cap: 'manageLeads' },
    { key: 'clients',  href: '/clients.html',  label: 'Clients',  feature: 'clients' },
    { key: 'schedule', href: '/schedule.html', label: 'Schedule', feature: 'sched' },
    { key: 'import',   href: '/import.html',   label: 'Import',   feature: 'ems',     cap: 'acceptImports' },
    { key: 'closed',   href: '/closed.html',   label: 'Closed',   feature: 'board',   cap: 'closeRepairOrders' },
    { key: 'reports',  href: '/reports.html',  label: 'Reports',  feature: 'reports', cap: 'viewReports' },
    { key: 'sales',    href: '/sales.html',    label: 'Sales',    feature: 'msales',  cap: 'manageLeads' },
    { key: 'checkin',  href: '/checkin.html',  label: 'Check-in', feature: 'mcheck' },
    /* Roles and Sales pay are Admin's, reached from its tab strip — they are not
       daily work and do not earn a slot in the main nav. */
    { key: 'admin',    href: '/admin.html',    label: 'Admin',    feature: 'board',   cap: 'admin' }
  ];

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /**
   * Every request goes through here. Two rules learned the hard way:
   * only declare a JSON body when there is one (Fastify refuses an empty JSON
   * body, which is what made cancelling an appointment silently do nothing),
   * and never let a failure return quietly — a rejected promise with a real
   * message is what the screens show the user.
   */
  function api(path, opts) {
    var o = Object.assign({}, opts || {});
    o.headers = Object.assign({}, o.headers || {});
    if (o.body != null && !o.headers['content-type']) o.headers['content-type'] = 'application/json';

    return fetch(path, o).then(function (r) {
      if (r.status === 401) { location.href = '/'; throw new Error('signed out'); }
      if (r.status === 204) return {};
      return r.text().then(function (text) {
        var j = {};
        if (text) { try { j = JSON.parse(text); } catch (e) { j = { error: text.slice(0, 200) }; } }
        if (!r.ok) {
          var err = new Error(j.error || j.message || ('Request failed (' + r.status + ')'));
          err.status = r.status;
          err.data = j;
          throw err;
        }
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

    mountTabs(active);

    var bell = document.getElementById('bell');
    if (bell) {
      bell.innerHTML =
        '<button class="bellbtn" id="bellBtn" aria-label="Notifications">' +
        '<span class="bellglyph">Inbox</span><span class="badge" id="bellBadge" hidden>0</span></button>' +
        '<div class="inbox" id="inbox" hidden>' +
        '<div class="inboxhead"><div class="inboxtitle">Messages</div>' +
        '<button class="markall" id="markAll">Mark all read</button></div>' +
        '<div id="inboxTabs" style="display:flex;gap:0;padding:0 13px 10px"></div>' +
        '<div class="inboxlist" id="inboxList"></div>' +
        '<div style="padding:10px 13px;border-top:1px solid var(--line)">' +
        '<a href="/messages.html" style="font:400 11.5px var(--font);color:var(--acc);' +
        'text-decoration:none">See all messages</a></div></div>';

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
        api('/api/inbox/mark-all', { method: 'POST', body: JSON.stringify({ read: unread, filter: INBOX_FILTER }) })
          .then(loadInbox).then(refreshCount);
      });
      refreshCount();
      setInterval(refreshCount, 45000);
    }

    var who = document.getElementById('who');
    if (who) {
      who.innerHTML = '<a href="/account.html" style="color:inherit;text-decoration:none" ' +
        'title="Your name, email and password">' +
        esc(ME.user.name) + (ME.roleLabel ? ' · ' + esc(ME.roleLabel) : '') + '</a>';
      who.querySelector('a').addEventListener('mouseenter', function () {
        this.style.color = 'var(--text)';
      });
      who.querySelector('a').addEventListener('mouseleave', function () {
        this.style.color = 'inherit';
      });
    }

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

  /**
   * Mobile navigation. The top bar cannot hold the nav and the filters and the
   * KPI band on a phone — between them they took 330px of a 664px screen and
   * left one car visible. Below 760px the nav moves down here, five tabs, and
   * everything else goes behind More.
   */
  var TABS = [
    { key: 'board', href: '/board.html', label: 'Board', feature: 'board',
      d: 'M4 5.5h16M4 12h16M4 18.5h16' },
    { key: 'schedule', href: '/schedule.html', label: 'Schedule', feature: 'sched',
      d: 'M4 6h16v14H4z M8 3v4 M16 3v4 M4 10.5h16' },
    { key: 'parts', href: '/parts.html', label: 'Parts', feature: 'parts', cap: 'manageParts',
      d: 'M12 8.5a3.5 3.5 0 100 7 3.5 3.5 0 000-7z M12 3v2.5 M12 18.5V21 M3 12h2.5 M18.5 12H21 M5.6 5.6l1.8 1.8 M16.6 16.6l1.8 1.8 M18.4 5.6l-1.8 1.8 M7.4 16.6l-1.8 1.8' },
    { key: 'clients', href: '/clients.html', label: 'Clients', feature: 'clients',
      d: 'M12 11.5a4 4 0 100-8 4 4 0 000 8z M4.5 20.5c0-3.6 3.4-5.5 7.5-5.5s7.5 1.9 7.5 5.5' }
  ];

  function icon(d, color) {
    return '<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="' + color +
      '" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="' + d +
      '"></path></svg>';
  }

  function mountTabs(active) {
    if (document.getElementById('tabbar')) return;

    var allowed = NAV.filter(function (n) {
      if (n.feature && ME.features.indexOf(n.feature) < 0) return false;
      if (n.cap && !ME.caps[n.cap]) return false;
      return true;
    });
    var keys = allowed.map(function (n) { return n.key; });

    var tabs = TABS.filter(function (t) { return keys.indexOf(t.key) >= 0; });
    var rest = allowed.filter(function (n) {
      return !tabs.some(function (t) { return t.key === n.key; });
    });

    var bar = document.createElement('nav');
    bar.className = 'tabbar';
    bar.id = 'tabbar';
    bar.innerHTML = tabs.map(function (t) {
      var on = t.key === active;
      var c = on ? 'var(--acc2)' : 'var(--dim)';
      return '<a class="tab' + (on ? ' sel' : '') + '" href="' + t.href + '">' +
        icon(t.d, c) + '<span>' + esc(t.label) + '</span></a>';
    }).join('') +
      '<button class="tab" id="tabMore" aria-label="More">' +
      icon('M6 12h.01 M12 12h.01 M18 12h.01', 'var(--dim)') + '<span>More</span></button>';

    var sheet = document.createElement('div');
    sheet.className = 'sheet';
    sheet.id = 'moreSheet';
    sheet.hidden = true;
    sheet.innerHTML = '<div class="sheetcard">' +
      '<div class="sheethead">' + esc(ME.company ? ME.company.name : 'Easy Shop') +
      '<span>' + esc(ME.user.name) + (ME.roleLabel ? ' · ' + esc(ME.roleLabel) : '') + '</span></div>' +
      rest.map(function (n) {
        return '<a class="sheetrow" href="' + n.href + '">' + esc(n.label) + '</a>';
      }).join('') +
      '<a class="sheetrow" href="/messages.html">Messages</a>' +
      '<a class="sheetrow" href="/account.html">Your account</a>' +
      (ME.isPlatformOwner ? '<a class="sheetrow" href="/platform.html">Platform</a>' : '') +
      '<button class="sheetrow" id="sheetOut">Sign out</button></div>';

    document.body.appendChild(bar);
    document.body.appendChild(sheet);
    document.body.classList.add('has-tabbar');

    document.getElementById('tabMore').addEventListener('click', function () {
      sheet.hidden = !sheet.hidden;
    });
    sheet.addEventListener('click', function (e) { if (e.target === sheet) sheet.hidden = true; });
    document.getElementById('sheetOut').addEventListener('click', function () {
      api('/api/auth/logout', { method: 'POST' }).then(function () { location.href = '/'; });
    });
  }

  function refreshCount() {
    return api('/api/inbox/count').then(function (d) {
      var b = document.getElementById('bellBadge');
      if (!b) return;
      b.textContent = d.unread;
      b.hidden = d.unread === 0;
    }).catch(function () {});
  }

  /** New / Old / All, the same three the full screen has. */
  function renderInboxTabs(d) {
    var box = document.getElementById('inboxTabs');
    if (!box) return;
    var tabs = [['new', 'New', d.unread], ['old', 'Old', d.old], ['all', 'All', d.total]];
    box.innerHTML = '<div style="display:flex;border:1px solid var(--line);border-radius:5px;' +
      'overflow:hidden">' + tabs.map(function (t, i) {
        var on = INBOX_FILTER === t[0];
        return '<button data-f="' + t[0] + '" style="font:' + (on ? '500' : '400') +
          ' 11px var(--font);color:' + (on ? 'var(--acc)' : 'var(--dim)') +
          ';background:' + (on ? 'var(--chip)' : 'transparent') + ';border:none;padding:5px 11px' +
          (i < 2 ? ';border-right:1px solid var(--line)' : '') + '">' +
          esc(t[1]) + ' <span style="opacity:.7">' + t[2] + '</span></button>';
      }).join('') + '</div>';

    Array.prototype.forEach.call(box.querySelectorAll('button'), function (b) {
      b.addEventListener('click', function (e) {
        e.stopPropagation();
        INBOX_FILTER = b.dataset.f;
        loadInbox();
      });
    });
  }

  function loadInbox() {
    var list = document.getElementById('inboxList');
    list.innerHTML = '<div class="inboxempty">Loading…</div>';
    return api('/api/inbox?filter=' + INBOX_FILTER + '&limit=60').then(function (d) {
      var mark = document.getElementById('markAll');
      if (mark) mark.textContent = d.unread ? 'Mark all read' : 'Mark all unread';
      renderInboxTabs(d);

      if (!d.items.length) {
        list.innerHTML = '<div class="inboxempty">' +
          (INBOX_FILTER === 'new' ? 'Nothing new. You are caught up.'
            : INBOX_FILTER === 'old' ? 'Nothing read yet.' : 'Nothing yet.') + '</div>';
        return;
      }
      list.innerHTML = d.items.map(function (n) {
        return '<div class="inboxrow' + (n.read_at ? ' read' : '') + '" data-id="' + n.id +
          '" data-ro="' + (n.ro_id || '') + '">' +
          '<div class="inboxdot"></div>' +
          '<div class="inboxbody"><div class="inboxt">' + esc(n.title) + '</div>' +
          '<div class="inboxb">' + esc(n.body) + '</div>' +
          '<div class="inboxm">' + when(n.created_at) + '</div></div>' +
          '<div style="display:flex;flex-direction:column;gap:5px;align-items:flex-end">' +
          '<button class="flip" data-read="' + (n.read_at ? 1 : 0) + '">' +
          (n.read_at ? 'Unread' : 'Read') + '</button>' +
          '<button class="flip del" title="Delete from your list">Delete</button>' +
          '</div></div>';
      }).join('');

      Array.prototype.forEach.call(list.querySelectorAll('.del'), function (b) {
        b.addEventListener('click', function (e) {
          e.stopPropagation();
          var row = b.closest('.inboxrow');
          api('/api/inbox/delete', {
            method: 'POST', body: JSON.stringify({ ids: [Number(row.dataset.id)] })
          }).then(loadInbox).then(refreshCount);
        });
      });

      Array.prototype.forEach.call(list.querySelectorAll('.flip:not(.del)'), function (b) {
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
