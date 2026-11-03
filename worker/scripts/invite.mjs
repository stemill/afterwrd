// Set up a site's owner from the terminal. Runs SQL against the Worker's D1 database through wrangler. Only the
// owner signs in to an afterwrd site (friends see each other from their own sites); day to day, Your devices
// (/_admin) adds the owner's phones and computers.
//
//   npm run invite -- add "Your Name" --owner   the owner of a new site; prints a link to add the first device
//   npm run invite -- again 1                   a new device link for the owner (their number from list)
//   npm run invite -- list
//   npm run invite -- revoke 3                  signs them out and deletes their passkeys
//
// Add --local to work against `npm run dev` instead of the deployed site. Links use the site address from
// --url, or AFTERWRD_URL, or http://localhost:8787 with --local.
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";

const OWNER_INVITE_SECONDS = 3600; // a device link grants owner access, so it's short-lived

const args = process.argv.slice(2);
const local = take("--local");
const owner = take("--owner");
const siteUrl = (option("--url") ?? process.env.AFTERWRD_URL ?? (local ? "http://localhost:8787" : "")).replace(/\/$/, "");
const [command, value] = args;
const now = Math.floor(Date.now() / 1000);

switch (command) {
  case "add": {
    if (!value) fail('Give a name: npm run invite -- add "Your Name" --owner');
    if (!owner) fail("Only the owner signs in to an afterwrd site; add --owner. Friends connect from their own sites.");
    const [existing] = sql("SELECT id, name FROM users WHERE is_owner = 1 AND revoked_at IS NULL ORDER BY id LIMIT 1");
    if (existing) {
      fail(`This site already has an owner, ${existing.name}. For another device: npm run invite -- again ${existing.id}`);
    }
    const [user] = sql(`INSERT INTO users (name, is_owner, created_at) VALUES (${quote(value)}, 1, ${now}) RETURNING id`);
    printInvite(user.id, value);
    break;
  }
  case "again": {
    const user = findUser(value);
    if (!user.is_owner) fail(`${user.name} isn't the owner; only the owner signs in to an afterwrd site.`);
    printInvite(user.id, user.name);
    break;
  }
  case "list": {
    const rows = sql(`
      SELECT u.id, u.name, u.is_owner, u.revoked_at,
        (SELECT COUNT(*) FROM credentials c WHERE c.user_id = u.id) AS passkeys,
        (SELECT MAX(last_used_at) FROM credentials c WHERE c.user_id = u.id) AS last_sign_in,
        (SELECT COUNT(*) FROM invites i WHERE i.user_id = u.id AND i.used_at IS NULL AND i.expires_at > ${now}) AS open_invites
      FROM users u ORDER BY u.id`);
    if (!rows.length) console.log("No one yet. Start with: npm run invite -- add \"Your Name\" --owner");
    for (const r of rows) {
      const status = r.revoked_at ? `revoked ${day(r.revoked_at)}`
        : [`${r.passkeys} passkey${r.passkeys === 1 ? "" : "s"}`,
           r.last_sign_in && `last signed in ${day(r.last_sign_in)}`,
           r.open_invites && "invite waiting", r.is_owner && "owner"].filter(Boolean).join(", ");
      console.log(`${String(r.id).padStart(3)}  ${r.name.padEnd(28)} ${status}`);
    }
    break;
  }
  case "revoke": {
    const user = findUser(value);
    sql(`UPDATE users SET revoked_at = ${now} WHERE id = ${user.id};
         DELETE FROM sessions WHERE user_id = ${user.id};
         DELETE FROM credentials WHERE user_id = ${user.id};
         DELETE FROM invites WHERE user_id = ${user.id} AND used_at IS NULL;`);
    console.log(`Revoked ${user.name}: signed out everywhere, passkeys and open invites deleted.`);
    break;
  }
  default:
    fail("Commands: add <name> | again <id> | list | revoke <id>   (add --local for the dev server)");
}

function printInvite(userId, name) {
  if (!siteUrl) fail("Where is the site? Pass --url https://afterwrd.<you>.workers.dev or set AFTERWRD_URL.");
  const token = randomBytes(32).toString("base64url");
  const hash = createHash("sha256").update(token).digest("hex");
  sql(`INSERT INTO invites (token_hash, user_id, expires_at) VALUES ('${hash}', ${userId}, ${now + OWNER_INVITE_SECONDS})`);
  console.log(`Device link for ${name} (works once, for one hour, and gives OWNER access):\n\n  ${siteUrl}/_auth/invite/${token}\n`);
  console.log("Open it only on your own phone or computer; whoever opens it first gets in.");
}

function findUser(id) {
  if (!/^\d+$/.test(id ?? "")) fail("Give the person's number from: npm run invite -- list");
  const [user] = sql(`SELECT id, name, is_owner FROM users WHERE id = ${id} AND revoked_at IS NULL`);
  if (!user) fail(`No current person with number ${id}.`);
  return user;
}

function sql(command) {
  const result = spawnSync("npx", ["wrangler", "d1", "execute", "afterwrd", local ? "--local" : "--remote", "--json",
    "--command", command], { encoding: "utf8" });
  if (result.status !== 0) fail(`wrangler failed:\n${result.stderr || result.stdout}`);
  return JSON.parse(result.stdout).flatMap((r) => r.results ?? []);
}

function quote(text) {
  return `'${text.replaceAll("'", "''")}'`;
}

function day(ts) {
  return new Date(ts * 1000).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

function take(flag) {
  const i = args.indexOf(flag);
  if (i === -1) return false;
  args.splice(i, 1);
  return true;
}

function option(flag) {
  const i = args.indexOf(flag);
  if (i === -1) return undefined;
  const [, v] = args.splice(i, 2);
  return v;
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
