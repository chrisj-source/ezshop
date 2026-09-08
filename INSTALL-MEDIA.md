# Installing the media tools

Thumbnails, HEIC photos and PDF viewing need three things on the box. The app
runs without any of them — you just get a plain glyph where a thumbnail would
be — so install what you need and restart.

Everything below is Debian and Ubuntu. There are notes for RHEL/Alma and macOS
at the end.

---

## 1. Redis — the thumbnail queue

```bash
sudo apt update
sudo apt install -y redis-server
sudo systemctl enable --now redis-server
redis-cli ping        # PONG
```

Redis is listening on `127.0.0.1:6379` and, as installed by Debian, is not open
to the network. Nothing else is needed — the app finds it there by default.

If you moved it, put the address in `.env`:

```
REDIS_URL=redis://127.0.0.1:6379
```

Leave `REDIS_URL` empty and the app makes thumbnails inside the upload request
instead. It works; whoever is uploading waits a second or two longer.

## 2. mupdf-tools — PDF thumbnails and page viewing

```bash
sudo apt install -y mupdf-tools
mutool -v             # prints a version
```

This is what renders page one of a PDF for its thumbnail, and the other pages
when someone turns to them.

## 3. libheif — iPhone HEIC photos

```bash
sudo apt install -y libheif-examples
heif-convert --help   # prints usage
```

On newer Debian and Ubuntu the package is `libheif-examples`; on some releases it
is `libheif-tools`. Either provides `heif-convert`, which is the only part the
app calls.

```bash
apt-cache search libheif | grep -E 'examples|tools'
```

HEIC photos are converted to JPEG on upload and the HEIC is deleted — a JPEG
opens anywhere, in ten years, without this package installed.

## 4. sharp — resizing and JPEG encoding

An npm dependency, not an apt one, and it ships prebuilt binaries. It comes in
with the rest:

```bash
cd /path/to/easyshop/server
npm install
```

Nothing else to do. If npm cannot fetch a prebuilt binary for your architecture
it will say so, and you need libvips headers to build it:

```bash
sudo apt install -y build-essential libvips-dev
npm install --build-from-source sharp
```

---

## Then

```bash
npm run build
npm run migrate            # adds the thumbnail columns and the page cache
sudo systemctl restart easyshop
```

The app logs what it found on start:

```
media tools — sharp: yes, heif-convert: yes, mutool: yes
```

Anything reading `no` there is what you are missing. Admin shows the same thing.

## Existing files

Everything uploaded before this has no thumbnail. One pass fixes them:

```bash
npm run backfill-thumbs
```

With Redis up it queues the work and returns straight away — watch
`journalctl -u easyshop -f` as it drains. Without Redis it does the work itself
and takes as long as it takes. Safe to run again; it only touches what is still
waiting.

---

## Other systems

**RHEL, Alma, Rocky** — mupdf and libheif tools are in EPEL:

```bash
sudo dnf install -y epel-release
sudo dnf install -y redis mupdf libheif-tools
sudo systemctl enable --now redis
```

The `mutool` binary comes with the `mupdf` package there rather than a separate
`-tools` one.

**macOS**, for development:

```bash
brew install redis mupdf-tools libheif
brew services start redis
```

---

## What the shop loses without each one

| Missing | What happens |
| --- | --- |
| Redis | Thumbnails are made during the upload. Slower to upload, everything else the same. |
| mupdf-tools | PDFs get a glyph instead of a thumbnail and cannot be paged in the viewer. Download still works. |
| libheif | An iPhone HEIC uploads but gets a glyph, and stays a HEIC. Photos taken with the camera set to "Most Compatible" are unaffected. |
| sharp | No thumbnails at all, for anything. |

## Disk

Photos are resized to a 2048px long edge and a 400px thumbnail, so a 4 MB phone
photo lands at about 350 KB. Rendered PDF pages are a cache: page one is kept
with the document, and any other page a person opens is kept for thirty days
after they last looked at it, then dropped and re-rendered on demand. Admin
counts that cache separately from the documents themselves, because it is disk
you can throw away.

Change the thirty days in `.env`:

```
PAGE_CACHE_DAYS=30
MEDIA_CONCURRENCY=2      # thumbnail jobs at once; raise it if the box is idle
```
