import { auth, db, firebaseConfig } from "./firebase-config.js";
import { signOut, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-auth.js";
import { requireMfaOrRedirect, clearMfaSession } from "./auth-guard.js";
import { adminUnlockAccount } from "./login-lockout.js";
import { deliverNotification } from "./notification-delivery.js";
import { saveUserProfilePhoto, applyAvatarImage, saveServiceImage } from "./profile-photo.js";
import { openLogoutConfirmation } from "./logout-confirmation.js";
import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-app.js";
import { getAuth, createUserWithEmailAndPassword, fetchSignInMethodsForEmail, sendPasswordResetEmail } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-auth.js";
import { doc, setDoc, collection, query, where, onSnapshot, addDoc, updateDoc, getDocs, getDoc, deleteDoc, writeBatch, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";
import { STAFF_ROLES, normalizeStatus, getApptDate as sharedApptDate, computeReservationPayment, getAppointmentBalanceDue, parsePrice as sharedParsePrice, timeToMinutes } from "./appointment-utils.js";
import { normalizeEmail } from "./auth-security.js";
import { downloadCsv, csvDate, csvFilename, csvMoney } from "./csv-export.js";
import { downloadReportPdf, formatReportDate, formatReportMoney } from "./report-pdf.js";

// -------------------------------------------------------------
// APPOINTMENT / TRANSACTION HELPERS
// -------------------------------------------------------------
function parseApptDate(appt) {
    const dateStr = sharedApptDate(appt);
    if (!dateStr) return new Date(NaN);
    if (typeof appt?.bookingDate?.toDate === 'function') return appt.bookingDate.toDate();
    if (typeof appt?.date?.toDate === 'function') return appt.date.toDate();
    if (typeof appt?.appointmentDate?.toDate === 'function') return appt.appointmentDate.toDate();
    return new Date(dateStr.includes('T') ? dateStr : `${dateStr}T00:00:00`);
}

function apptStatus(appt) {
    return normalizeStatus(appt?.status);
}

function isServedOrCompletedStatus(status) {
    const s = normalizeStatus(status);
    return s === 'served' || s === 'completed';
}

function parsePrice(value) {
    return parseFloat(String(value ?? '').replace(/,/g, '')) || 0;
}

function isRevenueEligibleStatus(status) {
    return isServedOrCompletedStatus(status);
}

function isWeeklyBookingStatus(status) {
    const s = normalizeStatus(status);
    return s === 'served' || s === 'confirmed' || s === 'pending';
}

function isTodayBookingStatus(status) {
    const s = normalizeStatus(status);
    return s !== 'cancelled' && s !== 'denied' && s !== 'no-show' && s !== 'declined';
}

function appointmentBelongsToClient(appt, client) {
    if (!appt || !client) return false;
    // The users/{uid} document ID is the canonical customer identifier. Some
    // older bookings used clientUid, so keep that supported before falling back
    // to legacy name/email matching used by the existing statistics.
    if (appt.clientId === client.id || appt.clientUid === client.id) return true;
    const clientEmail = (client.email || '').toLowerCase().trim();
    const apptEmail = (appt.clientEmail || '').toLowerCase().trim();
    if (clientEmail && apptEmail && clientEmail === apptEmail) return true;
    const clientName = (client.fullName || '').toLowerCase().trim();
    const apptName = (appt.clientName || '').toLowerCase().trim();
    return !!(clientName && apptName && clientName === apptName);
}

function computeClientStats(client, appointments = appointmentsCache) {
    let visits = 0;
    let spent = 0;
    (appointments || []).forEach(appt => {
        if (!appointmentBelongsToClient(appt, client)) return;
        if (!isRevenueEligibleStatus(appt.status)) return;
        spent += parsePrice(appt.price);
        visits++;
    });
    return { visits, spent };
}

/** Single source of truth — revenue from served/completed appointments only. */
function buildFinancialSnapshot(appointments = appointmentsCache) {
    const today = new Date();
    const currentMonth = today.getMonth();
    const currentYear = today.getFullYear();
    const todayString = today.toDateString();

    const monthLabels = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const last6Months = [];
    for (let i = 5; i >= 0; i--) {
        const d = new Date(today);
        d.setMonth(d.getMonth() - i);
        last6Months.push({ label: monthLabels[d.getMonth()], month: d.getMonth(), year: d.getFullYear() });
    }
    const monthRevenue = last6Months.map(() => 0);

    let dailyTotal = 0;
    let monthlyTotal = 0;
    let allTimeTotal = 0;
    let todayBookingsCount = 0;
    const catMap = {};
    const weekDays = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    const weekData = weekDays.map(() => 0);
    const payMap = {};
    const transactionRows = [];
    const uniqueClients = new Set();

    const startOfWeek = new Date(today);
    startOfWeek.setDate(today.getDate() - today.getDay() + 1);
    startOfWeek.setHours(0, 0, 0, 0);
    const endOfWeek = new Date(today);
    endOfWeek.setDate(today.getDate() - today.getDay() + 7);
    endOfWeek.setHours(23, 59, 59, 999);

    (appointments || []).forEach(appt => {
        const price = parsePrice(appt.price);
        const apptDate = parseApptDate(appt);
        const validDate = !isNaN(apptDate.getTime());
        const dateStr = validDate ? apptDate.toLocaleDateString() : new Date().toLocaleDateString();

        if (validDate && apptDate.toDateString() === todayString && isTodayBookingStatus(appt.status)) {
            todayBookingsCount++;
        }

        if (validDate && isWeeklyBookingStatus(appt.status)) {
            const chartIndex = apptDate.getDay() === 0 ? 6 : apptDate.getDay() - 1;
            if (apptDate >= startOfWeek && apptDate <= endOfWeek) {
                weekData[chartIndex] += 1;
            }
        }

        if (!isRevenueEligibleStatus(appt.status)) return;

        allTimeTotal += price;

        if (validDate && apptDate.toDateString() === todayString) {
            dailyTotal += price;
        }
        if (validDate && apptDate.getMonth() === currentMonth && apptDate.getFullYear() === currentYear) {
            monthlyTotal += price;
        }

        if (validDate) {
            for (let i = 0; i < last6Months.length; i++) {
                if (apptDate.getMonth() === last6Months[i].month && apptDate.getFullYear() === last6Months[i].year) {
                    monthRevenue[i] += price;
                    break;
                }
            }
        }

        const cat = appt.category || appt.serviceName || 'Other';
        catMap[cat] = (catMap[cat] || 0) + price;

        const payment = appt.paymentMethod || appt.reservationPaymentMethod || 'Other';
        payMap[payment] = (payMap[payment] || 0) + 1;

        transactionRows.push({
            id: appt.id || '',
            clientId: appt.clientId || null,
            clientName: appt.clientName || appt.clientEmail || 'Unknown',
            serviceName: appt.serviceName || 'Service',
            staffName: appt.staffName || 'Unassigned',
            amount: price,
            paymentMethod: payment,
            date: dateStr,
            dateKey: validDate ? toDateKey(apptDate) : '',
            reservationFee: sharedParsePrice(appt.reservationFeePaid ?? appt.reservationFee ?? 0),
            paymentStatus: appt.balancePaid ? 'Paid' : (appt.reservationPaymentStatus || appt.paymentProofStatus || 'Not recorded'),
            appointmentStatus: appt.status || '',
            sortDate: validDate ? apptDate : new Date(0)
        });

        if (appt.clientEmail) uniqueClients.add(appt.clientEmail);
        else if (appt.clientName) uniqueClients.add(appt.clientName);
    });

    transactionRows.sort((a, b) => b.sortDate - a.sortDate);

    const cashCount = transactionRows.filter(r => (r.paymentMethod || '').toLowerCase() === 'cash').length;
    const digitalCount = transactionRows.filter(r => {
        const p = (r.paymentMethod || '').toLowerCase();
        return p && p !== 'cash' && p !== 'other';
    }).length;

    return {
        today, currentMonth, currentYear, last6Months, monthRevenue,
        dailyTotal, monthlyTotal, allTimeTotal, todayBookingsCount,
        catMap, weekDays, weekData, payMap, transactionRows, uniqueClients,
        cashCount, digitalCount,
        avgTicket: transactionRows.length ? Math.round(allTimeTotal / transactionRows.length) : 0
    };
}

function updateLowStockKpi() {
    const lowStockCount = inventoryCache.filter(item => (item.stock ?? 0) <= (item.threshold ?? 0)).length;
    const kpiLowStock = document.getElementById("kpiLowStock");
    if (kpiLowStock) kpiLowStock.textContent = lowStockCount;
}

function refreshFinancialViews() {
    const snap = buildFinancialSnapshot(appointmentsCache);
    applyDashboardFromSnapshot(snap);
    renderDashboardChartsFromSnapshot(snap);
    renderTransactionsFromSnapshot(snap);
    renderRecentTransactionsFromSnapshot(snap);
    updateLowStockKpi();
    if (clientGrid && clientsCache.length) renderClientGrid();
    renderReports();
}

function applyDashboardFromSnapshot(snap) {
    const kpiToday = document.getElementById("kpiBookings");
    const kpiClients = document.getElementById("kpiClients");
    const kpiRevenue = document.getElementById("kpiRevenue");
    const dashMonthlyTotal = document.getElementById('dashMonthlyTotal');

    if (kpiToday) kpiToday.textContent = snap.todayBookingsCount;
    if (kpiClients) kpiClients.textContent = clientsCache.length || snap.uniqueClients.size;
    if (kpiRevenue) kpiRevenue.textContent = `₱${snap.monthlyTotal.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
    if (dashMonthlyTotal) dashMonthlyTotal.textContent = `₱${snap.monthlyTotal.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
}

function renderDashboardChartsFromSnapshot(snap) {
    const ctx1 = document.getElementById('dashRevenueChart')?.getContext('2d');
    if (ctx1) {
        if (dashRevenueChartInst) dashRevenueChartInst.destroy();
        dashRevenueChartInst = new Chart(ctx1, {
            type: 'bar',
            data: {
                labels: snap.last6Months.map(m => m.label),
                datasets: [{
                    label: 'Revenue (₱)',
                    data: snap.monthRevenue,
                    backgroundColor: 'rgba(214,51,132,0.6)',
                    borderColor: '#d63384',
                    borderWidth: 2,
                    borderRadius: 6
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: { legend: { display: false } },
                scales: { y: { beginAtZero: true, ticks: { callback: v => '₱' + v.toLocaleString() } } }
            }
        });
    }

    const ctx2 = document.getElementById('dashCategoryChart')?.getContext('2d');
    if (ctx2) {
        if (dashCategoryChartInst) dashCategoryChartInst.destroy();
        const labels = Object.keys(snap.catMap);
        const data = Object.values(snap.catMap);
        const colors = ['#f06292', '#b388ff', '#69db7c', '#ffb74d', '#74c0fc', '#fcc5c0', '#81ecec', '#ff7675'];
        if (!data.length || data.reduce((a, b) => a + b, 0) === 0) {
            dashCategoryChartInst = new Chart(ctx2, {
                type: 'doughnut',
                data: { labels: ['No Data'], datasets: [{ data: [1], backgroundColor: ['#eee'], borderWidth: 0 }] },
                options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, cutout: '75%' }
            });
        } else {
            dashCategoryChartInst = new Chart(ctx2, {
                type: 'doughnut',
                data: { labels, datasets: [{ data, backgroundColor: colors.slice(0, labels.length), borderWidth: 0 }] },
                options: {
                    responsive: true, maintainAspectRatio: false,
                    plugins: { legend: { position: 'bottom', labels: { boxWidth: 12, font: { size: 11 } } } },
                    cutout: '65%'
                }
            });
        }
    }

    const ctx3 = document.getElementById('dashWeeklyChart')?.getContext('2d');
    if (ctx3) {
        if (dashWeeklyChartInst) dashWeeklyChartInst.destroy();
        dashWeeklyChartInst = new Chart(ctx3, {
            type: 'line',
            data: {
                labels: snap.weekDays,
                datasets: [{
                    label: 'Bookings',
                    data: snap.weekData,
                    borderColor: '#d63384',
                    backgroundColor: 'rgba(214,51,132,0.08)',
                    fill: true,
                    tension: 0.3,
                    pointBackgroundColor: '#d63384',
                    pointRadius: 4
                }]
            },
            options: {
                responsive: true, maintainAspectRatio: false,
                plugins: { legend: { display: false } },
                scales: { y: { beginAtZero: true, ticks: { stepSize: 1 } } }
            }
        });
    }
}

function getFilteredTransactionRows(snap = buildFinancialSnapshot()) {
    const filter = txSearch ? txSearch.value.toLowerCase() : '';
    const start = document.getElementById('txDateStart')?.value || '';
    const end = document.getElementById('txDateEnd')?.value || '';
    const paymentFilter = document.getElementById('txPaymentFilter')?.value || '';
    return snap.transactionRows.filter(row => {
        const clientMatch = (row.clientName || '').toLowerCase().includes(filter);
        const serviceMatch = (row.serviceName || '').toLowerCase().includes(filter);
        const staffMatch = (row.staffName || '').toLowerCase().includes(filter);
        const searchMatch = clientMatch || serviceMatch || staffMatch;
        const dateMatch = (!start || row.dateKey >= start) && (!end || row.dateKey <= end);
        const paymentMatch = !paymentFilter || (row.paymentMethod || '').toLowerCase() === paymentFilter;
        return searchMatch && dateMatch && paymentMatch;
    });
}

function renderTransactionsFromSnapshot(snap) {
    if (!transactionsTableBody) return;

    const filtered = getFilteredTransactionRows(snap);

    const totalRev = filtered.reduce((s, r) => s + r.amount, 0);

    if (txCount) txCount.textContent = `${filtered.length} transactions · ₱${totalRev.toLocaleString()} total`;
    if (txTotalRevenue) txTotalRevenue.textContent = `₱${totalRev.toLocaleString()}`;
    if (txCashCount) txCashCount.textContent = filtered.filter(r => (r.paymentMethod || '').toLowerCase() === 'cash').length;
    if (txDigitalCount) txDigitalCount.textContent = filtered.filter(r => {
        const p = (r.paymentMethod || '').toLowerCase();
        return p && p !== 'cash' && p !== 'other';
    }).length;
    if (txAvgTicket) txAvgTicket.textContent = filtered.length ? `₱${Math.round(totalRev / filtered.length).toLocaleString()}` : '₱0';

    if (filtered.length === 0) {
        transactionsTableBody.innerHTML = `<tr><td colspan="7" style="text-align:center;color:#888;padding:20px;">No transactions yet.</td></tr>`;
        return;
    }

    transactionsTableBody.innerHTML = filtered.map((row, idx) => `
        <tr>
            <td>${idx + 1}</td>
            <td><strong>${row.clientName}</strong></td>
            <td>${row.serviceName}</td>
            <td>${row.staffName}</td>
            <td>₱${row.amount.toLocaleString()}</td>
            <td><span class="tag">${row.paymentMethod}</span></td>
            <td>${row.date}</td>
        </tr>
    `).join('');
}

function exportTransactionsCsv() {
    const rows = getFilteredTransactionRows();
    if (!rows.length) {
        showToast('No Data', 'No transactions match the current filters.', 'error');
        return;
    }
    const start = document.getElementById('txDateStart')?.value || '';
    const end = document.getElementById('txDateEnd')?.value || '';
    downloadCsv(csvFilename('kbeauty_sales', start, end), [
        'Transaction ID', 'Date', 'Client Name', 'Service', 'Assigned Staff / Stylist',
        'Payment Method', 'Reservation Fee', 'Total Amount', 'Payment Status', 'Appointment Status'
    ], rows.map(row => [
        row.id, row.dateKey || csvDate(row.sortDate), row.clientName, row.serviceName, row.staffName,
        row.paymentMethod, csvMoney(row.reservationFee), csvMoney(row.amount), row.paymentStatus, row.appointmentStatus
    ]));
    showToast('Export Complete', `${rows.length} transaction record(s) exported as CSV.`, 'success');
}

function renderRecentTransactionsFromSnapshot(snap) {
    const container = document.getElementById('recentTransactions');
    if (!container) return;

    const recent = snap.transactionRows.slice(0, 3);
    if (recent.length === 0) {
        container.innerHTML = '<div style="padding:12px 0;color:#888;text-align:center;">No recent transactions.</div>';
        return;
    }
    container.innerHTML = recent.map(t =>
        `<div class="transaction-item"><div class="left"><div class="tx-icon"><i class="fas fa-receipt"></i></div><div class="tx-detail"><div class="tx-client">${t.clientName}</div><div class="tx-meta">${t.serviceName} · ${t.staffName}</div></div></div><div class="right"><div class="tx-amount">₱${t.amount.toLocaleString()}</div><div class="tx-payment">${t.paymentMethod}</div></div></div>`
    ).join('');
}

// -------------------------------------------------------------
// NOTIFICATION HELPER FUNCTION
// -------------------------------------------------------------
async function createNotification(recipientId, message) {
    try {
        await addDoc(collection(db, "notifications"), {
            recipientId, message, isRead: false, createdAt: new Date()
        });
        if (recipientId && recipientId !== "admin" && recipientId !== "staff") {
            deliverNotification(recipientId, message).catch(console.warn);
        }
    } catch (error) {
        console.error("Error generating notification:", error);
    }
}

// -------------------------------------------------------------
// AUTH GUARD
// -------------------------------------------------------------
onAuthStateChanged(auth, async (user) => {
    if (!user) {
        window.location.href = "../index.html";
        return;
    }
    if (!requireMfaOrRedirect(user)) return;

    currentAdminUid = user.uid;
    console.info('[QR Settings] Auth state ready; checking Admin role before initialization.', { uid: user.uid });

    const adminProfileRef = getDoc(doc(db, "users", user.uid));
    const avatarEl = document.getElementById('adminSidebarAvatar');
    const nameEl = document.getElementById('adminSidebarName');
    const photoInput = document.getElementById('adminProfilePhotoInput');
    adminProfileRef.then(adminSnap => {
        const data = adminSnap.exists() ? adminSnap.data() : {};
        if (nameEl) nameEl.textContent = data.fullName || user.displayName || 'Admin';
        if (avatarEl) {
            applyAvatarImage(data.photoURL || '', avatarEl, (data.fullName || user.displayName || 'A').charAt(0).toUpperCase());
        }
        if (photoInput && avatarEl) {
            avatarEl.addEventListener('click', () => photoInput.click());
            photoInput.addEventListener('change', async (e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                avatarEl.classList.add('is-uploading');
                try {
                    const url = await saveUserProfilePhoto(user.uid, file);
                    applyAvatarImage(url, avatarEl, (data.fullName || user.displayName || 'A').charAt(0).toUpperCase());
                    showToast('Profile photo updated!', 'success');
                } catch (err) {
                    showToast('Error', err.message || 'Could not upload photo.', 'error');
                } finally {
                    avatarEl.classList.remove('is-uploading');
                    photoInput.value = '';
                }
            });
        }
    }).catch(profileErr => {
        // The profile badge is non-critical; do not let it hide the QR-settings
        // read that follows or create an unhandled Firestore rejection.
        console.warn('[Admin Dashboard] Could not load the Admin profile for the sidebar.', {
            code: profileErr?.code,
            message: profileErr?.message,
            uid: user.uid
        });
    });

    let userDoc;
    try {
        userDoc = await getDoc(doc(db, "users", user.uid));
    } catch (roleReadErr) {
        console.error('[QR Settings] Admin-role read failed; QR settings will not be initialized.', {
            code: roleReadErr?.code,
            message: roleReadErr?.message,
            uid: user.uid,
            path: `users/${user.uid}`
        });
        showToast('Error', 'Could not verify your Admin access. Please refresh and sign in again.', 'error');
        return;
    }
    if (!userDoc.exists() || userDoc.data().role !== "Admin") {
        alert("Access denied. Admin account required.");
        clearMfaSession();
        await signOut(auth);
        window.location.href = "../index.html";
        return;
    }
    console.info('[QR Settings] Admin role confirmed; initializing QR settings once.', { uid: user.uid });
    initQrPaymentSettings();
});

// -------------------------------------------------------------
// QR CODE PAYMENT SETTINGS
// -------------------------------------------------------------
function isAdminImageFile(file) {
    const allowed = ['image/jpeg', 'image/png', 'image/webp'];
    const ext = file?.name?.split('.').pop()?.toLowerCase() || '';
    return !!file && allowed.includes(file.type) && ['jpg', 'jpeg', 'png', 'webp'].includes(ext);
}

function getAdminQrImageMetadata(file) {
    if (!isAdminImageFile(file)) throw new Error('Please upload a JPG, PNG, or WebP QR image.');
    if (file.size > 5 * 1024 * 1024) throw new Error('QR image must be 5 MB or smaller.');

    const extension = file.name.split('.').pop().toLowerCase();
    const contentType = file.type;
    return { extension, contentType };
}

function withQrOperationTimeout(promise, timeoutMs, timeoutMessage, operation, details = {}) {
    let timeoutId;
    const timeout = new Promise((_, reject) => {
        timeoutId = window.setTimeout(() => {
            console.error(`[QR Settings] ${operation} timed out`, details);
            reject(new Error(timeoutMessage));
        }, timeoutMs);
    });
    return Promise.race([promise, timeout]).finally(() => window.clearTimeout(timeoutId));
}

function getQrSettingsReadErrorMessage(error) {
    switch (error?.code) {
        case 'permission-denied':
            return 'QR settings could not be read. Confirm that the deployed Firestore rules recognize this Admin account.';
        case 'unauthenticated':
            return 'Your session expired before QR settings could be loaded. Please sign in again.';
        case 'unavailable':
            return 'QR settings could not be reached. Check your internet connection and try again.';
        case 'deadline-exceeded':
            return 'Loading QR settings timed out. Please check your connection and try again.';
        case 'failed-precondition':
            return 'QR settings could not be read because Firebase is not configured correctly for this project.';
        default:
            return 'QR settings could not be loaded. Check the browser console for the Firebase error details.';
    }
}

async function verifyQrSettingsAdmin() {
    const user = auth.currentUser;
    if (!user) throw new Error('Your session has expired. Please sign in again.');

    try {
        console.info('[QR Settings] Admin verification starting', { uid: user.uid });
        const userSnap = await withQrOperationTimeout(
            getDoc(doc(db, 'users', user.uid)),
            15000,
            'Admin access could not be verified. Please refresh and sign in again.',
            'Admin verification',
            { uid: user.uid }
        );
        if (!userSnap.exists() || userSnap.data().role !== 'Admin') {
            throw new Error('Admin account required to change QR payment settings.');
        }
        currentAdminUid = user.uid;
        console.info('[QR Settings] Admin verified', { uid: user.uid });
        return user.uid;
    } catch (err) {
        console.error('QR settings Admin-role verification failed:', {
            code: err?.code,
            message: err?.message,
            uid: user.uid
        });
        if (err?.message === 'Admin account required to change QR payment settings.') throw err;
        throw new Error('Could not verify your Admin access. Please refresh and sign in again.');
    }
}


const QR_IMAGE_MAX_DIMENSION = 700;
const QR_IMAGE_MAX_DATA_URL_BYTES = 700 * 1024;

function getQrImageDataSize(dataUrl) {
    return new Blob([dataUrl]).size;
}

function readQrImageAsDataUrl(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error('The QR image could not be read. Please choose another image.'));
        reader.onload = () => resolve(reader.result);
        reader.readAsDataURL(file);
    });
}

function loadQrImage(dataUrl) {
    return new Promise((resolve, reject) => {
        const image = new Image();
        image.onerror = () => reject(new Error('The QR image could not be processed. Please choose another image.'));
        image.onload = () => resolve(image);
        image.src = dataUrl;
    });
}

function renderQrImageData(image, width, height, type, quality) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Your browser could not prepare the QR image. Please try another browser.');

    // JPEG has no transparency. A white background keeps a transparent QR
    // scannable when PNG needs to be compressed further.
    if (type === 'image/jpeg') {
        context.fillStyle = '#ffffff';
        context.fillRect(0, 0, width, height);
    }
    context.drawImage(image, 0, 0, width, height);
    return canvas.toDataURL(type, quality);
}

async function processQrImage(file) {
    const { contentType } = getAdminQrImageMetadata(file);
    console.info('[QR Settings] Processing selected image.', {
        isFile: typeof File !== 'undefined' && file instanceof File,
        isBlob: typeof Blob !== 'undefined' && file instanceof Blob,
        name: file.name,
        type: contentType,
        originalSizeBytes: file.size,
        originalSizeKB: Math.round(file.size / 1024)
    });

    const sourceDataUrl = await readQrImageAsDataUrl(file);
    const image = await loadQrImage(sourceDataUrl);
    const largestDimension = Math.max(image.naturalWidth, image.naturalHeight);
    if (!largestDimension) throw new Error('The QR image has invalid dimensions. Please choose another image.');

    const scale = Math.min(1, QR_IMAGE_MAX_DIMENSION / largestDimension);
    const width = Math.max(1, Math.round(image.naturalWidth * scale));
    const height = Math.max(1, Math.round(image.naturalHeight * scale));
    let qrImageData = renderQrImageData(
        image,
        width,
        height,
        contentType === 'image/png' ? 'image/png' : 'image/jpeg',
        0.92
    );

    // PNG keeps sharp QR edges. If it exceeds the Firestore-safe limit, use a
    // high-quality JPEG with a white background rather than saving an oversized document.
    if (getQrImageDataSize(qrImageData) > QR_IMAGE_MAX_DATA_URL_BYTES) {
        qrImageData = renderQrImageData(image, width, height, 'image/jpeg', 0.92);
    }
    if (getQrImageDataSize(qrImageData) > QR_IMAGE_MAX_DATA_URL_BYTES) {
        qrImageData = renderQrImageData(image, width, height, 'image/jpeg', 0.86);
    }

    const processedSize = getQrImageDataSize(qrImageData);
    console.info('[QR Settings] Processed image size.', {
        width,
        height,
        processedSizeBytes: processedSize,
        processedSizeKB: Math.round(processedSize / 1024),
        limitKB: QR_IMAGE_MAX_DATA_URL_BYTES / 1024
    });
    if (processedSize > QR_IMAGE_MAX_DATA_URL_BYTES) {
        throw new Error('The QR image is still too large after processing. Please choose a smaller image.');
    }
    return qrImageData;
}

function getQrImageSource(settings = qrPaymentSettingsCache) {
    return settings.qrImageData || settings.qrCodeURL || '';
}

function hasActiveQrImage(settings = qrPaymentSettingsCache) {
    return settings.enabled === true && !!getQrImageSource(settings);
}

function renderQrPaymentSettings() {
    renderQrProviders();
}

