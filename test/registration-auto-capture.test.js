const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
const source = name => html.match(new RegExp(`    (?:async )?function ${name}\\([^\\n]*\\) \\{[\\s\\S]*?\\n    \\}`))[0];
const state = html.slice(html.indexOf('    const REG_AUTO_CAPTURE_SCORE'), html.indexOf('    function resetRegAutoCapture'));
const face = (score = 0.95, box = {}) => ({ score, box: { x: 300, y: 300, width: 400, height: 400, ...box } });

function harness() {
    const video = { srcObject: {}, videoWidth: 1000, videoHeight: 1000 };
    const nodes = {
        'reg-video-preview': video,
        'reg-face-status': {},
        'reg-auto-capture': { checked: true },
        'k-existing': { value: 'K1' },
        'tab-karyawan': { active: true, classList: { contains() { return nodes['tab-karyawan'].active; } } },
        'employee-picker-panel': { open: false, classList: { contains() { return nodes['employee-picker-panel'].open; } } }
    };
    let tick, now = 0, captures = 0, calls = 0;
    const context = vm.createContext({
        document: { hidden: false, getElementById: id => nodes[id] },
        regLiveTimer: null, regCameraBusy: false, regCaptureBusy: false, regPhotoData: '', regDescriptor: null,
        faceModelsLoaded: true, regCameraActive: () => !!video.srcObject,
        faceapi: { TinyFaceDetectorOptions: function() {}, detectSingleFace: async () => { calls++; return face(); } },
        performance: { now: () => now },
        setInterval: (fn, delay) => { assert.equal(delay, 400); tick = fn; return 1; }, clearInterval() {},
        captureRegFace: async () => { captures++; context.regPhotoData = 'photo'; }
    });
    vm.runInContext(state + ['resetRegAutoCapture', 'canAutoCaptureRegFace', 'updateRegAutoCapture', 'stopRegLive', 'startRegLive'].map(source).join('\n'), context);
    return { context, video, nodes, get captures() { return captures; }, get calls() { return calls; },
        async tick(time) { now = time; await tick(); } };
}

test('Auto capture needs >0.90, at least three stable detections spanning 800ms, then fires once', () => {
    const { context: c, video } = harness();
    assert.equal(c.updateRegAutoCapture(face(), video, 0), false);
    assert.equal(c.updateRegAutoCapture(face(), video, 400), false);
    assert.equal(c.updateRegAutoCapture(face(), video, 800), true);
    assert.equal(c.updateRegAutoCapture(face(), video, 1200), false);
});

test('An isolated high score or score exactly 0.90 does not trigger capture', () => {
    const { context: c, video } = harness();
    assert.equal(c.updateRegAutoCapture(face(), video, 0), false);
    assert.equal(c.updateRegAutoCapture(face(0.90), video, 400), false);
    assert.equal(c.updateRegAutoCapture(face(), video, 800), false);
    assert.equal(c.updateRegAutoCapture(face(0.75), video, 1200), false);
    assert.equal(c.updateRegAutoCapture(null, video, 1600), false);
});

test('Too-small, too-large, off-center and moving faces reset auto stability', () => {
    for (const bad of [
        face(0.95, { width: 100, height: 100 }),
        face(0.95, { x: 50, y: 50, width: 900, height: 900 }),
        face(0.95, { x: 0 }), face(0.95, { x: 360 }), face(0.95, { width: 480 })
    ]) {
        const { context: c, video } = harness();
        c.updateRegAutoCapture(face(), video, 0);
        c.updateRegAutoCapture(face(), video, 400);
        assert.equal(c.updateRegAutoCapture(bad, video, 800), false);
        assert.equal(c.updateRegAutoCapture(face(), video, 1200), false);
    }
});

test('Detection gap, camera restart and retake require a fresh stability period', () => {
    const { context: c, video } = harness();
    c.updateRegAutoCapture(face(), video, 0);
    c.updateRegAutoCapture(face(), video, 400);
    assert.equal(c.updateRegAutoCapture(face(), video, 2000), false);
    c.stopRegLive();
    assert.equal(c.updateRegAutoCapture(face(), video, 2400), false);
    c.resetRegAutoCapture();
    assert.equal(c.updateRegAutoCapture(face(), video, 2800), false);
});

test('Auto gates respect toggle, selected employee, retained photo, busy camera, hidden page/tab and picker', () => {
    for (const disable of [
        h => { h.nodes['reg-auto-capture'].checked = false; },
        h => { h.nodes['k-existing'].value = ''; },
        h => { h.context.regPhotoData = 'old-photo'; },
        h => { h.context.regCameraBusy = true; },
        h => { h.context.regCaptureBusy = true; },
        h => { h.context.document.hidden = true; },
        h => { h.nodes['tab-karyawan'].active = false; },
        h => { h.nodes['employee-picker-panel'].open = true; },
        h => { h.video.srcObject = null; }
    ]) {
        const h = harness();
        assert.equal(h.context.canAutoCaptureRegFace(), true);
        disable(h);
        assert.equal(h.context.canAutoCaptureRegFace(), false);
    }
});

test('Live loop auto captures once and never replaces a retained photo', async () => {
    const h = harness();
    h.context.startRegLive();
    for (const time of [0, 400, 800, 1200, 1600]) await h.tick(time);
    assert.equal(h.captures, 1);
    assert.equal(h.context.regPhotoData, 'photo');
    assert.equal(h.calls, 3);
});

test('Auto OFF still detects live faces and preserves manual capture control', async () => {
    const h = harness();
    h.nodes['reg-auto-capture'].checked = false;
    h.context.startRegLive();
    for (const time of [0, 400, 800]) await h.tick(time);
    assert.equal(h.captures, 0);
    assert.equal(h.calls, 3);
    assert.match(html, /id="btn-snap-face" onclick="captureRegFace\(\)"/);
    assert.match(source('captureRegFace'), /if \(regCaptureBusy \|\| regCameraBusy \|\| regPhotoData\) return/);
});

test('Detection requests cannot overlap and stale camera results cannot trigger auto capture', async () => {
    const h = harness();
    let resolve;
    h.context.faceapi.detectSingleFace = () => new Promise(done => { resolve = done; });
    h.context.startRegLive();
    const pending = h.tick(0);
    await h.tick(400); // must not issue a second detection
    h.context.stopRegLive();
    resolve(face());
    await pending;
    assert.equal(h.captures, 0);
    assert.equal(h.nodes['reg-face-status'].innerText, undefined);
});
