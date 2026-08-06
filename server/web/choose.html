<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Choose a shop — Easy Shop</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
<style>
  :root { --bg:#131c2e;--text:#e7eaf2;--dim:#7f8ca4;--line:#2c3a55;
          --acc:#d9a441;--acc2:#e5bf68;--stopped:#d07e6f;--font:'Inter',system-ui,sans-serif; }
  * { box-sizing:border-box; }
  body { margin:0;min-height:100vh;background:var(--bg);color:var(--text);
         font-family:var(--font);display:grid;place-items:center;padding:24px; }
  .card { width:100%;max-width:400px; }
  h1 { font:500 21px var(--font);margin:0 0 6px; }
  .sub { font:400 12.5px var(--font);color:var(--dim);margin-bottom:24px; }
  .shop { display:flex;align-items:center;gap:12px;width:100%;text-align:left;
          background:transparent;border:1px solid var(--line);border-radius:5px;
          padding:13px 14px;margin-bottom:9px;cursor:pointer;color:var(--text);font-family:var(--font); }
  .shop:hover { border-color:var(--acc); }
  .shop:disabled { opacity:.45;cursor:default; }
  .nm { font:500 13px var(--font); }
  .rl { font:400 10.5px var(--font);color:var(--dim);margin-top:2px; }
  .off { margin-left:auto;font:500 9px var(--font);letter-spacing:.08em;text-transform:uppercase;
         color:var(--stopped);border:1px solid var(--stopped);padding:2px 6px;border-radius:3px; }
</style>
</head>
<body>
<div class="card">
  <h1>Choose a shop</h1>
  <div class="sub">You have access to more than one.</div>
  <div id="list"></div>
</div>
<script>
(function () {
  fetch('/api/me').then(function (r) { return r.json(); }).then(function (me) {
    if (!me.companies || !me.companies.length) { location.href = '/'; return; }
    var el = document.getElementById('list');
    el.innerHTML = me.companies.map(function (c) {
      return '<button class="shop" data-id="' + c.id + '"' + (c.suspended ? ' disabled' : '') + '>' +
        '<div><div class="nm">' + c.name + '</div><div class="rl">' + c.roleLabel + '</div></div>' +
        (c.suspended ? '<div class="off">Switched off</div>' : '') + '</button>';
    }).join('');
    Array.prototype.forEach.call(el.querySelectorAll('.shop:not([disabled])'), function (b) {
      b.addEventListener('click', function () {
        fetch('/api/auth/switch-company', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ companyId: Number(b.dataset.id) })
        }).then(function () { location.href = '/board.html'; });
      });
    });
  });
})();
</script>
</body>
</html>
