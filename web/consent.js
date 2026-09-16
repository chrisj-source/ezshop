/* Consent, and the only thing that loads Google Tag Manager.
 *
 * The standing decision on this site was that the marketing pages set nothing,
 * so no banner was needed — a banner on a site that tracks nothing implies
 * tracking that is not happening. Adding GTM reverses that, and the rule
 * recorded in CLAUDE.md is that the consent plumbing ships WITH the analytics
 * rather than after it. This is that plumbing.
 *
 * How it behaves, and why:
 *
 *  - **Opt IN, not opt out.** GTM is not loaded at all until somebody accepts.
 *    Consent Mode with denied defaults would be the conventional choice, but it
 *    still loads Google's script and still makes a request on first paint. This
 *    site told people it set nothing; the honest upgrade is to keep that true
 *    for anyone who does not say yes.
 *
 *  - **Consent Mode signals are set anyway**, before anything loads, so any tag
 *    added in the GTM interface later inherits a denied default instead of
 *    firing freely. Two defences, because the container is edited by a human in
 *    a web UI and this file is not.
 *
 *  - **Global Privacy Control is honoured without being asked.** privacy.html
 *    promises exactly that, so a GPC browser is treated as a refusal and never
 *    sees the banner. A promise on a policy page that the code does not keep is
 *    worse than no promise.
 *
 *  - **The choice lives in localStorage, not a cookie.** Storing a refusal in a
 *    cookie means setting a cookie on somebody who just declined cookies. It is
 *    defensible as strictly necessary, but localStorage is not transmitted with
 *    every request and reads better on the policy page.
 *
 *  - **Declining is one click, the same size as accepting.** A decline hidden
 *    behind a second screen is a dark pattern and, under several state laws,
 *    not valid consent.
 */
