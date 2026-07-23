import type { Metadata, Viewport } from 'next';
import { Space_Grotesk, Plus_Jakarta_Sans } from 'next/font/google';

import './globals.css';

const display = Space_Grotesk({
  subsets: ['latin'],
  weight: ['500', '600', '700'],
  variable: '--font-display',
  display: 'swap',
});

const sans = Plus_Jakarta_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-sans',
  display: 'swap',
});

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
    <html lang="en" className={`dark ${display.variable} ${sans.variable}`}>
      <body className="min-h-[100dvh] font-sans antialiased">{children}</body>
    </html>
  );
}
