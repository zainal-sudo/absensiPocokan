const express = require('express');
const mysql = require('mysql2');
const path = require('path');
const fs = require('fs');
const https = require('https');
const os = require('os');

// Muat .env bila ada (opsional, tanpa wajib install dotenv)
try { require('dotenv').config(); } catch (e) {}

const app = express();
const PORT = process.env.PORT || 3000;
const HTTPS_PORT = process.env.HTTPS_PORT || 3443;

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// MySQL Connection Pool (kredensial via environment, JANGAN hardcode password)
const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASS || process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'db_pocokan',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

pool.getConnection((err, connection) => {
  if (err) {
    console.error('Database connection failed:', err.message);
  } else {
    console.log('Connected to MySQL database db_pocokan.');
    connection.release();
    initAttendanceTable();
    ensureFaceColumns();
  }
});

function ensureFaceColumns() {
  pool.query(`SHOW COLUMNS FROM tkaryawan LIKE 'foto_wajah'`, (err, cols) => {
    if (!err && cols.length === 0) {
      pool.query(`ALTER TABLE tkaryawan ADD COLUMN foto_wajah LONGTEXT`, (e) => {
        if (e) console.error('Error adding foto_wajah:', e.message);
        else console.log('Kolom foto_wajah ditambahkan.');
      });
    }
  });
  pool.query(`SHOW COLUMNS FROM tkaryawan LIKE 'face_descriptor'`, (err, cols) => {
    if (!err && cols.length === 0) {
      pool.query(`ALTER TABLE tkaryawan ADD COLUMN face_descriptor LONGTEXT`, (e) => {
        if (e) console.error('Error adding face_descriptor:', e.message);
        else console.log('Kolom face_descriptor ditambahkan.');
      });
    }
  });
}

function initAttendanceTable() {
  const query = `
    CREATE TABLE IF NOT EXISTS tabsensi_wajah (
      id INT AUTO_INCREMENT PRIMARY KEY,
      karyawan_id VARCHAR(50) NOT NULL,
      tanggal DATE NOT NULL,
      jam_masuk TIME,
      jam_pulang TIME,
      foto_masuk LONGTEXT,
      status ENUM('Hadir', 'Izin', 'Alpha') DEFAULT 'Hadir',
      catatan TEXT
    )
  `;
  pool.query(query, (err) => {
    if (err) console.error('Error creating tabsensi_wajah table:', err.message);
  });
}

// API: Get Pabrik List from tpabrik
app.get('/api/pabrik', (req, res) => {
  pool.query('SELECT pab_kode as id, pab_nama as nama_pabrik, pab_path as lokasi FROM tpabrik', (err, results) => {
    if (err) {
      console.error("Error fetching pabrik:", err.message);
      return res.status(500).json({ error: err.message });
    }
    res.json(results);
  });
});

// API: Get Karyawan List from tkaryawan
app.get('/api/karyawan', (req, res) => {
  const query = `
    SELECT k.kar_kode as id, k.kar_nama as nama, k.kar_bag_kode as posisi,
           p.pab_nama as nama_pabrik,
           CASE WHEN k.foto_wajah IS NOT NULL AND k.foto_wajah != '' THEN 1 ELSE 0 END as has_face
    FROM tkaryawan k
    LEFT JOIN tpabrik p ON k.kar_pab_kode = p.pab_kode
    ORDER BY k.kar_nama ASC
  `;
  pool.query(query, (err, results) => {
    if (err) {
      console.error("Error fetching karyawan:", err.message);
      return res.status(500).json({ error: err.message });
    }
    res.json(results);
  });
});

// API: Face descriptors untuk auto-recognition (ringan, tanpa foto base64)
app.get('/api/karyawan/descriptors', (req, res) => {
  pool.query(
    `SELECT kar_kode as id, kar_nama as nama, face_descriptor FROM tkaryawan WHERE face_descriptor IS NOT NULL AND face_descriptor != ''`,
    (err, results) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(results);
    }
  );
});

