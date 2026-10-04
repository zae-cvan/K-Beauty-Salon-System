import { auth, db } from "./firebase-config.js";
import { signInWithEmailAndPassword, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-auth.js";
import { doc, getDoc } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";

// -------------------------------------------------------------
// 1. HANDLE LOGIN FORM SUBMISSION
// -------------------------------------------------------------
const loginForm = document.getElementById("login-form");

if (loginForm) {
    loginForm.addEventListener("submit", async (e) => {
        e.preventDefault();

        const email = document.getElementById("login-email").value.trim();
        const password = document.getElementById("login-password").value;

        try {
            // Attempt Firebase Auth sign-in
            const userCredential = await signInWithEmailAndPassword(auth, email, password);
            const user = userCredential.user;

            // Fetch user role from Firestore 'users' collection
            await routeUserByRole(user.uid);

        } catch (error) {
            console.error("Login Error:", error);
            alert("Login Failed: " + error.message);
        }
    });
}

// -------------------------------------------------------------
// 2. ROLE-BASED ROUTING HELPER
// -------------------------------------------------------------
async function routeUserByRole(uid) {
    try {
        const userDocRef = doc(db, "users", uid);
        const userDocSnap = await getDoc(userDocRef);

        if (userDocSnap.exists()) {
            const userData = userDocSnap.data();
            const role = userData.role;

            // Route based on user role from root directory
            const staffRoles = ["Staff", "Stylist", "Receptionist", "General Staff", "Manager"];
            if (role === "Admin") {
                window.location.href = "pages/admin-dashboard.html";
            } else if (staffRoles.includes(role)) {
                window.location.href = "pages/staff-dashboard.html";
            } else if (role === "Client") {
                window.location.href = "pages/client-dashboard.html";
            } else {
                alert("Unknown user role assigned: " + role);
            }
        } else {
            alert("No user profile record found in database for this account.");
        }
    } catch (error) {
        console.error("Role Fetch Error:", error);
        alert("Error fetching user profile: " + error.message);
    }
}

// -------------------------------------------------------------
// 3. AUTO-REDIRECT IF ALREADY LOGGED IN
// -------------------------------------------------------------
onAuthStateChanged(auth, (user) => {
    // Only auto-redirect if we are currently on the login or register root pages
    const currentPath = window.location.pathname;
    if (user && (currentPath.endsWith("index.html") || currentPath.endsWith("register.html") || currentPath === "/")) {
        routeUserByRole(user.uid);
    }
});