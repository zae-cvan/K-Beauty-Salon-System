import { auth, db } from "./firebase-config.js";
import { createUserWithEmailAndPassword } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-auth.js";
import { doc, setDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";
import { verifyOtp, resendOtp, getActiveOtpCode } from "./otp-service.js";
import { setMfaVerified } from "./auth-guard.js";
import { routeUserAfterMfa, showAuthMessage, hideAuthMessage } from "./login.js";

const params = new URLSearchParams(window.location.search);
const purpose = params.get("purpose") || "login";
const email = decodeURIComponent(params.get("email") || sessionStorage.getItem("pendingLoginEmail") || "");
const reason = params.get("reason");

const otpForm = document.getElementById("otp-form");
const verifyBtn = document.getElementById("otp-verify-btn");
const resendBtn = document.getElementById("otp-resend-btn");
const messageEl = document.getElementById("otpMessage");
const visibleOtpBanner = document.getElementById("visibleOtpBanner");
const otpDigits = [...document.querySelectorAll(".otp-digit")];

function renderVisibleOtp(code) {
    if (!visibleOtpBanner || !code) return;
    let note = "Enter this code below. Shown here for accounts that cannot receive email.";
    try {
        const emailFailed = JSON.parse(sessionStorage.getItem("otpEmailFailed") || "null");
        if (emailFailed?.error) {
            note = `The email could not be delivered (${emailFailed.error}). Use this code to continue.`;
        }
    } catch (err) { /* ignore malformed flag */ }
    visibleOtpBanner.style.display = "block";
    visibleOtpBanner.innerHTML = `
        <p class="otp-visible-label">Your verification code</p>
        <p class="otp-visible-code" aria-label="Verification code ${code.split("").join(" ")}">${code}</p>
        <p class="otp-visible-note">${note}</p>
    `;
}

async function loadAndShowOtp() {
    let code = sessionStorage.getItem("devOtpHint");
    if (!code && email) {
        try {
            code = await getActiveOtpCode(email, purpose);
            if (code) sessionStorage.setItem("devOtpHint", code);
        } catch (err) {
            console.warn("Could not load OTP for display:", err);
        }
    }
    renderVisibleOtp(code);
}

if (!email) {
    window.location.href = purpose === "register" ? "register.html" : "index.html";
}

document.getElementById("otpEmailDisplay").textContent = email;
document.getElementById("otpTitle").textContent =
    purpose === "register" ? "Verify your email to register" :
    purpose === "login" ? "Two-factor authentication" : "Enter verification code";

document.getElementById("otpBackLink").href = purpose === "register" ? "register.html" : "index.html";

if (reason === "mfa_required") {
    showAuthMessage(messageEl, "Please complete email verification to continue.", "info");
}

loadAndShowOtp();

otpDigits.forEach((input, i) => {
    input.addEventListener("input", (e) => {
        e.target.value = e.target.value.replace(/\D/g, "").slice(0, 1);
        if (e.target.value && i < otpDigits.length - 1) otpDigits[i + 1].focus();
    });
    input.addEventListener("keydown", (e) => {
        if (e.key === "Backspace" && !e.target.value && i > 0) otpDigits[i - 1].focus();
    });
    input.addEventListener("paste", (e) => {
        e.preventDefault();
        const pasted = (e.clipboardData.getData("text") || "").replace(/\D/g, "").slice(0, 6);
        pasted.split("").forEach((char, j) => { if (otpDigits[j]) otpDigits[j].value = char; });
        if (pasted.length === 6) otpDigits[5].focus();
    });
});

function getOtpValue() {
    return otpDigits.map(i => i.value).join("");
}

otpForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const code = getOtpValue();
    if (code.length !== 6) {
        showAuthMessage(messageEl, "Please enter the full 6-digit code.", "error");
        return;
    }

    verifyBtn.disabled = true;
    verifyBtn.textContent = "Verifying…";
    hideAuthMessage(messageEl);

    try {
        const result = await verifyOtp(email, purpose, code);
        if (!result.success) {
            showAuthMessage(messageEl, result.error, "error");
            return;
        }

        if (purpose === "register") {
            await completeRegistration();
        } else if (purpose === "login") {
            await completeLoginMfa();
        }
    } catch (err) {
        console.error(err);
        let msg = err.message || "Verification failed.";
        if (err.code === "auth/email-already-in-use") {
            msg = "This email is already registered. Please sign in instead.";
        } else if (err.code === "permission-denied" || msg.includes("permission")) {
            msg = "Could not save your profile. Publish Firestore rules in Firebase Console.";
        }
        showAuthMessage(messageEl, msg, "error");
    } finally {
        verifyBtn.disabled = false;
        verifyBtn.textContent = "Verify Code";
    }
});

