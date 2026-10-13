import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'dev.sharefront.warp',
  appName: 'Warp',
  webDir: 'www',
  android: {
    // The transfer engine lives in Java; the WebView is only the UI.
    allowMixedContent: true,
  },
  server: {
    androidScheme: 'https',
  },
};

export default config;
