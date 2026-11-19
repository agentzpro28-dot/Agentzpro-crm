import type { Metadata } from "next";
import styles from "@/app/docs/integrations/docs.module.css";

export const metadata: Metadata = {
  title: { absolute: "Webhook | AgentzPro Docs" },
  description: "Send leads to AgentzPro from any tool that can make a server-to-server POST request.",
};

const SAMPLE_BODY = `{
  "name": "John Doe",
  "phone": "9876543210",
  "email": "john@example.com",
  "source": "Landing Page",
  "lead_id": "optional-your-own-id"
}`;

export default function WebhookDocsPage() {
  return (
    <article className={styles.doc}>
      <span className={styles.badge}>Integrations</span>
      <h1 className={styles.title}>Webhook</h1>
      <p className={styles.intro}>
        Every company gets its own secret webhook URL. Any tool that can send a server-to-server POST request —
        a website form plugin, Zapier, Pabbly, or your own software — can send leads to it directly, one lead
        per request.
      </p>

      <section className={styles.section}>
        <h2>Set it up</h2>
        <ol className={styles.stepList}>
          <li className={styles.step}>
            <span className={styles.stepNumber}>1</span>
            <div>
              <h3>Create the webhook URL</h3>
              <p>On the Integrations page, select Create webhook URL.</p>
            </div>
          </li>
          <li className={styles.step}>
            <span className={styles.stepNumber}>2</span>
            <div>
              <h3>Paste it into your tool</h3>
              <p>Use it as the destination for a POST action in Zapier, Pabbly, your CRM, or a WordPress / Elementor webhook action.</p>
            </div>
          </li>
        </ol>
        <p className={styles.note}>
          <strong>Keep this URL secret.</strong> Never put it in your website&apos;s HTML or JavaScript — anyone
          who has it can send leads to your CRM. Requests sent from a web browser are refused.
        </p>
      </section>

      <section className={styles.section}>
        <h2>Technical reference</h2>

        <p><strong>Method:</strong> POST. <strong>Body:</strong> JSON (<code>application/json</code>, or no content type at all) or form data (<code>application/x-www-form-urlencoded</code>). One lead per request.</p>

        <p>Example body:</p>
        <pre className={styles.pre}>{SAMPLE_BODY}</pre>

        <p>Field names are matched case-insensitively; spaces and hyphens are read the same as underscores.</p>
        <ul className={styles.sourceList}>
          <li><span><code>name</code> / <code>full_name</code> / <code>fullname</code></span><span>Lead&apos;s name.</span></li>
          <li><span><code>first_name</code> / <code>last_name</code></span><span>Used instead of (or alongside) name.</span></li>
          <li><span><code>email</code> / <code>email_address</code></span><span>Lead&apos;s email.</span></li>
          <li><span><code>phone</code> / <code>phone_number</code> / <code>mobile</code> / <code>mobile_number</code></span><span>Lead&apos;s phone number.</span></li>
          <li><span><code>source</code></span><span>Free text; shown in the Ad Name column.</span></li>
          <li><span><code>lead_id</code></span><span>Your own id for this lead. Sending it again with the same lead_id is never saved twice.</span></li>
        </ul>
        <p>
          Either <code>phone</code> (in any of its accepted names) or <code>email</code> is required. Any other
          field you send — city, budget, anything — is saved with the lead as its own field.
        </p>

        <p>Responses:</p>
        <table className={styles.table}>
          <thead><tr><th>Status</th><th>Meaning</th></tr></thead>
          <tbody>
            <tr><td>200</td><td>Saved. The response body includes <code>&quot;duplicate&quot;: true</code> when a lead with the same lead_id was already saved.</td></tr>
            <tr><td>400 / 404 / 415</td><td>The request was not accepted as sent (bad webhook URL, missing phone/email, or an unsupported body format). It is never accepted by retrying unchanged.</td></tr>
            <tr><td>403</td><td>Sent from a web browser, not server to server. Send it from your tool&apos;s own server instead.</td></tr>
            <tr><td>413</td><td>The request body is too large.</td></tr>
            <tr><td>429</td><td>Too many leads sent in a short time. A Retry-After header says how many seconds to wait.</td></tr>
            <tr><td>500</td><td>A failure on our side. Safe to retry; a retry with the same lead_id is never saved twice.</td></tr>
          </tbody>
        </table>
      </section>

      <section className={styles.section}>
        <h2>Stopping or replacing the URL</h2>
        <p>
          The old URL stops working at once. Paste the new URL into every tool that sends leads.
        </p>
        <p>
          Stop receiving webhook leads makes AgentzPro refuse anything sent to the current URL. To start again,
          create a new webhook URL and paste it into your tools.
        </p>
      </section>
    </article>
  );
}
