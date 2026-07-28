import type { Metadata, Viewport } from 'next';

import { MistBackground } from '@/components/mist-background';

import './globals.css';

const description =
  'AI instant replay — was the call fair? Upload a clip, get a verdict cited against the official rulebook.';

export const metadata: Metadata = {
  metadataBase: new URL('https://refcheck.ai'),
  title: {
    default: 'RefCheck AI',
    template: '%s | RefCheck AI',
  },
  description,
  applicationName: 'RefCheck AI',
  keywords: ['sports', 'referee', 'instant replay', 'AI', 'rulebook', 'officiating'],
  openGraph: {
    title: 'RefCheck AI',
    description,
    type: 'website',
    siteName: 'RefCheck AI',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'RefCheck AI',
    description,
  },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#0a0f16',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      <body className="min-h-[100dvh] font-sans antialiased">
        <MistBackground />
        {children}
      </body>
    </html>
  );
}
