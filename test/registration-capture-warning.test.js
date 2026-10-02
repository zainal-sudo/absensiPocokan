const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
const source = name => html.match(new RegExp(`    (?:async )?function ${name}\\([^\\n]*\\) \\{[\\s\\S]*?\\n    \\}`))[0];

function harness(score, decodeFailure = false) {
    const nodes = {};
    const node = id => nodes[id] ||= { style: {}, getClientRects: () => [], decode: async () => { if (decodeFailure) throw new Error('decode failed'); } };
    Object.assign(node('reg-video-preview'), { srcObject: {}, videoWidth: 480, videoHeight: 640 });
    Object.assign(node('reg-canvas-capture'), { getContext: () => ({ drawImage() {} }), toDataURL: () => 'captured-jpeg' });
    node('reg-save-label').textContent = 'Daftarkan Ulang Wajah';
    let checks = 0, extractions = 0, stopped = 0;
    const context = vm.createContext({
        REG_CAPTURE_WARNING_SCORE: 0.85, regPhotoData: '', regDescriptor: null,
        regCameraBusy: false, regCaptureBusy: false, faceModelsLoaded: true, regLastDetectScore: 0.99,
        document: { getElementById: node }, console: { warn() {}, error() {} },
        waitVideoReady: async () => true, syncRegResultName() {}, syncRegCameraButtons() {}, rlog() {},
        stopRegLive() { stopped++; }, requestAnimationFrame: fn => fn(), alert: message => { throw new Error(message); },
        faceapi: { TinyFaceDetectorOptions: function() {}, detectSingleFace: async image => {
            assert.equal(image, node('reg-img-result'), 'check must use the displayed JPEG');
            checks++;
            return score === null ? null : { score };
        } },
        detectDescriptor: async () => {
            extractions++;
            context.regLastDetectScore = 0.99; // unrelated/shared extraction score must not affect warning
            return new Float32Array(128).fill(0.1);
        }
    });
    vm.runInContext(['getRegCapturedPhotoScore', 'getRegCaptureFeedback', 'captureRegFace'].map(source).join('\n'), context);
    return { context, node, get checks() { return checks; }, get extractions() { return extractions; }, get stopped() { return stopped; } };
}

test('Captured photo below 0.85 shows a warning without deleting photo/descriptor or forcing retake', async () => {
    const h = harness(0.8);
    await h.context.captureRegFace();
    assert.match(h.node('reg-face-status').innerText, /0,80.*Ambil Ulang.*tetap bisa disimpan/);
    assert.match(h.node('reg-face-status').className, /text-warning-emphasis/);
    assert.equal(h.node('reg-score-value').textContent, '0.80');
    assert.equal(h.context.regPhotoData, 'captured-jpeg');
    assert.equal(h.context.regDescriptor.length, 128);
    assert.equal(h.node('btn-save-reg-face').style.display, 'inline-flex');
    assert.equal(h.node('btn-retake-reg-face').disabled, false);
    assert.equal(h.checks, 1);
    assert.equal(h.extractions, 1);
    assert.equal(h.stopped, 1);
});

for (const score of [0.85, 0.9, 0.95]) {
    test(`Captured photo score ${score} keeps normal success feedback`, async () => {
        const h = harness(score);
        await h.context.captureRegFace();
        assert.match(h.node('reg-face-status').className, /text-success/);
        assert.match(h.node('reg-face-status').innerText, /128 titik.*Daftarkan Ulang Wajah/);
        assert.equal(h.node('reg-score-value').textContent, score.toFixed(2));
    });
}

test('Missing photo score is not shown as zero or success, and does not block saving valid descriptor', async () => {
    const h = harness(null);
    await h.context.captureRegFace();
    assert.match(h.node('reg-face-status').innerText, /belum tersedia.*Ambil Ulang/);
    assert.equal(h.node('reg-score-value').textContent, '–');
    assert.equal(h.context.regDescriptor.length, 128);
    assert.equal(h.context.regPhotoData, 'captured-jpeg');
});

test('Photo decode failure does not discard successfully extracted descriptor', async () => {
    const h = harness(0.95, true);
    await h.context.captureRegFace();
    assert.match(h.node('reg-face-status').innerText, /belum tersedia/);
    assert.equal(h.context.regDescriptor.length, 128);
    assert.equal(h.checks, 0);
});
