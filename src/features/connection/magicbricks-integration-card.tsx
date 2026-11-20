"use client";

import { Building, Check, Copy, Eye, EyeOff, KeyRound, Loader2, RefreshCw, X } from "lucide-react";
import { useCallback, useEffect, useId, useState } from "react";
import { LoadingState, Notice, StatusBadge } from "@/components/ui";
import { IntegrationCardTitle } from "@/features/connection/integration-card-title";
import styles from "@/features/connection/magicbricks-integration-card.module.css";
import { formatDateTime } from "@/lib/date-utils";
import { MAGICBRICKS_LABEL, type MagicbricksOverview } from "@/lib/magicbricks/magicbricks";
import { createMagicbricksIntegration, getMagicbricksOverview } from "@/services/crm-api-client";

type Busy = "create" | "replace" | "refresh" | null;
type Message = { tone: "success" | "danger" | "warning" | "info"; text: string };

const LABEL = MAGICBRICKS_LABEL;

/**
 * MagicBricks on the Integrations page: the company's own secret webhook URL and the 2 setup steps (sending the URL to
 * the account manager is covered in detail on the public docs page, not repeated here). Only when a request
 * could not be saved does a "Failed requests" list appear (the last 10: when and why), so the owner knows to contact
 * us; the raw requests stay with our support team. The URL is the only secret, so it is shown only to the owner, hidden
 * until asked.
 */
