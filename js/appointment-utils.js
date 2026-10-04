/**
 * Shared appointment utilities for Client, Staff, and Admin portals.
 */

export const STAFF_ROLES = ['Staff', 'Stylist', 'Receptionist', 'General Staff', 'Manager'];

export const SALON_OPEN_MINUTES = 9 * 60;
export const SALON_CLOSE_MINUTES = 18 * 60;
export const TIME_SLOT_INTERVAL = 30;

/** Past-date booking is restricted to authorized staff backfill; clients can only book today onward. */
export const ALLOW_PAST_BOOKINGS = false;

/** Earliest selectable date when past bookings are explicitly enabled (staff/admin backfill). */
export const PAST_BOOKING_MIN_DATE = '2018-01-01';

export function isPastBookingDate(dateKey) {
    if (!dateKey) return false;
    return dateKey < getTodayKey();
}

export function applyBookingDateInputLimits(input, allowPast = ALLOW_PAST_BOOKINGS) {
    if (!input) return;
    if (allowPast) {
        input.min = PAST_BOOKING_MIN_DATE;
        input.removeAttribute('max');
    } else {
        input.min = getTodayKey();
    }
}

export const STATUS = {
    PENDING: 'pending',
    CONFIRMED: 'confirmed',
    CANCELLED: 'cancelled',
    DENIED: 'denied',
    SERVED: 'served',
    NO_SHOW: 'no-show',
    CANCELLATION_REQUESTED: 'cancellation requested',
    COMPLETED: 'completed',
    APPROVED: 'approved',
    DECLINED: 'declined'
};

export function normalizeStatus(status) {
    const s = (status || 'pending').toLowerCase().trim();
    if (s === 'cancellation_requested') return STATUS.CANCELLATION_REQUESTED;
    if (s === 'no show') return STATUS.NO_SHOW;
    if (s === 'approved') return STATUS.CONFIRMED;
    if (s === 'completed') return STATUS.SERVED;
    if (s === 'declined') return STATUS.DENIED;
    return s;
}

export function getStatusMeta(status, operationalStatus = null) {
    const norm = normalizeStatus(status);

    if (operationalStatus === 'checked_in') {
        return { label: 'Checked In', icon: '🟣', className: 'status-checked-in' };
    }
    if (operationalStatus === 'in_service') {
        return { label: 'In Service', icon: '💆', className: 'status-in-service' };
    }

    const map = {
        [STATUS.PENDING]: { label: 'Pending', icon: '🟡', className: 'status-pending' },
        [STATUS.CONFIRMED]: { label: 'Confirmed', icon: '🔵', className: 'status-confirmed' },
        [STATUS.CANCELLED]: { label: 'Cancelled', icon: '🔴', className: 'status-cancelled' },
        [STATUS.DENIED]: { label: 'Denied', icon: '⚫', className: 'status-denied' },
        [STATUS.SERVED]: { label: 'Served', icon: '🟢', className: 'status-served' },
        [STATUS.NO_SHOW]: { label: 'No Show', icon: '🟠', className: 'status-no-show' },
        [STATUS.CANCELLATION_REQUESTED]: { label: 'Cancellation Requested', icon: '🟡', className: 'status-cancel-req' }
    };

    return map[norm] || { label: status || 'Unknown', icon: '•', className: 'status-unknown' };
}

export function isActiveAppointmentStatus(status) {
    const norm = normalizeStatus(status);
    return ![
        STATUS.CANCELLED,
        STATUS.DENIED,
        STATUS.SERVED,
        STATUS.NO_SHOW,
        STATUS.COMPLETED,
        STATUS.DECLINED
    ].includes(norm);
}

export function isBlockingAppointmentStatus(status) {
    const norm = normalizeStatus(status);
    return [STATUS.PENDING, STATUS.CONFIRMED, STATUS.CANCELLATION_REQUESTED, STATUS.APPROVED].includes(norm);
}

export function timeToMinutes(timeStr) {
    if (!timeStr) return 0;
    const [h, m] = timeStr.split(':').map(Number);
    return h * 60 + (m || 0);
}