// ---------------------------------------------------------------------------
// MULTIPLE QR PAYMENT OPTIONS (up to 5)
// Each option is stored in its own document under
// systemSettings/qrPayment/providers so several base64 QR images never share
// one Firestore document and every document stays below Firestore's limit.
// ---------------------------------------------------------------------------
const QR_MAX_PROVIDERS = 5;
let qrProvidersCache = [];
let qrProviderEditingId = null;
let qrProviderPendingFile = null;
let qrProviderPendingObjectUrl = null;

function qrProvidersCollection() {
    return collection(db, 'systemSettings', 'qrPayment', 'providers');
}

function sortQrProviders(providers) {
    return [...providers].sort((a, b) => {
        const ao = Number.isFinite(a.displayOrder) ? a.displayOrder : QR_MAX_PROVIDERS;
        const bo = Number.isFinite(b.displayOrder) ? b.displayOrder : QR_MAX_PROVIDERS;
        if (ao !== bo) return ao - bo;
        return String(a.providerName || '').localeCompare(String(b.providerName || ''));
    });
}

function getProviderImageSource(provider) {
    return provider?.qrImageData || provider?.qrCodeURL || '';
}

function renderQrProviderCard(provider) {
    const image = getProviderImageSource(provider);
    const active = provider.enabled === true;
    const name = escapeAdminHtml(provider.providerName || 'QR Payment');
    return `
        <div class="qr-provider-card" data-provider-id="${escapeAdminHtml(provider.id)}">
            <div class="qr-provider-card-head">
                <span class="qr-provider-name">${name}</span>
                <span class="qr-settings-status ${active ? 'is-active' : ''}">${active ? 'Active' : 'Inactive'}</span>
            </div>
            <div class="qr-provider-preview">
                ${image
                    ? `<img src="${image}" alt="${name} QR code" />`
                    : `<div class="admin-qr-empty"><i class="fas fa-image"></i><span>No QR image</span></div>`}
            </div>
            <div class="qr-provider-meta">
                <div><span>Account Name</span><strong>${escapeAdminHtml(provider.accountName || '—')}</strong></div>
                <div><span>Account Number</span><strong>${escapeAdminHtml(provider.accountNumber || '—')}</strong></div>
            </div>
            <div class="qr-provider-card-actions">
                <button type="button" class="btn-secondary btn-sm" data-qr-action="edit"><i class="fas fa-pen"></i> Edit</button>
                <button type="button" class="btn-secondary btn-sm" data-qr-action="toggle"><i class="fas fa-power-off"></i> ${active ? 'Disable' : 'Enable'}</button>
                <button type="button" class="btn-danger-sm" data-qr-action="delete"><i class="fas fa-trash"></i> Delete</button>
            </div>
        </div>`;
}

function renderQrProviders() {
    const status = document.getElementById('qrSettingsStatus');
    const list = document.getElementById('qrProvidersList');
    const empty = document.getElementById('qrProvidersEmpty');
    const addBtn = document.getElementById('addQrProviderBtn');
    const limitNote = document.getElementById('qrProvidersLimitNote');
    const note = document.getElementById('qrSettingsNote');
    const count = qrProvidersCache.length;
    const atLimit = count >= QR_MAX_PROVIDERS;

    if (status) {
        status.textContent = `${count} of ${QR_MAX_PROVIDERS} configured`;
        status.classList.toggle('is-active', count > 0);
    }
    if (empty) empty.style.display = count ? 'none' : 'flex';
    // Hide the add button entirely once the maximum is reached and surface the
    // explanatory note so the limit is visible rather than silently enforced.
    if (addBtn) addBtn.style.display = atLimit ? 'none' : '';
    if (limitNote) limitNote.style.display = atLimit ? 'block' : 'none';
    if (list) list.innerHTML = count ? qrProvidersCache.map(renderQrProviderCard).join('') : '';
    if (note) {
        note.textContent = qrPaymentSettingsCache.updatedAt?.toDate
            ? `Last updated ${qrPaymentSettingsCache.updatedAt.toDate().toLocaleString()}`
            : '';
    }
}

// Existing installs keep their single configured QR: the first time the admin
// opens QR settings we copy the legacy configuration into the providers
// subcollection. Nothing is deleted, so the parent document still works for
// clients that have not received the multi-provider update.
async function seedLegacyQrProvider() {
    const legacy = qrPaymentSettingsCache;
    const image = getQrImageSource(legacy);
    if (!image) return null;

    const providerId = 'legacy-salon-qr';
    const data = {
        providerId,
        providerName: 'Salon QR',
        accountName: legacy.accountName || '',
        accountNumber: legacy.accountNumber || '',
        qrImageData: legacy.qrImageData || '',
        qrCodeURL: legacy.qrCodeURL || '',
        instructions: legacy.instructions || '',
        enabled: legacy.enabled === true,
        displayOrder: 0,
        createdAt: serverTimestamp(),
        createdBy: currentAdminUid || '',
        updatedAt: serverTimestamp(),
        updatedBy: currentAdminUid || '',
        migratedFromLegacy: true
    };

    await withQrOperationTimeout(
        setDoc(doc(db, 'systemSettings', 'qrPayment', 'providers', providerId), data, { merge: true }),
        20000,
        'QR settings could not be saved. Please try again.',
        'Legacy QR migration',
        { path: `systemSettings/qrPayment/providers/${providerId}` }
    );
    // Flag the parent so clients know providers (not the legacy single QR) are
    // now the source of truth once the admin deletes or adds options.
    await withQrOperationTimeout(
        setDoc(doc(db, 'systemSettings', 'qrPayment'), {
            maxProviders: QR_MAX_PROVIDERS,
            providersManaged: true,
            updatedAt: serverTimestamp(),
            updatedBy: currentAdminUid || ''
        }, { merge: true }),
        20000,
        'QR settings could not be saved. Please try again.',
        'Provider flag write',
        { path: 'systemSettings/qrPayment' }
    );

    return { id: providerId, ...data };
}

async function loadQrPaymentSettings() {
    // An auth-state callback can occasionally be delivered more than once. Keep
    // one read in flight so the page never creates competing QR-settings loads.
    if (qrPaymentSettingsLoadPromise) return qrPaymentSettingsLoadPromise;

    const settingsPath = 'systemSettings/qrPayment';
    const providersPath = 'systemSettings/qrPayment/providers';
    const user = auth.currentUser;
    qrPaymentSettingsLoadPromise = (async () => {
        try {
            if (!user) throw Object.assign(new Error('No authenticated user.'), { code: 'unauthenticated' });

            console.info('[QR Settings] Firestore read starting.', {
                operation: 'getDoc',
                path: settingsPath,
                uid: user.uid,
                authenticated: true,
                firestoreInitialized: !!db,
                projectId: firebaseConfig.projectId
            });
            const snap = await getDoc(doc(db, 'systemSettings', 'qrPayment'));

            // Firestore resolves a missing document successfully. It is the
            // expected first-run state, not an error and not a reason to toast.
            qrPaymentSettingsCache = snap.exists()
                ? { ...QR_PAYMENT_SETTINGS_DEFAULTS, ...snap.data() }
                : { ...QR_PAYMENT_SETTINGS_DEFAULTS };

            let providerDocs = [];
            try {
                const providerSnap = await getDocs(qrProvidersCollection());
                providerDocs = providerSnap.docs.map(d => ({ id: d.id, ...d.data() }));
            } catch (providerErr) {
                console.error('[QR Settings] Providers read failed.', {
                    code: providerErr?.code,
                    message: providerErr?.message,
                    path: providersPath
                });
                throw providerErr;
            }
            qrProvidersCache = sortQrProviders(providerDocs);
            console.info('[QR Settings] Firestore read completed.', {
                path: settingsPath,
                providers: qrProvidersCache.length,
                legacyEnabled: qrPaymentSettingsCache.enabled === true
            });

            if (!qrProvidersCache.length && getQrImageSource(qrPaymentSettingsCache)) {
                try {
                    const seeded = await seedLegacyQrProvider();
                    if (seeded) {
                        qrProvidersCache = [seeded];
                        console.info('[QR Settings] Legacy QR migrated into the providers subcollection.');
                    }
                } catch (seedErr) {
                    // A read-only session or unpublished rules must not hide the
                    // already-configured QR: surface it as a card that cannot be
                    // written until the rules are published.
                    console.warn('[QR Settings] Legacy QR migration skipped.', {
                        code: seedErr?.code,
                        message: seedErr?.message
                    });
                    qrProvidersCache = [{
                        id: 'legacy-salon-qr',
                        providerId: 'legacy-salon-qr',
                        providerName: 'Salon QR',
                        accountName: qrPaymentSettingsCache.accountName || '',
                        accountNumber: qrPaymentSettingsCache.accountNumber || '',
                        qrImageData: qrPaymentSettingsCache.qrImageData || '',
                        qrCodeURL: qrPaymentSettingsCache.qrCodeURL || '',
                        instructions: qrPaymentSettingsCache.instructions || '',
                        enabled: qrPaymentSettingsCache.enabled === true,
                        displayOrder: 0,
                        migrationPending: true
                    }];
                }
            }

            console.info('[QR Settings] Rendering settings.');
            renderQrProviders();
            console.info('[QR Settings] COMPLETE.');
        } catch (err) {
            console.error('[QR Settings] LOAD FAILED', err?.code, err?.message);
            console.error('[QR Settings] Firestore read failed.', {
                path: settingsPath,
                code: err?.code,
                name: err?.name,
                message: err?.message,
                authenticated: !!auth.currentUser,
                uid: auth.currentUser?.uid || null
            });
            renderQrProviders();
            showToast('Error', getQrSettingsReadErrorMessage(err), 'error');
        }
    })();

    try {
        await qrPaymentSettingsLoadPromise;
    } finally {
        qrPaymentSettingsLoadPromise = null;
    }
}

function releaseQrProviderPreview() {
    if (!qrProviderPendingObjectUrl) return;
    try { URL.revokeObjectURL(qrProviderPendingObjectUrl); } catch (_) { /* ignore */ }
    qrProviderPendingObjectUrl = null;
}

function setQrProviderPreview(source) {
    const preview = document.getElementById('qrProviderPreview');
    const empty = document.getElementById('qrProviderPreviewEmpty');
    if (preview) {
        preview.src = source || '';
        preview.style.display = source ? 'block' : 'none';
    }
    if (empty) empty.style.display = source ? 'none' : 'flex';
}

function openQrProviderModal(provider = null) {
    const overlay = document.getElementById('qrProviderModalOverlay');
    if (!overlay) return;
    // Enforce the maximum when the form opens, not only at save time.
    if (!provider && qrProvidersCache.length >= QR_MAX_PROVIDERS) {
        showToast('Limit reached', `Maximum of ${QR_MAX_PROVIDERS} QR payment options reached.`, 'info');
        return;
    }

    qrProviderEditingId = provider ? provider.id : null;
    qrProviderPendingFile = null;
    releaseQrProviderPreview();

    const title = document.getElementById('qrProviderModalTitle');
    if (title) title.textContent = provider ? 'Edit QR Payment Option' : 'Add QR Payment Option';

    const setValue = (id, value) => {
        const el = document.getElementById(id);
        if (el) el.value = value;
    };
    setValue('qrProviderName', provider?.providerName || '');
    setValue('qrProviderAccountName', provider?.accountName || '');
    setValue('qrProviderAccountNumber', provider?.accountNumber || '');
    setValue('qrProviderInstructions', provider?.instructions || '');

    const enabled = document.getElementById('qrProviderEnabled');
    if (enabled) enabled.checked = provider ? provider.enabled === true : true;

    const fileInput = document.getElementById('qrProviderImageInput');
    if (fileInput) fileInput.value = '';
    const status = document.getElementById('qrProviderUploadStatus');
    if (status) {
        status.textContent = provider && getProviderImageSource(provider)
            ? 'Using the saved QR image.'
            : '';
    }

    setQrProviderPreview(getProviderImageSource(provider));
    overlay.style.display = 'flex';
    document.getElementById('qrProviderName')?.focus();
}

function closeQrProviderModal() {
    const overlay = document.getElementById('qrProviderModalOverlay');
    if (overlay) overlay.style.display = 'none';
    qrProviderEditingId = null;
    qrProviderPendingFile = null;
    const fileInput = document.getElementById('qrProviderImageInput');
    if (fileInput) fileInput.value = '';
    const status = document.getElementById('qrProviderUploadStatus');
    if (status) status.textContent = '';
    releaseQrProviderPreview();
    setQrProviderPreview('');
}

function bindQrProviderImageInput() {
    const fileInput = document.getElementById('qrProviderImageInput');
    const status = document.getElementById('qrProviderUploadStatus');
    if (!fileInput || fileInput.dataset.bound === '1') return;
    fileInput.dataset.bound = '1';

    fileInput.addEventListener('change', () => {
        const file = fileInput.files?.[0] || null;
        if (!file) {
            qrProviderPendingFile = null;
            return;
        }
        try {
            getAdminQrImageMetadata(file);
        } catch (err) {
            fileInput.value = '';
            qrProviderPendingFile = null;
            if (status) status.textContent = err.message;
            return;
        }
        qrProviderPendingFile = file;
        try {
            releaseQrProviderPreview();
            qrProviderPendingObjectUrl = URL.createObjectURL(file);
            setQrProviderPreview(qrProviderPendingObjectUrl);
        } catch (previewErr) {
            console.warn('Could not preview selected QR image:', previewErr);
        }
        if (status) status.textContent = `Selected: ${file.name} — ready to save`;
    });
}

// Keeps the parent document in sync so clients know the providers subcollection
// (not the original single QR) is now the source of truth. Best effort: the
// provider document itself is already saved if this fails.
async function markQrProvidersManaged() {
    try {
        await withQrOperationTimeout(
            setDoc(doc(db, 'systemSettings', 'qrPayment'), {
                maxProviders: QR_MAX_PROVIDERS,
                providerCount: qrProvidersCache.length,
                providersManaged: true,
                updatedAt: serverTimestamp(),
                updatedBy: currentAdminUid || ''
            }, { merge: true }),
            20000,
            'QR payment option could not be saved. Please try again.',
            'Provider flag write',
            { path: 'systemSettings/qrPayment' }
        );
    } catch (err) {
        console.warn('[QR Settings] Parent settings flag write failed.', {
            code: err?.code,
            message: err?.message
        });
    }
}

async function saveQrProvider() {
    const saveBtn = document.getElementById('qrProviderSaveBtn');
    const status = document.getElementById('qrProviderUploadStatus');
    const providerName = document.getElementById('qrProviderName')?.value.trim() || '';
    const accountName = document.getElementById('qrProviderAccountName')?.value.trim() || '';
    const accountNumber = document.getElementById('qrProviderAccountNumber')?.value.trim() || '';
    const instructions = document.getElementById('qrProviderInstructions')?.value.trim() || '';
    const enabled = document.getElementById('qrProviderEnabled')?.checked !== false;
    const fileInput = document.getElementById('qrProviderImageInput');
    const file = fileInput?.files?.[0] || null;
    const editing = qrProvidersCache.find(p => p.id === qrProviderEditingId) || null;

    if (!providerName) {
        showToast('Payment option name is required.', 'error');
        return;
    }
    if (providerName.length > 60) {
        showToast('Payment option name must be 60 characters or fewer.', 'error');
        return;
    }
    if (!accountName) {
        showToast('Account name is required.', 'error');
        return;
    }
    if (!editing && !file) {
        showToast('Please choose a QR image for this payment option.', 'error');
        return;
    }
    // Validate the provider count before writing, so a manipulated DOM still
    // cannot create a sixth option.
    if (!editing && qrProvidersCache.length >= QR_MAX_PROVIDERS) {
        showToast(`Maximum of ${QR_MAX_PROVIDERS} QR payment options reached.`, 'error');
        return;
    }

    saveBtn.disabled = true;
    if (status) status.textContent = file ? 'Preparing QR image…' : 'Saving payment option…';
    try {
        if (file) getAdminQrImageMetadata(file);
        await verifyQrSettingsAdmin();

        let qrImageData = editing ? (editing.qrImageData || '') : '';
        if (file) {
            // Reuses the existing compression path so every qrImageData stays
            // comfortably below Firestore's document-size limit.
            qrImageData = await processQrImage(file);
            if (status) status.textContent = 'Saving payment option…';
        }

        const isNew = !editing;
        const providerId = isNew ? doc(qrProvidersCollection()).id : editing.id;
        const data = {
            providerId,
            providerName,
            accountName,
            accountNumber,
            instructions,
            enabled,
            displayOrder: editing && Number.isFinite(editing.displayOrder)
                ? editing.displayOrder
                : qrProvidersCache.length,
            updatedAt: serverTimestamp(),
            updatedBy: currentAdminUid || ''
        };
        if (file) {
            data.qrImageData = qrImageData;
            data.qrCodeURL = '';
        } else if (editing) {
            data.qrImageData = editing.qrImageData || '';
            data.qrCodeURL = editing.qrCodeURL || '';
        }
        if (isNew) {
            data.createdAt = serverTimestamp();
            data.createdBy = currentAdminUid || '';
        }

        console.info('[QR Settings] Saving provider document.', {
            path: `systemSettings/qrPayment/providers/${providerId}`,
            isNew,
            enabled,
            hasQrImageData: !!data.qrImageData
        });
        await withQrOperationTimeout(
            setDoc(doc(db, 'systemSettings', 'qrPayment', 'providers', providerId), data, { merge: true }),
            20000,
            'QR payment option could not be saved. Please try again.',
            'Provider save',
            { path: `systemSettings/qrPayment/providers/${providerId}` }
        );

        qrProvidersCache = sortQrProviders([
            ...qrProvidersCache.filter(p => p.id !== providerId),
            { id: providerId, ...data }
        ]);
        renderQrProviders();
        await markQrProvidersManaged();
        closeQrProviderModal();
        showToast('Saved', `“${providerName}” payment option saved.`, 'success');
        console.info('[QR Settings] Provider save complete.', { providerId, isNew, enabled });
    } catch (err) {
        console.error('[QR Settings] Provider save error:', err);
        if (status) status.textContent = err.message || 'Save failed. Please try again.';
        showToast('Error', err.message || 'Could not save the QR payment option.', 'error');
    } finally {
        if (saveBtn) saveBtn.disabled = false;
    }
}

async function toggleQrProvider(provider, button) {
    const next = provider.enabled !== true;
    if (button) button.disabled = true;
    try {
        await verifyQrSettingsAdmin();
        await withQrOperationTimeout(
            setDoc(doc(db, 'systemSettings', 'qrPayment', 'providers', provider.id), {
                enabled: next,
                updatedAt: serverTimestamp(),
                updatedBy: currentAdminUid || ''
            }, { merge: true }),
            20000,
            'QR payment option could not be updated. Please try again.',
            'Provider status',
            { path: `systemSettings/qrPayment/providers/${provider.id}` }
        );
        qrProvidersCache = qrProvidersCache.map(p => p.id === provider.id
            ? { ...p, enabled: next, updatedAt: { toDate: () => new Date() } }
            : p);
        renderQrProviders();
        await markQrProvidersManaged();
        showToast(
            next ? 'Enabled' : 'Disabled',
            `“${provider.providerName}” is now ${next ? 'shown to clients' : 'hidden from clients'}.`,
            'success'
        );
    } catch (err) {
        console.error('[QR Settings] Provider status update failed:', err);
        showToast('Error', err.message || 'Could not update the QR payment option.', 'error');
    } finally {
        if (button) button.disabled = false;
    }
}

async function deleteQrProvider(provider) {
    if (!confirm(`Delete the “${provider.providerName}” QR payment option? Clients will no longer see it.`)) return;
    try {
        await verifyQrSettingsAdmin();
        await withQrOperationTimeout(
            deleteDoc(doc(db, 'systemSettings', 'qrPayment', 'providers', provider.id)),
            20000,
            'QR payment option could not be deleted. Please try again.',
            'Provider delete',
            { path: `systemSettings/qrPayment/providers/${provider.id}` }
        );
        qrProvidersCache = qrProvidersCache.filter(p => p.id !== provider.id);
        renderQrProviders();
        await markQrProvidersManaged();
        showToast('Deleted', `“${provider.providerName}” payment option deleted.`, 'success');
        console.info('[QR Settings] Provider deleted.', { providerId: provider.id });
    } catch (err) {
        console.error('[QR Settings] Provider delete failed:', err);
        showToast('Error', err.message || 'Could not delete the QR payment option.', 'error');
    }
}

function initQrPaymentSettings() {
    const addBtn = document.getElementById('addQrProviderBtn');
    if (!addBtn) {
        console.warn('[QR Settings] QR settings controls were not found; initialization skipped.');
        return;
    }
    if (addBtn.dataset.bound === '1') {
        console.info('[QR Settings] QR settings already initialized; duplicate initialization skipped.');
        return;
    }
    addBtn.dataset.bound = '1';
    console.info('[QR Settings] Binding QR payment option controls and starting the initial read.');

    addBtn.addEventListener('click', () => openQrProviderModal(null));

    document.getElementById('qrProvidersList')?.addEventListener('click', (event) => {
        const action = event.target.closest('[data-qr-action]');
        if (!action) return;
        const card = action.closest('[data-provider-id]');
        const provider = qrProvidersCache.find(p => p.id === card?.dataset.providerId);
        if (!provider) return;
        const kind = action.dataset.qrAction;
        if (kind === 'edit') openQrProviderModal(provider);
        else if (kind === 'toggle') toggleQrProvider(provider, action);
        else if (kind === 'delete') deleteQrProvider(provider);
    });

    document.getElementById('qrProviderModalClose')?.addEventListener('click', closeQrProviderModal);
    document.getElementById('qrProviderCancelBtn')?.addEventListener('click', closeQrProviderModal);
    document.getElementById('qrProviderSaveBtn')?.addEventListener('click', saveQrProvider);
    document.getElementById('qrProviderModalOverlay')?.addEventListener('click', (event) => {
        if (event.target === event.currentTarget) closeQrProviderModal();
    });
    bindQrProviderImageInput();

    loadQrPaymentSettings();
}

// -------------------------------------------------------------
// 1. LOGOUT FEATURE
// -------------------------------------------------------------
const logoutBtn = document.getElementById("logout-btn");
async function logoutUser() {
    try {
        clearMfaSession();
        await signOut(auth);
        alert("Logged out successfully.");
        window.location.href = "../index.html";
    } catch (error) {
        console.error("Logout Error:", error);
        throw error;
    }
}

if (logoutBtn) {
    logoutBtn.addEventListener("click", () => {
        openLogoutConfirmation(logoutUser);
    });
}

// -------------------------------------------------------------
// 2. STAFF ACCOUNT CREATION — ADMIN → USER MANAGEMENT
//    Creates a real Firebase Auth account on a SECONDARY Firebase app so
//    the primary Auth instance (the logged-in Admin session) is never
//    switched, signed out or otherwise disturbed. A strong temporary
//    password is generated in memory only, used once to create the Auth
//    account, and then a Firebase password-setup email is sent so the
//    staff member chooses their own password. The temporary password is
//    never stored, logged or displayed anywhere.
// -------------------------------------------------------------
const addStaffAccountBtn = document.getElementById("addStaffAccountBtn");
const addStaffOverlay = document.getElementById("addStaffModalOverlay");
const addStaffForm = document.getElementById("addStaffForm");
const addStaffSubmitBtn = document.getElementById("addStaffSubmitBtn");
const addStaffCancelBtn = document.getElementById("addStaffCancelBtn");
const addStaffModalCloseBtn = document.getElementById("addStaffModalClose");
const addStaffErrorEl = document.getElementById("addStaffFormError");

const STAFF_CREATION_APP_NAME = "StaffCreationApp";
let staffCreationBusy = false;

// Secondary Firebase app + Auth used ONLY for staff account creation.
// Reuses the exact existing firebaseConfig under a unique app name, and
// the getApps() lookup keeps repeated creations from ever throwing
// "app already exists". Because the Auth persistence key includes the
// app name, this instance can never touch the primary Admin session.
function getStaffCreationAuth() {
    const secondaryApp = getApps().find(app => app.name === STAFF_CREATION_APP_NAME)
        || initializeApp(firebaseConfig, STAFF_CREATION_APP_NAME);
    return getAuth(secondaryApp);
}

// Strong one-time password built from crypto.getRandomValues. It lives
// only in this local variable — never written to Firestore, storage,
// localStorage, logs or the activity trail — and is discarded right
// after the Auth account is created.
function generateTemporaryPassword() {
    // 64 characters → uniform 32-bit draws (no modulo bias).
    const charset = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!#";
    const length = 24;
    const draws = new Uint32Array(length);
    crypto.getRandomValues(draws);
    let password = "";
    for (let i = 0; i < length; i++) {
        password += charset[draws[i] % charset.length];
    }
    // Guarantee upper + lower + digit + special regardless of the draw.
    return password + "Qa7!";
}

function setAddStaffError(message) {
    if (!addStaffErrorEl) return;
    addStaffErrorEl.textContent = message || "";
    addStaffErrorEl.style.display = message ? "block" : "none";
}

// Friendly, non-technical messages for the errors the Admin can actually
// hit. Technical details are logged to the console instead.
function friendlyAddStaffErrorMessage(error) {
    switch (error?.code) {
        case "auth/email-already-in-use":
            return "An account with this email address already exists.";
        case "auth/invalid-email":
            return "Please enter a valid email address.";
        case "auth/weak-password":
            return "Firebase rejected the generated temporary password. Please try again.";
        case "auth/too-many-requests":
            return "Too many attempts. Please wait a moment and try again.";
        case "auth/network-request-failed":
            return "Network error. Check your connection and try again.";
        case "auth/user-disabled":
            return "This login is disabled. Re-enable it in Firebase Console → Authentication first.";
        case "permission-denied":
            return "Database permission error. Publish firestore.rules in Firebase Console (Firestore → Rules).";
        case "unavailable":
            return "The database is unreachable right now. Check your connection and try again.";
        default:
            return null;
    }
}

function addStaffUserFacingError(message) {
    const error = new Error(message);
    error.isUserFacing = true;
    return error;
}

// The page already guards itself with the Admin auth check, but every
// creation re-verifies users/{uid}.role === "Admin" against Firestore so
// this feature can never be driven by a non-Admin session.
async function verifyAdminForStaffCreation() {
    const user = auth.currentUser;
    if (!user) throw addStaffUserFacingError("Your session has expired. Please sign in again.");
    const snap = await getDoc(doc(db, "users", user.uid));
    if (!snap.exists() || snap.data().role !== "Admin") {
        throw addStaffUserFacingError("Only an Admin account can create staff accounts.");
    }
    currentAdminUid = user.uid;
    return user.uid;
}

