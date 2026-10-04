// Shared PDF presentation helpers for the Admin Reports Center.
// Report data is prepared in admin.js from the same in-memory snapshots used by the UI.

const PAGE_MARGIN = 14;
const REPORT_ACCENT = [181, 31, 107];

function getPdfConstructor() {
    const Pdf = window.jspdf?.jsPDF || window.jsPDF;
    if (!Pdf) {
        throw new Error('The PDF library did not load. Please refresh and try again.');
    }
    return Pdf;
}

function asText(value, fallback = '—') {
    if (value === null || value === undefined || value === '') return fallback;
    return String(value);
}

export function formatReportMoney(value) {
    const amount = Number(value) || 0;
    // The built-in PDF fonts do not reliably contain the peso glyph on every
    // browser. ISO currency text is clear, printable, and unambiguous.
    return `PHP ${amount.toLocaleString('en-PH', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
    })}`;
}

export function formatReportDate(value) {
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return '—';
    return date.toLocaleDateString('en-PH', {
        year: 'numeric', month: 'long', day: 'numeric'
    });
}

function drawHeader(doc, reportName, period) {
    const pageWidth = doc.internal.pageSize.getWidth();
    doc.setFillColor(...REPORT_ACCENT);
    doc.rect(0, 0, pageWidth, 26, 'F');
    doc.setTextColor(255, 255, 255);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(16);
    doc.text('K-BEAUTY SALON', PAGE_MARGIN, 12);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.text(reportName.toUpperCase(), PAGE_MARGIN, 19);

    doc.setTextColor(45, 32, 48);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8.5);
    doc.text(`Generated: ${new Date().toLocaleString('en-PH')}`, PAGE_MARGIN, 34);
    doc.text(`Report period: ${period}`, PAGE_MARGIN, 39);
    return 47;
}

function drawSummary(doc, startY, summary) {
    if (!summary.length) return startY;
    const columns = Math.min(summary.length, 3);
    const gap = 4;
    const pageWidth = doc.internal.pageSize.getWidth();
    const cardWidth = (pageWidth - (PAGE_MARGIN * 2) - (gap * (columns - 1))) / columns;
    const cardHeight = 19;

    summary.forEach((item, index) => {
        const column = index % columns;
        const row = Math.floor(index / columns);
        const x = PAGE_MARGIN + (column * (cardWidth + gap));
        const y = startY + (row * (cardHeight + gap));
        doc.setFillColor(255, 242, 247);
        doc.roundedRect(x, y, cardWidth, cardHeight, 2, 2, 'F');
        doc.setTextColor(104, 45, 79);
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(7.5);
        doc.text(asText(item.label), x + 4, y + 6);
        doc.setTextColor(45, 32, 48);
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(10.5);
        doc.text(asText(item.value), x + 4, y + 13);
    });

    return startY + (Math.ceil(summary.length / columns) * (cardHeight + gap)) + 3;
}

function drawFooter(doc, reportName) {
    const totalPages = doc.getNumberOfPages();
    for (let page = 1; page <= totalPages; page++) {
        doc.setPage(page);
        const pageWidth = doc.internal.pageSize.getWidth();
        const pageHeight = doc.internal.pageSize.getHeight();
        doc.setDrawColor(234, 207, 220);
        doc.line(PAGE_MARGIN, pageHeight - 10, pageWidth - PAGE_MARGIN, pageHeight - 10);
        doc.setTextColor(123, 96, 108);
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(7.5);
        doc.text(`K-Beauty Salon | ${reportName}`, PAGE_MARGIN, pageHeight - 5);
        doc.text(`Page ${page} of ${totalPages}`, pageWidth - PAGE_MARGIN, pageHeight - 5, { align: 'right' });
    }
}

export function downloadReportPdf({ reportName, period, summary, columns, rows, filename, orientation = 'portrait' }) {
    const Pdf = getPdfConstructor();
    const doc = new Pdf({ orientation, unit: 'mm', format: 'a4' });
    let cursorY = drawHeader(doc, reportName, period);
    cursorY = drawSummary(doc, cursorY, summary);

    doc.setTextColor(45, 32, 48);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10);
    doc.text('DETAILS', PAGE_MARGIN, cursorY + 6);
    cursorY += 10;

    if (rows.length) {
        if (typeof doc.autoTable !== 'function') {
            throw new Error('The PDF table library did not load. Please refresh and try again.');
        }
        doc.autoTable({
            startY: cursorY,
            head: [columns],
            body: rows.map(row => row.map(value => asText(value))),
            margin: { left: PAGE_MARGIN, right: PAGE_MARGIN, bottom: 18 },
            styles: { font: 'helvetica', fontSize: 7.3, cellPadding: 2.1, textColor: [45, 32, 48] },
            headStyles: { fillColor: REPORT_ACCENT, textColor: [255, 255, 255], fontStyle: 'bold' },
            alternateRowStyles: { fillColor: [255, 248, 251] },
            theme: 'grid',
            showHead: 'everyPage'
        });
    } else {
        doc.setTextColor(123, 96, 108);
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(9);
        doc.text('No records available for this report period.', PAGE_MARGIN, cursorY + 5);
    }

    drawFooter(doc, reportName);
    doc.save(filename);
}
