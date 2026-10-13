import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Claritia",
  description: "Tests that write and fix themselves. Describe a user flow in plain English and Claritia turns it into a Playwright test.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="h-full">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        {/* eslint-disable-next-line @next/next/no-page-custom-font */}
        <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&family=Geist+Mono:wght@400;500&display=swap" />
      </head>
      <body className="min-h-full font-sans antialiased">{children}</body>
    </html>
  );
}
