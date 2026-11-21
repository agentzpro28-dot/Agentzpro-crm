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

      <section className={styles.section}>
        <h2>Regenerating the URL</h2>
        <p>{`Your old URL keeps working for ${HOUSING_PREVIOUS_URL_DAYS} days. Send the new URL to your ${LABEL} account manager before then, or ${LABEL} will stop delivering leads.`}</p>
      </section>
    </article>
  );
}
