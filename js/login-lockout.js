import { db } from "./firebase-config.js";
import { doc, getDoc, setDoc, deleteDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";
import {
    normalizeEmail, emailToDocId, getLockoutStatus, buildLockoutMessage, LOCKOUT_CONFIG
} from "./auth-security.js";

function lockoutRef(email) {
    return doc(db, "loginAttempts", emailToDocId(email));
}

export async function checkLoginLockout(email) {
    const snap = await getDoc(lockoutRef(email));
    const status = getLockoutStatus(snap.exists() ? snap.data() : null);
    if (status.locked) {
        return { allowed: false, message: buildLockoutMessage(status.remainingMinutes), ...status };
    }
    return { allowed: true, failedAttempts: status.failedAttempts };
}

export async function recordFailedLogin(email) {
    const ref = lockoutRef(email);
    const snap = await getDoc(ref);
    const current = snap.exists() ? snap.data() : { failedAttempts: 0 };
    const failedAttempts = (current.failedAttempts || 0) + 1;

    const update = {
        email: normalizeEmail(email),
        failedAttempts,
        lastAttemptAt: serverTimestamp()
    };

    if (failedAttempts >= LOCKOUT_CONFIG.maxAttempts) {
        update.lockedUntil = new Date(Date.now() + LOCKOUT_CONFIG.lockoutMinutes * 60 * 1000);
    }

    await setDoc(ref, update, { merge: true });

    if (failedAttempts >= LOCKOUT_CONFIG.maxAttempts) {
        return {
            locked: true,
            message: buildLockoutMessage(LOCKOUT_CONFIG.lockoutMinutes),
            remainingMinutes: LOCKOUT_CONFIG.lockoutMinutes
        };
    }

    const remaining = LOCKOUT_CONFIG.maxAttempts - failedAttempts;
    return {
        locked: false,
        message: `Invalid email or password. ${remaining} attempt${remaining !== 1 ? "s" : ""} remaining.`
    };
}

export async function resetLoginAttempts(email) {
    await setDoc(lockoutRef(email), {
        email: normalizeEmail(email),
        failedAttempts: 0,
        lockedUntil: null,
        lastAttemptAt: serverTimestamp()
    }, { merge: true });
}

export async function adminUnlockAccount(email) {
    await deleteDoc(lockoutRef(email));
}

export async function getLockoutInfo(email) {
    const snap = await getDoc(lockoutRef(email));
    return getLockoutStatus(snap.exists() ? snap.data() : null);
}