function openAddStaffModal() {
    if (!addStaffOverlay) return;
    setAddStaffError("");
    addStaffForm?.reset();
    addStaffOverlay.style.display = "flex";
    document.getElementById("staffFullName")?.focus();
}

function closeAddStaffModal() {
    if (staffCreationBusy) return; // never discard an in-flight creation
    if (addStaffOverlay) addStaffOverlay.style.display = "none";
    setAddStaffError("");
    addStaffForm?.reset();
}

async function handleAddStaffSubmit(e) {
    e.preventDefault();
    if (staffCreationBusy) return; // double-click / double-submit guard

    const fullName = (document.getElementById("staffFullName")?.value || "").trim();
    const email = normalizeEmail(document.getElementById("staffEmail")?.value);
    const phone = (document.getElementById("staffPhone")?.value || "").trim();
    const role = document.getElementById("staffRole")?.value || "";

    setAddStaffError("");

    if (fullName.length < 2) {
        setAddStaffError("Please enter the staff member's full name.");
        return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        setAddStaffError("Please enter a valid email address.");
        return;
    }
    if (phone && !/^[+\d][\d\s\-()]{6,19}$/.test(phone)) {
        setAddStaffError("Please enter a valid phone number, or leave it blank.");
        return;
    }
    // Whitelist against the roles this system actually supports. Admin and
    // Client are excluded and cannot be injected past this check.
    if (!STAFF_ROLES.includes(role)) {
        setAddStaffError("Please select a staff role. Admin and Client accounts cannot be created here.");
        return;
    }

    staffCreationBusy = true;
    const submitLabel = addStaffSubmitBtn ? addStaffSubmitBtn.innerHTML : "";
    if (addStaffSubmitBtn) {
        addStaffSubmitBtn.disabled = true;
        addStaffSubmitBtn.textContent = "Creating...";
    }
    if (addStaffCancelBtn) addStaffCancelBtn.disabled = true;
    if (addStaffModalCloseBtn) addStaffModalCloseBtn.disabled = true;

    let secondaryAuth = null;

    try {
        const adminUid = await verifyAdminForStaffCreation();
        secondaryAuth = getStaffCreationAuth();

        // Duplicate guards (best effort — the Auth error below is
        // still the authoritative duplicate check).
        let signInMethods = [];
        try {
            signInMethods = await fetchSignInMethodsForEmail(secondaryAuth, email) || [];
        } catch (lookupErr) {
            console.warn("[Add Staff] Sign-in-method pre-check skipped:", lookupErr?.code || lookupErr?.message);
        }
        if (signInMethods.length) {
            const dupErr = new Error("duplicate email");
            dupErr.code = "auth/email-already-in-use";
            throw dupErr;
        }

        let dupProfile = null;
        try {
            dupProfile = await getDocs(query(collection(db, "users"), where("email", "==", email)));
        } catch (lookupErr) {
            console.warn("[Add Staff] Profile pre-check skipped:", lookupErr?.code || lookupErr?.message);
        }
        if (dupProfile && !dupProfile.empty) {
            const dupErr = new Error("duplicate profile");
            dupErr.code = "auth/email-already-in-use";
            throw dupErr;
        }

        // (1) Real Firebase Auth account on the SECONDARY app — the
        // primary Auth instance (Admin session) is never touched.
        const temporaryPassword = generateTemporaryPassword();
        const credential = await createUserWithEmailAndPassword(secondaryAuth, email, temporaryPassword);
        const staffUser = credential.user;

        // (2) Firestore users/{uid} profile keyed by the Auth UID,
        // reusing the existing users schema (same identity fields as
        // public Client registration, plus createdBy for auditing).
        try {
            await setDoc(doc(db, "users", staffUser.uid), {
                uid: staffUser.uid,
                fullName: fullName,
                email: email,
                phone: phone,
                role: role,
                photoURL: "",
                createdAt: serverTimestamp(),
                createdBy: adminUid
            });
        } catch (profileErr) {
            console.error("[Add Staff] Auth account created but the Firestore profile write failed:", {
                code: profileErr?.code,
                message: profileErr?.message,
                uid: staffUser.uid,
                email: email
            });
            const reason = friendlyAddStaffErrorMessage(profileErr) || "the profile write was rejected";
            throw addStaffUserFacingError(
                `The login for ${email} was created in Firebase Authentication, but the staff profile failed to save (${reason}). ` +
                `Fix the reported issue, then create the profile manually — or delete this login in Firebase Console → Authentication before retrying.`
            );
        }

        // (3) Password setup email — the generated temporary password is
        // discarded here and never shown to anyone. A failed email is
        // reported honestly instead of silently ignored.
        let setupEmailSent = false;
        try {
            await sendPasswordResetEmail(secondaryAuth, email);
            setupEmailSent = true;
        } catch (resetErr) {
            console.error("[Add Staff] Password setup email could not be sent:", {
                code: resetErr?.code,
                message: resetErr?.message,
                email: email
            });
        }

        // Success: close the modal and notify. The real-time users
        // listener refreshes the User Management list automatically —
        // no page reload.
        addStaffForm?.reset();
        if (addStaffOverlay) addStaffOverlay.style.display = "none";

        const safeEmail = escapeCustomerHtml(email);
        if (setupEmailSent) {
            showToast("Staff account created", `Staff account created successfully. Password setup instructions were sent to ${safeEmail}.`, "success");
        } else {
            showToast("Staff account created", `The account for ${safeEmail} was created, but the setup email could not be sent. Ask the staff member to use \"Forgot Password\" on the Sign In page.`, "warning");
        }
    } catch (error) {
        console.error("[Add Staff] Account creation failed:", {
            code: error?.code,
            message: error?.message,
            email: email
        });
        const message = error?.isUserFacing
            ? error.message
            : (friendlyAddStaffErrorMessage(error) || "Account creation failed. Please try again. Technical details are in the browser console.");
        setAddStaffError(message);
    } finally {
        // Always drop the SECONDARY session. The primary Admin auth is
        // never signed out or replaced.
        if (secondaryAuth) {
            try {
                await signOut(secondaryAuth);
            } catch (signOutErr) {
                console.warn("[Add Staff] Secondary sign-out skipped:", signOutErr?.code || signOutErr?.message);
            }
        }
        staffCreationBusy = false;
        if (addStaffSubmitBtn) {
            addStaffSubmitBtn.disabled = false;
            addStaffSubmitBtn.innerHTML = submitLabel;
        }
        if (addStaffCancelBtn) addStaffCancelBtn.disabled = false;
        if (addStaffModalCloseBtn) addStaffModalCloseBtn.disabled = false;
    }
}

if (addStaffAccountBtn) addStaffAccountBtn.addEventListener("click", openAddStaffModal);
if (addStaffModalCloseBtn) addStaffModalCloseBtn.addEventListener("click", closeAddStaffModal);
if (addStaffCancelBtn) addStaffCancelBtn.addEventListener("click", closeAddStaffModal);
if (addStaffOverlay) addStaffOverlay.addEventListener("click", (event) => {
    if (event.target === event.currentTarget) closeAddStaffModal();
});
if (addStaffForm) addStaffForm.addEventListener("submit", handleAddStaffSubmit);
document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && addStaffOverlay && addStaffOverlay.style.display === "flex") {
        closeAddStaffModal();
    }
});

// -------------------------------------------------------------
// 3. REAL-TIME STAFF LIST LISTENER (MULTIPLE ROLES)
// -------------------------------------------------------------
const staffTableBody = document.getElementById("staff-table-body");
if (staffTableBody) {
    const staffQuery = query(
        collection(db, "users"), 
        where("role", "in", ["Staff", "Stylist", "Receptionist", "General Staff", "Manager"])
    );

    onSnapshot(staffQuery, (snapshot) => {
        staffTableBody.innerHTML = "";

        if (snapshot.empty) {
            staffTableBody.innerHTML = `<tr><td colspan="4" style="text-align: center; color: #888;">No staff members found.</td></tr>`;
            return;
        }

        snapshot.forEach((docSnap) => {
            const staffData = docSnap.data();
            const row = document.createElement("tr");

            const avatarHtml = staffData.photoURL 
                ? `<img src="${staffData.photoURL}" alt="${staffData.fullName}" style="width: 38px; height: 38px; border-radius: 50%; object-fit: cover; border: 2px solid #f8c8dc;">`
                : `<div style="width: 38px; height: 38px; border-radius: 50%; background: #fff0f5; color: #d63384; display: flex; align-items: center; justify-content: center;"><i class="fa-solid fa-user" style="font-size: 18px;"></i></div>`;

            let roleColor = "#1976d2"; 
            let roleBg = "#e3f2fd";
            
            if (staffData.role === "Stylist") {
                roleColor = "#d63384"; roleBg = "#f8c8dc"; 
            } else if (staffData.role === "Manager") {
                roleColor = "#28a745"; roleBg = "#d4edda"; 
            } else if (staffData.role === "Receptionist") {
                roleColor = "#fd7e14"; roleBg = "#ffe5d0"; 
            }

            row.innerHTML = `
                <td>${avatarHtml}</td>
                <td><strong>${staffData.fullName || "N/A"}</strong></td>
                <td>${staffData.email || "N/A"}</td>
                <td><span style="background: ${roleBg}; color: ${roleColor}; padding: 3px 10px; border-radius: 12px; font-weight: bold; font-size: 12px;">${staffData.role}</span></td>
            `;

            staffTableBody.appendChild(row);
        });
    }, (error) => {
        console.error("Error loading staff list:", error);
        staffTableBody.innerHTML = `<tr><td colspan="4" style="text-align: center; color: red;">Error loading staff list.</td></tr>`;
    });
}

// -------------------------------------------------------------
// 4. REAL-TIME CLIENTS LIST LISTENER
// -------------------------------------------------------------
const clientGrid = document.getElementById("clientGrid");
const clientCountEl = document.getElementById("clientCount");
const customerDetailEl = document.getElementById("customerDetail");
const clientSearchInput = document.getElementById("clientSearch");
let clientsCache = [];
let selectedClientId = null;
let selectedClientNotes = [];
let stopSelectedClientNotesListener = null;

function escapeCustomerHtml(value) {
    return String(value ?? '').replace(/[&<>'"]/g, char => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
    }[char]));
}

function customerValue(value) {
    return value === undefined || value === null || String(value).trim() === ''
        ? 'Not provided'
        : escapeCustomerHtml(value);
}

function customerDate(value, options = { year: 'numeric', month: 'long', day: 'numeric' }) {
    if (!value) return 'Not provided';
    const date = typeof value.toDate === 'function' ? value.toDate() : new Date(value);
    return Number.isNaN(date.getTime()) ? 'Not provided' : date.toLocaleDateString('en-PH', options);
}

function selectedClientAppointments(client) {
    if (!client?.id) return [];
    return appointmentsCache.filter(appt => {
        if (appt.clientId || appt.clientUid) {
            return appt.clientId === client.id || appt.clientUid === client.id;
        }
        // Preserve visibility of truly legacy records with no UID at all while
        // never using name/email to override an existing appointment UID.
        return appointmentBelongsToClient(appt, client);
    });
}

function appointmentPaymentStatus(appt) {
    if (typeof appt.balancePaid === 'boolean') return appt.balancePaid ? 'Paid' : 'Unpaid';
    return appt.paymentStatus || appt.reservationPaymentStatus || appt.paymentProofStatus || '';
}

function renderCustomerLoading() {
    if (customerDetailEl) {
        customerDetailEl.innerHTML = '<div class="detail-placeholder"><i class="fas fa-spinner fa-spin" style="font-size:28px;color:#d63384;display:block;margin-bottom:12px;"></i>Loading customer profile...</div>';
    }
}

function listenToSelectedClientNotes(clientId) {
    stopSelectedClientNotesListener?.();
    selectedClientNotes = [];
    const notesQuery = query(collection(db, 'clientNotes'), where('clientId', '==', clientId));
    stopSelectedClientNotesListener = onSnapshot(notesQuery, snapshot => {
        if (selectedClientId !== clientId) return;
        selectedClientNotes = snapshot.docs.map(note => ({ id: note.id, ...note.data() }));
        renderClientDetail(clientId);
    }, error => {
        console.error('Error loading selected customer notes:', error);
        if (selectedClientId !== clientId) return;
        selectedClientNotes = null;
        renderClientDetail(clientId);
    });
}

if (clientGrid) {
    const clientsQuery = query(
        collection(db, "users"),
        where("role", "==", "Client")
    );

    onSnapshot(clientsQuery, (snapshot) => {
        console.log("🔄 Clients listener fired. Docs:", snapshot.size);
        clientsCache = [];
        
        if (snapshot.empty) {
            clientGrid.innerHTML = `<div style="padding:30px;text-align:center;color:#888;background:#fcfafb;border-radius:12px;border:1px solid #f0e8ec;">No registered clients found.</div>`;
            if(clientCountEl) clientCountEl.textContent = "0 registered clients";
            if(customerDetailEl) customerDetailEl.innerHTML = `<div class="detail-placeholder"><i class="fas fa-user-circle" style="font-size:48px;color:#ddd;display:block;margin-bottom:12px;"></i>Select a client to view details</div>`;
            renderReports();
            return;
        }

        snapshot.forEach((docSnap) => {
            const clientData = docSnap.data();
            clientData.id = docSnap.id;
            clientsCache.push(clientData);
        });

        if (selectedClientId && !clientsCache.some(client => client.id === selectedClientId)) {
            selectedClientId = null;
            selectedClientNotes = [];
            stopSelectedClientNotesListener?.();
            stopSelectedClientNotesListener = null;
            renderCustomerLoading();
        }

        renderClientGrid();
        renderReports();
    }, (error) => {
        console.error("Error loading clients list:", error);
        clientGrid.innerHTML = `<div style="padding:30px;text-align:center;color:red;background:#fcfafb;border-radius:12px;border:1px solid #f0e8ec;">Error loading clients.</div>`;
    });
}

// -------------------------------------------------------------
// 4.1 RENDER CLIENT GRID
// -------------------------------------------------------------
function legacyRenderClientGrid() {
    if (!clientGrid) return;

    if (clientsCache.length === 0) {
        clientGrid.innerHTML = `<div style="padding:30px;text-align:center;color:#888;background:#fcfafb;border-radius:12px;border:1px solid #f0e8ec;">No registered clients found.</div>`;
        if(clientCountEl) clientCountEl.textContent = "0 registered clients";
        return;
    }

    let html = '';
    clientsCache.forEach(clientData => {
        const clientId = clientData.id;
        const initial = (clientData.fullName || "Unknown").charAt(0).toUpperCase();
        const preferences = (clientData.preferences && Array.isArray(clientData.preferences)) ? clientData.preferences : [];
        const { visits, spent } = computeClientStats(clientData);

        html += `
            <div class="client-card" data-id="${clientId}">
                <div class="avatar-lg">${initial}</div>
                <div class="client-info">
                    <div class="name">${clientData.fullName || "N/A"}</div>
                    <div class="email">${clientData.email || "N/A"}</div>
                    <div class="stats">
                        <span><i class="fas fa-calendar-check"></i> ${visits} Visits</span>
                        <span><i class="fas fa-tag"></i> ${preferences.slice(0, 2).join(', ') || 'No prefs'}</span>
                    </div>
                </div>
                <div class="client-spent">₱${spent.toLocaleString()}</div>
            </div>
        `;
    });

    clientGrid.innerHTML = html;
    if(clientCountEl) clientCountEl.textContent = `${clientsCache.length} registered clients`;

    document.querySelectorAll('.client-card').forEach(card => {
        card.addEventListener('click', function() {
            document.querySelectorAll('.client-card').forEach(el => el.classList.remove('active'));
            this.classList.add('active');
            renderClientDetail(this.dataset.id);
        });
    });

    const activeCard = document.querySelector('.client-card.active');
    if (activeCard) {
        renderClientDetail(activeCard.dataset.id);
    } else if (clientsCache.length > 0) {
        const firstCard = clientGrid.querySelector('.client-card');
        if(firstCard) {
            firstCard.classList.add('active');
            renderClientDetail(firstCard.dataset.id);
        }
    }
}

// -------------------------------------------------------------
// 5. RENDER CLIENT DETAIL
// -------------------------------------------------------------
function legacyRenderClientDetail(clientId) {
    const client = clientsCache.find(c => c.id === clientId);
    if (!client) return;

    document.querySelectorAll('.client-card').forEach(el => el.classList.remove('active'));
    const activeCard = document.querySelector(`.client-card[data-id="${clientId}"]`);
    if (activeCard) activeCard.classList.add('active');

    const { visits, spent } = computeClientStats(client);

    let historyHtml = '<div style="color:#888;text-align:center;padding:10px;">No visit history available.</div>';
    if (client.history && client.history.length > 0) {
        historyHtml = client.history.map(h => `
            <div class="history-item">
                <div class="h-left">
                    <div class="h-name">${h.service || 'Service'}</div>
                    <div class="h-meta">${h.date || 'N/A'} · ${h.staff || 'N/A'}</div>
                </div>
                <div class="h-right">
                    <div class="h-amount">₱${(h.amount || 0).toLocaleString()}</div>
                    <div class="h-status"><span class="status-badge ${h.status || 'completed'}">${h.status || 'completed'}</span></div>
                </div>
            </div>
        `).join('');
    }

    let joinedDate = 'N/A';
    if (client.createdAt && typeof client.createdAt.toDate === 'function') {
        joinedDate = client.createdAt.toDate().toLocaleDateString();
    }

    customerDetailEl.innerHTML = `
        <div class="client-detail-card">
            <div class="detail-header">
                <div class="avatar-xl">${(client.fullName || 'U').charAt(0).toUpperCase()}</div>
                <div class="detail-title">
                    <h2>${client.fullName || 'Unknown'}</h2>
                    <p>${client.email || 'N/A'}</p>
                    <div class="member-since">Member since ${joinedDate}</div>
                </div>
            </div>
            <div class="detail-stats">
                <div class="stat-item"><div class="stat-label">Total Visits</div><div class="stat-value">${visits}</div></div>
                <div class="stat-item"><div class="stat-label">Total Spent</div><div class="stat-value"><span class="currency">₱</span>${spent.toLocaleString()}</div></div>
            </div>
            <div class="detail-section">
                <span class="section-label">Preferences</span>
                <div class="tag-group">
                    ${(client.preferences && client.preferences.length > 0) ? client.preferences.map(p => `<span class="tag">${p}</span>`).join('') : '<span class="text-muted">None</span>'}
                </div>
            </div>
            <div class="detail-section detail-history">
                <span class="section-label">History</span>
                ${historyHtml}
            </div>
        </div>
    `;
}

// -------------------------------------------------------------
// 6. ADD INDIVIDUAL CUSTOM SERVICE FEATURE
// -------------------------------------------------------------
function renderClientGrid(renderSelectedDetail = true) {
    if (!clientGrid) return;

    if (!clientsCache.length) {
        clientGrid.innerHTML = '<div class="customer-empty-state">No registered clients found.</div>';
        if (clientCountEl) clientCountEl.textContent = '0 registered clients';
        return;
    }

    const search = (clientSearchInput?.value || '').trim().toLowerCase();
    const visibleClients = clientsCache.filter(client =>
        !search || `${client.fullName || ''} ${client.email || ''}`.toLowerCase().includes(search)
    );
    if (!visibleClients.length) {
        clientGrid.innerHTML = '<div class="customer-empty-state">No customers match your search.</div>';
        if (clientCountEl) clientCountEl.textContent = `${clientsCache.length} registered clients`;
        return;
    }

    clientGrid.innerHTML = visibleClients.map(client => {
        const initial = (client.fullName || client.email || 'U').trim().charAt(0).toUpperCase();
        const avatar = client.photoURL
            ? `<img src="${escapeCustomerHtml(client.photoURL)}" alt="" />`
            : escapeCustomerHtml(initial);
        const stats = computeClientStats(client);
        return `
            <button type="button" class="client-card ${client.id === selectedClientId ? 'active' : ''}" data-id="${escapeCustomerHtml(client.id)}" aria-label="View ${escapeCustomerHtml(client.fullName || client.email || 'customer')} profile">
                <div class="avatar-lg">${avatar}</div>
                <div class="client-info">
                    <div class="name">${customerValue(client.fullName)}</div>
                    <div class="email">${customerValue(client.email)}</div>
                    <div class="stats"><span><i class="fas fa-calendar-check"></i> ${stats.visits} Visits</span></div>
                </div>
                <div class="client-spent">&#8369;${stats.spent.toLocaleString()}</div>
            </button>`;
    }).join('');

    if (clientCountEl) clientCountEl.textContent = `${clientsCache.length} registered clients`;
    clientGrid.querySelectorAll('.client-card').forEach(card => {
        card.addEventListener('click', () => selectClient(card.dataset.id));
    });

    if (selectedClientId && clientsCache.some(client => client.id === selectedClientId)) {
        if (renderSelectedDetail) renderClientDetail(selectedClientId);
    } else if (!selectedClientId) {
        selectClient(visibleClients[0].id);
    }
}

function selectClient(clientId) {
    if (!clientsCache.some(client => client.id === clientId)) return;
    selectedClientId = clientId;
    renderCustomerLoading();
    renderClientGrid(false);
    listenToSelectedClientNotes(clientId);
    requestAnimationFrame(() => {
        if (selectedClientId === clientId) renderClientDetail(clientId);
    });
}

function renderClientDetail(clientId) {
    const client = clientsCache.find(item => item.id === clientId);
    if (!client || !customerDetailEl || selectedClientId !== clientId) return;

    const { visits, spent } = computeClientStats(client);
    const appointments = selectedClientAppointments(client)
        .slice()
        .sort((a, b) => parseApptDate(b) - parseApptDate(a));
    const completed = appointments.filter(appt => isRevenueEligibleStatus(appt.status));
    const lastVisit = completed[0] ? customerDate(parseApptDate(completed[0])) : '';
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const upcoming = appointments
        .filter(appt => {
            const date = parseApptDate(appt);
            const status = apptStatus(appt);
            return !Number.isNaN(date.getTime()) && date >= today && (status === 'pending' || status === 'confirmed');
        })
        .sort((a, b) => parseApptDate(a) - parseApptDate(b))[0];

    const historyHtml = appointments.length ? appointments.slice(0, 6).map(appt => {
        const metadata = [
            customerDate(parseApptDate(appt), { year: 'numeric', month: 'short', day: 'numeric' }),
            appt.bookingTime || appt.time || appt.appointmentTime || '',
            appt.staffName || appt.stylistName || ''
        ].filter(Boolean).map(escapeCustomerHtml).join(' &middot; ');
        const payment = [appt.paymentMethod || appt.reservationPaymentMethod || '', appointmentPaymentStatus(appt)]
            .filter(Boolean).map(escapeCustomerHtml).join(' &middot; ');
        const amount = appt.price === undefined || appt.price === null || appt.price === ''
            ? ''
            : `<div class="h-amount">&#8369;${parsePrice(appt.price).toLocaleString()}</div>`;
        return `<div class="history-item">
            <div class="h-left"><div class="h-name">${customerValue(appt.serviceName || appt.service)}</div><div class="h-meta">${metadata}</div>${payment ? `<div class="h-payment">${payment}</div>` : ''}</div>
            <div class="h-right">${amount}<div class="h-status">${customerValue(appt.status)}</div></div>
        </div>`;
    }).join('') : '<div class="customer-history-empty">No visit history available.</div>';

    const notesHtml = selectedClientNotes === null
        ? '<div class="text-muted">Notes could not be loaded.</div>'
        : selectedClientNotes.length
            ? selectedClientNotes.map(note => `<div class="customer-note">${customerValue(note.text)}${note.authorName ? `<span>${escapeCustomerHtml(note.authorName)}</span>` : ''}</div>`).join('')
            : '<div class="text-muted">No client notes available.</div>';
    const avatar = client.photoURL
        ? `<img src="${escapeCustomerHtml(client.photoURL)}" alt="${escapeCustomerHtml(client.fullName || 'Customer')} profile photo" />`
        : escapeCustomerHtml((client.fullName || client.email || 'U').charAt(0).toUpperCase());
    const upcomingHtml = upcoming ? `<div class="upcoming-appointment">
        <strong>${customerValue(upcoming.serviceName || upcoming.service)}</strong>
        <span>${customerDate(parseApptDate(upcoming))}${upcoming.bookingTime || upcoming.time ? ` &middot; ${escapeCustomerHtml(upcoming.bookingTime || upcoming.time)}` : ''}</span>
        ${(upcoming.staffName || upcoming.stylistName) ? `<span>Stylist: ${customerValue(upcoming.staffName || upcoming.stylistName)}</span>` : ''}
        <span>${customerValue(upcoming.status)}</span>
    </div>` : '';

    customerDetailEl.innerHTML = `
        <article class="client-detail-card">
            <div class="customer-profile-label">Customer Profile</div>
            <div class="detail-header">
                <div class="avatar-xl">${avatar}</div>
                <div class="detail-title">
                    <h2>${customerValue(client.fullName || client.email)}</h2>
                    <p>Customer</p>
                    <div class="email-line">${customerValue(client.email)}</div>
                    <div class="member-since">Member since ${customerDate(client.createdAt || client.memberSince)}</div>
                </div>
            </div>
            <section class="detail-section customer-personal-info">
                <span class="section-label">Personal Information</span>
                <dl class="profile-data-list">
                    <div><dt>Full Name</dt><dd>${customerValue(client.fullName)}</dd></div>
                    <div><dt>Phone Number</dt><dd>${customerValue(client.phone)}</dd></div>
                    <div><dt>Email Address</dt><dd>${customerValue(client.email)}</dd></div>
                    <div><dt>Date of Birth</dt><dd>${customerDate(client.dateOfBirth)}</dd></div>
                    <div><dt>Gender</dt><dd>${customerValue(client.gender)}</dd></div>
                </dl>
            </section>
            <section class="detail-section">
                <span class="section-label">Customer Summary</span>
                <div class="detail-stats">
                    <div class="stat-item"><div class="stat-value">${visits}</div><div class="stat-label">Total Visits</div></div>
                    <div class="stat-item"><div class="stat-value">&#8369;${spent.toLocaleString()}</div><div class="stat-label">Total Spent</div></div>
                </div>
                ${lastVisit ? `<div class="visit-summary-row"><span>Last Visit</span><strong>${lastVisit}</strong></div>` : ''}
            </section>
            ${upcomingHtml ? `<section class="detail-section"><span class="section-label">Upcoming Appointment</span>${upcomingHtml}</section>` : ''}
            <section class="detail-section detail-history"><span class="section-label">Recent Visits</span>${historyHtml}</section>
            <section class="detail-section customer-notes"><span class="section-label">Client Notes</span>${notesHtml}</section>
        </article>`;
}

