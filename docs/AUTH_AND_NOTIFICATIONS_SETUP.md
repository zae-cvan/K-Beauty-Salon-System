# Auth & Email Notifications Setup

## Overview

- **Registration:** instant account creation (password-only, no email verification step)
- **Login:** password sign-in, straight to the portal (OTP MFA removed)
- **Lockout:** 5 failed attempts → 10 minute lockout per email
- **Notifications:** in-app Firestore + optional EmailJS emails

> **Re-enabling OTP later:** the OTP flow files (`js/otp-service.js`,
> `js/verify-otp.js`, `verify-otp.html`, `js/emailjs-config.js`) are still in
> the repo. To restore email verification, re-add the `otpVerifications`
> rule below and the OTP steps in `js/register.js` / `js/login.js`.

## Firestore Rules (required)

Publish these rules in **Firebase Console → Firestore → Rules**:

```
match /loginAttempts/{attemptId} {
  allow read, create, update, delete: if true;
}
```

These are already in `firestore.rules` at the project root — copy/publish the full file.

## EmailJS

Keys are in `js/emailjs-config.js`. Templates should include:

| Template | Variables |
|----------|-----------|
| Notification | `to_email`, `user_name`, `subject`, `message` |

## Files

| File | Purpose |
|------|---------|
| `js/auth-security.js` | Password policy, lockout helpers |
| `js/login.js` | Login + forgot password |
| `js/auth-guard.js` | Session guard for dashboards |
| `js/login-lockout.js` | Brute-force tracking |
| `js/notification-delivery.js` | Email notifications |

## Admin: Unlock locked accounts

In **Admin → Users**, click **Unlock** next to a user to clear their login lockout.