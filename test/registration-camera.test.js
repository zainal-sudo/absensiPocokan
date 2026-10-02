const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
const names = [
    'rearLensKind', 'rearCameraCandidates', 'isDefaultRearLabel', 'pickRearCamera', 'listCameraDevices',
    'requestRegistrationRearStream', 'requestCameraStreamWithRetry', 'requestCameraStream',
    'trackIsRear', 'requestRearByDeviceId', 'applyRearZoom', 'safeGet'
];
const source = names.map(name => {
    if (name === 'safeGet') return html.match(/    function safeGet\([^\n]+/)[0];
    const match = html.match(new RegExp(`    (?:async )?function ${name}\\([^\\n]*\\) \\{[\\s\\S]*?\\n    \\}`));
    assert(match, `Missing camera function ${name}`);
    return match[0];
}).join('\n');

const camera = (deviceId, label) => ({ kind: 'videoinput', deviceId, label });
const front = camera('front', 'Front Camera');
const ultra = camera('ultra', 'Back Ultra Wide Camera');
const main = camera('main', 'Back Wide Angle Camera');
const tele = camera('tele', 'Back Telephoto Camera');
const devices = [front, ultra, tele, main];

function harness({ list = devices, stored = {}, hiddenLabels = false, fail, defaultId = 'ultra' } = {}) {
    const storage = new Map(Object.entries(stored));
    const requests = [], streams = [];
    let granted = !hiddenLabels;
    const mediaDevices = {
        enumerateDevices: async () => granted ? list : [camera('', '')],
        getUserMedia: async constraints => {
            const id = constraints.video.deviceId?.exact || (constraints.video.facingMode?.ideal === 'user' ? 'front' : defaultId);
            requests.push(id);
            if (fail) await fail(id, requests.length);
            assert(streams.every(stream => !stream.active), 'hardware must be released before opening another lens');
            const device = list.find(c => c.deviceId === id);
            if (!device) throw new DOMException('Unavailable', 'NotFoundError');
            granted = true;
            const settings = { deviceId: id, facingMode: id === 'front' ? 'user' : 'environment', zoom: 1 };
            const track = {
                label: device.label, readyState: 'live',
                getSettings: () => settings,
                getCapabilities: () => ({ zoom: { min: 1, max: 4 } }),
                applyConstraints: async value => { settings.zoom = value.advanced[0].zoom; },
                stop() { this.readyState = 'ended'; }
            };
            const stream = { get active() { return track.readyState === 'live'; }, getVideoTracks: () => [track], getTracks: () => [track] };
            streams.push(stream);
            return stream;
        }
    };
    const context = vm.createContext({
        navigator: { mediaDevices }, DOMException,
        localStorage: { getItem: key => storage.get(key) || null, removeItem: key => storage.delete(key) },
        setTimeout: callback => { callback(); }
    });
    vm.runInContext(source, context);
    return { api: context, storage, requests, streams, mediaDevices };
}

test('Main rear lens is selected by label regardless of enumeration order', async () => {
    for (const list of [[main, front, ultra, tele], devices, [tele, main, ultra, front]]) {
        const { api, requests } = harness({ list });
        const stream = await api.requestRegistrationRearStream();
        assert.equal(stream.getVideoTracks()[0].getSettings().deviceId, 'main');
        assert.deepEqual(requests, ['main']);
    }
});

test('First permission grant corrects an ultrawide default once, before returning preview stream', async () => {
    const { api, requests, streams } = harness({ hiddenLabels: true });
    const stream = await api.requestRegistrationRearStream();
    assert.deepEqual(requests, ['ultra', 'main']);
    assert.equal(streams[0].active, false);
    assert.equal(stream.getVideoTracks()[0].getSettings().deviceId, 'main');
});

test('Opaque camera labels keep browser choice, not an assumed second lens', async () => {
    const list = [camera('front', 'Front'), camera('ultra', 'Rear device A'), camera('main', 'Rear device B')];
    const { api, requests } = harness({ list });
    await api.requestRegistrationRearStream();
    assert.deepEqual(requests, ['ultra']);
    assert.equal(api.rearCameraCandidates(list).length, 2, 'both rear devices remain available for manual selection');
});

test('Android camera 0 rear label is preferred regardless of lens order or deviceId', async () => {
    for (const label of ['camera 0, facing back', 'camera2 0, facing back', ' CAMERA 0, FACING BACK ']) {
        const normal = camera('opaque-normal-id', label);
        const wide = camera('ultra', 'camera 2, facing back');
        for (const list of [[front, wide, normal], [normal, wide, front]]) {
            const { api, requests } = harness({ list });
            const stream = await api.requestRegistrationRearStream();
            assert.equal(stream.getVideoTracks()[0].getSettings().deviceId, normal.deviceId);
            assert.deepEqual(requests, [normal.deviceId]);
        }
    }
});

test('Android camera 0 is selected after permission reveals its label', async () => {
    const list = [front, camera('ultra', 'camera 2, facing back'), camera('normal', 'camera 0, facing back')];
    const { api, requests, streams } = harness({ list, hiddenLabels: true });
    await api.requestRegistrationRearStream();
    assert.deepEqual(requests, ['ultra', 'normal']);
    assert.equal(streams[0].active, false);
});

test('Manual preference and positively identified main lens outrank Android camera 0', async () => {
    const list = [front, camera('android-default', 'camera 0, facing back'), main, tele];
    const automatic = harness({ list });
    await automatic.api.requestRegistrationRearStream();
    assert.deepEqual(automatic.requests, ['main']);
    const manual = harness({ list, stored: { regRearDeviceIdV2: 'tele' } });
    await manual.api.requestRegistrationRearStream();
    assert.deepEqual(manual.requests, ['tele']);
});

test('Unavailable Android default falls back without repeatedly reopening it', async () => {
    const { api, requests } = harness({
        list: [front, camera('ultra', 'camera 2, facing back'), camera('normal', 'camera 0, facing back')],
        fail: id => { if (id === 'normal') throw new DOMException('Unavailable', 'NotFoundError'); }
    });
    await api.requestRegistrationRearStream();
    assert.deepEqual(requests, ['normal', 'ultra']);
});

test('Android default heuristic excludes front, other camera numbers and explicitly ultrawide labels', () => {
    const { api } = harness();
    for (const label of ['camera 0, facing front', 'camera 10, facing back', 'camera 2, facing back', 'camera 0, facing back Ultra Wide', '0', '']) {
        assert.equal(api.isDefaultRearLabel(label), false);
    }
});

test('Explicit successful preference wins, legacy unverified preference does not', async () => {
    const selected = harness({ stored: { regRearDeviceIdV2: 'tele' } });
    await selected.api.requestRegistrationRearStream();
    assert.deepEqual(selected.requests, ['tele']);
    const legacy = harness({ stored: { regRearDeviceId: 'ultra' } });
    await legacy.api.requestRegistrationRearStream();
    assert.deepEqual(legacy.requests, ['main']);
});

test('Unavailable stored device is cleared and falls back to a working main camera', async () => {
    const { api, requests, storage } = harness({
        stored: { regRearDeviceIdV2: 'tele' },
        fail: id => { if (id === 'tele') throw new DOMException('Removed', 'NotFoundError'); }
    });
    await api.requestRegistrationRearStream();
    assert.equal(storage.has('regRearDeviceIdV2'), false);
    assert.deepEqual(requests, ['tele', 'ultra', 'main']);
});

test('Manual choice failure does not silently select or save a different device', async () => {
    const { api, requests, storage } = harness({ stored: { regRearDeviceIdV2: 'main' } });
    await assert.rejects(api.requestRegistrationRearStream('missing'), { name: 'NotFoundError' });
    assert.deepEqual(requests, ['missing']);
    assert.equal(storage.get('regRearDeviceIdV2'), 'main');
});

test('Permission denial is not retried through other lenses', async () => {
    const { api, requests } = harness({ fail: () => { throw new DOMException('Denied', 'NotAllowedError'); } });
    await assert.rejects(api.requestRegistrationRearStream(), { name: 'NotAllowedError' });
    assert.deepEqual(requests, ['main']);
});

test('Failed post-permission correction restores a working default, without a switching loop', async () => {
    const { api, requests } = harness({
        hiddenLabels: true,
        fail: id => { if (id === 'main') throw new DOMException('Unavailable', 'NotFoundError'); }
    });
    const stream = await api.requestRegistrationRearStream();
    assert.deepEqual(requests, ['ultra', 'main', 'ultra']);
    assert.equal(stream.active, true);
});

test('Front camera is not accepted as an opaque/manual rear choice', async () => {
    const { api, streams } = harness();
    await assert.rejects(api.requestRegistrationRearStream('front'), { name: 'NotFoundError' });
    assert.equal(streams[0].active, false);
});

test('Kiosk/front request still uses front facing mode, ignoring rear preference', async () => {
    const { api, requests } = harness({ stored: { regRearDeviceIdV2: 'main' } });
    await api.requestCameraStreamWithRetry('user');
    assert.deepEqual(requests, ['front']);
});

test('Zoom 1 is requested on the selected lens and only reported when verified', async () => {
    const { api } = harness();
    const stream = await api.requestRegistrationRearStream();
    const track = stream.getVideoTracks()[0];
    track.getSettings().zoom = 2;
    assert.equal(await api.applyRearZoom({ srcObject: stream }, 1), 1);
    track.getSettings = () => ({});
    track.applyConstraints = async () => {};
    assert.equal(await api.applyRearZoom({ srcObject: stream }, 1), null);
    track.applyConstraints = async () => { throw new DOMException('Unsupported', 'OverconstrainedError'); };
    assert.equal(await api.applyRearZoom({ srcObject: stream }, 1), null);
});

test('Ultrawide, telephoto and virtual labels are not misidentified as main lenses', () => {
    const { api } = harness();
    for (const label of ['Back Ultra-Wide Camera', 'Kamera belakang 0,5x', 'Rear Telephoto', 'Back Dual Wide Camera']) {
        assert.notEqual(api.rearLensKind(label), 'main');
    }
    assert.equal(api.rearLensKind('Kamera belakang utama'), 'main');
    assert.equal(api.rearLensKind('Back Camera 1x'), 'main');
});

test('Capture visibility follows retained photo through close, reopen, retake and camera switching', async () => {
    let active = false;
    const elements = Object.fromEntries([
        'btn-open-reg-camera', 'btn-close-reg-camera', 'reg-rear-lens', 'btn-snap-face',
        'reg-face-status-card', 'reg-video-preview', 'btn-flip-cam', 'reg-zoom-row', 'reg-lens-row'
    ].map(id => [id, { style: {}, classList: { toggle() {} } }]));
    const context = vm.createContext({
        document: { getElementById: id => elements[id] },
        regCameraActive: () => active,
        regCameraBusy: false, regCaptureBusy: false, regPhotoData: '', regFacingMode: 'user',
        applyCameraAspect() {}, startRegLive() {}, syncRegFlipButton() {},
        syncZoomRow() {}, syncLensRow() {}, focusRegistrationCamera() {},
        openCamera: async (video, captureButton) => {
            assert.equal(captureButton, null, 'generic openCamera must not re-show Capture');
            active = true;
            context.syncRegCameraButtons(); // playing event while camera startup is busy
            assert.equal(elements['btn-snap-face'].style.display, 'none');
            return true;
        }
    });
    for (const name of ['syncRegCameraButtons', 'startRegCamera', 'captureRegFace']) {
        vm.runInContext(html.match(new RegExp(`    (?:async )?function ${name}\\([^\\n]*\\) \\{[\\s\\S]*?\\n    \\}`))[0], context);
    }
    await context.startRegCamera();
    assert.equal(elements['btn-snap-face'].style.display, 'inline-flex');
    assert.equal(elements['reg-face-status-card'].style.display, 'block');

    context.regPhotoData = 'captured-photo';
    context.syncRegCameraButtons();
    assert.equal(elements['btn-snap-face'].style.display, 'none');
    active = false;
    context.syncRegCameraButtons();
    assert.equal(elements['btn-snap-face'].style.display, 'none');
    assert.equal(elements['reg-face-status-card'].style.display, 'block');
    await context.startRegCamera();
    assert.equal(elements['btn-snap-face'].style.display, 'none');
    await context.captureRegFace(); // guard must leave existing photo intact
    assert.equal(context.regPhotoData, 'captured-photo');

    context.regPhotoData = ''; // Ambil Ulang / successful lens switch resets photo
    context.regCameraBusy = true;
    context.syncRegCameraButtons();
    assert.equal(elements['btn-snap-face'].style.display, 'none');
    context.regCameraBusy = false;
    context.syncRegCameraButtons();
    assert.equal(elements['btn-snap-face'].style.display, 'inline-flex');
    active = false;
    context.syncRegCameraButtons();
    assert.equal(elements['btn-snap-face'].style.display, 'none');
    assert.equal(elements['reg-face-status-card'].style.display, 'none');
});
