import { auth, db } from "./firebase-config.js";
import { signOut, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-auth.js";
import { requireMfaOrRedirect, clearMfaSession } from "./auth-guard.js";
import { deliverNotification } from "./notification-delivery.js";
import { saveUserProfilePhoto, applyAvatarImage } from "./profile-photo.js";
import { openLogoutConfirmation } from "./logout-confirmation.js";
import {
    collection, query, where, onSnapshot, doc, updateDoc, addDoc, getDoc, getDocs,
    serverTimestamp, deleteDoc, setDoc
} from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";
import {
    STAFF_ROLES, normalizeStatus, getStatusMeta, isActiveAppointmentStatus,
    isBlockingAppointmentStatus, getTodayKey, toLocalDateKey, formatDisplayTime,
    formatTimeRange, formatPrice, getApptDate, getApptTime, getAppointmentDuration,
    validateStylistSlot, defaultWeeklyHours, randomizedWeeklyHours, isLegacySundayOffSchedule, needsStylistAssignment, SALON_OPEN_MINUTES,
    SALON_CLOSE_MINUTES, TIME_SLOT_INTERVAL, minutesToTime, timeToMinutes, getDayKeyFromDate,
    applyBookingDateInputLimits
} from "./appointment-utils.js";

// =============================================================
// STATE
// =============================================================
let currentUser = null;
let currentProfile = null;
let allAppointments = [];
let allStylists = [];
let allServices = [];
let allClients = [];
let stylistSchedules = {};
let clientNotes = [];
let waitingList = [];
let staffNotifications = [];
let selectedStylistId = null;
let stylistSpecialtiesEditFor = null;
let selectedClientId = null;
let assignTargetApptId = null;
let selectedAssignStylistId = null;
let calendarView = 'day';
let calendarDate = new Date();
let confirmCallback = null;
let pendingDenyAppt = null;

const TAB_TITLES = {
    tabDashboard: 'Dashboard',
    tabAppointments: 'Appointments',
    tabCalendar: 'Calendar',
    tabStylists: 'Stylists',
    tabClients: 'Clients',
    tabWalkins: 'Walk-ins',
    tabWaiting: 'Waiting List',
    tabNotifications: 'Notifications',
    tabProfile: 'My Profile'
};

// =============================================================
// UTILITIES
// =============================================================
function showToast(message, type = 'info') {
    const el = document.getElementById('staffToast');
    if (!el) return;
    el.textContent = message;
    el.className = `staff-toast show toast-${type}`;
    clearTimeout(showToast._timer);
    showToast._timer = setTimeout(() => el.classList.remove('show'), 3500);
}

function getGreeting() {
    const h = new Date().getHours();
    if (h < 12) return 'Good Morning';
    if (h < 17) return 'Good Afternoon';
    return 'Good Evening';
}

function isStaffRole(role) {
    return STAFF_ROLES.includes(role);
}

async function createNotification(recipientId, message) {
    try {
        await addDoc(collection(db, "notifications"), {
            recipientId, message, isRead: false, createdAt: serverTimestamp()
        });
        if (recipientId && recipientId !== "admin" && recipientId !== "staff") {
            deliverNotification(recipientId, message).catch(console.warn);
        }
    } catch (e) {
        console.error("Notification error:", e);
    }
}

function showConfirm(title, message, onConfirm, danger = false) {
    document.getElementById('confirmTitle').textContent = title;
    document.getElementById('confirmMessage').textContent = message;
    const okBtn = document.getElementById('confirmOk');
    okBtn.className = danger ? 'btn-danger' : 'btn-primary';
    confirmCallback = onConfirm;
    document.getElementById('confirmOverlay').classList.add('open');
}

function closeConfirm() {
    document.getElementById('confirmOverlay').classList.remove('open');
    confirmCallback = null;
}

function generateTimeSlots(durationMins = 60) {
    const slots = [];
    for (let start = SALON_OPEN_MINUTES; start + durationMins <= SALON_CLOSE_MINUTES; start += TIME_SLOT_INTERVAL) {
        slots.push(minutesToTime(start));
    }
    return slots;
}

function renderStatusBadge(appt) {
    const meta = getStatusMeta(appt.status, appt.operationalStatus);
    return `<span class="status-badge ${meta.className}">${meta.icon} ${meta.label}</span>`;
}

function getScheduleForStylist(stylistUid) {
    if (stylistSchedules[stylistUid]) return stylistSchedules[stylistUid];
    return { weeklyHours: randomizedWeeklyHours(stylistUid), blocks: [] };
}

function isStylistAvailable(stylistUid, date, time, durationMins, excludeApptId = null) {
    const schedule = getScheduleForStylist(stylistUid);
    return !validateStylistSlot(allAppointments, schedule, stylistUid, date, time, durationMins, excludeApptId);
}

// Qualification mirrors the Client picker: stylists with no declared
// specialties are all-rounders (qualified for everything); otherwise one of
// their specialties must match the service category.
function isStylistQualifiedForService(staff, serviceId) {
    if (!staff || !serviceId) return true;
    const service = allServices.find(s => s.id === serviceId);
    return isStylistQualifiedForCategory(staff, service ? service.category : '');
}

function isStylistQualifiedForCategory(staff, category) {
    if (!staff) return true;
    const specialties = staff.specialties;
    if (!Array.isArray(specialties) || specialties.length === 0) return true;
    const cat = (category || '').trim().toLowerCase();
    if (!cat) return true;
    return specialties.some(spec => (spec || '').trim().toLowerCase() === cat);
}

// =============================================================
// AUTH
// =============================================================
async function logoutUser() {
    clearMfaSession();
    await signOut(auth);
    window.location.href = "../index.html";
}

document.getElementById('logout-btn')?.addEventListener('click', () => {
    openLogoutConfirmation(logoutUser);
});

onAuthStateChanged(auth, async (user) => {
    if (!user) {
        window.location.href = "../index.html";
        return;
    }
    if (!requireMfaOrRedirect(user)) return;
    currentUser = user;
    const userDoc = await getDoc(doc(db, "users", user.uid));
    if (!userDoc.exists() || !isStaffRole(userDoc.data().role)) {
        showToast("Access denied. Staff account required.", "error");
        setTimeout(() => window.location.href = "../index.html", 1500);
        return;
    }
    currentProfile = userDoc.data();
    initStaffPortal(user);
});

function initStaffPortal(user) {
    const name = currentProfile.fullName || user.displayName || 'Staff';
    document.getElementById('staffName').textContent = name.split(' ')[0];
    document.getElementById('staffGreeting').textContent = getGreeting();
    document.getElementById('staffTodayDate').textContent = new Date().toLocaleDateString('en-US', {
        weekday: 'long', month: 'long', day: 'numeric', year: 'numeric'
    });
    document.getElementById('profileDisplayName').textContent = name;
    document.getElementById('profileDisplayEmail').textContent = user.email || '';
    document.getElementById('profileDisplayRole').textContent = currentProfile.role || 'Staff';
    const initial = name.charAt(0).toUpperCase();
    const profilePhoto = currentProfile.photoURL || '';
    ['topbarAvatar', 'profileAvatarLg'].forEach(id => {
        const el = document.getElementById(id);
        if (el) applyAvatarImage(profilePhoto, el, initial);
    });

    const staffPhotoInput = document.getElementById('staffProfilePhotoInput');
    if (staffPhotoInput) {
        const avatarLg = document.getElementById('profileAvatarLg');
        const openPicker = () => staffPhotoInput.click();
        avatarLg?.addEventListener('click', openPicker);
        document.getElementById('staffUploadPhotoBtn')?.addEventListener('click', openPicker);
        staffPhotoInput.addEventListener('change', async (e) => {
            const file = e.target.files?.[0];
            if (!file || !currentUser) return;
            avatarLg?.classList.add('is-uploading');
            try {
                const url = await saveUserProfilePhoto(currentUser.uid, file);
                currentProfile = { ...currentProfile, photoURL: url };
                ['topbarAvatar', 'profileAvatarLg'].forEach(id => {
                    const el = document.getElementById(id);
                    if (el) applyAvatarImage(url, el, initial);
                });
                showToast('Profile photo updated.', 'success');
            } catch (err) {
                showToast(err.message || 'Could not upload photo.', 'error');
            } finally {
                avatarLg?.classList.remove('is-uploading');
                staffPhotoInput.value = '';
            }
        });
    }

    initNavigation();
    initModals();
    initWalkinForm();
    initWaitingForm();
    loadAllData(user.uid);
}

// =============================================================
// DATA LISTENERS
// =============================================================
function loadAllData(staffUid) {
    onSnapshot(collection(db, "appointments"), (snap) => {
        allAppointments = [];
        snap.forEach(d => allAppointments.push({ id: d.id, ...d.data() }));
        allAppointments.sort((a, b) => {
            const da = getApptDate(a) + getApptTime(a);
            const db_ = getApptDate(b) + getApptTime(b);
            return da.localeCompare(db_);
        });
        renderAllViews();
    });

    const stylistQueries = STAFF_ROLES.map(role =>
        getDocs(query(collection(db, "users"), where("role", "==", role)))
    );
    Promise.all(stylistQueries).then(results => {
        allStylists = [];
        results.forEach(snap => snap.forEach(d => {
            const data = d.data();
            if (data.deleted === true) return;
            allStylists.push({ id: d.id, ...data });
        }));
        allStylists.sort((a, b) => (a.fullName || '').localeCompare(b.fullName || ''));
        populateStylistSelects();
        renderStylistPicker();
    });

    getDocs(collection(db, "services")).then(snap => {
        allServices = [];
        snap.forEach(d => allServices.push({ id: d.id, ...d.data() }));
        populateWalkinServices();
    });

    getDocs(query(collection(db, "users"), where("role", "==", "Client"))).then(snap => {
        allClients = [];
        snap.forEach(d => {
            const data = d.data();
            if (data.deleted === true) return;
            allClients.push({ id: d.id, ...data });
        });
        renderClientPicker();
    }).catch(() => {
        allClients = dedupeClientsFromAppointments();
        renderClientPicker();
    });

    onSnapshot(collection(db, "stylistSchedules"), (snap) => {
        stylistSchedules = {};
        snap.forEach(d => { stylistSchedules[d.id] = { stylistUid: d.id, ...d.data() }; });
        migrateLegacyStylistSchedules();
        renderStylistDetail();
    });

    onSnapshot(collection(db, "clientNotes"), (snap) => {
        clientNotes = [];
        snap.forEach(d => clientNotes.push({ id: d.id, ...d.data() }));
        renderClientDetail();
    });

    onSnapshot(collection(db, "waitingList"), (snap) => {
        waitingList = [];
        snap.forEach(d => waitingList.push({ id: d.id, ...d.data() }));
        waitingList.sort((a, b) => (b.createdAt?.toMillis?.() || 0) - (a.createdAt?.toMillis?.() || 0));
        renderWaitingList();
        renderDashboardWaiting();
    });

    onSnapshot(query(collection(db, "notifications"), where("recipientId", "in", [staffUid, "staff"])), (snap) => {
        staffNotifications = [];
        let unread = 0;
        snap.forEach(d => {
            const n = { id: d.id, ...d.data() };
            staffNotifications.push(n);
            if (!n.isRead) unread++;
        });
        staffNotifications.sort((a, b) => (b.createdAt?.toMillis?.() || 0) - (a.createdAt?.toMillis?.() || 0));
        updateNotifBadges(unread);
        renderNotifications();
    });
}

function dedupeClientsFromAppointments() {
    const map = new Map();
    allAppointments.forEach(a => {
        if (a.clientId && !map.has(a.clientId)) {
            map.set(a.clientId, { id: a.clientId, fullName: a.clientName, email: a.clientEmail });
        }
    });
    return [...map.values()];
}

function renderAllViews() {
    renderDashboard();
    renderAppointments();
    renderCalendar();
    renderRecentWalkins();
    checkNewAppointments();
}

// =============================================================
// DASHBOARD
// =============================================================
function renderDashboard() {
    const today = getTodayKey();
    const todayAppts = allAppointments.filter(a => getApptDate(a) === today && !a.archived);
    const active = allAppointments.filter(a => !a.archived);
    const pending = active.filter(a => normalizeStatus(a.status) === 'pending');
    const confirmed = active.filter(a => normalizeStatus(a.status) === 'confirmed');
    const served = active.filter(a => ['served', 'completed'].includes(normalizeStatus(a.status)));
    const cancelled = active.filter(a => normalizeStatus(a.status) === 'cancelled');
    const noShow = active.filter(a => normalizeStatus(a.status) === 'no-show');
    const needsAssign = active.filter(a => needsStylistAssignment(a) && isActiveAppointmentStatus(a.status));
    const waiting = active.filter(a => a.operationalStatus === 'checked_in' && normalizeStatus(a.status) === 'confirmed');
    const upcoming = active.filter(a => {
        const d = getApptDate(a);
        return d >= today && isActiveAppointmentStatus(a.status);
    });
    const availableStylists = countAvailableStylistsNow();

    const kpis = [
        { value: todayAppts.length, label: "Today's Appointments", icon: 'fa-calendar-day' },
        { value: upcoming.length, label: 'Upcoming', icon: 'fa-clock' },
        { value: pending.length, label: 'Pending', icon: 'fa-hourglass' },
        { value: availableStylists, label: 'Stylists Available', icon: 'fa-user-check' },
        { value: waiting.length, label: 'Clients Waiting', icon: 'fa-person-walking' },
        { value: served.filter(a => getApptDate(a) === today).length, label: 'Served Today', icon: 'fa-check-circle' },
        { value: cancelled.filter(a => getApptDate(a) === today).length, label: 'Cancelled Today', icon: 'fa-ban' },
        { value: noShow.filter(a => getApptDate(a) === today).length, label: 'No-Shows Today', icon: 'fa-user-slash' }
    ];

    document.getElementById('staffKpiGrid').innerHTML = kpis.map(k => `
        <div class="kpi-card">
            <div class="kpi-icon"><i class="fas ${k.icon}"></i></div>
            <div class="kpi-value">${k.value}</div>
            <div class="kpi-label">${k.label}</div>
        </div>
    `).join('');

    document.getElementById('opsSummaryGrid').innerHTML = `
        <div class="ops-item"><span>Appointments</span><strong>${todayAppts.length}</strong></div>
        <div class="ops-item"><span>Confirmed</span><strong>${confirmed.filter(a => getApptDate(a) === today).length}</strong></div>
        <div class="ops-item"><span>Pending</span><strong>${pending.filter(a => getApptDate(a) === today).length}</strong></div>
        <div class="ops-item"><span>Needs Assignment</span><strong>${needsAssign.filter(a => getApptDate(a) === today).length}</strong></div>
        <div class="ops-item"><span>Served</span><strong>${served.filter(a => getApptDate(a) === today).length}</strong></div>
        <div class="ops-item"><span>Walk-ins</span><strong>${todayAppts.filter(a => a.isWalkIn).length}</strong></div>
        <div class="ops-item"><span>Cancelled</span><strong>${cancelled.filter(a => getApptDate(a) === today).length}</strong></div>
        <div class="ops-item"><span>No Show</span><strong>${noShow.filter(a => getApptDate(a) === today).length}</strong></div>
    `;

    const list = document.getElementById('todayApptList');
    const sorted = [...todayAppts].sort((a, b) => getApptTime(a).localeCompare(getApptTime(b)));
    list.innerHTML = sorted.length ? sorted.map(renderApptRowCompact).join('') : '<p class="empty-hint">No appointments scheduled for today.</p>';
    list.querySelectorAll('[data-action]').forEach(btn => btn.addEventListener('click', handleApptAction));
}

function countAvailableStylistsNow() {
    const today = getTodayKey();
    const now = new Date();
    const timeStr = minutesToTime(now.getHours() * 60 + now.getMinutes());
    return allStylists.filter(s => isStylistAvailable(s.id, today, timeStr, 30)).length;
}

function renderApptRowCompact(appt) {
    const dur = getAppointmentDuration(appt);
    const timeRange = formatTimeRange(getApptTime(appt), dur);
    const assignWarn = needsStylistAssignment(appt) ? '<span class="assign-warn">⚠ Needs Assignment</span>' : '';
    return `
        <div class="appt-row-compact">
            <div class="appt-row-time">${timeRange}</div>
            <div class="appt-row-main">
                <strong>${appt.clientName || appt.clientEmail || 'Client'}</strong>
                <span>${appt.serviceName || 'Service'} · ${appt.staffName || 'Unassigned'} ${assignWarn}</span>
            </div>
            <div class="appt-row-status">${renderStatusBadge(appt)}</div>
            <div class="appt-row-actions">${getQuickActions(appt)}</div>
        </div>`;
}

function renderDashboardWaiting() {
    const waiting = allAppointments.filter(a =>
        a.operationalStatus === 'checked_in' &&
        normalizeStatus(a.status) === 'confirmed' &&
        !a.archived
    );
    document.getElementById('waitingCountPill').textContent = waiting.length;
    const el = document.getElementById('dashboardWaitingList');
    el.innerHTML = waiting.length ? waiting.map(a => `
        <div class="waiting-card">
            <strong>${a.clientName || 'Client'}</strong>
            <p>${a.serviceName} · Stylist: ${a.staffName || '—'}</p>
            <p class="muted">Checked in: ${a.checkedInAt ? formatDisplayTimeFromTimestamp(a.checkedInAt) : '—'}</p>
            <button type="button" class="btn-primary btn-sm" data-action="in-service" data-id="${a.id}">Start Service</button>
        </div>
    `).join('') : '<p class="empty-hint">No clients waiting right now.</p>';
    el.querySelectorAll('[data-action]').forEach(btn => btn.addEventListener('click', handleApptAction));
}

function formatDisplayTimeFromTimestamp(ts) {
    const d = ts?.toDate?.() || new Date(ts);
    return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

// =============================================================
// APPOINTMENTS LIST
// =============================================================
function getFilteredAppointments() {
    const search = (document.getElementById('apptSearch')?.value || '').toLowerCase();
    const statusFilter = document.getElementById('apptStatusFilter')?.value || 'active';
    const dateFilter = document.getElementById('apptDateFilter')?.value || '';

    return allAppointments.filter(appt => {
        const text = `${appt.clientName} ${appt.clientEmail} ${appt.serviceName} ${appt.staffName}`.toLowerCase();
        if (search && !text.includes(search)) return false;
        if (dateFilter && getApptDate(appt) !== dateFilter) return false;

        const norm = normalizeStatus(appt.status);
        if (statusFilter === 'active') return !appt.archived && isActiveAppointmentStatus(appt.status);
        if (statusFilter === 'archived') return appt.archived === true;
        if (statusFilter === 'needs-assignment') return needsStylistAssignment(appt) && isActiveAppointmentStatus(appt.status);
        if (statusFilter === 'all') return true;
        return norm === statusFilter;
    });
}

function renderAppointments() {
    const filtered = getFilteredAppointments();
    document.getElementById('apptCount').textContent = `${filtered.length} appointment${filtered.length !== 1 ? 's' : ''}`;

    const tbody = document.getElementById('apptTableBody');
    const cards = document.getElementById('apptCardsMobile');

    if (!filtered.length) {
        const empty = '<p class="empty-hint">No appointments match your filters.</p>';
        if (tbody) tbody.innerHTML = `<tr><td colspan="6">${empty}</td></tr>`;
        if (cards) cards.innerHTML = empty;
        return;
    }

    if (tbody) {
        tbody.innerHTML = filtered.map(appt => {
            const dur = getAppointmentDuration(appt);
            const assignLabel = needsStylistAssignment(appt)
                ? '<span class="assign-warn">⚠ Assignment Required</span>'
                : (appt.staffName || '—');
            return `
                <tr>
                    <td>${formatTimeRange(getApptTime(appt), dur)}<br><small>${getApptDate(appt)}</small></td>
                    <td><strong>${appt.clientName || appt.clientEmail}</strong></td>
                    <td>${appt.serviceName || '—'}</td>
                    <td>${assignLabel}</td>
                    <td>${renderStatusBadge(appt)}</td>
                    <td class="actions-cell">${getQuickActions(appt)}${getMoreMenu(appt)}</td>
                </tr>`;
        }).join('');
    }

    if (cards) {
        cards.innerHTML = filtered.map(appt => `
            <div class="appt-card-mobile">
                <div class="appt-card-head">
                    <strong>${appt.clientName || appt.clientEmail}</strong>
                    ${renderStatusBadge(appt)}
                </div>
                <p>${appt.serviceName} · ${formatTimeRange(getApptTime(appt), getAppointmentDuration(appt))}</p>
                <p class="muted">${getApptDate(appt)} · ${appt.staffName || 'Unassigned'}</p>
                <div class="appt-card-actions">${getQuickActions(appt)}${getMoreMenu(appt)}</div>
            </div>
        `).join('');
    }

    document.querySelectorAll('[data-action]').forEach(btn => btn.addEventListener('click', handleApptAction));
    document.querySelectorAll('[data-dropdown]').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const menu = btn.nextElementSibling;
            document.querySelectorAll('.dropdown-menu.open').forEach(m => { if (m !== menu) m.classList.remove('open'); });
            menu?.classList.toggle('open');
        });
    });
}

