// Satu sumber business time untuk Node dan browser, tanpa timezone OS.
(function (root) {
    const timeZone = 'Asia/Jakarta';
    const formatter = new Intl.DateTimeFormat('en-GB', {
        timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
    });

    function getJakartaDateTime(now = new Date()) {
        const parts = {};
        formatter.formatToParts(now).forEach(part => { parts[part.type] = part.value; });
        return {
            tanggal: `${parts.year}-${parts.month}-${parts.day}`,
            jam: `${parts.hour}:${parts.minute}:${parts.second}`
        };
    }

    const api = { timeZone, getJakartaDateTime };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.JakartaTime = api;
})(typeof globalThis !== 'undefined' ? globalThis : window);