export function MagicbricksIntegrationCard() {
  const [overview, setOverview] = useState<MagicbricksOverview | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [busy, setBusy] = useState<Busy>(null);
  const [message, setMessage] = useState<Message | null>(null);
  const [confirmReplace, setConfirmReplace] = useState(false);
  const [copied, setCopied] = useState(false);
  const [showUrl, setShowUrl] = useState(false);
  const urlInputId = useId();
  const titleId = useId();

  useEffect(() => {
    let active = true;
    void getMagicbricksOverview()
      .then((data) => { if (active) setOverview(data); })
      .catch((error: unknown) => { if (active) setMessage({ tone: "danger", text: errorText(error, `${LABEL} details could not be loaded. Try again.`) }); })
      .finally(() => { if (active) setIsLoading(false); });
    return () => { active = false; };
  }, []);

  const reload = useCallback(async (): Promise<void> => {
    setOverview(await getMagicbricksOverview());
  }, []);

  async function run(action: Exclude<Busy, null>, task: () => Promise<void>): Promise<void> {
    setBusy(action);
    setMessage(null);
    try {
      await task();
    } catch (error) {
      setMessage({ tone: "danger", text: errorText(error, "The request could not be completed. Try again.") });
    } finally {
      setBusy(null);
    }
  }

  async function copyUrl(value: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setMessage({ tone: "warning", text: "Copy did not work in this browser. Select the text and copy it instead." });
    }
  }

  const canManage = overview?.canManage === true;
  const integration = overview?.integration ?? null;
  const webhookUrl = integration?.url ?? null;
  const badge = !overview ? null
    : integration ? (integration.lastLeadAt ? { tone: "success" as const, text: "Connected" } : { tone: "warning" as const, text: "Waiting for first lead" })
      : overview.hasIntegration && !canManage ? { tone: "success" as const, text: "Set up" } : { tone: "info" as const, text: "Not set up" };

  return <section className={`panel integration-card ${styles.card}`} aria-labelledby={titleId}><div className="panel__body stack">
    <div className="section-title"><IntegrationCardTitle id={titleId} icon={Building} title={LABEL} description={`Receive property enquiries from your ${LABEL} account automatically.`} guide={{ href: "/docs/integrations/magicbricks", text: "Read the setup guide before you generate your webhook URL" }} />
      {badge ? <StatusBadge tone={badge.tone}>{badge.text}</StatusBadge> : null}
    </div>
    {message ? <Notice tone={message.tone} title={message.text} /> : null}
    {isLoading ? <LoadingState label={`Loading ${LABEL} details`} /> : null}
    {overview && !canManage ? <Notice tone="info" title={`Only the company owner can set up ${LABEL}.`} /> : null}
    {overview && canManage ? <>
      <div className={styles.step}>
        <h3><span className={styles.stepNumber}>1</span>Generate your webhook URL</h3>
        {integration ? <>
          {webhookUrl ? <>
            <p className="field-help"><strong>Keep this URL secret.</strong> Give it only to {LABEL}: anyone who has it can send leads to your CRM.</p>
            <div className="field"><label htmlFor={urlInputId}>Webhook URL</label>
              <div className={styles.copyRow}><input id={urlInputId} type={showUrl ? "text" : "password"} autoComplete="off" readOnly value={webhookUrl} onFocus={(event) => event.currentTarget.select()} />
                <button className={styles.copyAction} type="button" aria-pressed={showUrl} onClick={() => setShowUrl((current) => !current)}>{showUrl ? <EyeOff aria-hidden="true" size={16} /> : <Eye aria-hidden="true" size={16} />}{showUrl ? "Hide" : "Show"}</button>
                <button className={`${styles.copyAction}${copied ? ` ${styles.copyActionDone}` : ""}`} type="button" onClick={() => void copyUrl(webhookUrl)}>{copied ? <Check aria-hidden="true" size={16} /> : <Copy aria-hidden="true" size={16} />}{copied ? "Copied" : "Copy URL"}</button></div></div>
          </> : <Notice tone="warning" title={`This URL can't be shown. Regenerate it, then send the new URL to your ${LABEL} account manager.`} />}
          <div className="button-group">
            {confirmReplace ? <>
              <span className="field-help">The old URL stops working at once. Send the new URL to your {LABEL} account manager.</span>
              <button className="button button--danger" type="button" disabled={busy === "replace"} onClick={() => void run("replace", async () => { await createMagicbricksIntegration(); await reload(); setConfirmReplace(false); setShowUrl(false); setMessage({ tone: "success", text: `New URL created. Send it to your ${LABEL} account manager.` }); })}>{busy === "replace" ? <Loader2 className="spin" aria-hidden="true" size={18} /> : <RefreshCw aria-hidden="true" size={18} />}Regenerate URL</button>
              <button className="button button--secondary" type="button" onClick={() => setConfirmReplace(false)}><X aria-hidden="true" size={18} />Cancel</button>
            </> : <button className="button button--secondary" type="button" onClick={() => setConfirmReplace(true)}><RefreshCw aria-hidden="true" size={18} />Regenerate URL</button>}
          </div>
        </> : <>
          <p className="field-help">Create the secret URL {LABEL} will send your leads to.</p>
          <div className="button-group"><button className="button" type="button" disabled={busy === "create"} onClick={() => void run("create", async () => { await createMagicbricksIntegration(); await reload(); })}>{busy === "create" ? <Loader2 className="spin" aria-hidden="true" size={18} /> : <KeyRound aria-hidden="true" size={18} />}Generate webhook URL</button></div>
        </>}
      </div>

      <div className={styles.step}>
        <h3><span className={styles.stepNumber}>2</span>Check that leads arrive</h3>
        {!integration ? <p className="field-help">Generate the webhook URL first.</p>
          : integration.lastLeadAt ? <div className={styles.arrival}>
            <strong className={styles.arrivalStatus}>Connected<Check aria-hidden="true" size={18} /></strong>
            <span className="field-help" title={formatDateTime(integration.lastLeadAt)}>Last lead received {magicbricksRelativeTime(integration.lastLeadAt)}</span>
          </div> : <div className="meta-list"><div className="meta-item"><span>Status</span><strong>Waiting for first lead</strong></div></div>}
        <p className="field-help">The status turns Connected when {LABEL} sends the first lead.</p>
        {integration ? <div className="button-group">
          <button className="button button--secondary" type="button" disabled={busy === "refresh"} onClick={() => void run("refresh", reload)}>{busy === "refresh" ? <Loader2 className="spin" aria-hidden="true" size={18} /> : <RefreshCw aria-hidden="true" size={18} />}Refresh</button>
        </div> : null}
      </div>

      {integration && integration.failedRequests.length > 0 ? <div className={styles.section}>
        <div className="section-title"><div><h3>Failed requests</h3><p>These {LABEL} enquiries could not be saved. Contact AgentzPro support with the time shown.</p></div></div>
        <ul className={styles.logList}>{integration.failedRequests.map((entry) => <li key={entry.id} className={styles.log}>
          <div className={styles.logRow}>
            <span className={styles.logTime}>{formatDateTime(entry.createdAt)}</span>
            <StatusBadge tone="danger">Failed</StatusBadge>
          </div>
          <p className={styles.logError}>{entry.reason}</p>
        </li>)}</ul>
      </div> : null}
    </> : null}
  </div></section>;
}

/** "just now", "5 minutes ago", "yesterday", "3 days ago". */
export function magicbricksRelativeTime(iso: string, now = Date.now()): string {
  const seconds = Math.round((Date.parse(iso) - now) / 1000);
  if (Math.abs(seconds) < 45) return "just now";
  const format = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return format.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return format.format(hours, "hour");
  const days = Math.round(hours / 24);
  if (Math.abs(days) < 30) return format.format(days, "day");
  return `on ${formatDateTime(iso)}`;
}

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}
