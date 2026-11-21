import type { Metadata } from "next";
import styles from "@/app/docs/integrations/docs.module.css";

export const metadata: Metadata = {
  title: { absolute: "MagicBricks | AgentzPro Docs" },
  description: "Receive property enquiries from your MagicBricks account directly into AgentzPro.",
};

export default function MagicbricksDocsPage() {
  return (
    <article className={styles.doc}>
      <span className={styles.badge}>Integrations</span>
      <h1 className={styles.title}>MagicBricks</h1>
      <p className={styles.intro}>
        MagicBricks delivers your property enquiries through a secret webhook URL that only your MagicBricks
        account manager sets up — there is nothing to configure on MagicBricks&apos;s side yourself beyond
        handing them the URL. Only the company owner can set this up.
      </p>

      <section className={styles.section}>
        <h2>Set it up</h2>
        <ol className={styles.stepList}>
          <li className={styles.step}>
            <span className={styles.stepNumber}>1</span>
            <div>
              <h3>Generate your webhook URL</h3>
              <p>On the Integrations page, select Generate webhook URL. This is your company&apos;s own secret URL — keep it private and give it only to MagicBricks.</p>
            </div>
          </li>
          <li className={styles.step}>
            <span className={styles.stepNumber}>2</span>
            <div>
              <h3>Send it to your MagicBricks account manager</h3>
              <p>Copy the URL and send it to your MagicBricks account manager. They set up the lead delivery on their side.</p>
            </div>
          </li>
          <li className={styles.step}>
            <span className={styles.stepNumber}>3</span>
            <div>
              <h3>Check that leads arrive</h3>
              <p>The Integrations page shows &quot;Waiting for first lead&quot; until the first enquiry comes in, then turns to Connected with the time of the last one received.</p>
            </div>
          </li>
        </ol>
      </section>

      <section className={styles.section}>
        <h2>Duplicate enquiries</h2>
        <p>
          A second enquiry for a phone number already saved as a lead is not created as a new lead — it is added
          as a note on the existing one, so the same person&apos;s history stays on one record.
        </p>
      </section>

      <section className={styles.section}>
        <h2>If an enquiry fails to save</h2>
        <p>
          A request MagicBricks sends that could not be saved appears under Failed requests on the Integrations
          page, with a plain reason and when it happened. Contact AgentzPro support with that time — the request
          itself is kept with our support team, not shown on the page.
        </p>
      </section>

      <section className={styles.section}>
        <h2>Regenerating the URL</h2>
        <p>Your old URL keeps working for 7 days. Send the new URL to your MagicBricks account manager before then, or MagicBricks will stop delivering leads.</p>
      </section>
    </article>
  );
}