clientSearchInput?.addEventListener('input', () => renderClientGrid(false));

const addServiceImageInput = document.getElementById('svcImage');
const addServiceImagePreview = document.getElementById('svcImagePreview');
const serviceImageEditorInput = document.getElementById('serviceImageEditorInput');
let pendingServiceImageId = '';

function updateServiceImagePreview() {
    const file = addServiceImageInput?.files?.[0];
    if (!addServiceImagePreview) return;
    if (!file) {
        addServiceImagePreview.innerHTML = '<i class="fas fa-image"></i><span>No image selected</span>';
        return;
    }
    const previewUrl = URL.createObjectURL(file);
    addServiceImagePreview.innerHTML = `<img src="${previewUrl}" alt="Selected service image">`;
    addServiceImagePreview.querySelector('img')?.addEventListener('load', () => URL.revokeObjectURL(previewUrl), { once: true });
}

function serviceImageUrl(service) {
    return service?.imageUrl || service?.imageURL || service?.image || service?.thumbnail || service?.servicePhoto || '';
}

addServiceImageInput?.addEventListener('change', updateServiceImagePreview);

const addServiceForm = document.getElementById("addServiceForm");
if (addServiceForm) {
    addServiceForm.addEventListener("submit", async (e) => {
        e.preventDefault();

        const serviceName = document.getElementById("svcName").value;
        const category = document.getElementById("svcCategory").value;
        const price = parseFloat(document.getElementById("svcPrice").value);
        const duration = document.getElementById("svcDuration").value;
        const imageFile = addServiceImageInput?.files?.[0];

        try {
            // Save the service first. An optional image must never block the
            // original Add Service workflow if Storage is unavailable.
            const serviceRef = await addDoc(collection(db, "services"), {
                serviceName: serviceName,
                category: category,
                price: price,
                duration: duration,
                createdAt: new Date()
            });

            let imageNotice = '';
            if (imageFile) {
                try {
                    const imageUrl = await saveServiceImage(serviceRef.id, imageFile);
                    await updateDoc(serviceRef, {
                        imageUrl,
                        imageUpdatedAt: serverTimestamp()
                    });
                } catch (imageError) {
                    console.error('Service image upload error:', imageError);
                    imageNotice = '\n\nThe service was added, but its image could not be saved: ' + imageError.message;
                }
            }

            alert(`Service "${serviceName}" added successfully!${imageNotice}`);
            addServiceForm.reset();
            updateServiceImagePreview();
            closeAddServiceModal();

        } catch (error) {
            console.error("Add Service Error:", error);
            alert("Failed to add service: " + error.message);
        }
    });
}

// -------------------------------------------------------------
// 7. REAL-TIME SERVICES LISTENER — CATEGORY CARDS · SORT · PAGINATION
// -------------------------------------------------------------
// Admin → Services view only. Same Firestore collection ("services"),
// same document fields, same Add / Delete / Change-Image CRUD.
// This section only reorganizes HOW the loaded services are displayed.
const servicesGridEl = document.getElementById("servicesGrid");
const servicesPaginationEl = document.getElementById("servicesPagination");
const serviceCategoryGridEl = document.getElementById("serviceCategoryGrid");
const serviceSearchInputEl = document.getElementById("serviceSearchInput");
const serviceSortSelectEl = document.getElementById("serviceSortSelect");
const serviceListTitleEl = document.getElementById("serviceListTitle");
const serviceResultSummaryEl = document.getElementById("serviceResultSummary");
const serviceCountEl = document.getElementById("serviceCount");

const SERVICES_PER_PAGE = 6;
// Carried over from the old table view so category cards keep the same order.
const SERVICE_CATEGORY_PRIORITY = ['Hair Color', 'Mens Hair Color', 'Hair Treatment', 'Hair Rebond'];

let adminAllServices = [];           // latest onSnapshot payload (id from doc.id)
let adminSelectedCategoryKey = '';   // normalized key; '' = All Services
let adminServiceSearchTerm = '';
let adminServiceSortKey = 'name-asc'; // default: Name A–Z
let adminServiceCurrentPage = 1;
let adminServiceTotalPages = 1;

// Category helpers. Normalization is for DISPLAY/GROUPING ONLY — the
// stored Firestore `category` value is never rewritten.
function getServiceCategoryKey(service) {
    return String(service?.category ?? '').trim().toLowerCase();
}

function getServiceCategoryLabel(service) {
    const raw = String(service?.category ?? '').trim();
    return raw || 'Uncategorized';
}

function getServiceName(service) {
    return String(service?.serviceName || service?.name || 'N/A');
}

function getServicePrice(service) {
    const value = Number(service?.price);
    return Number.isFinite(value) ? value : 0;
}

function getServiceCreatedTime(service) {
    const raw = service?.createdAt;
    if (!raw) return 0;
    if (typeof raw === 'number') return raw;
    if (raw instanceof Date) return raw.getTime() || 0;
    if (typeof raw.toDate === 'function') {
        const date = raw.toDate();
        return date instanceof Date ? (date.getTime() || 0) : 0;
    }
    if (typeof raw === 'string') {
        const parsed = Date.parse(raw);
        return Number.isNaN(parsed) ? 0 : parsed;
    }
    return 0;
}

function compareServiceText(a, b) {
    return String(a).localeCompare(String(b), undefined, { sensitivity: 'base' });
}

function sortAdminServices(list) {
    const sorted = list.slice();
    switch (adminServiceSortKey) {
        case 'name-desc':
            return sorted.sort((a, b) => compareServiceText(getServiceName(b), getServiceName(a)));
        case 'price-asc':
            return sorted.sort((a, b) => getServicePrice(a) - getServicePrice(b));
        case 'price-desc':
            return sorted.sort((a, b) => getServicePrice(b) - getServicePrice(a));
        case 'category-asc':
            return sorted.sort((a, b) => {
                const byCategory = compareServiceText(getServiceCategoryLabel(a), getServiceCategoryLabel(b));
                return byCategory !== 0 ? byCategory : compareServiceText(getServiceName(a), getServiceName(b));
            });
        case 'newest':
            return sorted.sort((a, b) => getServiceCreatedTime(b) - getServiceCreatedTime(a));
        case 'oldest':
            return sorted.sort((a, b) => getServiceCreatedTime(a) - getServiceCreatedTime(b));
        case 'name-asc':
        default:
            return sorted.sort((a, b) => compareServiceText(getServiceName(a), getServiceName(b)));
    }
}

// Pipeline: category filter → search filter → sort → (paginate in render).
function getFilteredAdminServices() {
    const term = adminServiceSearchTerm.trim().toLowerCase();
    return adminAllServices.filter(service => {
        if (adminSelectedCategoryKey && getServiceCategoryKey(service) !== adminSelectedCategoryKey) return false;
        if (!term) return true;
        return getServiceName(service).toLowerCase().includes(term)
            || String(service?.category ?? '').toLowerCase().includes(term)
            || String(service?.semiCategory ?? '').toLowerCase().includes(term)
            || String(service?.duration ?? '').toLowerCase().includes(term);
    });
}

// Category cards are rebuilt from the loaded array on every render, so
// counts always reflect adds/deletes/category edits automatically.
function renderServiceCategoryCards() {
    if (!serviceCategoryGridEl) return;
    const groups = new Map();
    adminAllServices.forEach(service => {
        const key = getServiceCategoryKey(service);
        const existing = groups.get(key);
        if (existing) {
            existing.count += 1;
        } else {
            groups.set(key, { key, label: getServiceCategoryLabel(service), count: 1 });
        }
    });
    const priorityRank = (label) => {
        const index = SERVICE_CATEGORY_PRIORITY.findIndex(cat => cat.toLowerCase() === label.toLowerCase());
        return index === -1 ? SERVICE_CATEGORY_PRIORITY.length : index;
    };
    const ordered = Array.from(groups.values()).sort((a, b) => {
        const rankDiff = priorityRank(a.label) - priorityRank(b.label);
        return rankDiff !== 0 ? rankDiff : compareServiceText(a.label, b.label);
    });

    const total = adminAllServices.length;
    const allActive = adminSelectedCategoryKey === '';
    let html = `<button type="button" class="svc-category-card${allActive ? ' active' : ''}" data-category-key=""${allActive ? ' aria-current="true"' : ''}>
                <span class="svc-category-name">All Services</span>
                <span class="svc-category-count">${total} Service${total === 1 ? '' : 's'}</span>
            </button>`;
    ordered.forEach(group => {
        const active = adminSelectedCategoryKey === group.key;
        html += `<button type="button" class="svc-category-card${active ? ' active' : ''}" data-category-key="${escapeAdminHtml(group.key)}"${active ? ' aria-current="true"' : ''}>
                <span class="svc-category-name">${escapeAdminHtml(group.label)}</span>
                <span class="svc-category-count">${group.count} Service${group.count === 1 ? '' : 's'}</span>
            </button>`;
    });
    serviceCategoryGridEl.innerHTML = html;
}

function renderServicesPagination() {
    if (!servicesPaginationEl) return;
    if (adminServiceTotalPages <= 1) {
        servicesPaginationEl.innerHTML = '';
        return;
    }
    let html = `<button type="button" class="svc-page-btn" data-page="prev"${adminServiceCurrentPage <= 1 ? ' disabled' : ''}>&lsaquo; Previous</button>`;
    for (let page = 1; page <= adminServiceTotalPages; page++) {
        const active = page === adminServiceCurrentPage;
        html += `<button type="button" class="svc-page-btn${active ? ' active' : ''}" data-page="${page}"${active ? ' aria-current="page"' : ''}>${page}</button>`;
    }
    html += `<button type="button" class="svc-page-btn" data-page="next"${adminServiceCurrentPage >= adminServiceTotalPages ? ' disabled' : ''}>Next &rsaquo;</button>`;
    servicesPaginationEl.innerHTML = html;
}

function renderAdminServices() {
    renderServiceCategoryCards();

    if (serviceCountEl) serviceCountEl.textContent = adminAllServices.length + ' services';

    const filtered = sortAdminServices(getFilteredAdminServices());
    const total = filtered.length;
    adminServiceTotalPages = Math.max(1, Math.ceil(total / SERVICES_PER_PAGE));
    // Clamp so deleting/searching away the current page never leaves an empty view.
    if (adminServiceCurrentPage > adminServiceTotalPages) adminServiceCurrentPage = adminServiceTotalPages;
    if (adminServiceCurrentPage < 1) adminServiceCurrentPage = 1;

    const startIndex = (adminServiceCurrentPage - 1) * SERVICES_PER_PAGE;
    const pageItems = filtered.slice(startIndex, startIndex + SERVICES_PER_PAGE);

    let selectedLabel = 'All Services';
    if (adminSelectedCategoryKey) {
        const match = adminAllServices.find(service => getServiceCategoryKey(service) === adminSelectedCategoryKey);
        selectedLabel = match ? getServiceCategoryLabel(match) : 'Uncategorized';
    }
    if (serviceListTitleEl) serviceListTitleEl.textContent = selectedLabel;

    if (serviceResultSummaryEl) {
        serviceResultSummaryEl.textContent = total > 0
            ? `Showing ${startIndex + 1}\u2013${startIndex + pageItems.length} of ${total} service${total === 1 ? '' : 's'}`
            : '';
    }

    if (servicesGridEl) {
        if (total === 0) {
            let message;
            if (adminAllServices.length === 0) {
                message = "No services yet. Click '+ Add Service' or 'Auto-Seed' to populate.";
            } else if (adminServiceSearchTerm.trim()) {
                message = 'No services match your search.';
            } else {
                message = 'No services found in this category.';
            }
            servicesGridEl.innerHTML = `<div class="svc-empty-state">${message}</div>`;
        } else {
            let html = '';
            pageItems.forEach(service => {
                const imageUrl = serviceImageUrl(service);
                const name = getServiceName(service);
                const metaBits = [];
                if (service.semiCategory) metaBits.push(String(service.semiCategory));
                if (service.sessionType) metaBits.push(String(service.sessionType));
                const metaHtml = metaBits.length
                    ? `<div class="svc-card-meta">${metaBits.map(bit => `<span>${escapeAdminHtml(bit)}</span>`).join('')}</div>`
                    : '';
                const imageHtml = imageUrl
                    ? `<div class="svc-card-image"><img src="${escapeAdminHtml(imageUrl)}" alt="${escapeAdminHtml(name)} image" loading="lazy"></div>`
                    : '<div class="svc-card-image"><i class="fas fa-image svc-card-image-empty"></i></div>';
                html += `<article class="svc-card" data-id="${escapeAdminHtml(service.id)}">
                ${imageHtml}
                <div class="svc-card-body">
                    <span class="svc-card-category">${escapeAdminHtml(getServiceCategoryLabel(service))}</span>
                    <h4 class="svc-card-title">${escapeAdminHtml(name)}</h4>
                    ${metaHtml}
                    <div class="svc-card-facts">
                        <span class="svc-card-price">₱${getServicePrice(service).toLocaleString()}</span>
                        <span class="svc-card-duration"><i class="fas fa-clock"></i> ${escapeAdminHtml(service.duration || '-')}</span>
                    </div>
                </div>
                <div class="svc-card-actions">
                    <button type="button" class="btn-outline btn-sm svc-service-image-btn" data-id="${escapeAdminHtml(service.id)}"><i class="fas fa-image"></i> ${imageUrl ? 'Change' : 'Add'} Image</button>
                    <button type="button" class="btn-danger-sm svc-service-delete-btn" data-id="${escapeAdminHtml(service.id)}">Delete</button>
                </div>
            </article>`;
            });
            servicesGridEl.innerHTML = html;
        }
    }

    renderServicesPagination();
}

const adminServicesCollection = collection(db, "services");
onSnapshot(adminServicesCollection, (snapshot) => {
    const servicesCache = [];
    snapshot.forEach((docSnap) => {
        const serviceData = docSnap.data() || {};
        serviceData.id = docSnap.id;
        servicesCache.push(serviceData);
    });
    adminAllServices = servicesCache;
    renderAdminServices();
}, (error) => {
    console.error("Error loading services:", error);
    if (serviceCategoryGridEl) serviceCategoryGridEl.innerHTML = '<div class="svc-empty-state">Error loading categories.</div>';
    if (servicesGridEl) servicesGridEl.innerHTML = '<div class="svc-empty-state" style="color:#b02a37;">Error loading services.</div>';
});

// ─── Delegated listeners — attached ONCE, not per render ───
serviceCategoryGridEl?.addEventListener('click', (event) => {
    const card = event.target.closest('.svc-category-card');
    if (!card) return;
    const key = card.dataset.categoryKey || '';
    if (key === adminSelectedCategoryKey) return;
    adminSelectedCategoryKey = key;
    adminServiceCurrentPage = 1;
    renderAdminServices();
});

servicesGridEl?.addEventListener('click', async (event) => {
    const deleteBtn = event.target.closest('.svc-service-delete-btn');
    if (deleteBtn) {
        const id = deleteBtn.dataset.id;
        if (!id) return;
        if (confirm('Delete this service permanently?')) {
            try {
                await deleteDoc(doc(db, "services", id));
                showToast('Deleted', 'Service removed successfully.', 'success');
            } catch (error) {
                console.error("Delete error:", error);
                showToast('Error', 'Failed to delete service.', 'error');
            }
        }
        return;
    }
    const imageBtn = event.target.closest('.svc-service-image-btn');
    if (imageBtn) {
        pendingServiceImageId = imageBtn.dataset.id || '';
        if (!pendingServiceImageId || !serviceImageEditorInput) return;
        serviceImageEditorInput.value = '';
        serviceImageEditorInput.click();
    }
});

servicesPaginationEl?.addEventListener('click', (event) => {
    const btn = event.target.closest('.svc-page-btn');
    if (!btn || btn.disabled) return;
    const target = btn.dataset.page;
    let nextPage = adminServiceCurrentPage;
    if (target === 'prev') nextPage = adminServiceCurrentPage - 1;
    else if (target === 'next') nextPage = adminServiceCurrentPage + 1;
    else nextPage = parseInt(target, 10);
    if (!Number.isFinite(nextPage)) return;
    if (nextPage < 1) nextPage = 1;
    if (nextPage > adminServiceTotalPages) nextPage = adminServiceTotalPages;
    if (nextPage === adminServiceCurrentPage) return;
    adminServiceCurrentPage = nextPage;
    renderAdminServices();
    servicesGridEl?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
});

serviceSearchInputEl?.addEventListener('input', () => {
    adminServiceSearchTerm = serviceSearchInputEl.value || '';
    adminServiceCurrentPage = 1;
    renderAdminServices();
});

serviceSortSelectEl?.addEventListener('change', () => {
    adminServiceSortKey = serviceSortSelectEl.value || 'name-asc';
    adminServiceCurrentPage = 1;
    renderAdminServices();
});

// ─── ADD SERVICE MODAL (form fields & submit logic unchanged) ───
const addServiceModalOverlayEl = document.getElementById('addServiceModalOverlay');
const openAddServiceModalBtn = document.getElementById('openAddServiceModalBtn');
const addServiceModalCloseBtn = document.getElementById('addServiceModalClose');
const addServiceCancelBtnEl = document.getElementById('addServiceCancelBtn');

function openAddServiceModal() {
    if (!addServiceModalOverlayEl) return;
    addServiceModalOverlayEl.style.display = 'flex';
    document.getElementById('svcName')?.focus();
}

function closeAddServiceModal() {
    if (addServiceModalOverlayEl) addServiceModalOverlayEl.style.display = 'none';
}

openAddServiceModalBtn?.addEventListener('click', openAddServiceModal);
addServiceModalCloseBtn?.addEventListener('click', closeAddServiceModal);
addServiceCancelBtnEl?.addEventListener('click', closeAddServiceModal);
addServiceModalOverlayEl?.addEventListener('click', (event) => {
    if (event.target === addServiceModalOverlayEl) closeAddServiceModal();
});
document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && addServiceModalOverlayEl && addServiceModalOverlayEl.style.display === 'flex') {
        closeAddServiceModal();
    }
});

serviceImageEditorInput?.addEventListener('change', async () => {
    const file = serviceImageEditorInput.files?.[0];
    const serviceId = pendingServiceImageId;
    serviceImageEditorInput.value = '';
    pendingServiceImageId = '';
    if (!file || !serviceId) return;

    try {
        const imageUrl = await saveServiceImage(serviceId, file);
        await updateDoc(doc(db, 'services', serviceId), {
            imageUrl,
            imageUpdatedAt: serverTimestamp()
        });
        showToast('Service image updated', 'The customer service card will now use this image.', 'success');
    } catch (error) {
        console.error('Service image update error:', error);
        showToast('Image not updated', error.message || 'Please try another image.', 'error');
    }
});

