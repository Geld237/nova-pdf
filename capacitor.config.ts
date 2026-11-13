import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'io.github.geld237.novapdf',
  appName: 'Nova PDF',
  webDir: 'dist',
  backgroundColor: '#f4f5f8',
  android: { allowMixedContent: false },
  ios: { contentInset: 'automatic' },
};

export default config;
