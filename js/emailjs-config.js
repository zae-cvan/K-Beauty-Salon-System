/**
 * EmailJS configuration
 */
export const EMAILJS_CONFIG = {
    publicKey: "i0Saur_5NLSeqnrUw",
    serviceId: "service_upsd4p7",
    templates: {
        otp: "template_mm8tthp",
        notification: "template_glmnf26"
    }
};

export function isEmailJsConfigured() {
    return !EMAILJS_CONFIG.publicKey.startsWith("YOUR_");
}
