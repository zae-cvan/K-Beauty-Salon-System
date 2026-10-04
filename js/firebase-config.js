// Import the functions you need from the Firebase SDKs
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";
import { getStorage } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-storage.js";

// We will put your actual API keys here in the next step!
export const firebaseConfig = {
  apiKey: "AIzaSyDK1hcurE0Txyof65RgL1A6g0auqj6n2cM",
  authDomain: "kbeauty-salon-system.firebaseapp.com",
  projectId: "kbeauty-salon-system",
  storageBucket: "kbeauty-salon-system.firebasestorage.app",
  messagingSenderId: "737114216305",
  appId: "1:737114216305:web:301f46c00af19f88ed48d0"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
export const storage = getStorage(app);

console.log("Firebase files are successfully connected!");