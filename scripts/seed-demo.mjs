/**
 * Seed a workspace with the accounts and ONE demo customer.
 *
 * WHY THIS EXISTS
 * ---------------
 * The product must be testable from a clean slate, and §29 of the brief asks
 * for exactly one demo customer that walks the whole business chain:
 *
 *   Customer → Opportunity → Next Step → MOM → new Next Step → new Opportunity
 *            → Timeline
 *
 * The previous attempt at demo data was a sample customer baked into the HTML.
 * It survived an empty server state and wrote itself into real workspaces on
 * the first save (see the fence at `demo data` in Waypoint-v1.html). That is
 * why this script exists as a SEPARATE file that writes a SEPARATE workspace:
 * the shipped page carries no sample data at all, and this script never
 * touches `data/` unless you point it there on purpose.
 *
 * USAGE
 *   node scripts/seed-demo.mjs                       # seeds <root>/data
 *   WB_DATA_DIR=/tmp/demo node scripts/seed-demo.mjs # seeds an isolated space
 *   node scripts/seed-demo.mjs --force               # overwrite a non-empty book
 *
 * It refuses to overwrite a workspace that already holds customers unless
 * `--force` is given: silently replacing a book somebody is working in is the
 * one thing a seeding tool must never do quietly.
 */
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { randomBytes, pbkdf2Sync } from 'node:crypto';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const DATA_DIR = process.env.WB_DATA_DIR ? resolve(process.env.WB_DATA_DIR) : join(ROOT, 'data');
const DATA_FILE = join(DATA_DIR, 'workbench.json');
const REV_FILE = join(DATA_DIR, 'workbench.rev.json');

const FORCE = process.argv.includes('--force');

/* Must match src/lib/auth.ts and server/server.mjs, or the server will reject
   credentials this script writes. */
const ALGO = 'pbkdf2-sha256';
const KEY_LEN = 32;
const SALT_LEN = 16;
const ITERATIONS = 150_000;
const PASSWORD = process.env.SEED_PASS || 'Waypoint#2026';

const now = new Date().toISOString();
const today = new Date().toISOString().slice(0, 10);
const day = (n) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
};
const month = today.slice(0, 7);
const id = (p, n) => `${p}${Date.now()}${String(n).padStart(3, '0')}`;

function hash(password) {
  const salt = randomBytes(SALT_LEN);
  const key = pbkdf2Sync(password, salt, ITERATIONS, KEY_LEN, 'sha256');
  return {
    algo: ALGO,
    iterations: ITERATIONS,
    salt: salt.toString('base64'),
    hash: key.toString('base64'),
  };
}

/* ---------------------------------------------------------------- accounts
   Four real roles, so §35 can walk the product as each of them. The brief
   names the roles Admin / Manager / Primary BD / Primary SA.

   WHY THE FIRST ACCOUNT IS EXACTLY `u_teh` / `Teh Bin Shun`
   Several suites (`verify-newflows`, `verify-journey`) copy THIS file as the
   fixture they run against, then sign in as `tehbinshun@global.tencent.com`
   and drive the screens. The ACCOUNT ID matters as much as the name: the
   client resolves the signed-in person against `team` rows and customer
   ownership by id, so a workspace whose admin is `u_kelvin` while the roster
   says `u_teh` signs in successfully and then behaves as an unauthenticated
   stranger — the lookup sheet answers "Sign in to the shared workspace."
   That is not a smaller seed; it is a broken test run, which is how this was
   found. The other three are new, and nothing depends on their ids. */
const PEOPLE = [
  { id: 'u_teh',     name: 'Teh Bin Shun', role: 'admin',   title: 'Senior Solution Architect',
    email: 'tehbinshun@global.tencent.com' },
  { id: 'u_manager', name: 'Tan Wei Ming',  role: 'manager', title: 'Head of Cloud Business' },
  { id: 'u_bd',      name: 'Jason Lim',     role: 'bd',      title: 'Account Manager' },
  { id: 'u_sa',      name: 'Priya Nair',    role: 'sa',      title: 'Solution Architect' },
  /* Not an account — a supporting person. §3: Non-Core Members have no
     WorkBuddy account and no customer permission. David Tan exists only as a
     name inside the demo record, which is the whole point of the pattern. */
];

const users = PEOPLE.map((p) => ({
  id: p.id,
  name: p.name,
  email: p.email || '',
  role: p.role,
  title: p.title,
  createdAt: now,
  updatedAt: now,
}));

const credentials = {};
for (const p of PEOPLE) {
  credentials[p.id] = { userId: p.id, ...hash(PASSWORD), createdAt: now, updatedAt: now };
}

