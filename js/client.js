import { auth, db, storage } from "./firebase-config.js";
import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-auth.js";
import { requireMfaOrRedirect, clearMfaSession } from "./auth-guard.js";
import { deliverNotification } from "./notification-delivery.js";
import { openLogoutConfirmation } from "./logout-confirmation.js";
import {
    collection, query, where, getDocs, addDoc, onSnapshot,
    serverTimestamp, doc, getDoc, setDoc, updateDoc, deleteDoc
} from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";
import { ref, uploadBytes, getDownloadURL } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-storage.js";
import {
    validateStylistSlot, defaultWeeklyHours, randomizedWeeklyHours, isLegacySundayOffSchedule,
    isPastBookingDate, applyBookingDateInputLimits,
    RESERVATION_FEE, computeReservationPayment
} from "./appointment-utils.js";

// =============================================================
// STATE
// =============================================================
let currentUser = null;
let currentUserProfile = null;
let allServices = [];
let unsubscribeServices = null;
let hasInitializedBookingWidget = false;
let loadedStaffMembers = [];
let stylistSchedulesCache = {};
let staffLoadError = '';
let staffAutoRetried = false;
const BOOKABLE_STAFF_ROLES = ['stylist', 'staff', 'manager', 'general staff'];
let selectedAppointmentIdToCancel = null;
let activeAppointments = [];
let historyAppointments = [];
let reschedulingAppointmentId = null;
let clientNotifications = [];
const QR_PAYMENT_SETTINGS_DEFAULTS = Object.freeze({
    enabled: false,
    qrImageData: '',
    qrCodeURL: '',
    accountName: '',
    accountNumber: '',
    instructions: ''
});
let qrPaymentSettings = { ...QR_PAYMENT_SETTINGS_DEFAULTS };
// Multiple QR payment options configured by the admin (max 5), one document each.
let qrPaymentProviders = [];
let selectedQrProviderId = '';
let stopQrProviderListener = null;
let servicesViewMode = 'grid';
let activeCategoryFilter = 'all';
let serviceSearchQuery = '';
let overviewServicesViewMode = 'grid';
let overviewServiceSearchQuery = '';
let overviewServiceCategoryFilter = 'all';

const SALON_OPEN_MINUTES = 9 * 60;
const SALON_CLOSE_MINUTES = 18 * 60;
const TIME_SLOT_INTERVAL = 30;

let calendarViewDate = new Date();
let calendarSelectedDate = null;
let calendarAutoFocused = false;

const CARD_STYLES = ['card-gold', 'card-signature', 'card-aromatherapy'];
const ACCENT_CLASSES = ['', 'blush', 'sage'];
const SKIN_KEYWORDS = {
    dry: ['hydrat', 'moistur', 'facial', 'mask', 'nourish', 'dry', 'skin'],
    oily: ['clean', 'purif', 'facial', 'oil', 'matte', 'peel', 'skin'],
    sensitive: ['calm', 'gentle', 'sooth', 'sensitive', 'facial', 'skin'],
    combination: ['balance', 'facial', 'skin'],
    normal: ['facial', 'glow', 'skin', 'spa']
};
const HAIR_KEYWORDS = {
    straight: ['hair', 'cut', 'trim', 'style', 'blow', 'straight'],
    wavy: ['hair', 'style', 'treatment', 'keratin', 'wavy'],
    curly: ['hair', 'curl', 'moistur', 'treatment', 'define'],
    coily: ['hair', 'moistur', 'deep', 'treatment', 'coil'],
    fine: ['hair', 'volume', 'treatment', 'fine'],
    thick: ['hair', 'smoothing', 'keratin', 'treatment', 'thick']
};
const CATEGORY_ICONS = {
    'Facial': 'fa-face-smile',
    'Hair': 'fa-scissors',
    'Nails': 'fa-hand-sparkles',
    'Massage': 'fa-spa',
    'Body': 'fa-leaf',
    'Waxing': 'fa-star',
    'Makeup': 'fa-wand-magic-sparkles',
    'default': 'fa-spa'
};
const LOCAL_SERVICE_IMAGES = Object.freeze({
    hairColor: '../images/services/hair-color.webp',
    hairTreatment: '../images/services/hair-treatment.webp',
    facial: '../images/services/facial-treatment.webp',
    hairRemoval: '../images/services/hair-removal.webp',
    eyebrow: '../images/services/eyebrow.webp',
    bodyContouring: '../images/services/body-contouring.webp',
    skinBrightening: '../images/services/skin-brightening.webp'
});

// =============================================================
// DOM REFS
// =============================================================
const feedbackModal = document.getElementById('feedbackModal');
const feedbackCloseBtn = document.getElementById('feedbackCloseBtn');
const feedbackApptId = document.getElementById('feedbackApptId');
const feedbackComment = document.getElementById('feedbackComment');
const feedbackCancelBtn = document.getElementById('feedbackCancelBtn');
const feedbackSubmitBtn = document.getElementById('feedbackSubmitBtn');
const starElements = document.querySelectorAll('.star-rating i');
let selectedRating = 0;

const logoutBtn = document.getElementById("logout-btn");
const bellIcon = document.getElementById("bellIcon");
const notifBadge = document.getElementById("notifBadge");
const notifPanel = document.getElementById("notifPanel");
const notifOverlay = document.getElementById("notifOverlay");
const notifPanelClose = document.getElementById("notifPanelClose");
const notifPanelBody = document.getElementById("notifPanelBody");

const tabPanes = document.querySelectorAll('.tab-pane');
const navItems = document.querySelectorAll('.nav-item');
const dashboardServices = document.getElementById('dashboardServices');
const servicesContainer = document.getElementById('servicesContainer');
const bookingList = document.getElementById('bookingList');
const historyList = document.getElementById('historyList');
const bookingBadge = document.getElementById('bookingBadge');
const bookingCountBadge = document.getElementById('bookingCountBadge');

const modal = document.getElementById('bookingModal');
const modalClose = document.getElementById('modalCloseBtn');
const modalCancel = document.getElementById('modalCancelBtn');
const modalBook = document.getElementById('modalBookBtn');
const modalServiceName = document.getElementById('modalServiceName');
const modalServiceId = document.getElementById('modalServiceId');
const modalStylist = document.getElementById('modalStylist');
const modalDate = document.getElementById('modalDate');
const modalTime = document.getElementById('modalTime');
const modalNote = document.getElementById('modalNote');
const modalPaymentProof = document.getElementById('modalPaymentProof');
const studioPaymentProof = document.getElementById('studioPaymentProof');

const profileAvatar = document.getElementById('profileAvatar');
const profileAvatarImg = document.getElementById('profileAvatarImg');
const profileAvatarIcon = document.getElementById('profileAvatarIcon');
const profilePhotoInput = document.getElementById('profilePhotoInput');
const profilePhotoBtn = document.getElementById('profilePhotoBtn');
const profileName = document.getElementById('profileName');
const profileEmail = document.getElementById('profileEmail');
const profilePassword = document.getElementById('profilePassword');
const profileForm = document.getElementById('profileForm');
const deleteAccountBtn = document.getElementById('deleteAccountBtn');

const greetingName = document.getElementById('greetingName');
const greetingTime = document.getElementById('greetingTime');
const sidebarName = document.getElementById('sidebarName');
const topAvatar = document.getElementById('topAvatar');
const sidebarAvatar = document.getElementById('sidebarAvatar');

const nextServiceName = document.getElementById('nextServiceName');
const nextStylist = document.getElementById('nextStylist');
const nextTime = document.getElementById('nextTime');
const nextPrice = document.getElementById('nextPrice');
const nextStatusBadge = document.getElementById('nextStatusBadge');
const nextCancelBtn = document.getElementById('nextCancelBtn');
const nextReschedBtn = document.getElementById('nextReschedBtn');

const pickServiceName = document.getElementById('pickServiceName');
const pickDesc = document.getElementById('pickDesc');
const pickBookBtn = document.getElementById('pickBookBtn');

// =============================================================
// UTILITY
// =============================================================
function showToast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    if (!container) return;
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    const iconMap = { success: 'fa-check-circle', error: 'fa-exclamation-circle', info: 'fa-info-circle' };
    toast.innerHTML = `<i class="fas ${iconMap[type] || iconMap.info}"></i> ${message}`;
    container.appendChild(toast);
    setTimeout(() => {
        toast.style.animation = 'slideOutRight 0.35s forwards';
        setTimeout(() => toast.remove(), 400);
    }, 3200);
}

function setButtonLoading(button, isLoading) {
    if (isLoading) {
        button.dataset.originalText = button.innerHTML;
        button.disabled = true;
        button.innerHTML = `<span class="spinner-border"></span> ${reschedulingAppointmentId ? 'Updating...' : 'Booking...'}`;
    } else {
        button.disabled = false;
        button.innerHTML = button.dataset.originalText || (reschedulingAppointmentId ? 'Update Appointment' : 'Confirm Booking');
    }
}

function getTimeGreeting() {
    const hour = new Date().getHours();
    if (hour < 12) return 'Good morning';
    if (hour < 17) return 'Good afternoon';
    return 'Good evening';
}

function getCategoryIcon(category) {
    if (!category) return CATEGORY_ICONS.default;
    for (const [key, icon] of Object.entries(CATEGORY_ICONS)) {
        if (category.toLowerCase().includes(key.toLowerCase())) return icon;
    }
    return CATEGORY_ICONS.default;
}

function statusClass(status) {
    return (status || 'pending').toLowerCase().replace(/\s+/g, '-');
}

function formatPrice(amount) {
    return `₱${parseFloat(amount || 0).toLocaleString()}`;
}

function parseDurationMinutes(durationStr) {
    if (durationStr == null || durationStr === '') return null;

    if (typeof durationStr === 'number' && !Number.isNaN(durationStr)) {
        return durationStr;
    }

    const str = String(durationStr).toLowerCase().trim();

    if (isPackageDurationLabel(str) || str === 'per session') return null;

    const rangeHourMatch = str.match(/([\d.]+)\s*[-–]\s*([\d.]+)\s*h(?:r|our)?s?/);
    if (rangeHourMatch) {
        return Math.round(parseFloat(rangeHourMatch[2]) * 60);
    }

    const hourMatch = str.match(/([\d.]+)\s*h(?:r|our)?s?/);
    if (hourMatch) return Math.round(parseFloat(hourMatch[1]) * 60);

    const minMatch = str.match(/([\d.]+)\s*m(?:in)?s?/);
    if (minMatch) return Math.round(parseFloat(minMatch[1]));

    return null;
}

function getCategoryDurationFallback(category) {
    const c = (category || '').toLowerCase();
    if (c.includes('hair removal') || c.includes('whitening spots')) return 45;
    if (c.includes('slimming') || c.includes('contouring') || c.includes('hifu')) return 45;
    if (c.includes('facial treatment') || c.includes('microneedling')) return 60;
    if (c.includes('semi permanent') || c.includes('eyebrow')) return 120;
    if (c.includes('hair rebond') || c.includes('hair color') || c.includes('hair treatment')) return 180;
    if (c.includes('combo')) return 120;
    return 60;
}

function resolveServiceDurationMinutes(service) {
    if (!service) return 60;
    if (service.durationMinutes && !Number.isNaN(service.durationMinutes)) {
        return service.durationMinutes;
    }
    const parsed = parseDurationMinutes(service.duration);
    if (parsed) return parsed;
    return getCategoryDurationFallback(service.category);
}

function isPackageDurationLabel(durationStr) {
    if (!durationStr) return false;
    const str = String(durationStr).toLowerCase();
    return /package|\d+\s*\+\s*\d+|full course|\(\d+\s*sessions?\)|\d+\s*sessions?\s*\)|visits?/.test(str);
}

function getBaseService(serviceId, variantId = null) {
    const base = getServiceById(serviceId);
    if (base && !base.variantOf) return base;
    if (variantId) {
        const variant = getServiceById(variantId);
        if (variant?.variantOf) return getServiceById(variant.variantOf) || base;
    }
    if (base?.variantOf) return getServiceById(base.variantOf) || base;
    return base;
}

function getPerSessionDurationMinutes(serviceId, variantId = null) {
    const base = getBaseService(serviceId, variantId);
    return resolveServiceDurationMinutes(base);
}

function getPerSessionDurationLabel(serviceId, variantId = null) {
    const base = getBaseService(serviceId, variantId);
    const mins = resolveServiceDurationMinutes(base);
    return formatDurationLabel(mins, true);
}

function getPackageVisitNote(variant) {
    if (!variant || variant.sessionType === 'Standard') return '';
    const fromDuration = String(variant.duration || '').match(/(\d+)\s*sessions?/i);
    if (fromDuration) return `${fromDuration[1]} visits total`;
    if (/5\s*\+\s*1/i.test(variant.sessionType || '')) return '6 visits total';
    return '';
}

function formatSessionOptionLabel(variant, baseService, isStandard = false) {
    const sessionDur = formatDurationLabel(resolveServiceDurationMinutes(baseService), true);
    const price = formatPrice(isStandard ? baseService.price : variant.price);
    if (isStandard) return `Standard · ${sessionDur} · ${price}`;
    const visitNote = getPackageVisitNote(variant);
    const name = variant.sessionType || 'Package';
    return visitNote ? `${name} · ${sessionDur} · ${price} (${visitNote})` : `${name} · ${sessionDur} · ${price}`;
}

function timeToMinutes(timeStr) {
    if (!timeStr) return 0;
    const [h, m] = timeStr.split(':').map(Number);
    return h * 60 + (m || 0);
}

function minutesToTime(totalMinutes) {
    const h = Math.floor(totalMinutes / 60);
    const m = totalMinutes % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function getServiceById(serviceId) {
    return allServices.find(s => s.id === serviceId) || null;
}

function getAppointmentDuration(appt, fallbackService = null) {
    if (appt?.durationMinutes) return appt.durationMinutes;
    if (appt?.duration && !isPackageDurationLabel(appt.duration)) {
        const parsed = parseDurationMinutes(appt.duration);
        if (parsed) return parsed;
    }
    const base = getBaseService(appt?.serviceId, appt?.variantId);
    if (base) return resolveServiceDurationMinutes(base);
    const svc = fallbackService || getServiceById(appt?.serviceId || appt?.variantId);
    return resolveServiceDurationMinutes(svc);
}

function getResolvedService(serviceId, variantId) {
    const base = getBaseService(serviceId, variantId);
    if (!base) return null;

    if (variantId && variantId !== serviceId) {
        const variant = allServices.find(s => s.id === variantId);
        if (variant) {
            return {
                ...variant,
                duration: base.duration,
                perSessionDurationMinutes: resolveServiceDurationMinutes(base)
            };
        }
    }

    return {
        ...base,
        perSessionDurationMinutes: resolveServiceDurationMinutes(base)
    };
}

function generateTimeSlots(durationMins = 60) {
    const slots = [];
    for (let start = SALON_OPEN_MINUTES; start + durationMins <= SALON_CLOSE_MINUTES; start += TIME_SLOT_INTERVAL) {
        slots.push(minutesToTime(start));
    }
    return slots;
}

function populateTimeSelect(selectEl, durationMins, selectedValue = null) {
    if (!selectEl) return;
    const slots = generateTimeSlots(durationMins);
    const current = selectedValue && slots.includes(selectedValue) ? selectedValue : slots[0] || '';
    selectEl.innerHTML = slots.length
        ? slots.map(t => {
            const range = formatTimeRange(t, durationMins);
            return `<option value="${t}">${range}</option>`;
        }).join('')
        : '<option value="">No slots available</option>';
    if (current) selectEl.value = current;
    return current;
}

function isWithinSalonHours(timeStr, durationMins) {
    const start = timeToMinutes(timeStr);
    return start >= SALON_OPEN_MINUTES && start + durationMins <= SALON_CLOSE_MINUTES;
}

function isActiveBookingStatus(status) {
    const s = (status || 'Pending').toUpperCase();
    return !['CANCELLED', 'DECLINED', 'COMPLETED', 'SERVED'].includes(s);
}

function hasClientBookingConflict(date, time, durationMins, excludeApptId = null) {
    const checkList = [...activeAppointments];
    const start = timeToMinutes(time);
    const end = start + durationMins;

    return checkList.some(appt => {
        if (excludeApptId && appt.id === excludeApptId) return false;
        if (!isActiveBookingStatus(appt.status)) return false;
        const apptDate = appt.bookingDate || appt.date;
        if (apptDate !== date) return false;
        const apptTime = appt.bookingTime || appt.time;
        const apptDur = getAppointmentDuration(appt);
        const apptStart = timeToMinutes(apptTime);
        const apptEnd = apptStart + apptDur;
        return start < apptEnd && end > apptStart;
    });
}

function validateBookingSlot(date, time, durationMins, excludeApptId = null) {
    if (!date || !time) return 'Please select a date and time.';
    if (!isWithinSalonHours(time, durationMins)) {
        return 'Appointments must fit within salon hours (9:00 AM – 6:00 PM).';
    }
    if (hasClientBookingConflict(date, time, durationMins, excludeApptId)) {
        return 'You already have an appointment during this time. Please choose another slot.';
    }
    return null;
}

function buildStylistSlotKey(staffUid, date) {
    return `${staffUid}_${date}`;
}

// Mirrors appointment statuses that occupy the stylist's time.
function isSlotBlockingStatus(status) {
    const s = (status || '').toLowerCase();
    return !['cancelled', 'denied', 'declined', 'served', 'completed', 'no-show', 'no show'].includes(s);
}

// Publishes a stylist-availability index entry for an appointment. The
// slotBlocks collection is readable by all signed-in users, so Clients can see
// which stylists are already busy (they cannot read other clients' appointments).
// Never throws — a slot-index failure must not break the booking itself.
async function writeAppointmentSlotBlock(appointmentId, { staffUid, date, time, durationMins, status }) {
    if (!appointmentId || !staffUid || !date || !time) return;
    try {
        const startMin = timeToMinutes(time);
        const endMin = startMin + (durationMins || 60);
        await setDoc(doc(db, "slotBlocks", appointmentId), {
            appointmentId,
            staffUid,
            stylistDate: buildStylistSlotKey(staffUid, date),
            date,
            startMin,
            endMin,
            blocking: isSlotBlockingStatus(status),
            createdBy: currentUser ? currentUser.uid : '',
            createdAt: serverTimestamp()
        });
    } catch (err) {
        console.warn('Slot block write failed (availability may be stale):', err);
    }
}

async function removeAppointmentSlotBlock(appointmentId) {
    if (!appointmentId) return;
    try {
        await deleteDoc(doc(db, "slotBlocks", appointmentId));
    } catch (err) {
        console.warn('Slot block remove failed:', err);
    }
}

async function hasStylistBookingConflict(stylistUid, date, time, durationMins, excludeApptId = null) {
    if (!stylistUid) return false;
    try {
        const q = query(
            collection(db, "slotBlocks"),
            where("stylistDate", "==", buildStylistSlotKey(stylistUid, date))
        );
        const snap = await getDocs(q);
        const start = timeToMinutes(time);
        const end = start + durationMins;
        let conflict = false;
        snap.forEach(d => {
            const block = d.data();
            if (excludeApptId && block.appointmentId === excludeApptId) return;
            if (!block.blocking) return;
            const blockStart = block.startMin;
            const blockEnd = block.endMin;
            if (start < blockEnd && end > blockStart) conflict = true;
        });
        return conflict;
    } catch (err) {
        console.error('Stylist conflict check error:', err);
        return false;
    }
}

async function validateBookingSlotFull(date, time, durationMins, stylistUid = '', excludeApptId = null) {
    const base = validateBookingSlot(date, time, durationMins, excludeApptId);
    if (base) return base;
    if (!stylistUid) return null;

    if (await hasStylistBookingConflict(stylistUid, date, time, durationMins, excludeApptId)) {
        return 'This stylist is not available during the selected time. Please choose another time or stylist.';
    }

    try {
        const scheduleSnap = await getDoc(doc(db, "stylistSchedules", stylistUid));
        const schedule = scheduleSnap.exists()
            ? scheduleSnap.data()
            : { weeklyHours: randomizedWeeklyHours(stylistUid), blocks: [] };
        const scheduleError = validateStylistSlot([], schedule, stylistUid, date, time, durationMins, excludeApptId);
        if (scheduleError && !scheduleError.includes('Scheduling conflict')) {
            return scheduleError;
        }
    } catch (err) {
        console.error('Schedule validation error:', err);
    }
    return null;
}

function formatDurationLabel(durationInput, perSession = false) {
    const mins = typeof durationInput === 'number'
        ? durationInput
        : (parseDurationMinutes(durationInput) ?? 60);
    const hours = mins / 60;
    let label;

    if (hours === 1) {
        label = '1 hour';
    } else if (Number.isInteger(hours)) {
        label = `${hours} hours`;
    } else {
        label = `${parseFloat(hours.toFixed(1))} hours`;
    }

    return perSession ? `${label} per session` : label;
}

function formatTimeRange(startTime, durationInput) {
    if (!startTime) return '—';
    const durationMins = typeof durationInput === 'number'
        ? durationInput
        : parseDurationMinutes(durationInput);
    const endTime = minutesToTime(timeToMinutes(startTime) + durationMins);
    return `${formatDisplayTime(startTime)} to ${formatDisplayTime(endTime)}`;
}

function getDurationMinutesFromAppt(appt) {
    return appt.durationMinutes || getAppointmentDuration(appt);
}

function getBaseServices() {
    return allServices.filter(s => !s.variantOf);
}

function escapeServiceHtml(value) {
    return String(value ?? '').replace(/[&<>'"]/g, char => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
    }[char]));
}

