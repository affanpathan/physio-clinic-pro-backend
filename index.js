const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { Pool, types } = require('pg');
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");

const localEnvPath = path.resolve(__dirname, '.env');
const frontendEnvPath = path.resolve(__dirname, '..', 'frontend', '.env');
const envPath = fs.existsSync(localEnvPath) ? localEnvPath : fs.existsSync(frontendEnvPath) ? frontendEnvPath : localEnvPath;
const dotenvResult = require('dotenv').config({ path: envPath });
console.log('Loaded env path:', envPath, 'dotenv error:', dotenvResult.error ? dotenvResult.error.message : null);
console.log('SYS_ADMIN configured:', Boolean(process.env.SYS_ADMIN), 'length:', process.env.SYS_ADMIN ? process.env.SYS_ADMIN.length : 0);

const app = express();
app.use(cors());
app.use(express.json());

const JWT_SECRET = process.env.JWT_SECRET || 'supersecretjwtkey';
const ADMIN_JWT_SECRET = process.env.ADMIN_JWT_SECRET || JWT_SECRET;

function authenticateToken(req, res, next) {
  if (req.path === '/clinic-users/login' || req.path === '/' || req.path === '/admin/validate') {
    return next();
  }

  const authHeader = req.get('authorization') || '';
  if (!authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }

  const token = authHeader.slice(7);
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.userId = payload.userId;
    req.userName = payload.userName;
    req.clinicId = payload.clinicId;
    req.isAdmin = Boolean(payload.role === 'admin');
    next();
  } catch (err) {
    try {
      const payload = jwt.verify(token, ADMIN_JWT_SECRET);
      req.isAdmin = Boolean(payload.role === 'admin');
      next();
    } catch (_err) {
      return res.status(401).json({ success: false, error: 'Invalid token' });
    }
  }
}

app.use('/api', authenticateToken);

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
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: isProduction ? { rejectUnauthorized: false } : false,
    })
  : new Pool(dbConfig);

pool.on('error', (err) => {
  console.error('Unexpected error on idle PostgreSQL client:', err.message);
  // Do not exit the process; let Vercel handle recycling the serverless container
});

// DATE (OID 1082): return as raw 'YYYY-MM-DD' string. Without this, pg parses it into a
// local-midnight JS Date, and res.json()'s toISOString() call then shifts it to the previous
// calendar day whenever the server's local timezone is ahead of UTC.
types.setTypeParser(1082, (val) => val);

const normalizeDate = (value) => {
  if (!value) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toISOString().slice(0, 10);
};

function normalizeTherapies(therapies) {
  if (!Array.isArray(therapies)) return { therapies: [], error: null };
  const seen = new Set();
  const result = [];
  for (const t of therapies) {
    const therapy_type = String(t?.therapy_type || '').trim();
    const duration_minutes = Math.max(0, parseInt(t?.duration_minutes, 10) || 0);
    if (!therapy_type || duration_minutes <= 0) continue;
    if (seen.has(therapy_type)) return { therapies: [], error: `Duplicate therapy type: ${therapy_type}` };
    seen.add(therapy_type);
    result.push({ therapy_type, duration_minutes });
  }
  return { therapies: result, error: null };
}