// -------------------------------------------------------------
// 8. AUTO-SEED OFFICIAL PRICELIST (WITH PURGE & PREVENT DUPLICATES)
// -------------------------------------------------------------
const seedBtn = document.getElementById("seedServicesBtn");
if (seedBtn) {
    seedBtn.addEventListener("click", async () => {
        // ⚠️ CRITICAL: Purge existing to prevent duplicates
        if (!confirm("⚠️ This will DELETE all existing services in your database and reseed the entire catalog with the official pricelist. Proceed?")) return;

        // Master Seed Configuration (Normalized Title Case)
            const servicesToSeed = [
            // --- SEMI PERMANENT EYEBROWS ---
            { id: 'eyebrows-microblading', name: "Men's Microblading Brow", category: "Semi permanent Eyebrows", semiCategory: null, basePrice: 3499, duration: "~2 hrs", variants: [{ sessionType: "Full sessions", price: 6499, duration: "Full course (~4 hrs)" }] },
            { id: 'eyebrows-nano', name: "Men's Nano Brows", category: "Semi permanent Eyebrows", semiCategory: null, basePrice: 5999, duration: "~2 hrs", variants: [{ sessionType: "Full sessions", price: 10499, duration: "Full course (~4 hrs)" }] },
            { id: 'eyebrows-ombre', name: "Ombre Brow", category: "Semi permanent Eyebrows", semiCategory: null, basePrice: 3999, duration: "~2 hrs", variants: [{ sessionType: "Full sessions", price: 6999, duration: "Full course (~4 hrs)" }] },
            { id: 'eyebrows-hybrid-ombre', name: "Hybrid Ombre Brows", category: "Semi permanent Eyebrows", semiCategory: null, basePrice: 4499, duration: "~2 hrs", variants: [{ sessionType: "Full sessions", price: 7999, duration: "Full course (~4 hrs)" }] },
            { id: 'eyebrows-korean-nano', name: "Korean Nano Brows", category: "Semi permanent Eyebrows", semiCategory: null, basePrice: 5499, duration: "~2 hrs", variants: [{ sessionType: "Full sessions", price: 9999, duration: "Full course (~4 hrs)" }] },
            { id: 'eyebrows-korean-combo', name: "Korean Nano Combo Brows", category: "Semi permanent Eyebrows", semiCategory: null, basePrice: 6499, duration: "~2 hrs", variants: [{ sessionType: "Full sessions", price: 11999, duration: "Full course (~4 hrs)" }] },
            { id: 'eyebrows-9d', name: "9D Microblading", category: "Semi permanent Eyebrows", semiCategory: null, basePrice: 1999, duration: "~1.5 hrs", variants: [{ sessionType: "Full sessions", price: 2999, duration: "Full course (~3 hrs)" }] },
            { id: 'eyebrows-hybrid', name: "Hybrid Microblading", category: "Semi permanent Eyebrows", semiCategory: null, basePrice: 2999, duration: "~1.5 hrs", variants: [{ sessionType: "Full sessions", price: 4999, duration: "Full course (~3 hrs)" }] },

            // --- HAIR REMOVAL (DIODE) ---
            { id: 'hair-removal-ua', name: "Under Arms", category: "Hair Removal (Diode)", semiCategory: null, basePrice: 599, duration: "~30 mins", variants: [{ sessionType: "5+1 Package", price: 2999, duration: "Package (6 sessions)" }] },
            { id: 'hair-removal-knee', name: "Knee", category: "Hair Removal (Diode)", semiCategory: null, basePrice: 1499, duration: "~45 mins", variants: [{ sessionType: "5+1 Package", price: 7499, duration: "Package (6 sessions)" }] },
            { id: 'hair-removal-elbow', name: "Elbow", category: "Hair Removal (Diode)", semiCategory: null, basePrice: 999, duration: "~30 mins", variants: [{ sessionType: "5+1 Package", price: 4999, duration: "Package (6 sessions)" }] },
            { id: 'hair-removal-bikini', name: "Bikini Area", category: "Hair Removal (Diode)", semiCategory: null, basePrice: 1499, duration: "~45 mins", variants: [{ sessionType: "5+1 Package", price: 7499, duration: "Package (6 sessions)" }] },
            { id: 'hair-removal-arms', name: "Arms", category: "Hair Removal (Diode)", semiCategory: null, basePrice: 999, duration: "~30 mins", variants: [{ sessionType: "5+1 Package", price: 4999, duration: "Package (6 sessions)" }] },
            { id: 'hair-removal-halfleg', name: "Half Leg", category: "Hair Removal (Diode)", semiCategory: null, basePrice: 799, duration: "~45 mins", variants: [{ sessionType: "5+1 Package", price: 3999, duration: "Package (6 sessions)" }] },
            { id: 'hair-removal-face', name: "Face", category: "Hair Removal (Diode)", semiCategory: null, basePrice: 799, duration: "~30 mins", variants: [{ sessionType: "5+1 Package", price: 3999, duration: "Package (6 sessions)" }] },

            // --- ✅ CORRECTED WHITENING SPOTS (PICO WHITENING) ---
            { id: 'whitening-ua', name: "Under Arms", category: "Whitening Spots (Pico)", semiCategory: null, basePrice: 999, duration: "~45 mins", variants: [{ sessionType: "5+1 Package", price: 4999, duration: "Package (6 sessions)" }] },
            { id: 'whitening-knee', name: "Knee", category: "Whitening Spots (Pico)", semiCategory: null, basePrice: 1499, duration: "~45 mins", variants: [{ sessionType: "5+1 Package", price: 7499, duration: "Package (6 sessions)" }] },
            { id: 'whitening-elbow', name: "Elbow", category: "Whitening Spots (Pico)", semiCategory: null, basePrice: 999, duration: "~45 mins", variants: [{ sessionType: "5+1 Package", price: 4999, duration: "Package (6 sessions)" }] },
            { id: 'whitening-bikini', name: "Bikini Area", category: "Whitening Spots (Pico)", semiCategory: null, basePrice: 1499, duration: "~45 mins", variants: [{ sessionType: "5+1 Package", price: 7499, duration: "Package (6 sessions)" }] },

            // --- FACIAL TREATMENT (SEMI-CATEGORY: FOR GLOWING & BRIGHTENING) ---
            { id: 'facial-hydra', name: "Hydra Facial", category: "Facial Treatment", semiCategory: "For Glowing & Brightening Skin", basePrice: 1299, duration: "~1 hr", variants: [{ sessionType: "5+1 Package", price: 6499, duration: "Package (6 sessions)" }] },
            { id: 'facial-aqua-glass', name: "Aqua Glass Skin Facial", category: "Facial Treatment", semiCategory: "For Glowing & Brightening Skin", basePrice: 1999, duration: "~1 hr", variants: [{ sessionType: "5+1 Package", price: 9999, duration: "Package (6 sessions)" }] },
            { id: 'facial-youth-revival', name: "Youth Revival Facial", category: "Facial Treatment", semiCategory: "For Glowing & Brightening Skin", basePrice: 2499, duration: "~1.5 hrs", variants: [{ sessionType: "5+1 Package", price: 12499, duration: "Package (6 sessions)" }] },
            { id: 'facial-collagen', name: "Collagen Boost Therapy", category: "Facial Treatment", semiCategory: "For Glowing & Brightening Skin", basePrice: 2699, duration: "~1.5 hrs", variants: [{ sessionType: "5+1 Package", price: 13499, duration: "Package (6 sessions)" }] },

            // --- FACIAL TREATMENT (SEMI-CATEGORY: FOR ACNE TREATMENT) ---
            { id: 'facial-acne-reset', name: "Acne Reset Treatment", category: "Facial Treatment", semiCategory: "For Acne Treatment", basePrice: 1299, duration: "~1 hr", variants: [{ sessionType: "5+1 Package", price: 6499, duration: "Package (6 sessions)" }] },
            { id: 'facial-acne-defense', name: "Acne Defense Treatment", category: "Facial Treatment", semiCategory: "For Acne Treatment", basePrice: 1499, duration: "~1 hr", variants: [{ sessionType: "5+1 Package", price: 7499, duration: "Package (6 sessions)" }] },

            // --- FACIAL TREATMENT (SEMI-CATEGORY: OTHER SERVICES) ---
            { id: 'facial-warts', name: "Warts Removal", category: "Facial Treatment", semiCategory: "Other Services", basePrice: 999, duration: "~1 hr", variants: [{ sessionType: "5+1 Package", price: 5999, duration: "Package (6 sessions)" }] },
            { id: 'facial-pimple-inj', name: "Pimple Inj", category: "Facial Treatment", semiCategory: "Other Services", basePrice: 499, duration: "~30 mins", variants: [{ sessionType: "5+1 Package", price: 4999, duration: "Package (6 sessions)" }] },
            { id: 'facial-carbon', name: "Carbon Face Laser", category: "Facial Treatment", semiCategory: "Other Services", basePrice: 1199, duration: "~1 hr", variants: [{ sessionType: "5+1 Package", price: 3499, duration: "Package (6 sessions)" }] },
            { id: 'facial-bb-korean', name: "BB- Korean Glow", category: "Facial Treatment", semiCategory: "Other Services", basePrice: 999, duration: "~1 hr", variants: [] },
            { id: 'facial-bb-blush', name: "BB- Blush", category: "Facial Treatment", semiCategory: "Other Services", basePrice: 699, duration: "~1 hr", variants: [] },
            { id: 'facial-melasma-laser', name: "Melasma Laser", category: "Facial Treatment", semiCategory: "Other Services", basePrice: 1999, duration: "~1 hr", variants: [] },

            // --- MICRONEEDLING ---
            { id: 'micro-vampire', name: "Vampire Facial", category: "Microneedling", semiCategory: null, basePrice: 3499, duration: "~1.5 hrs", variants: [] },
            { id: 'micro-stretchmark', name: "Stretchmark", category: "Microneedling", semiCategory: null, basePrice: 4999, duration: "~1.5 hrs", variants: [] },
            { id: 'micro-under-eyes', name: "Under Eyes", category: "Microneedling", semiCategory: null, basePrice: 3499, duration: "~1.5 hrs", variants: [] },
            { id: 'micro-hair-exosome', name: "Hair Revival Exosome", category: "Microneedling", semiCategory: null, basePrice: 4999, duration: "~1.5 hrs", variants: [] },
            { id: 'micro-korean-exo', name: "Korean Exosomes", category: "Microneedling", semiCategory: null, basePrice: 3999, duration: "~1.5 hrs", variants: [] },
            { id: 'micro-premium-exo', name: "Premium Korean Exosomes", category: "Microneedling", semiCategory: null, basePrice: 5999, duration: "~1.5 hrs", variants: [] },
            { id: 'micro-melasma-therapy', name: "Melasma Therapy", category: "Microneedling", semiCategory: null, basePrice: 3999, duration: "~1.5 hrs", variants: [] },
            { id: 'micro-melasma-bright', name: "Melasma Brightening", category: "Microneedling", semiCategory: null, basePrice: 3499, duration: "~1.5 hrs", variants: [] },
            { id: 'micro-melasma-laser', name: "Melasma Laser", category: "Microneedling", semiCategory: null, basePrice: 1999, duration: "~1.5 hrs", variants: [] },

            // --- COMBO PACKAGES ---
            { id: 'combo-hydra-carbon', name: "Hydra Facial + Carbon Laser", category: "Combo Packages", semiCategory: null, basePrice: 2399, duration: "~2 hrs", variants: [] },
            { id: 'combo-hydra-exo', name: "Hydra Facial + Korean Exosomes", category: "Combo Packages", semiCategory: null, basePrice: 4999, duration: "~2 hrs", variants: [] },
            { id: 'combo-prp-exo', name: "PRP + Korean Exosomes", category: "Combo Packages", semiCategory: null, basePrice: 5999, duration: "~2 hrs", variants: [] },

            // --- HAIR REBOND (LOREAL) ---
            { id: 'rebond-loreal-bot', name: "Loreal Rebond + Brazilian Botox", category: "Hair Rebond", semiCategory: "Loreal", basePrice: 2699, duration: "~3 - 4 hrs", variants: [] },
            { id: 'rebond-loreal-col', name: "Loreal Rebond + Color + Brazilian", category: "Hair Rebond", semiCategory: "Loreal", basePrice: 3099, duration: "~4 - 5 hrs", variants: [] },
            { id: 'rebond-loreal-bal', name: "Loreal Rebond + Balayage + Brazilian", category: "Hair Rebond", semiCategory: "Loreal", basePrice: 3999, duration: "~5 - 6 hrs", variants: [] },

            // --- HAIR REBOND (REGULAR) ---
            { id: 'rebond-reg-bot', name: "Regular Rebond + Brazilian Botox", category: "Hair Rebond", semiCategory: "Regular", basePrice: 2199, duration: "~3 - 4 hrs", variants: [] },
            { id: 'rebond-reg-col', name: "Regular Rebond + Color + Brazilian", category: "Hair Rebond", semiCategory: "Regular", basePrice: 2499, duration: "~4 - 5 hrs", variants: [] },
            { id: 'rebond-reg-bal', name: "Regular Rebond + Balayage + Brazilian", category: "Hair Rebond", semiCategory: "Regular", basePrice: 1499, duration: "~5 - 6 hrs", variants: [] },

            // --- HAIR COLOR (LOREAL) ---
            { id: 'color-loreal-reg', name: "Loreal Regular Color", category: "Hair Color", semiCategory: "Loreal", basePrice: 1999, duration: "~2 - 3 hrs", variants: [] },
            { id: 'color-loreal-bra', name: "Loreal Color + Brazilian", category: "Hair Color", semiCategory: "Loreal", basePrice: 2199, duration: "~3 - 4 hrs", variants: [] },
            { id: 'color-loreal-bal', name: "Loreal Balayage + Brazilian", category: "Hair Color", semiCategory: "Loreal", basePrice: 3099, duration: "~3 - 4 hrs", variants: [] },
            { id: 'color-loreal-3d', name: "Loreal 3D Fashion / Hybrid Color + Botox", category: "Hair Color", semiCategory: "Loreal", basePrice: 4199, duration: "~4 - 5 hrs", variants: [] },

            // --- HAIR COLOR (REGULAR) ---
            { id: 'color-reg-reg', name: "Regular Color", category: "Hair Color", semiCategory: "Regular", basePrice: 999, duration: "~2 - 3 hrs", variants: [] },
            { id: 'color-reg-bra', name: "Regular Color + Brazilian", category: "Hair Color", semiCategory: "Regular", basePrice: 1499, duration: "~3 - 4 hrs", variants: [] },
            { id: 'color-reg-bal', name: "Regular Balayage + Brazilian", category: "Hair Color", semiCategory: "Regular", basePrice: 2499, duration: "~3 - 4 hrs", variants: [] },
            { id: 'color-reg-3d', name: "Regular 3D Fashion / Hybrid Color + Botox", category: "Hair Color", semiCategory: "Regular", basePrice: 2999, duration: "~4 - 5 hrs", variants: [] },

            // --- HAIR TREATMENT (AMAZON PROTEIN) ---
            { id: 'treat-amazon', name: "Amazon Protein Straightening", category: "Hair Treatment", semiCategory: "Amazon Organic Protein Straight", basePrice: 3999, duration: "~3 - 4 hrs", variants: [] },
            { id: 'treat-amazon-loreal', name: "Loreal Color + Amazon Protein Straight", category: "Hair Treatment", semiCategory: "Amazon Organic Protein Straight", basePrice: 5499, duration: "~4 - 5 hrs", variants: [] },
            { id: 'treat-amazon-col', name: "Color + Amazon Protein Straight", category: "Hair Treatment", semiCategory: "Amazon Organic Protein Straight", basePrice: 4699, duration: "~4 - 5 hrs", variants: [] },

            // --- HAIR TREATMENT (BASIC) ---
            { id: 'treat-keratin', name: "Keratin Treatment", category: "Hair Treatment", semiCategory: "Basic Hair Treatment", basePrice: 499, duration: "~1 - 1.5 hrs", variants: [] },
            { id: 'treat-botox', name: "Hair Brazilian Botox", category: "Hair Treatment", semiCategory: "Basic Hair Treatment", basePrice: 799, duration: "~1 - 1.5 hrs", variants: [] },
            { id: 'treat-superflex', name: "SuperFlex Brazilian Botox", category: "Hair Treatment", semiCategory: "Basic Hair Treatment", basePrice: 1299, duration: "~1.5 - 2 hrs", variants: [] },
            { id: 'treat-superflex-k', name: "SuperFlex Keratin Brazilian Botox", category: "Hair Treatment", semiCategory: "Basic Hair Treatment", basePrice: 1499, duration: "~1.5 - 2 hrs", variants: [] },

            // --- SLIMMING (EXILIS) ---
            { id: 'slim-fullface', name: "Full Face", category: "Slimming (Exilis Slimming)", semiCategory: null, basePrice: 1299, duration: "~45 mins", variants: [] },
            { id: 'slim-neck', name: "Neck", category: "Slimming (Exilis Slimming)", semiCategory: null, basePrice: 1299, duration: "~45 mins", variants: [] },
            { id: 'slim-arms', name: "Arms", category: "Slimming (Exilis Slimming)", semiCategory: null, basePrice: 1299, duration: "~45 mins", variants: [] },
            { id: 'slim-tummy', name: "Tummy", category: "Slimming (Exilis Slimming)", semiCategory: null, basePrice: 1499, duration: "~45 mins", variants: [] },
            { id: 'slim-brafat', name: "Bra Fat", category: "Slimming (Exilis Slimming)", semiCategory: null, basePrice: 2999, duration: "~45 mins", variants: [] },
            { id: 'slim-halfbody', name: "Half Body", category: "Slimming (Exilis Slimming)", semiCategory: null, basePrice: 5999, duration: "~1.5 hrs", variants: [{ sessionType: "5+1 Package", price: 29999, duration: "Package (6 sessions)" }] },

            // --- FACE CONTOURING (HIFU) ---
            { id: 'hifu-jawline', name: "Jawline", category: "Face Contouring (Hifu Ulthera)", semiCategory: null, basePrice: 2999, duration: "~45 mins", variants: [] },
            { id: 'hifu-fullface', name: "Full Face", category: "Face Contouring (Hifu Ulthera)", semiCategory: null, basePrice: 4999, duration: "~1 hr", variants: [] },
            { id: 'hifu-jawneck', name: "Jaw & Neck", category: "Face Contouring (Hifu Ulthera)", semiCategory: null, basePrice: 1299, duration: "~45 mins", variants: [{ sessionType: "5+1 Package", price: 6499, duration: "Package (6 sessions)" }] },
            { id: 'hifu-arms', name: "Arms", category: "Face Contouring (Hifu Ulthera)", semiCategory: null, basePrice: 1299, duration: "~45 mins", variants: [] },
            { id: 'hifu-tummy', name: "Tummy", category: "Face Contouring (Hifu Ulthera)", semiCategory: null, basePrice: 1499, duration: "~45 mins", variants: [] },
            { id: 'hifu-brafat', name: "Bra Fat", category: "Face Contouring (Hifu Ulthera)", semiCategory: null, basePrice: 2999, duration: "~45 mins", variants: [] },
            { id: 'hifu-halfbody', name: "Half Body", category: "Face Contouring (Hifu Ulthera)", semiCategory: null, basePrice: 5999, duration: "~1.5 hrs", variants: [{ sessionType: "5+1 Package", price: 29999, duration: "Package (6 sessions)" }] },
        ];

        try {
            seedBtn.disabled = true;
            seedBtn.innerText = "Purging old data...";

            // ⚠️ STEP 1: PURGE ALL EXISTING SERVICES (Clean Slate)
            const servicesSnapshot = await getDocs(collection(db, "services"));
            if (!servicesSnapshot.empty) {
                const deleteBatch = writeBatch(db);
                servicesSnapshot.forEach(docSnap => {
                    deleteBatch.delete(docSnap.ref);
                });
                await deleteBatch.commit();
                console.log(`✅ Deleted ${servicesSnapshot.size} old duplicate services.`);
            }

            seedBtn.innerText = "Seeding fresh data...";

            // ⚠️ STEP 2: SEED NEW SERVICES (Using static IDs to prevent duplicates)
            const batch = writeBatch(db);
            servicesToSeed.forEach(data => {
                const { id, name, category, semiCategory, basePrice, duration, variants } = data;
                const baseRef = doc(db, "services", id);
                
                // Add Base Service
                batch.set(baseRef, {
                    serviceName: name,
                    category: category,
                    semiCategory: semiCategory || null,
                    price: basePrice,
                    duration: duration || "~1 hr",
                    sessionType: "Standard",
                    variantOf: null,
                    createdAt: new Date()
                });

                // Add Variants linked to this Base ID
                variants.forEach((variant, index) => {
                    const variantId = `${id}-package-${index}`;
                    const variantRef = doc(db, "services", variantId);
                    batch.set(variantRef, {
                        serviceName: `${name} (${variant.sessionType})`,
                        category: category,
                        semiCategory: semiCategory || null,
                        price: variant.price,
                        duration: duration || "~1 hr",
                        sessionType: variant.sessionType,
                        variantOf: id,
                        packageNote: variant.duration || null,
                        createdAt: new Date()
                    });
                });
            });

            await batch.commit();
            alert(`Success! All services have been wiped clean and re-seeded with the official catalog.`);
            seedBtn.innerText = "✅ Official Pricelist Seeded";

        } catch (error) {
            console.error("Seeding Error:", error);
            alert("Failed to seed services: " + error.message);
            seedBtn.disabled = false;
            seedBtn.innerText = "⚡ Auto-Seed Official Pricelist";
        }
    });
}

// -------------------------------------------------------------
// 9. REAL-TIME MASTER APPOINTMENTS LISTENER
// -------------------------------------------------------------
const masterTableBody = document.getElementById("master-appointments-body");
let appointmentsCache = [];
let transactionsCache = [];
let inventoryCache = [];
let currentAdminUid = null;
const QR_PAYMENT_SETTINGS_DEFAULTS = Object.freeze({
    enabled: false,
    qrImageData: '',
    qrCodeURL: '',
    accountName: '',
    accountNumber: '',
    instructions: ''
});
let qrPaymentSettingsCache = { ...QR_PAYMENT_SETTINGS_DEFAULTS };
let qrPaymentSettingsLoadPromise = null;

let dashRevenueChartInst = null;
let dashCategoryChartInst = null;
let dashWeeklyChartInst = null;

if (masterTableBody) {
    const masterApptQuery = collection(db, "appointments");

    onSnapshot(masterApptQuery, (snapshot) => {
        console.log("🔄 Appointments listener fired. Docs:", snapshot.size);
        appointmentsCache = [];
        
        if (snapshot.empty) {
            masterTableBody.innerHTML = `<tr><td colspan="8">No appointments recorded in system.</td></tr>`;
            refreshFinancialViews();
            return;
        }

        const allAppointments = [];

        snapshot.forEach((docSnap) => {
            const appt = docSnap.data();
            const apptId = docSnap.id;
            appt.id = apptId;
            allAppointments.push(appt);
            appointmentsCache.push(appt);
        });

        renderAppointments();
        renderClientGrid();
        refreshFinancialViews();
        renderUpcomingAppointments();

        const analyticsTab = document.getElementById('tab-analytics');
        if (analyticsTab && analyticsTab.classList.contains('active')) {
            loadAnalytics();
        }
    }, (error) => {
        console.error("Error loading master appointments:", error);
        masterTableBody.innerHTML = `<tr><td colspan="8">Error loading master appointments.</td></tr>`;
    });
}

// -------------------------------------------------------------
// 9.1 APPOINTMENT RENDERER
// -------------------------------------------------------------
function isPastAppointment(appt) {
    const dateStr = sharedApptDate(appt);
    if (!dateStr) return false;
    if (typeof dateStr.toDate === 'function') {
        const d = dateStr.toDate();
        return d < new Date(new Date().toDateString());
    }
    const now = new Date();
    const todayKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    return String(dateStr).slice(0, 10) < todayKey;
}

function escapeAdminHtml(value) {
    return String(value ?? '').replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
}

function renderAppointmentPaymentProof(appt) {
    const methodRaw = appt.reservationPaymentMethod || appt.paymentMethod || '';
    const method = methodRaw ? String(methodRaw).toUpperCase() : '—';
    const proofUrl = appt.paymentProofURL || appt.receiptURL || '';
    const proofStatus = appt.paymentProofStatus || (proofUrl ? 'awaiting-review' : '');
    const statusLabel = proofStatus ? proofStatus.replace(/[-_]/g, ' ') : '';
    const providerLabel = appt.reservationPaymentProviderName || appt.paymentProvider || '';
    let html = `<div style="font-size:11px;font-weight:700;color:#555;">${escapeAdminHtml(method)}${providerLabel ? ' · ' + escapeAdminHtml(providerLabel) : ''}</div>`;
    if (proofUrl) {
        html += `<button type="button" class="payment-proof-link" data-proof-url="${escapeAdminHtml(proofUrl)}" data-appt-id="${escapeAdminHtml(appt.id)}" data-proof-method="${escapeAdminHtml(method)}"><i class="fas fa-image"></i> View proof</button>`;
        if (statusLabel) html += `<div class="payment-proof-badge"><i class="fas fa-clock"></i>${escapeAdminHtml(statusLabel)}</div>`;
        if (methodRaw === 'qr' && proofStatus === 'awaiting-review') {
            html += `<div style="display:flex;gap:4px;margin-top:6px;flex-wrap:wrap;"><button type="button" class="btn-success-sm payment-verify-btn" data-id="${escapeAdminHtml(appt.id)}">Verify</button><button type="button" class="btn-danger-sm payment-reject-btn" data-id="${escapeAdminHtml(appt.id)}">Reject</button></div>`;
        }
    } else if (methodRaw === 'qr') {
        html += `<div class="payment-proof-badge"><i class="fas fa-triangle-exclamation"></i> Proof not uploaded</div>`;
    } else if (methodRaw) {
        html += `<div style="font-size:10px;color:#999;margin-top:4px;">${appt.reservationReference ? 'Ref: ' + escapeAdminHtml(appt.reservationReference) : 'No proof image'}</div>`;
    }
    return html;
}

function openPaymentProofModal(appt) {
    const url = appt?.paymentProofURL || appt?.receiptURL || '';
    if (!url) return;
    const modal = document.getElementById('paymentProofModal');
    const image = document.getElementById('paymentProofModalImage');
    const meta = document.getElementById('paymentProofModalMeta');
    const details = document.getElementById('paymentProofModalDetails');
    const openLink = document.getElementById('paymentProofOpenLink');
    if (!modal || !image) return;

    image.src = url;
    if (openLink) openLink.href = url;
    if (meta) meta.textContent = `${appt.clientName || appt.clientEmail || 'Client'} · ${appt.serviceName || 'Appointment'}`;
    if (details) {
        details.innerHTML = [
            `<div><strong>Payment method:</strong> ${escapeAdminHtml(appt.reservationPaymentMethod || appt.paymentMethod || '—')}</div>`,
            `<div><strong>QR payment option:</strong> ${escapeAdminHtml(appt.reservationPaymentProviderName || appt.paymentProvider || '—')}</div>`,
            `<div><strong>Reference:</strong> ${escapeAdminHtml(appt.reservationReference || 'Not provided')}</div>`,
            `<div><strong>Status:</strong> ${escapeAdminHtml((appt.paymentProofStatus || 'awaiting-review').replace(/[-_]/g, ' '))}</div>`,
            `<div><strong>Appointment:</strong> ${escapeAdminHtml(appt.bookingDate || appt.date || '—')} ${escapeAdminHtml(appt.bookingTime || appt.time || '')}</div>`
        ].join('');
    }
    modal.classList.add('open');
}

function closePaymentProofModal() {
    const modal = document.getElementById('paymentProofModal');
    if (modal) modal.classList.remove('open');
}

// QR payment status is changed only from this Admin portal action. The same
// status is copied to its existing transaction record and the client receives
// a notification through the system's existing notifications collection.
async function reviewQrPayment(appointmentId, approved) {
    const appointmentRef = doc(db, 'appointments', appointmentId);
    const appointmentSnap = await getDoc(appointmentRef);
    if (!appointmentSnap.exists()) throw new Error('This appointment no longer exists.');
    const appt = { id: appointmentSnap.id, ...appointmentSnap.data() };
    if (appt.reservationPaymentMethod !== 'qr' || !appt.paymentProofURL) {
        throw new Error('Only QR reservations with an uploaded proof can be reviewed.');
    }
    if (appt.paymentProofStatus !== 'awaiting-review') {
        throw new Error('This payment has already been reviewed.');
    }

    const action = approved ? 'verify' : 'reject';
    const providerLabel = appt.reservationPaymentProviderName || appt.paymentProvider || '';
    if (!confirm(`${approved ? 'Verify' : 'reject'} the QR payment for ${appt.clientName || appt.clientEmail || 'this client'}${providerLabel ? ` paid via ${providerLabel}` : ''}?`)) return;

    const nowFields = approved
        ? {
            reservationPaymentStatus: 'verified', paymentProofStatus: 'verified',
            paymentVerifiedAt: serverTimestamp(), paymentVerifiedBy: auth.currentUser.uid
        }
        : {
            reservationPaymentStatus: 'rejected', paymentProofStatus: 'rejected',
            paymentRejectedAt: serverTimestamp(), paymentRejectedBy: auth.currentUser.uid
        };
    const txSnap = await getDocs(query(collection(db, 'transactions'), where('appointmentId', '==', appointmentId)));
    const batch = writeBatch(db);
    batch.update(appointmentRef, nowFields);
    txSnap.forEach(txDoc => {
        batch.update(txDoc.ref, approved
            ? { paymentStatus: 'verified', verifiedAt: serverTimestamp(), verifiedBy: auth.currentUser.uid }
            : { paymentStatus: 'rejected', rejectedAt: serverTimestamp(), rejectedBy: auth.currentUser.uid });
    });
    await batch.commit();

    if (appt.clientId) {
        await addDoc(collection(db, 'notifications'), {
            recipientId: appt.clientId,
            message: approved
                ? `Payment Verified: Your QR reservation payment for ${appt.serviceName || 'your appointment'} has been verified.`
                : `Payment Review Update: Your QR reservation payment for ${appt.serviceName || 'your appointment'} was rejected. Please contact the salon or submit a new booking.`,
            isRead: false,
            createdAt: serverTimestamp()
        });
    }
    showToast(approved ? 'Payment verified' : 'Payment rejected', approved ? 'The client has been notified.' : 'The client has been notified to contact the salon.', approved ? 'success' : 'warning');
}

function renderAppointments() {
    const searchInput = document.getElementById('apptSearch');
    const statusDropdown = document.getElementById('apptStatusFilter');
    const searchTerm = searchInput ? searchInput.value.toLowerCase() : '';
    const filterStatus = statusDropdown ? statusDropdown.value : 'active';

    const filtered = appointmentsCache.filter(appt => {
        const clientMatch = (appt.clientName || appt.clientEmail || '').toLowerCase().includes(searchTerm);
        const serviceMatch = (appt.serviceName || '').toLowerCase().includes(searchTerm);
        const staffMatch = (appt.staffName || '').toLowerCase().includes(searchTerm);
        const searchMatch = clientMatch || serviceMatch || staffMatch;
        
        const apptStatus = (appt.status || '').toLowerCase();
        const isArchived = appt.archived === true;

        let statusMatch = true;
        if (filterStatus === 'active') {
            statusMatch = !isArchived;
        } else if (filterStatus === 'archived') {
            statusMatch = isArchived;
        } else if (filterStatus === 'historical') {
            statusMatch = isPastAppointment(appt);
        } else if (filterStatus === 'all') {
            statusMatch = true;
        } else {
            statusMatch = apptStatus === filterStatus;
        }
        return searchMatch && statusMatch;
    });

    if (filterStatus === 'historical') {
        filtered.sort((a, b) => {
            const da = parseApptDate(a);
            const db = parseApptDate(b);
            const ta = isNaN(da.getTime()) ? 0 : da.getTime();
            const tb = isNaN(db.getTime()) ? 0 : db.getTime();
            return tb - ta;
        });
    }

    const apptCount = document.getElementById('apptCount');
    if (apptCount) apptCount.textContent = filtered.length + ' appointments';

    if (filtered.length === 0) {
        masterTableBody.innerHTML = `<tr><td colspan="8" style="text-align:center;color:#888;padding:20px;">No appointments found.</td></tr>`;
        return;
    }

    masterTableBody.innerHTML = filtered.map(appt => {
        const status = (appt.status || "pending").toLowerCase();
        const isArchived = appt.archived === true;
        
        let statusBadgeColor = "#ffc107";
        let displayStatus = status.charAt(0).toUpperCase() + status.slice(1);
        
        if (isArchived) {
            statusBadgeColor = "#6c757d";
            displayStatus = "Archived";
        } else if (status === "confirmed") { statusBadgeColor = "#28a745"; } 
        else if (status === "served" || status === "completed") { statusBadgeColor = "#0d6efd"; } 
        else if (status === "cancelled") { statusBadgeColor = "#dc3545"; } 
        else if (status === "denied") { statusBadgeColor = "#6c757d"; displayStatus = "Denied"; }
        else if (status === "no-show") { statusBadgeColor = "#6c757d"; } 
        else if (status === "cancellation_requested" || status === "cancellation requested") { statusBadgeColor = "#ffc107"; displayStatus = "Cancellation Requested"; }

        const cancellationReason = appt.cancellationReason ? `<br><small style="color: #dc3545; font-style: italic;">Reason: "${appt.cancellationReason}"</small>` : "";
        const denialReasonHtml = appt.denialReason ? `<br><small style="color: #d63384; font-style: italic;">Denial reason: "${appt.denialReason}"</small>` : "";
        const dateTimeDisplay = appt.bookingTime ? `${appt.bookingDate} at ${appt.bookingTime}` : (appt.date || 'N/A');
        // Customer feedback + star rating (payment details live in the
        // Transactions section, not here).
        let feedbackHtml = '';
        if (appt.feedback && appt.feedback.rating) {
            const r = Math.min(5, Math.max(1, Math.round(Number(appt.feedback.rating) || 1)));
            feedbackHtml = `<br><small style="color:#f59e0b;">${'★'.repeat(r)}${'☆'.repeat(5 - r)} <b>${r}/5</b>${appt.feedback.comment ? ` — "${appt.feedback.comment}"` : ''}</small>`;
        }

        const ellipsisMenu = (items) => `
            <div class="dropdown-wrapper">
                <button class="ellipsis-btn" data-id="${appt.id}" data-action="dropdown-toggle"><i class="fas fa-ellipsis-v"></i></button>
                <div class="dropdown-menu" id="dropdown-${appt.id}">
                    ${items.map(item => `<button class="dropdown-item ${item.cls || ''}" data-id="${appt.id}">${item.label}</button>`).join('')}
                </div>
            </div>`;

        let actionButtons = "";

        if (isArchived) {
            actionButtons = ellipsisMenu([
                { label: 'Unarchive', cls: 'admin-unarchive-btn' },
                { label: 'Delete', cls: 'delete-btn' }
            ]);
        } else if (status === "pending") {
            actionButtons = `
                <button class="btn-action-sm admin-confirm-btn" data-id="${appt.id}" style="background-color:#28a745;color:white;border:none;padding:4px 8px;border-radius:4px;cursor:pointer;font-size:11px;margin-right:4px;">Confirm</button>
                <button class="btn-action-sm admin-cancel-btn" data-id="${appt.id}" style="background-color:#dc3545;color:white;border:none;padding:4px 8px;border-radius:4px;cursor:pointer;font-size:11px;">Cancel</button>
            `;
        } else if (status === "confirmed" || status === "approved") {
            actionButtons = `
                <button class="btn-action-sm admin-served-btn" data-id="${appt.id}" style="background-color:#0d6efd;color:white;border:none;padding:4px 8px;border-radius:4px;cursor:pointer;font-size:11px;margin-right:4px;">Served</button>
                <button class="btn-action-sm admin-no-show-btn" data-id="${appt.id}" style="background-color:#6c757d;color:white;border:none;padding:4px 8px;border-radius:4px;cursor:pointer;font-size:11px;">No-show</button>
            `;
        } else if (status === "cancellation_requested" || status === "cancellation requested") {
            actionButtons = `
                <button class="btn-action-sm admin-approve-cancel-btn" data-id="${appt.id}" style="background-color:#dc3545;color:white;border:none;padding:4px 8px;border-radius:4px;cursor:pointer;font-size:11px;margin-right:4px;">Approve Cancel</button>
                <button class="btn-action-sm admin-deny-cancel-btn" data-id="${appt.id}" style="background-color:#28a745;color:white;border:none;padding:4px 8px;border-radius:4px;cursor:pointer;font-size:11px;">Deny Cancel</button>
            `;
        } else if (status === "served" || status === "completed" || status === "no-show" || status === "cancelled" || status === "denied") {
            actionButtons = ellipsisMenu([
                { label: 'Archive', cls: 'admin-archive-btn' },
                { label: 'Delete', cls: 'delete-btn' }
            ]);
        } else {
            actionButtons = `<span style="color:#888;font-size:12px;">Closed</span>`;
        }

        return `
            <tr>
                <td>${appt.clientEmail || appt.clientName || "N/A"}</td>
                <td><strong>${appt.serviceName || appt.name || "Treatment"}</strong>${feedbackHtml}${cancellationReason}${denialReasonHtml}</td>
                <td>${appt.staffName || appt.assignedStylist || "Unassigned"}</td>
                <td>${dateTimeDisplay}</td>
                <td>₱${(parseFloat(String(appt.price).replace(/,/g, '')) || 0).toLocaleString()}</td>
                <td>${renderAppointmentPaymentProof(appt)}</td>
                <td><span style="background-color:${statusBadgeColor};color:#fff;padding:4px 8px;border-radius:16px;font-size:11px;font-weight:bold;display:inline-block;">${displayStatus}</span></td>
                <td><div class="action-buttons-container">${actionButtons}</div></td>
            </tr>
        `;
    }).join('');
}

