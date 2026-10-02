const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
const extract = name => html.match(new RegExp('    function ' + name + '\\([^\\n]*\\) \\{[\\s\\S]*?\\n    \\}'))[0];
const data = [
    { id: 'K03', nama: 'Zaki', nama_pabrik: 'Pabrik A', has_face: 0 },
    { id: 'K02', nama: 'Budi', nama_pabrik: 'Pabrik B', has_face: '1' },
    { id: 'K01', nama: 'Abel', nama_pabrik: 'Pabrik A', has_face: 1 }
];
const context = vm.createContext({});
vm.runInContext(extract('filterEmployeeChoices') + extract('filterEmployeeList'), context);
const ids = result => Array.from(result, k => k.id);

test('Employee list searches name / NIK case-insensitively and does not mutate data', () => {
    const snapshot = JSON.stringify(data);
    assert.deepEqual(ids(context.filterEmployeeList(data)), ['K01', 'K02', 'K03']);
    assert.deepEqual(ids(context.filterEmployeeList(data, '  k02 ')), ['K02']);
    assert.deepEqual(ids(context.filterEmployeeList(data, 'BUDI')), ['K02']);
    assert.equal(JSON.stringify(data), snapshot);
});

test('Factory, face and sorting filters combine correctly', () => {
    assert.deepEqual(ids(context.filterEmployeeList(data, '', 'Pabrik A', '', 'desc')), ['K03', 'K01']);
    assert.deepEqual(ids(context.filterEmployeeList(data, '', 'Pabrik A', 'registered')), ['K01']);
    assert.deepEqual(ids(context.filterEmployeeList(data, '', '', 'unregistered')), ['K03']);
    assert.deepEqual(ids(context.filterEmployeeList(data, 'Budi', 'Pabrik A')), []);
    assert.deepEqual(ids(context.filterEmployeeList(null)), []);
});

test('Rendering is limited to 30 rows, show-more reveals next batch, and zero results have an empty state', () => {
    const elements = Object.fromEntries(['employee-list-search', 'employee-list-factory', 'employee-list-face', 'employee-list-sort', 'employee-list-count', 'table-karyawan', 'employee-list-more'].map(id => [id, { value: '' }]));
    elements['employee-list-sort'].value = 'asc';
    const renderContext = vm.createContext({
        karyawanCache: Array.from({ length: 65 }, (_, i) => ({ id: String(i), nama: 'Employee ' + i, has_face: 0 })),
        employeeListLimit: 30,
        document: { getElementById: id => elements[id] },
        escHtml: value => String(value || '').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    });
    vm.runInContext(extract('filterEmployeeChoices') + extract('filterEmployeeList') + extract('renderEmployeeList'), renderContext);
    renderContext.renderEmployeeList();
    assert.equal((elements['table-karyawan'].innerHTML.match(/<tr>/g) || []).length, 30);
    assert.equal(elements['employee-list-more'].hidden, false);
    assert.match(elements['employee-list-count'].textContent, /30 dari 65/);
    renderContext.employeeListLimit = 60;
    renderContext.renderEmployeeList();
    assert.equal((elements['table-karyawan'].innerHTML.match(/<tr>/g) || []).length, 60);
    renderContext.employeeListLimit = 90;
    renderContext.renderEmployeeList();
    assert.equal(elements['employee-list-more'].hidden, true);
    elements['employee-list-search'].value = 'not found';
    renderContext.renderEmployeeList();
    assert.match(elements['table-karyawan'].innerHTML, /Tidak ada karyawan/);
    assert.equal(elements['employee-list-more'].hidden, true);
});

test('Employee values are HTML-escaped before table rendering', () => {
    const elements = Object.fromEntries(['employee-list-search', 'employee-list-factory', 'employee-list-face', 'employee-list-sort', 'employee-list-count', 'table-karyawan', 'employee-list-more'].map(id => [id, { value: '' }]));
    const c = vm.createContext({
        karyawanCache: [{ id: '1', nama: '<script>bad</script>', nama_pabrik: '<b>A</b>', posisi: '<img>' }], employeeListLimit: 30,
        document: { getElementById: id => elements[id] },
        escHtml: value => String(value || '').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    });
    vm.runInContext(extract('filterEmployeeChoices') + extract('filterEmployeeList') + extract('renderEmployeeList'), c);
    c.renderEmployeeList();
    assert.doesNotMatch(elements['table-karyawan'].innerHTML, /<script>|<img>|<b>/);
});

test('List table is only inside its scrollable modal; registration picker remains separate', () => {
    assert.equal((html.match(/id="table-karyawan"/g) || []).length, 1);
    const main = html.slice(0, html.indexOf('</main>'));
    assert.doesNotMatch(main, /id="table-karyawan"/);
    assert.match(main, /id="employee-list-open"/);
    assert.match(html, /id="employee-list-modal"[\s\S]*?modal-dialog-scrollable[\s\S]*?id="table-karyawan"/);
    assert.match(html, /id="employee-picker-panel"/);
    assert.doesNotMatch(extract('renderEmployeeList'), /fetch\(/);
});

for (const reducedMotion of [false, true]) {
    test(`Submitting search renders then focuses and scrolls to results (reduced motion: ${reducedMotion})`, () => {
        const calls = [];
        const c = vm.createContext({
            employeeListLimit: 90, EMPLOYEE_LIST_STEP: 30,
            renderEmployeeList: () => calls.push('render'),
            document: { getElementById: id => {
                assert.equal(id, 'employee-list-results');
                return {
                    focus: options => { assert.equal(options.preventScroll, true); calls.push('focus'); },
                    scrollIntoView: options => {
                        assert.equal(options.block, 'start');
                        assert.equal(options.behavior, reducedMotion ? 'instant' : 'smooth');
                        calls.push('scroll');
                    }
                };
            } },
            window: { matchMedia: () => ({ matches: reducedMotion }) }
        });
        vm.runInContext(extract('submitEmployeeListSearch'), c);
        c.submitEmployeeListSearch({ preventDefault: () => calls.push('preventDefault') });
        assert.deepEqual(calls, ['preventDefault', 'render', 'focus', 'scroll']);
        assert.equal(c.employeeListLimit, 30);
        assert.match(html, /id="employee-list-search-form" role="search"/);
        assert.match(html, /type="submit"[^>]*>Cari<\/button>/);
        assert.match(html, /enterkeyhint="search"/);
        assert.match(html, /id="employee-list-results" tabindex="-1"/);
    });
}
