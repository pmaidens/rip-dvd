"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const destinations = [
  { href: "/", label: "Overview" },
  { href: "/discs", label: "Disc intake" },
  { href: "/catalog", label: "Catalog" },
  { href: "/encoding", label: "Encoding" },
  { href: "/verification", label: "Verification" },
] as const;

export function AppNavigation() {
  const pathname = usePathname();
  return (
    <nav className="app-navigation" aria-label="Primary navigation">
      <Link className="app-brand" href="/" aria-label="rip-dvd overview">
        <span aria-hidden="true">R</span>
        <strong>rip-dvd</strong>
      </Link>
      <div className="app-navigation-links">
        {destinations.map((destination) => {
          const isCurrent = pathname === destination.href;
          return (
            <Link
              key={destination.href}
              href={destination.href}
              aria-current={isCurrent ? "page" : undefined}
            >
              {destination.label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
