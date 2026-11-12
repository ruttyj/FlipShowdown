// Self-contained HTML for /login. Every interpolated value goes through escapeHtml.

export function escapeHtml(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}

// Matches the app's slate-900 / indigo-900 / purple-900 background.
const STYLES = `
    * { box-sizing: border-box; }
    body {
        margin: 0;
        min-height: 100vh;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 16px;
        font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
        color: #f8fafc;
        background: linear-gradient(135deg, #0f172a 0%, #312e81 50%, #581c87 100%);
    }
    .card {
        width: 100%;
        max-width: 380px;
        padding: 28px 24px;
        border-radius: 16px;
        background: rgba(15, 23, 42, 0.6);
        border: 1px solid rgba(255, 255, 255, 0.12);
        box-shadow: 0 20px 50px rgba(0, 0, 0, 0.4);
    }
    h1 {
        margin: 0 0 4px;
        font-size: 1.75rem;
        background: linear-gradient(90deg, #fbbf24, #f472b6);
        -webkit-background-clip: text;
        background-clip: text;
        color: transparent;
    }
    p { margin: 0 0 20px; color: #cbd5e1; line-height: 1.5; }
    label { display: block; margin: 14px 0 6px; font-size: 0.9rem; color: #e2e8f0; }
    input {
        width: 100%;
        padding: 12px;
        font-size: 1rem;
        border-radius: 10px;
        border: 1px solid rgba(255, 255, 255, 0.2);
        background: rgba(15, 23, 42, 0.7);
        color: #f8fafc;
    }
    input:focus { outline: 2px solid #a78bfa; outline-offset: 1px; }
    button {
        width: 100%;
        margin-top: 22px;
        padding: 12px;
        font-size: 1rem;
        font-weight: 600;
        border: 0;
        border-radius: 10px;
        color: #fff;
        background: linear-gradient(90deg, #7c3aed, #db2777);
        cursor: pointer;
    }
    .error {
        margin: 0 0 12px;
        padding: 10px 12px;
        border-radius: 8px;
        background: rgba(220, 38, 38, 0.2);
        color: #fecaca;
    }
    .hint { margin: 16px 0 0; font-size: 0.8rem; color: #94a3b8; }
`;

function renderDocument(title, bodyHtml) {
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>
<style>${STYLES}</style>
</head>
<body>
<main class="card">
${bodyHtml}
</main>
</body>
</html>`;
}

/**
 * Dev-mode login form. `values` = { fromUrl, email, fullName, error } (all optional);
 * they're echoed back so a failed submit keeps what the user typed.
 */
export function renderDevLoginPage(values = {}) {
    let errorHtml = '';
    if (values.error) {
        errorHtml = `<div class="error" role="alert">${escapeHtml(values.error)}</div>`;
    }

    return renderDocument('Sign in - Flip Showdown', `
<h1>Flip Showdown</h1>
<p>Development sign-in. No password needed &mdash; pick any email to play as.</p>
${errorHtml}
<form method="post" action="/login">
    <input type="hidden" name="from_url" value="${escapeHtml(values.fromUrl)}">
    <label for="email">Email</label>
    <input id="email" name="email" type="email" required autocomplete="email" autofocus value="${escapeHtml(values.email)}">
    <label for="full_name">Display name (optional)</label>
    <input id="full_name" name="full_name" type="text" maxlength="100" autocomplete="nickname" value="${escapeHtml(values.fullName)}">
    <button type="submit">Sign in</button>
</form>
<p class="hint">Use a different browser or a private window to sign in as another player.</p>`);
}

/** Shown in cloudflare mode when a request reaches /login without a valid Access token. */
export function renderCloudflareInfoPage() {
    return renderDocument('Sign in - Flip Showdown', `
<h1>Flip Showdown</h1>
<p>Sign-in is handled by Cloudflare Access. Open the app through its Cloudflare URL to sign in.</p>`);
}
