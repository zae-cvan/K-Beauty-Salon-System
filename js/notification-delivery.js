/**
 * Email notifications via EmailJS (in addition to in-app Firestore notifications).
 */
import { EMAILJS_CONFIG, isEmailJsConfigured } from "./emailjs-config.js";
import { db } from "./firebase-config.js";
import { doc, getDoc } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";

async function loadEmailJs() {
    if (window.emailjs) return window.emailjs;
    return new Promise((resolve, reject) => {
        if (document.querySelector('script[src*="emailjs"]')) {
            const wait = setInterval(() => {
                if (window.emailjs) { clearInterval(wait); resolve(window.emailjs); }
            }, 50);
            return;
        }
        const script = document.createElement("script");
        script.src = "https://cdn.jsdelivr.net/npm/@emailjs/browser@4/dist/email.min.js";
        script.onload = () => {
            if (isEmailJsConfigured()) window.emailjs.init({ publicKey: EMAILJS_CONFIG.publicKey });
            resolve(window.emailjs);
        };
        script.onerror = reject;
        document.head.appendChild(script);
    });
}

export async function getUserContact(userId) {
    if (!userId || userId === "admin" || userId === "staff") return null;
    const snap = await getDoc(doc(db, "users", userId));
    if (!snap.exists()) return null;
    const data = snap.data();
    return { email: data.email || "", name: data.fullName || data.email || "Client" };
}

export async function sendEmailNotification(toEmail, subject, message, userName = "Client") {
    if (!toEmail || !isEmailJsConfigured()) return false;
    try {
        const emailjs = await loadEmailJs();
        await emailjs.send(EMAILJS_CONFIG.serviceId, EMAILJS_CONFIG.templates.notification, {
            to_email: toEmail,
            user_name: userName,
            subject,
            message
        });
        return true;
    } catch (err) {
        console.error("[Notification] Email failed:", err);
        return false;
    }
}

export async function deliverNotification(recipientId, message, subject = "K-Beauty Salon Update") {
    const contact = await getUserContact(recipientId);
    if (!contact?.email) return { email: false };
    const emailSent = await sendEmailNotification(contact.email, subject, message, contact.name);
    return { email: emailSent };
}
