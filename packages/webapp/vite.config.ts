import { createHash } from 'node:crypto';
import path from 'node:path';

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react-swc';
import { defineConfig } from 'vite';
import checker from 'vite-plugin-checker';
import svgr from 'vite-plugin-svgr';

import type { PluginOption } from 'vite';

// https://vitejs.dev/config/
export default defineConfig({
    plugins: [
        react(),
        svgr(),
        checker({
            typescript: true
        }),
        tailwindcss(),
        // When running on a non-standard port, serve a modified env.js so that
        // apiUrl is empty (relative), routing all API calls through the Vite proxy.
        {
            name: 'env-js-rewrite',
            configureServer(server) {
                // When running on a non-standard port, rewrite apiUrl so all API
                // requests go through the Vite proxy instead of cross-origin to 3003.
                server.middlewares.use('/env.js', (req, res, next) => {
                    const host = req.headers.host || 'localhost:3002';
                    const apiUrl = `http://${host}`;
                    fetch('http://localhost:3003/env.js')
                        .then((r) => r.text())
                        .then((text) => {
                            const rewritten = text.replace(/"apiUrl":\s*"[^"]*"/, `"apiUrl": "${apiUrl}"`);
                            res.setHeader('Content-Type', 'application/javascript');
                            res.end(rewritten);
                        })
                        .catch(() => next());
                });
            }
        }
    ] as PluginOption[],
    resolve: {
        alias: {
            '@': path.resolve(__dirname, './src'),
            // https://github.com/tabler/tabler-icons/issues/1233
            // /esm/icons/index.mjs only exports the icons statically, so no separate chunks are created
            '@tabler/icons-react': '@tabler/icons-react/dist/esm/icons/index.mjs'
        }
    },
    server: {
        proxy: {
            '/api': { target: 'http://localhost:3003', changeOrigin: true }
        }
    },
    define: {
        'import.meta.env.VITE_HASH': JSON.stringify(createHash('md5').update(Date.now().toString()).digest('hex').slice(0, 8))
    }
});