function getServiceImageKey(service) {
    const serviceText = `${service?.serviceName || ''} ${service?.category || ''}`.toLowerCase();
    if (serviceText.includes('hair removal') || serviceText.includes('diode')) return 'hairRemoval';
    if (serviceText.includes('eyebrow') || serviceText.includes('brow')) return 'eyebrow';
    if (serviceText.includes('contour') || serviceText.includes('hifu') || serviceText.includes('slimming')) return 'bodyContouring';
    if (serviceText.includes('whiten') || serviceText.includes('pico') || serviceText.includes('microneedl')) return 'skinBrightening';
    if (serviceText.includes('facial')) return 'facial';
    if (serviceText.includes('color')) return 'hairColor';
    if (serviceText.includes('hair') || serviceText.includes('rebond') || serviceText.includes('treatment')) return 'hairTreatment';
    return 'facial';
}

function getServiceImageData(service) {
    const fallback = LOCAL_SERVICE_IMAGES[getServiceImageKey(service)];
    const storedImage = [service?.imageUrl, service?.imageURL, service?.image, service?.thumbnail, service?.servicePhoto]
        .find(value => typeof value === 'string' && value.trim());
    return { source: storedImage || fallback, fallback };
}

function serviceSearchText(service) {
    return [service.serviceName, service.description, service.category]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
}

function scoreServiceForProfile(service, profile) {
    if (!profile) return 0;
    const text = serviceSearchText(service);
    const category = (service.category || '').toLowerCase();
    let score = 0;

    if (profile.skinType && SKIN_KEYWORDS[profile.skinType]) {
        SKIN_KEYWORDS[profile.skinType].forEach(kw => {
            if (text.includes(kw)) score += 2;
        });
        if (category.includes('facial') || text.includes('facial')) score += 1;
    }

    if (profile.hairType && HAIR_KEYWORDS[profile.hairType]) {
        HAIR_KEYWORDS[profile.hairType].forEach(kw => {
            if (text.includes(kw)) score += 2;
        });
        if (category.includes('hair') || text.includes('hair')) score += 1;
    }

    return score;
}

function getRecommendedServices(limit = 3) {
    const base = getBaseServices();
    if (!base.length) return [];

    const profile = currentUserProfile || {};
    const hasPrefs = profile.skinType || profile.hairType;
    if (!hasPrefs) return base.slice(0, limit);

    const scored = base
        .map(service => ({ service, score: scoreServiceForProfile(service, profile) }))
        .sort((a, b) => b.score - a.score || (a.service.serviceName || '').localeCompare(b.service.serviceName || ''));

    if (scored.every(item => item.score === 0)) return base.slice(0, limit);
    return scored.slice(0, limit).map(item => item.service);
}

function updateCuratedSectionCopy() {
    const sub = document.getElementById('curatedSectionSub');
    const title = document.getElementById('curatedSectionTitle');
    if (sub) sub.textContent = 'Browse our complete collection of available salon treatments';
    if (title) title.textContent = 'Salon services for you';
}

function insidersPickReason(service, profile) {
    if (service.description) return service.description;

    const category = (service.category || 'beauty').toLowerCase();
    if (profile?.skinType && profile?.hairType) {
        return `Our top ${category} pick for ${profile.skinType} skin and ${profile.hairType} hair.`;
    }
    if (profile?.skinType) {
        return `A ${category} treatment suited to ${profile.skinType} skin.`;
    }
    if (profile?.hairType) {
        return `A ${category} treatment suited to ${profile.hairType} hair.`;
    }
    return `Our most requested ${category} treatment.`;
}

function getFilteredServices() {
    return allServices.filter(s => {
        if (s.variantOf) return false;
        const matchCat = activeCategoryFilter === 'all' || s.category === activeCategoryFilter;
        const q = serviceSearchQuery.toLowerCase();
        const matchSearch = !q ||
            (s.serviceName || '').toLowerCase().includes(q) ||
            (s.category || '').toLowerCase().includes(q) ||
            (s.description || '').toLowerCase().includes(q);
        return matchCat && matchSearch;
    });
}

function emptyStateHTML(icon, title, desc, btnText, btnAction) {
    return `
        <div class="empty-state">
            <div class="empty-state-icon"><i class="fas ${icon}"></i></div>
            <h4>${title}</h4>
            <p>${desc}</p>
            ${btnText ? `<button class="btn-reserve empty-action-btn" data-action="${btnAction}">${btnText}</button>` : ''}
        </div>`;
}

function updateWizardStep(step) {
    document.querySelectorAll('.wizard-step').forEach(el => {
        const n = parseInt(el.dataset.step);
        el.classList.remove('active', 'completed');
        if (n < step) el.classList.add('completed');
        if (n === step) el.classList.add('active');
    });
    document.querySelectorAll('.studio-panel').forEach(el => {
        el.classList.toggle('active', parseInt(el.dataset.panel) === step);
    });
}

function formatPassDate(dateStr) {
    if (!dateStr) return { month: '—', day: '—' };
    const d = new Date(dateStr + 'T00:00:00');
    return {
        month: d.toLocaleDateString('en-US', { month: 'short' }).toUpperCase(),
        day: d.getDate()
    };
}

function formatDisplayTime(timeStr) {
    if (!timeStr) return '—';
    const [h, m] = timeStr.split(':');
    const hour = parseInt(h, 10);
    const ampm = hour >= 12 ? 'PM' : 'AM';
    const h12 = hour % 12 || 12;
    return `${h12}:${m} ${ampm}`;
}

function updateBookingSummary(service, price, startTime = null) {
    const summaryService = document.getElementById('summaryService');
    const summaryDuration = document.getElementById('summaryDuration');
    const summaryPrice = document.getElementById('summaryPrice');
    const summaryReservationFee = document.getElementById('summaryReservationFee');
    const summaryBalanceDue = document.getElementById('summaryBalanceDue');
    const summaryTimeRange = document.getElementById('summaryTimeRange');
    const durationMins = service?.perSessionDurationMinutes
        ?? resolveServiceDurationMinutes(getBaseService(service?.id, service?.variantOf || service?.id) || service);
    const payment = computeReservationPayment(price);

    if (summaryService) summaryService.textContent = service?.serviceName || '—';
    if (summaryDuration) summaryDuration.textContent = formatDurationLabel(durationMins, true);
    if (summaryPrice) summaryPrice.textContent = formatPrice(payment.totalPrice);
    if (summaryReservationFee) summaryReservationFee.textContent = formatPrice(payment.reservationFee);
    if (summaryBalanceDue) summaryBalanceDue.textContent = formatPrice(payment.balanceDue);
    if (summaryTimeRange) {
        summaryTimeRange.textContent = startTime
            ? formatTimeRange(startTime, durationMins)
            : 'Select a time slot';
    }
}

function updateStudioReservationSummary() {
    if (!bookingWidgetState?.selectedVariantId) return;
    const service = getResolvedService(bookingWidgetState.selectedServiceId, bookingWidgetState.selectedVariantId);
    const price = service?.price ?? allServices.find(s => s.id === bookingWidgetState.selectedVariantId)?.price;
    const payment = computeReservationPayment(price);
    const totalEl = document.getElementById('studioPayTotal');
    const resEl = document.getElementById('studioPayReservation');
    const balEl = document.getElementById('studioPayBalance');
    if (totalEl) totalEl.textContent = formatPrice(payment.totalPrice);
    if (resEl) resEl.textContent = formatPrice(payment.reservationFee);
    if (balEl) balEl.textContent = formatPrice(payment.balanceDue);
}

function updateModalPaymentSummary(price) {
    const payment = computeReservationPayment(price);
    const totalEl = document.getElementById('modalPayTotal');
    const resEl = document.getElementById('modalPayReservation');
    const balEl = document.getElementById('modalPayBalance');
    const payBtn = document.getElementById('modalPayBookBtn');
    if (totalEl) totalEl.textContent = formatPrice(payment.totalPrice);
    if (resEl) resEl.textContent = formatPrice(payment.reservationFee);
    if (balEl) balEl.textContent = formatPrice(payment.balanceDue);
    if (payBtn) payBtn.textContent = `Pay ${formatPrice(payment.reservationFee)} & Confirm Booking`;
}

function showModalPaymentStep(show) {
    const details = document.getElementById('bookingDetailsStep');
    const payment = document.getElementById('bookingPaymentStep');
    const success = document.getElementById('bookingSuccessStep');
    if (details) details.style.display = show ? 'none' : '';
    if (payment) payment.style.display = show ? '' : 'none';
    if (success) success.style.display = 'none';
}

function resetModalBookingView() {
    showModalPaymentStep(false);
    resetPaymentProof('modal');
    const success = document.getElementById('bookingSuccessStep');
    if (success) success.style.display = 'none';
    if (modalBook) modalBook.textContent = reschedulingAppointmentId ? 'Update Appointment' : 'Continue to Payment';
}

function showBookingModalSuccess(payMethod, payment) {
    const textEl = document.getElementById('bookingSuccessText');
    const noteEl = document.getElementById('bookingSuccessPaymentNote');
    if (textEl) textEl.textContent = 'Your booking request has been submitted and is awaiting salon confirmation.';
    if (noteEl) {
        noteEl.textContent = payMethod === 'cash'
            ? `Reservation fee ${formatPrice(payment.reservationFee)} is due in cash when you visit.`
            : `Reservation fee ${formatPrice(payment.reservationFee)} received — your payment proof is pending admin verification.`;
    }
    const details = document.getElementById('bookingDetailsStep');
    const paymentStep = document.getElementById('bookingPaymentStep');
    const success = document.getElementById('bookingSuccessStep');
    if (details) details.style.display = 'none';
    if (paymentStep) paymentStep.style.display = 'none';
    if (success) success.style.display = '';
}

function showBookingStudioConfirmation(payMethod, payment) {
    const textEl = document.getElementById('studioConfirmationText');
    const noteEl = document.getElementById('studioPaymentNote');
    if (textEl) textEl.textContent = 'Your booking request has been submitted and is awaiting salon confirmation.';
    if (noteEl) {
        noteEl.textContent = payMethod === 'cash'
            ? `Reservation fee ${formatPrice(payment.reservationFee)} is due in cash when you visit.`
            : `Reservation fee ${formatPrice(payment.reservationFee)} received — your payment proof is pending admin verification.`;
    }
    showBookingStudioStep(6);
}

let stopQrPaymentSettingsListener = null;

function getQrPaymentImageSource(settings = qrPaymentSettings) {
    // qrCodeURL supports settings saved by the previous Storage-based version.
    // New Admin settings use the Firestore Data URL in qrImageData.
    return settings?.qrImageData || settings?.qrCodeURL || '';
}

// ---------------------------------------------------------------------------
// MULTIPLE QR PAYMENT OPTIONS
// The admin may configure up to 5 options; each is its own document under
// systemSettings/qrPayment/providers so several base64 QR images never share
// one Firestore document. The original single-QR configuration is still read
// from systemSettings/qrPayment so existing installs keep working unchanged.
// ---------------------------------------------------------------------------
function sortQrPaymentProviders(providers) {
    return [...providers].sort((a, b) => {
        const ao = Number.isFinite(a.displayOrder) ? a.displayOrder : 99;
        const bo = Number.isFinite(b.displayOrder) ? b.displayOrder : 99;
        if (ao !== bo) return ao - bo;
        return String(a.providerName || '').localeCompare(String(b.providerName || ''));
    });
}

// Options that are active AND actually carry a QR image.
function getActiveQrProviders() {
    return qrPaymentProviders.filter(p => p.enabled === true && !!getQrPaymentImageSource(p));
}

function getLegacyQrProvider() {
    if (qrPaymentSettings.enabled !== true) return null;
    const image = getQrPaymentImageSource(qrPaymentSettings);
    if (!image) return null;
    return {
        id: 'legacy',
        providerId: 'legacy',
        providerName: qrPaymentSettings.accountName || 'Salon QR',
        accountName: qrPaymentSettings.accountName || '',
        accountNumber: qrPaymentSettings.accountNumber || '',
        instructions: qrPaymentSettings.instructions || '',
        qrImageData: qrPaymentSettings.qrImageData || '',
        qrCodeURL: qrPaymentSettings.qrCodeURL || '',
        enabled: true,
        displayOrder: 0
    };
}

// Providers become authoritative as soon as the admin has saved one. Before
// that, the original single-QR document remains the only source available.
function getEffectiveQrProviders() {
    const active = getActiveQrProviders();
    if (active.length) return active;
    if (qrPaymentSettings.providersManaged === true) return [];
    const legacy = getLegacyQrProvider();
    return legacy ? [legacy] : [];
}

function getSelectedQrProvider() {
    const list = getEffectiveQrProviders();
    if (!list.length) return null;
    return list.find(p => p.id === selectedQrProviderId) || list[0];
}

function hasConfiguredQrPayment() {
    return getEffectiveQrProviders().length > 0;
}

function escapeQrProviderHtml(value) {
    return String(value ?? '').replace(/[&<>'"]/g, char => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]
    ));
}

function updateQrProviderSelector(prefix) {
    const wrap = document.getElementById(`${prefix}QrProviderSelect`);
    const options = document.getElementById(`${prefix}QrProviderOptions`);
    if (!wrap || !options) return;

    const list = getEffectiveQrProviders();
    // One option needs no choice: the existing single-QR presentation stays as-is.
    if (list.length < 2) {
        wrap.style.display = 'none';
        options.innerHTML = '';
        return;
    }
    if (!list.some(p => p.id === selectedQrProviderId)) {
        selectedQrProviderId = list[0].id;
    }
    wrap.style.display = '';
    options.innerHTML = list.map(p => {
        const selected = p.id === selectedQrProviderId ? ' is-selected' : '';
        return `<button type="button" class="qr-provider-option${selected}" data-provider-id="${escapeQrProviderHtml(p.id)}">${escapeQrProviderHtml(p.providerName || 'QR')}</button>`;
    }).join('');
}

async function loadQrPaymentSettings() {
    const settingsRef = doc(db, 'systemSettings', 'qrPayment');
    const providersRef = collection(db, 'systemSettings', 'qrPayment', 'providers');
    try {
        console.info('[QR Payment] Reading Firestore settings.', {
            operation: 'getDoc',
            path: 'systemSettings/qrPayment',
            authenticated: !!auth.currentUser,
            uid: auth.currentUser?.uid || null
        });
        const snap = await getDoc(settingsRef);
        qrPaymentSettings = snap.exists()
            ? { ...QR_PAYMENT_SETTINGS_DEFAULTS, ...snap.data() }
            : { ...QR_PAYMENT_SETTINGS_DEFAULTS };
        console.info('[QR Payment] Firestore settings read completed.', {
            path: 'systemSettings/qrPayment',
            exists: snap.exists(),
            hasQrImageData: !!qrPaymentSettings.qrImageData,
            hasQrCodeURL: !!qrPaymentSettings.qrCodeURL
        });
    } catch (err) {
        console.warn('[QR Payment] Firestore settings read failed.', {
            operation: 'getDoc',
            path: 'systemSettings/qrPayment',
            code: err?.code,
            message: err?.message
        });
    }

    // Payment options live in their own subcollection (max 5). A failed read
    // must never block booking — the legacy single-QR document still applies.
    try {
        const providerSnap = await getDocs(providersRef);
        qrPaymentProviders = sortQrPaymentProviders(
            providerSnap.docs.map(d => ({ id: d.id, ...d.data() }))
        );
        console.info('[QR Payment] Payment options loaded.', {
            path: 'systemSettings/qrPayment/providers',
            total: qrPaymentProviders.length,
            active: getActiveQrProviders().length
        });
    } catch (err) {
        qrPaymentProviders = [];
        console.warn('[QR Payment] Payment options read failed.', {
            operation: 'getDocs',
            path: 'systemSettings/qrPayment/providers',
            code: err?.code,
            message: err?.message
        });
    }
    ['studio', 'modal'].forEach(prefix => {
        updateQrProviderSelector(prefix);
        updateQrPaymentPanel(prefix);
    });

    // Keep an open client dashboard synchronized when the admin edits a QR.
    stopQrPaymentSettingsListener?.();
    stopQrPaymentSettingsListener = onSnapshot(settingsRef, snap => {
        qrPaymentSettings = snap.exists()
            ? { ...QR_PAYMENT_SETTINGS_DEFAULTS, ...snap.data() }
            : { ...QR_PAYMENT_SETTINGS_DEFAULTS };
        ['studio', 'modal'].forEach(prefix => {
            updateQrProviderSelector(prefix);
            updateQrPaymentPanel(prefix);
            updatePaymentMethodHints(prefix);
        });
    }, err => console.warn('[QR Payment] Live Firestore settings listener stopped.', {
        operation: 'onSnapshot',
        path: 'systemSettings/qrPayment',
        code: err?.code,
        message: err?.message
    }));

    // Live updates when the admin adds, disables or removes a payment option.
    stopQrProviderListener?.();
    stopQrProviderListener = onSnapshot(providersRef, snap => {
        qrPaymentProviders = sortQrPaymentProviders(
            snap.docs.map(d => ({ id: d.id, ...d.data() }))
        );
        ['studio', 'modal'].forEach(prefix => {
            updateQrProviderSelector(prefix);
            updateQrPaymentPanel(prefix);
            updatePaymentMethodHints(prefix);
        });
    }, err => console.warn('[QR Payment] Live payment-options listener stopped.', {
        operation: 'onSnapshot',
        path: 'systemSettings/qrPayment/providers',
        code: err?.code,
        message: err?.message
    }));
}

