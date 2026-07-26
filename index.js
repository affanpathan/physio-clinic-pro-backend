const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

const isProduction = process.env.NODE_ENV === 'production' || process.env.VERCEL === '1';
console.log(process.env.DB_HOST, process.env.DB_PORT, process.env.DB_NAME, process.env.DB_USER, process.env.DB_PASSWORD,process.env.DATABASE_URL);
/*const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME || 'physio_db',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'admin',
  ssl: isProduction ? { rejectUnauthorized: false } : false
});*/

const pool = new Pool({
  // If DATABASE_URL is present, it overrides all other individual parameters automatically
  connectionString: process.env.DATABASE_URL || `postgres://${process.env.DB_USER || 'postgres'}:${process.env.DB_PASSWORD || 'admin'}@${process.env.DB_HOST || 'localhost'}:${process.env.DB_PORT || 5432}/${process.env.DB_NAME || 'physio_db'}`,
  ssl: isProduction ? { rejectUnauthorized: false } : false
});

pool.on('error', (err) => {
  console.error('Unexpected error on idle PostgreSQL client:', err.message);
  // Do not exit the process; let Vercel handle recycling the serverless container
});

const normalizeDate = (value) => {
  if (!value) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toISOString().slice(0, 10);
};

// Initialize DB schema
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS patients (
      id SERIAL PRIMARY KEY,
      patient_id VARCHAR(20) UNIQUE NOT NULL,
      first_name VARCHAR(100) NOT NULL,
      last_name VARCHAR(100) NOT NULL,
      phone VARCHAR(20),
      email VARCHAR(150),
      date_of_birth DATE,
      gender VARCHAR(10),
      address TEXT,
      diagnosis TEXT,
      referring_doctor VARCHAR(150),
      notes TEXT,
      is_active BOOLEAN DEFAULT true,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS therapy_plans (
      id SERIAL PRIMARY KEY,
      patient_id INTEGER REFERENCES patients(id) ON DELETE CASCADE,
      plan_name VARCHAR(200) NOT NULL,
      total_sessions INTEGER DEFAULT 0,
      sessions_completed INTEGER DEFAULT 0,
      fee_per_session NUMERIC(10,2) DEFAULT 0,
      start_date DATE,
      end_date DATE,
      status VARCHAR(20) DEFAULT 'active',
      notes TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS visits (
      id SERIAL PRIMARY KEY,
      patient_id INTEGER REFERENCES patients(id) ON DELETE CASCADE,
      therapy_plan_id INTEGER REFERENCES therapy_plans(id) ON DELETE SET NULL,
      visit_date DATE NOT NULL,
      visit_time TIME,
      therapist_name VARCHAR(150),
      therapy_type VARCHAR(150),
      duration_minutes INTEGER DEFAULT 60,
      fee_charged NUMERIC(10,2) DEFAULT 0,
      amount_paid NUMERIC(10,2) DEFAULT 0,
      payment_method VARCHAR(20) DEFAULT 'cash',
      payment_status VARCHAR(20) DEFAULT 'pending',
      session_notes TEXT,
      chief_complaint TEXT,
      treatment_given TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS patient_payments (
      id SERIAL PRIMARY KEY,
      patient_id INTEGER REFERENCES patients(id) ON DELETE CASCADE,
      visit_id INTEGER REFERENCES visits(id) ON DELETE SET NULL,
      payment_date DATE NOT NULL,
      amount NUMERIC(10,2) NOT NULL,
      payment_method VARCHAR(20) NOT NULL,
      reference_number VARCHAR(100),
      notes TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS daily_ledger (
      id SERIAL PRIMARY KEY,
      entry_date DATE NOT NULL,
      entry_type VARCHAR(20) NOT NULL,
      category VARCHAR(100),
      description TEXT NOT NULL,
      amount NUMERIC(10,2) NOT NULL,
      payment_method VARCHAR(20) NOT NULL,
      reference_number VARCHAR(100),
      patient_id INTEGER REFERENCES patients(id) ON DELETE SET NULL,
      visit_id INTEGER REFERENCES visits(id) ON DELETE SET NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS appointments (
      id SERIAL PRIMARY KEY,
      patient_id INTEGER REFERENCES patients(id) ON DELETE CASCADE,
      therapist_name VARCHAR(150),
      appointment_date DATE NOT NULL,
      appointment_time TIME NOT NULL,
      duration_minutes INTEGER DEFAULT 15,
      therapy_type VARCHAR(150),
      status VARCHAR(20) DEFAULT 'scheduled',
      notes TEXT,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_visits_patient ON visits(patient_id);
    CREATE INDEX IF NOT EXISTS idx_visits_date ON visits(visit_date);
    CREATE INDEX IF NOT EXISTS idx_ledger_date ON daily_ledger(entry_date);
    CREATE INDEX IF NOT EXISTS idx_payments_patient ON patient_payments(patient_id);
    CREATE INDEX IF NOT EXISTS idx_appointments_patient ON appointments(patient_id);
    CREATE INDEX IF NOT EXISTS idx_appointments_date ON appointments(appointment_date);
  `);
  console.log('Database initialized');
}

initDB().catch(console.error);

// Root check route to quickly verify function invocation works
app.get('/', async (req, res) => {
  try {
    // Quick query test to see if DB is truly working
    const result = await pool.query('SELECT NOW()');
    res.status(200).json({ 
      status: "success", 
      message: "Physio Clinic API is alive!",
      database_time: result.rows[0].now 
    });
  } catch (err) {
    res.status(500).json({ 
      status: "error", 
      message: "Server is up, but Database connection failed.",
      details: err.message 
    });
  }
});

// ---- PATIENTS ----
app.get('/api/patients', async (req, res) => {
  try {
    const { search, active } = req.query;
    let query = 'SELECT * FROM patients WHERE 1=1';
    const params = [];
    if (search) {
      params.push(`%${search}%`);
      query += ` AND (first_name ILIKE $${params.length} OR last_name ILIKE $${params.length} OR patient_id ILIKE $${params.length} OR phone ILIKE $${params.length})`;
    }
    if (active !== undefined) {
      params.push(active === 'true');
      query += ` AND is_active = $${params.length}`;
    }
    query += ' ORDER BY created_at DESC';
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/patients/:id', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM patients WHERE id = $1', [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/patients', async (req, res) => {
  try {
    const { first_name, last_name, phone, email, date_of_birth, gender, address, diagnosis, referring_doctor, notes } = req.body;
    const countRes = await pool.query('SELECT COUNT(*) FROM patients');
    const patient_id = `PT${String(parseInt(countRes.rows[0].count) + 1001).padStart(5,'0')}`;
    const result = await pool.query(
      `INSERT INTO patients (patient_id, first_name, last_name, phone, email, date_of_birth, gender, address, diagnosis, referring_doctor, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [patient_id, first_name, last_name, phone, email, date_of_birth, gender, address, diagnosis, referring_doctor, notes]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/patients/:id', async (req, res) => {
  try {
    const { first_name, last_name, phone, email, date_of_birth, gender, address, diagnosis, referring_doctor, notes, is_active } = req.body;
    const result = await pool.query(
      `UPDATE patients SET first_name=$1, last_name=$2, phone=$3, email=$4, date_of_birth=$5, gender=$6,
       address=$7, diagnosis=$8, referring_doctor=$9, notes=$10, is_active=$11, updated_at=NOW()
       WHERE id=$12 RETURNING *`,
      [first_name, last_name, phone, email, date_of_birth, gender, address, diagnosis, referring_doctor, notes, is_active, req.params.id]
    );
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---- VISITS ----
app.get('/api/visits', async (req, res) => {
  try {
    const { patient_id, date_from, date_to, date } = req.query;
    let query = `SELECT v.*, p.first_name, p.last_name, p.patient_id as pid 
                 FROM visits v JOIN patients p ON v.patient_id = p.id WHERE 1=1`;
    const params = [];
    if (patient_id) { params.push(patient_id); query += ` AND v.patient_id = $${params.length}`; }
    if (date) { params.push(date); query += ` AND v.visit_date = $${params.length}`; }
    if (date_from) { params.push(date_from); query += ` AND v.visit_date >= $${params.length}`; }
    if (date_to) { params.push(date_to); query += ` AND v.visit_date <= $${params.length}`; }
    query += ' ORDER BY v.visit_date DESC, v.visit_time DESC';
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/visits', async (req, res) => {
  const client = await pool.connect();
  try {
    // console.log('Request Body:', req.body);
    await client.query('BEGIN');
    const { patient_id, therapy_plan_id, visit_date, visit_time, therapist_name, therapy_type,
            duration_minutes, fee_charged, amount_paid, payment_method, payment_status, session_notes,
            chief_complaint, treatment_given } = req.body;
    const normalizedVisitDate = normalizeDate(visit_date);
    
    const visitResult = await client.query(
      `INSERT INTO visits (patient_id, therapy_plan_id, visit_date, visit_time, therapist_name, therapy_type,
        duration_minutes, fee_charged, amount_paid, payment_method, payment_status, session_notes, chief_complaint, treatment_given)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
      [patient_id, therapy_plan_id || null, normalizedVisitDate, visit_time, therapist_name, therapy_type,
       duration_minutes || 60, fee_charged || 0, amount_paid || 0, payment_method, payment_status, session_notes, chief_complaint, treatment_given]
    );
    const visit = visitResult.rows[0];

    if (amount_paid > 0) {
      await client.query(
        `INSERT INTO patient_payments (patient_id, visit_id, payment_date, amount, payment_method, notes)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [patient_id, visit.id, normalizedVisitDate, amount_paid, payment_method, `Visit payment - ${normalizedVisitDate}`]
      );
      await client.query(
        `INSERT INTO daily_ledger (entry_date, entry_type, category, description, amount, payment_method, patient_id, visit_id)
         VALUES ($1,'income','therapy_fee',$2,$3,$4,$5,$6)`,
        [normalizedVisitDate, `Therapy fee - ${visit.therapy_type || 'Session'}`, amount_paid, payment_method, patient_id, visit.id]
      );
    }
    await client.query('COMMIT');
    res.status(201).json(visit);
  } catch (err) {
    await client.query('ROLLBACK');

/*     console.error('========== DB ERROR ==========');
  console.error(err);
  console.error('Code:', err.code);
  console.error('Message:', err.message);
  console.error('Detail:', err.detail);
  console.error('Constraint:', err.constraint);
  console.error('Table:', err.table);
  console.error('Column:', err.column);
  console.error('=============================='); */

    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

app.put('/api/visits/:id', async (req, res) => {
  try {
    const { visit_date, visit_time, therapist_name, therapy_type, duration_minutes, fee_charged,
            amount_paid, payment_method, payment_status, session_notes, chief_complaint, treatment_given } = req.body;
    const normalizedVisitDate = normalizeDate(visit_date);
    const result = await pool.query(
      `UPDATE visits SET visit_date=$1, visit_time=$2, therapist_name=$3, therapy_type=$4, duration_minutes=$5,
       fee_charged=$6, amount_paid=$7, payment_method=$8, payment_status=$9, session_notes=$10,
       chief_complaint=$11, treatment_given=$12 WHERE id=$13 RETURNING *`,
      [normalizedVisitDate, visit_time, therapist_name, therapy_type, duration_minutes || 60, fee_charged || 0,
       amount_paid || 0, payment_method, payment_status, session_notes, chief_complaint, treatment_given, req.params.id]
    );
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---- THERAPY PLANS ----
app.get('/api/therapy-plans/:patient_id', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM therapy_plans WHERE patient_id=$1 ORDER BY created_at DESC', [req.params.patient_id]);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/therapy-plans', async (req, res) => {
  try {
    const { patient_id, plan_name, total_sessions, fee_per_session, start_date, end_date, notes } = req.body;
    const result = await pool.query(
      `INSERT INTO therapy_plans (patient_id, plan_name, total_sessions, fee_per_session, start_date, end_date, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [patient_id, plan_name, total_sessions, fee_per_session, start_date, end_date, notes]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---- DAILY LEDGER ----
app.get('/api/ledger', async (req, res) => {
  try {
    const { date, date_from, date_to } = req.query;
    let query = `SELECT l.id,
              to_char(l.entry_date,'YYYY-MM-DD') AS entry_date,
              l.entry_type, l.category, l.description, l.amount, l.payment_method, l.reference_number,
              l.patient_id, l.visit_id, l.created_at,
              p.first_name, p.last_name, v.fee_charged, v.amount_paid
           FROM daily_ledger l
           LEFT JOIN patients p ON l.patient_id = p.id
           LEFT JOIN visits v ON l.visit_id = v.id
           WHERE 1=1`;
    const params = [];
    if (date) { params.push(date); query += ` AND l.entry_date = $${params.length}`; }
    if (date_from) { params.push(date_from); query += ` AND l.entry_date >= $${params.length}`; }
    if (date_to) { params.push(date_to); query += ` AND l.entry_date <= $${params.length}`; }
    query += ' ORDER BY l.entry_date DESC, l.created_at DESC';
    // console.log(query, params);
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/ledger', async (req, res) => {
  try {
    const { entry_date, entry_type, category, description, amount, payment_method, reference_number, patient_id } = req.body;
    const normalizedEntryDate = normalizeDate(entry_date);
    const patientId = patient_id ? patient_id : null;
    // insert into daily ledger
    const result = await pool.query(
      `INSERT INTO daily_ledger (entry_date, entry_type, category, description, amount, payment_method, reference_number, patient_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [normalizedEntryDate, entry_type, category, description, amount, payment_method, reference_number, patientId]
    );

    console.log(entry_type, patientId, amount);
    // If this is an income entry for a patient, also record a patient payment so patient ledger reflects it
    if (entry_type === 'income' && patientId && Number(amount) > 0) {
      await pool.query(
        `INSERT INTO patient_payments (patient_id, visit_id, payment_date, amount, payment_method, reference_number, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [patientId, null, normalizedEntryDate, amount, payment_method, reference_number, description]
      );
    }

    res.status(201).json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/ledger/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM daily_ledger WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---- PATIENT LEDGER ----
app.get('/api/patient-ledger/:patient_id', async (req, res) => {
  try {
    const visits = await pool.query(
      `SELECT v.id, v.patient_id, v.therapy_plan_id, to_char(v.visit_date,'YYYY-MM-DD') AS visit_date,
              v.visit_time, v.therapist_name, v.therapy_type, v.duration_minutes,
              v.fee_charged, v.amount_paid, v.payment_method, v.payment_status,
              v.session_notes, v.chief_complaint, v.treatment_given, v.created_at,
              'visit' as record_type
       FROM visits v
       WHERE v.patient_id = $1
       ORDER BY v.visit_date DESC`,
      [req.params.patient_id]
    );
    const payments = await pool.query(
      `SELECT pp.id, pp.visit_id, to_char(pp.payment_date,'YYYY-MM-DD') AS payment_date, pp.amount, pp.payment_method, pp.reference_number, pp.notes, pp.created_at, 'payment' as record_type FROM patient_payments pp WHERE pp.patient_id = $1 ORDER BY pp.payment_date DESC`,
      [req.params.patient_id]
    );
    const summary = await pool.query(
      `WITH visits_sum AS (
         SELECT COALESCE(SUM(fee_charged),0) AS total_charged,
                COUNT(*) AS total_visits
         FROM visits WHERE patient_id = $1
       ), payments_sum AS (
         SELECT COALESCE(SUM(amount),0) AS total_paid
         FROM patient_payments WHERE patient_id = $1
       )
       SELECT v.total_charged,
              p.total_paid,
              v.total_charged - p.total_paid AS balance_due,
              v.total_visits
       FROM visits_sum v CROSS JOIN payments_sum p`,
      [req.params.patient_id]
    );
    // console.log(visits, payments, summary);
    res.json({ visits: visits.rows, payments: payments.rows, summary: summary.rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---- PATIENT DUES ----
app.get('/api/patient-dues', async (req, res) => {
  try {
    const { patient_id } = req.query;
    const params = [];
    let query = `
      SELECT p.id, p.patient_id as patient_code, p.first_name, p.last_name,
             COALESCE(v.total_charged,0) as total_charged,
             COALESCE(pay.total_paid,0) as total_paid,
             COALESCE(v.total_charged,0) - COALESCE(pay.total_paid,0) as due_balance
      FROM patients p
      LEFT JOIN (
        SELECT patient_id, SUM(fee_charged) AS total_charged
        FROM visits
        GROUP BY patient_id
      ) v ON v.patient_id = p.id
      LEFT JOIN (
        SELECT patient_id, SUM(amount) AS total_paid
        FROM patient_payments
        GROUP BY patient_id
      ) pay ON pay.patient_id = p.id
    `;
    if (patient_id) {
      params.push(patient_id);
      query += ` WHERE p.id = $${params.length}`;
    }
    if (!patient_id) {
      query += ` WHERE COALESCE(v.total_charged,0) - COALESCE(pay.total_paid,0) > 0`;
    }
    query += ` ORDER BY due_balance DESC`;
    // console.log(query, params);
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---- DASHBOARD STATS ----
app.get('/api/dashboard', async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const [todayVisits, todayIncome, totalPatients, monthlyIncome, pendingBalance, recentVisits] = await Promise.all([
      pool.query(`SELECT COUNT(*) FROM visits WHERE visit_date = $1`, [today]),
      pool.query(`SELECT COALESCE(SUM(amount_paid),0) as total FROM visits WHERE visit_date = $1`, [today]),
      pool.query(`SELECT COUNT(*) FROM patients WHERE is_active = true`),
      pool.query(`SELECT COALESCE(SUM(amount),0) as total FROM daily_ledger WHERE entry_type='income' AND DATE_TRUNC('month', entry_date) = DATE_TRUNC('month', NOW())`),
      pool.query(`SELECT (SELECT COALESCE(SUM(fee_charged),0) FROM visits) - (SELECT COALESCE(SUM(amount),0) FROM patient_payments) as total`),
      pool.query(`SELECT v.*, p.first_name, p.last_name, p.patient_id as pid FROM visits v 
                  JOIN patients p ON v.patient_id = p.id ORDER BY v.created_at DESC LIMIT 5`),
    ]);
    const weeklyData = await pool.query(`
      SELECT TO_CHAR(gs.day, 'Dy') as day, 
             COALESCE(SUM(v.amount_paid),0) as income,
             COUNT(v.id) as visits
      FROM generate_series(NOW()::date - 6, NOW()::date, '1 day'::interval) gs(day)
      LEFT JOIN visits v ON v.visit_date = gs.day::date
      GROUP BY gs.day ORDER BY gs.day
    `);
    res.json({
      today_visits: parseInt(todayVisits.rows[0].count),
      today_income: parseFloat(todayIncome.rows[0].total),
      total_patients: parseInt(totalPatients.rows[0].count),
      monthly_income: parseFloat(monthlyIncome.rows[0].total),
      pending_balance: parseFloat(pendingBalance.rows[0].total),
      recent_visits: recentVisits.rows,
      weekly_data: weeklyData.rows,
    });
  } catch (err) {
    // res.status(500).json({ error: err.message });
    console.error("Dashboard query failed:", err.message);
    
    res.status(500).json({ 
      status: "error", 
      message: "Failed to retrieve dashboard records.",
      details: err.message 
    });
  }
});

// ---- APPOINTMENTS ----
app.get('/api/appointments', async (req, res) => {
  try {
    const { start_date, end_date } = req.query;
    let query = `
      SELECT a.id, a.patient_id, a.therapist_name, 
             to_char(a.appointment_date,'YYYY-MM-DD') AS appointment_date,
             to_char(a.appointment_time,'HH24:MI') AS appointment_time,
             a.duration_minutes, a.therapy_type, a.status, a.notes, a.created_at,
             p.first_name, p.last_name, p.patient_id as patient_code
      FROM appointments a
      LEFT JOIN patients p ON a.patient_id = p.id
    `;
    const params = [];
    if (start_date && end_date) {
      params.push(start_date, end_date);
      query += ` WHERE a.appointment_date BETWEEN $1 AND $2`;
    }
    query += ` ORDER BY a.appointment_date, a.appointment_time`;
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/appointments', async (req, res) => {
  try {
    const { patient_id, therapist_name, appointment_date, appointment_time, duration_minutes, therapy_type, status, notes } = req.body;
    const normalizedDate = normalizeDate(appointment_date);
    const result = await pool.query(
      `INSERT INTO appointments (patient_id, therapist_name, appointment_date, appointment_time, duration_minutes, therapy_type, status, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [patient_id || null, therapist_name || '', normalizedDate, appointment_time, duration_minutes || 15, therapy_type || '', status || 'scheduled', notes || '']
    );
    res.status(201).json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/appointments/:id', async (req, res) => {
  try {
    const { patient_id, therapist_name, appointment_date, appointment_time, duration_minutes, therapy_type, status, notes } = req.body;
    const normalizedDate = normalizeDate(appointment_date);
    const result = await pool.query(
      `UPDATE appointments SET patient_id=$1, therapist_name=$2, appointment_date=$3, appointment_time=$4, 
              duration_minutes=$5, therapy_type=$6, status=$7, notes=$8, updated_at=NOW()
       WHERE id=$9 RETURNING *`,
      [patient_id || null, therapist_name || '', normalizedDate, appointment_time, duration_minutes || 15, therapy_type || '', status || 'scheduled', notes || '', req.params.id]
    );
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/appointments/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM appointments WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

const PORT = process.env.SERVER_PORT || 5000;


// CRITICAL: Export the app for Vercel, do not call app.listen() when running on Vercel
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
module.exports = app; 