// -------------------------------------------------------------
// 9.2 SEARCH AND DROPDOWN LISTENERS
document.addEventListener('click', (event) => {
    const proofBtn = event.target.closest('.payment-proof-link');
    if (proofBtn) {
        const appt = appointmentsCache.find(item => item.id === proofBtn.dataset.apptId);
        if (appt) openPaymentProofModal(appt);
        return;
    }
    const reviewBtn = event.target.closest('.payment-verify-btn, .payment-reject-btn');
    if (reviewBtn) {
        reviewQrPayment(reviewBtn.dataset.id, reviewBtn.classList.contains('payment-verify-btn'))
            .catch(error => showToast('Payment review failed', error.message, 'error'));
    }
});

document.getElementById('closePaymentProofModal')?.addEventListener('click', closePaymentProofModal);
document.getElementById('paymentProofCloseBtn')?.addEventListener('click', closePaymentProofModal);
document.getElementById('paymentProofModal')?.addEventListener('click', (event) => {
    if (event.target?.id === 'paymentProofModal') closePaymentProofModal();
});

// -------------------------------------------------------------
const apptSearchInput = document.getElementById('apptSearch');
const apptStatusDropdown = document.getElementById('apptStatusFilter');
if (apptSearchInput) apptSearchInput.addEventListener('input', renderAppointments);
if (apptStatusDropdown) apptStatusDropdown.addEventListener('change', renderAppointments);

// -------------------------------------------------------------
// 10. APPOINTMENT ACTION EVENT DELEGATION
// -------------------------------------------------------------
if (masterTableBody) {
    document.addEventListener('click', (e) => {
        if (!e.target.closest('.dropdown-wrapper')) {
            document.querySelectorAll('.dropdown-menu.open').forEach(el => el.classList.remove('open'));
        }
    });

    masterTableBody.addEventListener("click", async (e) => {
        const target = e.target.closest("button");
        if (!target) return;

        const apptId = target.dataset.id;
        if (!apptId) {
            console.warn("Button clicked but no ID found.");
            return;
        }

        if (target.classList.contains("admin-confirm-btn")) {
            updateMasterStatus(apptId, "confirmed");
        } else if (target.classList.contains("admin-cancel-btn")) {
            updateMasterStatus(apptId, "cancelled");
        } else if (target.classList.contains("admin-served-btn")) {
            openPaymentModal(apptId);
        } else if (target.classList.contains("admin-no-show-btn")) {
            updateMasterStatus(apptId, "no-show");
        } else if (target.classList.contains("admin-approve-cancel-btn")) {
            updateMasterStatus(apptId, "cancelled", "Cancellation approved by Admin.");
        } else if (target.classList.contains("admin-deny-cancel-btn")) {
            pendingDenyApptId = apptId;
            document.getElementById('denyReasonInput').value = '';
            document.getElementById('denyCancelModal').style.display = 'flex';
        } else if (target.classList.contains("ellipsis-btn")) {
            const menu = document.getElementById(`dropdown-${apptId}`);
            document.querySelectorAll('.dropdown-menu.open').forEach(el => {
                if (el !== menu) el.classList.remove('open');
            });
            if(menu) menu.classList.toggle('open');
        } else if (target.classList.contains("admin-archive-btn")) {
            const menu = document.getElementById(`dropdown-${apptId}`);
            if(menu) menu.classList.remove('open');
            
            if (confirm("Are you sure you want to archive this appointment?")) {
                try {
                    await updateDoc(doc(db, "appointments", apptId), {
                        archived: true,
                        updatedAt: new Date()
                    });
                    showToast('Archived', 'Appointment archived successfully.', 'success');
                } catch (error) {
                    console.error("Archive error:", error);
                    showToast('Error', 'Failed to archive appointment: ' + error.message, 'error');
                }
            }
        } else if (target.classList.contains("admin-unarchive-btn")) {
            const menu = document.getElementById(`dropdown-${apptId}`);
            if(menu) menu.classList.remove('open');

            if (confirm("Restore this appointment from the archive?")) {
                try {
                    await updateDoc(doc(db, "appointments", apptId), {
                        archived: false,
                        updatedAt: new Date()
                    });
                    showToast('Restored', 'Appointment unarchived successfully.', 'success');
                } catch (error) {
                    console.error("Unarchive error:", error);
                    showToast('Error', 'Failed to unarchive appointment: ' + error.message, 'error');
                }
            }
        } else if (target.classList.contains("delete-btn")) {
            const menu = document.getElementById(`dropdown-${apptId}`);
            if(menu) menu.classList.remove('open');
            
            if (!confirm("Are you sure you want to permanently delete this appointment? This action cannot be undone.")) return;

            try {
                const appt = appointmentsCache.find(a => a.id === apptId);
                const clientId = appt ? appt.clientId : null;
                
                const batch = writeBatch(db);
                const apptRef = doc(db, "appointments", apptId);
                batch.delete(apptRef);
                console.log(`📝 Added appointment deletion to batch: ${apptId}`);
                
                const txQuery = query(collection(db, "transactions"), where("appointmentId", "==", apptId));
                const txSnapshot = await getDocs(txQuery);
                let txDeleted = false;
                if (!txSnapshot.empty) {
                    const txDoc = txSnapshot.docs[0];
                    const txRef = doc(db, "transactions", txDoc.id);
                    batch.delete(txRef);
                    txDeleted = true;
                    console.log(`📝 Added transaction deletion to batch: ${txDoc.id}`);
                } else {
                    console.warn(`⚠️ No transaction found for appointment ${apptId}`);
                }
                
                await batch.commit();
                console.log(`✅ Batch commit successful. Appointment ${apptId} deleted. Transaction deleted: ${txDeleted}`);
                
                if (clientId) {
                    await recalculateClientStats(clientId);
                }
                
                showToast('Deleted', 'Appointment and linked transaction deleted successfully.', 'success');
            } catch (error) {
                console.error("Delete error:", error);
                showToast('Error', 'Failed to delete: ' + error.message, 'error');
            }
        }
    });
}

// -------------------------------------------------------------
// 11. UPDATE MASTER STATUS
// -------------------------------------------------------------
function slotBlockKey(staffUid, date) {
    return `${staffUid}_${date}`;
}

// Keeps the public stylist-availability index (slotBlocks) in sync when the
// admin changes an appointment's status. Non-blocking statuses remove the
// block so the stylist shows as available again in the Client picker.
async function syncAppointmentSlotBlock(apptId, appt) {
    if (!apptId || !appt) return;
    const staffUid = appt.staffUid || '';
    const date = appt.bookingDate || appt.date;
    const time = appt.bookingTime || appt.time;
    const norm = normalizeStatus(appt.status);
    const blocking = norm && !['cancelled', 'denied', 'declined', 'served', 'completed', 'no-show', 'no show'].includes(norm) && !appt.archived;
    try {
        if (!staffUid || !date || !time || !blocking) {
            await deleteDoc(doc(db, "slotBlocks", apptId));
            return;
        }
        const startMin = timeToMinutes(time);
        const endMin = startMin + (appt.durationMinutes || 60);
        await setDoc(doc(db, "slotBlocks", apptId), {
            appointmentId: apptId,
            staffUid,
            stylistDate: slotBlockKey(staffUid, date),
            date,
            startMin,
            endMin,
            blocking: true,
            createdBy: auth.currentUser ? auth.currentUser.uid : '',
            createdAt: serverTimestamp()
        });
    } catch (err) {
        console.warn('Slot block sync failed (availability may be stale):', err);
    }
}

async function updateMasterStatus(apptId, newStatus, customReason = null, isDenial = false) {
    if (!apptId) {
        alert("Error: Appointment ID not found.");
        return;
    }
    try {
        const apptRef = doc(db, "appointments", apptId);
        
        const apptSnap = await getDoc(apptRef);
        let clientId = null;
        let clientName = null;
        let updateData = { status: newStatus, updatedAt: new Date() };
        
        if(apptSnap.exists()) {
            const data = apptSnap.data();
            clientId = data.clientId;
            clientName = data.clientName || data.clientEmail || 'Customer';

            const originalReason = data.cancellationReason || ""; 

            if (newStatus === "cancelled" && !isDenial) {
                if (customReason && customReason === "Cancellation approved by Admin.") {
                    updateData.cancellationReason = originalReason; 
                } else if (customReason) {
                    updateData.cancellationReason = customReason;
                } else {
                    updateData.cancellationReason = "Cancelled by Admin.";
                }
                updateData.denialReason = null;
            } else if (isDenial) {
                updateData.status = "confirmed";
                updateData.denialReason = customReason || "No specific reason provided by Admin.";
                updateData.cancellationReason = null;
            } else if (customReason && newStatus !== "cancelled") {
                updateData.cancellationReason = customReason;
            }
        }

        await updateDoc(apptRef, updateData);

        if (apptSnap.exists()) {
            await syncAppointmentSlotBlock(apptId, {
                ...apptSnap.data(),
                status: updateData.status,
                archived: apptSnap.data().archived
            });
        }

        if(clientId) {
            let notificationMessage = "";
            if (isDenial) {
                notificationMessage = `Update: Your cancellation request was denied. Reason: "${customReason || 'No reason provided'}". Your appointment has been re-confirmed. Please contact us if you have questions.`;
            } else {
                notificationMessage = `Update: Your appointment status has been changed to '${newStatus}'.`;
            }
            await createNotification(clientId, notificationMessage);
        }

        alert(`Master Override: Appointment status updated to "${newStatus}".`);
    } catch (error) {
        console.error("Master Update Error:", error);
        alert("Failed to update status: " + error.message);
    }
}

// -------------------------------------------------------------
// 12. DENY CANCELLATION MODAL
// -------------------------------------------------------------
let pendingDenyApptId = null;

document.getElementById('denyCancelCloseBtn').addEventListener('click', () => {
    document.getElementById('denyCancelModal').style.display = 'none';
});

document.getElementById('denyCancelModal').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) {
        document.getElementById('denyCancelModal').style.display = 'none';
    }
});

document.getElementById('denyCancelConfirmBtn').addEventListener('click', async () => {
    const reason = document.getElementById('denyReasonInput').value.trim();
    if (!pendingDenyApptId) return;

    if (!reason) {
        alert("Please enter a reason for denying this cancellation request.");
        return;
    }

    document.getElementById('denyCancelModal').style.display = 'none';
    await updateMasterStatus(pendingDenyApptId, "denied", reason, true);
    pendingDenyApptId = null;
});

// -------------------------------------------------------------
// 13. RECALCULATE CLIENT STATS
// -------------------------------------------------------------
async function recalculateClientStats(clientId) {
    if (!clientId) return;
    const client = clientsCache.find(c => c.id === clientId);
    if (!client) return;

    const { visits, spent } = computeClientStats(client);

    await updateDoc(doc(db, "users", clientId), {
        spent,
        visits,
        updatedAt: new Date()
    });

    const activeCard = document.querySelector('.client-card.active');
    if (activeCard && activeCard.dataset.id === clientId) {
        renderClientDetail(clientId);
    }
}

// -------------------------------------------------------------
// 14. PAYMENT MODAL LOGIC
// -------------------------------------------------------------
let pendingApptId = null;
let pendingApptObject = null; 

function openPaymentModal(apptId) {
    const appt = appointmentsCache.find(a => a.id === apptId);
    if (!appt) {
        showToast('Error', 'Appointment not found.', 'error');
        return;
    }
    if (isServedOrCompletedStatus(appt.status) || apptStatus(appt) === 'cancelled' || apptStatus(appt) === 'no-show') {
        showToast('Warning', 'This appointment is already closed.', 'warning');
        return;
    }
    
    pendingApptId = apptId;
    pendingApptObject = appt; 

    document.getElementById('pmClient').textContent = appt.clientName || appt.clientEmail || 'N/A';
    document.getElementById('pmService').textContent = appt.serviceName || 'Service';

    const totalPrice = sharedParsePrice(appt.price);
    const payment = computeReservationPayment(totalPrice);
    const reservationPaid = sharedParsePrice(appt.reservationFeePaid ?? appt.reservationFee ?? 0);
    const balanceDue = getAppointmentBalanceDue(appt);

    document.getElementById('pmTotal').textContent = '₱' + totalPrice.toLocaleString();
    document.getElementById('pmReservation').textContent = reservationPaid > 0
        ? `-₱${reservationPaid.toLocaleString()}`
        : '₱0';
    document.getElementById('pmAmount').textContent = '₱' + balanceDue.toLocaleString();
    document.getElementById('paymentApptId').value = apptId;
    document.getElementById('paymentRef').value = '';

    const receiptRow = document.getElementById('pmReceiptRow');
    const receiptLink = document.getElementById('pmReceiptLink');
    if (receiptRow && receiptLink) {
        if (appt.receiptURL) {
            receiptLink.href = appt.receiptURL;
            receiptRow.style.display = '';
        } else {
            receiptRow.style.display = 'none';
        }
    }

    const cashRadio = document.querySelector('input[name="payment-method"][value="cash"]');
    if (cashRadio) cashRadio.checked = true;

    document.getElementById('paymentModal').classList.add('open');
}

function closePaymentModal() {
    document.getElementById('paymentModal').classList.remove('open');
    pendingApptId = null;
    pendingApptObject = null;
}

const closePaymentModalBtn = document.getElementById('closePaymentModal');
if (closePaymentModalBtn) closePaymentModalBtn.addEventListener('click', closePaymentModal);

const cancelPaymentBtn = document.getElementById('cancelPaymentBtn');
if (cancelPaymentBtn) cancelPaymentBtn.addEventListener('click', closePaymentModal);

const paymentModal = document.getElementById('paymentModal');
if (paymentModal) {
    paymentModal.addEventListener('click', function(e) {
        if (e.target === this) closePaymentModal();
    });
}

const confirmPaymentBtn = document.getElementById('confirmPaymentBtn');
if (confirmPaymentBtn) {
    confirmPaymentBtn.addEventListener('click', async function() {
        const apptId = document.getElementById('paymentApptId').value;
        const ref = document.getElementById('paymentRef').value.trim();
        
        const selectedRadio = document.querySelector('input[name="payment-method"]:checked');
        if (!selectedRadio) {
            showToast('Error', 'Please select a payment method.', 'error');
            return; 
        }
        const selectedPayment = selectedRadio.value;
        if (!['cash', 'qr'].includes(selectedPayment)) {
            showToast('Error', 'Please select QR Payment or Cash Payment.', 'error');
            return;
        }

        if (!apptId) {
            showToast('Error', 'No appointment selected.', 'error');
            return;
        }

        let appt = pendingApptObject;
        if (!appt || appt.id !== apptId) {
            appt = appointmentsCache.find(a => a.id === apptId);
        }

        if (!appt) {
            showToast('Error', 'Appointment data missing. Please refresh the page.', 'error');
            return;
        }

        try {
            const totalPrice = sharedParsePrice(appt.price);
            const balanceDue = getAppointmentBalanceDue(appt);
            const reservationPaid = sharedParsePrice(appt.reservationFeePaid ?? appt.reservationFee ?? 0);

            await addDoc(collection(db, "transactions"), {
                clientId: appt.clientId || null,
                clientName: appt.clientName || appt.clientEmail || 'Unknown',
                clientEmail: appt.clientEmail || '',
                serviceName: appt.serviceName || 'Treatment',
                staffName: appt.staffName || 'Unassigned',
                amount: balanceDue,
                paymentType: 'balance',
                paymentMethod: selectedPayment,
                referenceNumber: ref || '',
                appointmentId: apptId,
                date: new Date().toISOString().split('T')[0],
                createdAt: new Date()
            });

            await updateDoc(doc(db, "appointments", apptId), {
                status: 'served',
                paymentMethod: selectedPayment,
                balancePaid: true,
                balancePaidAt: new Date(),
                reservationFeePaid: reservationPaid || computeReservationPayment(totalPrice).reservationFee,
                balanceDue: 0,
                updatedAt: new Date()
            });

            if (appt.clientId) {
                await recalculateClientStats(appt.clientId);
            }

            closePaymentModal();
            showToast('✅ Payment Recorded', `${appt.clientName} paid ₱${balanceDue.toLocaleString()} balance via ${selectedPayment}.`, 'success');

            if (appt.clientId) {
                await createNotification(appt.clientId, `Your appointment has been completed. Payment: ${selectedPayment}. Thank you!`);
            }

            refreshFinancialViews();

        } catch (error) {
            console.error('Payment Error:', error);
            showToast('Error', 'Failed to complete payment: ' + error.message, 'error');
        }
    });
}

// -------------------------------------------------------------
// 15. REAL-TIME TRANSACTIONS LISTENER
// -------------------------------------------------------------
const transactionsTableBody = document.getElementById("transactionsTableBody");
const txSearch = document.getElementById("txSearch");
const txCount = document.getElementById("txCount");
const txTotalRevenue = document.getElementById("txTotalRevenue");
const txCashCount = document.getElementById("txCashCount");
const txDigitalCount = document.getElementById("txDigitalCount");
const txAvgTicket = document.getElementById("txAvgTicket");

if (transactionsTableBody) {
    const transactionsQuery = collection(db, "transactions");

    onSnapshot(transactionsQuery, (snapshot) => {
        console.log("🔄 Transactions listener fired. Docs:", snapshot.size);
        transactionsCache = [];
        snapshot.forEach((docSnap) => {
            const tx = docSnap.data();
            tx.id = docSnap.id;
            transactionsCache.push(tx);
        });
        // UI is driven by appointments (same as Analytics & BI) — refresh when appts update
    }, (error) => {
        console.error("Error loading transactions:", error);
    });
}

if (txSearch) {
    txSearch.addEventListener('input', () => renderTransactionsFromSnapshot(buildFinancialSnapshot()));
}
['txDateStart', 'txDateEnd', 'txPaymentFilter'].forEach(id => {
    document.getElementById(id)?.addEventListener('change', () => renderTransactionsFromSnapshot(buildFinancialSnapshot()));
});
document.getElementById('exportTransactionsBtn')?.addEventListener('click', exportTransactionsCsv);

// -------------------------------------------------------------
// 16. REAL-TIME USER MANAGEMENT LISTENER
// -------------------------------------------------------------
const usersTableBody = document.getElementById("usersTableBody");
const userCountEl = document.getElementById("userCount");

// Role tag filter state ("admin" | "staff" | "stylist" | "client" | null)
let userRoleFilter = null;
let lastUsersSnapshot = null;

if (usersTableBody) {
    const usersQuery = collection(db, "users");

    onSnapshot(usersQuery, (snapshot) => {
        lastUsersSnapshot = snapshot;
        renderUsers(snapshot);
    }, (error) => {
        console.error("Error loading users list:", error);
        usersTableBody.innerHTML = `<tr><td colspan="7" style="text-align:center;color:red;">Error loading users.</td></tr>`;
    });
}

function renderUsers(snapshot) {
    usersTableBody.innerHTML = "";
    let adminCount = 0, staffCount = 0, stylistCount = 0, clientCount = 0;

    if (snapshot.empty) {
        usersTableBody.innerHTML = `<tr><td colspan="7" style="text-align:center;color:#888;padding:20px;">No registered users found.</td></tr>`;
        if(userCountEl) userCountEl.textContent = "0 registered users";
        updateUserTagCounts(0, 0, 0, 0);
        return;
    }

    const roleMap = { 'Admin': 'Admin', 'Staff': 'Staff', 'Stylist': 'Staff', 'Receptionist': 'Staff', 'General Staff': 'Staff', 'Manager': 'Staff', 'Client': 'Client' };
    const roleColorMap = { 'Admin': 'admin', 'Staff': 'staff', 'Stylist': 'staff', 'Client': 'client' };

    let html = '';
    snapshot.forEach((docSnap) => {
        const user = docSnap.data();
        const role = user.role || 'Client';
        const displayRole = roleMap[role] || role;
        const roleClass = roleColorMap[displayRole] || '';

        // Counts are always full totals (unfiltered) so the tags stay live.
        if(role === 'Admin') adminCount++;
        else if(role === 'Stylist') stylistCount++;
        else if(role === 'Client') clientCount++;
        else staffCount++;

        // Row-level filter from the tag buttons (counts above still apply).
        if (userRoleFilter && !userRoleFilterMatches(userRoleFilter, role)) return;

        let joinedDate = 'N/A';
        if (user.createdAt && typeof user.createdAt.toDate === 'function') {
            joinedDate = user.createdAt.toDate().toLocaleDateString();
        }

        const specialtiesBtn = displayRole === 'Staff' && role !== 'Admin'
            ? `<button class="btn-outline btn-sm admin-specialties-btn" data-uid="${docSnap.id}" data-name="${(user.fullName || user.email || '').replace(/"/g, '&quot;')}" title="Manage service specialties for booking eligibility">Specialties</button>`
            : '';

        const hardDeleteBtn = role !== 'Admin'
            ? `<button class="btn-outline btn-sm admin-hard-delete-btn" data-uid="${docSnap.id}" data-name="${(user.fullName || user.email || '').replace(/"/g, '&quot;')}" title="Permanently delete this profile from the users list (delete the login in Firebase Console → Authentication separately)" style="color:#dc3545;border-color:#dc3545;">Delete</button>`
            : '';
        const deletedBadge = user.deleted ? ' <span style="color:#dc3545;font-size:11px;">(Deactivated)</span>' : '';

        // Role badge — clickable dropdown for non-Admin roles (Client / Staff /
        // Stylist only). Admin rows stay a plain badge to prevent lockouts.
        const roleMenu = role === 'Admin'
            ? `<span class="role-badge ${roleClass}">${role}</span>`
            : `<span class="role-badge role-badge-btn ${roleClass}" data-uid="${docSnap.id}" data-role="${role}" title="Click to change role">${role} <i class="fas fa-caret-down" style="font-size:9px;"></i></span>
               <div class="role-dropdown" data-uid="${docSnap.id}">
                   ${['Client', 'Staff', 'Stylist'].map(r =>
                       `<button type="button" class="role-dropdown-item ${r === role ? 'current' : ''}" data-uid="${docSnap.id}" data-new-role="${r}" ${r === role ? 'disabled' : ''}>${r}${r === role ? ' ✓' : ''}</button>`
                   ).join('')}
               </div>`;

        html += `
            <tr>
                <td><strong>${user.fullName || 'N/A'}</strong>${deletedBadge}</td>
                <td>${user.email || 'N/A'}</td>
                <td>${escapeCustomerHtml(user.phone || 'N/A')}</td>
                <td style="position:relative;">${roleMenu}</td>
                <td><span class="status-badge active">Active</span></td>
                <td>${joinedDate}</td>
                <td>
                    ${specialtiesBtn}
                    ${hardDeleteBtn}
                    <button class="btn-outline btn-sm admin-unlock-btn" data-email="${user.email || ''}" title="Unlock login after failed attempts">Unlock</button>
                </td>
            </tr>
        `;
    });
    if (!html) {
        const filterLabel = userRoleFilter ? userRoleFilter.charAt(0).toUpperCase() + userRoleFilter.slice(1) : '';
        usersTableBody.innerHTML = `<tr><td colspan="7" style="text-align:center;color:#888;padding:20px;">No ${filterLabel} users found.</td></tr>`;
        return;
    }
    usersTableBody.innerHTML = html;
    if(userCountEl) userCountEl.textContent = `${snapshot.size} registered users`;
    updateUserTagCounts(adminCount, staffCount, stylistCount, clientCount);
}

