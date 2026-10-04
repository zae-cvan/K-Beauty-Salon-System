// Shared logout confirmation UI. It deliberately performs no authentication or
// navigation itself; each portal supplies its existing logout action.
let modalElements = null;
let pendingLogoutAction = null;
let previousFocus = null;
let isLoggingOut = false;

function createModal() {
    if (modalElements) return modalElements;

    const style = document.createElement('style');
    style.textContent = `
        .logout-confirmation-overlay { align-items:center; background:rgba(30,15,25,.45); display:none; inset:0; justify-content:center; padding:16px; position:fixed; z-index:10000; }
        .logout-confirmation-overlay.is-open { display:flex; }
        .logout-confirmation-dialog { background:#fff; border:1px solid #f2c8d9; border-radius:20px; box-shadow:0 20px 48px rgba(49,18,35,.24); box-sizing:border-box; color:#402a36; max-width:420px; outline:none; padding:26px; width:calc(100% - 32px); }
        .logout-confirmation-icon { align-items:center; background:#fff0f5; border-radius:50%; color:#bd356d; display:flex; font-size:19px; height:42px; justify-content:center; margin-bottom:15px; width:42px; }
        .logout-confirmation-dialog h2 { color:#402a36; font-size:20px; line-height:1.25; margin:0 0 8px; }
        .logout-confirmation-dialog p { color:#715b66; font-size:14px; line-height:1.5; margin:0; }
        .logout-confirmation-error { color:#b4234f !important; display:none; font-size:13px !important; margin-top:12px !important; }
        .logout-confirmation-error.is-visible { display:block; }
        .logout-confirmation-actions { display:flex; gap:10px; justify-content:flex-end; margin-top:24px; }
        .logout-confirmation-actions button { border-radius:10px; cursor:pointer; font-family:inherit; font-size:14px; font-weight:600; min-height:42px; padding:10px 17px; }
        .logout-confirmation-cancel { background:#fff; border:1px solid #e7a9c2; color:#5b3646; }
        .logout-confirmation-confirm { background:#bd356d; border:1px solid #bd356d; color:#fff; }
        .logout-confirmation-actions button:hover:not(:disabled) { filter:brightness(.96); }
        .logout-confirmation-actions button:focus-visible { outline:3px solid rgba(189,53,109,.3); outline-offset:2px; }
        .logout-confirmation-actions button:disabled { cursor:wait; opacity:.7; }
        @media (max-width:420px) { .logout-confirmation-dialog { border-radius:18px; padding:22px; width:100%; } .logout-confirmation-actions { flex-direction:column-reverse; } .logout-confirmation-actions button { width:100%; } }
    `;
    document.head.appendChild(style);

    const overlay = document.createElement('div');
    overlay.className = 'logout-confirmation-overlay';
    overlay.innerHTML = `
        <section class="logout-confirmation-dialog" role="dialog" aria-modal="true" aria-labelledby="logout-confirmation-title" aria-describedby="logout-confirmation-message" tabindex="-1">
            <div class="logout-confirmation-icon" aria-hidden="true"><i class="fas fa-right-from-bracket"></i></div>
            <h2 id="logout-confirmation-title">Confirm Logout</h2>
            <p id="logout-confirmation-message">Are you sure you want to log out?</p>
            <p class="logout-confirmation-error" role="alert">Unable to log out. Please try again.</p>
            <div class="logout-confirmation-actions">
                <button type="button" class="logout-confirmation-cancel">Cancel</button>
                <button type="button" class="logout-confirmation-confirm">Yes, Log Out</button>
            </div>
        </section>`;
    document.body.appendChild(overlay);

    const dialog = overlay.querySelector('.logout-confirmation-dialog');
    const cancelButton = overlay.querySelector('.logout-confirmation-cancel');
    const confirmButton = overlay.querySelector('.logout-confirmation-confirm');
    const errorMessage = overlay.querySelector('.logout-confirmation-error');

    const close = () => {
        if (isLoggingOut) return;
        overlay.classList.remove('is-open');
        pendingLogoutAction = null;
        previousFocus?.focus?.();
    };

    cancelButton.addEventListener('click', close);
    overlay.addEventListener('click', event => {
        if (event.target === overlay) close();
    });
    document.addEventListener('keydown', event => {
        if (event.key === 'Escape' && overlay.classList.contains('is-open')) close();
    });
    confirmButton.addEventListener('click', async () => {
        if (!pendingLogoutAction || isLoggingOut) return;
        isLoggingOut = true;
        confirmButton.disabled = true;
        cancelButton.disabled = true;
        confirmButton.textContent = 'Logging out...';
        errorMessage.classList.remove('is-visible');
        try {
            await pendingLogoutAction();
        } catch (error) {
            console.error('Logout failed:', error);
            isLoggingOut = false;
            confirmButton.disabled = false;
            cancelButton.disabled = false;
            confirmButton.textContent = 'Yes, Log Out';
            errorMessage.classList.add('is-visible');
        }
    });

    modalElements = { overlay, dialog, cancelButton, confirmButton, errorMessage };
    return modalElements;
}

export function openLogoutConfirmation(logoutAction) {
    if (typeof logoutAction !== 'function') return;
    const { overlay, cancelButton, confirmButton, errorMessage } = createModal();
    pendingLogoutAction = logoutAction;
    previousFocus = document.activeElement;
    isLoggingOut = false;
    confirmButton.disabled = false;
    cancelButton.disabled = false;
    confirmButton.textContent = 'Yes, Log Out';
    errorMessage.classList.remove('is-visible');
    overlay.classList.add('is-open');
    cancelButton.focus();
}
