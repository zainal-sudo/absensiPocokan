const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const { getJakartaDateTime } = require('../public/jakarta-time');

const root = path.join(__dirname, '..');
const serverSource = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
const helperSource = fs.readFileSync(path.join(root, 'public/jakarta-time.js'), 'utf8');
const clockSource = html.slice(html.indexOf('    let clockTanggalWIB'), html.indexOf('    function startCamera()'));

for (const [instant, tanggal, jam] of [
    ['2026-09-30T16:59:59Z', '2026-09-30', '23:59:59'],
    ['2026-09-30T17:00:00Z', '2026-10-01', '00:00:00'],
    ['2026-09-30T23:30:00Z', '2026-10-01', '06:30:00'],
    ['2026-10-01T00:00:00Z', '2026-10-01', '07:00:00']
]) {
    test(`Boundary ${instant}`, () => {
        assert.deepEqual(getJakartaDateTime(new Date(instant)), { tanggal, jam });
    });
}

// Jalankan handler server ASLI, tanpa server HTTP, sertifikat, atau koneksi DB nyata.
function harness(instant) {
    const routes = {};
    const rows = [];
    const queries = [];
    let dateCalls = 0;
    let current = instant;
    class MockDate extends Date {
        constructor(...args) {
            if (!args.length) { super(current); dateCalls++; }
            else super(...args);
        }
    }
    const pool = {
        getConnection() {},
        query(sql, params, callback) {
            if (typeof params === 'function') { callback = params; params = []; }
            queries.push({ sql, params });
            if (sql.startsWith('SELECT kar_nama')) callback(null, [{ kar_nama: 'Test' }]);
            else if (sql.startsWith('SELECT id FROM tabsensi_wajah')) {
                callback(null, rows.filter(r => r.karyawan_id === params[0] && r.tanggal === params[1]));
            } else if (sql.startsWith('INSERT INTO tabsensi_wajah')) {
                rows.push({ id: rows.length + 1, tanggal: params[0], jam_masuk: params[1], karyawan_id: params[4] });
                callback(null, { affectedRows: 1 });
            } else if (sql.startsWith('UPDATE tabsensi_wajah')) {
                rows.find(r => r.id === params[2]).jam_pulang = params[0];
                callback(null, { affectedRows: 1 });
            } else callback(null, rows);
        }
    };
    const app = {
        use() {}, listen() {},
        get(url, fn) { routes[`GET ${url}`] = fn; },
        post(url, fn) { routes[`POST ${url}`] = fn; }, put() {}
    };
    const express = Object.assign(() => app, { json() {}, urlencoded() {}, static() {} });
    const context = vm.createContext({
        Date: MockDate, console, process: { env: {} }, __dirname: root,
        require(name) {
            if (name === 'express') return express;
            if (name === 'mysql2') return { createPool: () => pool };
            if (name === 'dotenv') return { config() {} };
            if (name === './public/jakarta-time') {
                return { getJakartaDateTime: () => getJakartaDateTime(new MockDate()) };
            }
            return require(name);
        }
    });
    vm.runInContext(serverSource, context);
    return {
        rows, queries, setTime(value) { current = value; },
        get dateCalls() { return dateCalls; },
        request(method, url, body = {}) {
            let data;
            let status = 200;
            const res = { status(value) { status = value; return this; }, json(value) { data = value; } };
            routes[`${method} ${url}`]({ body }, res);
            return { status, data };
        }
    };
}

test('MASUK 00:05 WIB stores calendar date; one instant per request; Pocokan date filter compatible', () => {
    const h = harness('2026-09-30T17:05:12Z');
    assert.equal(h.request('POST', '/api/absensi', { karyawan_id: 'K1', aksi: 'masuk', foto: 'test' }).status, 200);
    assert.equal(h.rows[0].tanggal, '2026-10-01');
    assert.equal(h.rows[0].jam_masuk, '00:05:12');
    assert.equal(h.dateCalls, 1);
    // Contract Tarik Absensi: WHERE tanggal = '2026-10-01' menemukan row.
    assert.equal(h.rows.filter(r => r.tanggal === '2026-10-01').length, 1);
    assert.equal(h.rows.filter(r => r.tanggal === '2026-09-30').length, 0);
});

