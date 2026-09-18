/*
 * Easy Shop — the booking form a shop embeds in its own website.
 *
 * Paste two lines and a form appears:
 *
 *   <div id="easyshop-form" data-campaign="hail-landing"></div>
 *   <script src="https://easyshopauto.com/f.js"
 *           data-key="pk_live_..." data-target="#easyshop-form" async></script>
 *
 * WHAT THIS FILE IS CAREFUL ABOUT, and why each one is not paranoia:
 *
 *  - **It renders INLINE, not in an iframe.** The form inherits the shop's
 *    fonts and text colour so it looks like part of their site rather than
 *    something bolted on. The cost is that we control none of the surrounding
 *    CSS, which is why nothing here assumes a width, a font size, or a
 *    background, and why every rule is set explicitly on the elements we make.
 *
 *  - **It runs on WordPress and HighLevel**, without being written for either.
 *    Both are page builders that will move a script tag, run it before its
 *    target div exists, include it twice, or inject the whole block into a tab
 *    after load. All four are handled below: the script finds its own tag,
 *    waits for its target, and refuses to mount twice.
 *
 *  - **Nothing global but one object.** These platforms carry jQuery and a
 *    pile of other people's code; a second `$` or a stray `Form` would be our
 *    fault and impossible for the shop to diagnose.
 *
 *  - **No PHP, no server-side anything on their host.** It is a script tag and
 *    an API. A page that renders can run it.
 *
 *  - **Accessibility is not optional here.** This is the one page a shop's
 *    CUSTOMERS touch besides check-in, so it is held to WCAG 2.1 AA — see
 *    CLAUDE.md. In practice that means labels and helper lines use the page's
 *    full-strength ink rather than a muted version of it: a shop's own muted
 *    grey is usually around 3.6:1 on their paper, which fails.
 *
 *  - **The honeypot is never named.** Not in the markup, not in a comment a
 *    scraper would read in the DOM, not in any message. A line telling the
 *    customer there is a hidden field a robot fills in tells the robot too.
 */