function updateQrPaymentPanel(prefix) {
    const method = document.querySelector(`input[name="${prefix}-reservation-pay"]:checked`)?.value || '';
    const panel = document.getElementById(`${prefix}QrPaymentPanel`);
    const proofGroup = document.getElementById(`${prefix}PaymentProofGroup`);
    const image = document.getElementById(`${prefix}QrPaymentImage`);
    const meta = document.getElementById(`${prefix}QrPaymentMeta`);
    const instructions = document.getElementById(`${prefix}QrPaymentInstructions`);
    const isQr = method === 'qr';
    const qrRadio = document.querySelector(`input[name="${prefix}-reservation-pay"][value="qr"]`);
    if (qrRadio) {
        // Keep QR Code selectable even while settings are loading or unavailable.
        // The payment panel explains the state and booking validation prevents a
        // QR booking without a configured QR code.
        qrRadio.disabled = false;
        qrRadio.closest('.reservation-pay-option')?.classList.remove('is-disabled');
    }

    if (panel) panel.style.display = isQr ? '' : 'none';
    if (proofGroup) proofGroup.style.display = isQr ? '' : 'none';

    if (!isQr) return;

    // The panel always reflects the option the client picked (or the only one
    // available), so switching providers replaces the QR and account details.
    const provider = getSelectedQrProvider();
    const currentSource = () => getQrPaymentImageSource(getSelectedQrProvider());
    const qrUrl = provider ? getQrPaymentImageSource(provider) : '';
    const unavailable = 'QR payment is currently unavailable. Please choose Cash Payment or contact the salon.';

    if (image) {
        image.onerror = () => {
            if (currentSource() !== qrUrl) return;
            console.error('[QR Payment] QR image failed to load', { url: qrUrl });
            image.style.display = 'none';
            if (meta) meta.textContent = unavailable;
        };
        image.onload = () => {
            if (currentSource() === qrUrl) image.style.display = 'block';
        };
        image.src = qrUrl;
        image.style.display = qrUrl ? 'block' : 'none';
        image.alt = provider?.accountName
            ? `QR code for ${provider.accountName}`
            : 'Salon payment QR code';
    }
    if (meta) {
        const parts = provider ? [provider.accountName, provider.accountNumber].filter(Boolean) : [];
        meta.textContent = qrUrl
            ? (parts.join(' · ') || 'Salon QR payment')
            : unavailable;
    }
    if (instructions) {
        instructions.textContent = (provider && provider.instructions)
            || qrPaymentSettings.instructions
            || 'Scan the QR, complete the reservation payment, then upload your screenshot or photo as proof.';
    }
}

function getPaymentProofInput(prefix) {
    return document.getElementById(`${prefix}PaymentProof`);
}

function getPaymentProofFile(prefix) {
    return getPaymentProofInput(prefix)?.files?.[0] || null;
}

function resetPaymentProof(prefix) {
    const input = getPaymentProofInput(prefix);
    const preview = document.getElementById(`${prefix}PaymentProofPreview`);
    const previewImage = document.getElementById(`${prefix}PaymentProofPreviewImage`);
    const fileName = document.getElementById(`${prefix}PaymentProofFileName`);
    if (input) input.value = '';
    if (preview) preview.style.display = 'none';
    if (previewImage) previewImage.src = '';
    if (fileName) fileName.textContent = '';
    const status = document.getElementById(`${prefix}PaymentProofStatus`);
    if (status) {
        status.className = 'payment-proof-status';
        status.innerHTML = '';
    }
    if (input) input.disabled = false;
}

function updatePaymentProofUploadState(prefix, state) {
    const status = document.getElementById(`${prefix}PaymentProofStatus`);
    const input = getPaymentProofInput(prefix);
    if (!status) return;
    if (state === 'uploading') {
        status.className = 'payment-proof-status is-uploading';
        status.innerHTML = '<i class="fas fa-cloud-arrow-up"></i> Uploading payment proof…';
        if (input) input.disabled = true;
    } else if (state === 'selected') {
        status.className = 'payment-proof-status is-selected';
        status.innerHTML = '<i class="fas fa-image"></i> Proof selected and ready to upload';
        if (input) input.disabled = false;
    } else if (state === 'uploaded') {
        status.className = 'payment-proof-status is-success';
        status.innerHTML = '<i class="fas fa-circle-check"></i> Payment proof uploaded';
        if (input) input.disabled = false;
    } else if (state === 'error') {
        status.className = 'payment-proof-status is-error';
        status.innerHTML = '<i class="fas fa-circle-exclamation"></i> Payment proof was not uploaded';
        if (input) input.disabled = false;
    }
}

function bindPaymentProofInput(prefix) {
    const input = getPaymentProofInput(prefix);
    if (!input || input.dataset.bound === '1') return;
    input.dataset.bound = '1';
    input.addEventListener('change', () => {
        const file = input.files?.[0];
        const preview = document.getElementById(`${prefix}PaymentProofPreview`);
        const previewImage = document.getElementById(`${prefix}PaymentProofPreviewImage`);
        const fileName = document.getElementById(`${prefix}PaymentProofFileName`);
        if (!file) {
            resetPaymentProof(prefix);
            return;
        }
        if (!isValidImageFile(file)) {
            showToast('Please upload a JPG, PNG, or WebP image.', 'error');
            resetPaymentProof(prefix);
            return;
        }
        if (file.size > 5 * 1024 * 1024) {
            showToast('Proof image must be 5 MB or smaller.', 'error');
            resetPaymentProof(prefix);
            return;
        }
        if (preview && previewImage) {
            const reader = new FileReader();
            reader.onload = () => {
                previewImage.src = reader.result;
                preview.style.display = 'flex';
            };
            reader.readAsDataURL(file);
        }
        if (fileName) fileName.textContent = file.name;
        updatePaymentProofUploadState(prefix, 'selected');
        showToast('Payment proof selected. It will be uploaded when you confirm the booking.', 'info');
    });
}

async function compressPaymentProofImageFile(file, maxDim = 1100, quality = 0.72) {
    const dataUrl = await compressImageFile(file, maxDim, quality);
    // Keep the fallback comfortably below Firestore's document-size limit.
    if (dataUrl.length > 650000) {
        throw new Error('Proof image is too large after compression. Please choose a smaller image.');
    }
    return dataUrl;
}

async function uploadPaymentProof(file, appointmentId, onStateChange = null) {
    if (!file) return { url: '', storagePath: '' };

    // Firebase Storage is not available for this project on the current plan.
    // Previously the booking flow waited for uploadBytes() before it could fall
    // back, which could leave the UI stuck on "Uploading payment proof..." and
    // the button stuck on "Booking...".  Store a compressed image data URL in
    // the appointment document instead.  Admin proof preview already accepts a
    // normal image URL, and data URLs work there without changing the UI.
    onStateChange?.('uploading');
    try {
        const dataUrl = await compressPaymentProofImageFile(file);
        onStateChange?.('uploaded');
        return { url: dataUrl, storagePath: '' };
    } catch (err) {
        onStateChange?.('error');
        throw err;
    }
}

function updatePaymentMethodHints(prefix) {
    const hintEl = document.getElementById(prefix + 'PaymentHint');
    const referenceGroup = document.getElementById(prefix + 'PaymentRefGroup');
    const referenceInput = document.getElementById(prefix + 'PaymentRef');
    const method = document.querySelector(`input[name="${prefix}-reservation-pay"]:checked`)?.value || '';
    if (hintEl) {
        if (method === 'qr') {
            hintEl.textContent = hasConfiguredQrPayment()
                ? 'Scan the QR above, complete the payment, then upload your payment proof.'
                : 'QR payment is currently unavailable. Please choose Cash Payment or contact the salon.';
        } else {
            hintEl.textContent = 'Pay the reservation fee in cash when you visit. No reference needed.';
        }
    }
    if (referenceGroup) referenceGroup.style.display = method === 'qr' ? '' : 'none';
    if (method !== 'qr' && referenceInput) referenceInput.value = '';
    updateQrPaymentPanel(prefix);
}

function bindPaymentMethodHints() {
    ['studio', 'modal'].forEach(prefix => {
        const radios = document.querySelectorAll(`input[name="${prefix}-reservation-pay"]`);
        radios.forEach(radio => radio.addEventListener('change', () => updatePaymentMethodHints(prefix)));
        bindPaymentProofInput(prefix);

        // Choosing a payment option swaps the QR, account details and instructions.
        const options = document.getElementById(`${prefix}QrProviderOptions`);
        if (options && options.dataset.bound !== '1') {
            options.dataset.bound = '1';
            options.addEventListener('click', (event) => {
                const button = event.target.closest('[data-provider-id]');
                if (!button) return;
                selectedQrProviderId = button.dataset.providerId || '';
                ['studio', 'modal'].forEach(p => {
                    updateQrProviderSelector(p);
                    updateQrPaymentPanel(p);
                    updatePaymentMethodHints(p);
                });
            });
        }

        if (radios.length) updatePaymentMethodHints(prefix);
    });
}

async function collectBookingFormData() {
    const date = modalDate.value;
    const time = modalTime.value;
    if (!date || !time) return { error: 'Please select date and time.' };
    if (isPastBookingDate(date)) return { error: 'You cannot book appointments on past dates. Please select today or a future date.' };

    const stylistId = modalStylist.value;
    let staffName = 'Any Available Stylist';
    if (stylistId) {
        const staff = loadedStaffMembers.find(s => s.id === stylistId);
        if (staff) staffName = staff.fullName || staff.email || 'Stylist';
    }

    const serviceId = modalServiceId.value;
    const variantId = modalVariantId.value;
    const service = allServices.find(s => s.id === serviceId);
    if (!service) return { error: 'Service not found.' };

    const resolved = getResolvedService(serviceId, variantId);
    const variant = variantId !== serviceId ? allServices.find(s => s.id === variantId) : null;
    const saveServiceName = variant ? variant.serviceName : service.serviceName;
    const savePrice = parseFloat(variant ? variant.price : service.price) || 0;
    const durationMins = resolved?.perSessionDurationMinutes ?? getPerSessionDurationMinutes(serviceId, variantId);
    const base = getBaseService(serviceId, variantId);
    const duration = base?.duration || '60 min';
    const payment = computeReservationPayment(savePrice);

    const stylistValidation = await validateSelectedStylist(
        stylistId, serviceId, date, time, durationMins, reschedulingAppointmentId
    );
    if (stylistValidation.error) return { error: stylistValidation.error };
    staffName = stylistValidation.staffName;

    return {
        date, time, note: modalNote.value.trim(), stylistId, staffName,
        serviceId, variantId, service, saveServiceName, savePrice, durationMins, duration, payment
    };
}

// Payment rule: QR requires a configured code and payment proof; Cash is
// payable at the salon and must not require QR-specific information.
function validateReservationPaymentInputs(payMethod, paymentReference = '', paymentProofFile = null) {
    if (!['qr', 'cash'].includes(payMethod)) {
        return 'Please select QR Payment or Cash Payment.';
    }
    const isQr = payMethod === 'qr';
    if (isQr) {
        // The client must have an active option to pay through — this covers both
        // "no QR configured" and "the admin disabled every option".
        if (!getSelectedQrProvider()) return 'QR payment is currently unavailable. Please choose Cash Payment or contact the salon.';
        const reference = String(paymentReference || '').trim();
        if (!reference) return 'Please enter the transaction/reference number from your QR payment.';
        if (reference.length > 100) return 'Transaction/reference number must be 100 characters or fewer.';
        if (!paymentProofFile) return 'Please upload your payment proof before completing the QR payment booking.';
        if (!isValidImageFile(paymentProofFile)) return 'Payment proof must be a JPG, PNG, or WebP image.';
        if (paymentProofFile.size > 5 * 1024 * 1024) return 'Payment proof must be 5 MB or smaller.';
        return null;
    }
    return null;
}

async function submitBookingWithReservation(bookingData, paymentMethod, paymentRef = '', paymentProofFile = null, paymentProofStateCallback = null) {
    const {
        date, time, note, stylistId, staffName,
        serviceId, variantId, service, saveServiceName, savePrice, durationMins, duration, payment
    } = bookingData;

    if (reschedulingAppointmentId) {
        const oldAppt = activeAppointments.find(a => a.id === reschedulingAppointmentId);
        await updateDoc(doc(db, "appointments", reschedulingAppointmentId), {
            serviceId,
            variantId: variantId !== serviceId ? variantId : null,
            serviceName: saveServiceName,
            price: savePrice,
            bookingDate: date,
            bookingTime: time,
            date,
            time,
            duration,
            durationMinutes: durationMins,
            note,
            staffUid: stylistId,
            staffName,
            updatedAt: serverTimestamp()
        });
        await removeAppointmentSlotBlock(reschedulingAppointmentId);
        if (stylistId) {
            await writeAppointmentSlotBlock(reschedulingAppointmentId, {
                staffUid: stylistId, date, time, durationMins,
                status: oldAppt?.status || 'Pending'
            });
        }
        showToast('Appointment rescheduled successfully!', 'success');
        reschedulingAppointmentId = null;
        return;
    }

    // Defense-in-depth: never create a booking with missing payment details.
    const paymentError = validateReservationPaymentInputs(paymentMethod, paymentRef, paymentProofFile);
    if (paymentError) throw new Error(paymentError);

    const isRemote = paymentMethod === 'qr';
    const reservationReference = isRemote ? paymentRef : '';
    const proofFile = isRemote ? paymentProofFile : null;
    // Snapshot the chosen option so history and verification keep showing the
    // provider name even if the admin later renames or deletes it.
    const qrProvider = isRemote ? getSelectedQrProvider() : null;
    const paymentProviderName = qrProvider ? (qrProvider.providerName || '') : '';
    const paymentProviderId = qrProvider ? (qrProvider.id || '') : '';
    const clientFullName = currentUserProfile?.fullName || currentUser.displayName || currentUser.email || 'Valued Client';

    const apptRef = doc(collection(db, 'appointments'));
    const proofUpload = proofFile ? await uploadPaymentProof(proofFile, apptRef.id, paymentProofStateCallback) : { url: '', storagePath: '' };
    await setDoc(apptRef, {
        clientId: currentUser.uid,
        clientEmail: currentUser.email || '',
        clientName: clientFullName,
        serviceId,
        variantId: variantId !== serviceId ? variantId : null,
        serviceName: saveServiceName,
        category: service.category || '',
        price: savePrice,
        reservationFee: payment.reservationFee,
        reservationFeePaid: payment.reservationFee,
        reservationPaymentMethod: paymentMethod,
        reservationReference,
        ...(paymentProviderName
            ? {
                reservationPaymentProviderId: paymentProviderId,
                reservationPaymentProviderName: paymentProviderName
            }
            : {}),
        reservationPaymentStatus: isRemote ? 'awaiting-verification' : 'pay-at-salon',
        ...(isRemote ? { reservationPaidAt: serverTimestamp() } : {}),
        ...(paymentMethod === 'qr' ? {
            paymentProofURL: proofUpload.url || '',
            paymentProofStoragePath: proofUpload.storagePath || '',
            paymentProofUploadedAt: serverTimestamp(),
            paymentProofStatus: 'awaiting-review'
        } : {}),
        balanceDue: payment.balanceDue,
        balancePaid: payment.balanceDue === 0,
        duration,
        durationMinutes: durationMins,
        staffUid: stylistId || '',
        staffName,
        bookingDate: date,
        bookingTime: time,
        date,
        time,
        status: 'Pending',
        note,
        createdAt: serverTimestamp()
    });

    if (stylistId) {
        await writeAppointmentSlotBlock(apptRef.id, {
            staffUid: stylistId, date, time, durationMins, status: 'Pending'
        });
    }

    await addDoc(collection(db, 'transactions'), {
        clientId: currentUser.uid,
        clientName: clientFullName,
        clientEmail: currentUser.email || '',
        serviceName: saveServiceName,
        staffName,
        amount: payment.reservationFee,
        paymentType: 'reservation',
        paymentMethod,
        referenceNumber: reservationReference,
        ...(paymentProviderName
            ? {
                paymentProviderId,
                paymentProvider: paymentProviderName
            }
            : {}),
        paymentStatus: isRemote ? 'awaiting-verification' : 'pay-at-salon',
        ...(isRemote ? { paymentDate: serverTimestamp() } : {}),
        appointmentId: apptRef.id,
        date: new Date().toISOString().split('T')[0],
        createdAt: serverTimestamp()
    });

    const paymentStatusLabel = isRemote ? 'paid via QR (proof uploaded)' : 'payable in cash at visit';
    await addDoc(collection(db, 'notifications'), {
        recipientId: 'admin',
        message: `New booking: ${clientFullName} requested ${saveServiceName} on ${date} at ${time}. Reservation fee ${formatPrice(payment.reservationFee)} ${paymentStatusLabel}.`,
        isRead: false,
        createdAt: serverTimestamp()
    });
    await addDoc(collection(db, 'notifications'), {
        recipientId: 'staff',
        message: `New appointment: ${clientFullName} — ${saveServiceName} on ${date} at ${time}. ${isRemote ? 'Reservation paid via QR with proof uploaded.' : 'Cash pay-at-salon reservation.'}${!stylistId ? ' Stylist assignment required.' : ''}`,
        isRead: false,
        createdAt: serverTimestamp()
    });

    showToast(isRemote
        ? `Booking confirmed! Reservation fee ${formatPrice(payment.reservationFee)} paid${paymentMethod === 'qr' ? ' and proof uploaded' : ''}. Balance at visit: ${formatPrice(payment.balanceDue)}.`
        : `Booking confirmed! Reservation fee ${formatPrice(payment.reservationFee)} is payable in cash at your visit. Balance: ${formatPrice(payment.balanceDue)}.`, 'success');
}

