const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const http = require('node:http');
const express = require('express');
const createEmployeeAuth = require('../lib/employee-auth');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'server.js'), 'utf8');

// Serve the real server routes with a fake DB: tests never read/write production data.
async function backend(t, { secure = false, dbError = false } = {}) {
    let time = 0;
    let app;
    const queries = [];
    const pool = {
        getConnection() {},
        query(sql, params, cb) {
            if (typeof params === 'function') { cb = params; params = []; }
            queries.push({ sql, params });
            if (sql.includes('FROM tuser')) {
                if (dbError) return cb(new Error('private database detail'));
                return cb(null, params[0] === 'PETUGAS' ? [{ USER_KODE: 'PETUGAS', USER_NAMA: 'Test User', USER_PASSWORD: 'test secret' }] : []);
            }
            if (sql.startsWith('UPDATE tkaryawan')) return cb(null, { affectedRows: 1 });
            cb(null, []);
        }
    };
    const factory = Object.assign(() => {
        app = express();
        if (secure) app.use((req, res, next) => { Object.defineProperty(req, 'protocol', { value: 'https' }); next(); });
        app.listen = () => {}; // Never bind the normal app ports or generate certificates.
        return app;
    }, { json: express.json, urlencoded: express.urlencoded, static: express.static });
    vm.runInNewContext(source, {
        console, process: { env: {} }, __dirname: root,
        require(name) {
            if (name === 'express') return factory;
            if (name === 'mysql2') return { createPool: () => pool };
            if (name === 'dotenv') return { config() {} };
            if (name === './lib/employee-auth') return p => createEmployeeAuth(p, { now: () => time });
            return require(name.startsWith('./') ? path.join(root, name) : name);
        }
    });
    const server = http.createServer(app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
    const base = `http://127.0.0.1:${server.address().port}`;
    return {
        queries, advance(ms) { time += ms; },
        async request(url, { method = 'GET', body, cookie, origin, header = true } = {}) {
            const headers = {};
            if (header) headers['X-Requested-With'] = 'AbsensiWajah';
            if (cookie) headers.Cookie = cookie;
            if (origin) headers.Origin = origin;
            if (body) headers['Content-Type'] = 'application/json';
            const res = await fetch(base + url, { method, headers, body: body ? JSON.stringify(body) : undefined });
            return { status: res.status, headers: res.headers, data: await res.json() };
        },
        async login(password = 'test secret', username = 'PETUGAS', cookie) {
            return this.request('/api/auth/login', { method: 'POST', body: { username, password }, cookie });
        }
    };
}
const cookieFrom = response => response.headers.get('set-cookie').split(';')[0];

test('Karyawan list and direct face PUT require server login; kiosk endpoints remain public', async t => {
    const h = await backend(t);
    assert.equal((await h.request('/api/karyawan')).status, 401);
    assert.equal((await h.request('/api/karyawan/K1/face', { method: 'PUT', body: { foto_wajah: 'photo', face_descriptor: [1] } })).status, 401);
    assert.equal(h.queries.length, 0);
    assert.equal((await h.request('/api/karyawan/descriptors')).status, 200);
    assert.equal((await h.request('/api/absensi/hari-ini')).status, 200);
    assert.equal((await h.request('/api/auth/session', { cookie: 'pocokan_employee_session=' + 'a'.repeat(64) })).status, 401);
});

test('USER_KODE + exact plain password issue HttpOnly session, protect face save, and logout revokes it', async t => {
    const h = await backend(t, { secure: true });
    const login = await h.login();
    assert.equal(login.status, 200);
    assert.equal(login.data.user.kode, 'PETUGAS');
    assert.equal(login.data.expiresIn, 30 * 60 * 1000);
    assert.doesNotMatch(JSON.stringify(login.data), /test secret|USER_PASSWORD/);
    const setCookie = login.headers.get('set-cookie');
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /Secure/);
    assert.match(setCookie, /SameSite=Strict/);
    const cookie = cookieFrom(login);
    assert.equal((await h.request('/api/karyawan', { cookie })).status, 200);
    assert.equal((await h.request('/api/karyawan/K1/face', { method: 'PUT', cookie, body: { foto_wajah: 'photo', face_descriptor: [1] } })).status, 200);
    assert.equal((await h.request('/api/auth/logout', { method: 'POST', cookie })).status, 200);
    assert.equal((await h.request('/api/auth/session', { cookie })).status, 401);
    assert.equal((await h.request('/api/karyawan', { cookie })).status, 401);
});

