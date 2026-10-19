import type { Metadata } from "next";
import type { ReactNode } from "react";

import { BrowserNotificationLifecycle } from "../components/browser-notification-lifecycle";
import { AppNavigation } from "../components/app-navigation";

import "./styles.css";

export const metadata: Metadata = {
  title: "Operations · rip-dvd",
  manifest: "/manifest.webmanifest",
  appleWebApp: { capable: true, title: "Rip DVD", statusBarStyle: "default" },
  icons: { apple: "/app-icon/180", icon: "/app-icon/192" },
  description: "Local disc archiving and encoding operations dashboard",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <BrowserNotificationLifecycle />
        <header className="app-header">
          <AppNavigation />
        </header>
        {children}
      </body>
    </html>
  );
}