async function submitStudioBookingWithReservation() {
    const { selectedServiceId, selectedVariantId, date, time, durationMinutes, stylistId } = bookingWidgetState || {};
    if (!selectedServiceId || !selectedVariantId || !date || !time) {
        showToast('Please complete all booking steps.', 'error');
        return;
    }
    if (isPastBookingDate(date)) {
        showToast('You cannot book appointments on past dates. Please select today or a future date.', 'error');
        return;
    }

    const service = allServices.find(s => s.id === selectedServiceId);
    const variant = selectedVariantId !== selectedServiceId ? allServices.find(s => s.id === selectedVariantId) : null;
    const saveServiceName = variant ? variant.serviceName : service?.serviceName;
    const savePrice = parseFloat(variant ? variant.price : service?.price) || 0;
    const resolved = getResolvedService(selectedServiceId, selectedVariantId);
    const durationMins = durationMinutes || getPerSessionDurationMinutes(selectedServiceId, selectedVariantId);
    const base = getBaseService(selectedServiceId, selectedVariantId);
    const duration = base?.duration || '60 min';
    const payment = computeReservationPayment(savePrice);

    let staffName = 'Any Available Stylist';
    if (stylistId) {
        const staff = loadedStaffMembers.find(s => s.id === stylistId);
        if (staff) staffName = staff.fullName || staff.email || 'Stylist';
    }

    const stylistValidation = await validateSelectedStylist(
        stylistId || '', selectedServiceId, date, time, durationMins
    );
    if (stylistValidation.error) {
        showToast(stylistValidation.error, 'error');
        return;
    }
    staffName = stylistValidation.staffName;

    const payMethod = document.querySelector('input[name="studio-reservation-pay"]:checked')?.value;
    const payRef = document.getElementById('studioPaymentRef')?.value.trim() || '';
    const paymentProofFile = getPaymentProofFile('studio');
    const paymentError = validateReservationPaymentInputs(payMethod, payRef, paymentProofFile);
    if (paymentError) {
        showToast(paymentError, 'error');
        return;
    }

    const bookBtn = document.getElementById('bookingQuickBookBtn');
    setButtonLoading(bookBtn, true);
    if (payMethod === 'qr') {
        updatePaymentProofUploadState('studio', 'uploading');
        showToast('Uploading your payment proof…', 'info');
    }
    try {
        await submitBookingWithReservation({
            date, time, note: '', stylistId: stylistId || '', staffName,
            serviceId: selectedServiceId,
            variantId: selectedVariantId,
            service,
            saveServiceName,
            savePrice,
            durationMins,
            duration,
            payment
        }, payMethod, payRef, paymentProofFile, state => updatePaymentProofUploadState('studio', state));
        showBookingStudioConfirmation(payMethod, payment);
    } catch (err) {
        if (payMethod === 'qr') updatePaymentProofUploadState('studio', 'error');
        showToast('Failed: ' + err.message, 'error');
    } finally {
        setButtonLoading(bookBtn, false);
    }
}

// =============================================================
// 1. AUTH STATE
// =============================================================
onAuthStateChanged(auth, async (user) => {
    if (!user) { window.location.href = "../index.html"; return; }
    if (!requireMfaOrRedirect(user)) return;
    currentUser = user;
    await loadQrPaymentSettings();
    if (greetingTime) greetingTime.textContent = getTimeGreeting();
    await loadUserProfile(user);
    await loadStaffMembers();
    await loadServicesAndCategories();
    listenToClientAppointments(user.uid);
    listenToClientNotifications(user.uid);
    initUIHandlers();
    initProfilePhotoUpload();
    initSalonCalendar();

    const dateStr = new Date().toLocaleDateString('en-US', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    const dateEl = document.getElementById('currentDate');
    if (dateEl) dateEl.textContent = dateStr.toUpperCase();
});

// =============================================================
// 2. LOAD USER PROFILE
// =============================================================
async function loadUserProfile(user) {
    try {
        const userDoc = await getDoc(doc(db, "users", user.uid));
        let displayName = user.displayName || 'Beautiful';

        if (userDoc.exists()) {
            currentUserProfile = userDoc.data();
            displayName = currentUserProfile.fullName || displayName;
            populateProfileFields(currentUserProfile, user);
        } else {
            populateProfileFields({}, user);
        }

        greetingName.textContent = displayName.split(' ')[0];
        sidebarName.textContent = displayName;
        const initial = displayName.charAt(0).toUpperCase();
        const photoURL = currentUserProfile?.photoURL || localStorage.getItem(`client_profile_pic_${user.uid}`);
        if (photoURL) {
            localStorage.setItem(`client_profile_pic_${user.uid}`, photoURL);
            applyAvatarEverywhere(photoURL, initial);
        } else {
            applyAvatarEverywhere(null, initial);
        }
    } catch (err) {
        console.error("Profile load error:", err);
    }
}

function populateProfileFields(data, user) {
    const setVal = (id, val) => {
        const el = document.getElementById(id);
        if (el) el.value = val ?? '';
    };
    const setCheck = (id, val, defaultVal = false) => {
        const el = document.getElementById(id);
        if (el) el.checked = val === undefined || val === null ? defaultVal : !!val;
    };

    setVal('profileName', data.fullName || user.displayName || '');
    setVal('profileEmail', user.email || '');
    setVal('profilePhone', data.phone || '');
    setVal('profileBirthday', data.dateOfBirth || '');
    setVal('profileGender', data.gender || '');
    setCheck('profileEmailReminders', data.emailReminders, true);
    setCheck('profilePromoEmails', data.promoEmails, false);

    // These display-only banner elements mirror existing loaded profile data.
    const summaryName = document.getElementById('profileSummaryName');
    const summaryEmail = document.getElementById('profileSummaryEmail');
    if (summaryName) summaryName.textContent = data.fullName || user.displayName || 'Your profile';
    if (summaryEmail) summaryEmail.textContent = user.email || '';

    const memberEl = document.getElementById('profileMemberSince');
    if (memberEl) {
        const created = data.createdAt?.toDate?.() || user.metadata?.creationTime;
        if (created) {
            const d = created instanceof Date ? created : new Date(created);
            memberEl.textContent = `Member since ${d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}`;
        }
    }
}

function setAvatarImage(url) {
    if (!profileAvatarImg || !profileAvatarIcon) return;
    if (url) {
        profileAvatarImg.src = url;
        profileAvatarImg.style.display = 'block';
        profileAvatarIcon.style.display = 'none';
    } else {
        profileAvatarImg.src = '';
        profileAvatarImg.style.display = 'none';
        profileAvatarIcon.style.display = 'block';
    }
}

function applyAvatarEverywhere(url, fallbackInitial = 'A') {
    setAvatarImage(url);

    [topAvatar, sidebarAvatar].forEach(el => {
        if (!el) return;
        if (url) {
            el.style.backgroundImage = `url(${url})`;
            el.classList.add('has-photo');
            el.textContent = '';
        } else {
            el.style.backgroundImage = '';
            el.classList.remove('has-photo');
            el.textContent = fallbackInitial;
        }
    });
}

function isValidImageFile(file) {
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/jpg'];
    const ext = file.name.split('.').pop()?.toLowerCase() || '';
    const validExt = ['jpg', 'jpeg', 'png', 'webp'];
    return allowed.includes(file.type) || validExt.includes(ext);
}

function compressImageFile(file, maxDim = 480, quality = 0.85) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
            const img = new Image();
            img.onload = () => {
                let { width, height } = img;
                const scale = Math.min(1, maxDim / Math.max(width, height));
                width = Math.max(1, Math.round(width * scale));
                height = Math.max(1, Math.round(height * scale));
                const canvas = document.createElement('canvas');
                canvas.width = width;
                canvas.height = height;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0, width, height);
                resolve(canvas.toDataURL('image/jpeg', quality));
            };
            img.onerror = () => reject(new Error('Could not read image'));
            img.src = reader.result;
        };
        reader.onerror = () => reject(new Error('Could not read file'));
        reader.readAsDataURL(file);
    });
}

async function dataUrlToBlob(dataUrl) {
    const res = await fetch(dataUrl);
    return res.blob();
}

async function saveProfilePhotoUrl(url) {
    await setDoc(doc(db, "users", currentUser.uid), {
        photoURL: url,
        updatedAt: serverTimestamp()
    }, { merge: true });

    currentUserProfile = { ...currentUserProfile, photoURL: url };
    localStorage.setItem(`client_profile_pic_${currentUser.uid}`, url);

    const initial = (currentUserProfile.fullName || 'A').charAt(0).toUpperCase();
    applyAvatarEverywhere(url, initial);
}

async function uploadProfilePhoto(file) {
    const dataUrl = await compressImageFile(file);

    try {
        const blob = await dataUrlToBlob(dataUrl);
        const storageRef = ref(storage, `profilePhotos/${currentUser.uid}`);
        await uploadBytes(storageRef, blob, { contentType: 'image/jpeg' });
        return await getDownloadURL(storageRef);
    } catch (storageErr) {
        console.warn('Firebase Storage unavailable, saving to profile directly.', storageErr);
        if (dataUrl.length > 900000) {
            throw new Error('Image is still too large after compression. Try a smaller photo.');
        }
        return dataUrl;
    }
}

function initProfilePhotoUpload() {
    if (!profilePhotoInput) return;

    const openPicker = () => profilePhotoInput.click();
    profilePhotoBtn?.addEventListener('click', openPicker);

    profilePhotoInput.addEventListener('change', async (e) => {
        const file = e.target.files?.[0];
        if (!file || !currentUser) return;

        if (!isValidImageFile(file)) {
            showToast("Please upload a JPG, PNG, or WebP image.", "error");
            profilePhotoInput.value = '';
            return;
        }
        if (file.size > 2 * 1024 * 1024) {
            showToast("Image must be 2 MB or smaller.", "error");
            profilePhotoInput.value = '';
            return;
        }

        profileAvatar?.classList.add('is-uploading');
        if (profilePhotoBtn) {
            profilePhotoBtn.disabled = true;
            profilePhotoBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Uploading...';
        }

        try {
            const url = await uploadProfilePhoto(file);
            await saveProfilePhotoUrl(url);
            showToast("Profile photo updated!", "success");
        } catch (err) {
            console.error("Photo upload error:", err);
            showToast(err.message || "Could not upload photo. Please try again.", "error");
        } finally {
            profileAvatar?.classList.remove('is-uploading');
            profilePhotoInput.value = '';
            if (profilePhotoBtn) {
                profilePhotoBtn.disabled = false;
                profilePhotoBtn.innerHTML = '<i class="fas fa-camera"></i> Upload Photo';
            }
        }
    });
}

// =============================================================
// 3. LOAD SERVICES
// =============================================================
async function loadServicesAndCategories() {
    if (unsubscribeServices) return;

    return new Promise((resolve, reject) => {
        let receivedFirstSnapshot = false;
        unsubscribeServices = onSnapshot(collection(db, "services"), (snap) => {
            allServices = [];
            snap.forEach(d => allServices.push({ id: d.id, ...d.data() }));

            // This listener keeps customer cards in sync with Admin → Services,
            // including newly uploaded or replaced service images.
            renderCategoryPills();
            updateCuratedSectionCopy();
            renderAtelierServices();
            renderAllServices();
            renderInsidersPick();
            updateServicesKpi();

            // The booking widget registers its controls once. Rebuilding it on
            // every admin image update would clear a customer's in-progress booking.
            if (!hasInitializedBookingWidget) {
                initBookingWidget();
                hasInitializedBookingWidget = true;
            }

            if (!receivedFirstSnapshot) {
                receivedFirstSnapshot = true;
                resolve();
            }
        }, (err) => {
            console.error("Services load error:", err);
            if (dashboardServices) {
                dashboardServices.innerHTML = emptyStateHTML('fa-spa', 'Services Unavailable', 'Please check back soon.', null);
            }
            if (!receivedFirstSnapshot) reject(err);
        });
    });
}

function renderCategoryPills() {
    const pills = document.getElementById('categoryPills');
    if (!pills) return;
    const categories = [...new Set(allServices.map(s => s.category))].filter(Boolean);
    pills.innerHTML = `<button class="category-pill active" data-cat="all">All</button>` +
        categories.map(cat => `<button class="category-pill" data-cat="${cat}">${cat}</button>`).join('');

    pills.querySelectorAll('.category-pill').forEach(btn => {
        btn.addEventListener('click', function() {
            pills.querySelectorAll('.category-pill').forEach(b => b.classList.remove('active'));
            this.classList.add('active');
            activeCategoryFilter = this.dataset.cat;
            renderAllServices();
        });
    });
}

// =============================================================
// 4. LOAD STAFF
// =============================================================
async function loadStaffMembers() {
    staffLoadError = '';
    try {
        const roles = ["Staff", "Stylist", "Receptionist", "General Staff", "Manager", "staff"];
        const q = query(collection(db, "users"), where("role", "in", roles));
        const snap = await getDocs(q);
        loadedStaffMembers = [];
        let skipped = 0;
        snap.forEach(d => {
            const data = d.data();
            if (data.deleted === true) { skipped++; return; }
            const role = (data.role || '').toLowerCase();
            if (!BOOKABLE_STAFF_ROLES.includes(role)) { skipped++; return; }
            loadedStaffMembers.push({ id: d.id, ...data });
        });
        loadedStaffMembers.sort((a, b) => (a.fullName || '').localeCompare(b.fullName || ''));
        console.info(`[client] Staff profiles loaded: ${loadedStaffMembers.length} (skipped ${skipped} non-bookable)`);
        await loadStylistSchedules();
    } catch (err) {
        loadedStaffMembers = [];
        staffLoadError = (err && err.code) ? `${err.code} — ${err.message}` : String(err || 'Unknown error');
        console.error("Staff load error:", err);
        console.info("[client] To debug: Firebase Console > Firestore > Rules > Rules playground, simulate: isSignedIn client user, list /users with where role in [...]");
        if (!staffAutoRetried) {
            staffAutoRetried = true;
            setTimeout(async () => {
                await loadStaffMembers();
                refreshStylistSelect(modalStylist, modalDate?.value, modalTime?.value,
                    getPerSessionDurationMinutes(modalServiceId?.value || '', modalVariantId?.value || modalServiceId?.value || '') || 60,
                    modalStylist?.value || '', modalServiceId?.value || '');
            }, 5000);
        }
    }
    try {
        populateModalStylists();
        populateBookingStudioStylists();
    } catch (err) {
        console.error("Staff populate error:", err);
    }
}

async function loadStylistSchedules() {
    try {
        const snap = await getDocs(collection(db, "stylistSchedules"));
        stylistSchedulesCache = {};
        const migrations = [];
        snap.forEach(d => {
            const data = d.data();
            let weeklyHours = data.weeklyHours;
            if (isLegacySundayOffSchedule(weeklyHours)) {
                weeklyHours = randomizedWeeklyHours(d.id);
                migrations.push(setDoc(doc(db, "stylistSchedules", d.id), {
                    weeklyHours,
                    updatedAt: serverTimestamp()
                }, { merge: true }));
            }
            stylistSchedulesCache[d.id] = { stylistUid: d.id, ...data, weeklyHours: weeklyHours || defaultWeeklyHours() };
        });
        if (migrations.length) {
            await Promise.all(migrations).catch(err => console.warn('Client schedule migration:', err));
        }
    } catch (err) {
        console.error('Stylist schedule load error:', err);
    }
}

function getScheduleForStylist(stylistUid) {
    if (stylistSchedulesCache[stylistUid]) return stylistSchedulesCache[stylistUid];
    return { weeklyHours: randomizedWeeklyHours(stylistUid), blocks: [] };
}

async function getStylistAvailabilityError(stylistUid, date, time, durationMins, excludeApptId = null) {
    if (!stylistUid || !date || !time) return null;
    if (await hasStylistBookingConflict(stylistUid, date, time, durationMins, excludeApptId)) {
        return 'Already booked at this time';
    }
    const schedule = getScheduleForStylist(stylistUid);
    return validateStylistSlot([], schedule, stylistUid, date, time, durationMins, excludeApptId);
}

/**
 * A stylist is qualified for a service when they have no declared specialties
 * (all-rounder) or one of their specialties matches the service category.
 */
function isStylistQualifiedForService(staff, serviceId) {
    if (!staff || !serviceId) return true;
    const specialties = staff.specialties;
    if (!Array.isArray(specialties) || specialties.length === 0) return true;
    const service = allServices.find(s => s.id === serviceId);
    if (!service) return true;
    const category = (service.category || '').trim().toLowerCase();
    if (!category) return true;
    return specialties.some(spec => (spec || '').trim().toLowerCase() === category);
}

// The picker is only a convenience layer. Immediately before a client writes
// an appointment, fetch the selected profile again so a deleted, deactivated,
// or newly unqualified staff member can never be submitted from stale UI.
async function validateSelectedStylist(stylistUid, serviceId, date, time, durationMins, excludeApptId = null) {
    if (!stylistUid) return { staffName: 'Any Available Stylist' };
    try {
        const staffSnap = await getDoc(doc(db, 'users', stylistUid));
        if (!staffSnap.exists()) return { error: 'The selected stylist is no longer available. Please choose another stylist.' };
        const staff = { id: staffSnap.id, ...staffSnap.data() };
        const role = (staff.role || '').toLowerCase();
        if (staff.deleted === true || !BOOKABLE_STAFF_ROLES.includes(role)) {
            return { error: 'The selected stylist is no longer active. Please choose another stylist.' };
        }
        if (!isStylistQualifiedForService(staff, serviceId)) {
            return { error: 'The selected stylist is not qualified for this service. Please choose another stylist.' };
        }
        const slotError = await validateBookingSlotFull(date, time, durationMins, stylistUid, excludeApptId);
        if (slotError) return { error: slotError };
        return { staffName: staff.fullName || staff.email || 'Stylist' };
    } catch (err) {
        console.error('Selected stylist validation error:', err);
        return { error: 'Could not revalidate the selected stylist. Please try again.' };
    }
}

function pickerEscapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
}

