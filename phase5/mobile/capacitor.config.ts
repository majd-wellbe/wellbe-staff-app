import type { CapacitorConfig } from '@capacitor/cli';

// App IDs are permanent once the app is in the stores: decide them before the first upload (README step 2).
const config: CapacitorConfig = {
  appId: 'com.wellbe.client',
  appName: 'Wellbe',
  webDir: 'www',                       // filled by `npm run web` from ../client and ../core
  backgroundColor: '#151b1e',
  ios: { contentInset: 'always', limitsNavigationsToAppBoundDomains: true },
  android: { allowMixedContent: false },
  plugins: {
    SplashScreen: { launchShowDuration: 800, backgroundColor: '#151b1e', showSpinner: false },
    PushNotifications: { presentationOptions: ['badge', 'sound', 'alert'] },
    LocalNotifications: { smallIcon: 'ic_stat_wellbe', iconColor: '#1f6e5b' }
  }
};
export default config;
