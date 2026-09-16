/**
 * IndexNow — tell the search engines a page changed, instead of waiting.
 *
 *   npm run indexnow                    every URL in the sitemap
 *   npm run indexnow -- /about.html     just these
 *
 * Why this and not "submit to Google"
 * -----------------------------------
 * IndexNow is one POST that Bing, Yandex, Seznam and Naver all share — submit
 * once and they each pick it up. **Google does not participate.** Its Indexing
 * API only accepts job postings and livestreams, so there is no honest way to
 * push an ordinary marketing page to Google; Google finds it by crawling, and
 * what helps there is the sitemap being correct and the pages being linked.
 * Anything claiming to "instantly index on Google" is selling something.
 *
 * So: this covers Bing (and therefore a large share of AI answer engines, which
 * lean on Bing's index), and the sitemap covers Google.
 *
 * Ownership is proved by a key file served at the site root. The key is read
 * from INDEXNOW_KEY, or discovered by finding the single `<32-hex>.txt` file in
 * `web/` — so rotating it means dropping in a new file, not editing code.
 */
import fs from 'node:fs/promises';
import path from 'node:path';

const WEB = path.join(__dirname, '..', '..', 'web');
const HOST = process.env.SITE_HOST ?? 'easyshopauto.com';
const ENDPOINT = 'https://api.indexnow.org/IndexNow';

async function findKey(): Promise<string> {
  if (process.env.INDEXNOW_KEY) return process.env.INDEXNOW_KEY;

  const names = await fs.readdir(WEB);
  const keys = names.filter(n => /^[a-f0-9]{8,64}\.txt$/i.test(n));

  if (!keys.length) {
    throw new Error(
      'No IndexNow key file in web/. Generate a key at https://www.bing.com/indexnow, ' +
      'save it as web/<key>.txt containing the key, and re-run.');
  }
  if (keys.length > 1) {
    throw new Error(`Several key files in web/ (${keys.join(', ')}). Leave one.`);
  }
  return keys[0].replace(/\.txt$/i, '');
}

/** The sitemap is the list of what is public, so it is the list worth pushing. */
async function sitemapUrls(): Promise<string[]> {
  const xml = await fs.readFile(path.join(WEB, 'sitemap.xml'), 'utf8');
  return [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map(m => m[1]);
}

async function main(): Promise<void> {
  const key = await findKey();

  const args = process.argv.slice(2).filter(a => !a.startsWith('-'));
  const urls = args.length
    ? args.map(a => (a.startsWith('http') ? a : `https://${HOST}${a.startsWith('/') ? a : '/' + a}`))
    : await sitemapUrls();

  if (!urls.length) { console.log('Nothing to submit.'); return; }

  /* Every submitted URL must be on the same host as the key file, or the whole
     batch is rejected. Worth checking here rather than reading a 422. */
  const wrong = urls.filter(u => { try { return new URL(u).hostname !== HOST; } catch { return true; } });
  if (wrong.length) {
    throw new Error(`These are not on ${HOST}, so the batch would be refused:\n  ${wrong.join('\n  ')}`);
  }

  console.log(`IndexNow → ${HOST}`);
  console.log(`key ${key.slice(0, 6)}… (served at https://${HOST}/${key}.txt)`);
  urls.forEach(u => console.log('  ' + u));

  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ host: HOST, key, keyLocation: `https://${HOST}/${key}.txt`, urlList: urls })
  });

  const body = await res.text().catch(() => '');

  /* 200 accepted, 202 accepted but the key is still being validated — both are
     success. Anything else is worth printing in full; the API's messages are
     specific and short. */
  if (res.status === 200 || res.status === 202) {
    console.log(`\n${res.status} — ${urls.length} URL(s) submitted.` +
      (res.status === 202 ? ' Key pending validation; it will be checked shortly.' : ''));
    return;
  }

  console.error(`\n${res.status} ${res.statusText}\n${body}`);
  if (res.status === 403) {
    console.error('403 means the key file could not be fetched or did not match. ' +
      `Check https://${HOST}/${key}.txt returns exactly the key.`);
  }
  if (res.status === 422) {
    console.error('422 means a URL is not on this host, or the key does not belong to it.');
  }
  if (res.status === 429) {
    console.error('429 means too many submissions. Submit only what actually changed.');
  }
  process.exit(1);
}

main().catch(e => { console.error(String(e.message ?? e)); process.exit(1); });
