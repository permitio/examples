import Aura from '@primeuix/themes/aura';
import tailwindcss from '@tailwindcss/vite';
import { defineNuxtConfig } from 'nuxt/config';

export default defineNuxtConfig({
  compatibilityDate: '2026-11-01',
  devtools: { enabled: false },
  telemetry: false,
  modules: ['@pinia/nuxt', '@primevue/nuxt-module'],
  css: ['~/assets/css/main.css', 'primeicons/primeicons.css'],
  vite: { plugins: [tailwindcss()] },
  primevue: {
    options: {
      ripple: true,
      // PrimeVue's styles go in their own CSS layer, below Tailwind's utilities, so a utility class
      // on a PrimeVue component wins.
      theme: {
        preset: Aura,
        options: { cssLayer: { name: 'primevue', order: 'theme, base, primevue' } },
      },
    },
  },
  typescript: {
    strict: true,
    // Applies to every tsconfig Nuxt generates: the app, the server, shared/ and nuxt.config.
    tsConfig: {
      compilerOptions: {
        noUncheckedIndexedAccess: true,
        exactOptionalPropertyTypes: true,
        noImplicitOverride: true,
        noPropertyAccessFromIndexSignature: true,
        verbatimModuleSyntax: true,
        isolatedModules: true,
        noImplicitReturns: true,
        noFallthroughCasesInSwitch: true,
      },
    },
  },
});