test('MASUK 08:00 + PULANG 17:00 update same WIB date', () => {
    const h = harness('2026-10-01T01:00:00Z');
    const body = { karyawan_id: 'K1', foto: 'test' };
    h.request('POST', '/api/absensi', { ...body, aksi: 'masuk' });
    h.setTime('2026-10-01T10:00:00Z');
    assert.equal(h.request('POST', '/api/absensi', { ...body, aksi: 'pulang' }).status, 200);
    assert.deepEqual(h.rows[0], { id: 1, karyawan_id: 'K1', tanggal: '2026-10-01', jam_masuk: '08:00:00', jam_pulang: '17:00:00' });
    assert.equal(h.dateCalls, 2);
});

test('PULANG after WIB midnight never updates yesterday (existing rule)', () => {
    const h = harness('2026-09-30T16:59:59Z');
    const body = { karyawan_id: 'K1', foto: 'test' };
    h.request('POST', '/api/absensi', { ...body, aksi: 'masuk' });
    h.setTime('2026-09-30T17:00:00Z');
    assert.equal(h.request('POST', '/api/absensi', { ...body, aksi: 'pulang' }).status, 400);
    assert.equal(h.rows[0].jam_pulang, undefined);
});

test('GET hari-ini 00:30 WIB queries new date', () => {
    const h = harness('2026-09-30T17:30:00Z');
    const res = h.request('GET', '/api/absensi/hari-ini');
    assert.equal(res.data.tanggal, '2026-10-01');
    assert.equal(h.queries[0].params[0], '2026-10-01');
});

test('Laporan uses endpoint-only DATE_FORMAT, JSON preserves calendar string', () => {
    const h = harness('2026-09-30T17:30:00Z');
    h.rows.push({ tanggal: '2026-10-01' });
    const res = h.request('GET', '/api/absensi/laporan');
    assert.match(h.queries[0].sql, /DATE_FORMAT\(a\.tanggal, '%Y-%m-%d'\) as tanggal/);
    assert.equal(JSON.parse(JSON.stringify(res.data))[0].tanggal, '2026-10-01');
    assert.doesNotMatch(serverSource, /dateStrings\s*:/);
});

test('Late yesterday response cannot overwrite today after midnight', async () => {
    const loadSource = html.slice(html.indexOf('    function loadHariIni()'), html.indexOf('    function renderHariIni(rows)'));
    let renders = 0;
    const context = vm.createContext({
        API_BASE: '', console,
        JakartaTime: { getJakartaDateTime: () => ({ tanggal: '2026-10-01' }) },
        fetch: async () => ({ ok: true, json: async () => ({ tanggal: '2026-09-30', data: [] }) }),
        renderHariIni: () => renders++, document: { getElementById: () => null }
    });
    vm.runInContext(loadSource, context);
    assert.equal(await vm.runInContext('loadHariIni()', context), false);
    assert.equal(renders, 0);
});

for (const tz of ['UTC', 'Asia/Jakarta', 'America/New_York']) {
    test(`Backend + browser clock and midnight refresh independent of TZ=${tz}`, () => {
        const script = `
            const assert = require('node:assert/strict');
            const vm = require('node:vm');
            const helper = require(${JSON.stringify(path.join(root, 'public/jakarta-time.js'))});
            assert.deepEqual(helper.getJakartaDateTime(new Date('2026-09-30T17:00:00Z')), {tanggal:'2026-10-01',jam:'00:00:00'});
            let instant = '2026-09-30T16:59:59Z';
            class MockDate extends Date { constructor() { super(instant); } }
            const elements = {'current-time': {}, 'today-date-str': {}};
            let refreshes = 0;
            const context = vm.createContext({Date:MockDate, Intl, document:{getElementById:id=>elements[id]}, loadHariIni:()=>refreshes++});
            vm.runInContext(${JSON.stringify(helperSource + '\n' + clockSource)}, context);
            vm.runInContext('tickClock()', context);
            assert.equal(elements['current-time'].innerText, '23:59:59');
            assert.equal(refreshes, 0);
            instant = '2026-09-30T17:00:00Z';
            vm.runInContext('tickClock(); tickClock(); tickClock()', context);
            assert.equal(elements['current-time'].innerText, '00:00:00');
            assert.match(elements['today-date-str'].innerText, /1 Oktober 2026/);
            assert.equal(refreshes, 1);
            instant = '2026-09-30T17:05:00Z';
            vm.runInContext('tickClock()', context);
            assert.equal(refreshes, 1);
        `;
        const result = spawnSync(process.execPath, ['-e', script], { env: { ...process.env, TZ: tz }, encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr);
    });
}