function getQuickActions(appt) {
    const norm = normalizeStatus(appt.status);
    const ops = appt.operationalStatus;
    let html = `<button type="button" class="btn-action" data-action="view" data-id="${appt.id}">View</button>`;

    if (needsStylistAssignment(appt) && isActiveAppointmentStatus(appt.status)) {
        html += `<button type="button" class="btn-action btn-accent" data-action="assign" data-id="${appt.id}">Assign</button>`;
    } else if (norm === 'confirmed' && appt.staffUid && ops !== 'checked_in') {
        html += `<button type="button" class="btn-action btn-accent" data-action="check-in" data-id="${appt.id}">Check In</button>`;
    } else if (ops === 'checked_in') {
        html += `<button type="button" class="btn-action" data-action="in-service" data-id="${appt.id}">In Service</button>`;
    } else if (ops === 'in_service') {
        html += `<button type="button" class="btn-action btn-accent" data-action="served" data-id="${appt.id}">Mark Served</button>`;
    }

    if (norm === 'pending') {
        html += `<button type="button" class="btn-action" data-action="confirm" data-id="${appt.id}">Confirm</button>`;
    }

    if (norm === 'confirmed' && appt.staffUid && !ops) {
        html += `<button type="button" class="btn-action" data-action="reassign" data-id="${appt.id}">Reassign</button>`;
    }

    return html;
}

