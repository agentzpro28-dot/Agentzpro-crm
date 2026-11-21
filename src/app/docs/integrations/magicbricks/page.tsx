import type { Metadata } from "next";
import styles from "@/app/docs/integrations/docs.module.css";
import { MAGICBRICKS_PREVIOUS_URL_DAYS } from "@/lib/magicbricks/magicbricks";

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

      <section className={styles.section} aria-labelledby="regenerate-warning">
        <div className={styles.warning} role="note">
          <h2 id="regenerate-warning"><span aria-hidden="true">⚠ </span>Warning: Do not click &quot;Regenerate URL&quot; without a real reason</h2>
          <ul>
            <li>Click <strong>Regenerate URL</strong> only if your webhook URL has leaked (someone outside your company has it).</li>
            <li>When you click it, a <strong>new webhook URL is created</strong>.</li>
            <li>Your <strong>old webhook URL keeps working for only {MAGICBRICKS_PREVIOUS_URL_DAYS} days</strong> from the time you create the new URL. <strong>After {MAGICBRICKS_PREVIOUS_URL_DAYS} days, the old URL will not accept any leads.</strong></li>
            <li>These {MAGICBRICKS_PREVIOUS_URL_DAYS} days are given to save your leads. Within these {MAGICBRICKS_PREVIOUS_URL_DAYS} days, <strong>ask your MagicBricks account manager to connect the new URL.</strong></li>
            <li>If the new URL is not connected within {MAGICBRICKS_PREVIOUS_URL_DAYS} days, <strong>your MagicBricks leads will be lost. AgentzPro is not responsible for these lost leads. It is fully your responsibility.</strong></li>
          </ul>
        </div>
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
    </article>
  );
}
