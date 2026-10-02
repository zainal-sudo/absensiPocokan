const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
const source = html.match(/    function filterEmployeeChoices\([^\n]*\) \{[\s\S]*?\n    \}/)[0];
const context = vm.createContext({});
vm.runInContext(source, context);
const employees = [
    { id: '3', nama: 'ZULKIFLI' },
    { id: '2', nama: 'Abel Kristian' },
    { id: '1', nama: 'Budi' },
    { id: '4', nama: 'Abel Kristian' }
];

test('Employee choices default to A–Z and do not mutate endpoint data', () => {
    const snapshot = JSON.stringify(employees);
    const result = context.filterEmployeeChoices(employees);
    assert.deepEqual(Array.from(result, k => k.id), ['2', '4', '1', '3']);
    assert.equal(JSON.stringify(employees), snapshot);
});

test('Employee names sort Z–A with stable code tie-break', () => {
    assert.deepEqual(Array.from(context.filterEmployeeChoices(employees, '', 'desc'), k => k.id), ['3', '1', '4', '2']);
});

test('Name search is case-insensitive, trims query and combines with sorting', () => {
    assert.deepEqual(Array.from(context.filterEmployeeChoices(employees, '  aBEL ', 'desc'), k => k.id), ['4', '2']);
    assert.equal(context.filterEmployeeChoices(employees, 'does not exist').length, 0);
    assert.equal(context.filterEmployeeChoices(null).length, 0);
});

test('Search and sort do not introduce employees outside the active endpoint response', () => {
    const result = context.filterEmployeeChoices(employees, 'b');
    assert(result.every(k => employees.includes(k)));
    assert.match(html, /fetch\(API_BASE \+ '\/api\/karyawan'\)/);
    assert.match(fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8'), /WHERE k\.kar_isaktif = 1/);
});