document.addEventListener("click", async (e) => {
    const unlockBtn = e.target.closest(".admin-unlock-btn");
    if (!unlockBtn) return;
    const email = unlockBtn.dataset.email;
    if (!email) return;
    if (!confirm(`Unlock login for ${email}?`)) return;
    try {
        await adminUnlockAccount(email);
        alert(`Login unlocked for ${email}.`);
    } catch (err) {
        alert("Unlock failed: " + err.message);
    }
});

document.addEventListener("click", async (e) => {
    const delBtn = e.target.closest(".admin-hard-delete-btn");
    if (!delBtn) return;
    const uid = delBtn.dataset.uid;
    const name = delBtn.dataset.name || 'this user';
    if (!confirm(`Permanently delete "${name}"?\n\nThis removes their profile from the users list immediately. Appointment history and transactions are kept (financial records). Their stylist schedule doc is also removed.\n\nIf their login still exists, delete it separately: Firebase Console → Authentication → Users.`)) return;
    if (!confirm(`Final confirmation: permanently delete "${name}"? This cannot be undone.`)) return;
    try {
        await deleteDoc(doc(db, "users", uid));
        try {
            await deleteDoc(doc(db, "stylistSchedules", uid));
        } catch (scheduleErr) {
            console.warn("No schedule doc to remove for", uid, scheduleErr);
        }
        showToast('Account Deleted', `${name} removed from the users list.`, 'success');
    } catch (err) {
        console.error("Delete error:", err);
        showToast('Error', 'Failed to delete account: ' + err.message, 'error');
    }
});

// Role badge dropdown: open/close the menu, pick a role (Client / Staff /
// Stylist only; Admin rows have no badge button), or click elsewhere to close.
function closeRoleDropdowns() {
    document.querySelectorAll('.role-dropdown.open').forEach(m => m.classList.remove('open'));
}

document.addEventListener("click", async (e) => {
    const toggle = e.target.closest(".role-badge-btn");
    if (toggle) {
        e.stopPropagation();
        const menu = document.querySelector(`.role-dropdown[data-uid="${toggle.dataset.uid}"]`);
        closeRoleDropdowns();
        if (menu && !menu.classList.contains('open')) menu.classList.add('open');
        return;
    }
    const item = e.target.closest(".role-dropdown-item");
    if (item) {
        e.stopPropagation();
        closeRoleDropdowns();
        const uid = item.dataset.uid;
        const newRole = item.dataset.newRole;
        const badge = document.querySelector(`.role-badge-btn[data-uid="${uid}"]`);
        const current = badge ? badge.dataset.role : '';
        if (!confirm(`Change role of this user from "${current}" to "${newRole}"?\n\nThis controls what the user can do in the system. The accounts list will refresh automatically.`)) return;
        try {
            await updateDoc(doc(db, "users", uid), { role: newRole, updatedAt: new Date() });
            showToast('Role updated', `Role changed to ${newRole}.`, 'success');
        } catch (err) {
            console.error("Role change error:", err);
            showToast('Error', 'Failed to change role: ' + err.message, 'error');
        }
        return;
    }
    closeRoleDropdowns();
});

// -------------------------------------------------------------
// 16.1 STYLIST SPECIALTIES EDITOR (Admin → Users)
// -------------------------------------------------------------
let specialtiesCategoryCache = null;

async function loadServiceCategoriesForSpecialties() {
    if (specialtiesCategoryCache) return specialtiesCategoryCache;
    const snap = await getDocs(collection(db, "services"));
    const cats = new Set();
    snap.forEach(d => {
        const c = (d.data().category || '').trim();
        if (c) cats.add(c);
    });
    specialtiesCategoryCache = [...cats].sort();
    return specialtiesCategoryCache;
}

async function openSpecialtiesModal(uid, name) {
    const modal = document.getElementById("specialtiesModal");
    if (!modal) return;
    document.getElementById("specialtiesUid").value = uid;
    document.getElementById("specialtiesTargetName").textContent = name || 'Stylist';

    const [categories, userSnap] = await Promise.all([
        loadServiceCategoriesForSpecialties(),
        getDoc(doc(db, "users", uid))
    ]);
    const current = userSnap.exists() ? (userSnap.data().specialties || []) : [];
    const currentSet = new Set((current || []).map(s => String(s).trim()));

    const box = document.getElementById("specialtiesCheckboxes");
    box.innerHTML = categories.length
        ? categories.map(cat => `
            <label style="display:flex;align-items:center;gap:8px;font-size:13px;color:#333;cursor:pointer;padding:4px 0;">
                <input type="checkbox" class="specialty-cat-cb" value="${cat.replace(/"/g, '&quot;')}" ${currentSet.has(cat) ? 'checked' : ''}>
                ${cat}
            </label>
        `).join('')
        : '<p style="grid-column:1/-1;font-size:13px;color:#888;">No service categories found. Seed the pricelist first.</p>';

    modal.classList.add('open');
}

document.addEventListener("click", (e) => {
    const btn = e.target.closest(".admin-specialties-btn");
    if (btn) openSpecialtiesModal(btn.dataset.uid, btn.dataset.name);
});

document.getElementById('closeSpecialtiesModal')?.addEventListener('click', () => {
    document.getElementById('specialtiesModal')?.classList.remove('open');
});
document.getElementById('cancelSpecialtiesBtn')?.addEventListener('click', () => {
    document.getElementById('specialtiesModal')?.classList.remove('open');
});
document.getElementById('specialtiesModal')?.addEventListener('click', function(e) {
    if (e.target === this) this.classList.remove('open');
});
document.getElementById('saveSpecialtiesBtn')?.addEventListener('click', async () => {
    const uid = document.getElementById('specialtiesUid').value;
    if (!uid) return;
    const selected = [...document.querySelectorAll('.specialty-cat-cb:checked')].map(cb => cb.value);
    try {
        await updateDoc(doc(db, "users", uid), { specialties: selected, updatedAt: new Date() });
        document.getElementById('specialtiesModal').classList.remove('open');
        showToast('Saved', 'Stylist specialties updated. Qualification now applies to booking.', 'success');
    } catch (err) {
        console.error("Specialties save error:", err);
        showToast('Error', 'Failed to save specialties: ' + err.message, 'error');
    }
});

function userRoleFilterMatches(filterKey, role) {
    switch (filterKey) {
        case 'admin': return role === 'Admin';
        case 'staff': return ['Staff', 'Receptionist', 'General Staff', 'Manager'].includes(role);
        case 'stylist': return role === 'Stylist';
        case 'client': return role === 'Client';
        default: return true;
    }
}

// Clicking a role tag filters the users table to that role; clicking the
// active tag again clears the filter. Counts themselves stay full totals.
document.addEventListener("click", (e) => {
    const tag = e.target.closest(".tag-filter");
    if (!tag) return;
    const key = tag.dataset.filter || '';
    userRoleFilter = (userRoleFilter === key ? null : key);
    document.querySelectorAll('.tag-group .tag-filter').forEach(t => {
        t.classList.toggle('active', t.dataset.filter === userRoleFilter);
    });
    if (lastUsersSnapshot) renderUsers(lastUsersSnapshot);
});

function updateUserTagCounts(admin, staff, stylist, client) {
    const tags = document.querySelectorAll('.tag-group .tag');
    if(tags.length >= 4) {
        tags[0].innerHTML = `${admin} Admin`;
        tags[1].innerHTML = `${staff} Staffs`;
        tags[2].innerHTML = `${stylist} Stylists`;
        tags[3].innerHTML = `${client} Clients`;
    }
}

// -------------------------------------------------------------
// 18. ANALYTICS & BI DATA LOADER
// -------------------------------------------------------------
let revenueChartInstance = null;
let categoryChartInstance = null;
let paymentChartInstance = null;

// -------------------------------------------------------------
// BOOKING VOLUME CHART — Weekly / Monthly toggle with real query
// -------------------------------------------------------------
let bookingVolumeRange = 'weekly';
let bookingVolumeChartInstance = null;
let bookingVolumeUnsub = null;
let bookingVolumeCaches = { weekly: { labels: [], data: [] }, monthly: { labels: [], data: [] } };

function toDateKey(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

function getBookingVolumeRange(range) {
    const now = new Date();
    let start, end;
    if (range === 'monthly') {
        start = new Date(now.getFullYear(), now.getMonth(), 1);
        end = new Date(now.getFullYear(), now.getMonth() + 1, 0);
    } else {
        start = new Date(now);
        start.setDate(now.getDate() - now.getDay() + 1);
        start.setHours(0, 0, 0, 0);
        end = new Date(start);
        end.setDate(start.getDate() + 6);
    }
    return { start, end, startKey: toDateKey(start), endKey: toDateKey(end) };
}

function setupBookingVolumeQuery() {
    if (bookingVolumeUnsub) { bookingVolumeUnsub(); bookingVolumeUnsub = null; }
    const { startKey, endKey } = getBookingVolumeRange(bookingVolumeRange);
    const q = query(
        collection(db, "appointments"),
        where("date", ">=", startKey),
        where("date", "<=", endKey)
    );
    bookingVolumeUnsub = onSnapshot(q, (snapshot) => {
        let labels;
        const counts = {};
        if (bookingVolumeRange === 'monthly') {
            const { end } = getBookingVolumeRange('monthly');
            labels = [];
            for (let i = 1; i <= end.getDate(); i++) { labels.push(String(i)); counts[i] = 0; }
        } else {
            labels = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
            labels.forEach((_, i) => { counts[i] = 0; });
        }
        snapshot.forEach(docSnap => {
            const appt = docSnap.data();
            if (!isWeeklyBookingStatus(appt.status)) return;
            const dateStr = appt.date || appt.bookingDate || '';
            if (bookingVolumeRange === 'monthly') {
                const dayNum = parseInt(dateStr.split('-')[2], 10);
                if (!isNaN(dayNum) && counts[dayNum] != null) counts[dayNum]++;
            } else {
                const d = new Date(dateStr + 'T00:00:00');
                const idx = d.getDay() === 0 ? 6 : d.getDay() - 1;
                if (counts[idx] != null) counts[idx]++;
            }
        });
        const data = labels.map((_, i) => counts[i] || 0);
        bookingVolumeCaches[bookingVolumeRange] = { labels, data };
        renderBookingVolumeChart();
    }, (error) => {
        console.error("Booking volume query error:", error);
    });
}

function renderBookingVolumeChart() {
    const canvas = document.getElementById('weeklyChart');
    if (!canvas) return;
    if (bookingVolumeChartInstance) bookingVolumeChartInstance.destroy();
    const { labels, data } = bookingVolumeCaches[bookingVolumeRange] || { labels: [], data: [] };
    const hasData = data.some(v => v > 0);
    if (!hasData) {
        bookingVolumeChartInstance = new Chart(canvas.getContext('2d'), {
            type: 'line',
            data: {
                labels: ['No Data'],
                datasets: [{ label: 'Bookings', data: [0], borderColor: '#d63384', pointRadius: 0 }]
            },
            options: {
                responsive: true, maintainAspectRatio: false,
                plugins: { legend: { display: false } },
                scales: { y: { beginAtZero: true } }
            }
        });
    } else {
        bookingVolumeChartInstance = new Chart(canvas.getContext('2d'), {
            type: 'line',
            data: {
                labels,
                datasets: [{
                    label: 'Bookings',
                    data,
                    borderColor: '#d63384',
                    backgroundColor: 'rgba(214,51,132,0.08)',
                    fill: true,
                    tension: 0.3,
                    pointBackgroundColor: '#d63384',
                    pointRadius: 4
                }]
            },
            options: {
                responsive: true, maintainAspectRatio: false,
                plugins: { legend: { display: false } },
                scales: { y: { beginAtZero: true } }
            }
        });
    }
    bookingVolumeChartInstance.resize();
}

function initBookingVolumeToggle() {
    const container = document.getElementById('bookingVolumeToggle');
    if (!container) return;
    container.querySelectorAll('.seg-btn').forEach(btn => {
        btn.addEventListener('click', function() {
            container.querySelectorAll('.seg-btn').forEach(b => b.classList.remove('active'));
            this.classList.add('active');
            bookingVolumeRange = this.dataset.range;
            setupBookingVolumeQuery();
        });
    });
    setupBookingVolumeQuery();
}

function renderBiChartsFromSnapshot(snap) {
    const colors = ['#f06292', '#b388ff', '#69db7c', '#ffb74d', '#74c0fc', '#fcc5c0', '#81ecec', '#ff7675'];

    const canvas1 = document.getElementById('revenueChart');
    if (canvas1) {
        if (revenueChartInstance) revenueChartInstance.destroy();
        revenueChartInstance = new Chart(canvas1.getContext('2d'), {
            type: 'bar',
            data: {
                labels: snap.last6Months.map(m => m.label),
                datasets: [{
                    label: 'Revenue (₱)',
                    data: snap.monthRevenue,
                    backgroundColor: 'rgba(214,51,132,0.6)',
                    borderColor: '#d63384',
                    borderWidth: 2,
                    borderRadius: 6
                }]
            },
            options: {
                responsive: true, maintainAspectRatio: false,
                plugins: { legend: { display: false } },
                scales: { y: { beginAtZero: true, ticks: { callback: v => '₱' + v.toLocaleString() } } }
            }
        });
        revenueChartInstance.resize();
    }

    const canvas2 = document.getElementById('categoryChart');
    if (canvas2) {
        if (categoryChartInstance) categoryChartInstance.destroy();
        const labels = Object.keys(snap.catMap);
        const data = Object.values(snap.catMap);
        if (!data.length || data.reduce((a, b) => a + b, 0) === 0) {
            categoryChartInstance = new Chart(canvas2.getContext('2d'), {
                type: 'doughnut',
                data: { labels: ['No Data'], datasets: [{ data: [1], backgroundColor: ['#eee'], borderWidth: 0 }] },
                options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, cutout: '75%' }
            });
        } else {
            categoryChartInstance = new Chart(canvas2.getContext('2d'), {
                type: 'doughnut',
                data: { labels, datasets: [{ data, backgroundColor: colors.slice(0, labels.length), borderWidth: 0 }] },
                options: {
                    responsive: true, maintainAspectRatio: false,
                    plugins: { legend: { position: 'bottom', labels: { boxWidth: 12, font: { size: 11 } } } },
                    cutout: '65%'
                }
            });
        }
        categoryChartInstance.resize();
    }

    const canvas3 = document.getElementById('weeklyChart');
    if (canvas3) {
        renderBookingVolumeChart();
    }

    const canvas4 = document.getElementById('paymentChart');
    if (canvas4) {
        if (paymentChartInstance) paymentChartInstance.destroy();
        const pLabels = Object.keys(snap.payMap);
        const pData = Object.values(snap.payMap);
        const pColors = ['#6f42c1', '#28a745', '#0d6efd', '#ffc107', '#dc3545'];
        if (!pData.length || pData.reduce((a, b) => a + b, 0) === 0) {
            paymentChartInstance = new Chart(canvas4.getContext('2d'), {
                type: 'pie',
                data: { labels: ['No Data'], datasets: [{ data: [1], backgroundColor: ['#eee'], borderWidth: 0 }] },
                options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom', labels: { boxWidth: 12, font: { size: 11 } } } } }
            });
        } else {
            paymentChartInstance = new Chart(canvas4.getContext('2d'), {
                type: 'pie',
                data: { labels: pLabels, datasets: [{ data: pData, backgroundColor: pColors.slice(0, pLabels.length), borderWidth: 0 }] },
                options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom', labels: { boxWidth: 12, font: { size: 11 } } } } }
            });
        }
        paymentChartInstance.resize();
    }

    const tbody = document.getElementById('biTxBody');
    if (tbody) {
        const recent = snap.transactionRows.slice(0, 5);
        if (!recent.length) {
            tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:#888;padding:16px;">No transactions.</td></tr>';
        } else {
            tbody.innerHTML = recent.map(t => `
                <tr><td><strong>${t.clientName}</strong></td><td>${t.serviceName}</td><td>${t.staffName}</td><td>₱${t.amount.toLocaleString()}</td><td><span class="tag">${t.paymentMethod}</span></td><td>${t.date}</td></tr>
            `).join('');
        }
    }
}

function loadAnalytics() {
    try {
        const snap = buildFinancialSnapshot(appointmentsCache);
        if (!snap.transactionRows.length) {
            drawEmptyAnalyticsCharts();
            document.getElementById('biTotalRevenue').textContent = '₱0';
            document.getElementById('biThisMonth').textContent = '₱0';
            document.getElementById('biTotalClients').textContent = '0';
            document.getElementById('biAvgTicket').textContent = '₱0';
            const tbody = document.getElementById('biTxBody');
            if (tbody) tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:#888;padding:16px;">No transactions.</td></tr>';
            return;
        }

        document.getElementById('biTotalRevenue').textContent = `₱${snap.allTimeTotal.toLocaleString()}`;
        document.getElementById('biThisMonth').textContent = `₱${snap.monthlyTotal.toLocaleString()}`;
        document.getElementById('biTotalClients').textContent = snap.uniqueClients.size;
        document.getElementById('biAvgTicket').textContent = `₱${snap.avgTicket.toLocaleString()}`;

        setTimeout(() => renderBiChartsFromSnapshot(snap), 200);
    } catch (err) {
        console.error("Analytics error:", err);
    }
}

function drawEmptyAnalyticsCharts() {
    const canvas1 = document.getElementById('revenueChart');
    if (canvas1) {
        if (revenueChartInstance) revenueChartInstance.destroy();
        revenueChartInstance = new Chart(canvas1.getContext('2d'), {
            type: 'bar',
            data: { labels: [], datasets: [] },
            options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } } }
        });
        revenueChartInstance.resize();
    }
}

document.addEventListener("DOMContentLoaded", () => {
    initBookingVolumeToggle();
    const navAnalytics = document.getElementById("nav-analytics");
    if (navAnalytics) {
        navAnalytics.addEventListener("click", () => { loadAnalytics(); });
    }
    if (document.getElementById('tab-analytics') && document.getElementById('tab-analytics').classList.contains('active')) {
        loadAnalytics();
    }
});

// -------------------------------------------------------------
// 19. INVENTORY MANAGEMENT
// -------------------------------------------------------------
const openModalBtn = document.getElementById('openAddItemModal');
if (openModalBtn) {
    openModalBtn.addEventListener('click', () => {
        document.getElementById('addItemModal').classList.add('open');
    });
}
document.getElementById('closeAddItemModal').addEventListener('click', () => {
    document.getElementById('addItemModal').classList.remove('open');
});
document.getElementById('cancelAddItemBtn').addEventListener('click', () => {
    document.getElementById('addItemModal').classList.remove('open');
});
document.getElementById('addItemModal').addEventListener('click', function(e) {
    if (e.target === this) {
        this.classList.remove('open');
    }
});

const addInventoryForm = document.getElementById("addInventoryForm");
if (addInventoryForm) {
    addInventoryForm.addEventListener("submit", async (e) => {
        e.preventDefault();

        const itemName = document.getElementById("invName").value.trim();
        const category = document.getElementById("invCategory").value;
        const unit = document.getElementById("invUnit").value.trim();
        const supplier = document.getElementById("invSupplier").value.trim() || 'Unknown';
        const stock = parseInt(document.getElementById("invQty").value) || 0;
        const threshold = parseInt(document.getElementById("invThreshold").value) || 0;
        const maxStock = parseInt(document.getElementById("invMaxStock").value) || 0;
        const cost = parseFloat(document.getElementById("invCost").value) || 0;

        if (!itemName || !category || !unit || isNaN(stock) || isNaN(threshold) || isNaN(cost)) {
            alert("Please fill in all required fields.");
            return;
        }

        try {
            await addDoc(collection(db, "inventory"), { 
                itemName, category, unit, supplier, stock, threshold, maxStock, cost, updatedAt: new Date() 
            });
            alert(`Success! "${itemName}" added to inventory.`);
            document.getElementById('addItemModal').classList.remove('open');
            addInventoryForm.reset();
        } catch (error) {
            console.error("Add Inventory Error:", error);
            alert("Failed to add inventory item: " + error.message);
        }
    });
}

function getStockStatus(item) {
    const ratio = item.stock / item.threshold;
    if (item.stock === 0) return { label: 'Critical', class: 'critical' };
    if (ratio <= 0.5) return { label: 'Low', class: 'low' };
    if (ratio <= 1.5) return { label: 'Medium', class: 'medium' };
    return { label: 'Good', class: 'in-stock' };
}

function getFilteredInventory() {
    const searchInput = document.getElementById('invSearch');
    const categoryDropdown = document.getElementById('invCategoryFilter');
    const statusDropdown = document.getElementById('invStatusFilter');

    const searchTerm = searchInput ? searchInput.value.toLowerCase() : '';
    const categoryFilter = categoryDropdown ? categoryDropdown.value : '';
    const statusFilter = statusDropdown ? statusDropdown.value : '';

    return inventoryCache.filter(item => {
        const status = getStockStatus(item);
        const searchMatch = (item.itemName || '').toLowerCase().includes(searchTerm) || 
                            (item.supplier || '').toLowerCase().includes(searchTerm);
        const categoryMatch = !categoryFilter || (item.category || '') === categoryFilter;
        const statusMatch = !statusFilter || status.class === statusFilter;
        return searchMatch && categoryMatch && statusMatch;
    });
}

function renderInventory() {
    const filtered = getFilteredInventory();

    const tbody = document.getElementById('inventoryTableBody');
    if (filtered.length === 0) {
        tbody.innerHTML = `<tr><td colspan="8" style="text-align: center; padding: 20px; color: #888;">No items found matching filters.</td></tr>`;
        return;
    }

    tbody.innerHTML = filtered.map(item => {
        const isLowStock = item.stock <= item.threshold;
        const status = getStockStatus(item);
        const statusBadge = isLowStock 
            ? `<span style="background-color: #dc3545; color: white; padding: 4px 8px; border-radius: 4px; font-size: 11px; font-weight: bold;">⚠️ LOW STOCK</span>`
            : `<span style="background-color: #28a745; color: white; padding: 4px 8px; border-radius: 4px; font-size: 11px; font-weight: bold;">IN STOCK</span>`;

        return `
            <tr>
                <td><strong>${item.itemName || "N/A"}</strong></td>
                <td>${item.category || "General"}</td>
                <td><strong>${item.stock}</strong> ${item.unit || "pcs"}</td>
                <td>N/A</td>
                <td>₱${(item.cost || 0).toLocaleString()}</td>
                <td>${item.supplier || 'N/A'}</td>
                <td>${statusBadge}</td>
                <td>
                    <div class="action-group">
                        <button class="btn-success-sm update-stock-btn" data-id="${item.id}" data-stock="${item.stock}" data-threshold="${item.threshold}" data-name="${item.itemName}" data-change="1">+1</button>
                        <button class="btn-warning-sm update-stock-btn" data-id="${item.id}" data-stock="${item.stock}" data-threshold="${item.threshold}" data-name="${item.itemName}" data-change="-1">-1</button>
                        <button class="btn-danger-sm delete-stock-btn" data-id="${item.id}">Delete</button>
                    </div>
                </td>
            </tr>
        `;
    }).join('');
}

const inventoryTableBody = document.getElementById("inventoryTableBody");
if (inventoryTableBody) {
    const inventoryQuery = collection(db, "inventory");
    onSnapshot(inventoryQuery, (snapshot) => {
        console.log("🔄 Inventory listener fired. Docs:", snapshot.size);
        inventoryCache = [];
        snapshot.forEach((docSnap) => {
            const item = docSnap.data();
            item.id = docSnap.id;
            inventoryCache.push(item);
        });
        renderInventory();
        updateInventorySummary();
        updateLowStockAlerts();
        updateLowStockKpi();
        renderInventoryCharts();
        renderReorderSuggestions();
        renderReports();
    }, (error) => {
        console.error("Error loading inventory:", error);
        inventoryTableBody.innerHTML = `<tr><td colspan="8">Error loading inventory list.</td></tr>`;
    });

    document.getElementById('invSearch').addEventListener('input', renderInventory);
    document.getElementById('invCategoryFilter').addEventListener('change', renderInventory);
    document.getElementById('invStatusFilter').addEventListener('change', renderInventory);

    document.addEventListener("click", async (e) => {
        const updateBtn = e.target.closest(".update-stock-btn");
        const deleteBtn = e.target.closest(".delete-stock-btn");

        if (updateBtn) {
            const id = updateBtn.dataset.id;
            const item = inventoryCache.find(i => i.id === id);
            if (!item) return;
            const currentStock = parseInt(item.stock) || 0;
            const change = parseInt(updateBtn.dataset.change) || 1;
            const newStock = Math.max(0, currentStock + change);
            const threshold = parseInt(item.threshold) || 0;
            const itemName = item.itemName || 'Item';

            try {
                await updateDoc(doc(db, "inventory", id), { stock: newStock, updatedAt: new Date() });
                if (change < 0 && newStock <= threshold && currentStock > threshold) {
                    await createNotification("admin", `⚠️ Low Stock Alert: "${itemName}" just dropped to ${newStock}`);
                }
            } catch (err) { console.error("Stock update error:", err); }
        }

        if (deleteBtn) {
            const id = deleteBtn.dataset.id;
            if (confirm("Are you sure you want to permanently delete this inventory item?")) {
                try {
                    await deleteDoc(doc(db, "inventory", id));
                    showToast('Deleted', 'Item deleted successfully.', 'success');
                } catch (error) {
                    console.error("Delete error:", error);
                    showToast('Error', 'Failed to delete item: ' + error.message, 'error');
                }
            }
        }
    });
}

function updateInventorySummary() {
    const total = inventoryCache.length;
    const low = inventoryCache.filter(i => i.stock <= i.threshold).length;
    const fullyStocked = inventoryCache.filter(i => i.stock > i.threshold * 2).length;
    const totalValue = inventoryCache.reduce((sum, i) => sum + (i.stock * (i.cost || 0)), 0);
    document.getElementById('invTotalItems').textContent = total;
    document.getElementById('invLowStockCount').textContent = low;
    document.getElementById('invFullyStocked').textContent = fullyStocked;
    document.getElementById('invTotalValue').textContent = '₱' + totalValue.toLocaleString();
    document.getElementById('kpiLowStock').textContent = low;
}

