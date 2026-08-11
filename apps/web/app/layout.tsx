import type { Metadata } from "next";
import type { ReactNode } from "react";

import { AppNavigation } from "../components/app-navigation";

import "./styles.css";

export const metadata: Metadata = {
  title: "Operations · rip-dvd",
  description: "Local disc archiving and encoding operations dashboard",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <AppNavigation />
        {children}
      </body>
    </html>
  );
}
