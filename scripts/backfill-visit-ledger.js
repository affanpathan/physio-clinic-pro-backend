// One-off backfill: creates missing daily_ledger rows for visits recorded before the fix to
// POST/PUT /api/visits, which used to skip the daily_ledger insert entirely when amount_paid
// was 0. Safe to re-run — only ever targets visits with no matching daily_ledger.visit_id row.
//
// Usage:
//   node scripts/backfill-visit-ledger.js           (dry run — lists what would be inserted)
//   node scripts/backfill-visit-ledger.js --apply   (actually inserts the missing rows)
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const localEnvPath = path.resolve(__dirname, '..', '.env');
const frontendEnvPath = path.resolve(__dirname, '..', '..', 'frontend', '.env');
const envPath = fs.existsSync(localEnvPath) ? localEnvPath : fs.existsSync(frontendEnvPath) ? frontendEnvPath : localEnvPath;
require('dotenv').config({ path: envPath });

const isProduction = process.env.NODE_ENV === 'production' || process.env.VERCEL === '1';
const dbPassword = String(process.env.DB_PASSWORD ?? process.env.PGPASSWORD ?? 'admin');
const dbConfig = {
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT || 5432),
  database: process.env.DB_NAME || 'physio_db',
  user: process.env.DB_USER || 'postgres',
  password: dbPassword,
  ssl: isProduction ? { rejectUnauthorized: false } : false,
};
const pool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: isProduction ? { rejectUnauthorized: false } : false })
  : new Pool(dbConfig);

const APPLY = process.argv.includes('--apply');

async function main() {
  const { rows: missing } = await pool.query(`
    SELECT v.id, v.clinic_id, v.visit_date, v.therapy_type, v.amount_paid, v.payment_method, v.bank_id,
           p.first_name, p.last_name
    FROM visits v
    LEFT JOIN patients p ON p.id = v.patient_id
    WHERE NOT EXISTS (SELECT 1 FROM daily_ledger l WHERE l.visit_id = v.id)
    ORDER BY v.visit_date ASC
  `);

  if (!missing.length) {
    console.log('No visits are missing a daily_ledger entry. Nothing to do.');
    return pool.end();
  }

  console.log(`Found ${missing.length} visit(s) with no daily_ledger row:\n`);
  for (const v of missing) {
    console.log(`  visit #${v.id}  ${v.visit_date}  ${v.first_name || ''} ${v.last_name || ''}  amount_paid=${v.amount_paid}  clinic_id=${v.clinic_id}`);
  }

  if (!APPLY) {
    console.log(`\nDry run only — no changes made. Re-run with --apply to insert these ${missing.length} row(s).`);
    return pool.end();
  }

  const result = await pool.query(`
    INSERT INTO daily_ledger (clinic_id, entry_date, entry_type, category, description, amount, payment_method, bank_id, patient_id, visit_id)
    SELECT v.clinic_id, v.visit_date, 'income', 'Therapy Fee', 'Therapy fee - ' || COALESCE(v.therapy_type, ''),
           COALESCE(v.amount_paid, 0), v.payment_method, v.bank_id, v.patient_id, v.id
    FROM visits v
    WHERE NOT EXISTS (SELECT 1 FROM daily_ledger l WHERE l.visit_id = v.id)
    RETURNING id
  `);
  console.log(`\nInserted ${result.rowCount} daily_ledger row(s).`);
  return pool.end();
}

main().catch((err) => { console.error('Backfill failed:', err.message); process.exit(1); });