async function completeRegistration() {
    const raw = sessionStorage.getItem("pendingRegistration");
    if (!raw) {
        showAuthMessage(messageEl, "Registration session expired. Please register again.", "error");
        setTimeout(() => window.location.href = "register.html", 2000);
        return;
    }

    const data = JSON.parse(raw);
    let user;
    try {
        const credential = await createUserWithEmailAndPassword(auth, data.email, data.password);
        user = credential.user;

        await setDoc(doc(db, "users", user.uid), {
            uid: user.uid,
            fullName: data.fullName,
            email: data.email,
            role: "Client",
            phone: data.phone || "",
            dateOfBirth: data.dateOfBirth,
            gender: data.gender,
            skinType: data.skinType,
            hairType: data.hairType,
            allergies: data.allergies || "",
            beautyNotes: data.beautyNotes || "",
            preferredStylistId: "",
            emailReminders: true,
            promoEmails: false,
            emailVerified: true,
            emailVerifiedAt: serverTimestamp(),
            termsAccepted: true,
            termsVersion: "2026-08-12",
            termsAcceptedAt: serverTimestamp(),
            createdAt: serverTimestamp()
        });
    } catch (err) {
        console.error("completeRegistration:", err);
        if (err.code === "auth/email-already-in-use") {
            showAuthMessage(messageEl, "This email is already registered. Please sign in instead.", "error");
        } else if (err.code === "permission-denied" || (err.message && err.message.includes("permission"))) {
            showAuthMessage(messageEl, "Could not save profile. Publish Firestore rules, then try signing in.", "error");
        } else {
            showAuthMessage(messageEl, err.message || "Could not create account.", "error");
        }
        return;
    }

    sessionStorage.removeItem("pendingRegistration");
    sessionStorage.removeItem("devOtpHint");
    setMfaVerified(user.uid);
    showAuthMessage(messageEl, "Account created successfully! Redirecting…", "success");
    setTimeout(() => { window.location.href = "pages/client-dashboard.html"; }, 1200);
}

async function completeLoginMfa() {
    const uid = sessionStorage.getItem("pendingLoginUid");
    const role = sessionStorage.getItem("pendingLoginRole") || "Client";

    if (!uid) {
        showAuthMessage(messageEl, "Login session expired. Please sign in again.", "error");
        setTimeout(() => window.location.href = "index.html", 2000);
        return;
    }

    setMfaVerified(uid);
    sessionStorage.removeItem("pendingLoginEmail");
    sessionStorage.removeItem("pendingLoginUid");
    sessionStorage.removeItem("pendingLoginRole");

    showAuthMessage(messageEl, "Verified! Redirecting to your portal…", "success");
    setTimeout(() => routeUserAfterMfa(uid, role), 1000);
}

resendBtn.addEventListener("click", async () => {
    resendBtn.disabled = true;
    try {
        const extra = purpose === "register"
            ? { userName: JSON.parse(sessionStorage.getItem("pendingRegistration") || "{}").fullName || "there" }
            : { userName: "there", uid: sessionStorage.getItem("pendingLoginUid") };
        const result = await resendOtp(email, purpose, extra);
        if (result.code) {
            sessionStorage.setItem("devOtpHint", result.code);
            renderVisibleOtp(result.code);
        }
        showAuthMessage(messageEl, result.code
            ? "A new code is shown above."
            : "A new code has been sent.", "success");
    } catch (err) {
        showAuthMessage(messageEl, err.message || "Could not resend code.", "error");
    } finally {
        resendBtn.disabled = false;
    }
});

otpDigits[0]?.focus();
