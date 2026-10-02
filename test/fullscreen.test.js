const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../public/fullscreen.js'), 'utf8');

function harness({ unsupported = false, denied = false } = {}) {
    const events = {};
    const elements = {};
    for (const id of ['fullscreen-toggle', 'fullscreen-label', 'fullscreen-icon', 'fullscreen-status']) {
        elements[id] = { hidden: true, attributes: {}, setAttribute(k, v) { this.attributes[k] = v; }, addEventListener(name, fn) { this[name] = fn; } };
    }
    let enters = 0;
    let exits = 0;
    const document = {
        fullscreenElement: null,
        fullscreenEnabled: !unsupported,
        getElementById: id => elements[id],
        addEventListener: (name, fn) => { events[name] = fn; },
        documentElement: {
            async requestFullscreen() {
                enters++;
                if (denied) throw new Error('NotAllowedError');
                document.fullscreenElement = document.documentElement;
                events.fullscreenchange();
            }
        },
        async exitFullscreen() {
            exits++;
            document.fullscreenElement = null;
            events.fullscreenchange();
        }
    };
    vm.runInNewContext(source, { document });
    return { document, events, elements, get enters() { return enters; }, get exits() { return exits; } };
}

test('Fullscreen starts only on click; button toggles entire document and exits', async () => {
    const h = harness();
    const button = h.elements['fullscreen-toggle'];
    assert.equal(h.enters, 0);
    assert.equal(button.attributes['aria-pressed'], 'false');
    await button.click();
    assert.equal(h.enters, 1);
    assert.equal(h.document.fullscreenElement, h.document.documentElement);
    assert.equal(h.elements['fullscreen-label'].textContent, 'Keluar Layar Penuh');
    assert.equal(button.attributes['aria-pressed'], 'true');
    await button.click();
    assert.equal(h.exits, 1);
    assert.equal(h.elements['fullscreen-label'].textContent, 'Layar Penuh');
});

test('Escape/browser exit synchronizes label and icon', async () => {
    const h = harness();
    await h.elements['fullscreen-toggle'].click();
    h.document.fullscreenElement = null;
    h.events.fullscreenchange();
    assert.equal(h.elements['fullscreen-icon'].className, 'fa-solid fa-expand');
    assert.equal(h.elements['fullscreen-toggle'].attributes['aria-pressed'], 'false');
});

test('Unsupported and rejected fullscreen show notice without throwing', async () => {
    for (const options of [{ unsupported: true }, { denied: true }]) {
        const h = harness(options);
        await h.elements['fullscreen-toggle'].click();
        assert.equal(h.elements['fullscreen-status'].hidden, false);
        assert.equal(h.elements['fullscreen-toggle'].disabled, false);
        assert.equal(h.document.fullscreenElement, null);
    }
});

test('Rapid double click requests fullscreen only once', async () => {
    const h = harness();
    await Promise.all([h.elements['fullscreen-toggle'].click(), h.elements['fullscreen-toggle'].click()]);
    assert.equal(h.enters, 1);
    assert.equal(h.exits, 0);
});
