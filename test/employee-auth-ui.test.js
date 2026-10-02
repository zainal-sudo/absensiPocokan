const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../public/employee-auth.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');

function frontend() {
    const nodes = {};
    const events = {};
    const requests = [];
    const replies = [];
    const timers = new Map();
    let timerId = 0;
    let unlocks = 0;
    let locks = 0;
    const node = id => nodes[id] ||= {
        value: '', type: 'password', attributes: {}, listeners: {}, hidden: false,
        setAttribute(k, v) { this.attributes[k] = v; },
        addEventListener(k, fn) { this.listeners[k] = fn; }
    };
    const window = {};
    vm.runInNewContext(source, {
        window,
        document: { getElementById: node, addEventListener: (event, fn) => { events[event] = fn; } },
        setTimeout(fn, ms) { timers.set(++timerId, { fn, ms }); return timerId; },
        clearTimeout(id) { timers.delete(id); },
        async fetch(url, options) {
            requests.push({ url, options });
            const reply = replies.shift();
            if (reply instanceof Error) throw reply;
            assert(reply, 'Unexpected request: ' + url);
            return { ok: reply.status === 200, status: reply.status, json: async () => reply.data };
        }
    });
    window.EmployeeAuth.init({ apiBase: '', onAuthenticated: () => unlocks++, onLocked: () => locks++ });
    return {
        auth: window.EmployeeAuth, node, events, requests, replies, timers,
        get unlocks() { return unlocks; }, get locks() { return locks; },
        showTab(target = '#tab-karyawan') { events['shown.bs.tab']({ target: { getAttribute: () => target } }); },
        async login(username = 'PETUGAS', password = 'test secret') {
            node('employee-login-username').value = username;
            node('employee-login-password').value = password;
            await node('employee-login-form').listeners.submit({ preventDefault() {} });
        }
    };
}
const flush = () => new Promise(resolve => setImmediate(resolve));
const validUser = { user: { kode: 'PETUGAS', nama: 'Test' }, expiresIn: 1800000 };

test('Karyawan begins locked, Absen does not request login, and tab switch checks session', async () => {
    const h = frontend();
    assert.equal(h.auth.authenticated, false);
    assert.equal(h.node('employee-admin-content').hidden, true);
    h.showTab('#tab-kiosk');
    assert.equal(h.requests.length, 0);
    h.replies.push({ status: 401, data: {} });
    h.showTab();
    await flush();
    assert.equal(h.requests[0].url, '/api/auth/session');
    assert.equal(h.node('employee-login-submit').disabled, false);
    assert.equal(h.unlocks, 0);
});

test('Wrong login stays locked; valid login unlocks content and clears password', async () => {
    const h = frontend();
    h.replies.push({ status: 401, data: { error: 'Username atau password salah.' } });
    await h.login();
    assert.equal(h.auth.authenticated, false);
    assert.equal(h.node('employee-login-password').value, '');
    assert.match(h.node('employee-login-message').textContent, /password salah/);
    h.replies.push({ status: 200, data: validUser });
    await h.login(' PETUGAS ', ' password with spaces ');
    const request = h.requests[1];
    assert.equal(request.options.headers['X-Requested-With'], 'AbsensiWajah');
    assert.deepEqual(JSON.parse(request.options.body), { username: 'PETUGAS', password: ' password with spaces ' });
    assert.equal(h.auth.authenticated, true);
    assert.equal(h.node('employee-admin-content').hidden, false);
    assert.equal(h.node('employee-login-panel').hidden, true);
    assert.equal(h.node('employee-login-password').value, '');
    assert.equal(h.unlocks, 1);
});

test('Eye toggle shows/hides password and expiry locks UI and invokes cleanup', async () => {
    const h = frontend();
    const toggle = h.node('employee-password-toggle');
    toggle.listeners.click();
    assert.equal(h.node('employee-login-password').type, 'text');
    assert.equal(toggle.attributes['aria-pressed'], 'true');
    toggle.listeners.click();
    assert.equal(h.node('employee-login-password').type, 'password');
    h.replies.push({ status: 200, data: validUser });
    await h.login();
    const timer = [...h.timers.values()][0];
    assert.equal(timer.ms, 1800000);
    timer.fn();
    assert.equal(h.auth.authenticated, false);
    assert.equal(h.node('employee-admin-content').hidden, true);
    assert.equal(h.locks, 2);
    assert.match(h.node('employee-login-message').textContent, /berakhir/);
});

test('Valid session restores access without password; logout locks immediately and revokes server session', async () => {
    const h = frontend();
    h.replies.push({ status: 200, data: validUser });
    h.showTab();
    await flush();
    assert.equal(h.auth.authenticated, true);
    h.replies.push({ status: 200, data: {} });
    const pending = h.node('employee-logout').listeners.click();
    assert.equal(h.auth.authenticated, false);
    assert.equal(h.node('employee-admin-content').hidden, true);
    await pending;
    assert.equal(h.requests[1].url, '/api/auth/logout');
    assert.equal(h.node('employee-login-submit').disabled, false);
});

test('Network failures stay locked; failed logout offers server-revocation retry', async () => {
    const h = frontend();
    h.replies.push(new Error('offline'));
    await h.login();
    assert.equal(h.auth.authenticated, false);
    assert.match(h.node('employee-login-message').textContent, /Koneksi gagal/);
    h.replies.push(new Error('offline'));
    await h.node('employee-logout').listeners.click();
    assert.equal(h.node('employee-logout-retry').hidden, false);
    assert.match(h.node('employee-login-message').textContent, /belum berhasil dicabut/);
});

test('Admin markup is hidden by default and no password/session goes to browser storage', () => {
    assert.match(html, /id="employee-admin-content" hidden/);
    assert.match(html, /id="employee-login-password"[^>]*type="password"/);
    assert.doesNotMatch(source, /localStorage|sessionStorage/);
    assert.doesNotMatch(html, /loadKaryawan\(\); \/\/ dropdown/);
});
