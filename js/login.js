import { auth, db } from "./firebase-config.js";
import {
    signInWithEmailAndPassword, sendPasswordResetEmail, fetchSignInMethodsForEmail
} from "https://www.gstatic.com/firebasejs/10.8.1/firebase-auth.js";
import { doc, getDoc, setDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";
import { checkLoginLockout, recordFailedLogin, resetLoginAttempts } from "./login-lockout.js";
import { normalizeEmail } from "./auth-security.js";
import { setMfaVerified } from "./auth-guard.js";

const STAFF_ROLES = ["Staff", "Stylist", "Receptionist", "General Staff", "Manager"];

export async function handleLogin(email, password) {
    const normalized = normalizeEmail(email);

    const lockout = await checkLoginLockout(normalized);
    if (!lockout.allowed) {
        throw new Error(lockout.message);
    }

    try {
        const credential = await signInWithEmailAndPassword(auth, normalized, password);
        const user = credential.user;

        try {
            await resetLoginAttempts(normalized);
        } catch (lockoutErr) {
            console.warn("Could not reset lockout counter (non-blocking):", lockoutErr);
        }

        const userDoc = await getDoc(doc(db, "users", user.uid));
        let profile = userDoc.exists() ? userDoc.data() : {};

        if (!userDoc.exists()) {
            try {
                await setDoc(doc(db, "users", user.uid), {
                    uid: user.uid,
                    fullName: user.displayName || "Client",
                    email: normalized,
                    role: "Client",
                    phone: user.phoneNumber || "",
                    emailVerified: user.emailVerified,
                    createdAt: serverTimestamp()
                });
                profile = { fullName: user.displayName || "Client", role: "Client" };
                console.warn("Self-healed missing user profile for", normalized);
            } catch (healErr) {
                console.warn("Could not create missing user profile:", healErr);
            }
        }
        const userName = profile.fullName || user.displayName || "there";

        if (profile.deleted === true) {
            await auth.signOut();
            throw new Error("This account has been deactivated. Please contact the salon.");
        }

        setMfaVerified(user.uid);
        return {
            requiresMfa: false,
            uid: user.uid,
            role: profile.role || "Client"
        };
    } catch (error) {
        if (error.code === "auth/invalid-credential" ||
            error.code === "auth/wrong-password" ||
            error.code === "auth/user-not-found") {
            const result = await recordFailedLogin(normalized);
            throw new Error(result.message || "Invalid email or password.");
        }
        if (error.code === "permission-denied" || (error.message && error.message.includes("permission"))) {
            throw new Error(
                "Database permission error. Publish the latest Firestore rules in Firebase Console (Firestore → Rules)."
            );
        }
        throw error;
    }
}

export async function routeUserAfterMfa(uid, role) {
    if (role === "Admin") {
        window.location.href = "pages/admin-dashboard.html";
    } else if (STAFF_ROLES.includes(role)) {
        window.location.href = "pages/staff-dashboard.html";
    } else {
        window.location.href = "pages/client-dashboard.html";
    }
}

export async function handleForgotPassword(email) {
    const normalized = normalizeEmail(email);
    if (!normalized) throw new Error("Please enter your email address.");

    const methods = await fetchSignInMethodsForEmail(auth, normalized);
    if (!methods.length) {
        throw new Error("If an account exists for this email, a reset link will be sent.");
    }

    await sendPasswordResetEmail(auth, normalized);
    return "A password reset link has been sent. Please check your inbox and spam folder.";
}

export function showAuthMessage(el, message, type = "error") {
    if (!el) return;
    el.textContent = message;
    el.className = `auth-message auth-message--${type}`;
    el.style.display = "block";
}

export function hideAuthMessage(el) {
    if (el) el.style.display = "none";
}
