import type { Metadata } from "next";
import styles from "@/app/docs/integrations/docs.module.css";

export const metadata: Metadata = {
  title: { absolute: "Google Ads | AgentzPro Docs" },
  description: "Receive leads from your Google Ads lead forms, with each lead showing the campaign it came from.",
};

export default function GoogleAdsDocsPage() {
  return (
    <article className={styles.doc}>
      <span className={styles.badge}>Integrations</span>
      <h1 className={styles.title}>Google Ads</h1>
      <p className={styles.intro}>
        Google Ads has two independent parts: signing in with Google so each lead shows its campaign, and a
        webhook that actually delivers the leads. Only the company owner can set either one up, and the webhook
        works on its own even if the Google sign-in is never completed — useful when an agency runs the Google
        Ads account and the company owner cannot sign in to it.
      </p>

      <section className={styles.section}>
        <h2>Step 1: Campaign names (read-only)</h2>
        <p>
          Sign in with Google from the Integrations page, then choose the Google Ads account(s) your lead forms
          run in. AgentzPro only reads campaign and ad group names from that account — it never creates, changes
          or pauses a campaign, and never touches budgets, bids or billing.
        </p>
        <p>
          If Google stops accepting this sign-in, the Integrations page shows &quot;Google stopped accepting this
          sign-in. Sign in with Google again so campaign names keep loading.&quot; Leads keep arriving either
          way; only new leads stop showing a campaign name until you sign in again.
        </p>
      </section>

      <section className={styles.section}>
        <h2>Step 2: Lead form webhook (this is what delivers leads)</h2>
        <ol className={styles.stepList}>
          <li className={styles.step}>
            <span className={styles.stepNumber}>1</span>
            <div>
              <h3>Create the webhook URL and key</h3>
              <p>On the Integrations page, select Create webhook URL and key. One URL and key cover every campaign — the same pair is pasted into each lead form.</p>
            </div>
          </li>
          <li className={styles.step}>
            <span className={styles.stepNumber}>2</span>
            <div>
              <h3>Paste them into each Google Ads lead form</h3>
              <p>In Google Ads, open the lead form, go to Lead delivery → Webhook integration, and paste the URL and key there.</p>
            </div>
          </li>
          <li className={styles.step}>
            <span className={styles.stepNumber}>3</span>
            <div>
              <h3>Select &quot;Send test data&quot;</h3>
              <p>Google Ads sends a sample lead so you can confirm the connection. It shows on the Integrations page as a test lead received — a test lead is not added to your Leads list.</p>
            </div>
          </li>
        </ol>
        <p>Once a real lead arrives, the Integrations page shows &quot;Leads arriving&quot; and lists the campaigns sending them.</p>
      </section>

      <section className={styles.section}>
        <h2>Replacing the key or stopping delivery</h2>
        <p>
          The old key stops working at once. Any lead a form sends before you paste the new key into it is lost;
          Google does not resend it.
        </p>
        <p>
          Stop receiving Google Ads leads makes AgentzPro refuse anything sent to that URL. Google itself keeps
          trying to send until the URL and key are removed from each lead form.
        </p>
      </section>
    </article>
  );
}