function getMoreMenu(appt) {
    if (appt.archived) {
        return `
            <div class="dropdown-wrap">
                <button type="button" class="btn-icon-sm" data-dropdown="${appt.id}"><i class="fas fa-ellipsis-v"></i></button>
                <div class="dropdown-menu">
                    <button type="button" class="dropdown-item" data-action="unarchive" data-id="${appt.id}">Unarchive</button>
                    <button type="button" class="dropdown-item" data-action="notes" data-id="${appt.id}">Add Note</button>
                </div>
            </div>`;
    }

    const norm = normalizeStatus(appt.status);
    const items = [];

    if (norm === 'pending') {
        items.push({ action: 'deny', label: 'Deny' });
    }
    if (norm === 'confirmed' && !appt.operationalStatus) {
        items.push({ action: 'no-show', label: 'Mark No Show' });
    }
    if (['served', 'cancelled', 'no-show', 'denied'].includes(norm) && !appt.archived) {
        items.push({ action: 'archive', label: 'Archive' });
    }
    if (norm === 'cancellation requested') {
        items.push({ action: 'view-cancel', label: 'View Cancellation Request' });
    }
    items.push({ action: 'notes', label: 'Add Note' });

    if (!items.length) return '';
    return `
        <div class="dropdown-wrap">
            <button type="button" class="btn-icon-sm" data-dropdown="${appt.id}"><i class="fas fa-ellipsis-v"></i></button>
            <div class="dropdown-menu">
                ${items.map(i => `<button type="button" class="dropdown-item" data-action="${i.action}" data-id="${appt.id}">${i.label}</button>`).join('')}
            </div>
        </div>`;
}

async function handleApptAction(e) {
    const btn = e.currentTarget;
    const action = btn.dataset.action;
    const id = btn.dataset.id;
    const appt = allAppointments.find(a => a.id === id);
    if (!appt) return;

    switch (action) {
        case 'view': openApptModal(appt); break;
        case 'assign':
        case 'reassign': openAssignModal(appt); break;
        case 'confirm': await updateApptStatus(id, 'Confirmed'); break;
        case 'deny': await denyAppointment(appt); break;
        case 'check-in': await checkInClient(id); break;
        case 'in-service': await setOperationalStatus(id, 'in_service'); break;
        case 'served': await updateApptStatus(id, 'Served'); break;
        case 'no-show': await updateApptStatus(id, 'No Show'); break;
        case 'archive': await archiveAppointment(id); break;
        case 'unarchive': await unarchiveAppointment(id); break;
        case 'view-cancel': openApptModal(appt); break;
        case 'notes': openNotePrompt(appt); break;
    }
}

