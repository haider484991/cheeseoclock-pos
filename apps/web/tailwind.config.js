/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
      },
      boxShadow: {
        'soft-sm': '0 1px 2px rgba(28, 25, 23, 0.06), 0 1px 1px rgba(28, 25, 23, 0.04)',
        'soft-md': '0 4px 12px rgba(28, 25, 23, 0.08), 0 1px 3px rgba(28, 25, 23, 0.05)',
        'soft-lg': '0 12px 32px rgba(28, 25, 23, 0.12), 0 2px 8px rgba(28, 25, 23, 0.06)',
        lift: '0 6px 16px rgba(245, 158, 11, 0.25)',
      },
      keyframes: {
        'fade-in': {
          from: { opacity: '0', transform: 'translateY(6px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
      },
      animation: {
        'fade-in': 'fade-in 0.25s ease-out',
      },
    },
  },
  plugins: [],
};
