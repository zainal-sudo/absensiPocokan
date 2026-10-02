(function () {
    let options;
    let authenticated = false;
    let version = 0;
    let timer;
    let loginBusy = false;
    let logoutBusy = false;
    const node = id => document.getElementById(id);

    function message(text) {
        node('employee-login-message').textContent = text;
    }

    function lock(text = '') {
        version++;
        authenticated = false;
        clearTimeout(timer);
        node('employee-admin-content').hidden = true;
        node('employee-login-panel').hidden = false;
        node('employee-login-password').value = '';
        node('employee-login-password').type = 'password';
        node('employee-password-toggle').setAttribute('aria-pressed', 'false');
        node('employee-password-toggle').setAttribute('aria-label', 'Tampilkan password');
        node('employee-login-submit').disabled = false;
        message(text);
        options.onLocked();
    }

    function scheduleExpiry(milliseconds) {
        clearTimeout(timer);
        if (Number.isFinite(milliseconds) && milliseconds > 0) {
            timer = setTimeout(() => lock('Sesi login berakhir. Silakan masuk kembali.'), milliseconds);
        }
    }

    function unlock(data) {
        authenticated = true;
        node('employee-login-password').value = '';
        node('employee-login-panel').hidden = true;
        node('employee-admin-content').hidden = false;
        node('employee-auth-user').textContent = 'Masuk sebagai ' + data.user.kode;
        message('');
        scheduleExpiry(data.expiresIn);
        options.onAuthenticated();
    }

    async function check() {
        if (logoutBusy || loginBusy) return;
        const current = ++version;
        node('employee-admin-content').hidden = true;
        node('employee-login-panel').hidden = false;
        node('employee-login-submit').disabled = true;
        message('Memeriksa sesi login…');
        try {
            const res = await fetch(options.apiBase + '/api/auth/session', { credentials: 'same-origin', cache: 'no-store' });
            const data = await res.json();
            if (current !== version) return;
            if (!res.ok) { lock(res.status === 401 ? '' : 'Sesi belum dapat diperiksa. Silakan coba login.'); return; }
            unlock(data);
        } catch (error) {
            if (current === version) lock('Koneksi gagal. Silakan coba login kembali.');
        } finally {
            if (current === version) node('employee-login-submit').disabled = false;
        }
    }

    async function login(event) {
        event.preventDefault();
        if (loginBusy || logoutBusy) return;
        loginBusy = true;
        const current = ++version;
        node('employee-login-submit').disabled = true;
        message('Memeriksa username dan password…');
        const password = node('employee-login-password').value;
        try {
            const res = await fetch(options.apiBase + '/api/auth/login', {
                method: 'POST', credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'AbsensiWajah' },
                body: JSON.stringify({ username: node('employee-login-username').value.trim(), password })
            });
            const data = await res.json();
            if (current !== version) return;
            if (!res.ok) { message(data.error || 'Login gagal. Silakan coba lagi.'); return; }
            unlock(data);
        } catch (error) {
            if (current === version) message('Koneksi gagal. Silakan coba lagi.');
        } finally {
            loginBusy = false;
            node('employee-login-password').value = '';
            node('employee-login-submit').disabled = false;
        }
    }

    async function logout() {
        if (logoutBusy) return;
        logoutBusy = true;
        // Kunci UI segera, namun tetap pastikan sesi server dicabut.
        lock('Sedang keluar…');
        node('employee-login-submit').disabled = true;
        try {
            const res = await fetch(options.apiBase + '/api/auth/logout', {
                method: 'POST', credentials: 'same-origin',
                headers: { 'X-Requested-With': 'AbsensiWajah' }
            });
            if (!res.ok) throw new Error('Logout gagal');
            message('Berhasil keluar.');
        } catch (error) {
            message('Menu dikunci, tetapi sesi server belum berhasil dicabut. Periksa koneksi lalu coba Keluar lagi.');
            node('employee-logout-retry').hidden = false;
        } finally {
            logoutBusy = false;
            node('employee-login-submit').disabled = false;
        }
    }

    window.EmployeeAuth = {
        get authenticated() { return authenticated; },
        lock,
        refreshExpiry(res) {
            const value = res.headers && res.headers.get('X-Employee-Session-Expires-In');
            if (authenticated && value) scheduleExpiry(Number(value));
        },
        init(config) {
            options = config;
            node('employee-login-form').addEventListener('submit', login);
            node('employee-logout').addEventListener('click', logout);
            node('employee-logout-retry').addEventListener('click', logout);
            node('employee-password-toggle').addEventListener('click', () => {
                const show = node('employee-login-password').type === 'password';
                node('employee-login-password').type = show ? 'text' : 'password';
                node('employee-password-toggle').setAttribute('aria-pressed', String(show));
                node('employee-password-toggle').setAttribute('aria-label', show ? 'Sembunyikan password' : 'Tampilkan password');
            });
            document.addEventListener('shown.bs.tab', event => {
                if (event.target.getAttribute('data-bs-target') === '#tab-karyawan') check();
            });
            lock();
        }
    };
})();
