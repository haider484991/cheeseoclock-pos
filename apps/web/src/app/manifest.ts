import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Cheese O'Clock — Pizza & Burger Delivery",
    short_name: "Cheese O'Clock",
    description:
      'Signature pizzas & smash burgers delivered across DHA Karachi. Cash on delivery, open till 2am.',
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
