#!/usr/bin/env node
// MediCare platform CLI (zero dependencies). Run from anywhere: node platform/scripts/mc.mjs <command>
//
//   configure                         create .env files with random local secrets (idempotent)
//   infra up|down|status|logs [svc]|reset
//   db bootstrap                      roles, control DB, template DB, schemas (reads backend services' "mc" metadata)
//   migrate                           orchestrator: control → template → every tenant DB, records versions in the catalog
//   gateway sync                      generate infra/kong/kong.yml from service metadata and hot-reload Kong
//   tenant create <slug> --name <n> --admin <email> | tenant list
//   plan list                         published plans and add-ons (modules, limits, price)
//   plan show <slug>                  a hospital's contract: plan, add-ons, overrides, modules and their state, history
//   plan set <slug> <PLAN> [--addons LAB,BRANCHES_5:2] [--reason text]   move a hospital to a plan (applies now)
//   billing show <slug>               subscription, invoices, usage
//   billing reset-trial <slug> [--days 14]          DEV: start a fresh trial (no card, nothing due)
//   billing advance <slug> <trial-end|period-end|next-retry|grace-end|+Nd>  DEV: move the billing clock, run what is due
//   module enable|disable|reset <slug> <module>   switch one module on/off outside the plan (reset = back to the plan)
//   events reset <group>              replay a consumer group from the start (service must be stopped; dedupe makes it safe)
//   events dlq | events replay <topic> dead-letter topics: counts and errors; send failed events back once
//   dev                               run backend services + frontend zones (turbo dev in both repos)
//   test tenancy                      cross-tenant leak test against every route of every service
//   test race                         100 concurrent bookings for one slot: exactly one wins
//   test reminders                    reminders are scheduled, sent when due, skipped when the appointment is cancelled
//   test queue                        front desk: walk-in → check-in → live push to the doctor; tokens; no-show sweep
//   test payments                     online payment saga (simulated Razorpay), expiry, late payments, refunds, counter
//   test records                      clinical records: treating access, break-glass, encryption at rest, audit chain
//   test documents                    uploads to storage, virus scan, downloads, timeline, consents, allergies
//   test lab                          lab catalog, slots and capacity, orders (patient/doctor), payment, barcode samples
//   test results                      results + flags, critical values, verification, report PDF/QR, amendments, TAT
//   test home                         home collection: pincodes, home slots, assign phlebotomist, visit steps, missed visit
//   test plans                        plans: upgrade seeds the lab, downgrade makes it read-only (data intact), limits, upsell
//   test billing                      SaaS billing: trial → paid, failed renewal → grace → suspended → paid, SMS overage, upgrade
//   test onboarding                   self-serve signup → provisioning → setup guide → first booking; settings, roles, custom domain
//   test search                       "chest pain" → cardiologists by next available slot; test synonyms; isolation; fallback
//   test assistant                    AI assistant: knowledge answers, emergencies without the model, red team, handoff
//   test gaps                         wave 1 of the flow review (docs/ROLE-FLOWS-AND-GAPS.md): each fix as a user meets it
//   test wave2 / wave3 / wave4        waves 2–4 of the flow review
//   tenant export|purge <slug>        offboarding: export a hospital; destroy a deleted one's data (--confirm <slug>)
//   keys rotate <slug> | keys rewrap  data key rotation; re-wrap data keys with the current master key / KMS
//   test console                      platform console: plan builder, two-person approval, impact, move hospitals, audit
//   k8s render <env>                  write deploy/environments/<env>/{generated.yaml,apps.json} from service/zone metadata
//   k8s check <env>                   helm lint + render every app + kubeconform schema check (needs helm, docker)
//   seed demo                         create the demo hospitals citycare + sunrise, and MediCare's own account medicare (platform console at medicare.localhost:3400/platform)
//   setup                             configure + infra up + install + build + bootstrap + migrate + gateway sync
//
// Service/zone lists are never hard-coded: services come from backend/services/*/package.json ("mc" field),
// zones from frontend/zones.json.
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PLATFORM = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = resolve(PLATFORM, '..');
const BACKEND = process.env.MC_BACKEND_DIR ?? join(ROOT, 'backend');
const FRONTEND = process.env.MC_FRONTEND_DIR ?? join(ROOT, 'frontend');
const INFRA = join(PLATFORM, 'infra');
const ENV_FILE = join(PLATFORM, '.env');

const [, , cmd, sub, ...rest] = process.argv;

// ---------- helpers ----------
const log = (...a) => console.log('\x1b[36m[mc]\x1b[0m', ...a);
const fail = (msg) => { console.error('\x1b[31m[mc] ' + msg + '\x1b[0m'); process.exit(1); };
const secret = (n = 24) => randomBytes(n).toString('base64url');

function readEnv(file) {
  if (!existsSync(file)) return {};
  return Object.fromEntries(readFileSync(file, 'utf8').split('\n')
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
}
function writeEnv(file, vars, header) {
  writeFileSync(file, `# ${header}\n` + Object.entries(vars).map(([k, v]) => `${k}=${v}`).join('\n') + '\n');
}
const env = () => readEnv(ENV_FILE);

function flags(args) {
  const out = { _: [] };
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) out[args[i].slice(2)] = args[i + 1]?.startsWith('--') || args[i + 1] === undefined ? true : args[++i];
    else out._.push(args[i]);
  }
  return out;
}

export function services() {
  const dir = join(BACKEND, 'services');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).sort().flatMap((name) => {
    const pj = join(dir, name, 'package.json');
    if (!existsSync(pj)) return [];
    const pkg = JSON.parse(readFileSync(pj, 'utf8'));
    return pkg.mc?.kind === 'service' ? [{ dir: join(dir, name), name, pkg: pkg.name, ...pkg.mc }] : [];
  });
}