/* ------------------------------------------------------------ the customer
   ONE customer. §29 is explicit: one demo customer, clearly labelled, and it
   must not look like a production account. The name says SAMPLE because the
   product has to be able to say so everywhere it appears. */
const CID = id('c', 1);
const OPP1 = id('o', 1);
const OPP2 = id('o', 2);
const M1 = id('m', 1);
const S1 = id('s', 1);
const S2 = id('s', 2);
const S3 = id('s', 3);

const customer = {
  id: CID,
  name: 'SAMPLE - Nusantara Retail Group',
  industry: 'Retail',
  hq: 'Kuala Lumpur',
  size: '~4,000 staff',
  stance: 'Undecided',
  health: 'Watch',
  /* Both owners are set, because §2 says exactly 1 Primary BD and exactly 1
     Primary SA. These two fields are what scopes the whole book for each of
     them, and what a Next Step's Tracker must be drawn from. */
  owner: 'Jason Lim',
  sa: 'Priya Nair',
  since: month,
  site: 'nusantara-retail.example',
  logo: '',
  people: '',
  brief:
    'A Malaysian retail group running its own e-commerce and loyalty platforms. '
    + 'Three of their systems are due for a refresh inside the next two quarters, '
    + 'and their board has asked for an AI roadmap by year end.',
  pains: [
    'Peak-season load breaks their order platform every December',
    'No central view of customer data across 240 stores',
    'Warehouse forecasting is still a spreadsheet',
  ],
  /* Contacts are the customer's OWN people — not our BD/SA. §2 is precise
     about this: the Customer Department Owner is the customer's person. */
  contacts: [
    { id: id('p', 1), n: 'Farah Idris', t: 'Head of Digital', band: 'Decision maker',
      s: 'Undecided', e: 'farah.idris@nusantara-retail.example', ph: '+60 3-1234 5678', o: 'Jason Lim' },
    { id: id('p', 2), n: 'Ahmad Zaki', t: 'IT Director', band: 'Influencer',
      s: 'With us', e: 'ahmad.zaki@nusantara-retail.example', ph: '+60 3-1234 5679', o: 'Priya Nair' },
    { id: id('p', 3), n: 'Lim Siew Chin', t: 'CFO', band: 'Blocker',
      s: 'Against us', e: 'sc.lim@nusantara-retail.example', ph: '+60 3-1234 5680', o: 'Jason Lim' },
  ],
  /* §4 Existing Environment — the customer's OWN estate, not our solution.
     The row shape is `{ n, v, stance }` — the same keys the Add form writes
     (saveAdd's system branch) and tabRun renders (it groups by a.stance and
     prints a.v). Born as `{ n, runs, pos }`, which rendered as nothing. */
  apps: [
    { n: 'Order platform (on-prem)', v: 'Legacy Java on bare metal', stance: 'Replace' },
    { n: 'Loyalty system', v: 'Vendor-hosted', stance: 'Integrate' },
    { n: 'Data warehouse', v: 'On-prem SQL Server', stance: 'Both' },
  ],
  opps: [OPP1, OPP2],
  timeline: [],
  /* §3 Non-Core Members: names with no account behind them. A Product SA who
     executes a step but is not on the account team. */
  support: ['David Tan (Product SA, Database)'],
  team: ['Priya Nair'],
  demo: true,
  unverified: false,
  links: [],
  sources: [],
};

/* ---------------------------------------------------- the two opportunities
   §12: the field set the brief asks the Opportunity page to show. */
const opps = {
  [OPP1]: {
    id: OPP1, c: CID, t: 'Retail data platform modernisation',
    stage: 'Interested', v: 1800000, p: 20,
    stageAt: day(-12),
    owner: 'Jason Lim',
    comp: 'Incumbent local SI',
    close: day(150),
    cust: 'Farah Idris',
    desc: 'Consolidate the order, loyalty and warehouse data onto one managed platform.',
    soln: 'TencentDB + data lake, phased over two quarters',
    /* §13 rule-based health signals, stated with their reason. */
    blockers: 'CFO has not released the budget line yet',
    updatedAt: now,
  },
  [OPP2]: {
    id: OPP2, c: CID, t: 'AI roadmap advisory engagement',
    stage: 'Qualified', v: 420000, p: 40,
    stageAt: day(-3),
    owner: 'Priya Nair',
    comp: '-',
    close: day(90),
    cust: 'Ahmad Zaki',
    desc: 'Short advisory engagement to produce the AI roadmap their board asked for.',
    soln: 'Solution workshop + reference architecture',
    blockers: '',
    updatedAt: now,
  },
};