// Initialize DB schema
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS patients (
      id SERIAL PRIMARY KEY,
      clinic_id INTEGER REFERENCES clinic_master(id) ON DELETE CASCADE,
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
      clinic_id INTEGER REFERENCES clinic_master(id) ON DELETE CASCADE,
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
      clinic_id INTEGER REFERENCES clinic_master(id) ON DELETE CASCADE,
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
      clinic_id INTEGER REFERENCES clinic_master(id) ON DELETE CASCADE,
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
      clinic_id INTEGER REFERENCES clinic_master(id) ON DELETE CASCADE,
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
      clinic_id INTEGER REFERENCES clinic_master(id) ON DELETE CASCADE,
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

    CREATE TABLE IF NOT EXISTS therapists (
      id SERIAL PRIMARY KEY,
      clinic_id INTEGER REFERENCES clinic_master(id) ON DELETE CASCADE,
      therapist_name VARCHAR(200) NOT NULL,
      phone VARCHAR(30),
      address TEXT,
      active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS clinic_master (
      id SERIAL PRIMARY KEY,
      clinic_name VARCHAR(200) NOT NULL,
      clinic_person VARCHAR(200),
      clinic_phone VARCHAR(30),
      clinic_address TEXT,
      clinic_city VARCHAR(100),
      clinic_state VARCHAR(100),
      clinic_country VARCHAR(100),
      currency VARCHAR(10) DEFAULT 'INR',
      currency_symbol VARCHAR(10) DEFAULT '₹',
      last_date DATE,
      clinic_active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS clinic_users (
      id SERIAL PRIMARY KEY,
      clinic_id INTEGER REFERENCES clinic_master(id) ON DELETE CASCADE,
      user_name VARCHAR(200) NOT NULL,
      user_id VARCHAR(200) NOT NULL,
      user_pass VARCHAR(200) NOT NULL,
      active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );

    ALTER TABLE patients ADD COLUMN IF NOT EXISTS clinic_id INTEGER REFERENCES clinic_master(id) ON DELETE CASCADE;
    ALTER TABLE therapy_plans ADD COLUMN IF NOT EXISTS clinic_id INTEGER REFERENCES clinic_master(id) ON DELETE CASCADE;
    ALTER TABLE visits ADD COLUMN IF NOT EXISTS clinic_id INTEGER REFERENCES clinic_master(id) ON DELETE CASCADE;
    ALTER TABLE visits ADD COLUMN IF NOT EXISTS therapy_types TEXT[];

    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'visits' AND column_name = 'therapy_types' AND data_type = 'ARRAY'
      ) THEN
        ALTER TABLE visits ALTER COLUMN therapy_types TYPE JSONB USING to_jsonb(therapy_types);
      END IF;
    END $$;
    ALTER TABLE patient_payments ADD COLUMN IF NOT EXISTS clinic_id INTEGER REFERENCES clinic_master(id) ON DELETE CASCADE;
    ALTER TABLE patient_payments ADD COLUMN IF NOT EXISTS ledger_id INTEGER REFERENCES daily_ledger(id) ON DELETE SET NULL;
    ALTER TABLE daily_ledger ADD COLUMN IF NOT EXISTS clinic_id INTEGER REFERENCES clinic_master(id) ON DELETE CASCADE;
    ALTER TABLE appointments ADD COLUMN IF NOT EXISTS clinic_id INTEGER REFERENCES clinic_master(id) ON DELETE CASCADE;
    ALTER TABLE therapists ADD COLUMN IF NOT EXISTS clinic_id INTEGER REFERENCES clinic_master(id) ON DELETE CASCADE;
    ALTER TABLE clinic_master ADD COLUMN IF NOT EXISTS currency VARCHAR(10) DEFAULT 'INR';
    ALTER TABLE clinic_master ADD COLUMN IF NOT EXISTS currency_symbol VARCHAR(10) DEFAULT '₹';

    CREATE INDEX IF NOT EXISTS idx_visits_patient ON visits(patient_id);
    CREATE INDEX IF NOT EXISTS idx_therapists_clinic ON therapists(clinic_id);
    CREATE INDEX IF NOT EXISTS idx_visits_date ON visits(visit_date);
    CREATE INDEX IF NOT EXISTS idx_ledger_date ON daily_ledger(entry_date);
    CREATE INDEX IF NOT EXISTS idx_patients_clinic ON patients(clinic_id);
    CREATE INDEX IF NOT EXISTS idx_therapy_plans_clinic ON therapy_plans(clinic_id);
    CREATE INDEX IF NOT EXISTS idx_visits_clinic ON visits(clinic_id);
    CREATE INDEX IF NOT EXISTS idx_payments_clinic ON patient_payments(clinic_id);
    CREATE INDEX IF NOT EXISTS idx_ledger_clinic ON daily_ledger(clinic_id);
    CREATE INDEX IF NOT EXISTS idx_appointments_clinic ON appointments(clinic_id);
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

// ---- CLINIC MASTER ----
app.get('/api/clinic-master', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM clinic_master ORDER BY id ASC');
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/clinic-master/:id', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM clinic_master WHERE id = $1', [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/clinic-master', async (req, res) => {
  try {
    const { clinic_name, clinic_person, clinic_phone, clinic_address, clinic_city, clinic_state, clinic_country, currency, currency_symbol, last_date, clinic_active } = req.body;
    const result = await pool.query(
      `INSERT INTO clinic_master (clinic_name, clinic_person, clinic_phone, clinic_address, clinic_city, clinic_state, clinic_country, currency, currency_symbol, last_date, clinic_active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
      [clinic_name, clinic_person || '', clinic_phone || '', clinic_address || '', clinic_city || '', clinic_state || '', clinic_country || '', currency || 'INR', currency_symbol || '₹', last_date || null, clinic_active !== undefined ? clinic_active : true]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/clinic-master/:id', async (req, res) => {
  try {
    const { clinic_name, clinic_person, clinic_phone, clinic_address, clinic_city, clinic_state, clinic_country, currency, currency_symbol, last_date, clinic_active } = req.body;
    const result = await pool.query(
      `UPDATE clinic_master
       SET clinic_name = $1, clinic_person = $2, clinic_phone = $3, clinic_address = $4, clinic_city = $5,
           clinic_state = $6, clinic_country = $7, currency = $8, currency_symbol = $9, last_date = $10, clinic_active = $11, updated_at = NOW()
       WHERE id = $12 RETURNING *`,
      [clinic_name, clinic_person || '', clinic_phone || '', clinic_address || '', clinic_city || '', clinic_state || '', clinic_country || '', currency || 'INR', currency_symbol || '₹', last_date || null, clinic_active !== undefined ? clinic_active : true, req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/clinic-master/:id', async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM clinic_master WHERE id = $1 RETURNING id', [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---- CLINIC USERS ----
app.get('/api/clinic-users', async (req, res) => {
  try {
    const query = req.clinicId
      ? `SELECT cu.*, cm.clinic_name FROM clinic_users cu LEFT JOIN clinic_master cm ON cu.clinic_id = cm.id WHERE cu.clinic_id = $1 ORDER BY cu.id ASC`
      : `SELECT cu.*, cm.clinic_name FROM clinic_users cu LEFT JOIN clinic_master cm ON cu.clinic_id = cm.id ORDER BY cu.id ASC`;
    const params = req.clinicId ? [req.clinicId] : [];
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/clinic-users/:id', async (req, res) => {
  try {
    const query = req.clinicId
      ? `SELECT cu.*, cm.clinic_name FROM clinic_users cu LEFT JOIN clinic_master cm ON cu.clinic_id = cm.id WHERE cu.id = $1 AND cu.clinic_id = $2`
      : `SELECT cu.*, cm.clinic_name FROM clinic_users cu LEFT JOIN clinic_master cm ON cu.clinic_id = cm.id WHERE cu.id = $1`;
    const params = req.clinicId ? [req.params.id, req.clinicId] : [req.params.id];
    const result = await pool.query(query, params);
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/clinic-users/login', async (req, res) => {
  try {
    console.log('login called============');
    const { user_id, user_pass } = req.body;
    if (!user_id || !user_pass) {
      return res.status(400).json({ success: false, error: 'User ID and password are required.' });
    }

    console.log(user_id, user_pass);
    const result = await pool.query(
      `SELECT id, clinic_id, user_name, user_id, user_pass, active
      FROM clinic_users
      WHERE LOWER(TRIM(user_id)) = LOWER(TRIM($1))
        AND active = TRUE`,
      [String(user_id).trim()]
    );

    console.log(result.rows, result.rows.length);
    if (result.rows.length === 0) {
      return res.status(401).json({
        success: false,
        error: "Invalid user ID or password."
      });
    }

    const userRecord = result.rows[0];
    const storedPassword = String(userRecord.user_pass || '');
    let isPasswordValid = false;

    console.log(userRecord, storedPassword, isPasswordValid);
    if (/^\$2[aby]\$/.test(storedPassword)) {
      isPasswordValid = await bcrypt.compare(user_pass, storedPassword);
      console.log('validated', isPasswordValid);
    } else {
      isPasswordValid = user_pass === storedPassword;
      console.log('migrated', isPasswordValid);
      if (isPasswordValid) {
        const migratedHash = await bcrypt.hash(user_pass, 10);
        await pool.query('UPDATE clinic_users SET user_pass = $1 WHERE id = $2', [migratedHash, userRecord.id]);
      }
    }

    if (!isPasswordValid) {
      return res.status(401).json({
        success: false,
        error: "Invalid user ID or password."
      });
    }

    const clinicResult = await pool.query(
      `SELECT clinic_name, last_date, clinic_active, currency, currency_symbol FROM clinic_master WHERE id = $1`,
      [userRecord.clinic_id]
    );

    const clinicRow = clinicResult.rows[0] || {};
    const clinicName = clinicRow.clinic_name || '';
    const clinicCurrency = clinicRow.currency || 'INR';
    const clinicCurrencySymbol = clinicRow.currency_symbol || '₹';
    const clinicExpiry = clinicRow.last_date ? new Date(clinicRow.last_date) : null;
    const clinicActive = clinicRow.clinic_active !== false;
    const subscriptionExpired = clinicExpiry ? clinicExpiry < new Date(new Date().toISOString().split('T')[0]) : false;

    if (!userRecord.active || !clinicActive || subscriptionExpired) {
      return res.status(403).json({
        success: false,
        error: 'Your subscription has expired. Please contact the service provider to renew your subscription and continue using the application.'
      });
    }

    const token = jwt.sign(
      {
        userId: userRecord.id,
        userName: userRecord.user_name,
        clinicId: userRecord.clinic_id,
      },
      JWT_SECRET,
      { expiresIn: '8h' }
    );

    res.json({
      success: true,
      token,
      clinic_id: userRecord.clinic_id,
      user: {
        id: userRecord.id,
        clinic_id: userRecord.clinic_id,
        user_name: userRecord.user_name,
        user_id: userRecord.user_id,
        active: userRecord.active,
        clinic_name: clinicName,
        currency: clinicCurrency,
        currency_symbol: clinicCurrencySymbol,
      },
      clinic_name: clinicName,
      currency: clinicCurrency,
      currency_symbol: clinicCurrencySymbol,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/admin/validate', async (req, res) => {
  try {
    const { password } = req.body;
    if (!password) {
      return res.status(400).json({ success: false, error: 'Admin password is required.' });
    }
    const sysAdminPassword = String(process.env.SYS_ADMIN || '').trim();
    if (!sysAdminPassword) {
      return res.status(500).json({ success: false, error: 'Admin password is not configured.' });
    }
    const providedPassword = String(password || '').trim();
    if (providedPassword !== sysAdminPassword) {
      return res.status(401).json({ success: false, error: 'Invalid admin password.' });
    }
    const adminToken = jwt.sign({ role: 'admin' }, ADMIN_JWT_SECRET, { expiresIn: '8h' });
    console.log('admin validate: generated adminToken length=', adminToken ? adminToken.length : 0);
    res.json({ success: true, adminToken });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/clinic-users', async (req, res) => {
  try {
    const { clinic_id, user_name, user_id, user_pass, active } = req.body;
    // Hash the password
    const hashedPassword = await bcrypt.hash(user_pass, 10);
    const result = await pool.query(
      `INSERT INTO clinic_users (clinic_id, user_name, user_id, user_pass, active)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [clinic_id || req.clinicId || null, user_name, user_id, hashedPassword, active !== undefined ? active : true]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/clinic-users/:id', async (req, res) => {
  try {
    const { clinic_id, user_name, user_id, user_pass, active } = req.body;
    const isActive = active !== undefined ? active : true;
    const targetClinicId = clinic_id || req.clinicId || null;
    const clinicFilter = req.clinicId && !req.isAdmin ? ' AND clinic_id = $7' : '';

    if (typeof user_pass === 'string' && user_pass.length > 0) {
      const hashedPassword = await bcrypt.hash(user_pass, 10);
      const query = req.clinicId && !req.isAdmin
        ? `UPDATE clinic_users SET clinic_id = $1, user_name = $2, user_id = $3, user_pass = $4, active = $5, updated_at = NOW() WHERE id = $6${clinicFilter} RETURNING *`
        : `UPDATE clinic_users SET clinic_id = $1, user_name = $2, user_id = $3, user_pass = $4, active = $5, updated_at = NOW() WHERE id = $6 RETURNING *`;
      const params = req.clinicId && !req.isAdmin
        ? [targetClinicId, user_name, user_id, hashedPassword, isActive, req.params.id, req.clinicId]
        : [targetClinicId, user_name, user_id, hashedPassword, isActive, req.params.id];
      const result = await pool.query(query, params);
      if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
      return res.json(result.rows[0]);
    }

    const query = req.clinicId && !req.isAdmin
      ? `UPDATE clinic_users SET clinic_id = $1, user_name = $2, user_id = $3, active = $4, updated_at = NOW() WHERE id = $5${clinicFilter} RETURNING *`
      : `UPDATE clinic_users SET clinic_id = $1, user_name = $2, user_id = $3, active = $4, updated_at = NOW() WHERE id = $5 RETURNING *`;
    const params = req.clinicId && !req.isAdmin
      ? [targetClinicId, user_name, user_id, isActive, req.params.id, req.clinicId]
      : [targetClinicId, user_name, user_id, isActive, req.params.id];
    const result = await pool.query(query, params);
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/clinic-users/:id', async (req, res) => {
  try {
    const query = req.clinicId ? 'DELETE FROM clinic_users WHERE id = $1 AND clinic_id = $2 RETURNING id' : 'DELETE FROM clinic_users WHERE id = $1 RETURNING id';
    const params = req.clinicId ? [req.params.id, req.clinicId] : [req.params.id];
    const result = await pool.query(query, params);
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---- THERAPISTS ----
app.get('/api/therapists', async (req, res) => {
  try {
    const query = req.clinicId
      ? `SELECT t.*, cm.clinic_name FROM therapists t LEFT JOIN clinic_master cm ON t.clinic_id = cm.id WHERE t.clinic_id = $1 ORDER BY t.id ASC`
      : `SELECT t.*, cm.clinic_name FROM therapists t LEFT JOIN clinic_master cm ON t.clinic_id = cm.id ORDER BY t.id ASC`;
    const params = req.clinicId ? [req.clinicId] : [];
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/therapists/:id', async (req, res) => {
  try {
    const query = req.clinicId
      ? `SELECT t.*, cm.clinic_name FROM therapists t LEFT JOIN clinic_master cm ON t.clinic_id = cm.id WHERE t.id = $1 AND t.clinic_id = $2`
      : `SELECT t.*, cm.clinic_name FROM therapists t LEFT JOIN clinic_master cm ON t.clinic_id = cm.id WHERE t.id = $1`;
    const params = req.clinicId ? [req.params.id, req.clinicId] : [req.params.id];
    const result = await pool.query(query, params);
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/therapists', async (req, res) => {
  try {
    const { clinic_id, therapist_name, phone, address, active } = req.body;
    if (!therapist_name || !therapist_name.trim()) {
      return res.status(400).json({ error: 'Therapist name is required.' });
    }
    const targetClinicId = clinic_id || req.clinicId || null;
    const result = await pool.query(
      `INSERT INTO therapists (clinic_id, therapist_name, phone, address, active)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [targetClinicId, therapist_name.trim(), phone || '', address || '', active !== undefined ? active : true]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/therapists/:id', async (req, res) => {
  try {
    const { clinic_id, therapist_name, phone, address, active } = req.body;
    if (!therapist_name || !therapist_name.trim()) {
      return res.status(400).json({ error: 'Therapist name is required.' });
    }
    const targetClinicId = clinic_id || req.clinicId || null;
    const clinicFilter = req.clinicId && !req.isAdmin ? ' AND clinic_id = $7' : '';
    const query = req.clinicId && !req.isAdmin
      ? `UPDATE therapists SET clinic_id = $1, therapist_name = $2, phone = $3, address = $4, active = $5, updated_at = NOW() WHERE id = $6${clinicFilter} RETURNING *`
      : `UPDATE therapists SET clinic_id = $1, therapist_name = $2, phone = $3, address = $4, active = $5, updated_at = NOW() WHERE id = $6 RETURNING *`;
    const params = req.clinicId && !req.isAdmin
      ? [targetClinicId, therapist_name.trim(), phone || '', address || '', active !== undefined ? active : true, req.params.id, req.clinicId]
      : [targetClinicId, therapist_name.trim(), phone || '', address || '', active !== undefined ? active : true, req.params.id];
    const result = await pool.query(query, params);
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/therapists/:id', async (req, res) => {
  try {
    const query = req.clinicId ? 'DELETE FROM therapists WHERE id = $1 AND clinic_id = $2 RETURNING id' : 'DELETE FROM therapists WHERE id = $1 RETURNING id';
    const params = req.clinicId ? [req.params.id, req.clinicId] : [req.params.id];
    const result = await pool.query(query, params);
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---- PATIENTS ----
app.get('/api/patients', async (req, res) => {
  try {
    const { search, active } = req.query;
    let query = 'SELECT * FROM patients WHERE 1=1';
    const params = [];
    if (req.clinicId) {
      params.push(req.clinicId);
      query += ` AND clinic_id = $${params.length}`;
    }
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
    const result = await pool.query(
      req.clinicId ? 'SELECT * FROM patients WHERE id = $1 AND clinic_id = $2' : 'SELECT * FROM patients WHERE id = $1',
      req.clinicId ? [req.params.id, req.clinicId] : [req.params.id]
    );
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
      `INSERT INTO patients (clinic_id, patient_id, first_name, last_name, phone, email, date_of_birth, gender, address, diagnosis, referring_doctor, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [req.clinicId || null, patient_id, first_name, last_name, phone, email, date_of_birth, gender, address, diagnosis, referring_doctor, notes]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/patients/:id', async (req, res) => {
  try {
    const { first_name, last_name, phone, email, date_of_birth, gender, address, diagnosis, referring_doctor, notes, is_active } = req.body;
    const result = await pool.query(
      req.clinicId
        ? `UPDATE patients SET first_name=$1, last_name=$2, phone=$3, email=$4, date_of_birth=$5, gender=$6,
           address=$7, diagnosis=$8, referring_doctor=$9, notes=$10, is_active=$11, updated_at=NOW()
           WHERE id=$12 AND clinic_id=$13 RETURNING *`
        : `UPDATE patients SET first_name=$1, last_name=$2, phone=$3, email=$4, date_of_birth=$5, gender=$6,
           address=$7, diagnosis=$8, referring_doctor=$9, notes=$10, is_active=$11, updated_at=NOW()
           WHERE id=$12 RETURNING *`,
      req.clinicId
        ? [first_name, last_name, phone, email, date_of_birth, gender, address, diagnosis, referring_doctor, notes, is_active, req.params.id, req.clinicId]
        : [first_name, last_name, phone, email, date_of_birth, gender, address, diagnosis, referring_doctor, notes, is_active, req.params.id]
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
    if (req.clinicId) {
      params.push(req.clinicId);
      query += ` AND v.clinic_id = $${params.length}`;
    }
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
    const { patient_id, therapy_plan_id, visit_date, visit_time, therapist_name, therapies,
            fee_charged, amount_paid, payment_method, payment_status, session_notes,
            chief_complaint, treatment_given } = req.body;

    const { therapies: normalizedTherapies, error: therapiesError } = normalizeTherapies(therapies);
    if (therapiesError) return res.status(400).json({ error: therapiesError });
    if (!normalizedTherapies.length) return res.status(400).json({ error: 'At least one therapy type with duration is required.' });
    if (!fee_charged || Number(fee_charged) <= 0) return res.status(400).json({ error: 'Fee charged is required.' });

    const normalizedVisitDate = normalizeDate(visit_date);
    const legacyTherapyType = normalizedTherapies[0].therapy_type;
    const totalDuration = normalizedTherapies.reduce((s, t) => s + t.duration_minutes, 0);

    await client.query('BEGIN');
    const visitResult = await client.query(
      `INSERT INTO visits (clinic_id, patient_id, therapy_plan_id, visit_date, visit_time, therapist_name, therapy_type, therapy_types,
        duration_minutes, fee_charged, amount_paid, payment_method, payment_status, session_notes, chief_complaint, treatment_given)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
      [req.clinicId || null, patient_id, therapy_plan_id || null, normalizedVisitDate, visit_time, therapist_name, legacyTherapyType,
       JSON.stringify(normalizedTherapies), totalDuration, fee_charged || 0, amount_paid || 0, payment_method, payment_status, session_notes, chief_complaint, treatment_given]
    );
    const visit = visitResult.rows[0];

    if (amount_paid > 0) {
      await client.query(
        `INSERT INTO patient_payments (clinic_id, patient_id, visit_id, payment_date, amount, payment_method, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [req.clinicId || null, patient_id, visit.id, normalizedVisitDate, amount_paid, payment_method, `Visit payment - ${normalizedVisitDate}`]
      );
      await client.query(
        `INSERT INTO daily_ledger (clinic_id, entry_date, entry_type, category, description, amount, payment_method, patient_id, visit_id)
         VALUES ($1,$2,'income','therapy_fee',$3,$4,$5,$6,$7)`,
        [req.clinicId || null, normalizedVisitDate, `Therapy fee - ${legacyTherapyType}`, amount_paid, payment_method, patient_id, visit.id]
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
  const client = await pool.connect();
  try {
    const { visit_date, visit_time, therapist_name, therapies, fee_charged,
            amount_paid, payment_method, payment_status, session_notes, chief_complaint, treatment_given } = req.body;

    const { therapies: normalizedTherapies, error: therapiesError } = normalizeTherapies(therapies);
    if (therapiesError) return res.status(400).json({ error: therapiesError });
    if (!normalizedTherapies.length) return res.status(400).json({ error: 'At least one therapy type with duration is required.' });
    if (!fee_charged || Number(fee_charged) <= 0) return res.status(400).json({ error: 'Fee charged is required.' });

    const normalizedVisitDate = normalizeDate(visit_date);
    const legacyTherapyType = normalizedTherapies[0].therapy_type;
    const totalDuration = normalizedTherapies.reduce((s, t) => s + t.duration_minutes, 0);

    await client.query('BEGIN');

    const existing = await client.query(
      req.clinicId
        ? 'SELECT amount_paid, (visit_date = CURRENT_DATE) AS is_today FROM visits WHERE id=$1 AND clinic_id=$2'
        : 'SELECT amount_paid, (visit_date = CURRENT_DATE) AS is_today FROM visits WHERE id=$1',
      req.clinicId ? [req.params.id, req.clinicId] : [req.params.id]
    );
    if (!existing.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Not found' });
    }
    if (!existing.rows[0].is_today && Number(amount_paid || 0) !== Number(existing.rows[0].amount_paid)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Paid amount can only be edited on the day of the visit.' });
    }

    const result = await client.query(
      req.clinicId
        ? `UPDATE visits SET visit_date=$1, visit_time=$2, therapist_name=$3, therapy_type=$4, therapy_types=$5::jsonb, duration_minutes=$6,
           fee_charged=$7, amount_paid=$8, payment_method=$9, payment_status=$10, session_notes=$11,
           chief_complaint=$12, treatment_given=$13 WHERE id=$14 AND clinic_id=$15 RETURNING *`
        : `UPDATE visits SET visit_date=$1, visit_time=$2, therapist_name=$3, therapy_type=$4, therapy_types=$5::jsonb, duration_minutes=$6,
           fee_charged=$7, amount_paid=$8, payment_method=$9, payment_status=$10, session_notes=$11,
           chief_complaint=$12, treatment_given=$13 WHERE id=$14 RETURNING *`,
      req.clinicId
        ? [normalizedVisitDate, visit_time, therapist_name, legacyTherapyType, JSON.stringify(normalizedTherapies), totalDuration, fee_charged || 0,
           amount_paid || 0, payment_method, payment_status, session_notes, chief_complaint, treatment_given, req.params.id, req.clinicId]
        : [normalizedVisitDate, visit_time, therapist_name, legacyTherapyType, JSON.stringify(normalizedTherapies), totalDuration, fee_charged || 0,
           amount_paid || 0, payment_method, payment_status, session_notes, chief_complaint, treatment_given, req.params.id]
    );
    if (!result.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Not found' });
    }
    const visit = result.rows[0];

    // -- payment ledger sync: replace any existing payment/ledger rows for this visit with fresh ones reflecting the edited amount --
    await client.query('DELETE FROM patient_payments WHERE visit_id=$1', [req.params.id]);
    await client.query('DELETE FROM daily_ledger WHERE visit_id=$1', [req.params.id]);
    if (amount_paid > 0) {
      await client.query(
        `INSERT INTO patient_payments (clinic_id, patient_id, visit_id, payment_date, amount, payment_method, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [req.clinicId || null, visit.patient_id, visit.id, normalizedVisitDate, amount_paid, payment_method, `Visit payment - ${normalizedVisitDate}`]
      );
      await client.query(
        `INSERT INTO daily_ledger (clinic_id, entry_date, entry_type, category, description, amount, payment_method, patient_id, visit_id)
         VALUES ($1,$2,'income','therapy_fee',$3,$4,$5,$6,$7)`,
        [req.clinicId || null, normalizedVisitDate, `Therapy fee - ${legacyTherapyType}`, amount_paid, payment_method, visit.patient_id, visit.id]
      );
    }

    await client.query('COMMIT');
    res.json(visit);
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

app.delete('/api/visits/:id', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const visitCheck = await client.query(
      req.clinicId ? 'SELECT id FROM visits WHERE id=$1 AND clinic_id=$2' : 'SELECT id FROM visits WHERE id=$1',
      req.clinicId ? [req.params.id, req.clinicId] : [req.params.id]
    );
    if (!visitCheck.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Not found' });
    }
    await client.query('DELETE FROM patient_payments WHERE visit_id=$1', [req.params.id]);
    await client.query('DELETE FROM daily_ledger WHERE visit_id=$1', [req.params.id]);
    await client.query('DELETE FROM visits WHERE id=$1', [req.params.id]);
    await client.query('COMMIT');
    res.json({ success: true });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

// ---- THERAPY PLANS ----
app.get('/api/therapy-plans/:patient_id', async (req, res) => {
  try {
    const result = await pool.query(
      req.clinicId ? 'SELECT * FROM therapy_plans WHERE patient_id=$1 AND clinic_id=$2 ORDER BY created_at DESC' : 'SELECT * FROM therapy_plans WHERE patient_id=$1 ORDER BY created_at DESC',
      req.clinicId ? [req.params.patient_id, req.clinicId] : [req.params.patient_id]
    );
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/therapy-plans', async (req, res) => {
  try {
    const { patient_id, plan_name, total_sessions, fee_per_session, start_date, end_date, notes } = req.body;
    const result = await pool.query(
      `INSERT INTO therapy_plans (clinic_id, patient_id, plan_name, total_sessions, fee_per_session, start_date, end_date, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [req.clinicId || null, patient_id, plan_name, total_sessions, fee_per_session, start_date, end_date, notes]
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
    if (req.clinicId) { params.push(req.clinicId); query += ` AND l.clinic_id = $${params.length}`; }
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
  const client = await pool.connect();
  try {
    const { entry_date, entry_type, category, description, amount, payment_method, reference_number, patient_id } = req.body;
    const normalizedEntryDate = normalizeDate(entry_date);
    const patientId = patient_id ? patient_id : null;

    await client.query('BEGIN');

    // insert into daily ledger
    const result = await client.query(
      `INSERT INTO daily_ledger (clinic_id, entry_date, entry_type, category, description, amount, payment_method, reference_number, patient_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [req.clinicId || null, normalizedEntryDate, entry_type, category, description, amount, payment_method, reference_number, patientId]
    );
    const ledgerEntry = result.rows[0];

    // If this is an income entry for a patient, also record a patient payment so patient ledger reflects it
    if (entry_type === 'income' && patientId && Number(amount) > 0) {
      await client.query(
        `INSERT INTO patient_payments (clinic_id, patient_id, visit_id, ledger_id, payment_date, amount, payment_method, reference_number, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [req.clinicId || null, patientId, null, ledgerEntry.id, normalizedEntryDate, amount, payment_method, reference_number, description]
      );
    }

    await client.query('COMMIT');
    res.status(201).json(ledgerEntry);
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

app.delete('/api/ledger/:id', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      req.clinicId ? 'DELETE FROM patient_payments WHERE ledger_id=$1 AND clinic_id=$2' : 'DELETE FROM patient_payments WHERE ledger_id=$1',
      req.clinicId ? [req.params.id, req.clinicId] : [req.params.id]
    );
    await client.query(
      req.clinicId ? 'DELETE FROM daily_ledger WHERE id=$1 AND clinic_id=$2' : 'DELETE FROM daily_ledger WHERE id=$1',
      req.clinicId ? [req.params.id, req.clinicId] : [req.params.id]
    );
    await client.query('COMMIT');
    res.json({ success: true });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

// ---- PATIENT LEDGER ----
app.get('/api/patient-ledger/:patient_id', async (req, res) => {
  try {
    const visits = await pool.query(
      req.clinicId
        ? `SELECT v.id, v.patient_id, v.therapy_plan_id, to_char(v.visit_date,'YYYY-MM-DD') AS visit_date,
              v.visit_time, v.therapist_name, v.therapy_type, v.duration_minutes,
              v.fee_charged, v.amount_paid, v.payment_method, v.payment_status,
              v.session_notes, v.chief_complaint, v.treatment_given, v.created_at,
              'visit' as record_type
         FROM visits v
         WHERE v.patient_id = $1 AND v.clinic_id = $2
         ORDER BY v.visit_date DESC`
        : `SELECT v.id, v.patient_id, v.therapy_plan_id, to_char(v.visit_date,'YYYY-MM-DD') AS visit_date,
              v.visit_time, v.therapist_name, v.therapy_type, v.duration_minutes,
              v.fee_charged, v.amount_paid, v.payment_method, v.payment_status,
              v.session_notes, v.chief_complaint, v.treatment_given, v.created_at,
              'visit' as record_type
         FROM visits v
         WHERE v.patient_id = $1
         ORDER BY v.visit_date DESC`,
      req.clinicId ? [req.params.patient_id, req.clinicId] : [req.params.patient_id]
    );
    const payments = await pool.query(
      req.clinicId
        ? `SELECT pp.id, pp.visit_id, to_char(pp.payment_date,'YYYY-MM-DD') AS payment_date, pp.amount, pp.payment_method, pp.reference_number, pp.notes, pp.created_at, 'payment' as record_type FROM patient_payments pp WHERE pp.patient_id = $1 AND pp.clinic_id = $2 ORDER BY pp.payment_date DESC`
        : `SELECT pp.id, pp.visit_id, to_char(pp.payment_date,'YYYY-MM-DD') AS payment_date, pp.amount, pp.payment_method, pp.reference_number, pp.notes, pp.created_at, 'payment' as record_type FROM patient_payments pp WHERE pp.patient_id = $1 ORDER BY pp.payment_date DESC`,
      req.clinicId ? [req.params.patient_id, req.clinicId] : [req.params.patient_id]
    );
    const summary = await pool.query(
      req.clinicId
        ? `WITH visits_sum AS (
           SELECT COALESCE(SUM(fee_charged),0) AS total_charged,
                  COUNT(*) AS total_visits
           FROM visits WHERE patient_id = $1 AND clinic_id = $2
         ), payments_sum AS (
           SELECT COALESCE(SUM(amount),0) AS total_paid
           FROM patient_payments WHERE patient_id = $1 AND clinic_id = $2
         )
         SELECT v.total_charged,
                p.total_paid,
                v.total_charged - p.total_paid AS balance_due,
                v.total_visits
         FROM visits_sum v CROSS JOIN payments_sum p`
        : `WITH visits_sum AS (
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
      req.clinicId ? [req.params.patient_id, req.clinicId] : [req.params.patient_id]
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
    const clinicFilter = req.clinicId ? ' AND clinic_id = $1' : '';
    const patientFilter = patient_id ? ` AND p.id = $${req.clinicId ? 2 : 1}` : '';

    if (req.clinicId) params.push(req.clinicId);
    if (patient_id) params.push(patient_id);

    const query = `
      SELECT p.id, p.patient_id as patient_code, p.first_name, p.last_name,
             COALESCE(v.total_charged,0) as total_charged,
             COALESCE(pay.total_paid,0) as total_paid,
             COALESCE(v.total_charged,0) - COALESCE(pay.total_paid,0) as due_balance
      FROM patients p
      LEFT JOIN (
        SELECT patient_id, SUM(fee_charged) AS total_charged
        FROM visits
        WHERE 1=1${clinicFilter}
        GROUP BY patient_id
      ) v ON v.patient_id = p.id
      LEFT JOIN (
        SELECT patient_id, SUM(amount) AS total_paid
        FROM patient_payments
        WHERE 1=1${clinicFilter}
        GROUP BY patient_id
      ) pay ON pay.patient_id = p.id
      WHERE 1=1
      ${req.clinicId ? 'AND p.clinic_id = $1' : ''}
      ${patientFilter}
      ${!patient_id ? 'AND COALESCE(v.total_charged,0) - COALESCE(pay.total_paid,0) > 0' : ''}
      ORDER BY due_balance DESC
    `;

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---- DASHBOARD STATS ----
app.get('/api/dashboard', async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const clinicFilter = req.clinicId ? ` AND clinic_id = $${1}` : '';
    const [todayVisits, todayIncome, totalPatients, monthlyIncome, pendingBalance, recentVisits] = await Promise.all([
      pool.query(req.clinicId ? `SELECT COUNT(*) FROM visits WHERE visit_date = $1 AND clinic_id = $2` : `SELECT COUNT(*) FROM visits WHERE visit_date = $1`, [today, ...(req.clinicId ? [req.clinicId] : [])]),
      pool.query(req.clinicId ? `SELECT COALESCE(SUM(amount_paid),0) as total FROM visits WHERE visit_date = $1 AND clinic_id = $2` : `SELECT COALESCE(SUM(amount_paid),0) as total FROM visits WHERE visit_date = $1`, [today, ...(req.clinicId ? [req.clinicId] : [])]),
      pool.query(req.clinicId ? `SELECT COUNT(*) FROM patients WHERE is_active = true AND clinic_id = $1` : `SELECT COUNT(*) FROM patients WHERE is_active = true`, [ ...(req.clinicId ? [req.clinicId] : []) ]),
      pool.query(req.clinicId ? `SELECT COALESCE(SUM(amount),0) as total FROM daily_ledger WHERE entry_type='income' AND clinic_id = $1 AND DATE_TRUNC('month', entry_date) = DATE_TRUNC('month', NOW())` : `SELECT COALESCE(SUM(amount),0) as total FROM daily_ledger WHERE entry_type='income' AND DATE_TRUNC('month', entry_date) = DATE_TRUNC('month', NOW())`, [ ...(req.clinicId ? [req.clinicId] : []) ]),
      pool.query(req.clinicId ? `SELECT (SELECT COALESCE(SUM(fee_charged),0) FROM visits WHERE clinic_id = $1) - (SELECT COALESCE(SUM(amount),0) FROM patient_payments WHERE clinic_id = $1) as total` : `SELECT (SELECT COALESCE(SUM(fee_charged),0) FROM visits) - (SELECT COALESCE(SUM(amount),0) FROM patient_payments) as total`, [ ...(req.clinicId ? [req.clinicId] : []) ]),
      pool.query(req.clinicId ? `SELECT v.*, p.first_name, p.last_name, p.patient_id as pid FROM visits v 
                  JOIN patients p ON v.patient_id = p.id WHERE v.clinic_id = $1 ORDER BY v.created_at DESC LIMIT 5` : `SELECT v.*, p.first_name, p.last_name, p.patient_id as pid FROM visits v 
                  JOIN patients p ON v.patient_id = p.id ORDER BY v.created_at DESC LIMIT 5`, [ ...(req.clinicId ? [req.clinicId] : []) ]),
    ]);
    const weeklyData = await pool.query(req.clinicId ? `
      SELECT TO_CHAR(gs.day, 'Dy') as day, 
             COALESCE(SUM(v.amount_paid),0) as income,
             COUNT(v.id) as visits
      FROM generate_series(NOW()::date - 6, NOW()::date, '1 day'::interval) gs(day)
      LEFT JOIN visits v ON v.visit_date = gs.day::date AND v.clinic_id = $1
      GROUP BY gs.day ORDER BY gs.day
    ` : `
      SELECT TO_CHAR(gs.day, 'Dy') as day, 
             COALESCE(SUM(v.amount_paid),0) as income,
             COUNT(v.id) as visits
      FROM generate_series(NOW()::date - 6, NOW()::date, '1 day'::interval) gs(day)
      LEFT JOIN visits v ON v.visit_date = gs.day::date
      GROUP BY gs.day ORDER BY gs.day
    `, [ ...(req.clinicId ? [req.clinicId] : []) ]);
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
    console.error(JSON.stringify(err, null, 2));
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
      WHERE 1=1
    `;
    const params = [];
    if (req.clinicId) {
      params.push(req.clinicId);
      query += ` AND a.clinic_id = $${params.length}`;
    }
    if (start_date && end_date) {
      params.push(start_date, end_date);
      query += ` AND a.appointment_date BETWEEN $${params.length - 1} AND $${params.length}`;
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
      `INSERT INTO appointments (clinic_id, patient_id, therapist_name, appointment_date, appointment_time, duration_minutes, therapy_type, status, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [req.clinicId || null, patient_id || null, therapist_name || '', normalizedDate, appointment_time, duration_minutes || 15, therapy_type || '', status || 'scheduled', notes || '']
    );
    res.status(201).json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/appointments/:id', async (req, res) => {
  try {
    const { patient_id, therapist_name, appointment_date, appointment_time, duration_minutes, therapy_type, status, notes } = req.body;
    const normalizedDate = normalizeDate(appointment_date);
    const result = await pool.query(
      req.clinicId
        ? `UPDATE appointments SET patient_id=$1, therapist_name=$2, appointment_date=$3, appointment_time=$4, 
              duration_minutes=$5, therapy_type=$6, status=$7, notes=$8, updated_at=NOW()
           WHERE id=$9 AND clinic_id=$10 RETURNING *`
        : `UPDATE appointments SET patient_id=$1, therapist_name=$2, appointment_date=$3, appointment_time=$4, 
              duration_minutes=$5, therapy_type=$6, status=$7, notes=$8, updated_at=NOW()
           WHERE id=$9 RETURNING *`,
      req.clinicId
        ? [patient_id || null, therapist_name || '', normalizedDate, appointment_time, duration_minutes || 15, therapy_type || '', status || 'scheduled', notes || '', req.params.id, req.clinicId]
        : [patient_id || null, therapist_name || '', normalizedDate, appointment_time, duration_minutes || 15, therapy_type || '', status || 'scheduled', notes || '', req.params.id]
    );
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/appointments/:id', async (req, res) => {
  try {
    await pool.query(req.clinicId ? 'DELETE FROM appointments WHERE id=$1 AND clinic_id=$2' : 'DELETE FROM appointments WHERE id=$1', req.clinicId ? [req.params.id, req.clinicId] : [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

const DEFAULT_PORT = Number(process.env.SERVER_PORT || process.env.PORT || 5000);

// CRITICAL: Export the app for Vercel, do not call app.listen() when running on Vercel
const startServer = (port = DEFAULT_PORT) => {
  const server = app.listen(port, () => console.log(`Server running on port ${port}`));

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE' && port === DEFAULT_PORT) {
      const fallbackPort = port + 1;
      console.warn(`Port ${port} is already in use. Trying ${fallbackPort} instead.`);
      server.close(() => startServer(fallbackPort));
    } else if (err.code === 'EADDRINUSE') {
      const nextPort = port + 1;
      console.warn(`Port ${port} is already in use. Trying ${nextPort} instead.`);
      server.close(() => startServer(nextPort));
    } else {
      console.error('Server startup error:', err);
      process.exit(1);
    }
  });

  return server;
};

if (process.env.NODE_ENV !== 'test') {
  startServer();
}

module.exports = app; 
