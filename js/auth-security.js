/**
 * Password policy, common-password rejection, and login lockout helpers.
 */

export const PASSWORD_RULES = {
    minLength: 8,
    requireUpper: true,
    requireLower: true,
    requireNumber: true,
    requireSpecial: true,
    specialPattern: /[!@#$%^&*()_+]/
};

export const COMMON_PASSWORDS = new Set([
    "password", "password1", "password12", "password123", "password123!",
    "admin", "admin1", "admin12", "admin123", "admin123!",
    "12345678", "123456789", "1234567890", "qwerty", "qwerty123",
    "qwertyui", "letmein", "welcome", "welcome1", "iloveyou",
    "monkey", "dragon", "master", "login", "abc123", "abc123!",
    "football", "baseball", "sunshine", "princess", "trustno1",
    "superman", "batman", "hello123", "charlie", "donald", "access",
    "shadow", "michael", "jennifer", "computer", "internet", "samsung",
    "passw0rd", "p@ssw0rd", "p@ssword", "test1234", "guest123"
]);

export const LOCKOUT_CONFIG = {
    maxAttempts: 5,
    lockoutMinutes: 10
};

export function normalizeEmail(email) {
    return (email || "").trim().toLowerCase();
}

export function emailToDocId(email) {
    return normalizeEmail(email).replace(/@/g, "_at_").replace(/\./g, "_dot_");
}

export function validatePassword(password) {
    const errors = [];
    const checks = getPasswordChecks(password);

    if (!checks.minLength) errors.push("At least 8 characters");
    if (!checks.uppercase) errors.push("At least 1 uppercase letter");
    if (!checks.lowercase) errors.push("At least 1 lowercase letter");
    if (!checks.number) errors.push("At least 1 number");
    if (!checks.special) errors.push("At least 1 special character (!@#$%^&*()_+)");
    if (!checks.notCommon) errors.push("Cannot be a common or easily guessed password");

    return { valid: errors.length === 0, errors, checks };
}

export function getPasswordChecks(password) {
    const pwd = password || "";
    const lower = pwd.toLowerCase();

    return {
        minLength: pwd.length >= PASSWORD_RULES.minLength,
        uppercase: /[A-Z]/.test(pwd),
        lowercase: /[a-z]/.test(pwd),
        number: /[0-9]/.test(pwd),
        special: PASSWORD_RULES.specialPattern.test(pwd),
        notCommon: pwd.length > 0 && !COMMON_PASSWORDS.has(lower) && !COMMON_PASSWORDS.has(lower.replace(/[!@#$%^&*()_+]/g, ""))
    };
}

export function passwordsMatch(password, confirmPassword) {
    return password.length > 0 && password === confirmPassword;
}

export function getLockoutStatus(data) {
    if (!data) return { locked: false, remainingMinutes: 0, failedAttempts: 0 };

    const failedAttempts = data.failedAttempts || 0;
    const lockedUntil = data.lockedUntil?.toDate?.() || (data.lockedUntil ? new Date(data.lockedUntil) : null);

    if (lockedUntil && lockedUntil > new Date()) {
        const remainingMs = lockedUntil.getTime() - Date.now();
        return {
            locked: true,
            remainingMinutes: Math.ceil(remainingMs / 60000),
            failedAttempts
        };
    }

    return { locked: false, remainingMinutes: 0, failedAttempts };
}

export function buildLockoutMessage(remainingMinutes) {
    const mins = Math.max(1, remainingMinutes);
    return `Too many failed login attempts. Your account is temporarily locked. Please try again in ${mins} minute${mins !== 1 ? "s" : ""}.`;
}