// =============================================================
// APPOINTMENT UPDATES
// =============================================================
function buildStylistSlotKey(staffUid, date) {
    return `${staffUid}_${date}`;
}

// Publishes / removes the stylist-availability index entry for an appointment
// so the Client portal's stylist picker reflects real-time occupancy. Staff
// write the block on behalf of walk-ins (which have no logged-in client).
// Never throws — availability staleness must not break an appointment update.
async function syncAppointmentSlotBlock(appointmentId, appt) {
    if (!appointmentId || !appt) return;
    const staffUid = appt.staffUid || '';
    const date = getApptDate(appt);
    const time = getApptTime(appt);
    try {
        if (!staffUid || !date || !time || !isBlockingAppointmentStatus(appt.status) || appt.archived) {
            await deleteDoc(doc(db, "slotBlocks", appointmentId));
            return;
        }
        const startMin = timeToMinutes(time);
        const endMin = startMin + getAppointmentDuration(appt);
        await setDoc(doc(db, "slotBlocks", appointmentId), {
            appointmentId,
            staffUid,
            stylistDate: buildStylistSlotKey(staffUid, date),
            date,
            startMin,
            endMin,
            blocking: true,
            createdBy: currentUser ? currentUser.uid : '',
            createdAt: serverTimestamp()
        });
    } catch (err) {
        console.warn('Slot block sync failed (availability may be stale):', err);
    }
}

async function updateApptStatus(apptId, newStatus) {
    try {
        const appt = allAppointments.find(a => a.id === apptId);
        await updateDoc(doc(db, "appointments", apptId), {
            status: newStatus,
            operationalStatus: newStatus === 'Served' ? null : (appt?.operationalStatus || null),
            updatedAt: serverTimestamp()
        });
        await syncAppointmentSlotBlock(apptId, { ...appt, status: newStatus });
        if (appt?.clientId) {
            await createNotification(appt.clientId, `Your appointment status is now: ${newStatus}.`);
        }
        showToast(`Appointment marked as ${newStatus}.`, 'success');
    } catch (err) {
        showToast('Failed to update: ' + err.message, 'error');
    }
}

async function checkInClient(apptId) {
    try {
        await updateDoc(doc(db, "appointments", apptId), {
            operationalStatus: 'checked_in',
            checkedInAt: serverTimestamp(),
            updatedAt: serverTimestamp()
        });
        const appt = allAppointments.find(a => a.id === apptId);
        if (appt?.clientId) {
            await createNotification(appt.clientId, `You've been checked in for your ${appt.serviceName} appointment.`);
        }
        await createNotification('staff', `${appt?.clientName || 'Client'} checked in for ${appt?.serviceName}.`);
        showToast('Client checked in.', 'success');
    } catch (err) {
        showToast('Check-in failed: ' + err.message, 'error');
    }
}

async function setOperationalStatus(apptId, status) {
    try {
        const data = { operationalStatus: status, updatedAt: serverTimestamp() };
        if (status === 'in_service') data.inServiceAt = serverTimestamp();
        await updateDoc(doc(db, "appointments", apptId), data);
        showToast(status === 'in_service' ? 'Service started.' : 'Status updated.', 'success');
    } catch (err) {
        showToast(err.message, 'error');
    }
}

async function denyAppointment(appt) {
    pendingDenyAppt = appt;
    document.getElementById('denyModalSummary').textContent =
        `Deny ${appt.clientName || appt.clientEmail}'s request for ${appt.serviceName || 'this service'}?`;
    document.getElementById('denyReasonInput').value = '';
    document.getElementById('denyModalOverlay').classList.add('open');
}

async function confirmDenyAppointment() {
    if (!pendingDenyAppt) return;
    const reason = document.getElementById('denyReasonInput').value.trim();
    if (!reason) {
        showToast('Please provide a reason for denying this appointment.', 'error');
        return;
    }

    const appt = pendingDenyAppt;
    try {
        await updateDoc(doc(db, "appointments", appt.id), {
            status: 'Denied',
            denialReason: reason,
            deniedAt: serverTimestamp(),
            updatedAt: serverTimestamp()
        });
        await syncAppointmentSlotBlock(appt.id, { ...appt, status: 'Denied' });
        if (appt.clientId) {
            await createNotification(appt.clientId,
                `Your appointment request was denied. Reason: ${reason}`);
        }
        document.getElementById('denyModalOverlay').classList.remove('open');
        pendingDenyAppt = null;
        showToast('Appointment denied.', 'success');
    } catch (err) {
        showToast(err.message, 'error');
    }
}

async function archiveAppointment(apptId) {
    try {
        const appt = allAppointments.find(a => a.id === apptId);
        await updateDoc(doc(db, "appointments", apptId), { archived: true, updatedAt: serverTimestamp() });
        await syncAppointmentSlotBlock(apptId, { ...appt, archived: true });
        showToast('Appointment archived.', 'success');
    } catch (err) {
        showToast(err.message, 'error');
    }
}

async function unarchiveAppointment(apptId) {
    try {
        const appt = allAppointments.find(a => a.id === apptId);
        await updateDoc(doc(db, "appointments", apptId), { archived: false, updatedAt: serverTimestamp() });
        await syncAppointmentSlotBlock(apptId, { ...appt, archived: false });
        showToast('Appointment restored from archive.', 'success');
    } catch (err) {
        showToast(err.message, 'error');
    }
}

// =============================================================
// STYLIST ASSIGNMENT
// =============================================================
function openAssignModal(appt) {
    assignTargetApptId = appt.id;
    selectedAssignStylistId = null;
    const date = getApptDate(appt);
    const time = getApptTime(appt);
    const dur = getAppointmentDuration(appt);
    const clientSelected = appt.staffUid && appt.staffName !== 'Any Available Stylist';
    const serviceCategory = appt.category
        || (allServices.find(s => s.id === appt.serviceId)?.category || '');

    let conflictHtml = '';
    if (clientSelected) {
        const avail = isStylistAvailable(appt.staffUid, date, time, dur, appt.id);
        conflictHtml = avail
            ? `<p class="avail-ok">✓ ${appt.staffName} is available for this slot.</p>`
            : `<p class="avail-warn">⚠ ${appt.staffName} is unavailable during this schedule. Please reassign.</p>`;
    } else {
        conflictHtml = '<p class="avail-warn">⚠ Stylist Assignment Required</p>';
    }

    document.getElementById('assignModalBody').innerHTML = `
        <div class="assign-summary">
            <p><strong>Client:</strong> ${appt.clientName || appt.clientEmail}</p>
            <p><strong>Service:</strong> ${appt.serviceName}</p>
            <p><strong>Date:</strong> ${date} · ${formatTimeRange(time, dur)}</p>
            <p><strong>Current:</strong> ${appt.staffName || 'Any Available Stylist'}</p>
            ${conflictHtml}
        </div>
        <h4>Available Stylists</h4>
        <div class="stylist-assign-list" id="stylistAssignList">
            ${allStylists.map(s => {
                const avail = isStylistAvailable(s.id, date, time, dur, appt.id);
                const qualified = isStylistQualifiedForCategory(s, serviceCategory);
                const isCurrent = s.id === appt.staffUid;
                const reason = !qualified
                    ? 'Not qualified for this service'
                    : (!avail ? 'Occupied' : '');
                const selectable = avail && qualified;
                return `
                    <button type="button" class="stylist-assign-btn ${selectable ? '' : 'unavailable'} ${isCurrent ? 'current' : ''}"
                        data-stylist-id="${s.id}" ${selectable ? '' : 'disabled'}>
                        ${selectable ? '✓' : '✕'} ${s.fullName || s.email}${isCurrent ? ' (Current)' : ''}${reason ? ` — ${reason}` : ''}
                    </button>`;
            }).join('')}
        </div>
        <p class="form-hint" id="assignConflictMsg"></p>
    `;

    document.getElementById('assignModalConfirm').disabled = true;
    document.getElementById('assignModalOverlay').classList.add('open');

    document.getElementById('stylistAssignList').querySelectorAll('.stylist-assign-btn:not([disabled])').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.stylist-assign-btn').forEach(b => b.classList.remove('selected'));
            btn.classList.add('selected');
            selectedAssignStylistId = btn.dataset.stylistId;
            document.getElementById('assignModalConfirm').disabled = false;
        });
    });
}

