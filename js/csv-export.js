// Shared, dependency-free CSV export helpers for Admin reports.
// A UTF-8 BOM keeps peso symbols and Filipino names readable in Excel.
export function escapeCsvValue(value) {
    if (value === null || value === undefined) return '';
    const text = String(value).replace(/\r\n|\r|\n/g, '\n');
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function csvMoney(value) {
    const amount = Number(value);
    return Number.isFinite(amount) ? amount.toFixed(2) : '0.00';
}

export function csvDate(value) {
    if (!value) return '';
    if (typeof value === 'string') return value.slice(0, 10);
    const date = value?.toDate ? value.toDate() : value instanceof Date ? value : null;
    if (!date || Number.isNaN(date.getTime())) return '';
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function csvFilename(prefix, start = '', end = '') {
    const today = csvDate(new Date());
    const suffix = start && end ? `${start}_to_${end}` : start || end || today;
    return `${prefix}_${suffix.replace(/[^0-9A-Za-z_-]/g, '-')}.csv`;
}

export function downloadCsv(filename, headers, rows) {
    if (!Array.isArray(rows) || rows.length === 0) return false;
    const body = rows.map(row => row.map(escapeCsvValue).join(',')).join('\r\n');
    const csv = `\uFEFF${headers.map(escapeCsvValue).join(',')}\r\n${body}\r\n`;
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.style.display = 'none';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
    return true;
}