function updateLowStockAlerts() {
    const dashboardContainer = document.getElementById('lowStockAlerts');
    const inventoryContainer = document.getElementById('lowStockAlertList');
    const dashboardCount = document.getElementById('lowStockAlertCount');
    const inventoryCount = document.querySelector('#lowStockAlertSection #lowStockAlertCount');
    
    const lowItems = inventoryCache.filter(i => i.stock <= i.threshold);
    const alertText = lowItems.length + ' items';

    if(dashboardCount) dashboardCount.textContent = alertText;
    if(inventoryCount) inventoryCount.textContent = alertText;

    const content = lowItems.length === 0
        ? '<div style="padding:16px;text-align:center;color:#888;">✅ All items are above reorder level. Good job!</div>'
        : lowItems.map(item => `
            <div class="low-stock-alert-item">
                <div class="alert-info">
                    <div class="alert-name">${item.itemName}</div>
                    <div class="alert-detail">${item.stock} ${item.unit || ''} remaining · Reorder at ${item.threshold}</div>
                </div>
                <div class="alert-action">
                    <button class="btn-success-sm update-stock-btn" data-id="${item.id}" data-stock="${item.stock}" data-change="5">+5</button>
                </div>
            </div>
        `).join('');

    if(inventoryContainer) inventoryContainer.innerHTML = content;
    if(dashboardContainer) dashboardContainer.innerHTML = content;
}

document.getElementById('exportInventoryBtn')?.addEventListener('click', function() {
    const items = getFilteredInventory();
    if (!items.length) {
        showToast('No Data', 'No inventory items match the current filters.', 'error');
        return;
    }
    downloadCsv(csvFilename('kbeauty_inventory'), [
        'Item ID', 'Item Name', 'Category', 'Current Quantity', 'Unit', 'Reorder Level',
        'Stock Status', 'Unit Cost', 'Inventory Value', 'Last Updated'
    ], items.map(item => {
        const quantity = Number(item.stock) || 0;
        const unitCost = Number(item.cost) || 0;
        return [
            item.id, item.itemName || '', item.category || '', quantity, item.unit || '', Number(item.threshold) || 0,
            getStockStatus(item).label, csvMoney(unitCost), csvMoney(quantity * unitCost), csvDate(item.updatedAt)
        ];
    }));
    showToast('Export Complete', `${items.length} inventory item(s) exported as CSV.`, 'success');
});

let stockChart = null;
let categoryChart = null;

function renderInventoryCharts() {
    const canvas1 = document.getElementById('stockMovementChart')?.getContext('2d');
    const canvas2 = document.getElementById('categoryDistributionChart')?.getContext('2d');

    if (canvas1) {
        if (stockChart) stockChart.destroy();
        const stockData = inventoryCache.length > 0 ? [inventoryCache.length, 0, 0, 0] : [0,0,0,0]; 
        stockChart = new Chart(canvas1, {
            type: 'bar',
            data: {
                labels: ['Current Stock', 'Week 1', 'Week 2', 'Week 3'], 
                datasets: [{ label: 'Items', data: stockData, backgroundColor: 'rgba(214,51,132,0.6)', borderColor: '#d63384', borderWidth: 1, borderRadius: 4 }]
            },
            options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true } } }
        });
    }

    if (canvas2) {
        if (categoryChart) categoryChart.destroy();
        const catMap = {};
        inventoryCache.forEach(i => catMap[i.category] = (catMap[i.category] || 0) + 1);
        const labels = Object.keys(catMap);
        const data = Object.values(catMap);
        const colors = ['#f06292', '#b388ff', '#69db7c', '#ffb74d', '#74c0fc', '#fcc5c0', '#81ecec', '#ff7675'];

        if (data.length === 0) {
            categoryChart = new Chart(canvas2, {
                type: 'doughnut',
                data: { labels: ['No Items'], datasets: [{ data: [1], backgroundColor: ['#eee'], borderWidth: 0 }] },
                options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, cutout: '75%' }
            });
        } else {
            categoryChart = new Chart(canvas2, {
                type: 'doughnut',
                data: { labels: labels, datasets: [{ data: data, backgroundColor: colors.slice(0, labels.length), borderWidth: 0 }] },
                options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom', labels: { boxWidth: 12, font: { size: 11 } } } }, cutout: '65%' }
            });
        }
    }
}

function renderReorderSuggestions() {
    const container = document.getElementById('reorderSuggestions');
    const lowItems = inventoryCache.filter(i => i.stock <= i.threshold);
    if (lowItems.length === 0) {
        container.innerHTML = '<div style="padding:12px 0;color:#888;text-align:center;">No reorder suggestions at this time. All stock levels are healthy.</div>';
        return;
    }
    container.innerHTML = lowItems.map(item => `
        <div style="display:flex;justify-content:space-between;align-items:center;padding:12px 14px;background:#fff5f5;border-radius:10px;border-left:4px solid #dc3545;margin-bottom:8px;">
            <div>
                <span style="font-weight:600;">🔴 ${item.itemName}</span>
                <br><span style="font-size:13px;color:#666;">Only ${item.stock} ${item.unit || ''} left. Reorder at ${item.threshold}.</span>
            </div>
            <div style="text-align:right;">
                <div style="font-size:13px;color:#888;">Suggested order: <strong>${Math.max(item.threshold * 2, 5)} units</strong></div>
            </div>
        </div>
    `).join('');
}
// -------------------------------------------------------------
// 20. ADMIN NOTIFICATIONS SYSTEM
//     Bell button (#notifBtn) toggles the dropdown panel
//     (#notifDropdown) rendered by the real-time listener below.
// -------------------------------------------------------------
const notifBtn = document.getElementById("notifBtn");
const notifDropdown = document.getElementById("notifDropdown");
const notifBadge = document.getElementById("notifBadge");
const notifList = document.getElementById("notifList");
const notifMarkAllBtn = document.getElementById("notifMarkAllBtn");

let notifPanelOpen = false;
let adminNotificationsCache = [];

function setNotifPanelOpen(open) {
    notifPanelOpen = open;
    if (notifDropdown) notifDropdown.classList.toggle("open", open);
    if (notifBtn) notifBtn.setAttribute("aria-expanded", open ? "true" : "false");
}

function closeNotifDropdown() {
    if (notifPanelOpen) setNotifPanelOpen(false);
}

if (notifBtn) {
    notifBtn.addEventListener("click", () => {
        setNotifPanelOpen(!notifPanelOpen);
    });
}

// Click outside closes the panel; clicks inside (or on the bell) keep it open.
document.addEventListener("click", (e) => {
    if (!notifPanelOpen) return;
    if (notifBtn && notifBtn.contains(e.target)) return;
    if (notifDropdown && notifDropdown.contains(e.target)) return;
    closeNotifDropdown();
});

// Escape closes the panel.
document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && notifPanelOpen) closeNotifDropdown();
});

function notifCreatedAtDate(notif) {
    const raw = notif?.createdAt;
    if (raw && typeof raw.toDate === "function") return raw.toDate();
    if (raw instanceof Date) return raw;
    return null;
}

// Human-friendly relative time; older than a week falls back to a
// readable local date/time (stored timestamps are never modified).
function formatNotifTime(notif) {
    const date = notifCreatedAtDate(notif);
    if (!date || isNaN(date.getTime())) return "";
    const diffMs = Date.now() - date.getTime();
    const mins = Math.floor(diffMs / 60000);
    if (mins < 1) return "Just now";
    if (mins < 60) return `${mins} min ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
    const days = Math.floor(hours / 24);
    if (days === 1) return "Yesterday";
    if (days < 7) return `${days} days ago`;
    return date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

// The red badge reflects UNREAD notifications only. At zero the circle
// is removed entirely (and it starts hidden in the HTML).
function updateAdminNotifBadge(unreadCount) {
    if (!notifBadge) return;
    if (unreadCount > 0) {
        notifBadge.textContent = unreadCount > 99 ? "99+" : String(unreadCount);
        notifBadge.style.display = "flex";
    } else {
        notifBadge.textContent = "";
        notifBadge.style.display = "none";
    }
}

function renderAdminNotifications(notifications) {
    if (!notifList) return;
    if (!notifications.length) {
        notifList.innerHTML = `<div class="notif-empty"><i class="fas fa-bell-slash" style="font-size:20px; display:block; margin-bottom:8px; color:#e4cbd7;"></i>No notifications yet.</div>`;
        return;
    }
    notifList.innerHTML = notifications.map(notif => {
        const unread = !notif.isRead;
        const timeString = formatNotifTime(notif);
        return `
            <div class="admin-notif-item${unread ? " unread" : ""}" data-id="${notif.id}" data-read="${unread ? "false" : "true"}" tabindex="0">
                <span class="notif-indicator" aria-hidden="true"></span>
                <div>
                    <div class="notif-message">${escapeCustomerHtml(notif.message || "")}</div>
                    ${timeString ? `<div class="notif-time">${timeString}</div>` : ""}
                </div>
            </div>
        `;
    }).join("");
}

// Marks one notification as read; the badge/list refresh through the
// real-time snapshot, never by manual DOM bookkeeping.
async function markAdminNotificationRead(item) {
    if (!item || item.dataset.read === "true") return;
    const id = item.dataset.id;
    if (!id) return;
    try {
        await updateDoc(doc(db, "notifications", id), { isRead: true });
    } catch (err) {
        console.error("Error marking admin notification as read:", err);
        showToast("Error", "Could not mark the notification as read.", "error");
    }
}

// Delegated once — re-renders never stack duplicate listeners.
if (notifList) {
    notifList.addEventListener("click", (e) => {
        const item = e.target.closest(".admin-notif-item");
        if (item) markAdminNotificationRead(item);
    });
    notifList.addEventListener("keydown", (e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        const item = e.target.closest(".admin-notif-item");
        if (item) {
            e.preventDefault();
            markAdminNotificationRead(item);
        }
    });
}

// Mark all as read — only the Admin's unread notifications.
if (notifMarkAllBtn) {
    notifMarkAllBtn.addEventListener("click", async () => {
        const unread = adminNotificationsCache.filter(n => !n.isRead);
        if (!unread.length) return;
        notifMarkAllBtn.disabled = true;
        try {
            await Promise.all(unread.map(n => updateDoc(doc(db, "notifications", n.id), { isRead: true })));
            // The next real-time snapshot re-syncs the badge and disabled state.
        } catch (err) {
            console.error("Error marking all admin notifications as read:", err);
            showToast("Error", "Could not mark all notifications as read.", "error");
            notifMarkAllBtn.disabled = adminNotificationsCache.filter(n => !n.isRead).length === 0;
        }
    });
}

function listenToAdminNotifications() {
    const notifQuery = query(collection(db, "notifications"), where("recipientId", "==", "admin"));

    const timeValue = (notif) => {
        const date = notifCreatedAtDate(notif);
        return date && !isNaN(date.getTime()) ? date.getTime() : null;
    };

    onSnapshot(notifQuery, (snapshot) => {
        const notifications = [];
        snapshot.forEach(docSnap => notifications.push({ id: docSnap.id, ...docSnap.data() }));

        // Latest first; documents with a missing/unreadable createdAt go last.
        notifications.sort((a, b) => {
            const timeA = timeValue(a);
            const timeB = timeValue(b);
            if (timeA === null && timeB === null) return 0;
            if (timeA === null) return 1;
            if (timeB === null) return -1;
            return timeB - timeA;
        });

        adminNotificationsCache = notifications.map(n => ({ id: n.id, isRead: n.isRead === true }));

        const unreadCount = adminNotificationsCache.filter(n => !n.isRead).length;
        renderAdminNotifications(notifications);
        updateAdminNotifBadge(unreadCount);
        if (notifMarkAllBtn) notifMarkAllBtn.disabled = unreadCount === 0;
    }, (error) => {
        console.error("Error loading admin notifications:", error);
        if (notifList) notifList.innerHTML = `<div class="notif-error">Unable to load notifications.</div>`;
    });
}

listenToAdminNotifications();

function showToast(title, message, type) {
    type = type || 'info';
    const container = document.getElementById('toastContainer');
    if (!container) return;
    const toast = document.createElement('div');
    toast.className = 'toast ' + type;
    toast.innerHTML = '<div class="toast-title">' + title + '</div><div class="toast-message">' + message + '</div>';
    container.appendChild(toast);
    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateX(50px)';
        toast.style.transition = 'all 0.4s ease';
        setTimeout(() => toast.remove(), 500);
    }, 4000);
}

// -------------------------------------------------------------
// 21. REPORTS CENTER - AUTO-REFRESH IN REAL-TIME
// -------------------------------------------------------------
function renderReports() {
    const snap = buildFinancialSnapshot(appointmentsCache);
    const { currentMonth, currentYear } = snap;

    let periodBookings = 0;
    let periodServed = 0;
    let periodCancelled = 0;
    const periodActiveClients = new Set();

    appointmentsCache.forEach(appt => {
        const apptDate = parseApptDate(appt);
        if (isNaN(apptDate.getTime())) return;
        if (apptDate.getMonth() !== currentMonth || apptDate.getFullYear() !== currentYear) return;

        periodBookings++;
        const status = apptStatus(appt);
        if (status === 'cancelled') periodCancelled++;
        if (isRevenueEligibleStatus(appt.status)) {
            periodServed++;
            if (appt.clientId) periodActiveClients.add(appt.clientId);
            else if (appt.clientEmail) periodActiveClients.add(appt.clientEmail.toLowerCase());
            else if (appt.clientName) periodActiveClients.add(appt.clientName.toLowerCase());
        }
    });

    const completionRate = periodBookings > 0 ? Math.round((periodServed / periodBookings) * 100) : 0;
    const activeClients = clientsCache.length;

    let totalVisits = 0;
    clientsCache.forEach(c => {
        totalVisits += computeClientStats(c).visits;
    });
    const avgVisits = activeClients > 0 ? Math.round(totalVisits / activeClients) : 0;

    const topService = Object.entries(snap.catMap).sort((a, b) => b[1] - a[1])[0]?.[0] || 'N/A';

    const reportStats = document.querySelectorAll('#tab-reports .stat-mini .number');
    if (reportStats.length >= 4) {
        reportStats[0].textContent = `₱${snap.monthlyTotal.toLocaleString()}`;
        reportStats[1].textContent = periodBookings;
        reportStats[2].textContent = periodActiveClients.size || activeClients;
        reportStats[3].textContent = `${completionRate}%`;
    }

    const salesReportStat = document.querySelector('#tab-reports .report-card:nth-child(1) .rs-item:nth-child(1) strong');
    const salesTxStat = document.querySelector('#tab-reports .report-card:nth-child(1) .rs-item:nth-child(2) strong');
    const salesTopStat = document.querySelector('#tab-reports .report-card:nth-child(1) .rs-item:nth-child(3) strong');
    if (salesReportStat) salesReportStat.textContent = `₱${snap.allTimeTotal.toLocaleString()}`;
    if (salesTxStat) salesTxStat.textContent = snap.transactionRows.length;
    if (salesTopStat) salesTopStat.textContent = topService;

    const clientTotalEl = document.querySelector('#tab-reports .report-card:nth-child(2) .rs-item:nth-child(1) strong');
    const clientActiveEl = document.querySelector('#tab-reports .report-card:nth-child(2) .rs-item:nth-child(2) strong');
    const clientAvgEl = document.querySelector('#tab-reports .report-card:nth-child(2) .rs-item:nth-child(3) strong');
    if (clientTotalEl) clientTotalEl.textContent = activeClients;
    if (clientActiveEl) clientActiveEl.textContent = periodActiveClients.size;
    if (clientAvgEl) clientAvgEl.textContent = avgVisits;

    const apptTotalEl = document.querySelector('#tab-reports .report-card:nth-child(3) .rs-item:nth-child(1) strong');
    const apptServedEl = document.querySelector('#tab-reports .report-card:nth-child(3) .rs-item:nth-child(2) strong');
    const apptCancelEl = document.querySelector('#tab-reports .report-card:nth-child(3) .rs-item:nth-child(3) strong');
    if (apptTotalEl) apptTotalEl.textContent = periodBookings;
    if (apptServedEl) apptServedEl.textContent = periodServed;
    if (apptCancelEl) apptCancelEl.textContent = periodCancelled;

    const totalItems = inventoryCache.length;
    const lowStockItems = inventoryCache.filter(i => (i.stock || 0) <= (i.threshold || 0)).length;
    const totalStockValue = inventoryCache.reduce((sum, i) => sum + ((i.stock || 0) * (i.cost || 0)), 0);
    const invTotalEl = document.querySelector('#tab-reports .report-card:nth-child(4) .rs-item:nth-child(1) strong');
    const invLowEl = document.querySelector('#tab-reports .report-card:nth-child(4) .rs-item:nth-child(2) strong');
    const invValEl = document.querySelector('#tab-reports .report-card:nth-child(4) .rs-item:nth-child(3) strong');
    if (invTotalEl) invTotalEl.textContent = totalItems;
    if (invLowEl) invLowEl.textContent = lowStockItems;
    if (invValEl) invValEl.textContent = `₱${totalStockValue.toLocaleString()}`;
}

// -------------------------------------------------------------
// 21.1 REPORTS CENTER PDF EXPORTS
// -------------------------------------------------------------
// These calculations mirror renderReports so a downloaded report always
// represents the same data and period displayed in its card.
function getReportsPdfMetrics() {
    const snap = buildFinancialSnapshot(appointmentsCache);
    const { currentMonth, currentYear } = snap;
    let periodBookings = 0;
    let periodServed = 0;
    let periodCancelled = 0;
    const periodActiveClients = new Set();
    const periodAppointments = [];

    appointmentsCache.forEach(appt => {
        const apptDate = parseApptDate(appt);
        if (isNaN(apptDate.getTime())) return;
        if (apptDate.getMonth() !== currentMonth || apptDate.getFullYear() !== currentYear) return;
        periodAppointments.push(appt);
        periodBookings++;
        const status = apptStatus(appt);
        if (status === 'cancelled') periodCancelled++;
        if (isRevenueEligibleStatus(appt.status)) {
            periodServed++;
            if (appt.clientId) periodActiveClients.add(appt.clientId);
            else if (appt.clientEmail) periodActiveClients.add(appt.clientEmail.toLowerCase());
            else if (appt.clientName) periodActiveClients.add(appt.clientName.toLowerCase());
        }
    });

    const totalClients = clientsCache.length;
    const totalVisits = clientsCache.reduce((sum, client) => sum + computeClientStats(client).visits, 0);
    const avgVisits = totalClients > 0 ? Math.round(totalVisits / totalClients) : 0;
    const topService = Object.entries(snap.catMap).sort((a, b) => b[1] - a[1])[0]?.[0] || 'N/A';
    return { snap, periodAppointments, periodBookings, periodServed, periodCancelled, periodActiveClients, totalClients, avgVisits, topService };
}

function reportPdfFilename(reportName) {
    const date = new Date();
    const datePart = [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
    return `KBeauty_${reportName}_Report_${datePart}.pdf`;
}

function isClientActiveInReportPeriod(client, activeClientKeys) {
    const keys = [
        client.id,
        client.email ? client.email.toLowerCase() : '',
        client.fullName ? client.fullName.toLowerCase() : ''
    ].filter(Boolean);
    return keys.some(key => activeClientKeys.has(key));
}

function getClientLastVisit(client) {
    const visits = appointmentsCache
        .filter(appt => appointmentBelongsToClient(appt, client) && isRevenueEligibleStatus(appt.status))
        .map(parseApptDate)
        .filter(date => !Number.isNaN(date.getTime()))
        .sort((a, b) => b - a);
    return visits[0] ? formatReportDate(visits[0]) : '—';
}

function exportSalesReportPDF() {
    const { snap, topService } = getReportsPdfMetrics();
    downloadReportPdf({
        reportName: 'Sales Report',
        period: 'All recorded served or completed appointments',
        summary: [
            { label: 'Total Revenue', value: formatReportMoney(snap.allTimeTotal) },
            { label: 'Transactions', value: snap.transactionRows.length },
            { label: 'Top Service', value: topService }
        ],
        columns: ['Date', 'Transaction ID', 'Client', 'Service', 'Staff / Stylist', 'Payment', 'Amount', 'Status'],
        rows: snap.transactionRows.map(row => [
            row.dateKey || row.date, row.id, row.clientName, row.serviceName, row.staffName,
            row.paymentMethod, formatReportMoney(row.amount), row.paymentStatus
        ]),
        filename: reportPdfFilename('Sales'),
        orientation: 'landscape'
    });
}

function exportClientReportPDF() {
    const { totalClients, avgVisits, periodActiveClients } = getReportsPdfMetrics();
    downloadReportPdf({
        reportName: 'Client Report',
        period: 'All registered clients; active metric is for the current month',
        summary: [
            { label: 'Total Clients', value: totalClients },
            { label: 'Active Clients', value: periodActiveClients.size },
            { label: 'Average Visits', value: avgVisits }
        ],
        columns: ['Client Name', 'Email', 'Visit Count', 'Last Visit', 'Current-Month Status'],
        rows: clientsCache.map(client => {
            const stats = computeClientStats(client);
            const active = isClientActiveInReportPeriod(client, periodActiveClients);
            return [client.fullName || 'Unknown', client.email || '—', stats.visits, getClientLastVisit(client), active ? 'Active' : 'Inactive'];
        }),
        filename: reportPdfFilename('Client')
    });
}

function exportAppointmentReportPDF() {
    const { snap, periodAppointments, periodBookings, periodServed, periodCancelled } = getReportsPdfMetrics();
    const period = new Date(snap.currentYear, snap.currentMonth, 1).toLocaleDateString('en-PH', { month: 'long', year: 'numeric' });
    downloadReportPdf({
        reportName: 'Appointment Report',
        period,
        summary: [
            { label: 'Total Bookings', value: periodBookings },
            { label: 'Served / Completed', value: periodServed },
            { label: 'Cancellations', value: periodCancelled }
        ],
        columns: ['Date', 'Time', 'Client', 'Service', 'Stylist', 'Status', 'Payment Method'],
        rows: periodAppointments.slice().sort((a, b) => parseApptDate(b) - parseApptDate(a)).map(appt => [
            formatReportDate(parseApptDate(appt)), appt.bookingTime || appt.time || '—',
            appt.clientName || appt.clientEmail || 'Unknown', appt.serviceName || 'Service',
            appt.staffName || 'Unassigned', appt.status || '—', appt.paymentMethod || '—'
        ]),
        filename: reportPdfFilename('Appointment'),
        orientation: 'landscape'
    });
}

function exportInventoryReportPDF() {
    const totalStockValue = inventoryCache.reduce((sum, item) => sum + ((Number(item.stock) || 0) * (Number(item.cost) || 0)), 0);
    const lowStockItems = inventoryCache.filter(item => (item.stock || 0) <= (item.threshold || 0)).length;
    downloadReportPdf({
        reportName: 'Inventory Report',
        period: 'Current inventory snapshot',
        summary: [
            { label: 'Total Items', value: inventoryCache.length },
            { label: 'Low Stock Items', value: lowStockItems },
            { label: 'Total Stock Value', value: formatReportMoney(totalStockValue) }
        ],
        columns: ['Item Name', 'Category', 'Quantity', 'Unit', 'Reorder Level', 'Stock Status', 'Unit Cost', 'Stock Value'],
        rows: inventoryCache.map(item => {
            const quantity = Number(item.stock) || 0;
            const unitCost = Number(item.cost) || 0;
            return [
                item.itemName || 'Unnamed item', item.category || '—', quantity, item.unit || '—',
                Number(item.threshold) || 0, getStockStatus(item).label,
                formatReportMoney(unitCost), formatReportMoney(quantity * unitCost)
            ];
        }),
        filename: reportPdfFilename('Inventory'),
        orientation: 'landscape'
    });
}

const reportPdfExporters = {
    sales: exportSalesReportPDF,
    clients: exportClientReportPDF,
    appointments: exportAppointmentReportPDF,
    inventory: exportInventoryReportPDF
};

function bindReportsPdfExport() {
    const reportsTab = document.getElementById('tab-reports');
    if (!reportsTab || reportsTab.dataset.pdfExportBound === 'true') return;
    reportsTab.dataset.pdfExportBound = 'true';
    reportsTab.addEventListener('click', event => {
        const button = event.target.closest('[data-report-export]');
        if (!button || !reportsTab.contains(button) || button.disabled) return;
        const exporter = reportPdfExporters[button.dataset.reportExport];
        if (!exporter) return;

        const originalMarkup = button.innerHTML;
        button.disabled = true;
        button.setAttribute('aria-busy', 'true');
        button.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Generating...';
        try {
            exporter();
            showToast('Export Complete', 'Report PDF downloaded.', 'success');
        } catch (error) {
            console.error(`[Reports PDF] ${button.dataset.reportExport} report export failed:`, error);
            showToast('PDF Export Failed', 'Could not generate the report PDF. Please try again.', 'error');
        } finally {
            button.disabled = false;
            button.removeAttribute('aria-busy');
            button.innerHTML = originalMarkup;
        }
    });
}

bindReportsPdfExport();

// -------------------------------------------------------------
// 22. HELPER: RENDER UPCOMING APPOINTMENTS
// -------------------------------------------------------------
function renderUpcomingAppointments() {
    const container = document.getElementById('upcomingAppointments');
    if (!container) return;
    const upcoming = appointmentsCache.filter(a => {
        const s = apptStatus(a);
        return s === 'pending' || s === 'confirmed';
    }).slice(0, 5);
    if (upcoming.length === 0) {
        container.innerHTML = '<div style="padding:12px 0;color:#888;text-align:center;">No upcoming appointments.</div>';
        return;
    }
    container.innerHTML = upcoming.map(a => `
        <div class="appointment-item">
            <div class="appt-info">
                <span class="appt-client">${a.clientName || a.clientEmail || 'N/A'}</span>
                <span class="appt-service">${a.serviceName || 'Service'} · ${a.staffName || 'Unassigned'}</span>
            </div>
            <span class="appt-time">${a.bookingDate || a.date || ''} ${a.bookingTime || ''}</span>
        </div>
    `).join('');
}

// -------------------------------------------------------------
// 24. REPORTS TAB CLICK LISTENER
// -------------------------------------------------------------
document.addEventListener("DOMContentLoaded", () => {
    const navReports = document.getElementById("nav-reports");
    if (navReports) {
        navReports.addEventListener("click", () => { renderReports(); });
    }
    if (document.getElementById('tab-reports') && document.getElementById('tab-reports').classList.contains('active')) {
        renderReports();
    }
});

console.log("✅ admin.js fully loaded with all fixes.");