(function () {
  'use strict';

  /* Loaded twice — two blocks on one page, or a builder duplicating the embed.
     The second one no-ops rather than drawing a second form. */
  if (window.EasyShop && window.EasyShop.form) return;
  var NS = window.EasyShop = window.EasyShop || {};
  NS.form = { version: 1, mounted: [] };

  /* The script tag. `currentScript` is right even for async, but a page
     builder that rewrites the DOM can leave it null, so fall back to finding
     any of our tags that has not been claimed. */
  var tag = document.currentScript;
  if (!tag || !tag.getAttribute('data-key')) {
    var all = document.querySelectorAll('script[data-key^="pk_live_"]');
    for (var i = 0; i < all.length; i++) {
      if (!all[i].hasAttribute('data-es-claimed')) { tag = all[i]; break; }
    }
  }
  if (!tag) return;
  tag.setAttribute('data-es-claimed', '1');

  var KEY = tag.getAttribute('data-key') || '';
  var TARGET = tag.getAttribute('data-target') || '#easyshop-form';
  var BASE = (function () {
    try { return new URL(tag.src).origin; } catch (e) { return ''; }
  })();

  if (!KEY || !BASE) return;

  /* ------------------------------------------------------------- plumbing */

  function api(path, opts) {
    return fetch(BASE + path, Object.assign({
      credentials: 'omit',
      headers: { 'content-type': 'application/json' }
    }, opts || {})).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (body) {
        if (!r.ok) throw Object.assign(new Error(body.error || 'That did not work.'), body);
        return body;
      });
    });
  }

  function el(kind, style, text) {
    var n = document.createElement(kind);
    if (style) n.setAttribute('style', style);
    if (text != null) n.textContent = text;
    return n;
  }

  /* Nothing here sets a width, a font family or a background. The column
     belongs to the shop's layout and the ink belongs to their stylesheet. */
  var S = {
    stack: 'display:flex;flex-direction:column;gap:14px;font-family:inherit;color:inherit',
    row: 'display:flex;flex-wrap:wrap;gap:8px',
    grid: 'display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px',
    /* Full-strength ink. A muted label is the thing that fails 4.5:1 on a
       shop's own paper, and it fails on the smallest text on the page. */
    label: 'display:block;font-size:0.8125em;font-weight:600;letter-spacing:.03em;' +
           'text-transform:uppercase;margin:0 0 5px;color:inherit;opacity:1',
    help: 'font-size:0.8125em;line-height:1.5;margin:0;color:inherit;opacity:1',
    input: 'display:block;width:100%;box-sizing:border-box;font:inherit;font-size:1em;' +
           'padding:9px 11px;border:1px solid currentColor;border-radius:6px;' +
           'background:transparent;color:inherit'
  };

  function mountAll() {
    var nodes = document.querySelectorAll(TARGET);
    for (var i = 0; i < nodes.length; i++) {
      if (nodes[i].getAttribute('data-es-mounted')) continue;
      nodes[i].setAttribute('data-es-mounted', '1');
      NS.form.mounted.push(nodes[i]);
      build(nodes[i]);
    }
    return nodes.length > 0;
  }

  /* The target may not exist yet: a builder that runs scripts in the head, or
     a form inside a tab that is added to the DOM when somebody clicks it. */
  if (!mountAll()) {
    var seen = 0;
    var obs = new MutationObserver(function () {
      if (mountAll() || ++seen > 400) obs.disconnect();
    });
    obs.observe(document.documentElement, { childList: true, subtree: true });
    document.addEventListener('DOMContentLoaded', mountAll);
    setTimeout(function () { obs.disconnect(); }, 30000);
  }

  /* ------------------------------------------------------------ the form */

  function build(root) {
    var campaign = root.getAttribute('data-campaign') || '';
    var state = { purpose: null, date: null, time: null, cfg: null, days: [], busy: false };

    root.textContent = '';
    var wrap = el('div', S.stack);
    root.appendChild(wrap);

    var status = el('p', S.help);
    wrap.appendChild(status);
    status.textContent = 'Loading…';

    api('/api/f/config?k=' + encodeURIComponent(KEY)).then(function (cfg) {
      state.cfg = cfg;
      status.remove();
      draw(cfg);
    }).catch(function (e) {
      /* The visitor is not shown our plumbing. They are shown the thing they
         can act on, which is that the shop is reachable another way. */
      status.textContent = e && e.message === 'This form is not switched on yet.'
        ? 'Online booking is not available right now — please call the shop.'
        : 'This form could not load. Please call the shop and we will book you in.';
    });

    function accentStyle(on) {
      var c = state.cfg.accent, ink = state.cfg.accentInk;
      return on
        ? 'background:' + c + ';color:' + ink + ';border:1px solid ' + c
        : 'background:transparent;color:inherit;border:1px solid currentColor';
    }

    function draw(cfg) {
      /* Keyboard focus. Drawn from the shop's accent, and it is the reason the
         settings screen warns about a pale one: a ring nobody can see is a
         form nobody can fill in without a mouse. */
      var css = el('style');
      css.textContent =
        '.es-f :focus-visible{outline:2px solid ' + cfg.accent + ';outline-offset:2px}' +
        '.es-f button{font:inherit;cursor:pointer;border-radius:6px;padding:9px 14px}' +
        '.es-f button[disabled]{cursor:not-allowed;opacity:.55}';
      wrap.appendChild(css);
      wrap.className = (wrap.className + ' es-f').trim();

      if (cfg.intro) {
        var intro = el('p', S.help + ';font-size:1em');
        intro.textContent = cfg.intro;
        wrap.appendChild(intro);
      }

      /* ---- what they want */
      var purposes = el('div', S.row);
      wrap.appendChild(purposes);

      cfg.purposes.forEach(function (p, idx) {
        var b = el('button', 'flex:1 1 160px;min-width:0;text-align:left;padding:11px 13px');
        b.type = 'button';
        b.setAttribute('aria-pressed', 'false');
        var t = el('span', 'display:block;font-weight:600;font-size:1.0625em');
        t.textContent = p.label;
        var s = el('span', 'display:block;font-size:0.8125em;margin-top:2px');
        s.textContent = p.sub;
        b.appendChild(t); b.appendChild(s);
        b.onclick = function () { pick(p.key); };
        purposes.appendChild(b);
        b.setAttribute('data-p', p.key);
        if (idx === 0) setTimeout(function () { pick(p.key); }, 0);
      });

      function pick(key) {
        state.purpose = key; state.time = null; state.date = null;
        var bs = purposes.querySelectorAll('button');
        for (var i = 0; i < bs.length; i++) {
          var on = bs[i].getAttribute('data-p') === key;
          bs[i].setAttribute('style',
            'flex:1 1 160px;min-width:0;text-align:left;padding:11px 13px;' + accentStyle(on));
          bs[i].setAttribute('aria-pressed', on ? 'true' : 'false');
        }
        loadDays();
      }

      /* ---- when */
      var dayBox = el('div');
      var dayLabel = el('span', S.label); dayLabel.textContent = 'Pick a day';
      var dayRow = el('div', S.row);
      dayBox.appendChild(dayLabel); dayBox.appendChild(dayRow);
      wrap.appendChild(dayBox);

      var timeBox = el('div');
      var timeLabel = el('span', S.label); timeLabel.textContent = 'Pick a time';
      var timeRow = el('div', S.row);
      var timeNote = el('p', S.help + ';margin-top:6px');
      timeBox.appendChild(timeLabel); timeBox.appendChild(timeRow); timeBox.appendChild(timeNote);
      wrap.appendChild(timeBox);

      function loadDays() {
        dayRow.textContent = ''; timeRow.textContent = ''; timeNote.textContent = '';
        var loading = el('p', S.help); loading.textContent = 'Finding times…';
        dayRow.appendChild(loading);

        api('/api/f/slots?k=' + encodeURIComponent(KEY) + '&purpose=' + state.purpose)
          .then(function (r) {
            state.days = r.days || [];
            dayRow.textContent = '';
            var any = false;

            /* Every day here has times on it — the server drops the closed and
               full ones rather than sending them to be greyed out. So there is
               no disabled state to draw and no "closed" caption: a customer
               sees the days they can have. */
            state.days.forEach(function (d) {
              var b = el('button', 'flex:0 1 auto;min-width:64px;text-align:center;padding:8px 10px');
              b.type = 'button';
              var wd = el('span', 'display:block;font-size:0.75em');
              wd.textContent = d.weekday;
              var dn = el('span', 'display:block;font-size:1.125em;font-weight:600;line-height:1.15');
              dn.textContent = d.dayNum;
              var sub = el('span', 'display:block;font-size:0.6875em;margin-top:1px');
              sub.textContent = d.slots.length + ' times';
              b.appendChild(wd); b.appendChild(dn); b.appendChild(sub);
              b.setAttribute('style', b.getAttribute('style') + ';' + accentStyle(false));
              b.onclick = function () { pickDay(d); };
              dayRow.appendChild(b);
              b.__day = d;
              if (!any) { any = true; pickDay(d); }
            });

            if (!any) {
              timeNote.textContent = 'Nothing is bookable online in the next two weeks. ' +
                'Please call the shop and we will find you a time.';
            }
          })
          .catch(function () {
            dayRow.textContent = '';
            timeNote.textContent = 'Times could not be loaded. Please call the shop.';
          });
      }

      function pickDay(d) {
        state.date = d.date; state.time = null;
        var bs = dayRow.querySelectorAll('button');
        for (var i = 0; i < bs.length; i++) {
          bs[i].setAttribute('style',
            'flex:0 1 auto;min-width:64px;text-align:center;padding:8px 10px;' +
            accentStyle(bs[i].__day && bs[i].__day.date === d.date));
        }
        drawTimes(d);
      }

      function drawTimes(d) {
        timeRow.textContent = '';
        timeLabel.textContent = state.purpose === 'drop'
          ? 'Pick a time to drop it off' : 'Pick a time to come in';

        d.slots.forEach(function (t) {
          var b = el('button', 'padding:8px 13px;' + accentStyle(false), pretty(t));
          b.type = 'button';
          b.onclick = function () {
            state.time = t;
            var bs = timeRow.querySelectorAll('button');
            for (var i = 0; i < bs.length; i++) {
              bs[i].setAttribute('style', 'padding:8px 13px;' +
                accentStyle(bs[i].textContent === pretty(t)));
            }
          };
          timeRow.appendChild(b);
        });

        timeNote.textContent = d.slots.length
          ? (state.purpose === 'drop'
            ? 'A drop-off is a request — the time is held for you while the shop confirms it.'
            : '')
          : (d.why || 'Nothing left that day.');
      }

      /* ---- who */
      var fieldBox = el('div', S.grid);
      wrap.appendChild(fieldBox);
      var inputs = {};

      cfg.fields.forEach(function (f) {
        if (f.purpose !== 'both' && f.purpose !== state.purpose && f.kind !== 'builtin') return;
        var cell = el('div', f.key === 'what' ? 'grid-column:1/-1' : '');
        var id = 'es-' + f.key + '-' + Math.random().toString(36).slice(2, 7);

        var lab = el('label', S.label, f.label + (f.required ? '' : ' (optional)'));
        lab.setAttribute('for', id);
        cell.appendChild(lab);

        var input;
        if (f.key === 'what' || f.kind === 'text') {
          input = el('textarea', S.input + ';min-height:72px;resize:vertical');
        } else if (f.key === 'contact' || f.kind === 'choice') {
          input = el('select', S.input);
          var opts = f.options && f.options.length ? f.options
            : ['A phone call', 'A text message', 'Email'];
          opts.forEach(function (o) {
            var op = document.createElement('option');
            op.value = o; op.textContent = o;
            input.appendChild(op);
          });
        } else if (f.kind === 'yesno') {
          input = el('select', S.input);
          ['', 'Yes', 'No'].forEach(function (o) {
            var op = document.createElement('option');
            op.value = o; op.textContent = o || '—';
            input.appendChild(op);
          });
        } else {
          input = el('input', S.input);
          input.type = f.key === 'email' ? 'email' : f.key === 'phone' ? 'tel' : 'text';
          if (f.key === 'email') input.autocomplete = 'email';
          if (f.key === 'phone') input.autocomplete = 'tel';
          if (f.key === 'name') input.autocomplete = 'name';
        }
        input.id = id;
        if (f.required) input.required = true;
        inputs[f.key] = { node: input, def: f };
        cell.appendChild(input);
        fieldBox.appendChild(cell);
      });

      /* A field a person never sees and never fills. Given a name that looks
         like something a form would legitimately ask for, and described
         nowhere. */
      var hp = el('div', 'position:absolute;left:-9999px;width:1px;height:1px;overflow:hidden');
      hp.setAttribute('aria-hidden', 'true');
      var hpi = el('input');
      hpi.type = 'text'; hpi.name = 'company_website'; hpi.tabIndex = -1;
      hpi.setAttribute('autocomplete', 'off');
      hp.appendChild(hpi);
      wrap.appendChild(hp);

      /* ---- consent

         The shop's own words, read from the server rather than written here,
         so the text recorded against the submission is the text that was on
         screen. Unticked by default and never required: TCPA does not let
         consent to marketing be a condition of the sale, and the shop's own
         disclosure says as much — a required box would make that sentence a
         lie on their own website.

         Full-strength ink, like every other label here. This is the smallest
         text on the form and the one with legal weight, so it is the last
         place to be clever about opacity. */
      var consentBox = null;
      if (cfg.consent) {
        var cwrap = el('div',
          'display:flex;gap:10px;align-items:flex-start;padding:11px 12px;' +
          'border:1px solid currentColor;border-radius:6px');
        var cid2 = 'es-consent-' + Math.random().toString(36).slice(2, 7);

        consentBox = el('input', 'margin:2px 0 0;flex:none;width:18px;height:18px');
        consentBox.type = 'checkbox';
        consentBox.id = cid2;

        var ctext = el('div', 'font-size:0.8125em;line-height:1.55;color:inherit;opacity:1');
        var clab = el('label', 'display:block;font-weight:600;margin-bottom:3px;cursor:pointer');
        clab.setAttribute('for', cid2);
        clab.textContent = cfg.consent.label;
        ctext.appendChild(clab);

        var cbody = el('span', 'display:block');
        cbody.textContent = cfg.consent.body;
        ctext.appendChild(cbody);

        if (cfg.consent.privacyUrl || cfg.consent.termsUrl) {
          var links = el('span', 'display:block;margin-top:4px');
          if (cfg.consent.privacyUrl) {
            var a1 = el('a', 'color:inherit;text-decoration:underline', 'Privacy policy');
            a1.href = cfg.consent.privacyUrl;
            a1.target = '_blank';
            a1.rel = 'noopener';
            links.appendChild(a1);
          }
          if (cfg.consent.privacyUrl && cfg.consent.termsUrl) {
            links.appendChild(el('span', null, ' · '));
          }
          if (cfg.consent.termsUrl) {
            var a2 = el('a', 'color:inherit;text-decoration:underline', 'Terms');
            a2.href = cfg.consent.termsUrl;
            a2.target = '_blank';
            a2.rel = 'noopener';
            links.appendChild(a2);
          }
          ctext.appendChild(links);
        }

        cwrap.appendChild(consentBox);
        cwrap.appendChild(ctext);
        wrap.appendChild(cwrap);
      }

      /* ---- send */
      var foot = el('div', 'display:flex;flex-wrap:wrap;gap:12px;align-items:center');
      var send = el('button', 'font-weight:600;font-size:1em;padding:11px 20px;' + accentStyle(true));
      send.type = 'button';
      var note = el('p', S.help + ';flex:1 1 180px;margin:0');
      foot.appendChild(send); foot.appendChild(note);
      wrap.appendChild(foot);

      function refreshSend() {
        send.textContent = state.purpose === 'drop' ? 'Request this time' : 'Book this time';
        note.textContent = state.purpose === 'drop'
          ? 'We hold it for ' + cfg.holdHours + ' hours while somebody looks.'
          : 'The time is yours as soon as you press it.';
      }
      refreshSend();
      purposes.addEventListener('click', function () { setTimeout(refreshSend, 0); });

      send.onclick = function () {
        if (state.busy) return;

        var missing = [];
        var body = {
          k: KEY, purpose: state.purpose, date: state.date, time: state.time,
          campaign: campaign, pageUrl: location.href.slice(0, 400),
          company_website: hpi.value, answers: {},
          /* Only whether the box was ticked. The wording itself is read from
             the database server-side — a client that posted its own disclosure
             text could claim the customer agreed to anything. */
          smsConsent: !!(consentBox && consentBox.checked)
        };

        Object.keys(inputs).forEach(function (key) {
          var v = String(inputs[key].node.value || '').trim();
          if (inputs[key].def.required && !v) missing.push(inputs[key].def.label);
          if (inputs[key].def.kind === 'builtin') body[key] = v;
          else body.answers[key] = v;
        });

        if (!state.date || !state.time) missing.push('a time');
        if (missing.length) {
          note.textContent = 'Still needed: ' + missing.join(', ') + '.';
          return;
        }

        state.busy = true;
        send.disabled = true;
        send.textContent = 'Sending…';

        api('/api/f/submit?k=' + encodeURIComponent(KEY),
          { method: 'POST', body: JSON.stringify(body) })
          .then(function (r) { done(r); })
          .catch(function (e) {
            state.busy = false;
            send.disabled = false;
            refreshSend();
            note.textContent = e.message || 'That did not send. Please call the shop.';
            if (e.taken) loadDays();
          });
      };

      function done(r) {
        wrap.textContent = '';
        var box = el('div', 'border:1px solid currentColor;border-radius:8px;padding:18px 19px');
        var h = el('p', 'margin:0 0 9px;font-size:1.125em;font-weight:600');
        h.textContent = r.state === 'booked' ? 'You are booked in' : 'We have your request';
        box.appendChild(h);

        var p = el('p', S.help + ';font-size:0.9375em;margin:0');
        /* An address that has unsubscribed is CARRIED rather than refused —
           the same call check-in makes — but it will receive nothing, so the
           sentence promises a call instead of an email. It never says why:
           that is not the customer's business on a public page. */
        if (r.state === 'booked') {
          p.textContent = r.emailed
            ? 'It is on the shop\u2019s schedule. A confirmation is on its way to you by email.'
            : 'It is on the shop\u2019s schedule. Somebody will call you to confirm the details.';
        } else {
          p.textContent = r.emailed
            ? 'The time is held for you for ' + r.holdHours + ' hours while the shop confirms it. ' +
              'You will get a second email once it is confirmed, or a call if that time does not work.'
            : 'The time is held for you for ' + r.holdHours + ' hours. ' +
              'Somebody will call you to confirm it.';
        }
        box.appendChild(p);

        var when = el('p', S.help + ';margin:12px 0 0');
        when.textContent = pretty(r.when.time) + ' on ' + r.when.date;
        box.appendChild(when);

        wrap.appendChild(box);
      }
    }
  }

  function pretty(hhmm) {
    var p = String(hhmm).split(':');
    var h = Number(p[0]);
    return (h % 12 === 0 ? 12 : h % 12) + ':' + p[1] + ' ' + (h >= 12 ? 'PM' : 'AM');
  }
})();