/* --------------------------------------------------------- three Next Steps
   §5 is the heart of this phase: a Next Step has TWO people.
     exec  — who does the work. May be anyone, including a Non-Core Member.
     track — who follows up. MUST be this customer's Primary BD or Primary SA.
   The three rows below demonstrate all three shapes:
     S1  executed and completed by a Non-Core Member (Product SA David Tan),
         tracked by the Primary SA. This is Scenario 3 and §6 in one record.
     S2  our move, executed by the Primary BD.
     S3  waiting on the customer. */
const steps = [
  {
    id: S1, c: CID, o: OPP1,
    t: 'Size the data platform migration and send the architecture note',
    exec: 'David Tan (Product SA, Database)',
    track: 'Priya Nair',
    due: day(-2),
    from: 'us', p: 'p1',
    /* §6: a completed action keeps its completion date, who completed it, and
       its original execution owner. Nothing about it disappears. */
    done: day(-2),
    doneBy: 'David Tan (Product SA, Database)',
    doneNote: 'Architecture note sent; 3 phases, 14 weeks.',
    createdAt: day(-14),
    updatedAt: now,
  },
  {
    id: S2, c: CID, o: OPP1,
    t: 'Get the budget line confirmed with the CFO',
    exec: 'Jason Lim',
    track: 'Jason Lim',
    due: day(3),
    from: 'us', p: 'p1',
    done: '', doneBy: '', doneNote: '',
    createdAt: day(-10),
    updatedAt: now,
  },
  {
    id: S3, c: CID, o: null,
    t: 'Send the AI roadmap scope document',
    exec: 'the customer',
    track: 'Priya Nair',
    due: day(7),
    from: 'customer', p: 'p1',
    done: '', doneBy: '', doneNote: '',
    createdAt: day(-3),
    updatedAt: now,
  },
];

/* ---------------------------------------------------- the one MOM (interaction)
   §15/§16: a MOM connects to Customer, Opportunity, People, Next Steps and
   the Timeline. The AI-extracted content lives here as REVIEWED, ACCEPTED
   text — which is the only form that may ever become a business record (§8).
   §17: the same table carries the lighter interaction types. */
const interactions = [
  {
    id: M1, c: CID, o: OPP1,
    t: 'Data platform scoping workshop',
    d: day(-14), w: 'Two weeks ago', loc: 'Their KL office',
    att: 'Farah Idris, Ahmad Zaki, 2 engineers',
    ours: 'Jason Lim, Priya Nair',
    sum:
      'Walked through their current order, loyalty and warehouse estate. They confirmed '
      + 'peak-season load as the main pain and accepted our phased approach in principle. '
      + 'Finance is the gate: the CFO wants a single number before she releases anything.',
    out: 'Accepted the phased approach; waiting on the CFO for the budget line.',
    k: 'Meeting',
    /* §8: AI output that a human accepted. Marked, so nobody mistakes it for
       something a person typed. */
    ai: {
      summaryBy: 'model', acceptedBy: 'Priya Nair', acceptedAt: day(-14),
      concerns: ['Peak-season load on the order platform', 'No central customer view'],
      decisions: ['Phased delivery accepted in principle', 'Architecture note to be reviewed internally'],
      commitments: ['We send the architecture note', 'They return it with comments'],
      risks: ['CFO has not released the budget'],
    },
    createdAt: day(-14),
    updatedAt: now,
  },
];

/* -------------------------------------------------------------- timeline
   §18: the business history. Every entry names the thing it came from, so a
   reader can always get back to the record. */
const timeline = [
  { d: day(-20), k: 'customer', t: 'Customer created', x: 'Added by Jason Lim' },
  { d: day(-16), k: 'opp', t: 'Opportunity created: Retail data platform modernisation', x: 'RM 1,800,000 · Interested' },
  { d: day(-14), k: 'interaction', t: 'Data platform scoping workshop', x: 'Accepted the phased approach; waiting on the CFO for the budget line.' },
  { d: day(-14), k: 'step', t: 'Action: Size the data platform migration and send the architecture note', x: 'David Tan (Product SA, Database) · tracked by Priya Nair' },
  { d: day(-12), k: 'opp', t: 'Opportunity created: AI roadmap advisory engagement', x: 'RM 420,000 · Qualified' },
  { d: day(-3), k: 'step', t: 'Action: Send the AI roadmap scope document', x: 'Waiting on the customer · tracked by Priya Nair' },
  { d: day(-2), k: 'done', t: 'Done: Size the data platform migration and send the architecture note', x: 'Completed by David Tan (Product SA, Database)' },
];
customer.timeline = timeline;

/* The audit trail is what §24's version history reads from. */
const audit = timeline.map((t, i) => ({
  id: id('a', i),
  tm: t.d, d: t.d, k: 'data', role: 'bd',
  rec: t.t + ' - ' + customer.name,
  what: t.t, who: 'Jason Lim',
  from: '-', to: t.x,
  updatedAt: now,
}));

