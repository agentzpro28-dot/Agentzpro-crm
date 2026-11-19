import { PublicSiteFooter, PublicSiteHeader } from "@/components/public-site-chrome";
import { DocsSidebar } from "@/features/docs/docs-sidebar";
import landing from "@/app/landing.module.css";
import styles from "./docs.module.css";

/** Shared frame for every integration doc page: public header/footer plus the left-hand doc sidebar. */
export default function DocsIntegrationsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className={landing.page}>
      <PublicSiteHeader />
      <main className={styles.main}>
        <div className={styles.layout}>
          <DocsSidebar />
          <div>{children}</div>
        </div>
      </main>
      <PublicSiteFooter />
    </div>
  );
}
