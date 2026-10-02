const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
const functionSource = name => html.match(new RegExp(`    (?:async )?function ${name}\\([^\\n]*\\) \\{[\\s\\S]*?\\n    \\}`))[0];

function backend() {
    const routes = {};
    const queries = [];
    const employees = [{ kar_kode: 'K1', kar_isaktif: 1, foto_wajah: 'old-photo', face_descriptor: '[0,0]' }];
    const history = [{ karyawan_id: 'K1', foto_masuk: 'historical-photo', tanggal: '2026-10-01' }];
    const app = { get(url, handler) { routes[url] = handler; }, put(url, handler) { routes[url] = handler; } };
    const pool = { query(sql, params, cb) {
        queries.push({ sql, params });
        assert.match(sql, /^UPDATE tkaryawan SET foto_wajah = \?, face_descriptor = \? WHERE kar_kode = \? AND kar_isaktif = 1$/);
        const row = employees.find(k => k.kar_kode === params[2] && k.kar_isaktif === 1);
        if (row) { row.foto_wajah = params[0]; row.face_descriptor = params[1]; }
        cb(null, { affectedRows: row ? 1 : 0 });
    } };
    vm.runInNewContext(server.slice(server.indexOf("app.put('/api/karyawan/:id/face'"), server.indexOf('// Route lama')), { app, pool });
    return { employees, history, queries, save(body, id = 'K1') {
        let status = 200, data;
        routes['/api/karyawan/:id/face']({ body, params: { id } }, {
            status(value) { status = value; return this; }, json(value) { data = value; }
        });
        return { status, data };
    } };
}

test('Registration indicator requires both photo and descriptor, and descriptor list requires both too', () => {
    assert.match(server, /CASE WHEN k\.foto_wajah IS NOT NULL AND TRIM\(k\.foto_wajah\) != ''\s+AND k\.face_descriptor IS NOT NULL AND TRIM\(k\.face_descriptor\) != '' THEN 1 ELSE 0 END as has_face/);
    assert.match(server, /WHERE kar_isaktif = 1 AND foto_wajah IS NOT NULL AND TRIM\(foto_wajah\) != '' AND face_descriptor IS NOT NULL AND TRIM\(face_descriptor\) != ''/);
});

for (const [description, has_face, expected] of [
    ['not registered', 0, false], ['registered', 1, true],
    ['photo only (descriptor empty)', 0, false], ['descriptor only (photo empty)', 0, false]
]) {
    test(`${description}: CTA and hint follow endpoint registration status`, () => {
        const nodes = { 'k-existing': { value: 'K1' }, 'reg-save-label': {}, 'reg-existing-face-hint': {} };
        const context = vm.createContext({ document: { getElementById: id => nodes[id] }, karyawanCache: [{ id: 'K1', has_face }] });
        vm.runInContext(functionSource('syncRegRegistrationStatus') + '\nsyncRegRegistrationStatus();', context);
        assert.equal(nodes['reg-save-label'].textContent, expected ? 'Daftarkan Ulang Wajah' : 'Daftarkan Wajah');
        assert.equal(nodes['reg-existing-face-hint'].hidden, !expected);
    });
}

test('Re-registration overwrites the existing row together and leaves attendance history untouched', () => {
    const h = backend();
    const before = JSON.stringify(h.history);
    assert.equal(h.save({ foto_wajah: 'new-photo', face_descriptor: [1, 2] }).status, 200);
    assert.equal(h.employees.length, 1);
    assert.equal(h.employees[0].foto_wajah, 'new-photo');
    assert.equal(h.employees[0].face_descriptor, '[1,2]');
    assert.equal(h.queries.length, 1);
    assert.equal(JSON.stringify(h.history), before);
    assert(h.queries.every(q => !/INSERT|DELETE|tabsensi_wajah/i.test(q.sql)));
});

test('Inactive and missing employees cannot re-register', () => {
    const h = backend();
    h.employees[0].kar_isaktif = 0;
    const before = JSON.stringify(h.employees);
    assert.equal(h.save({ foto_wajah: 'new', face_descriptor: [1, 2] }).status, 404);
    assert.equal(h.save({ foto_wajah: 'new', face_descriptor: [1, 2] }, 'missing').status, 404);
    assert.equal(JSON.stringify(h.employees), before);
});

test('Manual requests cannot save a descriptor without a photo or a photo without a descriptor', () => {
    const h = backend();
    for (const photo of [undefined, null, '', '   ', false, {}]) {
        assert.equal(h.save({ foto_wajah: photo, face_descriptor: [1, 2] }).status, 400);
    }
    for (const descriptor of [undefined, null, '', '   ', []]) {
        assert.equal(h.save({ foto_wajah: 'new', face_descriptor: descriptor }).status, 400);
    }
    assert.equal(h.queries.length, 0);
    assert.equal(h.employees[0].foto_wajah, 'old-photo');
});

test('Successful save refreshes employees and faceDB, uses new descriptor and resets registration', async () => {
    const nodes = {};
    const node = id => nodes[id] ||= { value: 'K1', style: {}, srcObject: null };
    const requests = [], alerts = [];
    let employeeRefresh;
    const context = vm.createContext({
        document: { getElementById: node }, API_BASE: '', console, Float32Array,
        faceDB: [{ id: 'K1', desc: new Float32Array([0, 0]) }], faceDBVersion: 0, FACE_THRESHOLD: 0.6,
        regPhotoData: 'new-photo', regDescriptor: [1, 2],
        syncEmployeePickerLabel() {}, closeEmployeePicker() {}, syncRegCameraButtons() {}, setRegDiagnosticsOpen() {},
        loadKaryawan: async refresh => { employeeRefresh = refresh; }, alert: message => alerts.push(message),
        fetch: async (url, options) => {
            requests.push({ url, options });
            return { ok: true, json: async () => options ? { message: 'OK' } : [{ id: 'K1', nama: 'Test', face_descriptor: '[1,2]' }] };
        }
    });
    vm.runInContext(['loadFaceDB', 'euclidean', 'findBestMatch', 'daftarkanWajah'].map(functionSource).join('\n'), context);
    let reset = false;
    await context.daftarkanWajah({ preventDefault() {}, target: { reset() { reset = true; } } });
    assert.equal(requests[0].url, '/api/karyawan/K1/face');
    assert.equal(requests[0].options.method, 'PUT');
    assert.equal(requests[1].url, '/api/karyawan/descriptors');
    assert.equal(employeeRefresh, true);
    assert.deepEqual(Array.from(context.faceDB[0].desc), [1, 2]);
    assert.equal(context.findBestMatch(new Float32Array([1, 2])).distance, 0);
    assert.equal(context.findBestMatch(new Float32Array([0, 0])), null);
    assert(reset);
    assert.equal(context.regPhotoData, '');
    assert.equal(context.regDescriptor, null);
    assert.equal(node('btn-save-reg-face').style.display, 'none');
    assert.equal(alerts.length, 1);
});

test('Service worker never intercepts API GETs or PUTs', () => {
    let handler, intercepted = 0;
    const sw = fs.readFileSync(path.join(root, 'public/sw.js'), 'utf8');
    vm.runInNewContext(sw, { URL, self: { location: { origin: 'https://app.test' }, addEventListener(name, fn) { if (name === 'fetch') handler = fn; } } });
    for (const method of ['GET', 'PUT']) {
        handler({ request: { method, url: 'https://app.test/api/karyawan/descriptors' }, respondWith() { intercepted++; } });
    }
    assert.equal(intercepted, 0);
});
