/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Warm near-black family — never pure #000 so food photos blend in.
        night: {
          DEFAULT: '#0C0A07',
          soft: '#14110C',
          card: '#1A160F',
          edge: '#2A2418',
        },
        // Brand gold, sampled from the logo artwork (#F5B301), plus hover /
        // gradient stops. Yellow is a condiment: CTAs, prices, accents only.
        cheese: {
          DEFAULT: '#F5B301',
          hot: '#FFC72C',
          deep: '#D89C00',
        },
        cream: { DEFAULT: '#FAF5EA', dim: '#EFE8D8' },
        // The printed menu's paper and ink — the ordering page is set on it.
        paper: { DEFAULT: '#FBF7EE', deep: '#EFE9DD', line: '#E4DCCB' },
        ink: { DEFAULT: '#151412', soft: '#2B2824', muted: '#5B554D' },
        smoke: '#A39E93',
      },
      fontFamily: {
        // Same three faces as the printed menu: Anton headlines, Barlow
        // Condensed labels and prices, Barlow body.
        sans: ['var(--font-sans)', 'system-ui', 'sans-serif'],
        display: ['var(--font-display)', 'Impact', 'sans-serif'],
        cond: ['var(--font-cond)', 'var(--font-sans)', 'sans-serif'],
      },
      boxShadow: {
        // On dark UIs shadows vanish — gold glow + borders do the lifting.
        glow: '0 8px 30px rgba(245, 179, 1, 0.25)',
        'glow-lg': '0 12px 48px rgba(245, 179, 1, 0.4)',
        'soft-sm': '0 1px 2px rgba(28, 25, 23, 0.06), 0 1px 1px rgba(28, 25, 23, 0.04)',
        'soft-md': '0 4px 12px rgba(28, 25, 23, 0.08), 0 1px 3px rgba(28, 25, 23, 0.05)',
        'soft-lg': '0 12px 32px rgba(28, 25, 23, 0.12), 0 2px 8px rgba(28, 25, 23, 0.06)',
      },
      keyframes: {
        'fade-in': {
          from: { opacity: '0', transform: 'translateY(6px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        'fade-up': {
          from: { opacity: '0', transform: 'translateY(18px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        marquee: {
          from: { transform: 'translateX(0)' },
          to: { transform: 'translateX(-50%)' },
        },
        float: {
          '0%, 100%': { transform: 'translateY(0)' },
          '50%': { transform: 'translateY(-10px)' },
        },
        'tick-glow': {
          '0%, 100%': { boxShadow: '0 8px 30px rgba(245, 179, 1, 0.25)' },
          '50%': { boxShadow: '0 8px 42px rgba(245, 179, 1, 0.5)' },
        },
        'pop-in': {
          '0%': { opacity: '0', transform: 'translateY(8px) scale(0.96)' },
          '100%': { opacity: '1', transform: 'translateY(0) scale(1)' },
        },
        'sheet-up': {
          from: { transform: 'translateY(24px)', opacity: '0' },
          to: { transform: 'translateY(0)', opacity: '1' },
        },
      },
      animation: {
        'fade-in': 'fade-in 0.25s ease-out',
        'fade-up': 'fade-up 0.5s ease-out both',
        marquee: 'marquee 28s linear infinite',
        float: 'float 6s ease-in-out infinite',
        'float-slow': 'float 8s ease-in-out infinite',
        'tick-glow': 'tick-glow 4s ease-in-out infinite',
        'pop-in': 'pop-in 0.22s ease-out both',
        'sheet-up': 'sheet-up 0.24s ease-out both',
      },
    },
  },
  plugins: [],
};
