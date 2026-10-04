import { db } from "./firebase-config.js";
import { doc, setDoc, getDoc, updateDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";
import { EMAILJS_CONFIG, isEmailJsConfigured } from "./emailjs-config.js";
import { normalizeEmail } from "./auth-security.js";

const OTP_EXPIRY_MS = 10 * 60 * 1000;

function generateOtpCode() {
    return String(Math.floor(100000 + Math.random() * 900000));
}

function otpDocId(email, purpose) {
    const safe = normalizeEmail(email)
        .replace(/@/g, "_at_")
        .replace(/\./g, "_dot_")
        .replace(/[^a-z0-9_]/g, "_");
    return `${safe}_${purpose}`;
}

function otpDocRef(email, purpose) {
    return doc(db, "otpVerifications", otpDocId(email, purpose));
}

async function loadEmailJs() {
    if (window.emailjs) return window.emailjs;
    return new Promise((resolve, reject) => {
        const existing = document.querySelector('script[src*="emailjs"]');
        if (existing) {
            const wait = setInterval(() => {
                if (window.emailjs) { clearInterval(wait); resolve(window.emailjs); }
            }, 50);
            setTimeout(() => { clearInterval(wait); reject(new Error("EmailJS load timeout")); }, 10000);
            return;
        }
        const script = document.createElement("script");
        script.src = "https://cdn.jsdelivr.net/npm/@emailjs/browser@4/dist/email.min.js";
        script.onload = () => {
            if (window.emailjs && isEmailJsConfigured()) {
                window.emailjs.init({ publicKey: EMAILJS_CONFIG.publicKey });
            }
            resolve(window.emailjs);
        };
        script.onerror = () => reject(new Error("Failed to load EmailJS script"));
        document.head.appendChild(script);
    });
}

export async function sendOtpEmail(toEmail, code, purpose, userName = "there") {
    const purposeLabel = {
        register: "complete your registration",
        login: "sign in to your account",
        reset: "reset your password"
    }[purpose] || "verify your identity";

    if (!isEmailJsConfigured()) {
        console.warn("[OTP] EmailJS not configured. Dev OTP:", code);
        return { devMode: true, code };
    }

    const emailjs = await loadEmailJs();
    await emailjs.send(EMAILJS_CONFIG.serviceId, EMAILJS_CONFIG.templates.otp, {
        to_email: toEmail,
        user_email: toEmail,
        user_name: userName,
        otp_code: code,
        purpose_label: purposeLabel,
        expiry_minutes: "10"
    });
    return { devMode: false };
}

export async function createAndSendOtp(email, purpose, extra = {}) {
    const normalized = normalizeEmail(email);
    const code = generateOtpCode();
    const expiresAt = new Date(Date.now() + OTP_EXPIRY_MS);
    const ref = otpDocRef(normalized, purpose);

    await setDoc(ref, {
        email: normalized,
        purpose,
        code,
        expiresAt,
        verified: false,
        attempts: 0,
        createdAt: serverTimestamp(),
        ...extra
    });

    let sendResult = { devMode: true, code };
    try {
        sendResult = await sendOtpEmail(normalized, code, purpose, extra.userName || "there");
    } catch (emailErr) {
        console.error("[OTP] Email delivery failed (OTP still saved):", emailErr);
        sendResult = { devMode: true, code, emailFailed: true, emailError: emailErr.message };
    }

    return {
        otpId: ref.id,
        devMode: sendResult.devMode,
        code,
        emailFailed: sendResult.emailFailed || false,
        emailError: sendResult.emailError || null
    };
}

/** Read the current active OTP for on-screen display (e.g. invalid/unreachable email). */
export async function getActiveOtpCode(email, purpose) {
    const normalized = normalizeEmail(email);
    const snap = await getDoc(otpDocRef(normalized, purpose));
    if (!snap.exists()) return null;

    const data = snap.data();
    if (data.verified) return null;

    const expiresAt = data.expiresAt?.toDate?.() || new Date(data.expiresAt);
    if (expiresAt < new Date()) return null;

    return data.code || null;
}

export async function verifyOtp(email, purpose, inputCode) {
    const normalized = normalizeEmail(email);
    const ref = otpDocRef(normalized, purpose);
    const snap = await getDoc(ref);

    if (!snap.exists()) {
        return { success: false, error: "No active verification code found. Please request a new one." };
    }

    const data = snap.data();

    if (data.verified) {
        return { success: false, error: "This code was already used. Please request a new one." };
    }

    const expiresAt = data.expiresAt?.toDate?.() || new Date(data.expiresAt);
    if (expiresAt < new Date()) {
        return { success: false, error: "Verification code expired. Please request a new one." };
    }

    if (data.code !== inputCode.trim()) {
        const attempts = (data.attempts || 0) + 1;
        await updateDoc(ref, { attempts });
        if (attempts >= 5) {
            await updateDoc(ref, { verified: true, expiredByAttempts: true });
            return { success: false, error: "Too many incorrect attempts. Please request a new code." };
        }
        return { success: false, error: "Invalid verification code. Please try again." };
    }

    await updateDoc(ref, { verified: true, verifiedAt: serverTimestamp() });
    return { success: true, otpDocId: snap.id };
}

export async function resendOtp(email, purpose, extra = {}) {
    return createAndSendOtp(email, purpose, extra);
}
