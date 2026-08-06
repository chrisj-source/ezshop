/**
 * First run. Creates the platform owner and, optionally, the first company.
 *
 *   npm run build
 *   node dist/scripts/bootstrap.js "Chris Johnson" you@example.com
 *
 * Prints a temporary password. Sign in, then change it.
 */
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import crypto from 'node:crypto';
import { RowDataPacket } from 'mysql2/promise';
import { closeMaster, mexec, mqOne } from '../db/master';
import { hashPassword } from '../auth/password';
import { provisionCompany } from '../db/provision';
import { ShopType } from '../db/status-template';

function randomPassword(len = 18): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  return Array.from(crypto.randomBytes(len)).map(b => alphabet[b % alphabet.length]).join('');
}

async function main(): Promise<void> {
  const [, , argName, argEmail] = process.argv;
  const rl = readline.createInterface({ input: stdin, output: stdout });

  const name = argName ?? await rl.question('Your name: ');
  const email = (argEmail ?? await rl.question('Your email: ')).trim().toLowerCase();

  if (!name || !email) throw new Error('Name and email are both required.');

  let userId: number;
  const existing = await mqOne<RowDataPacket & { id: number }>('SELECT id FROM users WHERE email = ?', [email]);
  let password: string | null = null;

  if (existing) {
    userId = existing.id;
    await mexec('UPDATE users SET is_platform_owner = 1 WHERE id = ?', [userId]);
    console.log(`\nExisting user ${email} promoted to platform owner.`);
  } else {
    password = randomPassword();
    const res = await mexec(
      `INSERT INTO users (email, password_hash, name, is_platform_owner, must_change_pw)
       VALUES (?, ?, ?, 1, 1)`,
      [email, await hashPassword(password), name]
    );
    userId = res.insertId;
    console.log(`\nPlatform owner created.`);
    console.log(`  email:    ${email}`);
    console.log(`  password: ${password}`);
    console.log(`  (you will be asked to change it on first sign-in)`);
  }

  const wantCompany = (await rl.question('\nCreate your first shop now? [Y/n] ')).trim().toLowerCase();
  if (wantCompany === 'n') { rl.close(); await closeMaster(); return; }

  const cName = await rl.question('Shop name: ');
  const cSlug = (await rl.question('Short slug (lowercase, no spaces — becomes the database name): ')).trim().toLowerCase();
  const cCity = await rl.question('City, state (optional): ');
  const cType = (await rl.question('Shop type [pdr / collision / both / detail] (both): ')).trim() || 'both';

  const [city, state] = cCity.split(',').map(s => s.trim());

  const out = await provisionCompany({
    name: cName,
    slug: cSlug,
    city: city || undefined,
    state: state || undefined,
    shopType: cType as ShopType,
    planCode: 'growth',
    seats: 20,
    ownerName: name,
    ownerEmail: email,
    ownerPassword: password ?? undefined,
    actorUserId: userId
  });

  console.log(`\nShop created.`);
  console.log(`  database:  ${out.dbName}`);
  console.log(`  statuses:  ${out.statusCount} seeded from the ${cType} template`);
  console.log(`  owner:     ${email}`);
  if (out.tempPassword) console.log(`  password:  ${out.tempPassword}`);
  console.log(`\nStart the app and sign in at ${process.env.APP_URL ?? 'http://localhost:3000'}\n`);

  rl.close();
  await closeMaster();
}

main().catch(async err => {
  console.error('\nBootstrap failed:', err.message);
  await closeMaster().catch(() => {});
  process.exit(1);
});
