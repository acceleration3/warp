import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Output goes straight into the Electron app's renderer folder; the Android
// shell copies the same bundle into its Capacitor webDir.
export default defineConfig({
  plugins: [react()],
  base: './',
  build: {
    outDir: '../../apps/desktop/dist/renderer',
    emptyOutDir: true,
    target: 'chrome120',
  },
  server: { port: 5199 },
});