/* -------------------------------------------------------- the catalogue
   The sellable list. Source: the Tencent Cloud International Singapore &
   Johor product inventory (attachment `tencentcloud_intl_singapore_
   johor_products.md`, data cutoff 2026-09-19) — every cloud service it
   names, 149 across 14 categories. Regions are deliberately NOT modelled:
   the team sells the service, and the region is a conversation, not a
   catalogue row.

   Each entry is [name, category, abbreviation, one-liner]. The same content
   ships inside Waypoint-v1.html as the brand-new-workspace default (the
   `products:` array near the top of that file) — keep the two in step. */
const DB_SA = { n: 'David Tan', r: 'Product SA, Database', hq: 'KL', how: 'WeCom' };
const CATALOGUE = [
  /* — Compute (9) — */
  ['Cloud Virtual Machine', 'Compute', 'CVM', 'Elastic cloud servers - the baseline everything else sits on.'],
  ['Tencent Cloud Lighthouse', 'Compute', 'LH', 'Simple application servers - the easy first workload for an SMB.'],
  ['Cloud GPU Service', 'Compute', 'GPU', 'GPU instances for AI training and inference.'],
  ['CVM Dedicated Host', 'Compute', 'CDH', 'Dedicated physical hosts with isolated resources.'],
  ['Cloud Bare Metal', 'Compute', 'CBM', 'Non-virtualised bare metal compute.'],
  ['Auto Scaling', 'Compute', 'AS', 'Add and remove CVMs on demand.'],
  ['Tencent Cloud Automation Tools', 'Compute', 'TAT', 'Run commands and patches across a fleet.'],
  ['Batch Compute', 'Compute', 'BC', 'Distributed batch computing scheduler.'],
  ['Hyper Computing Cluster', 'Compute', 'HCC', 'High-bandwidth, low-latency compute clusters.'],
  /* — Storage (6) — */
  ['Cloud Object Storage', 'Storage', 'COS', 'Object storage, tiered by access - backups and static assets.'],
  ['Cloud Block Storage', 'Storage', 'CBS', 'Block volumes attached to a CVM.'],
  ['Cloud File Storage', 'Storage', 'CFS', 'Shared NFS filesystem for workloads that will not use objects.'],
  ['Cloud HDFS', 'Storage', 'CHDFS', 'Hadoop-compatible filesystem for the big-data estate.'],
  ['GooseFileSystem', 'Storage', 'GFS', 'Data-lake acceleration filesystem.'],
  ['LighthouseCOS', 'Storage', 'LCOS', 'Object storage bundled with Lighthouse.'],
  /* — Network (12) — */
  ['Virtual Private Cloud', 'Network', 'VPC', 'Your own network inside the region, with the routing you choose.'],
  ['Cloud Load Balancer', 'Network', 'CLB', 'Spread traffic across instances and zones.'],
  ['NAT Gateway', 'Network', 'NAT', 'Outbound internet for a VPC without public IPs on every box.'],
  ['Elastic IP', 'Network', 'EIP', 'A public IP that moves with the workload.'],
  ['Bandwidth Package', 'Network', 'BWP', 'Aggregate billing across many IPs.'],
  ['Flow Logs', 'Network', 'FL', 'Capture VPC traffic for audit and forensics.'],
  ['Anycast Internet Acceleration', 'Network', 'AIA', 'Anycast IP routing for cleaner entry paths.'],
  ['Direct Connect', 'Network', 'DC', 'A dedicated line into the region - the migration path for real workloads.'],
  ['Cloud Connect Network', 'Network', 'CCN', 'Interconnect VPCs across regions.'],
  ['Peering Connection', 'Network', 'PC', 'Connect two VPCs without leaving the cloud.'],
  ['VPN Connection', 'Network', 'VPN', 'IPsec tunnels back to their own network.'],
  ['Global Application Acceleration Platform', 'Network', 'GAAP', 'Accelerate an app for users far from its home region.'],
  /* — Database (14) — */
  ['TencentDB for MySQL', 'Database', 'MY', 'Managed MySQL, the workhorse of most migrations.'],
  ['TencentDB for SQL Server', 'Database', 'MSS', 'Managed SQL Server for estates that cannot leave it yet.'],
  ['TencentDB for PostgreSQL', 'Database', 'PG', 'Managed PostgreSQL with the extensions kept current.'],
  ['Cloud Native Database TDSQL-C', 'Database', 'TDSQL-C', 'MySQL- and PostgreSQL-compatible, storage that grows alone.'],
  ['TDSQL Boundless', 'Database', 'TDSQL-B', 'Distributed database with elastic horizontal scale.'],
  ['TencentDB for Redis', 'Database', 'RED', 'Managed Redis, cluster mode, with the failover we run.'],
  ['TencentDB for MongoDB', 'Database', 'MON', 'Managed MongoDB replica sets.'],
  ['TencentDB for CTSDB', 'Database', 'CTSDB', 'Time-series database for IoT and monitoring.'],
  ['Tencent Cloud VectorDB', 'Database', 'VectorDB', 'Vector database for AI retrieval.'],
  ['TencentDB for Tendis', 'Database', 'Tendis', 'Redis-compatible KV storage.'],
  ['TencentDB for DBbrain', 'Database', 'DBbrain', 'Database performance diagnosis as a service.'],
  ['Data Transfer Service', 'Database', 'DTS', 'Zero-downtime migration between databases.'],
  ['Database Expert Service', 'Database', 'DES', 'Professional DBAs when the database has a bad day.'],
  ['Database Management Center', 'Database', 'DMC', 'One console for every database.'],
  /* — Containers & Middleware (12) — */
  ['Tencent Kubernetes Engine', 'Containers & Middleware', 'TKE', 'Managed Kubernetes, with the control plane we run.'],
  ['TKE for Serverless', 'Containers & Middleware', 'TKE-S', 'Kubernetes without nodes to babysit.'],
  ['Tencent Container Registry', 'Containers & Middleware', 'TCR', 'Secure container image storage and distribution.'],
  ['TKE Distributed Cloud Center', 'Containers & Middleware', 'TDCC', 'One Kubernetes estate across clouds and edges.'],
  ['Serverless Cloud Function', 'Containers & Middleware', 'SCF', 'Run code without a server to patch.'],
  ['TDMQ for CKafka', 'Containers & Middleware', 'CKafka', 'Managed Apache Kafka for event streams between systems.'],
  ['TDMQ for RocketMQ', 'Containers & Middleware', 'RocketMQ', 'Apache RocketMQ-compatible messaging.'],
  ['TDMQ for RabbitMQ', 'Containers & Middleware', 'RabbitMQ', 'AMQP-compatible queues for the Java and .NET estates.'],
  ['TDMQ for Apache Pulsar', 'Containers & Middleware', 'Pulsar', 'Cloud-native message queue with tiered storage.'],
  ['TDMQ for MQTT', 'Containers & Middleware', 'MQTT', 'Messaging for IoT and connected vehicles.'],
  ['TDMQ for CMQ', 'Containers & Middleware', 'CMQ', 'The classic queue service - still working, still billing.'],
  ['API Gateway', 'Containers & Middleware', 'API', 'Publish, secure and meter APIs in one place.'],
  /* — CDN & Edge (6) — */
  ['Tencent Cloud EdgeOne', 'CDN & Edge', 'EO', 'CDN, WAF and DDoS scrubbing at the edge, one console.'],
  ['Content Delivery Network', 'CDN & Edge', 'CDN', 'Static and video delivery close to the viewer.'],
  ['Enterprise CDN', 'CDN & Edge', 'ECDN', 'Dynamic-content acceleration for enterprise apps.'],
  ['Anti-DDoS', 'CDN & Edge', 'DDoS', 'Volumetric scrubbing before it reaches your VPC.'],
  ['Global Office Access', 'CDN & Edge', 'GOA', 'Accelerated networking for branch and home offices.'],
  ['Edge Computing Machine', 'CDN & Edge', 'ECM', 'Compute at the edge, close to the users.'],
  /* — Security (16) — */
  ['Web Application Firewall', 'Security', 'WAF', 'Layer-7 protection for anything public-facing.'],
  ['Cloud Firewall', 'Security', 'CFW', 'Control traffic between VPCs and out to the internet.'],
  ['Cloud Workload Protection Platform', 'Security', 'CWPP', 'Server security - the agent on every box.'],
  ['Tencent Container Security Service', 'Security', 'TCSS', 'Runtime security for the container estate.'],
  ['Cloud Security Center', 'Security', 'SSC', 'One pane for every security signal.'],
  ['Vulnerability Scan Service', 'Security', 'VSS', 'Automated scanning before somebody else scans you.'],
  ['Firewall Manager', 'Security', 'FM', 'One firewall policy across many accounts.'],
  ['Captcha', 'Security', 'CAP', 'Separate people from bots at the door.'],
  ['Data Security Governance Center', 'Security', 'DSGC', 'Classify and grade the data before protecting it.'],
  ['Bastion Host', 'Security', 'BH', 'Audited, controlled access for operations teams.'],
  ['Data Security Audit', 'Security', 'DSA', 'See every query that touched the database.'],
  ['Key Management Service', 'Security', 'KMS', 'Create and control encryption keys.'],
  ['Secrets Manager', 'Security', 'SM', 'Vault the credentials nobody should see in clear.'],
  ['Security Expert Service', 'Security', 'SES', 'Security consultants when the question is bigger than a product.'],
  ['Penetration Testing Service', 'Security', 'PENTEST', 'Professional pen-testing with a report you can act on.'],
  ['Managed Security Service', 'Security', 'MSS', 'We run the monitoring so the team does not have to.'],
  /* — Media & RTC (12) — */
  ['Chat', 'Media & RTC', 'IM', 'In-app and group messaging - global, not region-bound.'],
  ['Real-time Communication', 'Media & RTC', 'TRTC', 'Real-time audio and video in the app.'],
  ['Cloud Streaming Services', 'Media & RTC', 'CSS', 'Live streaming from ingest to playback.'],
  ['Video on Demand', 'Media & RTC', 'VOD', 'Store, transcode and deliver recorded video.'],
  ['Mobile Live Video Broadcasting', 'Media & RTC', 'MLVB', 'Push-and-pull streaming SDKs for mobile apps.'],
  ['User Generated Short Video SDK', 'Media & RTC', 'UGSV', 'Short-video capture and playback in the app.'],
  ['Tencent Effect SDK', 'Media & RTC', 'X-Magic', 'Beauty filters and effects for live video.'],
  ['Media Processing Service', 'Media & RTC', 'MPS', 'Transcode, watermark and moderate video at scale.'],
  ['Cloud Application Rendering', 'Media & RTC', 'CAR', 'Stream rendered applications to any device.'],
  ['Game Multimedia Engine', 'Media & RTC', 'GME', 'In-game voice, from lobby to squad.'],
  ['Cloud Contact Center', 'Media & RTC', 'CCC', 'A contact centre without the call-centre room.'],
  ['Low-code Interactive Classroom', 'Media & RTC', 'LCIC', 'Online classrooms assembled from blocks.'],
  /* — Big Data (10) — */
  ['Elastic MapReduce', 'Big Data', 'EMR', 'Managed Hadoop and Spark when batch is the answer.'],
  ['Elasticsearch Service', 'Big Data', 'ES', 'Managed search and analytics cluster.'],
  ['Stream Compute Service', 'Big Data', 'SCS', 'Managed Flink for real-time streams.'],
  ['Data Lake Compute', 'Big Data', 'DLC', 'Query the data lake without moving it.'],
  ['Tencent Cloud TCHouse-C', 'Big Data', 'TCHouse-C', 'Managed ClickHouse for high-throughput analytics.'],
  ['Tencent Cloud TCHouse-D', 'Big Data', 'TCHouse-D', 'Managed Doris for real-time warehousing.'],
  ['Tencent Cloud TCHouse-P', 'Big Data', 'TCHouse-P', 'The OLAP warehouse for serious aggregation.'],
  ['Tencent Cloud WeData', 'Big Data', 'WED', 'Integration, scheduling and governance in one console.'],
  ['Business Intelligence', 'Big Data', 'BI', 'Self-service dashboards for people who are not engineers.'],
  ['EventBridge', 'Big Data', 'EB', 'Event routing between the systems that already run.'],
  /* — Dev & Ops (19) — */
  ['CloudBase', 'Dev & Ops', 'TCB', 'Front-end and mobile back-end without the back-end team.'],
  ['Cloud Access Management', 'Dev & Ops', 'CAM', 'Who may do what, sub-account by sub-account.'],
  ['Tencent Cloud Smart Advisor', 'Dev & Ops', 'SA', 'Automated architecture assessment against best practice.'],
  ['CloudAudit', 'Dev & Ops', 'AUD', 'Every API call, recorded and searchable.'],
  ['Tencent Cloud Organization', 'Dev & Ops', 'ORG', 'Manage many accounts as one estate.'],
  ['Terraform', 'Dev & Ops', 'TF', 'The estate as code, reviewed like code.'],
  ['Control Center', 'Dev & Ops', 'CC', 'One cross-product control plane.'],
  ['Tencent Cloud Code Analysis', 'Dev & Ops', 'TCA', 'Static analysis before the bug ships.'],
  ['Cloud Native Build', 'Dev & Ops', 'CNB', 'CI/CD pipelines close to the cloud they deploy to.'],
  ['Cloud Migration', 'Dev & Ops', 'CMG', 'Tooling and service to move an estate over.'],
  ['TencentCloud API', 'Dev & Ops', 'API3', 'Every product behind one API surface.'],
  ['Tencent Cloud CLI', 'Dev & Ops', 'CLI', 'The whole cloud from a terminal.'],
  ['Tencent Cloud Observability Platform', 'Dev & Ops', 'TCOP', 'Metrics, logs and traces in one place.'],
  ['TencentCloud Managed Service for Prometheus', 'Dev & Ops', 'TMP', 'Prometheus without the self-managed server.'],
  ['TencentCloud Managed Service for Grafana', 'Dev & Ops', 'TCMG', 'Grafana dashboards we keep running.'],
  ['Performance Testing Service', 'Dev & Ops', 'PTS', 'Distributed load testing before the December peak.'],
  ['Application Performance Management', 'Dev & Ops', 'APM', 'Trace the slowness to the service that owns it.'],
  ['Real User Monitoring', 'Dev & Ops', 'RUM', 'See the app the way the user saw it.'],
  ['Cloud Automated Testing', 'Dev & Ops', 'CAT', 'Probe availability from the outside.'],
  /* — AI & LLM (17) — */
  ['Tencent WorkBuddy Enterprise', 'AI & LLM', 'WBE', 'The AI workspace - a headline product in Malaysia.'],
  ['Tencent CodeBuddy', 'AI & LLM', 'CB', 'AI coding assistant for the dev team.'],
  ['Tencent WorkBuddy Managed Agents', 'AI & LLM', 'WMA', 'We run the agents the team depends on.'],
  ['LLM Service TokenHub', 'AI & LLM', 'TokenHub', 'Many foundation models behind one API.'],
  ['Tencent HY / Hy3', 'AI & LLM', 'HY', 'Our foundation models - the model behind Ask.'],
  ['Tencent HY 3D Global', 'AI & LLM', 'HY3D', 'Generate 3D assets from a prompt.'],
  ['Agent Development Platform', 'AI & LLM', 'ADP', 'Build and govern enterprise agents.'],
  ['Face Recognition', 'AI & LLM', 'FR', 'Detect, verify and search faces.'],
  ['Automatic Speech Recognition', 'AI & LLM', 'ASR', 'Speech to text, in many languages.'],
  ['Text To Speech', 'AI & LLM', 'TTS', 'Text to a natural voice.'],
  ['Tencent Machine Translation', 'AI & LLM', 'TMT', 'Translation across a hundred-odd language pairs.'],
  ['Optical Character Recognition', 'AI & LLM', 'OCR', 'Pull text out of forms, invoices and IDs.'],
  ['Face Fusion', 'AI & LLM', 'FF', 'Blend a face into media, within policy.'],
  ['eKYC (FaceID)', 'AI & LLM', 'eKYC', 'Face-based identity verification - live cases in Malaysia.'],
  ['Tencent Cloud AI Digital Human', 'AI & LLM', 'IVH', 'A presentable digital human for service roles.'],
  ['Tencent Cloud TI-ONE Platform', 'AI & LLM', 'TI-ONE', 'Train, tune and serve models on managed GPU.'],
  ['Image Creation', 'AI & LLM', 'IMG', 'AI image generation for marketing and design.'],
  /* — Messaging & Enterprise (8) — */
  ['Short Message Service', 'Messaging & Enterprise', 'SMS', 'Global SMS delivery, with OTP support.'],
  ['Simple Email Service', 'Messaging & Enterprise', 'SES', 'Transactional email that arrives.'],
  ['Domains', 'Messaging & Enterprise', 'DOM', 'Register and manage the domains.'],
  ['Cloud DNS Resolution', 'Messaging & Enterprise', 'DNS', 'Smart DNS resolution with health checks.'],
  ['HTTPDNS', 'Messaging & Enterprise', 'HTTPDNS', 'DNS over HTTP - immune to local hijacking.'],
  ['Private DNS', 'Messaging & Enterprise', 'PDNS', 'DNS that never leaves the VPC.'],
  ['SSL Certificate Service', 'Messaging & Enterprise', 'SSL', 'Issue and renew certificates without the expiry surprise.'],
  ['Tencent Cloud Blockchain as a Service', 'Messaging & Enterprise', 'BaaS', 'Blockchain nodes we operate.'],
  /* — Collaboration (4) — */
  ['Tencent VooV Meeting', 'Collaboration', 'VOOV', 'Video meetings - the international Tencent Meeting.'],
  ['Tencent Cloud Enterprise Drive', 'Collaboration', 'DRIVE', 'File storage and collaboration for the company.'],
  ['Tencent eSign', 'Collaboration', 'eSIGN', 'Contracts signed electronically, legally binding.'],
  ['Tencent Ecard', 'Collaboration', 'ECARD', 'Digital business cards.'],
  /* — IoT & Industry (4) — */
  ['IoT Hub', 'IoT & Industry', 'IOT', 'Connect and manage the device fleet.'],
  ['Marketing Automation', 'IoT & Industry', 'MA', 'Triggered campaigns across channels.'],
  ['Customer Data Platform', 'IoT & Industry', 'CDP', 'One customer profile from every touchpoint.'],
  ['Fusion Analytics', 'IoT & Industry', 'FA', 'Marketing analytics on the unified data.'],
];
const products = CATALOGUE.map(([n, cat, ab, one], i) => ({ id: 'p' + (i + 1), n, cat, ab, one, by: [] }));
/* §27's question is "what does it do, and who do I ask" — the demo answers
   it on three database products with the demo customer's non-core Product
   SA: the same David Tan who executes the first Next Step. */
