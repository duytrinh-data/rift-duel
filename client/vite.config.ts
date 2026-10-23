import { defineConfig, loadEnv } from 'vite';
import path from 'path';

export default defineConfig(({ command, mode }) => {
  const env = loadEnv(mode, path.resolve(__dirname, '..'), '');
  const serverUrl = process.env.VITE_GAME_SERVER_URL || env.VITE_GAME_SERVER_URL;
  if (command === 'build' && !serverUrl && process.env.ALLOW_LOCAL_BUILD !== '1') {
    throw new Error(
      'Thiếu VITE_GAME_SERVER_URL khi build production (hoặc đặt ALLOW_LOCAL_BUILD=1 cho test build local).'
    );
  }

  return {
    root: path.resolve(__dirname),
    envDir: path.resolve(__dirname, '..'),
    publicDir: path.resolve(__dirname, 'public'),
    resolve: {
      alias: {
        '@shared': path.resolve(__dirname, '../shared/src'),
      },
    },
    server: {
      port: 5174,
      strictPort: true,
      host: true,
    },
    build: {
      outDir: path.resolve(__dirname, 'dist'),
      emptyOutDir: true,
      target: 'es2022',
    },
  };
});
