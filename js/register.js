import { auth, db } from "./firebase-config.js";
import { createUserWithEmailAndPassword, fetchSignInMethodsForEmail } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-auth.js";
import { doc, setDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";
import { validatePassword, passwordsMatch, normalizeEmail } from "./auth-security.js";
import { setMfaVerified } from "./auth-guard.js";

const registerForm = document.getElementById("register-form");
const registerBtn = document.getElementById("register-btn");
const passwordInput = document.getElementById("password");
const confirmInput = document.getElementById("confirm-password");
const requirementsEl = document.getElementById("password-requirements");
const matchEl = document.getElementById("password-match-msg");
const registerMessage = document.getElementById("register-message");

function renderPasswordRequirements() {
    if (!requirementsEl || !passwordInput) return;
    const { checks } = validatePassword(passwordInput.value);
    const items = [
        { key: "minLength", label: "At least 8 characters" },
        { key: "uppercase", label: "At least 1 uppercase letter" },
        { key: "lowercase", label: "At least 1 lowercase letter" },
        { key: "number", label: "At least 1 number" },
        { key: "special", label: "At least 1 special character (!@#$%^&*()_+)" },
        { key: "notCommon", label: "Not a common password" }
    ];
    requirementsEl.innerHTML = items.map(item => `
        <li class="${checks[item.key] ? "met" : "unmet"}">
            <i class="fas ${checks[item.key] ? "fa-check-circle" : "fa-circle"}"></i>
            ${item.label}
        </li>
    `).join("");
}

function updatePasswordMatch() {
    if (!matchEl || !confirmInput) return;
    if (!confirmInput.value) {
        matchEl.textContent = "";
        matchEl.className = "password-match-msg";
        return;
    }
    if (passwordsMatch(passwordInput.value, confirmInput.value)) {
        matchEl.textContent = "Passwords match";
        matchEl.className = "password-match-msg match-ok";
    } else {
        matchEl.textContent = "Passwords do not match";
        matchEl.className = "password-match-msg match-error";
    }
}

passwordInput?.addEventListener("input", () => {
    renderPasswordRequirements();
    updatePasswordMatch();
});
confirmInput?.addEventListener("input", updatePasswordMatch);
renderPasswordRequirements();

function showRegisterMessage(msg, type = "error") {
    if (!registerMessage) return;
    registerMessage.textContent = msg;
    registerMessage.className = `auth-message auth-message--${type}`;
    registerMessage.style.display = "block";
}

if (registerForm) {
    registerForm.addEventListener("submit", async (e) => {
        e.preventDefault();

        const fullName = document.getElementById("fullname").value.trim();
        const email = normalizeEmail(document.getElementById("email").value);
        const password = passwordInput.value;
        const confirmPassword = confirmInput.value;
        const phone = document.getElementById("phone")?.value.trim() || "";
        const dateOfBirth = document.getElementById("birthday").value;
        const gender = document.getElementById("gender").value;
        const skinType = document.getElementById("skinType").value;
        const hairType = document.getElementById("hairType").value;
        const allergies = document.getElementById("allergies").value.trim();
        const beautyNotes = document.getElementById("beautyNotes").value.trim();
        const termsAccepted = document.getElementById("acceptTerms")?.checked;

        if (!dateOfBirth || !gender || !skinType || !hairType) {
            showRegisterMessage("Please complete all required personal and beauty preference fields.");
            return;
        }

        if (!termsAccepted) {
            showRegisterMessage("Please read and accept the Terms & Conditions.");
            return;
        }

        const pwdResult = validatePassword(password);
        if (!pwdResult.valid) {
            showRegisterMessage("Password does not meet security requirements.");
            return;
        }

        if (!passwordsMatch(password, confirmPassword)) {
            showRegisterMessage("Password and confirmation do not match.");
            return;
        }

        try {
            registerBtn.disabled = true;
            registerBtn.textContent = "Creating Account…";

            let methods = [];
            try {
                methods = await fetchSignInMethodsForEmail(auth, email);
            } catch (authCheckErr) {
                console.warn("Could not check existing account:", authCheckErr);
            }
            if (methods.length > 0) {
                showRegisterMessage("An account with this email already exists. Please sign in instead.");
                return;
            }

            const credential = await createUserWithEmailAndPassword(auth, email, password);
            const user = credential.user;

            await setDoc(doc(db, "users", user.uid), {
                uid: user.uid,
                fullName: fullName,
                email: email,
                role: "Client",
                phone: phone,
                dateOfBirth: dateOfBirth,
                gender: gender,
                skinType: skinType,
                hairType: hairType,
                allergies: allergies,
                beautyNotes: beautyNotes,
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

            setMfaVerified(user.uid);
            showRegisterMessage("Account created successfully! Redirecting…", "success");
            setTimeout(() => { window.location.href = "pages/client-dashboard.html"; }, 1200);
        } catch (error) {
            console.error("Registration Error:", error);
            let msg = error.message || "Registration failed. Please try again.";
            if (error.code === "auth/email-already-in-use") {
                msg = "This email is already registered. Please sign in instead.";
            } else if (error.code === "permission-denied" || msg.includes("permission")) {
                msg = "Database permission error. Publish firestore.rules in Firebase Console (Firestore → Rules).";
            }
            showRegisterMessage(msg);
        } finally {
            registerBtn.disabled = false;
            registerBtn.textContent = "Create Account";
        }
    });
}