// API: Update wajah + descriptor karyawan lama (wajib agar 957 karyawan lama bisa auto-scan)
app.put('/api/karyawan/:id/face', (req, res) => {
  const { foto_wajah, face_descriptor } = req.body;
  const id = req.params.id;
  if (!face_descriptor) return res.status(400).json({ error: 'face_descriptor wajib!' });
  const descStr = typeof face_descriptor === 'string' ? face_descriptor : JSON.stringify(face_descriptor);
  pool.query(
    `UPDATE tkaryawan SET foto_wajah = ?, face_descriptor = ? WHERE kar_kode = ?`,
    [foto_wajah || '', descStr, id],
    (err, result) => {
      if (err) return res.status(500).json({ error: err.message });
      if (result.affectedRows === 0) return res.status(404).json({ error: 'Karyawan tidak ditemukan' });
      res.json({ message: 'Wajah karyawan berhasil didaftarkan!' });
    }
  );
});

// API: Add Karyawan (Register Face & Employee)
app.post('/api/karyawan', (req, res) => {
  const { nama, posisi, upah_harian, pin, pabrik_id, foto_wajah, face_descriptor } = req.body;
  if (!nama) {
    return res.status(400).json({ error: 'Nama karyawan wajib diisi!' });
  }

  // Generate unique code or sequential/numeric if needed
  const kode = 'K' + Date.now().toString().slice(-6);
  const descStr = face_descriptor
    ? (typeof face_descriptor === 'string' ? face_descriptor : JSON.stringify(face_descriptor))
    : '';
  const query = `
    INSERT INTO tkaryawan (kar_kode, kar_nama, kar_bag_kode, kar_gapok, kar_rekening, kar_pab_kode, foto_wajah, face_descriptor)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `;

  pool.query(query, [kode, nama, posisi || '001', 0, pin || '123456', pabrik_id || 'P01', foto_wajah || '', descStr], (err, result) => {
    if (err) {
      console.error("Error inserting karyawan:", err.message);
      return res.status(500).json({ error: err.message });
    }
    res.json({ message: 'Karyawan dan pendaftaran wajah berhasil disimpan!', id: kode });
  });
});

// API: Today Attendance Summary
app.get('/api/absensi/hari-ini', (req, res) => {
  const today = new Date().toISOString().split('T')[0];
  const query = `
    SELECT k.kar_kode as karyawan_id, k.kar_nama as nama, k.kar_bag_kode as posisi, k.kar_gapok as upah_harian, p.pab_nama as nama_pabrik,
           a.id as absensi_id, a.jam_masuk, a.jam_pulang, a.catatan
    FROM tkaryawan k
    LEFT JOIN tpabrik p ON k.kar_pab_kode = p.pab_kode
    LEFT JOIN tabsensi_wajah a ON k.kar_kode = a.karyawan_id AND a.tanggal = ?
    ORDER BY k.kar_nama ASC
  `;
  pool.query(query, [today], (err, results) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ tanggal: today, data: results });
  });
});

// API: Submit Absen (Face Verification Match)
app.post('/api/absensi', (req, res) => {
  const { karyawan_id, aksi, foto, catatan } = req.body;
  const today = new Date().toISOString().split('T')[0];
  const timeNow = new Date().toTimeString().split(' ')[0];

  if (!karyawan_id) {
    return res.status(400).json({ error: 'Pilih karyawan terlebih dahulu!' });
  }

  if (!foto) {
    return res.status(400).json({ error: 'Foto wajah wajib diambil untuk verifikasi!' });
  }

  pool.query('SELECT kar_nama FROM tkaryawan WHERE kar_kode = ?', [karyawan_id], (err, results) => {
    if (err) return res.status(500).json({ error: err.message });
    if (results.length === 0) return res.status(404).json({ error: 'Karyawan tidak ditemukan' });

    const karyawan = results[0];
    
    // Check attendance status for today
    pool.query('SELECT id FROM tabsensi_wajah WHERE karyawan_id = ? AND tanggal = ?', [karyawan_id, today], (err, attResults) => {
      if (err) return res.status(500).json({ error: err.message });

      if (aksi === 'masuk') {
        if (attResults.length > 0) {
          return res.status(400).json({ error: 'Karyawan sudah melakukan absen masuk hari ini!' });
        }
        const insertQuery = 'INSERT INTO tabsensi_wajah (karyawan_id, tanggal, jam_masuk, foto_masuk, catatan) VALUES (?, ?, ?, ?, ?)';
        pool.query(insertQuery, [karyawan_id, today, timeNow, foto, catatan || 'Verifikasi Wajah'], (err) => {
          if (err) return res.status(500).json({ error: err.message });
          res.json({ message: `Absen Masuk Berhasil, Halo ${karyawan.kar_nama}!` });
        });
      } else if (aksi === 'pulang') {
        if (attResults.length === 0) {
          return res.status(400).json({ error: 'Karyawan belum melakukan absen masuk!' });
        }
        const updateQuery = 'UPDATE tabsensi_wajah SET jam_pulang = ?, catatan = CONCAT(IFNULL(catatan,""), " | ", ?) WHERE id = ?';
        pool.query(updateQuery, [timeNow, catatan || 'Pulang', attResults[0].id], (err) => {
          if (err) return res.status(500).json({ error: err.message });
          res.json({ message: `Absen Pulang Berhasil, ${karyawan.kar_nama}!` });
        });
      } else {
        res.status(400).json({ error: 'Aksi tidak valid' });
      }
    });
  });
});