// Renders the stylist picker as selectable profile cards into the container
// referenced by the input's data-picker attribute. Cards show the stylist's
// photo, name, specialties, and a live availability state; unavailable
// stylists are shown disabled. Returns the selected stylist id.
async function refreshStylistSelect(inputEl, date, time, durationMins, preferredId = '', serviceId = '') {
    if (!inputEl) return '';
    const pickerEl = document.getElementById(inputEl.dataset?.picker);
    if (!pickerEl) return '';

    const previous = preferredId || inputEl.value || '';
    inputEl.value = '';

    if (!loadedStaffMembers.length) {
        // No staff profiles available (rules not deployed yet, denied, or
        // still loading). Never block the booking — always allow "Any
        // Available Stylist", and offer a retry that reloads + re-renders.
        pickerEl.innerHTML = `
            <div class="stylist-option selected" data-uid="">
                <span class="stylist-avatar any">✦</span>
                <span class="stylist-option-main">
                    <span class="stylist-name">Any Available Stylist</span>
                    <span class="stylist-spec">Salon will assign an available stylist qualified for this service</span>
                </span>
                <span class="stylist-state available">Available</span>
            </div>
            <p class="stylist-picker-empty">${staffLoadError
                ? `Could not load stylist profiles (${pickerEscapeHtml(staffLoadError)}). `
                : 'Stylist profiles are unavailable right now, so you can continue with Any Available Stylist. '}
                <button type="button" class="stylist-retry-btn" id="pickerRetryBtn">Retry</button>
            </p>`;
        inputEl.value = '';
        pickerEl.querySelector('.stylist-option').addEventListener('click', () => {
            pickerEl.querySelectorAll('.stylist-option').forEach(c => c.classList.remove('selected'));
            pickerEl.querySelector('.stylist-option').classList.add('selected');
            inputEl.value = '';
            if (inputEl.id === 'bookingStylistInput' && bookingWidgetState) {
                bookingWidgetState.stylistId = '';
                updateBookingPreview();
            }
        });
        const retryBtn = document.getElementById('pickerRetryBtn');
        if (retryBtn) retryBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            retryBtn.disabled = true;
            retryBtn.textContent = 'Loading…';
            await loadStaffMembers();
            refreshStylistSelect(inputEl, date, time, durationMins, previous || '', serviceId);
        });
        return '';
    }

    let html = '';
    let selectableUids = [''];
    let availableUid = null;

    for (const staff of loadedStaffMembers) {
        const qualified = isStylistQualifiedForService(staff, serviceId);
        // Qualification is an eligibility rule, not merely a visual warning:
        // clients must never be offered an unqualified stylist for selection.
        if (!qualified) continue;
        let state = 'available';
        let stateLabel = 'Available';
        if (date && time && durationMins) {
            try {
                const err = await getStylistAvailabilityError(staff.id, date, time, durationMins, reschedulingAppointmentId);
                if (err) {
                    if (err.includes('off')) { state = 'day-off'; stateLabel = 'Day off'; }
                    else if (err.includes('hours')) { state = 'outside-hours'; stateLabel = 'Outside working hours'; }
                    else if (err.includes('blocked')) { state = 'blocked'; stateLabel = 'Blocked'; }
                    else { state = 'booked'; stateLabel = 'Already booked'; }
                }
            } catch (availErr) {
                // Availability lookups must never blank the whole list — if the
                // slotBlocks/schedules read fails, show the stylist as available.
                console.warn(`[client] Availability check failed for ${staff.id}:`, availErr);
            }
        }
        if (state === 'available') {
            selectableUids.push(staff.id);
            if (staff.id === previous) availableUid = staff.id;
        }

        const initial = (staff.fullName || 'S').trim().charAt(0).toUpperCase() || 'S';
        const safePhoto = (staff.photoURL || '').replace(/["']/g, '');
        const avatar = safePhoto
            ? `<span class="stylist-avatar" style="background-image:url('${safePhoto}')"></span>`
            : `<span class="stylist-avatar">${pickerEscapeHtml(initial)}</span>`;
        const specText = (Array.isArray(staff.specialties) && staff.specialties.length)
            ? staff.specialties.join(' · ')
            : 'All-rounder · all services';

        html += `
            <div class="stylist-option ${state === 'available' ? '' : 'disabled'} ${staff.id === availableUid ? 'selected' : ''}" data-uid="${staff.id}">
                ${avatar}
                <span class="stylist-option-main">
                    <span class="stylist-name">${pickerEscapeHtml(staff.fullName || staff.email || 'Stylist')}</span>
                    <span class="stylist-spec">${pickerEscapeHtml(specText)}</span>
                </span>
                <span class="stylist-state ${state}">${stateLabel}</span>
            </div>`;
    }

    const anySelected = availableUid ? '' : 'selected';
    pickerEl.innerHTML = `
        <div class="stylist-option ${anySelected}" data-uid="">
            <span class="stylist-avatar any">✦</span>
            <span class="stylist-option-main">
                <span class="stylist-name">Any Available Stylist</span>
                <span class="stylist-spec">Salon will assign an available stylist qualified for this service</span>
            </span>
            <span class="stylist-state available">Available</span>
        </div>${html}`;
    inputEl.value = availableUid || '';

    pickerEl.querySelectorAll('.stylist-option').forEach(card => {
        card.addEventListener('click', () => {
            if (card.classList.contains('disabled')) return;
            pickerEl.querySelectorAll('.stylist-option').forEach(c => c.classList.remove('selected'));
            card.classList.add('selected');
            inputEl.value = card.dataset.uid || '';
            if (inputEl.id === 'bookingStylistInput' && bookingWidgetState) {
                bookingWidgetState.stylistId = inputEl.value || '';
                updateBookingPreview();
            }
        });
    });

    if (previous && !selectableUids.includes(previous)) {
        showToast('Your selected stylist is not available for the new schedule. Please choose another.', 'info');
    }

    return inputEl.value;
}

function populateModalStylists() {
    if (!modalStylist) return;
    const date = modalDate?.value;
    const time = modalTime?.value;
    const durationMins = modalServiceId?.value
        ? getPerSessionDurationMinutes(modalServiceId.value, modalVariantId?.value || modalServiceId.value)
        : 60;
    const preferred = bookingWidgetState?.stylistId
        || currentUserProfile?.preferredStylistId
        || modalStylist.value
        || '';
    refreshStylistSelect(modalStylist, date, time, durationMins, preferred, modalServiceId.value);

}

function populateBookingStudioStylists() {
    const selectEl = document.getElementById('bookingStylistInput');
    if (!selectEl) return;
    const date = document.getElementById('bookingDateInput')?.value || bookingWidgetState?.date;
    const time = document.getElementById('bookingTimeInput')?.value || bookingWidgetState?.time;
    const durationMins = bookingWidgetState?.durationMinutes || 60;
    const preferred = bookingWidgetState?.stylistId || currentUserProfile?.preferredStylistId || '';
    const serviceId = bookingWidgetState?.selectedVariantId || bookingWidgetState?.selectedServiceId || '';
    refreshStylistSelect(selectEl, date, time, durationMins, preferred, serviceId).then(value => {
        if (bookingWidgetState) bookingWidgetState.stylistId = value || '';
    });
}

function updateServicesKpi() {
    const el = document.getElementById('kpiServicesCount');
    if (el) el.textContent = getBaseServices().length;
}

// =============================================================
// 5. RENDER DASHBOARD SERVICES
// =============================================================
function legacyRenderAtelierServices() {
    const container = document.getElementById('dashboardServices');
    if (!container) return;

    const services = getBaseServices();

    if (services.length === 0) {
        container.innerHTML = emptyStateHTML('fa-spa', 'No Services Yet', 'Our menu is being curated. Check back soon!', null);
        return;
    }

    const groups = services.reduce((result, service) => {
        const category = service.category || 'Other Services';
        (result[category] ||= []).push(service);
        return result;
    }, {});

    container.innerHTML = Object.entries(groups).map(([category, categoryServices]) => `
        <section class="dashboard-service-category">
            <h3><i class="fas ${getCategoryIcon(category)}" aria-hidden="true"></i>${escapeServiceHtml(category)}</h3>
            <div class="service-cards-grid">
                ${categoryServices.map((service, index) => {
                    const image = getServiceImageData(service);
                    const serviceName = service.serviceName || 'Treatment';
                    return `<button type="button" class="service-card ${CARD_STYLES[index % CARD_STYLES.length]}" data-id="${escapeServiceHtml(service.id)}">
                        <div class="service-card-image-wrap">
                            <img class="service-card-image" src="${escapeServiceHtml(image.source)}" data-fallback="${escapeServiceHtml(image.fallback)}" alt="${escapeServiceHtml(serviceName)} service" loading="lazy" />
                        </div>
                        <div class="service-card-content">
                            <span class="card-badge">${escapeServiceHtml(service.category || 'Treatment')}</span>
                            <div class="card-title">${escapeServiceHtml(serviceName)}</div>
                            ${service.description ? `<p class="card-desc">${escapeServiceHtml(service.description)}</p>` : ''}
                            <div class="card-body">
                                <div class="card-info">
                                    <div class="card-price">${formatPrice(service.price)}</div>
                                    ${service.duration ? `<div class="card-duration">${escapeServiceHtml(service.duration)}</div>` : ''}
                                </div>
                                <div class="card-action"><span>Book Appointment</span><i class="fas fa-arrow-right" aria-hidden="true"></i></div>
                            </div>
                        </div>
                    </button>`;
                }).join('')}
            </div>
        </section>
    `).join('');

    container.querySelectorAll('.service-card').forEach(card => {
        card.addEventListener('click', function() {
            const service = allServices.find(s => s.id === this.dataset.id);
            if (service) openBookingModal(service);
        });
    });

    container.querySelectorAll('.service-card-image').forEach(image => {
        image.addEventListener('error', () => {
            if (image.dataset.fallbackApplied === 'true') {
                image.parentElement?.classList.add('is-fallback-unavailable');
                return;
            }
            image.dataset.fallbackApplied = 'true';
            image.src = image.dataset.fallback;
        });
    });
}

function overviewServiceImageMarkup(service, className = 'service-card-image-wrap') {
    const image = getServiceImageData(service);
    const name = service.serviceName || 'Treatment';
    return `<div class="${className}"><img class="service-card-image" src="${escapeServiceHtml(image.source)}" data-fallback="${escapeServiceHtml(image.fallback)}" alt="${escapeServiceHtml(name)} service" loading="lazy" /></div>`;
}

function bindOverviewServiceCards(container) {
    container.querySelectorAll('.service-card').forEach(card => {
        card.addEventListener('click', function() {
            const service = allServices.find(item => item.id === this.dataset.id);
            if (service) openBookingModal(service);
        });
    });

    container.querySelectorAll('.service-card-image').forEach(image => {
        image.addEventListener('error', () => {
            if (image.dataset.fallbackApplied === 'true') {
                image.parentElement?.classList.add('is-fallback-unavailable');
                return;
            }
            image.dataset.fallbackApplied = 'true';
            image.src = image.dataset.fallback;
        });
    });
}

function renderOverviewCategoryFilters() {
    const filterContainer = document.getElementById('overviewCategoryFilters');
    if (!filterContainer) return;
    const categories = [...new Set(getBaseServices().map(service => service.category).filter(Boolean))];
    filterContainer.innerHTML = `<button type="button" class="overview-category-filter ${overviewServiceCategoryFilter === 'all' ? 'active' : ''}" data-category="all">All Services</button>` +
        categories.map(category => `<button type="button" class="overview-category-filter ${overviewServiceCategoryFilter === category ? 'active' : ''}" data-category="${escapeServiceHtml(category)}">${escapeServiceHtml(category)}</button>`).join('');

    filterContainer.querySelectorAll('.overview-category-filter').forEach(button => {
        button.addEventListener('click', () => {
            overviewServiceCategoryFilter = button.dataset.category;
            renderAtelierServices();
        });
    });
}

// ─── Overview gallery: per-category pagination ───
// Categories with fewer than 10 services render in full. Categories with
// 10+ services paginate 8 per page (4 × 2 on desktop). Page state is kept
// per category, so paging one category never moves another category.
const OVERVIEW_SERVICES_PER_PAGE = 8;
const OVERVIEW_PAGINATION_THRESHOLD = 10;
const overviewCategoryPages = {};

function renderOverviewCategoryPagination(category, totalPages, currentPage) {
    if (totalPages <= 1) return '';
    const label = escapeServiceHtml(category);
    let buttons = `<button type="button" class="category-page-btn" data-page="prev" aria-label="Previous ${label} services page"${currentPage <= 1 ? ' disabled' : ''}>&lsaquo;<span class="page-btn-text"> Previous</span></button>`;
    for (let page = 1; page <= totalPages; page++) {
        const active = page === currentPage;
        buttons += `<button type="button" class="category-page-btn${active ? ' active' : ''}" data-page="${page}" aria-label="Go to page ${page} of ${label} services"${active ? ' aria-current="page"' : ''}>${page}</button>`;
    }
    buttons += `<button type="button" class="category-page-btn" data-page="next" aria-label="Next ${label} services page"${currentPage >= totalPages ? ' disabled' : ''}><span class="page-btn-text">Next </span>&rsaquo;</button>`;
    return `<nav class="category-pagination" aria-label="${label} services pagination">${buttons}</nav>`;
}

function renderAtelierServices() {
    const container = document.getElementById('dashboardServices');
    if (!container) return;

    const queryText = overviewServiceSearchQuery.toLowerCase();
    const services = getBaseServices().filter(service => {
        const matchesSearch = !queryText || serviceSearchText(service).includes(queryText);
        const matchesCategory = overviewServiceCategoryFilter === 'all' || service.category === overviewServiceCategoryFilter;
        return matchesSearch && matchesCategory;
    });
    renderOverviewCategoryFilters();
    if (!services.length) {
        container.innerHTML = emptyStateHTML('fa-search', 'No Matching Services', 'Try a different service or category.', null);
        return;
    }

    const groups = services.reduce((result, service) => {
        const category = service.category || 'Other Services';
        (result[category] ||= []).push(service);
        return result;
    }, {});

    container.classList.toggle('is-list-view', overviewServicesViewMode === 'list');
    container.innerHTML = Object.entries(groups).map(([category, categoryServices]) => {
        // Client-side pagination from the already-loaded array — no extra
        // Firestore reads per page click.
        const totalInCategory = categoryServices.length;
        const totalPages = totalInCategory >= OVERVIEW_PAGINATION_THRESHOLD
            ? Math.ceil(totalInCategory / OVERVIEW_SERVICES_PER_PAGE)
            : 1;
        let currentPage = overviewCategoryPages[category] || 1;
        if (currentPage > totalPages) currentPage = totalPages; // services removed → clamp back
        if (currentPage < 1) currentPage = 1;
        overviewCategoryPages[category] = currentPage;
        const startIndex = (currentPage - 1) * OVERVIEW_SERVICES_PER_PAGE;
        const visibleServices = totalPages > 1
            ? categoryServices.slice(startIndex, startIndex + OVERVIEW_SERVICES_PER_PAGE)
            : categoryServices;
        const servicesMarkup = overviewServicesViewMode === 'list'
            ? `<div class="overview-service-list">
                <div class="overview-service-list-header"><span>Service</span><span>Category</span><span>Price</span><span>Duration</span><span></span></div>
                ${visibleServices.map(service => {
                const name = service.serviceName || 'Treatment';
                return `<button type="button" class="service-card overview-service-list-card" data-id="${escapeServiceHtml(service.id)}">
                    <span class="overview-service-list-main"><span class="card-title">${escapeServiceHtml(name)}</span></span>
                    <span class="overview-service-list-category">${escapeServiceHtml(service.category || 'Treatment')}</span>
                    <span class="overview-service-list-price">${formatPrice(service.price)}</span>
                    <span class="overview-service-list-duration">${service.duration ? escapeServiceHtml(service.duration) : ''}</span>
                    <span class="overview-service-book-now">Book Now <i class="fas fa-arrow-right" aria-hidden="true"></i></span>
                </button>`;
            }).join('')}</div>`
            : `<div class="service-cards-grid">${visibleServices.map((service, index) => {
                const serviceName = service.serviceName || 'Treatment';
                return `<button type="button" class="service-card ${CARD_STYLES[index % CARD_STYLES.length]}" data-id="${escapeServiceHtml(service.id)}">
                    ${overviewServiceImageMarkup(service)}
                    <div class="service-card-content">
                        <span class="card-badge">${escapeServiceHtml(service.category || 'Treatment')}</span>
                        <div class="card-title">${escapeServiceHtml(serviceName)}</div>
                        ${service.description ? `<p class="card-desc">${escapeServiceHtml(service.description)}</p>` : ''}
                        <div class="card-body"><div class="card-info"><div class="card-price">${formatPrice(service.price)}</div>${service.duration ? `<div class="card-duration">${escapeServiceHtml(service.duration)}</div>` : ''}</div><div class="card-action"><span>Book Appointment</span><i class="fas fa-arrow-right" aria-hidden="true"></i></div></div>
                    </div>
                </button>`;
            }).join('')}</div>`;
        const countMarkup = `<span class="dashboard-service-count">${totalInCategory} Service${totalInCategory === 1 ? '' : 's'}</span>`;
        const paginationMarkup = renderOverviewCategoryPagination(category, totalPages, currentPage);
        return `<section class="dashboard-service-category" data-category="${escapeServiceHtml(category)}"><h3><i class="fas ${getCategoryIcon(category)}" aria-hidden="true"></i>${escapeServiceHtml(category)}${countMarkup}</h3>${servicesMarkup}${paginationMarkup}</section>`;
    }).join('');

    bindOverviewServiceCards(container);

    // Pagination controls are freshly created nodes on every render, so
    // listeners attach here without ever duplicating (same pattern the
    // cards already use). Book Appointment keeps working because cards
    // are re-bound above after every render.
    container.querySelectorAll('.dashboard-service-category').forEach(section => {
        const category = section.dataset.category;
        section.querySelectorAll('.category-pagination button[data-page]').forEach(button => {
            button.addEventListener('click', () => {
                const items = groups[category] || [];
                const pages = items.length >= OVERVIEW_PAGINATION_THRESHOLD
                    ? Math.ceil(items.length / OVERVIEW_SERVICES_PER_PAGE)
                    : 1;
                const current = overviewCategoryPages[category] || 1;
                const target = button.dataset.page === 'prev' ? current - 1
                    : button.dataset.page === 'next' ? current + 1
                        : parseInt(button.dataset.page, 10);
                if (!Number.isFinite(target)) return;
                const next = Math.min(Math.max(target, 1), pages);
                if (next === current) return;
                overviewCategoryPages[category] = next;
                renderAtelierServices();
                // Smoothly return the viewport to THIS category's heading —
                // never to the top of the page.
                const grid = document.getElementById('dashboardServices');
                const sectionEl = grid
                    ? Array.from(grid.querySelectorAll('.dashboard-service-category')).find(sec => sec.dataset.category === category)
                    : null;
                sectionEl?.scrollIntoView({ behavior: 'smooth', block: 'start' });
            });
        });
    });
}

// =============================================================
// 6. RENDER ALL SERVICES
// =============================================================
function renderAllServices() {
    if (!servicesContainer) return;
    const filtered = getFilteredServices();

    if (filtered.length === 0) {
        servicesContainer.innerHTML = emptyStateHTML(
            'fa-search', 'No Results Found',
            'Try adjusting your search or category filter.',
            'View All Services', 'clearFilters'
        );
        bindEmptyActions();
        return;
    }

    if (servicesViewMode === 'grid') {
        servicesContainer.innerHTML = `<div class="services-grid-view">${filtered.map((s, i) => `
            <div class="catalog-card" data-id="${s.id}">
                <div class="catalog-card-accent ${ACCENT_CLASSES[i % ACCENT_CLASSES.length]}"></div>
                <div class="catalog-card-body">
                    <span class="cat-label">${s.category || 'Treatment'}</span>
                    <h4>${s.serviceName || 'Service'}</h4>
                    <p class="desc">${s.description || `A luxurious ${(s.category || 'beauty').toLowerCase()} experience tailored for you.`}</p>
                    <div class="catalog-card-footer">
                        <span class="price">${formatPrice(s.price)}</span>
                        <span class="book-link">Book <i class="fas fa-arrow-right"></i></span>
                    </div>
                </div>
            </div>
        `).join('')}</div>`;
    } else {
        const categories = [...new Set(filtered.map(s => s.category))].filter(Boolean);
        servicesContainer.innerHTML = categories.map(cat => {
            const items = filtered.filter(s => s.category === cat);
            return `
                <div class="category-section">
                    <div class="category-header" data-category="${cat}">
                        <span><i class="fas ${getCategoryIcon(cat)}" style="margin-right:10px; color:var(--gold);"></i>${cat} <span style="font-size:0.72rem; color:var(--text-muted); font-family:var(--font-sans); font-weight:400;">(${items.length})</span></span>
                        <i class="fas fa-chevron-down"></i>
                    </div>
                    <div class="category-body open" data-category="${cat}">
                        ${items.map(s => `
                            <div class="service-list-item" data-id="${s.id}">
                                <div class="service-icon-wrap"><i class="fas ${getCategoryIcon(cat)}"></i></div>
                                <div class="service-info">
                                    <div class="name">${s.serviceName || 'Service'}</div>
                                    <div class="meta">${s.duration || '60 min'} · ${s.category || ''}</div>
                                </div>
                                <span class="service-price-tag">${formatPrice(s.price)}</span>
                                <i class="fas fa-chevron-right chevron"></i>
                            </div>
                        `).join('')}
                    </div>
                </div>`;
        }).join('');

        document.querySelectorAll('.category-header').forEach(header => {
            header.addEventListener('click', function() {
                const cat = this.dataset.category;
                const body = document.querySelector(`.category-body[data-category="${cat}"]`);
                this.classList.toggle('open');
                body.classList.toggle('open');
            });
        });
    }

    servicesContainer.querySelectorAll('[data-id]').forEach(el => {
        el.addEventListener('click', function() {
            const service = allServices.find(s => s.id === this.dataset.id);
            if (service) openBookingModal(service);
        });
    });
}

function bindEmptyActions() {
    document.querySelectorAll('.empty-action-btn').forEach(btn => {
        btn.addEventListener('click', function() {
            if (this.dataset.action === 'clearFilters') {
                activeCategoryFilter = 'all';
                serviceSearchQuery = '';
                const searchInput = document.getElementById('serviceSearchInput');
                if (searchInput) searchInput.value = '';
                document.querySelectorAll('.category-pill').forEach(b => {
                    b.classList.toggle('active', b.dataset.cat === 'all');
                });
                renderAllServices();
            } else if (this.dataset.action === 'book') {
                switchTab('tabBooking');
                openBookingStudio();
            }
        });
    });
}

// =============================================================
// 7. RENDER INSIDER'S PICK
// =============================================================
function renderInsidersPick() {
    const recommended = getRecommendedServices(5);
    const curatedIds = new Set(getRecommendedServices(3).map(s => s.id));
    const featured = recommended.find(s => !curatedIds.has(s.id)) || recommended[0] || null;
    const profile = currentUserProfile || {};

    if (!featured) {
        pickServiceName.textContent = "Featured Service";
        pickDesc.textContent = "Check back soon for our studio's recommendation.";
        pickBookBtn.disabled = true;
        return;
    }

    pickServiceName.textContent = featured.serviceName || "Signature Treatment";
    pickDesc.textContent = insidersPickReason(featured, profile);
    pickBookBtn.disabled = false;
    pickBookBtn.onclick = () => openBookingModal(featured);
}

// =============================================================
// 8. STATS (no loyalty)
// =============================================================
function updateClientStats(active, history) {
    const completed = history.filter(h => ['COMPLETED', 'SERVED'].includes((h.status || '').toUpperCase()));

    const kpiUpcoming = document.getElementById('kpiUpcoming');
    const kpiCompleted = document.getElementById('kpiCompleted');
    const profileStatVisits = document.getElementById('profileStatVisits');

    if (kpiUpcoming) kpiUpcoming.textContent = active.length;
    if (kpiCompleted) kpiCompleted.textContent = completed.length;
    if (profileStatVisits) profileStatVisits.textContent = completed.length;
}

// =============================================================
// 9. APPOINTMENTS & NEXT VISIT
// =============================================================
function listenToClientAppointments(clientId) {
    const q = query(collection(db, "appointments"), where("clientId", "==", clientId));
    onSnapshot(q, (snapshot) => {
        const active = [];
        const history = [];
        snapshot.forEach(d => {
            const a = { id: d.id, ...d.data() };
            const status = (a.status || "Pending").trim();
            if (["COMPLETED", "CANCELLED", "DECLINED", "SERVED", "DENIED", "NO SHOW", "NO-SHOW"].includes(status.toUpperCase())) {
                history.push(a);
            } else {
                active.push(a);
            }
        });
        activeAppointments = active;
        historyAppointments = history;

        if (!calendarAutoFocused && active.length > 0) {
            const upcoming = [...active]
                .filter(a => isActiveBookingStatus(a.status))
                .sort((a, b) => new Date(`${a.bookingDate}T${a.bookingTime}`) - new Date(`${b.bookingDate}T${b.bookingTime}`))[0];
            if (upcoming) {
                calendarViewDate = new Date((upcoming.bookingDate || upcoming.date) + 'T00:00:00');
                calendarSelectedDate = upcoming.bookingDate || upcoming.date;
                calendarAutoFocused = true;
            }
        }

        renderBookings(active);
        renderHistory(history);
        renderNextVisit(active);
        updateClientStats(active, history);
        renderSalonCalendar();

        if (bookingBadge) {
            bookingBadge.textContent = active.length;
            bookingBadge.classList.toggle('show', active.length > 0);
        }
        if (bookingCountBadge) bookingCountBadge.textContent = active.length;

        const servedAppt = history.find(a =>
            a.status && a.status.toUpperCase() === 'SERVED' &&
            (!a.feedback || !a.feedback.rating)
        );
        if (servedAppt && !sessionStorage.getItem(`feedback_shown_${servedAppt.id}`)) {
            sessionStorage.setItem(`feedback_shown_${servedAppt.id}`, 'true');
            setTimeout(() => openFeedbackModal(servedAppt.id, servedAppt.serviceName), 800);
        }
    }, (err) => console.error("Appointments sync error:", err));
}

function renderNextVisit(active) {
    const today = new Date();
    const monthEl = document.querySelector('.date-box .month');
    const dayEl = document.querySelector('.date-box .day');
    const weekdayEl = document.querySelector('.date-box .weekday');

    if (active.length === 0) {
        nextServiceName.textContent = "No upcoming visits";
        nextStylist.textContent = "Book a treatment to get started.";
        nextTime.textContent = "—";
        nextPrice.textContent = "—";
        nextStatusBadge.textContent = "AVAILABLE";
        nextStatusBadge.className = 'badge-confirmed';
        nextCancelBtn.style.display = "none";
        nextReschedBtn.style.display = "none";
        if (monthEl) monthEl.textContent = today.toLocaleString('en-US', { month: 'short' }).toUpperCase();
        if (dayEl) dayEl.textContent = today.getDate();
        if (weekdayEl) weekdayEl.textContent = today.toLocaleString('en-US', { weekday: 'short' }).toUpperCase();
        return;
    }

    const sorted = active.sort((a, b) => new Date(`${a.bookingDate}T${a.bookingTime}`) - new Date(`${b.bookingDate}T${b.bookingTime}`));
    const next = sorted[0];
    const dateObj = new Date(next.bookingDate + 'T00:00:00');

    if (monthEl) monthEl.textContent = dateObj.toLocaleString('en-US', { month: 'short' }).toUpperCase();
    if (dayEl) dayEl.textContent = dateObj.getDate();
    if (weekdayEl) weekdayEl.textContent = dateObj.toLocaleString('en-US', { weekday: 'short' }).toUpperCase();

    nextServiceName.textContent = next.serviceName || 'Treatment';
    nextStylist.textContent = `with ${next.staffName || 'Your Stylist'} · K-Beauty Salon`;
    const nextDurMins = getDurationMinutesFromAppt(next);
    nextTime.textContent = next.bookingTime
        ? formatTimeRange(next.bookingTime, nextDurMins)
        : '';
    nextPrice.textContent = formatPrice(next.price);
    nextStatusBadge.textContent = next.status.toUpperCase();
    nextStatusBadge.className = `badge-confirmed status-${statusClass(next.status)}`;

    const isPending = next.status === 'Pending';
    nextCancelBtn.style.display = 'inline-block';
    nextCancelBtn.dataset.id = next.id;
    nextReschedBtn.style.display = isPending ? 'inline-block' : 'none';
    nextReschedBtn.dataset.id = next.id;

    if (next.status === 'Cancellation Requested') {
        nextCancelBtn.style.display = 'none';
        nextReschedBtn.style.display = 'none';
    }
}

function toLocalDateKey(dateObj) {
    const y = dateObj.getFullYear();
    const m = String(dateObj.getMonth() + 1).padStart(2, '0');
    const d = String(dateObj.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

function isPastDateKey(dateKey) {
    return isPastBookingDate(dateKey);
}

function prefillBookingStudioDate(dateKey) {
    const dateInput = document.getElementById('bookingDateInput');
    if (!dateInput || !dateKey) return;
    dateInput.value = dateKey;
    if (bookingWidgetState) {
        bookingWidgetState.date = dateKey;
        updateBookingPreview();
        showBookingStudioStep(bookingWidgetState.selectedServiceId ? bookingStudioStep : 1);
    }
}

function startBookingFromCalendar(dateKey) {
    if (isPastDateKey(dateKey)) {
        showToast('Please pick today or a future date to book.', 'error');
        return;
    }
    selectCalendarDate(dateKey);
    switchTab('tabBooking');
    prefillBookingStudioDate(dateKey);
    openBookingStudio();
}

function selectCalendarDate(dateKey) {
    calendarSelectedDate = dateKey;
    renderCalDayPanel(dateKey);
    document.querySelectorAll('.cal-cell').forEach(c => {
        c.classList.toggle('selected', c.dataset.date === dateKey);
    });
}

function renderCalDayPanel(dateKey) {
    const titleEl = document.getElementById('calDayTitle');
    const eventsEl = document.getElementById('calDayEvents');
    if (!titleEl || !eventsEl) return;

    if (!dateKey) {
        titleEl.textContent = 'Pick a date';
        eventsEl.innerHTML = '<p class="cal-day-empty">Tap a date on the calendar to view or book</p>';
        return;
    }

    const dateObj = new Date(dateKey + 'T00:00:00');
    titleEl.textContent = dateObj.toLocaleDateString('en-US', {
        weekday: 'long', month: 'long', day: 'numeric', year: 'numeric'
    });

    const dayAppts = activeAppointments
        .filter(a => (a.bookingDate || a.date) === dateKey && isActiveBookingStatus(a.status))
        .sort((a, b) => timeToMinutes(a.bookingTime || a.time) - timeToMinutes(b.bookingTime || b.time));

    const canBook = !isPastDateKey(dateKey);
    const bookBtnHtml = canBook
        ? `<button type="button" class="btn-reserve cal-book-day-btn" data-date="${dateKey}">Book on this day</button>`
        : '';

    if (!dayAppts.length) {
        eventsEl.innerHTML = `
            <p class="cal-day-empty">${canBook ? 'No appointments yet — reserve a visit for this day.' : 'No appointments on this day.'}</p>
            ${bookBtnHtml}`;
        eventsEl.querySelector('.cal-book-day-btn')?.addEventListener('click', () => startBookingFromCalendar(dateKey));
        return;
    }

    eventsEl.innerHTML = dayAppts.map(appt => {
        const durMins = getDurationMinutesFromAppt(appt);
        const durationLabel = getPerSessionDurationLabel(appt.serviceId, appt.variantId);
        const timeRange = formatTimeRange(appt.bookingTime || appt.time, durMins);
        return `
            <div class="cal-timeline-item">
                <div class="cal-timeline-time">
                    <span class="start">${timeRange}</span>
                    <span class="dur">${durationLabel}</span>
                </div>
                <div class="cal-timeline-body">
                    <h5>${appt.serviceName || 'Treatment'}</h5>
                    <p>${appt.staffName || 'Any Stylist'} · ${appt.status} · ${formatPrice(appt.price)}</p>
                </div>
            </div>`;
    }).join('') + bookBtnHtml;

    eventsEl.querySelector('.cal-book-day-btn')?.addEventListener('click', () => startBookingFromCalendar(dateKey));
}

function renderSalonCalendar() {
    const grid = document.getElementById('calGrid');
    const monthLabel = document.getElementById('calMonthLabel');
    if (!grid || !monthLabel) return;

    const year = calendarViewDate.getFullYear();
    const month = calendarViewDate.getMonth();
    monthLabel.textContent = calendarViewDate.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

    const firstDay = new Date(year, month, 1);
    const startOffset = firstDay.getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const daysInPrevMonth = new Date(year, month, 0).getDate();
    const todayKey = toLocalDateKey(new Date());

    const apptsByDate = {};
    activeAppointments.forEach(appt => {
        if (!isActiveBookingStatus(appt.status)) return;
        const key = appt.bookingDate || appt.date;
        if (!key) return;
        if (!apptsByDate[key]) apptsByDate[key] = [];
        apptsByDate[key].push(appt);
    });

    let cells = '';
    for (let i = 0; i < 42; i++) {
        let dayNum, cellMonth = month, cellYear = year, otherMonth = false;

        if (i < startOffset) {
            dayNum = daysInPrevMonth - startOffset + i + 1;
            cellMonth = month - 1;
            if (cellMonth < 0) { cellMonth = 11; cellYear = year - 1; }
            otherMonth = true;
        } else if (i >= startOffset + daysInMonth) {
            dayNum = i - startOffset - daysInMonth + 1;
            cellMonth = month + 1;
            if (cellMonth > 11) { cellMonth = 0; cellYear = year + 1; }
            otherMonth = true;
        } else {
            dayNum = i - startOffset + 1;
        }

        const dateKey = `${cellYear}-${String(cellMonth + 1).padStart(2, '0')}-${String(dayNum).padStart(2, '0')}`;
        const dayAppts = (apptsByDate[dateKey] || []).sort((a, b) =>
            timeToMinutes(a.bookingTime || a.time) - timeToMinutes(b.bookingTime || b.time)
        );
        const hasEvents = dayAppts.length > 0;
        const isToday = dateKey === todayKey;
        const isSelected = dateKey === calendarSelectedDate;
        const isBookable = !otherMonth && !isPastDateKey(dateKey);

        let chips = '';
        if (hasEvents) {
            chips = dayAppts.slice(0, 2).map(appt => {
                const durMins = getDurationMinutesFromAppt(appt);
                const timeRange = formatTimeRange(appt.bookingTime || appt.time, durMins);
                return `<div class="cal-event-chip">${timeRange}</div>`;
            }).join('');
            if (dayAppts.length > 2) {
                chips += `<div class="cal-more-label">+${dayAppts.length - 2} more</div>`;
            }
        }

        cells += `
            <div class="cal-cell ${otherMonth ? 'other-month' : ''} ${isToday ? 'today' : ''} ${hasEvents ? 'has-events' : ''} ${isBookable ? 'bookable' : ''} ${isSelected ? 'selected' : ''}"
                 data-date="${dateKey}" ${!otherMonth ? 'tabindex="0" role="button"' : ''}>
                <span class="cal-day-num">${dayNum}</span>
                ${chips}
            </div>`;
    }

    grid.innerHTML = cells;

    grid.querySelectorAll('.cal-cell:not(.other-month)').forEach(cell => {
        cell.addEventListener('click', () => {
            const dateKey = cell.dataset.date;
            const hasAppts = activeAppointments.some(a =>
                (a.bookingDate || a.date) === dateKey && isActiveBookingStatus(a.status)
            );
            if (!isPastDateKey(dateKey) && !hasAppts) {
                startBookingFromCalendar(dateKey);
                return;
            }
            selectCalendarDate(dateKey);
        });
    });

    if (calendarSelectedDate) {
        renderCalDayPanel(calendarSelectedDate);
    } else {
        const nextAppt = [...activeAppointments]
            .filter(a => isActiveBookingStatus(a.status))
            .sort((a, b) => new Date(`${a.bookingDate}T${a.bookingTime}`) - new Date(`${b.bookingDate}T${b.bookingTime}`))[0];
        if (nextAppt) {
            calendarSelectedDate = nextAppt.bookingDate || nextAppt.date;
            renderCalDayPanel(calendarSelectedDate);
        } else {
            renderCalDayPanel(null);
        }
    }
}

function initSalonCalendar() {
    document.getElementById('calPrevBtn')?.addEventListener('click', () => {
        calendarViewDate.setMonth(calendarViewDate.getMonth() - 1);
        renderSalonCalendar();
    });
    document.getElementById('calNextBtn')?.addEventListener('click', () => {
        calendarViewDate.setMonth(calendarViewDate.getMonth() + 1);
        renderSalonCalendar();
    });
}

function bookingPaymentNote(appt) {
    const method = (appt.reservationPaymentMethod || '').toLowerCase();
    if (method === 'cash') {
        return `<div class="pass-note"><i class="fas fa-money-bill-wave"></i> Reservation fee (${formatPrice(appt.reservationFeePaid)}) is payable in cash at your visit.</div>`;
    }
    const status = (appt.reservationPaymentStatus || '').toLowerCase();
    if (status === 'awaiting-verification') {
        // The provider name is a snapshot taken at booking time, so it keeps
        // showing even if the admin later renames or deletes that QR option.
        const provider = appt.reservationPaymentProviderName
            ? ` via ${escapeQrProviderHtml(appt.reservationPaymentProviderName)}`
            : '';
        return `<div class="pass-note"><i class="fas fa-hourglass-half"></i> Reservation fee (${formatPrice(appt.reservationFeePaid)}) received${provider} — payment verification pending.</div>`;
    }
    return '';
}

function renderBookings(active) {
    if (!bookingList) return;

    if (active.length === 0) {
        bookingList.innerHTML = emptyStateHTML(
            'fa-ticket', 'No Upcoming Visits',
            'Your salon pass collection is empty — book your next ritual.',
            'Book Now', 'book'
        );
        bindEmptyActions();
        return;
    }

    const sorted = [...active].sort((a, b) =>
        new Date(`${a.bookingDate}T${a.bookingTime}`) - new Date(`${b.bookingDate}T${b.bookingTime}`)
    );

    bookingList.innerHTML = sorted.map(b => {
        const isPending = b.status === 'Pending';
        const isConfirmed = b.status === 'Confirmed';
        const isCancellationRequested = b.status === 'Cancellation Requested';
        const canCancel = !isCancellationRequested && (isPending || isConfirmed);
        const serviceData = allServices.find(s => s.id === b.serviceId);
        const durMins = b.durationMinutes || getPerSessionDurationMinutes(b.serviceId, b.variantId);
        const durationLabel = getPerSessionDurationLabel(b.serviceId, b.variantId);
        const timeRange = formatTimeRange(b.bookingTime || b.time, durMins);
        const passDate = formatPassDate(b.bookingDate || b.date);

        return `
            <article class="salon-pass-card">
                <div class="pass-date-ribbon">
                    <span class="pass-month">${passDate.month}</span>
                    <span class="pass-day">${passDate.day}</span>
                </div>
                <div class="pass-body">
                    <div class="pass-top">
                        <h4>${b.serviceName || 'Treatment'}</h4>
                        <span class="status-badge ${statusClass(b.status)}">${b.status}</span>
                    </div>
                    <div class="pass-meta-row">
                        <span><i class="far fa-clock"></i> ${timeRange}</span>
                        <span><i class="fas fa-hourglass-half"></i> ${durationLabel}</span>
                        <span><i class="fas fa-user"></i> ${b.staffName || 'Any Stylist'}</span>
                        <span><i class="fas fa-tag"></i> ${formatPrice(b.price)}</span>
                    </div>
                    ${bookingPaymentNote(b)}
                    ${b.note ? `<div class="pass-note"><i class="fas fa-comment"></i> ${b.note}</div>` : ''}
                </div>
                <div class="pass-actions">
                    ${isPending ? `<button class="btn-sm-action outline btn-resched" data-id="${b.id}">Reschedule</button>` : ''}
                    ${canCancel ? `<button class="btn-sm-action danger btn-cancel-appt" data-id="${b.id}">Cancel</button>` : ''}
                    ${isCancellationRequested ? `<span class="pending-note"><i class="fas fa-hourglass-half"></i> Pending approval</span>` : ''}
                </div>
            </article>`;
    }).join('');

    bookingList.querySelectorAll('.btn-cancel-appt').forEach(btn => {
        btn.addEventListener('click', function() {
            selectedAppointmentIdToCancel = this.dataset.id;
            document.getElementById('cancel-reason-modal').classList.add('active');
        });
    });
    bookingList.querySelectorAll('.btn-resched').forEach(btn => {
        btn.addEventListener('click', function() { openBookingModal(null, this.dataset.id); });
    });
}

function renderHistory(historyItems) {
    if (!historyList) return;

    const sorted = [...historyItems].sort((a, b) =>
        new Date(`${b.bookingDate}T${b.bookingTime}`) - new Date(`${a.bookingDate}T${a.bookingTime}`)
    );

    if (sorted.length === 0) {
        historyList.innerHTML = emptyStateHTML(
            'fa-clock-rotate-left', 'No History Yet',
            'Your beauty journey starts with your first visit.',
            'Book Now', 'book'
        );
        bindEmptyActions();
        return;
    }

    historyList.innerHTML = sorted.map(h => {
        const hasFeedback = h.feedback && h.feedback.rating;
        const isPast = ['COMPLETED', 'SERVED'].includes((h.status || '').toUpperCase());
        return `
            <div class="history-card ${isPast ? '' : 'past'}">
                <div class="appointment-card-header" style="padding:0 0 12px;">
                    <span class="service-name">${h.serviceName || 'Treatment'}</span>
                    <span class="status-badge ${statusClass(h.status)}">${h.status}</span>
                </div>
                <div class="appointment-card-body" style="padding:0; grid-template-columns:1fr 1fr;">
                    <div class="appointment-meta"><i class="fas fa-user"></i> ${h.staffName || 'Stylist'}</div>
                    <div class="appointment-meta"><i class="fas fa-calendar"></i> ${h.bookingDate || h.date}</div>
                    <div class="appointment-meta"><i class="far fa-clock"></i> ${h.bookingTime || h.time}</div>
                    <div class="appointment-meta"><i class="fas fa-tag"></i> ${formatPrice(h.price)}</div>
                </div>
                ${h.denialReason ? `<p class="pass-note" style="margin-top:10px;color:#b02a37;"><i class="fas fa-circle-info"></i> Denied: ${h.denialReason}</p>` : ''}
                ${h.feedback ? `<div class="appointment-meta" style="margin-top:10px;"><i class="fas fa-star" style="color:var(--gold);"></i> ${h.feedback.rating}/5 ${h.feedback.comment ? `— "${h.feedback.comment}"` : ''}</div>` : ''}
                ${(h.status === 'Served' && !hasFeedback) ? `
                    <div style="margin-top:12px;">
                        <button class="btn-sm-action gold feedback-btn" data-id="${h.id}"><i class="fas fa-star"></i> Rate Visit</button>
                    </div>` : ''}
            </div>`;
    }).join('');

    historyList.querySelectorAll('.feedback-btn').forEach(btn => {
        btn.addEventListener('click', function() {
            const appt = sorted.find(a => a.id === this.dataset.id);
            openFeedbackModal(this.dataset.id, appt?.serviceName || 'Service');
        });
    });
}

// =============================================================
// 10. BOOKING MODAL
// =============================================================
function openBookingModal(serviceInput, variantId = null, prefilledDate = null, prefilledTime = null, prefilledStylistId = null) {
    let service = null;
    let serviceId = null;

    if (!serviceInput && variantId) {
        const appt = activeAppointments.find(a => a.id === variantId);
        if (!appt) { showToast("Appointment not found.", "error"); return; }
        reschedulingAppointmentId = variantId;
        modalServiceName.textContent = `Reschedule · ${appt.serviceName}`;
        modalServiceId.value = appt.serviceId;
        modalVariantId.value = appt.variantId || appt.serviceId;
        modalFinalPrice.value = parseFloat(appt.price || 0);
        modalDate.value = appt.bookingDate;
        const apptDur = getPerSessionDurationMinutes(appt.serviceId, appt.variantId);
        populateTimeSelect(modalTime, apptDur, appt.bookingTime);
        modalNote.value = appt.note || '';
        modalBook.textContent = 'Update Appointment';
        resetPaymentProof('modal');
        modalStylist.value = appt.staffUid || '';
        resetModalBookingView();
        refreshStylistSelect(modalStylist, appt.bookingDate, appt.bookingTime, apptDur, appt.staffUid || '', appt.serviceId);
        const resolvedAppt = getResolvedService(appt.serviceId, appt.variantId || appt.serviceId);
        updateBookingSummary(resolvedAppt, appt.price, appt.bookingTime);
        modal.classList.add('active');
        return;
    }

    if (typeof serviceInput === 'object' && serviceInput?.id) {
        service = serviceInput;
        serviceId = service.id;
    } else if (typeof serviceInput === 'string') {
        serviceId = serviceInput;
        service = allServices.find(s => s.id === serviceId);
    } else {
        showToast("Service not found.", "error");
        return;
    }

    if (!service) { showToast("Service not found.", "error"); return; }

    let displayName = service.serviceName;
    let finalPrice = parseFloat(service.price || 0);

    if (variantId && variantId !== serviceId) {
        const variant = allServices.find(s => s.id === variantId);
        if (variant) { displayName = variant.serviceName; finalPrice = parseFloat(variant.price || 0); service = variant; }
    }

    reschedulingAppointmentId = null;
    modalServiceName.textContent = displayName;
    modalServiceId.value = serviceId;
    modalVariantId.value = variantId || serviceId;
    modalFinalPrice.value = finalPrice;
    modalBook.textContent = 'Continue to Payment';
    resetModalBookingView();
    resetPaymentProof('modal');
    const modalPaymentRefInput = document.getElementById('modalPaymentRef');
    if (modalPaymentRefInput) modalPaymentRefInput.value = '';
    updatePaymentMethodHints('modal');
    updateBookingSummary(getResolvedService(serviceId, variantId || serviceId), finalPrice);

    applyBookingDateInputLimits(modalDate);
    modalDate.value = prefilledDate || toLocalDateKey(new Date());
    const durationMins = getPerSessionDurationMinutes(serviceId, variantId || serviceId);
    populateTimeSelect(modalTime, durationMins, prefilledTime || '10:00');
    updateBookingSummary(
        getResolvedService(serviceId, variantId || serviceId),
        finalPrice,
        prefilledTime || modalTime.value
    );
    const preferredStylist = prefilledStylistId
        || bookingWidgetState?.stylistId
        || currentUserProfile?.preferredStylistId
        || '';
    modalStylist.value = '';
    refreshStylistSelect(modalStylist, modalDate.value, modalTime.value, durationMins, preferredStylist, serviceId);
    modalNote.value = '';
    modal.classList.add('active');
}

function closeBookingModal() {
    modal.classList.remove('active');
    resetModalBookingView();
}
modalClose.addEventListener('click', closeBookingModal);
modalCancel.addEventListener('click', closeBookingModal);
modal.addEventListener('click', function(e) { if (e.target === this) closeBookingModal(); });

modalTime?.addEventListener('change', function() {
    const service = getResolvedService(modalServiceId.value, modalVariantId.value);
    if (service) updateBookingSummary(service, modalFinalPrice.value, this.value);
    const durationMins = getPerSessionDurationMinutes(modalServiceId.value, modalVariantId.value || modalServiceId.value);
    refreshStylistSelect(modalStylist, modalDate?.value, this.value, durationMins, modalStylist?.value, modalServiceId.value);
});

modalDate?.addEventListener('change', function() {
    const durationMins = getPerSessionDurationMinutes(modalServiceId.value, modalVariantId.value || modalServiceId.value);
    refreshStylistSelect(modalStylist, this.value, modalTime?.value, durationMins, modalStylist?.value, modalServiceId.value);
});

modalBook.addEventListener('click', async function() {
    if (reschedulingAppointmentId) {
        const bookingData = await collectBookingFormData();
        if (bookingData.error) {
            showToast(bookingData.error, 'error');
            return;
        }
        setButtonLoading(modalBook, true);
        try {
            await submitBookingWithReservation(bookingData);
            closeBookingModal();
        } catch (err) {
            showToast('Failed: ' + err.message, 'error');
        } finally {
            setButtonLoading(modalBook, false);
        }
        return;
    }

    const bookingData = await collectBookingFormData();
    if (bookingData.error) {
        showToast(bookingData.error, 'error');
        return;
    }

    updateModalPaymentSummary(bookingData.savePrice);
    showModalPaymentStep(true);
});

document.getElementById('modalPaymentBackBtn')?.addEventListener('click', () => {
    showModalPaymentStep(false);
});

document.getElementById('modalPayBookBtn')?.addEventListener('click', async function() {
    const bookingData = await collectBookingFormData();
    if (bookingData.error) {
        showToast(bookingData.error, 'error');
        showModalPaymentStep(false);
        return;
    }

    const payMethod = document.querySelector('input[name="modal-reservation-pay"]:checked')?.value;
    const payRef = document.getElementById('modalPaymentRef')?.value.trim() || '';
    const paymentProofFile = getPaymentProofFile('modal');
    const paymentError = validateReservationPaymentInputs(payMethod, payRef, paymentProofFile);
    if (paymentError) {
        showToast(paymentError, 'error');
        return;
    }

    setButtonLoading(this, true);
    if (payMethod === 'qr') {
        updatePaymentProofUploadState('modal', 'uploading');
        showToast('Uploading your payment proof…', 'info');
    }
    try {
        const payment = bookingData.payment;
        await submitBookingWithReservation(bookingData, payMethod, payRef, paymentProofFile, state => updatePaymentProofUploadState('modal', state));
        showBookingModalSuccess(payMethod, payment);
    } catch (err) {
        if (payMethod === 'qr') updatePaymentProofUploadState('modal', 'error');
        showToast('Failed: ' + err.message, 'error');
    } finally {
        setButtonLoading(this, false);
    }
});

document.getElementById('bookingSuccessViewBtn')?.addEventListener('click', () => {
    closeBookingModal();
    switchTab('tabBooking');
});

document.getElementById('bookingSuccessCloseBtn')?.addEventListener('click', closeBookingModal);

// =============================================================
// 11. NOTIFICATIONS
// =============================================================
let clientNotifPanelOpen = false;
let clientNotifFirstSnapshot = true;

function notifCreatedAtDate(notif) {
    const raw = notif?.createdAt;
    if (raw && typeof raw.toDate === "function") return raw.toDate();
    if (raw instanceof Date) return raw;
    return null;
}

// Human-friendly relative time; older than a week falls back to a
// readable local date/time. Stored timestamps are never modified.
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

function escapeNotifHtml(value) {
    return String(value ?? '').replace(/[&<>'"]/g, char => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
    }[char]));
}

// The badge reflects UNREAD notifications only; it disappears entirely at
// zero and never shows a stale count while the first snapshot is loading.
function updateClientNotifBadge(unreadCount) {
    if (!notifBadge) return;
    if (unreadCount > 0) {
        notifBadge.textContent = unreadCount > 99 ? '99+' : String(unreadCount);
        notifBadge.style.display = 'flex';
    } else {
        notifBadge.textContent = '';
        notifBadge.style.display = 'none';
    }
}

function listenToClientNotifications(userId) {
    const q = query(collection(db, "notifications"), where("recipientId", "==", userId));

    const timeValue = (notif) => {
        const date = notifCreatedAtDate(notif);
        return date && !isNaN(date.getTime()) ? date.getTime() : null;
    };

    onSnapshot(q, (snapshot) => {
        clientNotifications = [];
        snapshot.forEach(d => clientNotifications.push({ id: d.id, ...d.data() }));

        // Latest first; documents with a missing/unreadable createdAt go last.
        clientNotifications.sort((a, b) => {
            const timeA = timeValue(a);
            const timeB = timeValue(b);
            if (timeA === null && timeB === null) return 0;
            if (timeA === null) return 1;
            if (timeB === null) return -1;
            return timeB - timeA;
        });

        const unread = clientNotifications.filter(n => !n.isRead).length;
        clientNotifFirstSnapshot = false;
        updateClientNotifBadge(unread);
        renderNotificationPanel();
    }, (err) => {
        console.error("Notifications error:", err);
        if (notifPanelBody) notifPanelBody.innerHTML = `<div class="notif-error">Unable to load notifications.</div>`;
    });
}

function renderNotificationPanel() {
    if (!notifPanelBody) return;

    const markAllBtn = document.getElementById('notifMarkAllBtn');
    const unread = clientNotifications.filter(n => !n.isRead).length;
    if (markAllBtn) markAllBtn.disabled = unread === 0;

    if (clientNotifFirstSnapshot && clientNotifications.length === 0) {
        notifPanelBody.innerHTML = `<div class="notif-loading">Loading notifications…</div>`;
        return;
    }
    if (clientNotifications.length === 0) {
        notifPanelBody.innerHTML = `<div class="notif-empty"><i class="fas fa-bell-slash"></i><p>No notifications yet</p></div>`;
        return;
    }
    notifPanelBody.innerHTML = clientNotifications.map(n => {
        const isUnread = !n.isRead;
        const timeStr = formatNotifTime(n);
        return `<div class="notif-item${isUnread ? ' unread' : ''}" data-id="${n.id}" data-read="${isUnread ? 'false' : 'true'}" tabindex="0">
            <div class="notif-msg">${escapeNotifHtml(n.message || 'Notification')}</div>
            ${timeStr ? `<div class="notif-time">${timeStr}</div>` : ''}
        </div>`;
    }).join('');
}

function openNotifPanel() {
    clientNotifPanelOpen = true;
    notifPanel?.classList.add('open');
    notifOverlay?.classList.add('open');
    bellIcon?.setAttribute('aria-expanded', 'true');
}

function closeNotifPanel() {
    clientNotifPanelOpen = false;
    notifPanel?.classList.remove('open');
    notifOverlay?.classList.remove('open');
    bellIcon?.setAttribute('aria-expanded', 'false');
}

function toggleNotifPanel() {
    if (clientNotifPanelOpen) closeNotifPanel();
    else openNotifPanel();
}

// Marks one notification as read; the badge and list refresh through the
// real-time snapshot, never by manual DOM bookkeeping.
async function markClientNotificationRead(item) {
    if (!item || item.dataset.read === 'true') return;
    const id = item.dataset.id;
    if (!id) return;
    try {
        await updateDoc(doc(db, "notifications", id), { isRead: true });
    } catch (err) {
        console.error("Error marking notification as read:", err);
        showToast("Could not mark the notification as read.", 'error');
    }
}

async function markAllClientNotificationsRead() {
    const btn = document.getElementById('notifMarkAllBtn');
    const unread = clientNotifications.filter(n => !n.isRead);
    if (!unread.length) return;
    if (btn) btn.disabled = true;
    try {
        await Promise.all(unread.map(n => updateDoc(doc(db, "notifications", n.id), { isRead: true })));
        // The next real-time snapshot re-syncs the badge and button state.
    } catch (err) {
        console.error("Error marking all notifications as read:", err);
        showToast("Could not mark all notifications as read.", 'error');
        if (btn) btn.disabled = clientNotifications.filter(n => !n.isRead).length === 0;
    }
}

// =============================================================
// 12. TAB SWITCHING
// =============================================================
function switchTab(tabId) {
    tabPanes.forEach(p => p.classList.remove('active'));
    document.getElementById(tabId)?.classList.add('active');
    navItems.forEach(n => n.classList.remove('active'));
    document.querySelectorAll(`.nav-item[data-tab="${tabId}"]`).forEach(el => el.classList.add('active'));
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

function showOverviewServices() {
    if (!document.getElementById('tabDashboard')?.classList.contains('active')) {
        switchTab('tabDashboard');
    }
    requestAnimationFrame(() => {
        document.getElementById('servicesSection')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
}

navItems.forEach(item => {
    item.addEventListener('click', function() { switchTab(this.dataset.tab); });
});

// =============================================================
// 13. UI HANDLERS
// =============================================================
function initUIHandlers() {
    bindPaymentMethodHints();

    bellIcon?.addEventListener('click', toggleNotifPanel);
    notifPanelClose?.addEventListener('click', closeNotifPanel);
    notifOverlay?.addEventListener('click', closeNotifPanel);
    document.getElementById('notifMarkAllBtn')?.addEventListener('click', markAllClientNotificationsRead);
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && clientNotifPanelOpen) closeNotifPanel();
    });
    // Delegated once — panel re-renders never stack duplicate listeners.
    notifPanelBody?.addEventListener('click', (e) => {
        const item = e.target.closest('.notif-item');
        if (item) markClientNotificationRead(item);
    });
    notifPanelBody?.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        const item = e.target.closest('.notif-item');
        if (item) {
            e.preventDefault();
            markClientNotificationRead(item);
        }
    });

    document.getElementById('viewAllServicesLink')?.addEventListener('click', (e) => {
        e.preventDefault();
        showOverviewServices();
    });

    document.getElementById('overviewServiceSearch')?.addEventListener('input', function() {
        overviewServiceSearchQuery = this.value.trim();
        renderAtelierServices();
    });

    document.querySelectorAll('#overviewServicesViewToggle .overview-view-toggle-btn').forEach(btn => {
        btn.addEventListener('click', function() {
            overviewServicesViewMode = this.dataset.view;
            document.querySelectorAll('#overviewServicesViewToggle .overview-view-toggle-btn').forEach(toggle => {
                toggle.classList.toggle('active', toggle.dataset.view === overviewServicesViewMode);
            });
            renderAtelierServices();
        });
    });

    document.getElementById('heroReserveBtn')?.addEventListener('click', () => {
        switchTab('tabBooking');
        openBookingStudio();
    });

    document.getElementById('closeBookingStudioBtn')?.addEventListener('click', closeBookingStudio);
    document.getElementById('heroExploreBtn')?.addEventListener('click', showOverviewServices);

    topAvatar?.addEventListener('click', () => switchTab('tabProfile'));

    const searchInput = document.getElementById('serviceSearchInput');
    if (searchInput) {
        searchInput.addEventListener('input', function() {
            serviceSearchQuery = this.value.trim();
            renderAllServices();
        });
    }

    document.querySelectorAll('#servicesViewToggle .view-toggle-btn').forEach(btn => {
        btn.addEventListener('click', function() {
            document.querySelectorAll('#servicesViewToggle .view-toggle-btn').forEach(b => b.classList.remove('active'));
            this.classList.add('active');
            servicesViewMode = this.dataset.view;
            renderAllServices();
        });
    });
}

