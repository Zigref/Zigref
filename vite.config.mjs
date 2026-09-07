import { defineConfig } from 'vite';

export default defineConfig({
    resolve: {
        alias: {
            react: 'preact/compat',
            'react-dom': 'preact/compat',
            'react-dom/client': 'preact/compat',
        },
    },
});
