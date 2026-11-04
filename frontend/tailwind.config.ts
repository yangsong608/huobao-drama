import type { Config } from 'tailwindcss'

export default {
  content: [
    './app/components/novel/**/*.{vue,ts}',
    './app/pages/novels/**/*.{vue,ts}',
    './app/views/novel/**/*.{vue,ts}',
    './app/layouts/novel.vue',
  ],
  important: '.novel-scope',
  darkMode: ['selector', '[data-theme="dark"]'],
  corePlugins: {
    preflight: false,
  },
  theme: {
    extend: {
      colors: {
        novel: {
          accent: 'var(--novel-accent)',
        },
      },
    },
  },
} satisfies Config
