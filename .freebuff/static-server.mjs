/**
 * Minimal dependency-free static file server for previewing this project.
 *
 * Root = the workspace root, so pages/admin-dashboard.html can resolve its
 * ../css, ../js and ../images references (those escape any root that is not
 * the workspace root). No build step, no npm install.
 *
 * Usage:  node .freebuff/static-server.mjs [port]
 * Default port: 4173
 *
 * Dev-only route:  /__dev/<path>
 *   Same files, but external `<script type="module">` tags are stripped from
 *   HTML so the Firebase auth guards (admin.js / staff.js / client.js /
 *   payroll.js) do not bounce a signed-out viewer to the login page. This is
 *   PREVIEW ONLY — it lives in this thread's tooling, never in product code.
 */
import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.argv[2] || process.env.PORT || 4173);

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.htm': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.txt': 'text/plain; charset=utf-8',
    '.md': 'text/markdown; charset=utf-8',
    '.pdf': 'application/pdf',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
};

const server = http.createServer(async (req, res) => {
    try {
        let pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
        const devMode = pathname.startsWith('/__dev/');
        if (devMode) pathname = pathname.slice('/__dev'.length);
        if (pathname.endsWith('/')) pathname += 'index.html';

        const filePath = path.resolve(ROOT, '.' + pathname);
        if (filePath !== ROOT && !filePath.startsWith(ROOT + path.sep)) {
            res.writeHead(403, { 'Content-Type': 'text/plain' });
            return res.end('403 Forbidden');
        }

        let stat;
        try {
            stat = await fs.stat(filePath);
        } catch {
            stat = null;
        }

        if (stat && stat.isDirectory()) {
            return serveFile(path.join(filePath, 'index.html'), res, req, devMode);
        }
        return serveFile(filePath, res, req, devMode);
    } catch (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('500 ' + err.message);
    }
});

async function serveFile(filePath, res, req, devMode = false) {
    let data;
    try {
        data = await fs.readFile(filePath);
    } catch {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('404 Not Found: ' + path.relative(ROOT, filePath));
    }
    const ext = path.extname(filePath).toLowerCase();
    if (devMode && (ext === '.html' || ext === '.htm')) {
        data = stripAuthModules(data.toString('utf8'));
    }
    const type = MIME[ext] || 'application/octet-stream';
    res.writeHead(200, {
        'Content-Type': type,
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*',
    });
    if (req.method === 'HEAD') return res.end();
    res.end(data);
}

/** Remove external module scripts (the Firebase auth guards + data loaders). */
function stripAuthModules(html) {
    return html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, (tag) => {
        const isModule = /\btype\s*=\s*["']module["']/i.test(tag);
        const isExternal = /\bsrc\s*=/.test(tag);
        return isModule && isExternal ? '<!-- dev-preview: auth module script removed -->' : tag;
    });
}

server.listen(PORT, '127.0.0.1', () => {
    console.log(`static-server listening on http://127.0.0.1:${PORT}/ (root: ${ROOT})`);
});
server.on('error', (err) => {
    console.error('static-server failed:', err.message);
    process.exit(1);
});