// API: Report History
app.get('/api/absensi/laporan', (req, res) => {
  const query = `
    SELECT a.tanggal, k.kar_nama as nama, k.kar_bag_kode as posisi, p.pab_nama as nama_pabrik, a.jam_masuk, a.jam_pulang, a.catatan
    FROM tabsensi_wajah a
    JOIN tkaryawan k ON a.karyawan_id = k.kar_kode
    LEFT JOIN tpabrik p ON k.kar_pab_kode = p.pab_kode
    ORDER BY a.tanggal DESC, k.kar_nama ASC
  `;
  pool.query(query, (err, results) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(results);
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server Absensi HTTP jalan di http://localhost:${PORT}`);
  startHttps();
});

function getLanIps() {
  const nets = os.networkInterfaces();
  const ips = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) {
        ips.push(net.address);
      }
    }
  }
  return ips;
}

async function startHttps() {
  try {
    const keyPath = path.join(__dirname, 'key.pem');
    const certPath = path.join(__dirname, 'cert.pem');
    const ipsPath = path.join(__dirname, 'cert-ips.txt');
    const lanIps = getLanIps();
    let savedIps = '';
    try { savedIps = fs.existsSync(ipsPath) ? fs.readFileSync(ipsPath, 'utf8') : ''; } catch (e) {}
    const needRegen = !fs.existsSync(keyPath) || !fs.existsSync(certPath) ||
      lanIps.some(ip => !savedIps.includes(ip));
    if (needRegen) {
      console.log('Membuat sertifikat HTTPS self-signed...');
      const selfsigned = require('selfsigned');
      const attrs = [{ name: 'commonName', value: 'absensi-pocokan' }];
      const altNames = [
        { type: 2, value: 'localhost' },
        { type: 7, ip: '127.0.0.1' },
        ...lanIps.map(ip => ({ type: 7, ip }))
      ];
      const opts = {
        days: 825,
        keySize: 2048,
        extensions: [{ name: 'subjectAltName', altNames }]
      };
      const pems = await selfsigned.generate(attrs, opts);
      fs.writeFileSync(keyPath, pems.private);
      fs.writeFileSync(certPath, pems.cert);
      fs.writeFileSync(ipsPath, lanIps.join(','));
      console.log('Sertifikat dibuat: key.pem & cert.pem (IP: ' + lanIps.join(', ') + ')');
    }
    const options = { key: fs.readFileSync(path.join(__dirname, 'key.pem')), cert: fs.readFileSync(path.join(__dirname, 'cert.pem')) };
    https.createServer(options, app).listen(HTTPS_PORT, '0.0.0.0', () => {
      console.log(`Server Absensi HTTPS jalan di port ${HTTPS_PORT}. Buka dari HP:`);
      getLanIps().forEach(ip => console.log(`  https://${ip}:${HTTPS_PORT} (abaikan peringatan sertifikat / Advanced > Proceed)`));
      console.log(`HTTP (tanpa kamera HP): http://<IP-LAN>:${PORT}`);
    });
  } catch (e) {
    console.error('HTTPS gagal start:', e.message);
  }
}
