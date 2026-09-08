# Vendored browser scripts

Served off this box at `/vendor/…`. Nothing here is ours.

## zxing-0.21.3.min.js

The barcode reader behind VIN scanning on check-in (`web/checkin.html`).

`@zxing/library` 0.21.3, the UMD build, MIT licensed. It sets `window.ZXing`.

It used to load from jsdelivr with unpkg as a fallback. The security pass set
`script-src 'self' 'unsafe-inline'`, which blocks both, and VIN scanning stopped
working with nothing on screen to say why. It lives here now so the header stays
strict and no third-party script runs on the one page a shop's customers touch.

To fetch or refresh it:

    curl -fSL -o server/web/vendor/zxing-0.21.3.min.js \
      https://cdn.jsdelivr.net/npm/@zxing/library@0.21.3/umd/index.min.js

Expect roughly 400 KB. Committed to the repo deliberately: a deploy should not
depend on a network fetch. If you bump the version, rename the file and change
`ZXING_URLS` in `checkin.html` to match — the version is in the filename so a
stale cached copy can never be mistaken for the current one.
