import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
export default defineConfig({ plugins: [react({ jsxRuntime: 'automatic' })], esbuild: { jsx: 'automatic' }, test: { environment: 'jsdom', setupFiles: './src/test-setup.ts', css: true } });
