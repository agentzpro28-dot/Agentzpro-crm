import type { Metadata } from "next";
import styles from "@/app/docs/integrations/docs.module.css";
import { HOUSING_LABEL, HOUSING_PREVIOUS_URL_DAYS } from "@/lib/housing/housing";

export const metadata: Metadata = {
  title: { absolute: "Housing.com | AgentzPro Docs" },
  description: "Receive property enquiries from your Housing.com account directly into AgentzPro.",
};

const LABEL = HOUSING_LABEL;

export default function HousingDocsPage() {
  return (
    <article className={styles.doc}>
      <span className={styles.badge}>Integrations</span>
      <h1 className={styles.title}>{LABEL}</h1>
      <p className={styles.intro}>
        {LABEL} delivers your property enquiries to a secret webhook URL. Your {LABEL} account manager sets up the
        delivery on their side; all you do is give them the URL. Only the company owner can set this up.
      </p>

      <section className={styles.section}>
        <h2>Set it up</h2>
        <ol className={styles.stepList}>
          <li className={styles.step}>
            <span className={styles.stepNumber}>1</span>
            <div>
              <h3>Generate your webhook URL</h3>
              <p>
                On the Integrations page, select Generate webhook URL. You need an active {LABEL} package. This is your
                company&apos;s own secret URL: keep it private and give it only to {LABEL}, because anyone who has it
                can send leads to your CRM.
              </p>
            </div>
          </li>
          <li className={styles.step}>
            <span className={styles.stepNumber}>2</span>
            <div>
              <h3>Send it to your {LABEL} account manager</h3>
              <p>Copy the URL and send it to your {LABEL} account manager. They set up the lead delivery on their side.</p>
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
            <li>Your <strong>old webhook URL keeps working for only {HOUSING_PREVIOUS_URL_DAYS} days</strong> from the time you create the new URL. <strong>After {HOUSING_PREVIOUS_URL_DAYS} days, the old URL will not accept any leads.</strong></li>
            <li>These {HOUSING_PREVIOUS_URL_DAYS} days are given to save your leads. Within these {HOUSING_PREVIOUS_URL_DAYS} days, <strong>ask your Housing.com account manager to connect the new URL.</strong></li>
            <li>If the new URL is not connected within {HOUSING_PREVIOUS_URL_DAYS} days, <strong>your Housing.com leads will be lost. AgentzPro is not responsible for these lost leads. It is fully your responsibility.</strong></li>
          </ul>
        </div>
      </section>

      <section className={styles.section}>
        <h2>Duplicate enquiries</h2>
        <p>
          A new enquiry from a phone number already saved as a lead is not created as a second lead. It is added as a
          note on the existing one, so the same person&apos;s history stays on one record.
        </p>
      </section>

      <section className={styles.section}>
        <h2>If an enquiry fails to save</h2>
        <p>
          A request {LABEL} sends that could not be saved appears under Failed requests on the Integrations page, with
          a plain reason and when it happened. Contact AgentzPro support with that time. The request itself is kept
          with our support team, not shown on the page.
        </p>
      </section>
    </article>
  );
}