for (const n of ['TencentDB for MySQL', 'Cloud Native Database TDSQL-C', 'Data Transfer Service']){
  const p = products.find(x => x.n === n);
  if (p) p.by = [{ ...DB_SA }];
}

const state = {
  schemaVersion: 1,
  setupComplete: true,
  /* A book-wide "this is sample data" mark, and the reason it lives here
     rather than in the client: the seeded workspace's figures read exactly
     like a real pipeline, so which book you are looking at has to be a fact
     about the FILE, told by the server on every read and kept by it on every
     save. A client-side flag would be dropped by the first whole-state save
     — the badge would vanish mid-demo, which is the moment it matters.
     The customer carries `demo: true` too, but that is a different claim:
     it marks one ROW as a sample inside whatever book it sits in. */
  demo: true,
  customers: [customer],
  interactions,
  steps,
  opps,
  audit,
  files: [],
  watch: [],
  /* `products` is the sellable catalogue defined above — the 149 services
     from the Singapore & Johor inventory, three of them backed by name. */
  products,
  users,
  credentials,
  /* `team` is the roster the screens read for names and roles. `c` names the
     customer a person is ON — only the two owners are on the demo customer,
     because Admin and Manager reach everything through their role rather than
     through membership. The admin row carries the customer id too: the
     baseline workspace did, the client resolves the signed-in person against
     these rows, and a roster that omits it makes an admin look like a
     stranger inside their own workspace. */
  team: PEOPLE.map((p) => ({
    id: p.id,
    n: p.name, n2: p.name, role: p.role, r: p.title,
    c: (p.role === 'bd' || p.role === 'sa' || p.role === 'admin') ? CID : null,
    f: '', last: '', st: 'active',
    updatedAt: now,
  })),
  logs: [],
  config: {
    /* Four stages on the path, and no more. The book's own logic parks Won
       and Lost off the board — `parked = !D.stages.includes(stage)`, the
       Parked heading reads "not a position on the path", and parkedCard
       paints them as results (green / red), not positions. The colour ramp
       has exactly four shades (s1..s4) and the built-in default is four
       stages, so a fifth and sixth entry here rendered as empty board
       columns with capsules no stylesheet answers. */
    stages: ['Interested', 'Qualified', 'Proposal', 'Negotiation'],
  },
};