async function confirmAssignStylist() {
    if (!assignTargetApptId || !selectedAssignStylistId) return;
    const appt = allAppointments.find(a => a.id === assignTargetApptId);
    const stylist = allStylists.find(s => s.id === selectedAssignStylistId);
    if (!appt || !stylist) return;

    const date = getApptDate(appt);
    const time = getApptTime(appt);
    const dur = getAppointmentDuration(appt);
    const schedule = getScheduleForStylist(selectedAssignStylistId);
    const conflict = validateStylistSlot(allAppointments, schedule, selectedAssignStylistId, date, time, dur, appt.id);

    if (conflict) {
        document.getElementById('assignConflictMsg').textContent = '⚠ ' + conflict;
        showToast(conflict, 'error');
        return;
    }

    const wasReassign = appt.staffUid && appt.staffUid !== selectedAssignStylistId;
    try {
        await updateDoc(doc(db, "appointments", appt.id), {
            staffUid: stylist.id,
            staffName: stylist.fullName || stylist.email,
            reassignedFrom: wasReassign ? (appt.staffName || '') : null,
            reassignedAt: wasReassign ? serverTimestamp() : null,
            updatedAt: serverTimestamp()
        });
        if (appt.clientId && wasReassign) {
            await createNotification(appt.clientId,
                `Your appointment stylist was updated to ${stylist.fullName}. Please contact us if you have questions.`);
        }
        await createNotification('staff', `Stylist ${wasReassign ? 'reassigned' : 'assigned'}: ${stylist.fullName} for ${appt.clientName}.`);
        document.getElementById('assignModalOverlay').classList.remove('open');
        showToast(`Stylist ${stylist.fullName} assigned.`, 'success');
    } catch (err) {
        showToast(err.message, 'error');
    }
}

// =============================================================
// APPOINTMENT MODAL
// =============================================================
function openApptModal(appt) {
    const dur = getAppointmentDuration(appt);
    const norm = normalizeStatus(appt.status);
    let extra = '';
    if (appt.cancellationReason) {
        extra += `<p class="warn-text"><strong>Cancellation reason:</strong> ${appt.cancellationReason}</p>`;
        extra += `<p class="muted">Awaiting Admin approval — staff cannot cancel directly.</p>`;
    }
    if (appt.reassignedFrom) {
        extra += `<p class="warn-text">Stylist changed from ${appt.reassignedFrom} to ${appt.staffName}</p>`;
    }
    if (appt.note) extra += `<p><strong>Client note:</strong> ${appt.note}</p>`;
    if (appt.denialReason) extra += `<p class="warn-text"><strong>Denial reason:</strong> ${appt.denialReason}</p>`;
    if (appt.staffNotes) extra += `<p><strong>Staff notes:</strong> ${appt.staffNotes}</p>`;

    document.getElementById('apptModalTitle').textContent = `Appointment · ${appt.clientName || 'Client'}`;
    document.getElementById('apptModalBody').innerHTML = `
        <div class="detail-grid">
            <p><strong>Service</strong><span>${appt.serviceName}</span></p>
            <p><strong>Date & Time</strong><span>${getApptDate(appt)} · ${formatTimeRange(getApptTime(appt), dur)}</span></p>
            <p><strong>Duration</strong><span>${dur} min</span></p>
            <p><strong>Stylist</strong><span>${appt.staffName || 'Unassigned'}</span></p>
            <p><strong>Status</strong><span>${renderStatusBadge(appt)}</span></p>
            <p><strong>Price</strong><span>${formatPrice(appt.price)}</span></p>
            <p><strong>Contact</strong><span>${appt.clientEmail || appt.walkInContact || '—'}</span></p>
        </div>${extra}
    `;
    document.getElementById('apptModalFooter').innerHTML = getQuickActions(appt);
    document.getElementById('apptModalOverlay').classList.add('open');
    document.getElementById('apptModalFooter').querySelectorAll('[data-action]').forEach(btn => {
        btn.addEventListener('click', (e) => {
            document.getElementById('apptModalOverlay').classList.remove('open');
            handleApptAction(e);
        });
    });
}

function openNotePrompt(appt) {
    const note = prompt('Add staff note for this appointment:');
    if (!note?.trim()) return;
    updateDoc(doc(db, "appointments", appt.id), {
        staffNotes: note.trim(),
        updatedAt: serverTimestamp()
    }).then(() => showToast('Note saved.', 'success'));
}

// =============================================================
// CALENDAR
// =============================================================
function renderCalendar() {
    const container = document.getElementById('staffCalContainer');
    if (!container) return;

    if (calendarView === 'day') {
        renderDayCalendar(container);
    } else {
        renderWeekCalendar(container);
    }
}

function renderDayCalendar(container) {
    const dateKey = toLocalDateKey(calendarDate);
    document.getElementById('calViewLabel').textContent = calendarDate.toLocaleDateString('en-US', {
        weekday: 'long', month: 'long', day: 'numeric', year: 'numeric'
    });

    const dayAppts = allAppointments.filter(a => getApptDate(a) === dateKey && !a.archived && isBlockingAppointmentStatus(a.status));
    const hours = [];
    for (let m = SALON_OPEN_MINUTES; m < SALON_CLOSE_MINUTES; m += 60) {
        hours.push(m);
    }

    container.innerHTML = `
        <div class="cal-day-grid">
            ${hours.map(m => {
                const label = formatDisplayTime(minutesToTime(m));
                const slotAppts = dayAppts.filter(a => {
                    const start = timeToMinutesLocal(getApptTime(a));
                    return start >= m && start < m + 60;
                });
                const blocks = slotAppts.map(a => renderCalBlock(a)).join('');
                const empty = !blocks ? '<div class="cal-slot-empty">Available</div>' : '';
                return `
                    <div class="cal-hour-row">
                        <div class="cal-hour-label">${label}</div>
                        <div class="cal-hour-slots">${blocks}${empty}</div>
                    </div>`;
            }).join('')}
        </div>`;

    container.querySelectorAll('.cal-appt-block').forEach(el => {
        el.addEventListener('click', () => {
            const appt = allAppointments.find(a => a.id === el.dataset.id);
            if (appt) openApptModal(appt);
        });
    });
}

function renderCalBlock(appt) {
    const meta = getStatusMeta(appt.status, appt.operationalStatus);
    return `
        <div class="cal-appt-block ${meta.className}" data-id="${appt.id}">
            <strong>${appt.clientName || 'Client'}</strong>
            <span>${appt.serviceName}</span>
            <span class="cal-stylist">${appt.staffName || 'Unassigned'}</span>
            <span class="cal-status-tag">${meta.icon} ${meta.label}</span>
        </div>`;
}

function timeToMinutesLocal(t) {
    const [h, m] = (t || '00:00').split(':').map(Number);
    return h * 60 + (m || 0);
}