function compose(args, opts = {}) {
  return execFileSync('docker', ['compose', '--env-file', ENV_FILE, '-f', join(INFRA, 'docker-compose.yml'), ...args], { stdio: 'inherit', ...opts });
}
function psql(db, sql) {
  return execFileSync('docker', ['compose', '--env-file', ENV_FILE, '-f', join(INFRA, 'docker-compose.yml'),
    'exec', '-T', 'postgres', 'psql', '-v', 'ON_ERROR_STOP=1', '-qAt', '-U', 'postgres', '-d', db], { input: sql, encoding: 'utf8' });
}
const lit = (s) => `'${String(s).replaceAll("'", "''")}'`;
const ident = (s) => { if (!/^[a-z_][a-z0-9_]*$/.test(s)) fail(`bad identifier ${s}`); return s; };
const dbPasswordKey = (schema) => `DB_PASSWORD_SVC_${schema.toUpperCase()}`;

async function api(base, path, { method = 'GET', body, headers = {} } = {}) {
  const res = await fetch(base + path, {
    method, headers: { 'content-type': 'application/json', 'x-internal-token': env().INTERNAL_API_TOKEN, ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  if (!res.ok) fail(`${method} ${path} → ${res.status} ${typeof data === 'string' ? data : JSON.stringify(data)}`);
  return data;
}
const svcUrl = (name) => { const s = services().find((x) => x.schema === name || x.name === name); if (!s) fail(`unknown service ${name}`); return `http://localhost:${s.port}`; };

// ---------- commands ----------
function configure() {
  const cur = env();
  const vars = {
    POSTGRES_PASSWORD: cur.POSTGRES_PASSWORD ?? secret(),
    REDIS_PASSWORD: cur.REDIS_PASSWORD ?? secret(),
    KEYCLOAK_ADMIN_PASSWORD: cur.KEYCLOAK_ADMIN_PASSWORD ?? secret(),
    MINIO_ROOT_PASSWORD: cur.MINIO_ROOT_PASSWORD ?? secret(),
    MC_IAM_CLIENT_SECRET: cur.MC_IAM_CLIENT_SECRET ?? secret(),
    INTERNAL_API_TOKEN: cur.INTERNAL_API_TOKEN ?? secret(32),
    SESSION_SECRET: cur.SESSION_SECRET ?? randomBytes(32).toString('base64url'),
    DEV_STAFF_PASSWORD: cur.DEV_STAFF_PASSWORD ?? `Dev-${secret(9)}`,
    // Payments: "simulated" (local Razorpay stand-in, dev only) until you put real Razorpay TEST keys here and set
    // PAYMENT_GATEWAY=razorpay (webhooks then need a public URL to billing-service, e.g. a tunnel).
    // master key wrapping each hospital's clinical-data key (records-service); Cloud KMS takes this role in production
    MC_MASTER_KEY: cur.MC_MASTER_KEY ?? randomBytes(32).toString('base64url'),
    PAYMENT_GATEWAY: cur.PAYMENT_GATEWAY ?? 'simulated',
    RAZORPAY_KEY_ID: cur.RAZORPAY_KEY_ID ?? `rzp_test_sim${secret(6)}`,
    RAZORPAY_KEY_SECRET: cur.RAZORPAY_KEY_SECRET ?? secret(24),
    RAZORPAY_WEBHOOK_SECRET: cur.RAZORPAY_WEBHOOK_SECRET ?? secret(24),
    // AI assistant: empty = the offline dev provider. Put an AI Studio key here (synthetic data only) to use Gemini.
    GEMINI_API_KEY: cur.GEMINI_API_KEY ?? '',
  };
  for (const s of services()) if (s.schema) vars[dbPasswordKey(s.schema)] = cur[dbPasswordKey(s.schema)] ?? secret();
  writeEnv(ENV_FILE, vars, 'LOCAL DEV SECRETS — generated by `mc configure`, never commit');

  // backend/.env: shared by every service (each service only uses its own DB password)
  if (existsSync(BACKEND)) {
    const svcPorts = Object.fromEntries(services().map((s) => [`SVC_URL_${s.schema.toUpperCase()}`, `http://localhost:${s.port}`]));
    writeEnv(join(BACKEND, '.env'), {
      NODE_ENV: 'development',
      MC_DEV: 'true',
      // the test suites sign many patients in from one machine (production keeps the default of 10; review B-7)
      OTP_PER_IP_PER_10_MIN: '100000',
      // services → PgBouncer (transaction pooling); migrations/admin → Postgres directly
      PG_HOST: 'localhost', PG_PORT: '61643', PG_HOST_DIRECT: 'localhost', PG_PORT_DIRECT: '61432',
      CONTROL_DB: 'mc_control', TEMPLATE_DB: 'medicare_template',
      ...Object.fromEntries(services().filter((s) => s.schema).map((s) => [dbPasswordKey(s.schema), vars[dbPasswordKey(s.schema)]])),
      REDIS_URL: `redis://:${vars.REDIS_PASSWORD}@localhost:61379`,
      KAFKA_BROKERS: 'localhost:61092',
      KEYCLOAK_URL: 'http://localhost:61180', KEYCLOAK_REALM: 'medicare',
      OIDC_STAFF_ISSUER: 'http://localhost:61180/realms/medicare',
      MC_IAM_CLIENT_SECRET: vars.MC_IAM_CLIENT_SECRET,
      PATIENT_TOKEN_ISSUER: `http://localhost:${services().find((s) => s.schema === 'iam')?.port ?? 4402}/patient-auth`,
      INTERNAL_API_TOKEN: vars.INTERNAL_API_TOKEN,
      DEV_STAFF_PASSWORD: vars.DEV_STAFF_PASSWORD,
      MC_MASTER_KEY: vars.MC_MASTER_KEY,
      // documents: MinIO locally (browsers reach it at the same address); one bucket per hospital
      S3_ENDPOINT: 'http://localhost:61900', S3_PUBLIC_ENDPOINT: 'http://localhost:61900', S3_REGION: 'us-east-1', S3_FORCE_PATH_STYLE: 'true',
      S3_ACCESS_KEY: 'minio', S3_SECRET_KEY: vars.MINIO_ROOT_PASSWORD, S3_BUCKET_PREFIX: 'medicare-dev-t-',
      // dev-eicar: built-in scanner that only flags the EICAR test file (ClamAV needs ~1.3 GB RAM). For real scanning
      // locally: `docker compose --profile scan up -d clamav` and set VIRUS_SCANNER=clamav.
      VIRUS_SCANNER: 'dev-eicar', CLAMD_HOST: 'localhost', CLAMD_PORT: '61310',
      PAYMENT_GATEWAY: vars.PAYMENT_GATEWAY, RAZORPAY_KEY_ID: vars.RAZORPAY_KEY_ID,
      RAZORPAY_KEY_SECRET: vars.RAZORPAY_KEY_SECRET, RAZORPAY_WEBHOOK_SECRET: vars.RAZORPAY_WEBHOOK_SECRET,
      BILLING_WEBHOOK_URL: `http://localhost:${services().find((s) => s.schema === 'billing')?.port ?? 4409}/v1/webhooks/razorpay`,
      SMTP_HOST: 'localhost', SMTP_PORT: '61025',
      // ai-assistant-service: Gemini when GEMINI_API_KEY is set (platform/.env), else the offline dev provider
      GEMINI_API_KEY: vars.GEMINI_API_KEY, GEMINI_CHAT_MODEL: 'gemini-3.8-flash', GEMINI_EMBED_MODEL: 'gemini-embedding-2',
      // search-service: one OpenSearch index per hospital and kind (security plugin off locally)
      OPENSEARCH_URL: 'http://localhost:61920', SEARCH_INDEX_PREFIX: 'mc-dev',
      TENANT_BASE_DOMAIN: 'localhost', WEB_PORT: '3400',
      OTEL_EXPORTER_OTLP_ENDPOINT: '',
      ...svcPorts,
    }, 'LOCAL DEV — generated by `mc configure` from platform/.env, never commit');
  }
  if (existsSync(FRONTEND)) {
    writeEnv(join(FRONTEND, '.env'), {
      GATEWAY_URL: 'http://localhost:61000',
      KEYCLOAK_ISSUER: 'http://localhost:61180/realms/medicare',
      KEYCLOAK_CLIENT_ID: 'mc-web',
      SESSION_SECRET: vars.SESSION_SECRET,
    }, 'LOCAL DEV — generated by `mc configure`, never commit');
  }
  // PgBouncer config + userlist (service roles; plain passwords are allowed by PgBouncer and kept out of git)
  const gen = join(INFRA, 'pgbouncer/generated');
  mkdirSync(gen, { recursive: true });
  writeFileSync(join(gen, 'pgbouncer.ini'), readFileSync(join(INFRA, 'pgbouncer/pgbouncer.ini.tpl'), 'utf8').replace('${PG_SERVER_HOST}', 'postgres').replace('${PG_SERVER_PORT}', '5432'));
  writeFileSync(join(gen, 'userlist.txt'), Object.entries(vars).filter(([k]) => k.startsWith('DB_PASSWORD_SVC_')).map(([k, v]) => `"svc_${k.slice('DB_PASSWORD_SVC_'.length).toLowerCase()}" "${v}"`).join('\n') + '\n');
  log('wrote platform/.env, backend/.env, frontend/.env, infra/pgbouncer/generated/*');
}

function infra(action, args) {
  if (!existsSync(ENV_FILE)) configure();
  switch (action) {
    case 'up': compose(['up', '-d', '--wait', ...args]); break;
    case 'down': compose(['down', ...args]); break;
    case 'status': compose(['ps']); break;
    case 'logs': compose(['logs', '--tail', '100', ...args]); break;
    case 'reset': compose(['down', '-v']); break;
    default: fail('infra up|down|status|logs|reset');
  }
}

function dbBootstrap() {
  const e = env();
  const svcs = services().filter((s) => s.schema);
  if (!svcs.find((s) => s.schema === 'tenant')) fail('tenant-service (schema "tenant") must exist');
  let sql = '';
  for (const s of svcs) {
    const role = `svc_${ident(s.schema)}`;
    const pw = e[dbPasswordKey(s.schema)] ?? fail(`missing ${dbPasswordKey(s.schema)} — run mc configure`);
    sql += `DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = ${lit(role)}) THEN CREATE ROLE ${role} LOGIN PASSWORD ${lit(pw)}; ELSE ALTER ROLE ${role} PASSWORD ${lit(pw)}; END IF; END $$;\n`;
  }
  // Each service role finds its own schema first. Set on the ROLE (not as a connection option) so it also works through
  // PgBouncer in transaction-pooling mode, which rejects the "options" startup parameter.
  for (const s of svcs) sql += `ALTER ROLE svc_${s.schema} SET search_path TO ${s.schema}, public;\n`;
  sql += `ALTER ROLE svc_tenant CREATEDB;\n`;
  sql += `SELECT 'CREATE DATABASE mc_control' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'mc_control')\\gexec\n`;
  sql += `SELECT 'CREATE DATABASE medicare_template' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'medicare_template')\\gexec\n`;
  psql('postgres', sql);

  // control-plane schemas
  let control = 'REVOKE CREATE ON SCHEMA public FROM PUBLIC;\n';
  for (const s of svcs.filter((x) => x.control)) control += `CREATE SCHEMA IF NOT EXISTS ${s.schema} AUTHORIZATION svc_${s.schema};\n`;
  psql('mc_control', control);

  // tenant schemas: template + every existing tenant DB (a service added later gets its schema everywhere)
  const tenantSchemas = svcs.filter((x) => x.tenant).map((s) => `CREATE SCHEMA IF NOT EXISTS ${s.schema} AUTHORIZATION svc_${s.schema};`).join('\n');
  const tenantDbs = psql('postgres', `SELECT datname FROM pg_database WHERE datname LIKE 't\\_%'`).split('\n').filter(Boolean);
  for (const db of ['medicare_template', ...tenantDbs]) {
    psql(db, `REVOKE CREATE ON SCHEMA public FROM PUBLIC;
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;
CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;
CREATE TABLE IF NOT EXISTS public.tenant_meta (tenant_id uuid PRIMARY KEY, slug text NOT NULL UNIQUE, created_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE public.tenant_meta OWNER TO svc_tenant;
GRANT SELECT ON public.tenant_meta TO PUBLIC;
${tenantSchemas}\n`);
  }
  psql('postgres', `ALTER DATABASE medicare_template IS_TEMPLATE true;`);

  // Kafka topics: every published topic + its DLQ (consumers send failures to <topic>.dlq)
  const topics = [...new Set(services().flatMap((s) => s.publishes ?? []))].flatMap((t) => [t, `${t}.dlq`]);
  if (topics.length) {
    const existing = execFileSync('docker', ['compose', '--env-file', ENV_FILE, '-f', join(INFRA, 'docker-compose.yml'), 'exec', '-T', 'redpanda', 'rpk', 'topic', 'list'], { encoding: 'utf8' });
    const missing = topics.filter((t) => !existing.split('\n').some((l) => l.split(/\s+/)[0] === t));
    if (missing.length) compose(['exec', '-T', 'redpanda', 'rpk', 'topic', 'create', '-p', '3', ...missing], { stdio: 'ignore' });
    log(`kafka topics: ${topics.length} (${missing.length} created)`);
  }
  log(`bootstrapped roles for ${svcs.length} services; control DB, template DB and ${tenantDbs.length} tenant DB(s) have their schemas`);
}

function runNode(dir, args) {
  return execFileSync('node', ['dist/migrate.js', ...args], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
}

function migrate() {
  const svcs = services().filter((s) => s.schema && existsSync(join(s.dir, 'migrations')));
  for (const s of svcs) if (!existsSync(join(s.dir, 'dist/migrate.js'))) fail(`${s.name}: build first (pnpm --dir backend build)`);
  // Ring 0: control plane + template (new tenants are always cloned at the latest version)
  for (const s of svcs) {
    if (s.control) log(`${s.name}: control → ${runNode(s.dir, ['control']).trim()}`);
    if (s.tenant) log(`${s.name}: template → ${runNode(s.dir, ['template']).trim()}`);
  }
  // Ring 1..n: tenant databases in batches of 10 (internal/test tenants first)
  const rows = psql('mc_control', `SELECT id, db_name FROM tenant.tenants WHERE status IN ('ACTIVE','READ_ONLY','PROVISIONING') ORDER BY (slug LIKE 'internal%') DESC, created_at`)
    .split('\n').filter(Boolean).map((l) => { const [id, db] = l.split('|'); return { id, db }; });
  for (let i = 0; i < rows.length; i += 10) {
    const batch = rows.slice(i, i + 10);
    for (const s of svcs.filter((x) => x.tenant)) {
      const out = JSON.parse(runNode(s.dir, ['tenants', batch.map((r) => r.db).join(',')]));
      let rec = '';
      for (const r of batch) {
        const v = out[r.db];
        rec += `INSERT INTO tenant.tenant_schema_versions (tenant_id, service, version) VALUES (${lit(r.id)}, ${lit(s.schema)}, ${lit(v)})
                ON CONFLICT (tenant_id, service) DO UPDATE SET version = EXCLUDED.version, applied_at = now();\n`;
      }
      psql('mc_control', rec);
      log(`${s.name}: ${batch.length} tenant DB(s) → ${[...new Set(Object.values(out))].join(', ')}`);
    }
  }
  if (!rows.length) log('no tenant databases yet');
}

function gatewaySync() {
  const svcs = services().filter((s) => s.gateway !== false);
  let y = `# GENERATED by \`mc gateway sync\` from backend services' package.json "mc" metadata — do not edit.
# Routes /api/<route>/... to the service on the host, stripping /api/<route>. JWTs are verified in every service
# (nest-common AuthGuard), which also checks the token's tenant against X-Tenant-Host (set by the zone BFF).
# /internal/* routes are service-to-service only: the gateway answers 404 for them.
_format_version: "3.0"
_transform: true

plugins:
  - name: correlation-id
    config: { header_name: X-Request-Id, generator: uuid, echo_downstream: true }

services:
`;
  for (const s of svcs) {
    const route = s.route ?? s.schema;
    y += `  - name: ${s.name}
    url: http://host.docker.internal:${s.port}
    routes:
      - name: ${route}
        paths: ["/api/${route}/"]
        strip_path: true
      - name: ${route}-internal-blocked
        paths: ["/api/${route}/internal"]
        plugins:
          - name: request-termination
            config: { status_code: 404, message: "not found" }
    plugins:
      - name: rate-limiting
        config: { minute: 1200, policy: local, limit_by: ip }
`;
  }
  writeFileSync(join(INFRA, 'kong/kong.yml'), y);
  try {
    execFileSync('curl', ['-sf', '-X', 'POST', 'http://localhost:61001/config', '-F', `config=@${join(INFRA, 'kong/kong.yml')}`], { stdio: 'ignore' });
    log(`kong reloaded with ${svcs.length} service(s)`);
  } catch { log('wrote kong.yml (Kong not running — it loads the file on start)'); }
}

async function tenant(action, args) {
  const f = flags(args);
  if (action === 'create') {
    const slug = f._[0] ?? fail('usage: tenant create <slug> --name <name> --admin <email>');
    const t = await api(svcUrl('tenant'), '/internal/tenants', { method: 'POST', body: { slug, name: f.name ?? slug, adminEmail: f.admin ?? `admin@${slug}.test`, plan: f.plan } });
    log(`tenant ${t.slug} (${t.id}) → database ${t.dbName}, host ${t.hosts.join(', ')}`);
    log(`admin login: ${f.admin ?? `admin@${slug}.test`} / DEV_STAFF_PASSWORD from platform/.env (dev mode)`);
  } else if (action === 'list') {
    const ts = await api(svcUrl('tenant'), '/internal/tenants');
    console.table(ts.map((t) => ({ slug: t.slug, name: t.name, status: t.status, db: t.dbName, hosts: t.hosts.join(' ') })));
  } else if (action === 'export') {
    // offboarding (review H-1): the hospital's database (custom-format dump, restorable with pg_restore) and every
    // document, with a manifest. Run before purge.
    const slug = f._[0] ?? fail('usage: tenant export <slug> [--out dir]');
    const t = (await api(svcUrl('tenant'), '/internal/tenants?includeDeleted=true')).find((x) => x.slug === slug) ?? fail(`no tenant ${slug}`);
    const dir = join(f.out ?? join(PLATFORM, 'exports'), `${t.slug}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}`);
    mkdirSync(join(dir, 'documents'), { recursive: true });
    const dump = execFileSync('docker', ['compose', '--env-file', ENV_FILE, '-f', join(INFRA, 'docker-compose.yml'), 'exec', '-T', 'postgres', 'pg_dump', '-U', 'postgres', '-Fc', t.dbName], { maxBuffer: 1 << 30 });
    writeFileSync(join(dir, `${t.dbName}.dump`), dump);
    const docs = await api(svcUrl('records'), `/internal/tenants/${t.id}/export/documents`);
    for (const d of docs) {
      const res = await fetch(d.url);
      if (!res.ok) fail(`document ${d.id}: ${res.status}`);
      writeFileSync(join(dir, 'documents', d.file), Buffer.from(await res.arrayBuffer()));
    }
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ hospital: { id: t.id, slug: t.slug, name: t.name, status: t.status }, exportedAt: new Date().toISOString(),
      database: { file: `${t.dbName}.dump`, bytes: dump.length, restore: `pg_restore -d <new db> ${t.dbName}.dump` },
      documents: docs.map(({ url: _url, ...d }) => d) }, null, 2));
    log(`exported ${t.slug}: database ${(dump.length / 1e6).toFixed(1)} MB, ${docs.length} document(s) → ${dir}`);
  } else if (action === 'purge') {
    // offboarding (review H-1): destroys a DELETED hospital's data after the retention period. Not reversible.
    const slug = f._[0] ?? fail('usage: tenant purge <slug> --confirm <slug> [--force (dev: skip the retention period)]');
    if (f.confirm !== slug) fail(`this destroys ${slug}'s database, documents and data keys for good: repeat the slug with --confirm ${slug} (export it first: mc tenant export ${slug})`);
    const ts = await api(svcUrl('tenant'), '/internal/tenants?includeDeleted=true');
    const t = ts.find((x) => x.slug === slug) ?? fail(`no tenant ${slug}`);
    const r = await api(svcUrl('tenant'), `/internal/tenants/${t.id}/purge`, { method: 'POST', body: { force: !!f.force } });
    log(`purged ${slug}: ${JSON.stringify(r)}`);
  } else fail('tenant create|list|export|purge');
}

/** rpk inside the Redpanda container. */
const rpk = (args, input) => execFileSync('docker', ['compose', '--env-file', ENV_FILE, '-f', join(INFRA, 'docker-compose.yml'), 'exec', '-T', 'redpanda', 'rpk', '-X', 'brokers=redpanda:9092', ...args], { encoding: 'utf8', input, maxBuffer: 1 << 28 });
/** rpk -f json prints one pretty JSON object per message: split them back. */
function jsonStream(text) {
  const out = []; let buf = '';
  for (const line of text.split('\n')) { buf += `${line}\n`; if (line === '}') { out.push(JSON.parse(buf)); buf = ''; } }
  return out;
}
const dlqTopics = () => rpk(['topic', 'list']).split('\n').slice(1).map((l) => l.split(/\s+/)[0]).filter((t) => t.endsWith('.dlq'));
const readDlq = (topic) => jsonStream(rpk(['topic', 'consume', topic, '-o', ':end', '-f', 'json']).trim());
const header = (m, k) => (m.headers ?? []).find((h) => h.key === k)?.value ?? '';

/**
 * Dead-letter topics (review H-4): events that failed every retry. `events dlq` counts them per topic and groups the
 * errors by consumer; `events replay <topic>` sends a DLQ's messages back to the original topic (filter with
 * --consumer and --since). Consumers dedupe on the event id, so only a group that has not processed an event acts on
 * it, and replaying the same messages twice is harmless.
 */
function dlqList(args) {
  const f = flags(args);
  for (const t of f.topic ? [f.topic.endsWith('.dlq') ? f.topic : `${f.topic}.dlq`] : dlqTopics()) {
    const msgs = readDlq(t);
    if (!msgs.length) continue;
    const by = new Map();
    for (const m of msgs) { const k = `${header(m, 'dlq-consumer')} · ${JSON.parse(m.value).type} · ${header(m, 'dlq-error').slice(0, 120)}`; by.set(k, (by.get(k) ?? 0) + 1); }
    log(`${t}: ${msgs.length} message(s), oldest ${new Date(msgs[0].timestamp).toISOString().slice(0, 16)}`);
    for (const [k, n] of [...by].sort((a, b) => b[1] - a[1]).slice(0, 10)) console.log(`   ${String(n).padStart(4)}  ${k}`);
  }
}

function dlqReplay(args) {
  const f = flags(args);
  const topic = f._[0].replace(/\.dlq$/, '');
  const max = Number(f.max ?? 1000);
  let msgs = readDlq(`${topic}.dlq`);
  if (f.consumer) msgs = msgs.filter((m) => header(m, 'dlq-consumer') === f.consumer);
  if (f.since) msgs = msgs.filter((m) => m.timestamp >= Date.parse(f.since));
  msgs = msgs.slice(0, max);
  if (f['dry-run']) { log(`${msgs.length} message(s) would go back to ${topic}`); return; }
  for (const m of msgs) {
    const h = (m.headers ?? []).filter((x) => !x.key.startsWith('dlq-')).flatMap((x) => ['-H', `${x.key}:${x.value}`]);
    rpk(['topic', 'produce', topic, '-k', m.key, ...h, '-f', '%v\n'], `${m.value}\n`);
  }
  log(`${msgs.length} message(s) replayed to ${topic}${f.consumer ? ` (failed in ${f.consumer})` : ''}`);
}

/**
 * Encryption keys (wave 4, KMS) in the services that encrypt (records: clinical text; assistant: chats):
 *   keys rotate <slug>   new data key version for one hospital (old ciphertexts keep decrypting)
 *   keys rewrap          re-wrap every data key with the current master key (after changing MC_MASTER_KEY, keeping
 *                        the old one in MC_MASTER_KEY_PREVIOUS; or after KEY_WRAPPER=gcp-kms)
 */
async function keysCmd(action, args) {
  const f = flags(args);
  const encrypting = ['records', 'assistant'];
  if (action === 'rotate') {
    const t = await tenantBySlug(f._[0] ?? fail('usage: keys rotate <slug>'));
    for (const svc of encrypting) log(`${svc}: ${JSON.stringify(await api(svcUrl(svc), `/internal/tenants/${t.id}/keys/rotate`, { method: 'POST', body: {} }))}`);
  } else if (action === 'rewrap') {
    for (const svc of encrypting) log(`${svc}: ${JSON.stringify(await api(svcUrl(svc), '/internal/keys/rewrap', { method: 'POST', body: {} }))}`);
  } else fail('keys rotate <slug> | keys rewrap');
}

async function tenantBySlug(slug) {
  const ts = await api(svcUrl('tenant'), '/internal/tenants');
  return ts.find((x) => x.slug === slug) ?? fail(`no tenant ${slug}`);
}

/** Modules switch through ACTIVATING/DISABLING while services run their hooks: wait until they settle. */
async function waitForModules(t, timeoutMs = 60_000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const rows = await api(svcUrl('entitlement'), `/internal/tenants/${t.id}/module-states`);
    const pending = rows.filter((r) => r.state === 'ACTIVATING' || r.state === 'DISABLING');
    if (!pending.length) return rows;
    if (Date.now() > end) fail(`still switching: ${pending.map((p) => `${p.module_key} ${p.state}${p.last_error ? ` (${p.last_error})` : ''}`).join(', ')}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

/** entitlement-service has applied this contract change (overrides keep the contract id: compare the change count too). */
async function waitForApplied(t, before, timeoutMs = 60_000) {
  const end = Date.now() + timeoutMs;
  const seq = (await api(svcUrl('subscription'), `/internal/tenants/${t.id}/contract`)).seq;
  for (;;) {
    const applied = await api(svcUrl('entitlement'), `/internal/tenants/${t.id}/plan`);
    if (applied?.contract_id === before.contractId && applied.seq >= seq) return;
    if (Date.now() > end) fail(`plan change not applied by entitlement-service yet (seq ${seq})`);
    await new Promise((r) => setTimeout(r, 300));
  }
}

async function moduleCmd(action, args) {
  const [slug, key] = args;
  if (!slug || !key || !['enable', 'disable', 'reset'].includes(action)) fail('module enable|disable|reset <slug> <module>');
  const t = await tenantBySlug(slug);
  const c = await api(svcUrl('subscription'), `/internal/tenants/${t.id}/overrides/modules/${key}`, { method: 'PUT', body: { state: { enable: 'on', disable: 'off', reset: 'plan' }[action], by: 'mc cli' } });
  await waitForApplied(t, c);
  const rows = await waitForModules(t);
  log(`${slug}: module ${key} → ${rows.find((r) => r.module_key === key)?.state ?? 'not in plan'}`);
}

const inr = (n) => `₹${new Intl.NumberFormat('en-IN').format(n)}`;

async function billingCmd(action, args) {
  const f = flags(args);
  const t = await tenantBySlug(f._[0] ?? fail('billing show|reset-trial|advance <slug> …'));
  const sub = svcUrl('subscription');
  let b;
  if (action === 'show') {
    await api(sub, '/internal/usage/flush', { method: 'POST', body: {} });
    b = await api(sub, `/internal/tenants/${t.id}/billing`);
  } else if (action === 'reset-trial') b = await api(sub, `/internal/tenants/${t.id}/billing/reset-trial`, { method: 'POST', body: { days: Number(f.days ?? 14) } });
  else if (action === 'advance') b = await api(sub, `/internal/tenants/${t.id}/billing/advance`, { method: 'POST', body: { to: f._[1] ?? fail('advance <slug> <trial-end|period-end|next-retry|grace-end|+Nd>') } });
  else fail('billing show|reset-trial|advance');
  const d = (x) => (x ? new Date(x).toISOString().slice(0, 10) : '—');
  log(`${t.slug}: ${b.status} on ${b.plan.name}; clock ${d(b.now)}${b.clockOffsetDays ? ` (+${b.clockOffsetDays} d)` : ''}; trial ${d(b.trialEndsAt)}; period ${d(b.periodStart)} → ${d(b.periodEnd)}; card ${b.paymentMethod ? `${b.paymentMethod.kind} ${b.paymentMethod.last4 ?? ''}` : 'none'}; unpaid ${b.unpaid.invoices} (₹${b.unpaid.total})`);
  if (b.invoices?.length) console.table(b.invoices.map((i) => ({ invoice: i.number, kind: i.kind, period: `${d(i.periodStart)} → ${d(i.periodEnd)}`, total: i.total, status: i.status, error: i.lastError ?? '' })));
}

async function planCmd(action, args) {
  const f = flags(args);
  if (action === 'list') {
    const { plans, addons } = await api(svcUrl('subscription'), '/internal/plans');
    console.table(plans.map((p) => ({ plan: p.code, version: p.version, edition: p.edition, price: `${inr(p.listPrice)}/mo`, modules: p.modules.filter((m) => m !== 'core').join(' '),
      limits: Object.entries(p.features).filter(([, x]) => x.limit != null).map(([k, x]) => `${k.split('.')[1]} ${x.limit}`).join(', '), addons: p.addonCodes.join(' ') })));
    console.table(addons.map((a) => ({ addon: a.code, name: a.name, gives: a.module ?? `+${a.extraLimit} ${a.feature}`, price: `${inr(a.listPrice)}/mo` })));
  } else if (action === 'show') {
    const t = await tenantBySlug(f._[0] ?? fail('plan show <slug>'));
    const c = await api(svcUrl('subscription'), `/internal/tenants/${t.id}/contract`);
    const states = await api(svcUrl('entitlement'), `/internal/tenants/${t.id}/module-states`);
    log(`${t.slug}: ${c.plan.name} (${c.plan.code} v${c.plan.version}, ${inr(c.plan.listPrice)}/mo)${c.addons.length ? ` + ${c.addons.map((a) => `${a.code}×${a.quantity}`).join(', ')}` : ''}${Object.keys(c.overrides.modules ?? {}).length ? `, overrides ${JSON.stringify(c.overrides.modules)}` : ''}`);
    console.table(states.map((s) => ({ module: s.module_key, state: s.state, source: s.source, ...(s.last_error ? { error: s.last_error } : {}) })));
    const limits = Object.entries(c.effective.features).filter(([, x]) => x.limit != null || !x.enabled);
    if (limits.length) log(`limits/switches: ${limits.map(([k, x]) => (x.enabled ? `${k} ${x.limit}` : `${k} off`)).join(', ')}`);
    console.table(c.history.map((h) => ({ plan: `${h.plan} v${h.version}`, status: h.status, from: h.startsAt, by: h.by, reason: h.reason })));
  } else if (action === 'set') {
    const [slug, plan] = f._;
    if (!slug || !plan) fail('plan set <slug> <PLAN> [--addons LAB,BRANCHES_5:2] [--reason text]');
    const t = await tenantBySlug(slug);
    const addons = typeof f.addons === 'string' ? f.addons.split(',').filter(Boolean).map((a) => { const [code, q] = a.split(':'); return { code, quantity: Number(q ?? 1) }; }) : [];
    const c = await api(svcUrl('subscription'), `/internal/tenants/${t.id}/contract`, { method: 'PUT', body: { plan, addons, by: 'mc cli', reason: typeof f.reason === 'string' ? f.reason : 'changed with mc plan set' } });
    log(`${slug} → ${c.plan.name}; switching modules…`);
    await waitForApplied(t, c);
    const rows = await waitForModules(t);
    log(`${slug}: ${rows.map((r) => `${r.module_key} ${r.state}`).join(', ')}`);
  } else fail('plan list|show|set');
}

function run(cmdline, cwd) {
  return new Promise((res, rej) => {
    const p = spawn(cmdline, { cwd, shell: true, stdio: 'inherit' });
    p.on('exit', (c) => (c === 0 ? res() : rej(new Error(`${cmdline} exited ${c}`))));
  });
}

/**
 * Kubernetes inputs for one environment, derived from metadata (never hand-maintained lists):
 *  - generated.yaml: services + zones for the medicare-platform chart (config, Kong routes, DB bootstrap)
 *  - apps.json:      one entry per Argo CD Application (ApplicationSet git-files generator), with sync waves
 */
function k8sRender(envName) {
  const dir = join(PLATFORM, 'deploy/environments', envName);
  mkdirSync(dir, { recursive: true });
  const svcs = services();
  const zones = existsSync(join(FRONTEND, 'zones.json')) ? JSON.parse(readFileSync(join(FRONTEND, 'zones.json'), 'utf8')).zones : [];
  const extraSecrets = { iam: ['MC_IAM_CLIENT_SECRET', 'SMTP_USER', 'SMTP_PASSWORD'], tenant: ['SMTP_USER', 'SMTP_PASSWORD'], notification: ['SMTP_USER', 'SMTP_PASSWORD'], billing: ['RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET', 'RAZORPAY_WEBHOOK_SECRET'], records: ['MC_MASTER_KEY', 'S3_ACCESS_KEY', 'S3_SECRET_KEY'], assistant: ['MC_MASTER_KEY'] };
  // services with their own Google identity (Workload Identity), e.g. the AI assistant calling Vertex AI
  const gsa = { assistant: 'medicare-ai@<gcp-project>.iam.gserviceaccount.com' };
  let y = `# GENERATED by \`mc k8s render ${envName}\` from backend services' "mc" metadata and frontend/zones.json. Do not edit.\nservices:\n`;
  for (const s of svcs) y += `  - { name: ${s.name}, port: ${s.port}, schema: ${s.schema}, route: ${s.route ?? s.schema}, control: ${!!s.control}, tenant: ${!!s.tenant} }\n`;
  y += 'zones:\n';
  for (const z of zones) y += `  - { name: ${z.name}, basePath: "${z.basePath}" }\n`;
  writeFileSync(join(dir, 'generated.yaml'), y);
  // the platform chart ships the Keycloak realm (single source: infra/keycloak/realm-medicare.json)
  mkdirSync(join(PLATFORM, 'deploy/helm/medicare-platform/files'), { recursive: true });
  writeFileSync(join(PLATFORM, 'deploy/helm/medicare-platform/files/realm-medicare.json'), readFileSync(join(INFRA, 'keycloak/realm-medicare.json'), 'utf8'));
  const apps = [
    { name: 'medicare-platform', chart: 'medicare-platform', wave: '0', values: { } },
    ...svcs.map((s) => ({
      name: s.name, chart: 'medicare-service', wave: s.schema === 'tenant' ? '1' : '2',
      values: { name: s.name, port: s.port, schema: s.schema, migrations: existsSync(join(s.dir, 'migrations')), extraSecretKeys: extraSecrets[s.schema] ?? [], ...(gsa[s.schema] ? { serviceAccount: { annotations: { 'iam.gke.io/gcp-service-account': gsa[s.schema] } } } : {}) },
    })),
    ...zones.map((z) => ({ name: `zone-${z.name}`, chart: 'medicare-zone', wave: '3', values: { zone: z.name } })),
  ];
  for (const a of apps) a.valuesJson = JSON.stringify(a.values);
  writeFileSync(join(dir, 'apps.json'), JSON.stringify(apps, null, 2) + '\n');
  log(`${envName}: ${svcs.length} services, ${zones.length} zones → deploy/environments/${envName}/{generated.yaml,apps.json}`);
}

/** Lint and render every Argo app for an environment, then validate the manifests against Kubernetes schemas. */
function k8sCheck(envName) {
  k8sRender(envName);
  const env = join(PLATFORM, 'deploy/environments', envName);
  const apps = JSON.parse(readFileSync(join(env, 'apps.json'), 'utf8'));
  const out = join(PLATFORM, 'deploy/.rendered', envName);
  mkdirSync(out, { recursive: true });
  for (const a of apps) {
    const chart = join(PLATFORM, 'deploy/helm', a.chart);
    const vals = join(out, `${a.name}.values.json`);
    writeFileSync(vals, a.valuesJson);
    const args = ['-f', join(env, 'values.yaml'), '-f', join(env, 'generated.yaml'), '-f', vals];
    execFileSync('helm', ['lint', '--strict', chart, ...args], { stdio: 'pipe' });
    const yaml = execFileSync('helm', ['template', a.name, chart, '--namespace', `medicare-${envName}`, ...args], { encoding: 'utf8' });
    writeFileSync(join(out, `${a.name}.yaml`), yaml);
  }
  log(`helm lint + template ok for ${apps.length} apps`);
  const res = execFileSync('docker', ['run', '--rm', '-v', `${out}:/m:ro`, 'ghcr.io/yannh/kubeconform:latest', '-strict', '-summary',
    '-ignore-missing-schemas', '-kubernetes-version', '1.33.0', ...apps.map((a) => `/m/${a.name}.yaml`)], { encoding: 'utf8' });
  log(res.trim());
}

async function setup() {
  configure();
  infra('up', []);
  await run('pnpm install', BACKEND);
  configure(); // service list may have changed after install
  await run('pnpm build', BACKEND);
  dbBootstrap();
  migrate();
  gatewaySync();
  if (existsSync(join(FRONTEND, 'package.json'))) await run('pnpm install', FRONTEND);
  log('setup done → node platform/scripts/mc.mjs dev');
}

// ---------- dispatch ----------
const main = async () => {
  switch (cmd) {
    case 'configure': return configure();
    case 'infra': return infra(sub, rest);
    case 'db': if (sub === 'bootstrap') return dbBootstrap(); return fail('db bootstrap');
    case 'migrate': return migrate();
    case 'gateway': if (sub === 'sync') return gatewaySync(); return fail('gateway sync');
    case 'tenant': return tenant(sub, rest);
    case 'keys': return keysCmd(sub, rest);
    case 'module': return moduleCmd(sub, rest);
    case 'plan': return planCmd(sub, rest);
    case 'billing': return billingCmd(sub, rest);
    case 'events':
      if (sub === 'reset' && rest[0]) return compose(['exec', '-T', 'redpanda', 'rpk', '-X', 'brokers=redpanda:9092', 'group', 'seek', rest[0], '--to', 'start']);
      if (sub === 'dlq') return dlqList(rest);
      if (sub === 'replay' && rest[0]) return dlqReplay(rest);
      return fail('events reset <group> | events dlq [--topic <t>] | events replay <topic> [--consumer <group>] [--since <iso date>] [--max N] [--dry-run]');
    case 'dev': return Promise.all([run('pnpm dev', BACKEND), existsSync(join(FRONTEND, 'package.json')) ? run('pnpm dev', FRONTEND) : null]);
    case 'test':
      if (sub === 'tenancy') return run(`node ${join(PLATFORM, 'tests/tenancy-leak.mjs')}`, PLATFORM);
      if (sub === 'race') return run(`node ${join(PLATFORM, 'tests/booking-race.mjs')}`, PLATFORM);
      if (sub === 'reminders') return run(`node ${join(PLATFORM, 'tests/reminders.mjs')}`, PLATFORM);
      if (sub === 'queue') return run(`node ${join(PLATFORM, 'tests/queue.mjs')}`, PLATFORM);
      if (sub === 'payments') return run(`node ${join(PLATFORM, 'tests/payments.mjs')}`, PLATFORM);
      if (sub === 'records') return run(`node ${join(PLATFORM, 'tests/records.mjs')}`, PLATFORM);
      if (sub === 'documents') return run(`node ${join(PLATFORM, 'tests/documents.mjs')}`, PLATFORM);
      if (sub === 'lab') return run(`node ${join(PLATFORM, 'tests/lab.mjs')}`, PLATFORM);
      if (sub === 'results') return run(`node ${join(PLATFORM, 'tests/results.mjs')}`, PLATFORM);
      if (sub === 'home') return run(`node ${join(PLATFORM, 'tests/home.mjs')}`, PLATFORM);
      if (sub === 'plans') return run(`node ${join(PLATFORM, 'tests/plans.mjs')}`, PLATFORM);
      if (sub === 'console') return run(`node ${join(PLATFORM, 'tests/console.mjs')}`, PLATFORM);
      if (sub === 'billing') return run(`node ${join(PLATFORM, 'tests/billing.mjs')}`, PLATFORM);
      if (sub === 'onboarding') return run(`node ${join(PLATFORM, 'tests/onboarding.mjs')}`, PLATFORM);
      if (sub === 'search') return run(`node ${join(PLATFORM, 'tests/search.mjs')}`, PLATFORM);
      if (sub === 'assistant') return run(`node ${join(PLATFORM, 'tests/assistant.mjs')}`, PLATFORM);
      if (sub === 'gaps') return run(`node ${join(PLATFORM, 'tests/gaps.mjs')}`, PLATFORM);
      if (sub === 'wave2') return run(`node ${join(PLATFORM, 'tests/wave2.mjs')}`, PLATFORM);
      if (sub === 'wave3') return run(`node ${join(PLATFORM, 'tests/wave3.mjs')}`, PLATFORM);
      if (sub === 'wave4') return run(`node ${join(PLATFORM, 'tests/wave4.mjs')}`, PLATFORM);
      if (sub === 'wave5') return run(`node ${join(PLATFORM, 'tests/wave5.mjs')}`, PLATFORM);
      if (sub === 'concierge') return run(`node ${join(PLATFORM, 'tests/concierge.mjs')}`, PLATFORM);
      if (sub === 'copilot') return run(`node ${join(PLATFORM, 'tests/copilot.mjs')}`, PLATFORM);
      return fail('test tenancy|race|reminders|queue|payments|records|documents|lab|results|home|plans|console|billing|onboarding|search|assistant|gaps|wave2|wave3|wave4|wave5|concierge|copilot');
    case 'seed':
      if (sub !== 'demo') return fail('seed demo');
      for (const [slug, name, plan] of [['citycare', 'CityCare Clinic', 'HOSPITAL_ENTERPRISE'], ['sunrise', 'Sunrise Diagnostics', 'HOSPITAL_PRO'], ['medicare', 'MediCare HQ', 'MEDICARE_HQ']]) {
        const ts = await api(svcUrl('tenant'), '/internal/tenants');
        if (ts.some((t) => t.slug === slug)) log(`${slug} exists`);
        else await tenant('create', [slug, '--name', name, '--admin', `admin@${slug}.test`, '--plan', plan]);
      }
      return;
    case 'k8s':
      if (sub === 'render' && rest[0]) return k8sRender(rest[0]);
      if (sub === 'check' && rest[0]) return k8sCheck(rest[0]);
      return fail('k8s render|check <env>');
    case 'setup': return setup();
    default:
      { const lines = readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1); console.log(lines.slice(0, lines.findIndex((l) => !l.startsWith('//'))).map((l) => l.replace(/^\/\/ ?/, '')).join('\n')); }
  }
};
if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch((e) => fail(e.message));
