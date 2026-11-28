import type { Metadata } from "next";
import styles from "@/app/docs/integrations/docs.module.css";
import { HOUSING_LABEL, HOUSING_PREVIOUS_URL_DAYS } from "@/lib/housing/housing";

export const metadata: Metadata = {
  title: { absolute: "Housing.com | AgentzPro Docs" },
  description: "Receive property enquiries from your Housing.com account directly into AgentzPro.",
};

const LABEL = HOUSING_LABEL;

/** A sample Housing.com lead in JSON. */
const SAMPLE_BODY = `{
  "name": "Ravi Kumar",
  "mobile": "9876543210",
  "email": "ravi@example.com",
  "city": "Chennai"
}`;

/** The field names the Housing.com reader knows (src/lib/server/housing/housing-lead-mapper.ts), in its order. */
const FIELD_ROWS: ReadonlyArray<readonly [string, string]> = [
  ["Mobile", "mobile, phone, mobile_number, phone_number, mobile_no, phone_no, contact_number, contact_no, contact, cust_mobile, cust_phone, customer_mobile, customer_phone, user_mobile, user_phone, sender_mobile"],
  ["Email", "email, email_id, email_address, cust_email, customer_email, user_email, sender_email"],
  ["Name", "name, full_name, fullname, cust_name, customer_name, lead_name, buyer_name, user_name, contact_name, client_name, contact_person, sender_name, or first_name + last_name"],
  ["City", "city, city_name, locality, locality_name, location, area, area_name"],
  ["Message", "message, query, remark, remarks, comment, comments, requirement, requirements, need, description, details"],
  ["Project", "project_name, project, property_name, listing_name, society_name, property_title, listing_title, property_id, listing_id, project_id"],
  ["Enquiry ID", "lead_id, enquiry_id, inquiry_id, response_id, need_id, lead_ref, lead_reference, id"],
];