// =============================================================
// 14. PROFILE
// =============================================================
profileForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!currentUser) return;

    const profileData = {
        fullName: document.getElementById('profileName')?.value.trim() || '',
        phone: document.getElementById('profilePhone')?.value.trim() || '',
        dateOfBirth: document.getElementById('profileBirthday')?.value || '',
        gender: document.getElementById('profileGender')?.value || '',
        emailReminders: document.getElementById('profileEmailReminders')?.checked ?? true,
        promoEmails: document.getElementById('profilePromoEmails')?.checked ?? false,
        updatedAt: serverTimestamp()
    };

    try {
        if (!profileData.fullName) {
            showToast("Please enter your full name.", "error");
            return;
        }
        if (!profileData.phone || !profileData.dateOfBirth || !profileData.gender) {
            showToast("Please complete all required personal information fields.", "error");
            return;
        }

        await setDoc(doc(db, "users", currentUser.uid), profileData, { merge: true });
        currentUserProfile = { ...currentUserProfile, ...profileData };

        greetingName.textContent = profileData.fullName.split(' ')[0];
        sidebarName.textContent = profileData.fullName;
        const summaryName = document.getElementById('profileSummaryName');
        if (summaryName) summaryName.textContent = profileData.fullName;
        const initial = profileData.fullName.charAt(0).toUpperCase();
        if (currentUserProfile.photoURL) {
            applyAvatarEverywhere(currentUserProfile.photoURL, initial);
        } else {
            applyAvatarEverywhere(null, initial);
        }

        updateCuratedSectionCopy();
        renderAtelierServices();
        renderInsidersPick();

        showToast("Profile saved successfully!", "success");
    } catch (err) {
        showToast("Update failed: " + err.message, "error");
    }
});

