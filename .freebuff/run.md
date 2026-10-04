# Run doc — K-Beauty Salon (static site)

## 1. Reproduce uncommitted artifacts

None required. This is a plain static site (HTML/CSS/JS + Firebase CDN modules):
there is no build step, no lockfile, no `.env` to copy from the main checkout.

Only external runtime dependencies are CDNs (Google Fonts, Font Awesome,
Chart.js, jsPDF, Firebase), so a network connection is needed to render.

## 2. Run the preview server

The dashboards live in `pages/` and reference assets as `../css`, `../js`,
`../images`, so the server must be rooted at the **workspace root** (not at
`pages/`), otherwise every external stylesheet/script 404s.

```sh
node .freebuff/static-server.mjs        # default port 4173
node .freebuff/static-server.mjs 4600   # or pick a port
```

Then open e.g. `http://127.0.0.1:4173/pages/admin-dashboard.html`.

Portal entry points:

| Portal | Path                                  |
|--------|---------------------------------------|
| Admin  | `/pages/admin-dashboard.html`         |
| Staff  | `/pages/staff-dashboard.html`         |
| Client | `/pages/client-dashboard.html`         |
| Login  | `/index.html`                         |

Note: the dashboards are protected by Firebase Auth (`js/admin.js`,
`js/client.js`, `js/staff.js` redirect to `../index.html` when signed out), so
visiting a dashboard without a session lands on the login page.

The script is dependency-free (`node:http`, `node:fs`), logs requests to
stdout, and sends `Cache-Control: no-store` so edits show on reload.

### Dev-only no-login route

Dashboards redirect to `../index.html` when signed out. To preview their markup
and CSS without a Firebase session, prefix any path with `/__dev/`:

```
http://127.0.0.1:4173/__dev/pages/admin-dashboard.html
http://127.0.0.1:4173/__dev/pages/staff-dashboard.html
http://127.0.0.1:4173/__dev/pages/client-dashboard.html
```

That route strips external `<script type="module">` tags (the auth guards) from
the served HTML only. Product files are never modified; signed-in behavior is
unchanged. Regions filled by JS at runtime render empty in this mode.
