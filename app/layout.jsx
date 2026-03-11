import { SpeedInsights } from '@vercel/speed-insights/next';

export const metadata = {
  title: "SmartAxes — Graph Paper Generator",
  description: "Generate graph paper with smart axes for UK schools",
  icons: {
    icon: "/icon.svg",
  },
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, padding: 0 }}>
        {children}
        <SpeedInsights />
      </body>
    </html>
  );
}