deleteAccountBtn.addEventListener('click', function() {
    if (confirm("Are you sure you want to delete your account? This cannot be undone.")) {
        showToast("Account deletion requested (demo).", "info");
    }
});

async function logoutUser() {
    clearMfaSession();
    await signOut(auth);
    window.location.href = "../index.html";
}

if (logoutBtn) {
    logoutBtn.addEventListener('click', () => {
        openLogoutConfirmation(logoutUser);
    });
}

// =============================================================
// 15. CANCEL MODAL
// =============================================================
document.getElementById('modal-close-cancel-btn').addEventListener('click', () => {
    document.getElementById('cancel-reason-modal').classList.remove('active');
});
document.getElementById('modal-back-cancel-btn').addEventListener('click', () => {
    document.getElementById('cancel-reason-modal').classList.remove('active');
});
document.getElementById('modal-submit-cancel-btn').addEventListener('click', async () => {
    const reason = document.getElementById('cancel-reason-text').value.trim();
    if (!reason) { showToast("Please provide a reason.", "error"); return; }
    if (!selectedAppointmentIdToCancel) return;
    try {
        await updateDoc(doc(db, "appointments", selectedAppointmentIdToCancel), {
            status: "Cancellation Requested", cancellationReason: reason
        });
        showToast("Cancellation request submitted.", "success");
        document.getElementById('cancel-reason-modal').classList.remove('active');
        document.getElementById('cancel-reason-text').value = '';
    } catch (err) {
        showToast("Failed to submit request.", "error");
    }
});