function renderWeekCalendar(container) {
    const start = new Date(calendarDate);
    start.setDate(start.getDate() - start.getDay());
    const days = Array.from({ length: 7 }, (_, i) => {
        const d = new Date(start);
        d.setDate(start.getDate() + i);
        return d;
    });

    document.getElementById('calViewLabel').textContent = `Week of ${days[0].toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;

    container.innerHTML = `
        <div class="cal-week-grid">
            ${days.map(d => {
                const key = toLocalDateKey(d);
                const appts = allAppointments.filter(a => getApptDate(a) === key && !a.archived);
                return `
                    <div class="cal-week-col">
                        <div class="cal-week-head">${d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}</div>
                        ${appts.length ? appts.map(a => renderCalBlock(a)).join('') : '<p class="cal-slot-empty">No appointments</p>'}
                    </div>`;
            }).join('')}
        </div>`;

    container.querySelectorAll('.cal-appt-block').forEach(el => {
        el.addEventListener('click', () => {
            const appt = allAppointments.find(a => a.id === el.dataset.id);
            if (appt) openApptModal(appt);
        });
    });
}

// =============================================================
// STYLIST AVAILABILITY
// =============================================================
function renderStylistPicker() {
    const el = document.getElementById('stylistPickerList');
    if (!el) return;
    el.innerHTML = allStylists.map(s => `
        <button type="button" class="stylist-pick-btn ${s.id === selectedStylistId ? 'active' : ''}" data-id="${s.id}">
            <span class="stylist-avatar">${(s.fullName || 'S').charAt(0)}</span>
            ${s.fullName || s.email}
        </button>
    `).join('');
    el.querySelectorAll('.stylist-pick-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            selectedStylistId = btn.dataset.id;
            renderStylistPicker();
            renderStylistDetail();
        });
    });
}

function renderStylistDetail() {
    const panel = document.getElementById('stylistDetailPanel');
    if (!panel || !selectedStylistId) return;
    const stylist = allStylists.find(s => s.id === selectedStylistId);
    if (!stylist) return;

    ensureStylistSchedule(selectedStylistId, stylist.fullName);
    const schedule = getScheduleForStylist(selectedStylistId);
    const days = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
    const specialties = Array.isArray(stylist.specialties) ? stylist.specialties : [];
    const isSelf = !!currentUser && selectedStylistId === currentUser.uid;
    const editing = stylistSpecialtiesEditFor === selectedStylistId;
    const categoryOptions = [...new Set(allServices.map(s => (s.category || '').trim()).filter(Boolean))].sort();

    panel.innerHTML = `
        <h3 class="section-title">${stylist.fullName || stylist.email}</h3>
        <div class="schedule-week">
            ${days.map(day => {
                const d = schedule.weeklyHours?.[day] || { off: false, open: '09:00', close: '18:00' };
                const label = day.charAt(0).toUpperCase() + day.slice(1);
                const hours = d.off ? 'DAY OFF' : `${formatDisplayTime(d.open)} - ${formatDisplayTime(d.close)}`;
                return `<div class="schedule-day-row"><span>${label}</span><span>${hours}</span></div>`;
            }).join('')}
        </div>
        <h4 class="section-sub-title">Service Specialties</h4>
        ${editing ? `
            <div id="specialtiesEditBox" style="margin-bottom:14px;">
                ${categoryOptions.length ? categoryOptions.map(cat => `
                    <label style="display:flex;align-items:center;gap:8px;font-size:13px;color:#333;cursor:pointer;padding:3px 0;">
                        <input type="checkbox" class="specialty-cat-cb" value="${cat.replace(/"/g, '&quot;')}" ${specialties.includes(cat) ? 'checked' : ''}> ${cat}
                    </label>
                `).join('') : '<p class="empty-hint">No service categories found.</p>'}
                <div style="display:flex;gap:10px;margin-top:12px;">
                    <button type="button" id="saveSpecialtiesBtn" class="btn-primary btn-sm">Save Specialties</button>
                    <button type="button" id="cancelSpecialtiesBtn" class="btn-text-danger">Cancel</button>
                </div>
            </div>
        ` : `
            <div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:10px;">
                ${specialties.length ? specialties.map(s => `<span style="background:#fce4ec;color:#c2185b;border-radius:999px;padding:4px 12px;font-size:12px;font-weight:600;">${s}</span>`).join('') : '<span class="empty-hint">All services (all-rounder)</span>'}
            </div>
            ${isSelf ? '<button type="button" id="editSpecialtiesBtn" class="btn-primary btn-sm" style="margin-bottom:14px;">Edit Specialties</button>' : ''}
        `}
        <h4 class="section-sub-title">Block Schedule</h4>
        <form id="blockScheduleForm" class="block-form">
            <div class="form-grid">
                <label class="field"><span>Date</span><input type="date" id="blockDate" class="staff-input" required></label>
                <label class="field"><span>From</span><input type="time" id="blockStart" class="staff-input" value="14:00" required></label>
                <label class="field"><span>To</span><input type="time" id="blockEnd" class="staff-input" value="15:00" required></label>
                <label class="field field-full"><span>Reason</span><input type="text" id="blockReason" class="staff-input" placeholder="Personal appointment"></label>
            </div>
            <button type="submit" class="btn-primary btn-sm"><i class="fas fa-ban"></i> Block Schedule</button>
        </form>
        <div class="blocks-list" id="blocksList">
            ${(schedule.blocks || []).map((b, i) => `
                <div class="block-item">
                    <span>${b.date} · ${formatDisplayTime(b.startTime)} - ${formatDisplayTime(b.endTime)}</span>
                    <span>${b.reason || ''}</span>
                    <button type="button" class="btn-text-danger" data-remove-block="${i}">Remove</button>
                </div>
            `).join('') || '<p class="empty-hint">No blocked periods.</p>'}
        </div>
    `;

    document.getElementById('blockScheduleForm')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        await addScheduleBlock(selectedStylistId);
    });
    panel.querySelectorAll('[data-remove-block]').forEach(btn => {
        btn.addEventListener('click', () => removeScheduleBlock(selectedStylistId, parseInt(btn.dataset.removeBlock)));
    });
    document.getElementById('editSpecialtiesBtn')?.addEventListener('click', () => {
        stylistSpecialtiesEditFor = selectedStylistId;
        renderStylistDetail();
    });
    document.getElementById('cancelSpecialtiesBtn')?.addEventListener('click', () => {
        stylistSpecialtiesEditFor = null;
        renderStylistDetail();
    });
    document.getElementById('saveSpecialtiesBtn')?.addEventListener('click', async () => {
        const selected = [...panel.querySelectorAll('.specialty-cat-cb:checked')].map(cb => cb.value);
        try {
            await updateDoc(doc(db, "users", selectedStylistId), { specialties: selected, updatedAt: new Date() });
            const target = allStylists.find(s => s.id === selectedStylistId);
            if (target) target.specialties = selected;
            stylistSpecialtiesEditFor = null;
            renderStylistDetail();
            if (typeof showToast === 'function') showToast('Saved', 'Specialties updated. Booking eligibility applied.', 'success');
        } catch (err) {
            console.error("Specialties save error:", err);
            if (typeof showToast === 'function') showToast('Error', 'Failed to save specialties: ' + err.message, 'error');
        }
    });
}

async function migrateLegacyStylistSchedules() {
    const updates = [];
    Object.entries(stylistSchedules).forEach(([uid, schedule]) => {
        if (!isLegacySundayOffSchedule(schedule.weeklyHours)) return;
        const weeklyHours = randomizedWeeklyHours(uid);
        stylistSchedules[uid] = { ...schedule, weeklyHours };
        updates.push(setDoc(doc(db, "stylistSchedules", uid), {
            weeklyHours,
            updatedAt: serverTimestamp()
        }, { merge: true }));
    });
    if (updates.length) {
        await Promise.all(updates).catch(err => console.warn('Schedule migration:', err));
    }
}

async function ensureStylistSchedule(stylistUid, stylistName) {
    if (stylistSchedules[stylistUid]) return;
    await setDocSafe(stylistUid, {
        stylistUid, stylistName,
        weeklyHours: randomizedWeeklyHours(stylistUid),
        blocks: [],
        updatedAt: serverTimestamp()
    });
}

async function setDocSafe(id, data) {
    const ref = doc(db, "stylistSchedules", id);
    const snap = await getDoc(ref);
    if (!snap.exists()) {
        await setDoc(ref, { ...data, createdAt: serverTimestamp() });
    }
}

async function addScheduleBlock(stylistUid) {
    const date = document.getElementById('blockDate').value;
    const startTime = document.getElementById('blockStart').value;
    const endTime = document.getElementById('blockEnd').value;
    const reason = document.getElementById('blockReason').value.trim();
    const schedule = getScheduleForStylist(stylistUid);
    const blocks = [...(schedule.blocks || []), { date, startTime, endTime, reason }];
    try {
        await setDoc(doc(db, "stylistSchedules", stylistUid), {
            ...schedule, blocks, updatedAt: serverTimestamp()
        }, { merge: true });
        await createNotification('staff', `Schedule blocked for stylist on ${date}.`);
        showToast('Schedule blocked.', 'success');
    } catch (err) {
        showToast(err.message, 'error');
    }
}

async function removeScheduleBlock(stylistUid, index) {
    const schedule = getScheduleForStylist(stylistUid);
    const blocks = [...(schedule.blocks || [])];
    blocks.splice(index, 1);
    try {
        await setDoc(doc(db, "stylistSchedules", stylistUid), { blocks, updatedAt: serverTimestamp() }, { merge: true });
        showToast('Block removed.', 'success');
    } catch (err) {
        showToast(err.message, 'error');
    }
}

// =============================================================
// CLIENTS
// =============================================================
function renderClientPicker() {
    const search = (document.getElementById('clientSearch')?.value || '').toLowerCase();
    const clients = dedupeClientsFromAppointments().filter(c => {
        const text = `${c.fullName} ${c.email}`.toLowerCase();
        return !search || text.includes(search);
    });
    const el = document.getElementById('clientPickerList');
    if (!el) return;
    el.innerHTML = clients.map(c => `
        <button type="button" class="client-pick-btn ${c.id === selectedClientId ? 'active' : ''}" data-id="${c.id}">
            <strong>${c.fullName || c.email || 'Client'}</strong>
            <span>${c.email || ''}</span>
        </button>
    `).join('') || '<p class="empty-hint">No clients found.</p>';
    el.querySelectorAll('.client-pick-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            selectedClientId = btn.dataset.id;
            renderClientPicker();
            renderClientDetail();
        });
    });
}

function renderClientDetail() {
    const panel = document.getElementById('clientDetailPanel');
    if (!panel || !selectedClientId) return;
    const client = dedupeClientsFromAppointments().find(c => c.id === selectedClientId) ||
        allClients.find(c => c.id === selectedClientId);
    const history = allAppointments
        .filter(a => a.clientId === selectedClientId)
        .sort((a, b) => getApptDate(b).localeCompare(getApptDate(a)));
    const notes = clientNotes.filter(n => n.clientId === selectedClientId);

    panel.innerHTML = `
        <h3 class="section-title">${client?.fullName || client?.email || 'Client'}</h3>
        <h4 class="section-sub-title">Appointment History</h4>
        <div class="client-history">
            ${history.length ? history.map(a => `
                <div class="history-item">
                    <span class="history-date">${getApptDate(a)}</span>
                    <div>
                        <strong>${a.serviceName}</strong>
                        <span>${a.staffName || '—'} · ${getStatusMeta(a.status).label}</span>
                    </div>
                </div>
            `).join('') : '<p class="empty-hint">No appointment history.</p>'}
        </div>
        <h4 class="section-sub-title">Client Notes</h4>
        <div class="client-notes-list">
            ${notes.length ? notes.map(n => `<div class="note-item">• ${n.text} <small>${n.authorName || 'Staff'}</small></div>`).join('') : '<p class="empty-hint">No notes yet.</p>'}
        </div>
        <form id="clientNoteForm" class="note-form">
            <textarea id="clientNoteInput" class="staff-textarea" rows="2" placeholder="Add a note about this client…"></textarea>
            <button type="submit" class="btn-primary btn-sm">Add Note</button>
        </form>
    `;

    document.getElementById('clientNoteForm')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const text = document.getElementById('clientNoteInput').value.trim();
        if (!text) return;
        try {
            await addDoc(collection(db, "clientNotes"), {
                clientId: selectedClientId,
                text,
                authorUid: currentUser.uid,
                authorName: currentProfile.fullName || 'Staff',
                createdAt: serverTimestamp()
            });
            document.getElementById('clientNoteInput').value = '';
            showToast('Note added.', 'success');
        } catch (err) {
            showToast(err.message, 'error');
        }
    });
}

// =============================================================
// WALK-INS
// =============================================================
function populateWalkinServices() {
    const sel = document.getElementById('walkinService');
    if (!sel) return;
    const bases = allServices.filter(s => !s.variantOf);
    sel.innerHTML = '<option value="">Select service</option>' +
        bases.map(s => `<option value="${s.id}">${s.serviceName} · ${formatPrice(s.price)}</option>`).join('');
    sel.addEventListener('change', updateWalkinStylistOptions);
}

function populateStylistSelects() {
    const options = '<option value="">Any Available Stylist</option>' +
        allStylists.map(s => `<option value="${s.id}">${s.fullName || s.email}</option>`).join('');
    ['walkinStylist', 'waitingStylist'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.innerHTML = options;
    });
}

// Filters the walk-in stylist dropdown to stylists qualified for the selected
// service (admin-set specialties). "Any Available Stylist" stays available.
function updateWalkinStylistOptions() {
    const sel = document.getElementById('walkinStylist');
    if (!sel) return;
    const serviceId = document.getElementById('walkinService')?.value || '';
    sel.innerHTML = '<option value="">Any Available Stylist</option>' +
        allStylists
            .filter(s => isStylistQualifiedForService(s, serviceId))
            .map(s => `<option value="${s.id}">${s.fullName || s.email}</option>`)
            .join('');
    updateWalkinTimeSlots();
}

// Filters the waiting-list preferred-stylist dropdown. The waiting form stores
// the service as free text, so match it against the services menu to resolve
// its category; unmatched text keeps all stylists listed.
function updateWaitingStylistOptions() {
    const sel = document.getElementById('waitingStylist');
    if (!sel) return;
    const name = (document.getElementById('waitingService')?.value || '').trim().toLowerCase();
    const service = allServices.find(s => (s.serviceName || '').trim().toLowerCase() === name);
    sel.innerHTML = '<option value="">Any Stylist</option>' +
        allStylists
            .filter(s => isStylistQualifiedForCategory(s, service ? service.category : ''))
            .map(s => `<option value="${s.id}">${s.fullName || s.email}</option>`)
            .join('');
}

function initWalkinForm() {
    applyBookingDateInputLimits(document.getElementById('walkinDate'), true);
    updateWalkinTimeSlots();
    document.getElementById('walkinForm')?.addEventListener('submit', submitWalkin);
    document.getElementById('walkinStylist')?.addEventListener('change', updateWalkinTimeSlots);
    document.getElementById('walkinDate')?.addEventListener('change', updateWalkinTimeSlots);
}

function updateWalkinTimeSlots() {
    const timeSel = document.getElementById('walkinTime');
    if (!timeSel) return;
    const slots = generateTimeSlots(60);
    timeSel.innerHTML = slots.map(t => `<option value="${t}">${formatDisplayTime(t)}</option>`).join('');
}

async function submitWalkin(e) {
    e.preventDefault();
    const name = document.getElementById('walkinName').value.trim();
    const contact = document.getElementById('walkinContact').value.trim();
    const serviceId = document.getElementById('walkinService').value;
    const stylistId = document.getElementById('walkinStylist').value;
    const date = document.getElementById('walkinDate').value;
    const time = document.getElementById('walkinTime').value;
    const notes = document.getElementById('walkinNotes').value.trim();
    const service = allServices.find(s => s.id === serviceId);
    if (!service) return;

    const dur = getAppointmentDuration({ durationMinutes: 60, duration: service.duration });
    const stylist = allStylists.find(s => s.id === stylistId);
    const schedule = stylistId ? getScheduleForStylist(stylistId) : null;
    const conflict = stylistId
        ? validateStylistSlot(allAppointments, schedule, stylistId, date, time, dur)
        : null;

    const msgEl = document.getElementById('walkinValidationMsg');
    if (conflict) {
        msgEl.textContent = '⚠ ' + conflict;
        showToast(conflict, 'error');
        return;
    }
    msgEl.textContent = '';

    try {
        const newAppt = await addDoc(collection(db, "appointments"), {
            clientId: '', clientName: name, clientEmail: contact, walkInContact: contact,
            serviceId, serviceName: service.serviceName, category: service.category || '',
            price: parseFloat(service.price || 0), duration: service.duration || '60 min', durationMinutes: dur,
            staffUid: stylistId || '', staffName: stylist ? stylist.fullName : 'Any Available Stylist',
            bookingDate: date, bookingTime: time, date, time,
            status: 'Confirmed', operationalStatus: 'checked_in', checkedInAt: serverTimestamp(),
            isWalkIn: true, note: notes, staffNotes: notes,
            createdAt: serverTimestamp()
        });
        await syncAppointmentSlotBlock(newAppt.id, {
            staffUid: stylistId || '', bookingDate: date, bookingTime: time,
            durationMinutes: dur, status: 'Confirmed', archived: false
        });
        await createNotification('staff', `Walk-in added: ${name} for ${service.serviceName}.`);
        document.getElementById('walkinForm').reset();
        showToast('Walk-in appointment created.', 'success');
    } catch (err) {
        showToast(err.message, 'error');
    }
}

function renderRecentWalkins() {
    const el = document.getElementById('recentWalkinsList');
    if (!el) return;
    const walkins = allAppointments.filter(a => a.isWalkIn).slice(-8).reverse();
    el.innerHTML = walkins.length ? walkins.map(a => `
        <div class="walkin-item">
            <strong>${a.clientName}</strong> · ${a.serviceName}
            <span>${getApptDate(a)} ${formatDisplayTime(getApptTime(a))}</span>
        </div>
    `).join('') : '<p class="empty-hint">No walk-ins yet.</p>';
}

// =============================================================
// WAITING LIST
// =============================================================
function renderWaitingList() {
    const el = document.getElementById('waitingListContainer');
    if (!el) return;
    el.innerHTML = waitingList.length ? waitingList.map(w => `
        <div class="waiting-queue-item">
            <div>
                <strong>${w.clientName}</strong>
                <p>${w.serviceName} · ${w.stylistName || 'Any Stylist'}</p>
            </div>
            <div class="queue-actions">
                <button type="button" class="btn-action btn-sm" data-wait-action="convert" data-id="${w.id}">Book</button>
                <button type="button" class="btn-action btn-sm" data-wait-action="remove" data-id="${w.id}">Remove</button>
            </div>
        </div>
    `).join('') : '<p class="empty-hint">Waiting list is empty.</p>';

    el.querySelectorAll('[data-wait-action]').forEach(btn => {
        btn.addEventListener('click', async () => {
            const item = waitingList.find(w => w.id === btn.dataset.id);
            if (btn.dataset.waitAction === 'remove') {
                await deleteDoc(doc(db, "waitingList", btn.dataset.id));
                showToast('Removed from queue.', 'success');
            } else if (item) {
                switchTab('tabWalkins');
                document.getElementById('walkinName').value = item.clientName;
                document.getElementById('walkinContact').value = item.contact || '';
                showToast('Fill in walk-in details to convert.', 'info');
            }
        });
    });
}

function initWaitingForm() {
    document.getElementById('addToWaitingBtn')?.addEventListener('click', () => {
        document.getElementById('waitingModalOverlay').classList.add('open');
    });
    document.getElementById('waitingService')?.addEventListener('input', updateWaitingStylistOptions);
    document.getElementById('waitingForm')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const stylistSel = document.getElementById('waitingStylist');
        const stylistId = stylistSel.value;
        const stylistName = stylistId
            ? stylistSel.options[stylistSel.selectedIndex].text
            : 'Any Stylist';
        try {
            await addDoc(collection(db, "waitingList"), {
                clientName: document.getElementById('waitingName').value.trim(),
                serviceName: document.getElementById('waitingService').value.trim(),
                stylistId: stylistId || null,
                stylistName,
                status: 'waiting',
                createdAt: serverTimestamp()
            });
            document.getElementById('waitingModalOverlay').classList.remove('open');
            document.getElementById('waitingForm').reset();
            showToast('Added to waiting list.', 'success');
        } catch (err) {
            showToast(err.message, 'error');
        }
    });
}

// =============================================================
// NOTIFICATIONS
// =============================================================
function updateNotifBadges(unread) {
    const dot = document.getElementById('topbarNotifDot');
    const sidebar = document.getElementById('sidebarNotifCount');
    if (dot) dot.style.display = unread > 0 ? 'block' : 'none';
    if (sidebar) {
        sidebar.style.display = unread > 0 ? 'inline-flex' : 'none';
        sidebar.textContent = unread > 99 ? '99+' : unread;
    }
}

function renderNotifications() {
    const el = document.getElementById('staffNotifList');
    if (!el) return;
    el.innerHTML = staffNotifications.length ? staffNotifications.map(n => `
        <div class="notif-item ${n.isRead ? '' : 'unread'}" data-id="${n.id}">
            <i class="fas fa-bell"></i>
            <div><p>${n.message}</p><small>${formatNotifTime(n.createdAt)}</small></div>
        </div>
    `).join('') : '<p class="empty-hint">No notifications.</p>';

    el.querySelectorAll('.notif-item').forEach(item => {
        item.addEventListener('click', async () => {
            await updateDoc(doc(db, "notifications", item.dataset.id), { isRead: true });
        });
    });
}

function formatNotifTime(ts) {
    const d = ts?.toDate?.() || new Date();
    return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

// =============================================================
// NAVIGATION & MODALS
// =============================================================
function switchTab(tabId) {
    document.querySelectorAll('.staff-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.sidebar-link[data-tab]').forEach(l => l.classList.remove('active'));
    document.getElementById(tabId)?.classList.add('active');
    document.querySelector(`.sidebar-link[data-tab="${tabId}"]`)?.classList.add('active');
    document.getElementById('topbarTitle').textContent = TAB_TITLES[tabId] || 'Staff';
    document.getElementById('staffSidebar')?.classList.remove('open');
    document.getElementById('staffOverlay')?.classList.remove('open');
    if (tabId === 'tabCalendar') renderCalendar();
    if (tabId === 'tabClients') renderClientPicker();
}

function initNavigation() {
    document.querySelectorAll('.sidebar-link[data-tab]').forEach(link => {
        link.addEventListener('click', () => switchTab(link.dataset.tab));
    });
    document.querySelectorAll('[data-goto]').forEach(btn => {
        btn.addEventListener('click', () => switchTab(btn.dataset.goto));
    });
    document.getElementById('sidebarToggle')?.addEventListener('click', () => {
        document.getElementById('staffSidebar').classList.toggle('open');
        document.getElementById('staffOverlay').classList.toggle('open');
    });
    document.getElementById('staffOverlay')?.addEventListener('click', () => {
        document.getElementById('staffSidebar').classList.remove('open');
        document.getElementById('staffOverlay').classList.remove('open');
    });
    document.getElementById('topbarNotifBtn')?.addEventListener('click', () => switchTab('tabNotifications'));

    document.getElementById('apptSearch')?.addEventListener('input', renderAppointments);
    document.getElementById('apptStatusFilter')?.addEventListener('change', renderAppointments);
    document.getElementById('apptDateFilter')?.addEventListener('change', renderAppointments);
    document.getElementById('clientSearch')?.addEventListener('input', renderClientPicker);

    document.getElementById('calPrevBtn')?.addEventListener('click', () => {
        calendarDate.setDate(calendarDate.getDate() + (calendarView === 'day' ? -1 : -7));
        renderCalendar();
    });
    document.getElementById('calNextBtn')?.addEventListener('click', () => {
        calendarDate.setDate(calendarDate.getDate() + (calendarView === 'day' ? 1 : 7));
        renderCalendar();
    });
    document.querySelectorAll('[data-cal-view]').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('[data-cal-view]').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            calendarView = btn.dataset.calView;
            renderCalendar();
        });
    });

    document.addEventListener('click', () => {
        document.querySelectorAll('.dropdown-menu.open').forEach(m => m.classList.remove('open'));
    });
}

function initModals() {
    const close = (id) => document.getElementById(id)?.classList.remove('open');
    document.getElementById('apptModalClose')?.addEventListener('click', () => close('apptModalOverlay'));
    document.getElementById('assignModalClose')?.addEventListener('click', () => close('assignModalOverlay'));
    document.getElementById('assignModalCancel')?.addEventListener('click', () => close('assignModalOverlay'));
    document.getElementById('assignModalConfirm')?.addEventListener('click', confirmAssignStylist);
    document.getElementById('waitingModalClose')?.addEventListener('click', () => close('waitingModalOverlay'));
    document.getElementById('waitingModalCancel')?.addEventListener('click', () => close('waitingModalOverlay'));
    document.getElementById('confirmCancel')?.addEventListener('click', closeConfirm);
    document.getElementById('confirmOk')?.addEventListener('click', () => {
        if (confirmCallback) confirmCallback();
        else closeConfirm();
    });
    document.getElementById('denyModalClose')?.addEventListener('click', () => close('denyModalOverlay'));
    document.getElementById('denyModalCancel')?.addEventListener('click', () => {
        pendingDenyAppt = null;
        close('denyModalOverlay');
    });
    document.getElementById('denyModalConfirm')?.addEventListener('click', confirmDenyAppointment);
    document.getElementById('denyModalOverlay')?.addEventListener('click', (e) => {
        if (e.target.id === 'denyModalOverlay') {
            pendingDenyAppt = null;
            close('denyModalOverlay');
        }
    });
    ['apptModalOverlay', 'assignModalOverlay', 'waitingModalOverlay'].forEach(id => {
        document.getElementById(id)?.addEventListener('click', (e) => {
            if (e.target.id === id) close(id);
        });
    });
}

// Notify staff on new pending appointments
let knownApptIds = new Set();
function checkNewAppointments() {
    allAppointments.forEach(a => {
        if (!knownApptIds.has(a.id) && normalizeStatus(a.status) === 'pending') {
            if (knownApptIds.size > 0) {
                createNotification('staff', `New appointment: ${a.clientName} — ${a.serviceName} on ${getApptDate(a)}.`);
                if (needsStylistAssignment(a)) {
                    createNotification('staff', `⚠ Appointment requires stylist assignment: ${a.clientName}.`);
                }
            }
        }
        knownApptIds.add(a.id);
    });
}

console.log("K-Beauty Staff Operations Portal ready.");
