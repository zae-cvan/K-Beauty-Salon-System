import { auth, db } from './firebase-config.js';
import { onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.8.1/firebase-auth.js';
import {
    addDoc, collection, doc, getDoc, getDocs, onSnapshot, serverTimestamp,
    setDoc, updateDoc
} from 'https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js';
import { downloadCsv, csvDate, csvFilename, csvMoney } from './csv-export.js';

// Admin payroll is intentionally kept separate from appointment operations.
// It derives commission only from actual Served/Completed appointments that
// have an assigned staffUid and fall within the selected inclusive date range.
const STAFF_ROLES = new Set(['staff', 'stylist', 'receptionist', 'general staff', 'manager']);
let adminUser = null;
let staffMembers = [];
let payrollRecords = [];
let editingPayrollId = null;
let selectedSettings = null;
let latestCommission = { amount: 0, revenue: 0, appointments: [] };
let settingsLoadRequest = 0;

const $ = id => document.getElementById(id);
const money = amount => `₱${Number(amount || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const roundMoney = value => Math.round((Number(value) || 0) * 100) / 100;
const safeNumber = (id, label) => {
    const value = Number($(id)?.value ?? 0);
    if (!Number.isFinite(value) || value < 0) throw new Error(`${label} must be a valid non-negative amount.`);
    return roundMoney(value);
};
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function toast(message, isError = false) {
    const hint = $('payrollCalculatorHint');
    if (hint) {
        hint.textContent = message;
        hint.style.color = isError ? '#b02a37' : '#287a46';
    }
}

function localDateKey(date = new Date()) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function appointmentDateKey(appt) {
    const raw = appt.bookingDate || appt.date || appt.appointmentDate;
    if (typeof raw === 'string') return raw.slice(0, 10);
    if (raw?.toDate) return localDateKey(raw.toDate());
    if (raw instanceof Date) return localDateKey(raw);
    return '';
}

function isCompleted(appt) {
    const status = String(appt.status || '').trim().toLowerCase();
    return status === 'served' || status === 'completed';
}

function getSelectedStaff(id = $('payrollStaff')?.value) {
    return staffMembers.find(staff => staff.id === id) || null;
}

function setDefaultPeriod() {
    const end = new Date();
    const start = new Date(end);
    start.setDate(end.getDate() - 13);
    if (!$('payrollPeriodStart').value) $('payrollPeriodStart').value = localDateKey(start);
    if (!$('payrollPeriodEnd').value) $('payrollPeriodEnd').value = localDateKey(end);
}

function applyPeriodType() {
    const type = $('payrollPeriodType')?.value;
    const now = new Date();
    let start = new Date(now);
    let end = new Date(now);
    if (type === 'weekly') start.setDate(now.getDate() - 6);
    if (type === 'semi-monthly') {
        if (now.getDate() <= 15) { start.setDate(1); end.setDate(15); }
        else { start.setDate(16); end = new Date(now.getFullYear(), now.getMonth() + 1, 0); }
    }
    if (type === 'monthly') { start.setDate(1); end = new Date(now.getFullYear(), now.getMonth() + 1, 0); }
    if (type !== 'custom') {
        $('payrollPeriodStart').value = localDateKey(start);
        $('payrollPeriodEnd').value = localDateKey(end);
    }
}

function renderStaffOptions() {
    const options = staffMembers.length
        ? staffMembers.map(staff => `<option value="${escapeHtml(staff.id)}">${escapeHtml(staff.fullName || staff.email || 'Unnamed staff')} · ${escapeHtml(staff.role || 'Staff')}</option>`).join('')
        : '';
    ['payrollSettingsStaff', 'payrollStaff', 'payrollFilterStaff'].forEach(id => {
        const select = $(id);
        if (!select) return;
        const previous = select.value;
        select.innerHTML = `<option value="">${id === 'payrollFilterStaff' ? 'All staff' : 'Select staff'}</option>${options}`;
        if ([...select.options].some(option => option.value === previous)) select.value = previous;
    });
}

function fillSettings(settings = {}) {
    $('payrollBasicSalary').value = settings.basicSalary ?? 0;
    $('payrollCommissionRate').value = settings.commissionRate ?? 0;
    $('payrollOvertimeRate').value = settings.overtimeRate ?? 0;
    $('payrollDefaultAllowances').value = settings.defaultAllowances ?? 0;
    $('payrollDefaultDeductions').value = settings.defaultDeductions ?? 0;
}

function setSettingsHint(message, isError = false) {
    const hint = $('payrollSettingsHint');
    if (!hint) return;
    hint.textContent = message;
    hint.style.color = isError ? '#b02a37' : '#287a46';
}

async function loadSettings(staffUid, alsoPrefillCalculator = false) {
    const requestId = ++settingsLoadRequest;
    selectedSettings = null;
    fillSettings();
    if (!staffUid) return;
    console.info('[Payroll Settings] Loading settings', { staffUid });
    try {
        const snap = await getDoc(doc(db, 'payrollSettings', staffUid));
        if (requestId !== settingsLoadRequest) return;
        selectedSettings = snap.exists() ? snap.data() : {};
        fillSettings(selectedSettings);
        setSettingsHint(snap.exists() ? 'Saved settings loaded.' : 'No saved settings yet.');
        if (alsoPrefillCalculator) {
            $('payrollAllowances').value = selectedSettings.defaultAllowances ?? 0;
            $('payrollDeductions').value = selectedSettings.defaultDeductions ?? 0;
        }
        console.info('[Payroll Settings] Settings loaded', { staffUid, exists: snap.exists() });
    } catch (error) {
        if (requestId !== settingsLoadRequest) return;
        console.error('[Payroll Settings] LOAD FAILED', { staffUid, code: error.code, message: error.message });
        setSettingsHint('Could not load staff salary settings. Please try again.', true);
    }
}

async function saveSettings() {
    const saveButton = $('savePayrollSettingsBtn');
    const staffUid = $('payrollSettingsStaff')?.value;
    const staff = getSelectedStaff(staffUid);
    const originalLabel = saveButton?.innerHTML;

    console.info('[Payroll Settings] Save started', { staffUid: staffUid || null });
    if (!adminUser?.uid) {
        console.error('[Payroll Settings] SAVE FAILED', { operation: 'admin-authentication', message: 'No authenticated admin is available.' });
        throw new Error('Your admin session is not ready. Please refresh and try again.');
    }
    if (!staff || !staff.id) {
        console.error('[Payroll Settings] SAVE FAILED', { operation: 'staff-selection', staffUid: staffUid || null });
        throw new Error('Please select a staff member first.');
    }

    try {
        if (saveButton) {
            saveButton.disabled = true;
            saveButton.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Saving...';
        }

        const payload = {
            staffUid: staff.id,
            staffName: staff.fullName || staff.email || 'Unnamed staff',
            staffRole: staff.role || 'Staff',
            basicSalary: safeNumber('payrollBasicSalary', 'Basic salary'),
            commissionType: 'percentage',
            commissionRate: safeNumber('payrollCommissionRate', 'Commission rate'),
            overtimeRate: safeNumber('payrollOvertimeRate', 'Overtime rate'),
            defaultAllowances: safeNumber('payrollDefaultAllowances', 'Default allowances'),
            defaultDeductions: safeNumber('payrollDefaultDeductions', 'Default deductions'),
            updatedAt: serverTimestamp(),
            updatedBy: adminUser.uid
        };
        const settingsRef = doc(db, 'payrollSettings', staff.id);
        console.info('[Payroll Settings] Validation passed', { staffUid: staff.id });
        console.info('[Payroll Settings] Firestore write started', { path: `payrollSettings/${staff.id}` });
        await setDoc(settingsRef, payload, { merge: true });
        console.info('[Payroll Settings] Firestore write completed', { path: `payrollSettings/${staff.id}` });

        // Confirm the document exists before reporting success. This also makes
        // the just-saved values the canonical settings used by payroll loading.
        const persisted = await getDoc(settingsRef);
        if (!persisted.exists()) throw new Error('The salary settings document was not found after saving.');
        selectedSettings = persisted.data();
        fillSettings(selectedSettings);
        setSettingsHint('Staff salary settings saved successfully.');
        console.info('[Payroll Settings] Save complete', { staffUid: staff.id });
    } catch (error) {
        console.error('[Payroll Settings] SAVE FAILED', {
            staffUid: staff.id,
            code: error.code,
            message: error.message,
            operation: 'save-settings'
        });
        throw error;
    } finally {
        if (saveButton) {
            saveButton.disabled = false;
            saveButton.innerHTML = originalLabel || '<i class="fas fa-save"></i> Save Settings';
        }
    }
}

async function calculateCommission(staffUid, periodStart, periodEnd, rate) {
    const snapshot = await getDocs(collection(db, 'appointments'));
    const appointments = [];
    let revenue = 0;
    snapshot.forEach(item => {
        const appt = { id: item.id, ...item.data() };
        const date = appointmentDateKey(appt);
        if (appt.staffUid !== staffUid || !isCompleted(appt) || !date || date < periodStart || date > periodEnd) return;
        const serviceRevenue = Number(String(appt.price ?? 0).replace(/,/g, ''));
        if (!Number.isFinite(serviceRevenue) || serviceRevenue < 0) return;
        revenue += serviceRevenue;
        appointments.push({ id: appt.id, date, serviceName: appt.serviceName || 'Service', revenue: roundMoney(serviceRevenue) });
    });
    return { revenue: roundMoney(revenue), amount: roundMoney(revenue * (rate / 100)), appointments };
}

function calculateTotals(commission = latestCommission.amount) {
    const basicSalary = safeNumber('payrollBasicSalary', 'Basic salary');
    const overtimeRate = safeNumber('payrollOvertimeRate', 'Overtime rate');
    const overtimeHours = safeNumber('payrollOvertimeHours', 'Overtime hours');
    const incentives = safeNumber('payrollIncentives', 'Incentives');
    const allowances = safeNumber('payrollAllowances', 'Allowances');
    const deductions = safeNumber('payrollDeductions', 'Deductions');
    const otherCompensation = safeNumber('payrollOtherCompensation', 'Other compensation');
    const overtimePay = roundMoney(overtimeHours * overtimeRate);
    const grossPay = roundMoney(basicSalary + commission + incentives + overtimePay + allowances + otherCompensation);
    const netPay = roundMoney(grossPay - deductions);
    return { basicSalary, serviceCommission: commission, serviceRevenue: latestCommission.revenue, overtimeRate, overtimeHours, overtimePay, incentives, allowances, deductions, otherCompensation, grossPay, netPay };
}

function renderPreview(totals = null) {
    const preview = $('payrollPreview');
    if (!preview) return;
    if (!totals) {
        preview.innerHTML = '<span>Choose a staff member and period, then select <strong>Load &amp; Calculate</strong>.</span>';
        return;
    }
    preview.innerHTML = `
        <div><span class="text-muted">Completed service revenue</span><strong style="display:block;">${money(totals.serviceRevenue)}</strong></div>
        <div><span class="text-muted">Service commission</span><strong style="display:block;">${money(totals.serviceCommission)}</strong></div>
        <div><span class="text-muted">Overtime pay</span><strong style="display:block;">${money(totals.overtimePay)}</strong></div>
        <div><span class="text-muted">Gross pay</span><strong style="display:block;">${money(totals.grossPay)}</strong></div>
        <div><span class="text-muted">Deductions</span><strong style="display:block;color:#b02a37;">${money(totals.deductions)}</strong></div>
        <div><span class="text-muted">Net pay</span><strong style="display:block;color:#287a46;">${money(totals.netPay)}</strong></div>`;
}

async function loadAndCalculate() {
    const staff = getSelectedStaff();
    const start = $('payrollPeriodStart').value;
    const end = $('payrollPeriodEnd').value;
    if (!staff || !start || !end) throw new Error('Select a staff member and a valid payroll period.');
    if (start > end) throw new Error('Payroll period start cannot be after the end date.');
    await loadSettings(staff.id, true);
    const rate = safeNumber('payrollCommissionRate', 'Commission rate');
    latestCommission = await calculateCommission(staff.id, start, end, rate);
    const totals = calculateTotals(latestCommission.amount);
    renderPreview(totals);
    toast(`${latestCommission.appointments.length} completed appointment(s) included from ${start} to ${end}.`);
    return totals;
}

function payrollPayload(totals, staff) {
    return {
        staffUid: staff.id,
        staffName: staff.fullName || staff.email || 'Unnamed staff',
        staffRole: staff.role || 'Staff',
        periodType: $('payrollPeriodType').value || 'custom',
        periodStart: $('payrollPeriodStart').value,
        periodEnd: $('payrollPeriodEnd').value,
        basicSalary: totals.basicSalary,
        commissionType: 'percentage',
        commissionRate: safeNumber('payrollCommissionRate', 'Commission rate'),
        completedServiceRevenue: totals.serviceRevenue,
        serviceCommission: totals.serviceCommission,
        commissionAppointmentIds: latestCommission.appointments.map(appt => appt.id),
        commissionAppointments: latestCommission.appointments,
        incentives: totals.incentives,
        overtimeHours: totals.overtimeHours,
        overtimeRate: totals.overtimeRate,
        overtimePay: totals.overtimePay,
        allowances: totals.allowances,
        deductions: totals.deductions,
        otherCompensation: totals.otherCompensation,
        compensationNotes: $('payrollNotes').value.trim(),
        grossPay: totals.grossPay,
        netPay: totals.netPay
    };
}

async function savePayroll() {
    const staff = getSelectedStaff();
    if (!staff) throw new Error('Select a staff member before saving payroll.');
    const totals = await loadAndCalculate();
    const payload = payrollPayload(totals, staff);
    if (editingPayrollId) {
        const current = payrollRecords.find(record => record.id === editingPayrollId);
        if (!current || current.status !== 'Draft') throw new Error('Only draft payroll records can be edited.');
        await updateDoc(doc(db, 'payrollRecords', editingPayrollId), { ...payload, updatedAt: serverTimestamp(), updatedBy: adminUser.uid });
        toast('Draft payroll updated.');
        return;
    }
    const duplicate = payrollRecords.find(record => record.staffUid === staff.id && record.periodStart === payload.periodStart && record.periodEnd === payload.periodEnd);
    if (duplicate && !window.confirm(`A ${duplicate.status || 'existing'} payroll record already exists for this staff member and exact period. Save another draft anyway?`)) return;
    await addDoc(collection(db, 'payrollRecords'), { ...payload, status: 'Draft', generatedAt: serverTimestamp(), generatedBy: adminUser.uid, updatedAt: serverTimestamp() });
    toast('Payroll draft saved.');
    resetCalculator();
}

function statusClass(status) {
    const classes = { Draft: 'pending', Finalized: 'completed', Paid: 'active' };
    return classes[status] || 'pending';
}

function filteredRecords() {
    const staff = $('payrollFilterStaff').value;
    const status = $('payrollFilterStatus').value;
    const start = $('payrollFilterStart').value;
    const end = $('payrollFilterEnd').value;
    const search = $('payrollSearch').value.trim().toLowerCase();
    return payrollRecords.filter(record => {
        if (staff && record.staffUid !== staff) return false;
        if (status && record.status !== status) return false;
        if (start && record.periodEnd < start) return false;
        if (end && record.periodStart > end) return false;
        return !search || `${record.staffName || ''} ${record.staffRole || ''}`.toLowerCase().includes(search);
    });
}

function renderRecords() {
    const records = filteredRecords();
    const body = $('payrollRecordsBody');
    const sum = key => roundMoney(records.reduce((total, record) => total + Number(record[key] || 0), 0));
    $('payrollTotalGross').textContent = money(sum('grossPay'));
    $('payrollTotalCommission').textContent = money(sum('serviceCommission'));
    $('payrollTotalDeductions').textContent = money(sum('deductions'));
    $('payrollTotalNet').textContent = money(sum('netPay'));
    if (!records.length) {
        body.innerHTML = '<tr><td colspan="12" style="text-align:center;color:#888;padding:20px;">No payroll records match these filters.</td></tr>';
        return;
    }
    body.innerHTML = records.map(record => {
        const canEdit = record.status === 'Draft';
        const nextAction = record.status === 'Draft' ? '<button class="btn-warning-sm payroll-finalize" data-id="' + escapeHtml(record.id) + '">Finalize</button>' : record.status === 'Finalized' ? '<button class="btn-success-sm payroll-paid" data-id="' + escapeHtml(record.id) + '">Mark paid</button>' : '';
        return `<tr>
            <td title="${escapeHtml(record.id)}">${escapeHtml(record.id).slice(0, 8)}</td>
            <td><strong>${escapeHtml(record.staffName || 'Staff')}</strong><br><small>${escapeHtml(record.staffRole || '')}</small></td>
            <td>${escapeHtml(record.periodStart)}<br><small>to ${escapeHtml(record.periodEnd)}</small></td>
            <td>${money(record.basicSalary)}</td><td>${money(record.serviceCommission)}</td><td>${money(record.overtimePay)}</td><td>${money(record.allowances)}</td><td>${money(record.deductions)}</td><td>${money(record.grossPay)}</td><td><strong>${money(record.netPay)}</strong></td>
            <td><span class="status-badge ${statusClass(record.status)}">${escapeHtml(record.status || 'Draft')}</span></td>
            <td style="white-space:nowrap;"><button class="btn-outline btn-sm payroll-view" data-id="${escapeHtml(record.id)}">View</button> ${canEdit ? `<button class="btn-outline btn-sm payroll-edit" data-id="${escapeHtml(record.id)}">Edit</button>` : ''} ${nextAction}</td>
        </tr>`;
    }).join('');
}

function exportPayrollCsv() {
    const records = filteredRecords();
    if (!records.length) {
        toast('No payroll records match the current filters.', true);
        return;
    }
    const start = $('payrollFilterStart').value || '';
    const end = $('payrollFilterEnd').value || '';
    downloadCsv(csvFilename('kbeauty_payroll', start, end), [
        'Payroll ID', 'Staff Name', 'Staff Role', 'Payroll Period Start', 'Payroll Period End',
        'Basic Salary', 'Service Commission', 'Incentives', 'Overtime Hours', 'Overtime Pay',
        'Allowances', 'Other Compensation', 'Gross Pay', 'Deductions', 'Net Pay',
        'Payroll Status', 'Generated Date'
    ], records.map(record => [
        record.id, record.staffName || '', record.staffRole || '', record.periodStart || '', record.periodEnd || '',
        csvMoney(record.basicSalary), csvMoney(record.serviceCommission), csvMoney(record.incentives),
        Number(record.overtimeHours || 0), csvMoney(record.overtimePay), csvMoney(record.allowances),
        csvMoney(record.otherCompensation), csvMoney(record.grossPay), csvMoney(record.deductions),
        csvMoney(record.netPay), record.status || 'Draft', csvDate(record.generatedAt)
    ]));
    toast(`${records.length} payroll record(s) exported as CSV.`);
}

function resetCalculator() {
    editingPayrollId = null;
    latestCommission = { amount: 0, revenue: 0, appointments: [] };
    $('payrollCalculatorTitle').textContent = 'Generate Payroll';
    $('payrollStaff').value = '';
    $('payrollOvertimeHours').value = 0;
    $('payrollIncentives').value = 0;
    $('payrollAllowances').value = 0;
    $('payrollDeductions').value = 0;
    $('payrollOtherCompensation').value = 0;
    $('payrollNotes').value = '';
    fillSettings();
    renderPreview();
}

async function editDraft(id) {
    const record = payrollRecords.find(item => item.id === id);
    if (!record || record.status !== 'Draft') return;
    editingPayrollId = id;
    $('payrollCalculatorTitle').textContent = `Edit Draft · ${record.staffName || 'Payroll'}`;
    $('payrollStaff').value = record.staffUid;
    $('payrollPeriodType').value = record.periodType || 'custom';
    $('payrollPeriodStart').value = record.periodStart;
    $('payrollPeriodEnd').value = record.periodEnd;
    $('payrollOvertimeHours').value = record.overtimeHours || 0;
    $('payrollIncentives').value = record.incentives || 0;
    $('payrollAllowances').value = record.allowances || 0;
    $('payrollDeductions').value = record.deductions || 0;
    $('payrollOtherCompensation').value = record.otherCompensation || 0;
    $('payrollNotes').value = record.compensationNotes || '';
    await loadSettings(record.staffUid);
    $('payrollBasicSalary').value = record.basicSalary || 0;
    $('payrollCommissionRate').value = record.commissionRate || 0;
    $('payrollOvertimeRate').value = record.overtimeRate || 0;
    latestCommission = { amount: Number(record.serviceCommission || 0), revenue: Number(record.completedServiceRevenue || 0), appointments: record.commissionAppointments || [] };
    renderPreview(calculateTotals(latestCommission.amount));
    toast('Draft loaded. Recalculate before saving if completed service data has changed.');
}

async function updateStatus(id, status) {
    const record = payrollRecords.find(item => item.id === id);
    if (!record) return;
    const allowed = (record.status === 'Draft' && status === 'Finalized') || (record.status === 'Finalized' && status === 'Paid');
    if (!allowed) throw new Error('Invalid payroll status change.');
    if (!window.confirm(`${status} payroll for ${record.staffName}? This record will no longer be editable.`)) return;
    const update = { status, updatedAt: serverTimestamp(), updatedBy: adminUser.uid };
    if (status === 'Finalized') update.finalizedAt = serverTimestamp();
    if (status === 'Paid') update.paidAt = serverTimestamp();
    await updateDoc(doc(db, 'payrollRecords', id), update);
}

function printPayslip(id) {
    const record = payrollRecords.find(item => item.id === id);
    if (!record) return;
    const line = (label, amount) => `<tr><td>${escapeHtml(label)}</td><td>${money(amount)}</td></tr>`;
    const printWindow = window.open('', '_blank', 'width=820,height=900');
    if (!printWindow) { toast('Allow pop-ups to print the payslip.', true); return; }
    printWindow.document.write(`<!doctype html><html><head><title>Payslip ${escapeHtml(record.id)}</title><style>body{font-family:'Poppins','Segoe UI',Arial,sans-serif;color:#222;margin:42px}.head{border-bottom:3px solid #d63384;padding-bottom:14px}h1{margin:0;color:#d63384;font-size:26px}table{width:100%;border-collapse:collapse;margin-top:22px}td{padding:10px;border-bottom:1px solid #eee}td:last-child{text-align:right;font-weight:600}.total td{font-size:17px;font-weight:700}.net td{font-size:20px;color:#16713b;font-weight:700}.meta{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:18px;color:#555}@media print{body{margin:22px}}</style></head><body><div class="head"><h1>K-Beauty Salon</h1><p>Individual Employee Payslip</p></div><div class="meta"><div><strong>Employee:</strong> ${escapeHtml(record.staffName)}</div><div><strong>Role:</strong> ${escapeHtml(record.staffRole || 'Staff')}</div><div><strong>Payroll period:</strong> ${escapeHtml(record.periodStart)} to ${escapeHtml(record.periodEnd)}</div><div><strong>Status:</strong> ${escapeHtml(record.status)}</div></div><table>${line('Basic Salary', record.basicSalary)}${line('Service Commission', record.serviceCommission)}${line('Incentives', record.incentives)}${line(`Overtime Pay (${record.overtimeHours || 0} hrs)`, record.overtimePay)}${line('Allowances', record.allowances)}${line('Other Compensation', record.otherCompensation)}<tr class="total"><td>Gross Pay</td><td>${money(record.grossPay)}</td></tr>${line('Deductions', record.deductions)}<tr class="net"><td>Net Pay</td><td>${money(record.netPay)}</td></tr></table><p style="font-size:12px;color:#666">Generated ${new Date().toLocaleString('en-PH')} · Payroll ID: ${escapeHtml(record.id)}</p><script>window.onload=()=>window.print();<\/script></body></html>`);
    printWindow.document.close();
}

function bindEvents() {
    $('payrollSettingsStaff').addEventListener('change', event => loadSettings(event.target.value));
    $('payrollStaff').addEventListener('change', async event => {
        $('payrollSettingsStaff').value = event.target.value;
        await loadSettings(event.target.value, true);
        latestCommission = { amount: 0, revenue: 0, appointments: [] };
        renderPreview();
    });
    $('payrollPeriodType').addEventListener('change', applyPeriodType);
    $('savePayrollSettingsBtn').addEventListener('click', () => saveSettings().catch(error => setSettingsHint(error.message || 'Could not save staff salary settings. Please try again.', true)));
    $('calculatePayrollBtn').addEventListener('click', () => loadAndCalculate().catch(error => toast(error.message, true)));
    $('savePayrollBtn').addEventListener('click', () => savePayroll().catch(error => toast(error.message, true)));
    $('resetPayrollBtn').addEventListener('click', resetCalculator);
    $('exportPayrollBtn').addEventListener('click', exportPayrollCsv);
    ['payrollFilterStaff', 'payrollFilterStatus', 'payrollFilterStart', 'payrollFilterEnd', 'payrollSearch'].forEach(id => $(id).addEventListener(id === 'payrollSearch' ? 'input' : 'change', renderRecords));
    $('payrollRecordsBody').addEventListener('click', event => {
        const button = event.target.closest('button[data-id]');
        if (!button) return;
        const { id } = button.dataset;
        if (button.classList.contains('payroll-view')) printPayslip(id);
        if (button.classList.contains('payroll-edit')) editDraft(id).catch(error => toast(error.message, true));
        if (button.classList.contains('payroll-finalize')) updateStatus(id, 'Finalized').catch(error => toast(error.message, true));
        if (button.classList.contains('payroll-paid')) updateStatus(id, 'Paid').catch(error => toast(error.message, true));
    });
}

async function initializePayroll(user) {
    const profile = await getDoc(doc(db, 'users', user.uid));
    if (!profile.exists() || profile.data().role !== 'Admin') return;
    adminUser = user;
    setDefaultPeriod();
    renderPreview();
    bindEvents();
    onSnapshot(collection(db, 'users'), snapshot => {
        staffMembers = snapshot.docs.map(item => ({ id: item.id, ...item.data() }))
            .filter(staff => STAFF_ROLES.has(String(staff.role || '').toLowerCase()) && staff.deleted !== true)
            .sort((a, b) => String(a.fullName || a.email || '').localeCompare(String(b.fullName || b.email || '')));
        renderStaffOptions();
    }, error => toast(`Could not load staff: ${error.message}`, true));
    onSnapshot(collection(db, 'payrollRecords'), snapshot => {
        payrollRecords = snapshot.docs.map(item => ({ id: item.id, ...item.data() }))
            .sort((a, b) => (b.generatedAt?.toMillis?.() || 0) - (a.generatedAt?.toMillis?.() || 0));
        renderRecords();
    }, error => {
        $('payrollRecordsBody').innerHTML = `<tr><td colspan="12" style="text-align:center;color:#b02a37;padding:20px;">Could not load payroll records: ${escapeHtml(error.message)}</td></tr>`;
    });
}

onAuthStateChanged(auth, user => {
    if (user) initializePayroll(user).catch(error => console.error('Payroll initialization failed:', error));
});