test('Wrong user/password are generic, preserve spaces and use a parameterized query', async t => {
    const h = await backend(t);
    const badPassword = await h.login(' test secret');
    const missing = await h.login('test secret', 'missing');
    const injection = await h.login('test secret', "' OR 1=1 --");
    assert.equal(badPassword.status, 401);
    assert.deepEqual(badPassword.data, missing.data);
    assert.equal(injection.status, 401);
    assert.equal(injection.headers.get('set-cookie'), null);
    assert.equal(h.queries[2].sql, 'SELECT USER_KODE, USER_NAMA, USER_PASSWORD FROM tuser WHERE USER_KODE = ? LIMIT 1');
    assert.equal(h.queries[2].params[0], "' OR 1=1 --");
    assert.equal((await h.login('test secret', ' PETUGAS ')).status, 200);
});

test('Login attempts limited to ten per 15 minutes', async t => {
    const h = await backend(t);
    for (let i = 0; i < 10; i++) assert.equal((await h.login('wrong')).status, 401);
    const blocked = await h.login();
    assert.equal(blocked.status, 429);
    assert.equal(h.queries.length, 10);
    assert(blocked.headers.get('retry-after'));
    h.advance(15 * 60 * 1000);
    assert.equal((await h.login()).status, 200);
});

test('30-minute inactivity and eight-hour absolute expiry are enforced server-side', async t => {
    const h = await backend(t);
    const cookie = cookieFrom(await h.login());
    h.advance(30 * 60 * 1000);
    assert.equal((await h.request('/api/karyawan', { cookie })).status, 401);
    const activeCookie = cookieFrom(await h.login());
    for (let i = 0; i < 16; i++) {
        h.advance(29 * 60 * 1000);
        assert.equal((await h.request('/api/auth/session', { cookie: activeCookie })).status, 200);
    }
    h.advance(16 * 60 * 1000); // Eight hours total, though last activity was 16 minutes ago.
    assert.equal((await h.request('/api/karyawan', { cookie: activeCookie })).status, 401);
});

test('Login rotates sessions and rejects cross-origin/headerless state-changing requests', async t => {
    const h = await backend(t);
    const body = { username: 'PETUGAS', password: 'test secret' };
    assert.equal((await h.request('/api/auth/login', { method: 'POST', body, origin: 'https://evil.example' })).status, 403);
    assert.equal((await h.request('/api/auth/login', { method: 'POST', body, header: false })).status, 403);
    const cookie = cookieFrom(await h.login());
    assert.equal((await h.request('/api/karyawan/K1/face', { method: 'PUT', body: { foto_wajah: 'photo', face_descriptor: [1] }, cookie, header: false })).status, 403);
    assert.equal((await h.request('/api/auth/logout', { method: 'POST', cookie, origin: 'https://evil.example' })).status, 403);
    const secondCookie = cookieFrom(await h.login('test secret', 'PETUGAS', cookie));
    assert.notEqual(secondCookie, cookie);
    assert.equal((await h.request('/api/auth/session', { cookie })).status, 401);
    assert.equal((await h.request('/api/auth/session', { cookie: secondCookie })).status, 200);
});

test('DB failure is handled without exposing internals or issuing a session', async t => {
    const h = await backend(t, { dbError: true });
    const res = await h.login();
    assert.equal(res.status, 503);
    assert.doesNotMatch(JSON.stringify(res.data), /private database/);
    assert.equal(res.headers.get('set-cookie'), null);
});