/** The replies of the Housing.com webhook (src/app/api/webhooks/housing/[token]/route.ts). */
const REPLY_ROWS: ReadonlyArray<readonly [string, string, string]> = [
  ["200", "Lead saved (\"success\": true, \"accepted\": 1). A repeat phone number also gets this, with \"duplicate\": true; it is added as a note on the existing lead.", "–"],
  ["400", "Not saved: the lead is not readable.", "\"Mobile number or email not found.\", \"The body is not a lead object.\", \"More than one lead in one request.\", \"More than 100 fields.\" or \"A field name is longer than 100 characters.\""],
  ["404", "Not saved: wrong, replaced, expired or disconnected URL.", "\"Unknown webhook.\""],
  ["413", "Not saved: the request is over 64 KB.", "\"Payload too large.\""],
  ["415", "Not saved: not JSON, form data or URL parameters (for example XML).", "\"The body is not JSON, form data or URL parameters.\""],
  ["429", "Not saved: too many leads this minute. Send again after the Retry-After seconds.", "\"Too many leads. Try again shortly.\""],
  ["500", "Not saved: a failure on our side. Safe to send again.", "\"Temporary failure, retry later.\""],
];

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
        <h2>How {LABEL} can send a lead</h2>
        <p>Share this section with your {LABEL} account manager.</p>
        <ul>
          <li>Method: <strong>POST or GET</strong>.</li>
          <li>Format: <strong>JSON</strong>, <strong>form data</strong> (normal or multipart) or <strong>URL parameters</strong>. JSON is read even when it is sent with another content type.</li>
          <li><strong>One lead per request.</strong> One lead inside a list (<code>[{"{...}"}]</code>) is accepted; 2 or more leads in one request are not.</li>
          <li>A lead inside one field is accepted, for example <code>data={"{...}"}</code> or <code>{"{\"customer\": {...}}"}</code>.</li>
          <li>Limits: a request up to <strong>64 KB</strong>, up to <strong>100 fields</strong>, each field name up to <strong>100 characters</strong>.</li>
          <li>Every lead needs <strong>a mobile number or an email</strong>.</li>
        </ul>
        <pre className={styles.pre}>{SAMPLE_BODY}</pre>
      </section>

      <section className={styles.section}>
        <h2>Field names we read</h2>
        <p>Capitals, spaces, underscores and hyphens don&apos;t matter: <code>MobileNo</code>, <code>mobile_no</code> and <code>Mobile Number</code> are the same.</p>
        <table className={styles.table}>
          <thead>
            <tr>
              <th scope="col">Lead detail</th>
              <th scope="col">Field names</th>
            </tr>
          </thead>
          <tbody>
            {FIELD_ROWS.map(([detail, names]) => (
              <tr key={detail}>
                <th scope="row">{detail}</th>
                <td>{names}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p>
          <strong>Other field names:</strong> if the mobile number or email is sent under a name not in this list (for
          example <code>whatsapp</code>), it is still found from its value: a 10-digit Indian mobile number or an email
          address. When it is not clear which field holds it, nothing is guessed. The lead is refused only when neither a
          mobile number nor an email is found.
        </p>
      </section>

      <section className={styles.section}>
        <h2>What AgentzPro replies</h2>
        <table className={styles.table}>
          <thead>
            <tr>
              <th scope="col">Code</th>
              <th scope="col">Meaning</th>
              <th scope="col">Reason sent</th>
            </tr>
          </thead>
          <tbody>
            {REPLY_ROWS.map(([code, meaning, reason]) => (
              <tr key={code}>
                <th scope="row">{code}</th>
                <td>{meaning}</td>
                <td>{reason}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p>
          <strong>A lead is saved only when the reply is 200 with <code>&quot;accepted&quot;: 1</code>.</strong> Every
          other reply has <code>&quot;success&quot;: false</code> and a <code>&quot;reason&quot;</code>.
        </p>
      </section>

      <section className={styles.section} aria-labelledby="regenerate-warning">
        <div className={styles.warning} role="note">
          <h2 id="regenerate-warning"><span aria-hidden="true">⚠ </span>Warning: Do not click &quot;Regenerate URL&quot; without a real reason</h2>
          <ul>
            <li>Click <strong>Regenerate URL</strong> only if your webhook URL has leaked (someone outside your company has it).</li>
            <li>When you click it, a <strong>new webhook URL is created</strong>.</li>
            <li>Your <strong>old webhook URL keeps working for only {HOUSING_PREVIOUS_URL_DAYS} days</strong> from the time you create the new URL. <strong>After {HOUSING_PREVIOUS_URL_DAYS} days, the old URL will not accept any leads.</strong></li>
            <li>These {HOUSING_PREVIOUS_URL_DAYS} days are given to save your leads. Within these {HOUSING_PREVIOUS_URL_DAYS} days, <strong>ask your Housing.com account manager to connect the new URL.</strong></li>
            <li>If your account manager connects the new URL within {HOUSING_PREVIOUS_URL_DAYS} days, <strong>both the old URL and the new URL work until the {HOUSING_PREVIOUS_URL_DAYS} days end.</strong> The same lead will not be added twice to your account. You can also ask your account manager to remove the old URL and add the new URL.</li>
            <li>If the new URL is not connected within {HOUSING_PREVIOUS_URL_DAYS} days, <strong>your Housing.com leads will be lost. AgentzPro is not responsible for these lost leads. It is fully your responsibility.</strong></li>
          </ul>
        </div>
      </section>

      <section className={styles.section} aria-labelledby="disconnect-warning">
        <div className={styles.warning} role="note">
          <h2 id="disconnect-warning"><span aria-hidden="true">⚠ </span>Disconnect {LABEL}</h2>
          <ul>
            <li>Click <strong>Disconnect</strong> on the {LABEL} card to stop receiving {LABEL} leads. <strong>It works at once, with no confirmation.</strong></li>
            <li>From then on, <strong>every lead {LABEL} sends to your webhook URL is refused and cannot be recovered</strong>. This includes your old URL during its {HOUSING_PREVIOUS_URL_DAYS} days after a Regenerate.</li>
            <li>The {LABEL} leads already in your CRM stay as they are, and {LABEL} stays in the Source filter on the Leads page.</li>
            <li>To receive {LABEL} leads again, click <strong>Generate new webhook URL</strong> and send the new URL to your {LABEL} account manager. <strong>The disconnected URL never works again.</strong></li>
            <li>Ask your {LABEL} account manager to remove the disconnected URL.</li>
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
