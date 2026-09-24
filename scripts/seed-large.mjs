/**
 * Seed a LARGE throwaway book and serve the real UI against it.
 *
 * WHY THIS EXISTS
 * ---------------
 * The demo book has four customers. Every list looked fine against four
 * customers, and the day a real book held 150 the questions changed: does the
 * customer table still scroll with its header in reach, does the People page
 * still answer in one screenful, does a render take long enough to feel?
 * None of the 28 suites can see that — they prove correctness, not comfort.
 * This script builds the volume and serves it on a spare port so a person
 * (or agent-browser) can feel it.
 *
 * Throwaway directory, spare port, nothing touches data/.
 *
 * Run from Waypoint/:  node scripts/seed-large.mjs   (then open the URL it prints)
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { pbkdf2Sync, randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = Number(process.env.LARGE_PORT || 8789);
const PASSWORD = process.env.WP_PASS || 'Waypoint#2026';
const NAME = 'Teh Bin Shun';
const TEAM = ['Jason Lim', 'Priya Nair', 'Tan Wei Ming', NAME];

const gd = (days) => { const d = new Date(Date.now() + days * 864e5); return d.toISOString().slice(0, 10); };
const pick = (arr, i) => arr[i % arr.length];

const INDUSTRIES = ['Banking & Finance', 'Telecommunications', 'Retail', 'Manufacturing',
  'Property & Construction', 'Healthcare', 'Logistics', 'Media & Entertainment', 'Energy', 'Public sector'];
const CITIES = ['Kuala Lumpur', 'Cyberjaya', 'Singapore', 'Jakarta', 'Bangkok', 'Penang'];
const STANCES = ['With us', 'Undecided', 'Against us'];
const HEALTHS = ['Healthy', 'Healthy', 'Healthy', 'Watch', 'At risk'];
const BANDS = ['Decision maker', 'Influencer', 'Influencer', 'Blocker', undefined, undefined];
const TITLES = ['CIO', 'CTO', 'Head of Data Platforms', 'IT Director', 'Procurement Lead',
  'VP Engineering', 'Chief Risk Officer', 'Head of Digital', 'Infrastructure Lead', 'CFO'];
const SURNAMES = ['Lim', 'Tan', 'Nair', 'Menon', 'Halim', 'Nizam', 'Kumar', 'Wong', 'Abdullah', 'Chen',
  'Krishnan', 'Rahman', 'Ng', 'Subramaniam', 'Ismail', 'Lee', 'Singh', 'Ong', 'Yusof', 'Teo'];
const GIVEN = ['Sarah', 'Rajesh', 'Mei Ling', 'Amir', 'Shahrul', 'Vijay', 'Nurul', 'David', 'Priya', 'Daniel',
  'Farah', 'Kelvin', 'Aisha', 'Marcus', 'Siti', 'Jason', 'Anita', 'Hafiz', 'Grace', 'Ravi'];
const MEET_KINDS = ['Meeting', 'Video call', 'Site visit', 'Phone call', 'Workshop'];

function person(i, j, owner){
  const n = pick(GIVEN, i * 7 + j) + ' ' + pick(SURNAMES, i * 3 + j * 5);
  return {
    id: 'p_l' + i + '_' + j, n,
    t: pick(TITLES, i + j), band: pick(BANDS, i * 11 + j), s: pick(STANCES, i * 5 + j),
    e: n.toLowerCase().replace(/ /g, '.') + '@example' + (i % 97) + '.com',
    ph: '+60 3-' + String(2000 + (i * 13 + j) % 800) + ' ' + String(1000 + (i * 7 + j) % 9000),
    o: pick(TEAM, i + j), note: j === 0 ? 'Met at the Q3 review.' : '',
  };
}

function seed(dir){
  const salt = randomBytes(16);
  const hash = pbkdf2Sync(PASSWORD, salt, 150_000, 32, 'sha256');
  const at = new Date().toISOString();

  const customers = [];
  const interactions = [];
  const steps = [];
  const opps = {};
  const audit = [];
  /* A fresh book's own stage ladder (Waypoint-v1.html:1484) — a deal seeded
     into a stage the book does not have is a deal no column will show. */
  const STAGES = ['Interested', 'Evaluating', 'POC / Quoted', 'Submitted'];

  const N = 160;
  for (let i = 0; i < N; i++){
    const id = 'c_l' + i;
    const name = pick(GIVEN, i) + ' ' + pick(INDUSTRIES, i).split(' ')[0] + ' Group ' + (i + 1);
    /* Three customers carry the long tails: 40 contacts, a long audit trail,
       a long watch list — the screens that cap or chunk must be seen doing it. */
    const nContacts = i < 3 ? 40 : 2 + (i % 3);
    const contacts = [];
    for (let j = 0; j < nContacts; j++) contacts.push(person(i, j, pick(TEAM, i)));
    const owner = pick(TEAM, i);
    customers.push({
      id, name, industry: pick(INDUSTRIES, i), hq: pick(CITIES, i),
      owner, sa: pick(TEAM, i + 1), stance: pick(STANCES, i * 7), health: pick(HEALTHS, i * 3),
      since: gd(-30 - (i * 17) % 700), site: 'example' + i + '.com',
      people: 500 + (i * 137) % 20000,
      brief: 'Seeded volume record ' + (i + 1) + ' — exists to make long lists long.',
      pains: [], contacts, apps: [], timeline: [],
      opps: [], support: [], team: [owner], links: [], sources: [],
    });

    /* ~320 interactions spread over five months so the month groups open */
    const nMeet = (i % 5 === 0) ? 4 : (i % 2);
    for (let k = 0; k < nMeet; k++){
      const d = gd(-(i * 3 + k * 19) % 150);
      interactions.push({
        id: 'm_l' + i + '_' + k, c: id, t: pick(MEET_KINDS, i + k) + ' — ' + pick(TITLES, k) + ' sync',
        d, loc: pick(['Their office', 'Video call', 'Our office', 'On site'], i + k),
        att: contacts[0] ? contacts[0].n : '', ours: pick(TEAM, i),
        sum: 'Seeded interaction for volume testing.',
        out: k === 0 ? 'Follow-up agreed.' : '',
        k: pick(MEET_KINDS, i + k), createdAt: d, updatedAt: at,
      });
    }

    /* ~60 opportunities across the four live stages */
    if (i % 8 < 3){
      const oid = 'o_l' + i;
      const stage = pick(STAGES, i);
      opps[oid] = { id: oid, c: id, t: pick(INDUSTRIES, i + 2).split(' ')[0] + ' platform programme',
        stage, v: 400000 + (i * 97331) % 4600000, p: 20 + (i * 13) % 70,
        stageAt: gd(-(i % 60)), owner: pick(TEAM, i + 2), comp: 'Incumbent vendor',
        close: gd(30 + i % 120), cust: contacts[0] ? contacts[0].n : '', desc: '', soln: '',
        blockers: '', updatedAt: at };
      customers[i].opps.push(oid);
    }

    /* ~120 next steps, a fifth of them overdue */
    if (i % 4 < 3){
      const overdue = i % 5 === 0;
      steps.push({ id: 's_l' + i, c: id, o: customers[i].opps[0] || '',
        t: pick(['Send the revised proposal', 'Confirm the security review date', 'Deliver the POC plan',
          'Collect their feedback on the evaluation', 'Schedule the steering committee'], i),
        exec: pick(TEAM, i + 1), track: pick(TEAM, i), due: gd(overdue ? -(1 + i % 14) : (2 + i % 30)),
        from: i % 6 === 5 ? 'customer' : 'us', p: 'p1',
        done: '', doneBy: '', doneNote: '', createdAt: gd(-20), updatedAt: at });
    }

    /* the first three customers get long audit + watch tails */
    if (i < 3){
      for (let a = 0; a < 34; a++){
        audit.push({ id: 'a_l' + i + '_' + a, d: gd(-(a % 28)), tm: gd(-(a % 28)),
          k: 'data', what: pick(['Contact updated', 'Opportunity moved', 'Interaction logged', 'Field edited'], a),
          rec: name, who: pick(TEAM, a), role: 'bd', from: 'seeded value ' + a, to: 'seeded value ' + (a + 1) });
      }
    }
  }

  const state = {
    schemaVersion: 1, setupComplete: true,
    users: [
      { id: 'u_teh', name: NAME, role: 'admin', title: 'Senior Solution Architect', locked: false, createdAt: at, updatedAt: at },
      ...TEAM.slice(0, 3).map((n, i) => ({ id: 'u_' + i, name: n, role: 'bd', title: 'BD', locked: false, createdAt: at, updatedAt: at })),
    ],
    credentials: {
      u_teh: { userId: 'u_teh', algo: 'pbkdf2-sha256', iterations: 150_000, salt: salt.toString('base64'), hash: hash.toString('base64'), createdAt: at, updatedAt: at },
    },
    logs: [{ id: 'l_seed', at, action: 'create', entityType: 'auth', entityId: 'u_teh', summary: 'Large seeded book for volume testing' }],
    customers, interactions, steps, audit, opps,
    team: [], files: [], watch: [],
  };
  writeFileSync(join(dir, 'workbench.json'), JSON.stringify(state));
  writeFileSync(join(dir, 'workbench.rev.json'), JSON.stringify({ rev: 1, savedAt: at }));
  return { nCust: customers.length, nPpl: customers.reduce((a, c) => a + c.contacts.length, 0),
    nMeet: interactions.length, nSteps: steps.length, nOpps: Object.keys(opps).length };
}

const dir = mkdtempSync(join(tmpdir(), 'wplarge-'));
const counts = seed(dir);
const p = spawn(process.execPath, ['server/server.mjs'], {
  env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', WB_DATA_DIR: dir, WB_TLS: '0', WB_ORIGINS: `http://127.0.0.1:${PORT}` },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
p.stdout.on('data', (d) => { log += d.toString(); });
p.stderr.on('data', (d) => { log += d.toString(); });
for (let i = 0; i < 60; i++){
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/api/health`);
    if (r.ok){
      console.log(`LARGE BOOK UP  http://127.0.0.1:${PORT}/`);
      console.log(`sign in as "${NAME}" / "${PASSWORD}"`);
      console.log(`seeded: ${counts.nCust} customers · ${counts.nPpl} people · ${counts.nMeet} interactions · ${counts.nOpps} opportunities · ${counts.nSteps} steps`);
      console.log(`data dir: ${dir}  (throwaway)`);
      process.on('SIGINT', () => { p.kill(); process.exit(0); });
      await new Promise(() => {});
    }
  } catch { /* not yet */ }
  await new Promise((r) => setTimeout(r, 120));
}
console.error('server never came up:\n' + log);
p.kill();
process.exit(1);