(function () {
  'use strict';

  var GTM_ID = 'GTM-T5BC9MZ6';
  var KEY = 'es_consent';          /* 'granted' | 'denied' */
  var VERSION = '1';               /* bump to re-ask after a material change */

  var w = window, d = document;

  /* ------------------------------------------------------- consent mode */

  w.dataLayer = w.dataLayer || [];
  function gtag() { w.dataLayer.push(arguments); }

  /* Denied before anything else happens. */
  gtag('consent', 'default', {
    ad_storage: 'denied',
    ad_user_data: 'denied',
    ad_personalization: 'denied',
    analytics_storage: 'denied',
    functionality_storage: 'granted',   /* nothing here uses it, but it is honest */
    security_storage: 'granted',
    wait_for_update: 500
  });

  /* ------------------------------------------------------------ storage */

  function read() {
    try {
      var raw = localStorage.getItem(KEY);
      if (!raw) return null;
      var v = JSON.parse(raw);
      return v && v.version === VERSION ? v.state : null;
    } catch (e) { return null; }
  }

  function write(state) {
    try {
      localStorage.setItem(KEY, JSON.stringify({
        state: state, version: VERSION, at: new Date().toISOString()
      }));
    } catch (e) { /* private mode: the session simply is not remembered */ }
  }

  /** Does the browser already say no on this person's behalf? */
  function gpc() {
    return navigator.globalPrivacyControl === true;
  }

  /* --------------------------------------------------------------- GTM */

  var loaded = false;

  function loadGtm() {
    if (loaded) return;
    loaded = true;
    w.dataLayer.push({ 'gtm.start': new Date().getTime(), event: 'gtm.js' });
    var f = d.getElementsByTagName('script')[0];
    var j = d.createElement('script');
    j.async = true;
    j.src = 'https://www.googletagmanager.com/gtm.js?id=' + GTM_ID;
    f.parentNode.insertBefore(j, f);
  }

  function grant() {
    gtag('consent', 'update', {
      ad_storage: 'granted',
      ad_user_data: 'granted',
      ad_personalization: 'granted',
      analytics_storage: 'granted'
    });
    loadGtm();
  }

  /**
   * Withdrawing after the fact. The container cannot be unloaded once it is in
   * the page, so the honest sequence is: tell Google to stop storing, clear
   * what was already set, and reload so nothing carries on in memory.
   */
  function revoke() {
    gtag('consent', 'update', {
      ad_storage: 'denied',
      ad_user_data: 'denied',
      ad_personalization: 'denied',
      analytics_storage: 'denied'
    });
    var names = d.cookie.split(';').map(function (c) { return c.split('=')[0].trim(); });
    var host = location.hostname;
    var domains = [host, '.' + host, '.' + host.split('.').slice(-2).join('.')];
    names.forEach(function (n) {
      if (!/^(_ga|_gid|_gat|_gcl|_fbp|_uet|FPID|FPLC)/.test(n)) return;
      domains.forEach(function (dom) {
        d.cookie = n + '=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/; domain=' + dom;
      });
      d.cookie = n + '=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/';
    });
  }

  /* --------------------------------------------------------------- UI */

  function el(tag, attrs, text) {
    var e = d.createElement(tag);
    for (var k in attrs) if (Object.prototype.hasOwnProperty.call(attrs, k)) {
      if (k === 'style') e.style.cssText = attrs[k]; else e.setAttribute(k, attrs[k]);
    }
    if (text) e.textContent = text;
    return e;
  }

  var repaintFooter = function () {};

  function decide(state) {
    write(state);
    if (state === 'granted') grant(); else revoke();
    var bar = d.getElementById('es-consent');
    if (bar) bar.remove();
    repaintFooter();
  }

  function banner() {
    var bar = el('div', {
      id: 'es-consent',
      role: 'dialog',
      'aria-modal': 'false',
      'aria-label': 'Cookies on this site'
    });

    bar.innerHTML =
      '<div class="es-consent-in">' +
        '<p>We would like to measure which pages people find useful, using Google ' +
        'Analytics. It sets cookies. Nothing is sold or shared for advertising, and ' +
        'the site works exactly the same if you say no. ' +
        '<a href="privacy.html#cookies">What this covers</a>.</p>' +
        '<div class="es-consent-btns">' +
          '<button type="button" data-es="deny">No thanks</button>' +
          '<button type="button" data-es="allow" class="es-primary">Allow</button>' +
        '</div>' +
      '</div>';

    bar.addEventListener('click', function (ev) {
      var t = ev.target.closest ? ev.target.closest('[data-es]') : null;
      if (!t) return;
      decide(t.getAttribute('data-es') === 'allow' ? 'granted' : 'denied');
    });

    d.body.appendChild(bar);
  }

  /* ------------------------------------------------------------- start */

  var state = read();

  if (gpc()) {
    /* Their browser already answered. Record it so the footer control shows the
       right state, and never show the banner. */
    if (state !== 'denied') write('denied');
  } else if (state === 'granted') {
    grant();
  } else if (state !== 'denied') {
    if (d.readyState === 'loading') d.addEventListener('DOMContentLoaded', banner);
    else banner();
  }

  /**
   * The footer control. Any element with id="cookie-prefs" becomes a live
   * switch showing the current state, so changing your mind does not mean
   * hunting for a buried settings page.
   */
  function wireFooter() {
    var link = d.getElementById('cookie-prefs');
    if (!link) return;

    function paint() {
      var s = gpc() ? 'gpc' : (read() || 'unset');
      link.textContent =
        s === 'granted' ? 'Analytics: on'
        : s === 'gpc'   ? 'Analytics: off (your browser asked)'
        : s === 'denied' ? 'Analytics: off'
        : 'Cookie choices';
      link.setAttribute('aria-live', 'polite');
    }

    link.addEventListener('click', function (ev) {
      ev.preventDefault();
      if (gpc()) return;                    /* their browser decided; respect it */
      if (read() === 'granted') { decide('denied'); location.reload(); }
      else decide('granted');
    });

    repaintFooter = paint;
    paint();
  }

  if (d.readyState === 'loading') d.addEventListener('DOMContentLoaded', wireFooter);
  else wireFooter();
})();
