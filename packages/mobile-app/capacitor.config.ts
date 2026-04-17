import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.pi.mobile',
  appName: 'pi',
  webDir: 'dist',
  server: {
    androidScheme: 'http',
    allowNavigation: ['*'],
  },
  android: {
    allowMixedContent: true,
  },
};

export default config;
