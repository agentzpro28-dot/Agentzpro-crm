import type { Metadata } from "next";
import styles from "@/app/docs/integrations/docs.module.css";

export const metadata: Metadata = {
  title: { absolute: "Facebook Lead Ads | AgentzPro Docs" },
  description: "Connect your Facebook Page so leads from your Meta Lead Ads forms arrive in AgentzPro automatically.",
};

export default function FacebookDocsPage() {
  return (
    <article className={styles.doc}>
      <span className={styles.badge}>Integrations</span>
      <h1 className={styles.title}>Facebook Lead Ads</h1>
      <p className={styles.intro}>
        Connect a Facebook Page once, and every lead submitted through its Meta Lead Ads forms arrives in your
        AgentzPro Leads list on its own — no exporting, no copying from Meta&apos;s Ads Manager.
      </p>

      <section className={styles.section}>
        <h2>Before you connect</h2>
        <p>Only the company owner can connect or disconnect Facebook Pages; other team members see the connection as read-only.</p>
        <p>
          The Facebook Page you connect needs advertising access, plus one of <strong>Manage</strong>,{" "}
          <strong>Create content</strong> or <strong>Moderate</strong>. If a Page is missing one of these, it still
          shows in the list with a note on what it needs — Facebook, not AgentzPro, controls that access.
        </p>
      </section>

      <section className={styles.section}>
        <h2>Connect your Page</h2>
        <ol className={styles.stepList}>
          <li className={styles.step}>
            <span className={styles.stepNumber}>1</span>
            <div>
              <h3>Select Connect Facebook</h3>
              <p>On the Integrations page, this opens Facebook&apos;s own login window. Log in and approve the permissions it asks for.</p>
            </div>
          </li>
          <li className={styles.step}>
            <span className={styles.stepNumber}>2</span>
            <div>
              <h3>Choose which Pages to connect</h3>
              <p>Every eligible Page on your Facebook account is listed. Tick the ones that should send leads to AgentzPro and select Connect selected Pages.</p>
            </div>
          </li>
          <li className={styles.step}>
            <span className={styles.stepNumber}>3</span>
            <div>
              <h3>Leads start arriving on their own</h3>
              <p>From here, a new submission on any connected Page&apos;s lead form reaches your Leads list without anyone doing anything further.</p>
            </div>
          </li>
        </ol>
      </section>

      <section className={styles.section}>
        <h2>Connection status</h2>
        <table className={styles.table}>
          <thead><tr><th>Status</th><th>What it means</th></tr></thead>
          <tbody>
            <tr><td>Active</td><td>Leads are arriving normally.</td></tr>
            <tr><td>Reauthorization required</td><td>Facebook authorization needs to be renewed. Reconnect so your Pages and ad names keep loading.</td></tr>
            <tr><td>Disconnected</td><td>No Page is connected.</td></tr>
            <tr><td>Not connected</td><td>Facebook has never been connected for this company.</td></tr>
          </tbody>
        </table>
        <p>
          If a permission is declined during login, Facebook will not ask for it again on its own. Use Grant
          permissions on the Integrations page to ask again.
        </p>
      </section>

      <section className={styles.section}>
        <h2>Disconnecting</h2>
        <p>
          Disconnecting a single Page stops Meta from sending it any further leads and removes it from AgentzPro.
          Disconnecting the whole connection removes every Page from AgentzPro and also removes AgentzPro&apos;s
          authorization on your Facebook account, once no other AgentzPro company is using that same Facebook
          login.
        </p>
        <p>Either action can be reversed at any time by connecting again — nothing already received is deleted.</p>
      </section>
    </article>
  );
}
