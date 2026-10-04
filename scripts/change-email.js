// Usage:
//   node change-email.js <uid-or-email> <new-email>
//
// Prerequisites:
//   1. npm install (in this folder)
//   2. Firebase Console → Project settings → Service accounts →
//      "Generate new private key" → save the JSON as service-account.json
//      in this folder (or point GOOGLE_APPLICATION_CREDENTIALS at it).
//
// Example:
//   node change-email.js fakeuser@gmail.com realname@gmail.com

const { initializeApp, cert } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const path = require("path");

const [, , idOrEmail, newEmail] = process.argv;

if (!idOrEmail || !newEmail) {
    console.log("Usage: node change-email.js <uid-or-email> <new-email>");
    process.exit(1);
}

if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newEmail)) {
    console.error("Invalid new email:", newEmail);
    process.exit(1);
}

const keyPath = process.env.GOOGLE_APPLICATION_CREDENTIALS
    || path.join(__dirname, "service-account.json");

if (!require("fs").existsSync(keyPath)) {
    console.error("Service account key not found at:", keyPath);
    console.error("Download it from Firebase Console → Project settings → Service accounts → Generate new private key.");
    process.exit(1);
}

initializeApp({ credential: cert(keyPath) });

(async () => {
    const auth = getAuth();
    const user = idOrEmail.includes("@")
        ? await auth.getUserByEmail(idOrEmail)
        : await auth.getUser(idOrEmail);

    await auth.updateUser(user.uid, { email: newEmail, emailVerified: true });

    console.log("SUCCESS");
    console.log("  UID:      " + user.uid);
    console.log("  Old email:" + user.email);
    console.log("  New email:" + newEmail);
    console.log("Sign in with the new email now. The Firestore profile email was already updated separately.");
    process.exit(0);
})().catch((err) => {
    console.error("FAILED:", err.message);
    if (err.code === "auth/email-already-in-use") {
        console.error("That email belongs to another Auth account. Use a different email or delete that other account first.");
    }
    process.exit(1);
});