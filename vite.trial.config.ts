import react from '@vitejs/plugin-react-swc';
import autoprefixer from 'autoprefixer';
import tailwindcss from 'tailwindcss';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import tailwind from './tailwind.config';

const source = fileURLToPath(new URL('./src', import.meta.url));

export default defineConfig({
  root: source + '/trial-page',
  base: './',
  publicDir: false,
  resolve: { alias: { '@': source } },
  plugins: [react()],
  css: { postcss: { plugins: [
    tailwindcss({ ...tailwind, content: [
      source + '/components/Iao*Trial*.tsx', source + '/components/ui/{button,dialog}.tsx',
    ] }),
    autoprefixer(),
  ] } },
});