export function minutesToTime(mins) {
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

export function formatDisplayTime(timeStr) {
    if (!timeStr) return '—';
    const [h, m] = timeStr.split(':');
    const hour = parseInt(h, 10);
    const ampm = hour >= 12 ? 'PM' : 'AM';
    const h12 = hour % 12 || 12;
    return `${h12}:${m} ${ampm}`;
}

export function formatTimeRange(startTime, durationMins) {
    const start = timeToMinutes(startTime);
    const end = start + (durationMins || 60);
    return `${formatDisplayTime(startTime)} to ${formatDisplayTime(minutesToTime(end))}`;
}

export function getAppointmentDuration(appt) {
    if (appt?.durationMinutes && !Number.isNaN(appt.durationMinutes)) {
        return appt.durationMinutes;
    }
    const parsed = parseDurationMinutes(appt?.duration);
    return parsed || 60;
}

export function parseDurationMinutes(durationStr) {
    if (durationStr == null || durationStr === '') return null;
    if (typeof durationStr === 'number' && !Number.isNaN(durationStr)) return durationStr;
    const str = String(durationStr).toLowerCase().trim();
    if (/package|per session|\d+\s*\+\s*\d+/.test(str)) return null;
    const rangeHour = str.match(/([\d.]+)\s*[-–]\s*([\d.]+)\s*h/);
    if (rangeHour) return Math.round(parseFloat(rangeHour[2]) * 60);
    const hourMatch = str.match(/([\d.]+)\s*h/);
    if (hourMatch) return Math.round(parseFloat(hourMatch[1]) * 60);
    const minMatch = str.match(/([\d.]+)\s*m/);
    if (minMatch) return Math.round(parseFloat(minMatch[1]));
    return null;
}

export function toLocalDateKey(dateObj) {
    const y = dateObj.getFullYear();
    const m = String(dateObj.getMonth() + 1).padStart(2, '0');
    const d = String(dateObj.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

export function getTodayKey() {
    return toLocalDateKey(new Date());
}

export function formatPrice(amount) {
    return `₱${parseFloat(amount || 0).toLocaleString()}`;
}

export function getApptDate(appt) {
    return appt?.bookingDate || appt?.date || '';
}

export function getApptTime(appt) {
    return appt?.bookingTime || appt?.time || '';
}

export function overlapsTimeRange(date, startTime, durationMins, otherDate, otherStart, otherDuration) {
    if (date !== otherDate) return false;
    const start = timeToMinutes(startTime);
    const end = start + durationMins;
    const oStart = timeToMinutes(otherStart);
    const oEnd = oStart + otherDuration;
    return start < oEnd && end > oStart;
}

export function hasStylistConflict(appointments, stylistUid, date, time, durationMins, excludeApptId = null) {
    if (!stylistUid) return false;
    return appointments.some(appt => {
        if (excludeApptId && appt.id === excludeApptId) return false;
        if (appt.staffUid !== stylistUid) return false;
        if (!isBlockingAppointmentStatus(appt.status)) return false;
        if (appt.archived) return false;
        return overlapsTimeRange(
            date, time, durationMins,
            getApptDate(appt), getApptTime(appt), getAppointmentDuration(appt)
        );
    });
}

export const WEEKLY_DAY_KEYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

const DAY_KEYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

export function getDayKeyFromDate(dateStr) {
    const d = new Date(dateStr + 'T00:00:00');
    return DAY_KEYS[d.getDay()];
}

export function isStylistDayOff(schedule, dateStr) {
    if (!schedule?.weeklyHours) return false;
    const day = getDayKeyFromDate(dateStr);
    const daySchedule = schedule.weeklyHours[day];
    return daySchedule?.off === true;
}

export function isWithinStylistHours(schedule, dateStr, timeStr, durationMins) {
    if (!schedule?.weeklyHours) return isWithinSalonHours(timeStr, durationMins);
    const day = getDayKeyFromDate(dateStr);
    const daySchedule = schedule.weeklyHours[day];
    if (!daySchedule || daySchedule.off) return false;
    const open = timeToMinutes(daySchedule.open || '09:00');
    const close = timeToMinutes(daySchedule.close || '18:00');
    const start = timeToMinutes(timeStr);
    return start >= open && start + durationMins <= close;
}

export function isBlockedBySchedule(schedule, dateStr, timeStr, durationMins) {
    const blocks = schedule?.blocks || [];
    const start = timeToMinutes(timeStr);
    const end = start + durationMins;
    return blocks.some(block => {
        if (block.date !== dateStr) return false;
        const bStart = timeToMinutes(block.startTime);
        const bEnd = timeToMinutes(block.endTime);
        return start < bEnd && end > bStart;
    });
}

export function isWithinSalonHours(timeStr, durationMins) {
    const start = timeToMinutes(timeStr);
    return start >= SALON_OPEN_MINUTES && start + durationMins <= SALON_CLOSE_MINUTES;
}

export function validateStylistSlot(appointments, schedule, stylistUid, date, time, durationMins, excludeApptId = null) {
    if (!date || !time) return 'Date and time are required.';
    if (!isWithinSalonHours(time, durationMins)) {
        return 'Appointment must fit within salon hours (9:00 AM – 6:00 PM).';
    }
    if (stylistUid && isStylistDayOff(schedule, date)) {
        return 'Stylist is off on this day.';
    }
    if (stylistUid && schedule && !isWithinStylistHours(schedule, date, time, durationMins)) {
        return 'Appointment is outside stylist working hours.';
    }
    if (stylistUid && schedule && isBlockedBySchedule(schedule, date, time, durationMins)) {
        return 'This time is blocked on the stylist schedule.';
    }
    if (stylistUid && hasStylistConflict(appointments, stylistUid, date, time, durationMins, excludeApptId)) {
        return 'Scheduling conflict — stylist already has an appointment during this time.';
    }
    return null;
}

export function defaultWeeklyHours() {
    const day = { open: '09:00', close: '18:00', off: false };
    const hours = {};
    WEEKLY_DAY_KEYS.forEach(key => { hours[key] = { ...day }; });
    return hours;
}

/** One deterministic day off per stylist so not everyone is off on the same day. */
export function randomizedWeeklyHours(stylistUid = '') {
    const day = { open: '09:00', close: '18:00', off: false };
    const off = { open: '09:00', close: '18:00', off: true };
    const hours = {};
    WEEKLY_DAY_KEYS.forEach(key => { hours[key] = { ...day }; });

    let hash = 0;
    const seed = stylistUid || 'default-stylist';
    for (let i = 0; i < seed.length; i++) {
        hash = ((hash << 5) - hash) + seed.charCodeAt(i);
        hash |= 0;
    }
    const offIndex = Math.abs(hash) % WEEKLY_DAY_KEYS.length;
    hours[WEEKLY_DAY_KEYS[offIndex]] = { ...off };
    return hours;
}

/** Legacy schedules had every stylist off on Sunday only. */
export function isLegacySundayOffSchedule(weeklyHours) {
    if (!weeklyHours) return false;
    return WEEKLY_DAY_KEYS.every(key => {
        if (key === 'sunday') return weeklyHours[key]?.off === true;
        return weeklyHours[key]?.off !== true;
    });
}

export function needsStylistAssignment(appt) {
    return !appt.staffUid || appt.staffName === 'Any Available Stylist';
}

export const RESERVATION_FEE = 500;

export function parsePrice(value) {
    return parseFloat(String(value ?? '').replace(/,/g, '')) || 0;
}

/** Reservation fee (max ₱500) and remaining balance due at the salon. */
export function computeReservationPayment(servicePrice) {
    const totalPrice = parsePrice(servicePrice);
    const reservationFee = Math.min(RESERVATION_FEE, totalPrice);
    const balanceDue = Math.max(0, totalPrice - reservationFee);
    return { totalPrice, reservationFee, balanceDue };
}

export function getAppointmentBalanceDue(appt) {
    if (!appt) return 0;
    if (appt.balanceDue != null && appt.balanceDue !== '') {
        return parsePrice(appt.balanceDue);
    }
    return computeReservationPayment(appt.price).balanceDue;
}