nextCancelBtn.addEventListener('click', function() {
    if (this.dataset.id) {
        selectedAppointmentIdToCancel = this.dataset.id;
        document.getElementById('cancel-reason-modal').classList.add('active');
    }
});
nextReschedBtn.addEventListener('click', function() {
    if (this.dataset.id) openBookingModal(null, this.dataset.id);
});

// =============================================================
// 16. FEEDBACK MODAL
// =============================================================
function openFeedbackModal(apptId, serviceName) {
    selectedRating = 0;
    feedbackApptId.value = apptId;
    feedbackComment.value = '';
    document.getElementById('feedbackServiceName').textContent = serviceName || 'Service';
    starElements.forEach(el => { el.className = 'far fa-star'; });
    feedbackModal.classList.add('active');
}

function closeFeedbackModal() { feedbackModal.classList.remove('active'); }
feedbackCloseBtn.addEventListener('click', closeFeedbackModal);
feedbackCancelBtn.addEventListener('click', closeFeedbackModal);
feedbackModal.addEventListener('click', function(e) { if (e.target === this) closeFeedbackModal(); });

starElements.forEach(star => {
    star.addEventListener('click', function() {
        selectedRating = parseInt(this.dataset.star);
        starElements.forEach(el => {
            el.className = parseInt(el.dataset.star) <= selectedRating ? 'fas fa-star' : 'far fa-star';
        });
    });
    star.addEventListener('mouseenter', function() {
        const hover = parseInt(this.dataset.star);
        starElements.forEach(el => {
            el.className = parseInt(el.dataset.star) <= hover ? 'fas fa-star' : 'far fa-star';
        });
    });
});
document.querySelector('.star-rating')?.addEventListener('mouseleave', () => {
    starElements.forEach(el => {
        el.className = parseInt(el.dataset.star) <= selectedRating ? 'fas fa-star' : 'far fa-star';
    });
});

feedbackSubmitBtn.addEventListener('click', async function() {
    const apptId = feedbackApptId.value;
    if (!apptId || selectedRating === 0) {
        showToast("Please select a star rating.", "error");
        return;
    }
    try {
        await updateDoc(doc(db, "appointments", apptId), {
            feedback: { rating: selectedRating, comment: feedbackComment.value.trim(), createdAt: serverTimestamp() }
        });
        showToast("Thank you for your feedback!", "success");
        closeFeedbackModal();
    } catch (err) {
        showToast("Failed to submit feedback.", "error");
    }
});

// =============================================================
// 17. BOOKING STUDIO (compact step wizard)
// =============================================================
let bookingStudioStep = 1;
let bookingWidgetState = null;

function openBookingStudio() {
    const studio = document.getElementById('bookingStudio');
    if (studio) studio.classList.add('is-open');
}

function resetBookingStudio() {
    if (!bookingWidgetState) return;
    bookingWidgetState.category = '';
    bookingWidgetState.selectedServiceId = null;
    bookingWidgetState.selectedVariantId = null;
    bookingWidgetState.serviceName = '';
    bookingWidgetState.sessionLabel = '';
    bookingWidgetState.durationMinutes = 60;
    bookingWidgetState.durationLabel = '';
    bookingWidgetState.date = toLocalDateKey(new Date());
    bookingWidgetState.time = '';
    bookingWidgetState.stylistId = currentUserProfile?.preferredStylistId || '';

    const catSelect = document.getElementById('bookingCategorySelect');
    if (catSelect) catSelect.value = '';
    document.querySelectorAll('.booking-cat-chip').forEach(c => c.classList.remove('active'));
    const serviceGroupedList = document.getElementById('serviceGroupedList');
    if (serviceGroupedList) serviceGroupedList.innerHTML = '';
    const sessionSelect = document.getElementById('bookingSessionSelect');
    if (sessionSelect) sessionSelect.innerHTML = '<option value="">Select Session</option>';
    const dateInput = document.getElementById('bookingDateInput');
    if (dateInput) dateInput.value = bookingWidgetState.date;
    refreshBookingTimeSlots();
    const styInput = document.getElementById('bookingStylistInput');
    if (styInput) styInput.value = '';
    populateBookingStudioStylists();
    resetPaymentProof('studio');
    showBookingStudioStep(1);
    updateBookingPreview();
}

function closeBookingStudio() {
    const studio = document.getElementById('bookingStudio');
    if (studio) studio.classList.remove('is-open');
}

function updateBookingPreview() {
    const previewText = document.getElementById('bookingPreviewText');
    if (!previewText || !bookingWidgetState) return;

    const { category, serviceName, sessionLabel, date, time, durationLabel, stylistId } = bookingWidgetState;
    const parts = [];
    if (category) parts.push(category);
    if (serviceName) parts.push(serviceName);
    if (sessionLabel && sessionLabel !== 'Standard') parts.push(sessionLabel);
    if (durationLabel) parts.push(durationLabel);
    if (stylistId) {
        const stylist = loadedStaffMembers.find(s => s.id === stylistId);
        if (stylist) parts.push(`with ${stylist.fullName || 'Stylist'}`);
    } else if (bookingWidgetState && loadedStaffMembers.length) {
        parts.push('any available stylist');
    }
    if (date && time && bookingWidgetState.durationMinutes) {
        parts.push(`${date} · ${formatTimeRange(time, bookingWidgetState.durationMinutes)}`);
    } else if (date && time) {
        parts.push(`${date} at ${formatDisplayTime(time)}`);
    }

    previewText.textContent = parts.length
        ? parts.join(' · ')
        : 'Choose a category to begin';
}

function refreshBookingTimeSlots() {
    const timeInput = document.getElementById('bookingTimeInput');
    if (!timeInput || !bookingWidgetState) return;
    const mins = bookingWidgetState.durationMinutes || 60;
    const selected = populateTimeSelect(timeInput, mins, bookingWidgetState.time);
    bookingWidgetState.time = selected || '';
}

function showBookingStudioStep(step) {
    bookingStudioStep = step;
    updateWizardStep(step);

    const backBtn = document.getElementById('studioBackBtn');
    const continueBtn = document.getElementById('studioContinueBtn');
    const bookBtn = document.getElementById('bookingQuickBookBtn');
    const payment = computeReservationPayment(
        allServices.find(s => s.id === bookingWidgetState?.selectedVariantId)?.price
        ?? allServices.find(s => s.id === bookingWidgetState?.selectedServiceId)?.price
    );

    if (backBtn) {
        backBtn.disabled = step === 1;
        backBtn.style.display = step === 6 ? 'none' : '';
    }
    if (continueBtn) continueBtn.style.display = step < 5 ? 'flex' : 'none';
    const doneBtn = document.getElementById('studioDoneBtn');
    if (doneBtn) doneBtn.style.display = step === 6 ? 'flex' : 'none';
    if (bookBtn) {
        bookBtn.style.display = step === 5 ? 'flex' : 'none';
        bookBtn.textContent = `Pay ${formatPrice(payment.reservationFee)} & Book →`;
    }

    if (continueBtn) {
        const canContinue =
            (step === 1 && bookingWidgetState?.category) ||
            (step === 2 && bookingWidgetState?.selectedServiceId) ||
            (step === 3 && bookingWidgetState?.selectedVariantId) ||
            (step === 4 && bookingWidgetState?.date && bookingWidgetState?.time) ||
            false;
        continueBtn.disabled = !canContinue;
    }

    if (bookBtn) {
        bookBtn.disabled = !(bookingWidgetState?.selectedVariantId && bookingWidgetState?.date && bookingWidgetState?.time);
    }

    if (step === 4) {
        populateBookingStudioStylists();
    }
    if (step === 5) {
        updateStudioReservationSummary();
    }
}

function initBookingWidget() {
    const catSelect = document.getElementById('bookingCategorySelect');
    const categoryChips = document.getElementById('bookingCategoryChips');
    const serviceGroupedList = document.getElementById('serviceGroupedList');
    const sessionSelect = document.getElementById('bookingSessionSelect');
    const dateInput = document.getElementById('bookingDateInput');
    const timeInput = document.getElementById('bookingTimeInput');
    const bookBtn = document.getElementById('bookingQuickBookBtn');
    const continueBtn = document.getElementById('studioContinueBtn');
    const backBtn = document.getElementById('studioBackBtn');

    if (!catSelect || !categoryChips) return;

    const categories = [...new Set(allServices.map(s => s.category))].filter(Boolean);
    catSelect.innerHTML = `<option value="">Select Category</option>` +
        categories.map(cat => `<option value="${cat}">${cat}</option>`).join('');

    categoryChips.innerHTML = categories.map(cat => `
        <button type="button" class="booking-cat-chip" data-cat="${cat}">
            <i class="fas ${getCategoryIcon(cat)}"></i> ${cat}
        </button>
    `).join('');

    bookingWidgetState = {
        category: '',
        selectedServiceId: null,
        selectedVariantId: null,
        serviceName: '',
        sessionLabel: '',
        durationMinutes: 60,
        durationLabel: '',
        date: '',
        time: '',
        stylistId: currentUserProfile?.preferredStylistId || ''
    };

    applyBookingDateInputLimits(dateInput);
    dateInput.value = toLocalDateKey(new Date());
    bookingWidgetState.date = dateInput.value;
    refreshBookingTimeSlots();
    populateBookingStudioStylists();

    showBookingStudioStep(1);
    updateBookingPreview();

    categoryChips.querySelectorAll('.booking-cat-chip').forEach(chip => {
        chip.addEventListener('click', function() {
            categoryChips.querySelectorAll('.booking-cat-chip').forEach(c => c.classList.remove('active'));
            this.classList.add('active');
            catSelect.value = this.dataset.cat;
            bookingWidgetState.category = this.dataset.cat;
            bookingWidgetState.selectedServiceId = null;
            bookingWidgetState.selectedVariantId = null;
            bookingWidgetState.serviceName = '';
            bookingWidgetState.sessionLabel = '';
            renderServiceOptions(this.dataset.cat);
            showBookingStudioStep(2);
            updateBookingPreview();
        });
    });

    function renderServiceOptions(category) {
        const filtered = allServices.filter(s => s.category === category && !s.variantOf);
        const grouped = {};
        filtered.forEach(s => {
            const key = s.semiCategory || 'General';
            if (!grouped[key]) grouped[key] = [];
            grouped[key].push(s);
        });

        serviceGroupedList.innerHTML = Object.entries(grouped).map(([semiCat, services]) => `
            <div class="semi-cat-label">${semiCat}</div>
            <div class="service-pill-group">
                ${services.map(s => `<button type="button" class="service-select-btn" data-id="${s.id}">${s.serviceName} · ${formatDurationLabel(resolveServiceDurationMinutes(s), true)} · ${formatPrice(s.price)}</button>`).join('')}
            </div>
        `).join('') || '<p style="font-size:0.8rem;color:var(--dusty-rose);">No services in this category yet.</p>';

        serviceGroupedList.querySelectorAll('.service-select-btn').forEach(btn => {
            btn.addEventListener('click', function() {
                serviceGroupedList.querySelectorAll('.service-select-btn').forEach(b => b.classList.remove('selected'));
                this.classList.add('selected');
                bookingWidgetState.selectedServiceId = this.dataset.id;
                const svc = allServices.find(s => s.id === this.dataset.id);
                bookingWidgetState.serviceName = svc?.serviceName || '';
                loadSessionOptions(this.dataset.id);
                updateBookingPreview();
                showBookingStudioStep(3);
            });
        });
    }

    function loadSessionOptions(baseId) {
        sessionSelect.innerHTML = `<option value="">Choose session type</option>`;
        const baseService = allServices.find(s => s.id === baseId);
        if (!baseService) return;

        const sessionDur = getPerSessionDurationLabel(baseId);
        const opt = document.createElement('option');
        opt.value = baseService.id;
        opt.textContent = formatSessionOptionLabel(baseService, baseService, true);
        sessionSelect.appendChild(opt);

        allServices.filter(s => s.variantOf === baseId).forEach(v => {
            const o = document.createElement('option');
            o.value = v.id;
            o.textContent = formatSessionOptionLabel(v, baseService, false);
            sessionSelect.appendChild(o);
        });

        bookingWidgetState.selectedVariantId = baseService.id;
        bookingWidgetState.sessionLabel = 'Standard';
        bookingWidgetState.durationMinutes = getPerSessionDurationMinutes(baseId);
        bookingWidgetState.durationLabel = sessionDur;
        refreshBookingTimeSlots();
        populateBookingStudioStylists();
        updateBookingPreview();
    }

    dateInput.addEventListener('change', function() {
        bookingWidgetState.date = this.value;
        populateBookingStudioStylists();
        updateBookingPreview();
        showBookingStudioStep(4);
    });

    timeInput.addEventListener('change', function() {
        bookingWidgetState.time = this.value;
        populateBookingStudioStylists();
        updateBookingPreview();
        showBookingStudioStep(4);
    });

    document.getElementById('bookingStylistInput')?.addEventListener('change', function() {
        bookingWidgetState.stylistId = this.value;
        updateBookingPreview();
    });

    sessionSelect.addEventListener('change', function() {
        bookingWidgetState.selectedVariantId = this.value;
        bookingWidgetState.sessionLabel = this.options[this.selectedIndex]?.text.split(' · ')[0] || '';
        bookingWidgetState.durationMinutes = getPerSessionDurationMinutes(
            bookingWidgetState.selectedServiceId,
            this.value
        );
        bookingWidgetState.durationLabel = getPerSessionDurationLabel(
            bookingWidgetState.selectedServiceId,
            this.value
        );
        refreshBookingTimeSlots();
        populateBookingStudioStylists();
        updateBookingPreview();
        showBookingStudioStep(3);
    });

    continueBtn?.addEventListener('click', () => {
        if (bookingStudioStep < 5) showBookingStudioStep(bookingStudioStep + 1);
    });

    backBtn?.addEventListener('click', () => {
        if (bookingStudioStep > 1) showBookingStudioStep(bookingStudioStep - 1);
    });

    bookBtn?.addEventListener('click', () => {
        submitStudioBookingWithReservation();
    });

    document.getElementById('studioDoneBtn')?.addEventListener('click', () => {
        resetBookingStudio();
        closeBookingStudio();
        switchTab('tabBooking');
    });
}

// =============================================================
// INIT
// =============================================================
(function() {
    applyBookingDateInputLimits(modalDate);
    applyBookingDateInputLimits(document.getElementById('bookingDateInput'));
})();

console.log("K-Beauty Client Portal ready.");
