const crypto = require('node:crypto');

// Sesi sementara di memory: restart server mengharuskan login ulang, tanpa tabel baru.
module.exports = function createEmployeeAuth(pool, { now = Date.now } = {}) {
  const COOKIE = 'pocokan_employee_session';
  const IDLE_MS = 30 * 60 * 1000;
  const MAX_MS = 8 * 60 * 60 * 1000;
  const WINDOW_MS = 15 * 60 * 1000;
  const sessions = new Map();
  const attempts = new Map();
  const digest = value => crypto.createHash('sha256').update(value).digest();

  function cleanup() {
    const time = now();
    for (const [key, session] of sessions) {
      if (time >= session.expires || time >= session.last + IDLE_MS) sessions.delete(key);
    }
    for (const [key, entry] of attempts) {
      if (time >= entry.until) attempts.delete(key);
    }
  }

  function sessionKey(req) {
    const cookie = (req.headers.cookie || '').split(';').map(part => part.trim()).find(part => part.startsWith(COOKIE + '='));
    const token = cookie ? cookie.slice(COOKIE.length + 1) : '';
    return /^[a-f0-9]{64}$/.test(token) ? digest(token).toString('hex') : null;
  }

  function readSession(req) {
    cleanup();
    const session = sessions.get(sessionKey(req));
    if (session) session.last = now();
    return session;
  }

  function cookieOptions(req) {
    return { httpOnly: true, sameSite: 'strict', secure: req.secure, path: '/api', maxAge: MAX_MS };
  }

  function remaining(session) {
    return Math.min(IDLE_MS, session.expires - now());
  }

  function requireSameOrigin(req, res, next) {
    // Header khusus tidak bisa dikirim form lintas situs; Origin menolak fetch lintas situs.
    const origin = req.get('origin');
    if (req.get('x-requested-with') !== 'AbsensiWajah' ||
        (origin && origin !== `${req.protocol}://${req.get('host')}`)) {
      return res.status(403).json({ error: 'Permintaan login/pendaftaran tidak diizinkan.' });
    }
    next();
  }

  function requireLogin(req, res, next) {
    res.set('Cache-Control', 'no-store');
    const session = readSession(req);
    if (!session) return res.status(401).json({ error: 'Silakan login untuk mengakses menu Karyawan.' });
    if (!['GET', 'HEAD'].includes(req.method)) {
      return requireSameOrigin(req, res, () => {
        res.set('X-Employee-Session-Expires-In', String(remaining(session)));
        req.employeeUser = session.user;
        next();
      });
    }
    res.set('X-Employee-Session-Expires-In', String(remaining(session)));
    req.employeeUser = session.user;
    next();
  }

  function registerRoutes(app) {
    app.post('/api/auth/login', requireSameOrigin, (req, res) => {
      res.set('Cache-Control', 'no-store');
      cleanup();
      const ip = req.ip;
      const entry = attempts.get(ip) || { count: 0, until: now() + WINDOW_MS };
      if (entry.count >= 10 || (!attempts.has(ip) && attempts.size >= 10000)) {
        res.set('Retry-After', String(Math.max(1, Math.ceil((entry.until - now()) / 1000))));
        return res.status(429).json({ error: 'Terlalu banyak percobaan login. Coba lagi setelah 15 menit.' });
      }
      entry.count++;
      attempts.set(ip, entry);
      const { username, password } = req.body || {};
      if (typeof username !== 'string' || !username.trim() || username.length > 128 ||
          typeof password !== 'string' || !password || password.length > 1024) {
        return res.status(400).json({ error: 'Isi username dan password dengan benar.' });
      }
      // Kompatibilitas tuser lama: password teks biasa dibandingkan hanya di backend.
      pool.query('SELECT USER_KODE, USER_NAMA, USER_PASSWORD FROM tuser WHERE USER_KODE = ? LIMIT 1', [username.trim()], (err, rows) => {
        if (err) return res.status(503).json({ error: 'Login belum dapat diproses. Silakan coba lagi.' });
        const user = rows[0];
        const expected = user && typeof user.USER_PASSWORD === 'string' ? user.USER_PASSWORD : '';
        const matches = crypto.timingSafeEqual(digest(password), digest(expected));
        if (!user || !expected || !matches) return res.status(401).json({ error: 'Username atau password salah.' });
        cleanup();
        if (sessions.size >= 1000) return res.status(503).json({ error: 'Sesi penuh. Silakan coba lagi nanti.' });
        sessions.delete(sessionKey(req));
        const token = crypto.randomBytes(32).toString('hex');
        const session = {
          user: { kode: String(user.USER_KODE), nama: String(user.USER_NAMA || user.USER_KODE) },
          last: now(), expires: now() + MAX_MS
        };
        sessions.set(digest(token).toString('hex'), session);
        attempts.delete(ip);
        res.cookie(COOKIE, token, cookieOptions(req));
        res.json({ user: session.user, expiresIn: remaining(session) });
      });
    });
    app.get('/api/auth/session', (req, res) => {
      res.set('Cache-Control', 'no-store');
      const session = readSession(req);
      if (!session) return res.status(401).json({ error: 'Silakan login untuk mengakses menu Karyawan.' });
      res.json({ user: session.user, expiresIn: remaining(session) });
    });
    app.post('/api/auth/logout', requireSameOrigin, (req, res) => {
      res.set('Cache-Control', 'no-store');
      sessions.delete(sessionKey(req));
      const { maxAge, ...clearOptions } = cookieOptions(req);
      res.clearCookie(COOKIE, clearOptions);
      res.json({ message: 'Berhasil keluar.' });
    });
  }

  return { registerRoutes, requireLogin };
};
