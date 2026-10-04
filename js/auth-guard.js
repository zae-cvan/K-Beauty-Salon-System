/**
 * Session guard — import in dashboard entry points.
 * Login/registration set the MFA session immediately; the guard now only
 * enforces a signed-in state (the OTP MFA step was removed).
 */
const MFA_SESSION_KEY = "mfaVerified";
const MFA_UID_KEY = "mfaUid";
const MFA_TIME_KEY = "mfaVerifiedAt";
const MFA_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export function setMfaVerified(uid) {
    sessionStorage.setItem(MFA_SESSION_KEY, "true");
    sessionStorage.setItem(MFA_UID_KEY, uid);
    sessionStorage.setItem(MFA_TIME_KEY, String(Date.now()));
}

export function clearMfaSession() {
    sessionStorage.removeItem(MFA_SESSION_KEY);
    sessionStorage.removeItem(MFA_UID_KEY);
    sessionStorage.removeItem(MFA_TIME_KEY);
    sessionStorage.removeItem("pendingLoginEmail");
    sessionStorage.removeItem("pendingLoginUid");
    sessionStorage.removeItem("pendingLoginRole");
    sessionStorage.removeItem("pendingRegistration");
    sessionStorage.removeItem("devOtpHint");
}

export function isMfaVerifiedForUser(uid) {
    if (sessionStorage.getItem(MFA_SESSION_KEY) !== "true") return false;
    if (sessionStorage.getItem(MFA_UID_KEY) !== uid) return false;
    const verifiedAt = parseInt(sessionStorage.getItem(MFA_TIME_KEY) || "0", 10);
    if (Date.now() - verifiedAt > MFA_MAX_AGE_MS) {
        clearMfaSession();
        return false;
    }
    return true;
}

export function requireMfaOrRedirect(user, loginPath = "../index.html") {
    if (!user) {
        window.location.href = loginPath;
        return false;
    }
    return true;
}
