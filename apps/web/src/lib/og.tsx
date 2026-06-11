import { ImageResponse } from 'next/og';

export const OG_SIZE = { width: 1200, height: 630 };

/**
 * Shared brand template for opengraph images: warm-black canvas, gold glow,
 * Bebas Neue headline, yellow ticker strip. Each route fetches the font file
 * (bundled via `new URL(..., import.meta.url)`) and passes it in.
 */
export function brandOgImage({
  title,
  subtitle,
  fontData,
}: {
  title: string;
  subtitle: string;
  fontData: ArrayBuffer | null;
}) {
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'flex-end',
          backgroundColor: '#0C0A07',
          backgroundImage:
            'radial-gradient(circle at 80% 20%, rgba(245,179,1,0.28), transparent 55%)',
          fontFamily: fontData ? 'Bebas' : 'sans-serif',
        }}
      >
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            padding: '0 72px 48px',
          }}
        >
          <div
            style={{
              display: 'flex',
              color: '#F5B301',
              fontSize: 116,
              lineHeight: 0.95,
              letterSpacing: 2,
            }}
          >
            {title}
          </div>
          <div
            style={{
              display: 'flex',
              marginTop: 18,
              color: '#FAF5EA',
              fontSize: 44,
              letterSpacing: 1.5,
            }}
          >
            {subtitle}
          </div>
        </div>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            backgroundColor: '#F5B301',
            color: '#0C0A07',
            padding: '20px 72px',
            fontSize: 34,
            letterSpacing: 1.5,
          }}
        >
          <span>CASH ON DELIVERY</span>
          <span>·</span>
          <span>30–45 MIN</span>
          <span>·</span>
          <span>OPEN TILL 2AM</span>
        </div>
      </div>
    ),
    {
      ...OG_SIZE,
      fonts: fontData
        ? [{ name: 'Bebas', data: fontData, style: 'normal' as const, weight: 400 as const }]
        : undefined,
    },
  );
}