/* ------------------------------------------------------------------ write */

if (existsSync(DATA_FILE) && !FORCE) {
  let existing = null;
  try { existing = JSON.parse(readFileSync(DATA_FILE, 'utf8')); } catch { /* unreadable */ }
  const n = Array.isArray(existing?.customers) ? existing.customers.length : 0;
  if (n > 0) {
    console.error(`\n${DATA_FILE} already holds ${n} customer(s).`);
    console.error('Refusing to overwrite a book somebody may be working in.');
    console.error('Pass --force if you really mean to replace it.\n');
    process.exit(1);
  }
}

mkdirSync(DATA_DIR, { recursive: true });
const tmp = `${DATA_FILE}.${process.pid}.tmp`;
writeFileSync(tmp, JSON.stringify(state, null, 0), 'utf8');
renameSync(tmp, DATA_FILE);
writeFileSync(REV_FILE, JSON.stringify({ rev: 1, savedAt: now }, null, 0), 'utf8');

console.log('\nSeeded a demo workspace.\n');
console.log(`  workspace : ${DATA_DIR}`);
console.log(`  customer  : ${customer.name}  (flagged demo)`);
console.log(`  people    : 1 Primary BD (${customer.owner}) + 1 Primary SA (${customer.sa})`);
console.log(`  non-core  : ${customer.support.join(', ')}  (no account, no permission)`);
console.log(`  chain     : customer → 2 opportunities → 3 next steps → 1 MOM → timeline`);
console.log(`               one step is already completed by the non-core member.`);
console.log(`  catalogue : ${products.length} sellable services in ${new Set(products.map(p => p.cat)).size} categories`);
console.log('\n  sign in with either of:');
for (const p of PEOPLE) console.log(`    ${p.name.padEnd(16)} ${p.role.padEnd(8)} ${PASSWORD}`);
console.log('\n  Start it with:  WB_DATA_DIR=' + DATA_DIR + ' npm start\n');
