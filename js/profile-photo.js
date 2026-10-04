import { db, storage } from "./firebase-config.js";
import { doc, setDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";
import { ref, uploadBytes, getDownloadURL } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-storage.js";

export function isValidImageFile(file) {
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/jpg'];
    const ext = file.name.split('.').pop()?.toLowerCase() || '';
    const validExt = ['jpg', 'jpeg', 'png', 'webp'];
    return allowed.includes(file.type) || validExt.includes(ext);
}

export function compressImageFile(file, maxDim = 480, quality = 0.85) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
            const img = new Image();
            img.onload = () => {
                let { width, height } = img;
                const scale = Math.min(1, maxDim / Math.max(width, height));
                width = Math.max(1, Math.round(width * scale));
                height = Math.max(1, Math.round(height * scale));
                const canvas = document.createElement('canvas');
                canvas.width = width;
                canvas.height = height;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0, width, height);
                resolve(canvas.toDataURL('image/jpeg', quality));
            };
            img.onerror = () => reject(new Error('Could not read image'));
            img.src = reader.result;
        };
        reader.onerror = () => reject(new Error('Could not read file'));
        reader.readAsDataURL(file);
    });
}

async function dataUrlToBlob(dataUrl) {
    const res = await fetch(dataUrl);
    return res.blob();
}

/**
 * Uploads + compresses a profile photo for a user and persists the URL
 * on their users/{uid} document (photoURL). Falls back to a data URL if
 * Storage is unavailable.
 */
export async function saveUserProfilePhoto(uid, file, storagePath = 'profilePhotos') {
    if (!uid || !file) throw new Error('Missing user or file.');
    if (!isValidImageFile(file)) throw new Error('Please upload a JPG, PNG, or WebP image.');
    if (file.size > 5 * 1024 * 1024) throw new Error('Image must be 5 MB or smaller.');

    const dataUrl = await compressImageFile(file);
    let url;
    try {
        const blob = await dataUrlToBlob(dataUrl);
        const storageRef = ref(storage, `${storagePath}/${uid}`);
        await uploadBytes(storageRef, blob, { contentType: 'image/jpeg' });
        url = await getDownloadURL(storageRef);
    } catch (storageErr) {
        console.warn('Firebase Storage unavailable, saving data URL to profile.', storageErr);
        if (dataUrl.length > 900000) {
            throw new Error('Image is still too large after compression. Try a smaller photo.');
        }
        url = dataUrl;
    }

    await setDoc(doc(db, "users", uid), { photoURL: url, updatedAt: serverTimestamp() }, { merge: true });
    return url;
}

/**
 * Compresses and uploads a service image. The returned URL is intentionally
 * not persisted here so the caller can update the matching service document.
 * A compact data URL is used when Firebase Storage is not available.
 */
export async function saveServiceImage(serviceId, file) {
    if (!serviceId || !file) throw new Error('Missing service or image.');
    if (!isValidImageFile(file)) throw new Error('Please upload a JPG, PNG, or WebP image.');
    if (file.size > 5 * 1024 * 1024) throw new Error('Image must be 5 MB or smaller.');

    const dataUrl = await compressImageFile(file, 960, 0.86);
    try {
        const blob = await dataUrlToBlob(dataUrl);
        const storageRef = ref(storage, `serviceImages/${serviceId}`);
        await uploadBytes(storageRef, blob, { contentType: 'image/jpeg' });
        return await getDownloadURL(storageRef);
    } catch (storageErr) {
        console.warn('Firebase Storage unavailable, saving compact service image to Firestore.', storageErr);
        if (dataUrl.length > 900000) {
            throw new Error('Image is still too large after compression. Try a smaller image.');
        }
        return dataUrl;
    }
}

export function applyAvatarImage(url, el, fallbackInitial = 'A') {
    if (!el) return;
    if (url) {
        el.style.backgroundImage = `url(${url})`;
        el.classList.add('has-photo');
        el.textContent = '';
    } else {
        el.style.backgroundImage = '';
        el.classList.remove('has-photo');
        el.textContent = fallbackInitial;
    }
}
