/**
 * Platform accounts, from the box.
 *
 *   npm run platform -- root  adrian@example.com "Adrian Alonso"
 *   npm run platform -- admin chrisj@stormrsolutions.com "Chris J"
 *   npm run platform -- list
 *
 * Root is made here and nowhere else: there is no screen that can create it,
 * which is the point of a break-glass account. Root also cannot sign in at all
 * unless ROOT_ENABLED=1 is set on the box and the service restarted — making
 * the account is only half of it.
 *
 * An account that already exists is promoted in place and keeps its password.
 * A new one gets a generated password, printed once, and must change it at
 * first sign-in.
 */
import readline from 'readline/promises';
import { closeMaster, mexec, mq, mqOne } from '../db/master';
import { hashPassword, randomPassword } from '../auth/password';
import { RowDataPacket } from 'mysql2/promise';

async function main(): Promise<void> {
  const [, , verb, email, ...rest] = process.argv;
  const name = rest.join(' ').trim();

  if (verb === 'list') {
    const rows = await mq<RowDataPacket[]>(
      `SELECT id, name, email, platform_role, status, last_login_at
         FROM users WHERE platform_role <> 'none' ORDER BY platform_role DESC, name`);
    if (!rows.length) {
      console.log('\nNobody holds the platform yet. Make a root account:\n' +
        '  npm run platform -- root you@example.com "Your Name"\n');
    } else {
      console.log('');
      for (const r of rows) {
        console.log(
          `  ${String(r.platform_role).padEnd(6)} ${String(r.name).padEnd(24)} ${r.email ?? ''}` +
          (r.last_login_at ? `   last in ${String(r.last_login_at).slice(0, 16)}` : '   never signed in'));
      }
      console.log('');
    }
    return;
  }

  if (verb !== 'root' && verb !== 'admin') {
    console.log('\nUsage:\n' +
      '  npm run platform -- root  <email> "<name>"    the break-glass account\n' +
      '  npm run platform -- admin <email> "<name>"    runs the platform day to day\n' +
      '  npm run platform -- list                      who holds what\n');
    process.exitCode = 1;
    return;
  }

  if (!email) { console.error('An email is required.'); process.exitCode = 1; return; }

  const existing = await mqOne<RowDataPacket>('SELECT id, name FROM users WHERE email = ?', [email]);

  if (verb === 'root') {
    const already = await mqOne<RowDataPacket>(
      `SELECT id, email FROM users WHERE platform_role = 'root'`);
    if (already && Number(already.id) !== Number(existing?.id ?? 0)) {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const yes = await rl.question(
        `\nRoot is already ${already.email}. Move it to ${email}? The old one becomes an admin. [y/N] `);
      rl.close();
      if (yes.trim().toLowerCase() !== 'y') { console.log('Left alone.'); return; }
      await mexec(`UPDATE users SET platform_role = 'admin' WHERE id = ?`, [already.id]);
    }
  }

  if (existing) {
    await mexec(
      'UPDATE users SET platform_role = ?, is_platform_owner = 1 WHERE id = ?',
      [verb, existing.id]);
    console.log(`\n${existing.name} (${email}) is now platform ${verb}. Password unchanged.\n` +
      (verb === 'root'
        ? 'Root still cannot sign in until ROOT_ENABLED=1 is set and the service restarted.\n'
        : ''));
    return;
  }

  if (!name) { console.error('A name is required for a new account.'); process.exitCode = 1; return; }

  const password = randomPassword();
  await mexec(
    `INSERT INTO users (email, password_hash, name, is_platform_owner, platform_role, must_change_pw)
     VALUES (?, ?, ?, 1, ?, 1)`,
    [email, await hashPassword(password), name, verb]);

  console.log(`\nCreated ${name} (${email}) as platform ${verb}.`);
  console.log(`Password: ${password}`);
  console.log('Shown once. They must change it at first sign-in.');
  if (verb === 'root') {
    console.log('\nRoot cannot sign in until you set ROOT_ENABLED=1 in .env and restart the service.');
    console.log('Turn it back off the moment you are done.\n');
  } else {
    console.log('');
  }
}

main()
  .catch(e => { console.error(e); process.exitCode = 1; })
  .finally(() => closeMaster());
