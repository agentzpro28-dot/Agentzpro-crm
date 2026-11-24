"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import styles from "@/app/docs/integrations/docs.module.css";

const INTEGRATION_LINKS = [
  { href: "/docs/integrations/facebook", label: "Facebook" },
  { href: "/docs/integrations/google-ads", label: "Google Ads" },
  { href: "/docs/integrations/webhook", label: "Webhook" },
  { href: "/docs/integrations/99acres", label: "99acres" },
  { href: "/docs/integrations/magicbricks", label: "MagicBricks" },
  { href: "/docs/integrations/housing", label: "Housing.com" },
  { href: "/docs/integrations/sulekha", label: "Sulekha" },
] as const;

function NavLinks({ activeHref }: { activeHref: string }) {
  return (
    <ul className={styles.navList}>
      {INTEGRATION_LINKS.map((link) => (
        <li key={link.href}>
          <Link
            href={link.href}
            className={link.href === activeHref ? `${styles.navLink} ${styles.navLinkActive}` : styles.navLink}
            aria-current={link.href === activeHref ? "page" : undefined}
          >
            {link.label}
          </Link>
        </li>
      ))}
    </ul>
  );
}

/** Left-hand doc navigation: one "Integrations" section linking to each of the 6 platform pages. */
export function DocsSidebar() {
  const pathname = usePathname();
  return (
    <>
      <nav className={styles.sidebar} aria-label="Docs">
        <p className={styles.navTitle}>Integrations</p>
        <NavLinks activeHref={pathname} />
      </nav>
      <details className={styles.mobileNav}>
        <summary>Integrations</summary>
        <nav aria-label="Docs">
          <NavLinks activeHref={pathname} />
        </nav>
      </details>
    </>
  );
}
