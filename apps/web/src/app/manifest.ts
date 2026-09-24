import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Cheese O'Clock — Pizza & Burger Delivery",
    short_name: "Cheese O'Clock",
    description:
      'Signature pizzas, crispy chicken burgers and fries delivered across DHA & Clifton. Cash on delivery, open 12 noon – 1 am.',
    start_url: '/',
    display: 'standalone',
    background_color: '#0C0A07',
    theme_color: '#0C0A07',
    icons: [
      {
        src: '/logo.png',
        sizes: 'any',
        type: 'image/png',
        purpose: 'any',
      },
    ],
  };
}
