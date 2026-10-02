// Hanya mengatur fullscreen halaman; tidak menyentuh kamera atau state absensi.
(function () {
    const button = document.getElementById('fullscreen-toggle');
    const label = document.getElementById('fullscreen-label');
    const icon = document.getElementById('fullscreen-icon');
    const status = document.getElementById('fullscreen-status');
    let busy = false;

    function syncFullscreenButton() {
        const active = !!document.fullscreenElement;
        const text = active ? 'Keluar Layar Penuh' : 'Layar Penuh';
        label.textContent = text;
        button.setAttribute('aria-label', text);
        button.setAttribute('aria-pressed', String(active));
        button.title = text;
        icon.className = 'fa-solid ' + (active ? 'fa-compress' : 'fa-expand');
        button.disabled = busy;
    }

    function showNotice(message) {
        status.textContent = message;
        status.hidden = false;
    }

    button.addEventListener('click', async function () {
        if (busy) return;
        status.hidden = true;
        const root = document.documentElement;
        if (typeof root.requestFullscreen !== 'function' || typeof document.exitFullscreen !== 'function' || document.fullscreenEnabled === false) {
            showNotice('Browser ini tidak mendukung atau tidak mengizinkan layar penuh. Absensi tetap bisa digunakan seperti biasa.');
            return;
        }
        busy = true;
        syncFullscreenButton();
        try {
            // Panggil langsung dari klik pengguna untuk menjaga user activation.
            if (document.fullscreenElement) await document.exitFullscreen();
            else await root.requestFullscreen();
        } catch (error) {
            showNotice('Layar penuh belum berhasil. Coba lagi atau gunakan browser yang mendukung Fullscreen API.');
        } finally {
            busy = false;
            syncFullscreenButton();
        }
    });

    document.addEventListener('fullscreenchange', function () {
        status.hidden = true;
        syncFullscreenButton();
    });
    syncFullscreenButton();
})();
