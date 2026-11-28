"use client";

import { Check, Copy, Eye, EyeOff, Building2, KeyRound, Loader2, Pause, Play, RefreshCw, Unplug, X } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { LoadingState, Notice, StatusBadge } from "@/components/ui";
import { IntegrationCardTitle } from "@/features/connection/integration-card-title";
import styles from "@/features/connection/nobroker-integration-card.module.css";
import { formatDateTime } from "@/lib/date-utils";
import { NOBROKER_LABEL, NOBROKER_PREVIOUS_URL_DAYS, nobrokerLeadsStillOnOldUrl, type NoBrokerOverview } from "@/lib/nobroker/nobroker";
import { createNoBrokerIntegration, disconnectNoBroker, getNoBrokerOverview, setNoBrokerPaused } from "@/services/crm-api-client";

type Busy = "create" | "replace" | "refresh" | "pause" | "resume" | "disconnect" | null;
type Message = { tone: "success" | "danger" | "warning" | "info"; text: string };

const LABEL = NOBROKER_LABEL;

/**
 * NoBroker on the Integrations page: the company's own secret webhook URL (to send to the NoBroker account manager) and
 * the "Check that leads arrive" step. After a regenerate the old URL keeps working for 7 days; the card says until
 * when, and warns while the newest lead still came on the old URL. Only when a request could not be saved does a
 * "Failed requests" list appear (the last 10: when and why). The URL is the only secret, so it is shown only to the
 * owner, hidden until asked.
 */
export function NoBrokerIntegrationCard() {
  const [overview, setOverview] = useState<NoBrokerOverview | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [busy, setBusy] = useState<Busy>(null);
  const [message, setMessage] = useState<Message | null>(null);
  const [confirmReplace, setConfirmReplace] = useState(false);
  const [confirmPause, setConfirmPause] = useState(false);
  const [copied, setCopied] = useState(false);
  const [showUrl, setShowUrl] = useState(false);
  const urlInputId = useId();
  const titleId = useId();

  useEffect(() => {
    let active = true;
    void getNoBrokerOverview()
      .then((data) => { if (active) setOverview(data); })
      .catch((error: unknown) => { if (active) setMessage({ tone: "danger", text: errorText(error, `${LABEL} details could not be loaded. Try again.`) }); })
      .finally(() => { if (active) setIsLoading(false); });
    return () => { active = false; };
  }, []);

  const reload = useCallback(async (): Promise<void> => {
    setOverview(await getNoBrokerOverview());
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
  const previousUrl = integration?.previousUrl ?? null;
  const oldUrlStillUsed = previousUrl ? nobrokerLeadsStillOnOldUrl(integration?.lastLeadAt ?? null, previousUrl.lastLeadAt) : false;
  const paused = integration?.paused === true;
  const badge = !overview ? null
    : paused ? { tone: "warning" as const, text: "Paused" }
    : integration ? (integration.lastLeadAt ? { tone: "success" as const, text: "Connected" } : { tone: "warning" as const, text: "Waiting for first lead" })
      : overview.disconnected ? { tone: "danger" as const, text: "Disconnected" }
      : overview.hasIntegration && !canManage ? { tone: "success" as const, text: "Set up" } : { tone: "info" as const, text: "Not set up" };

  return <section className={`panel integration-card ${styles.card}`} aria-labelledby={titleId}><div className="panel__body stack">
    <div className="section-title"><IntegrationCardTitle id={titleId} icon={Building2} title={LABEL} description={`Receive property enquiries from your ${LABEL} account automatically.`} guide={{ href: "/docs/integrations/nobroker", text: "Read the setup guide before you generate your webhook URL" }} />
      {badge ? <StatusBadge tone={badge.tone}>{badge.text}</StatusBadge> : null}
    </div>
    {message ? <Notice tone={message.tone} title={message.text} /> : null}
    {isLoading ? <LoadingState label={`Loading ${LABEL} details`} /> : null}
    {overview && !canManage ? <Notice tone="info" title={`Only the company owner can set up ${LABEL}.`} /> : null}
    {overview && canManage ? <>
      <div className={styles.step}>
        <h3><span className={styles.stepNumber}>1</span>Generate your webhook URL</h3>
        <p className="field-help">Requires an active {LABEL} package.</p>
        {integration ? <>
          {webhookUrl ? <>
            <p className="field-help"><strong>Keep this URL secret.</strong> Give it only to {LABEL}: anyone who has it can send leads to your CRM.</p>
            <div className="field"><label htmlFor={urlInputId}>Webhook URL</label>
              <div className={styles.copyRow}><input id={urlInputId} type={showUrl ? "text" : "password"} autoComplete="off" readOnly value={webhookUrl} onFocus={(event) => event.currentTarget.select()} />
                <button className={styles.copyAction} type="button" aria-pressed={showUrl} onClick={() => setShowUrl((current) => !current)}>{showUrl ? <EyeOff aria-hidden="true" size={16} /> : <Eye aria-hidden="true" size={16} />}{showUrl ? "Hide" : "Show"}</button>
                <button className={`${styles.copyAction}${copied ? ` ${styles.copyActionDone}` : ""}`} type="button" onClick={() => void copyUrl(webhookUrl)}>{copied ? <Check aria-hidden="true" size={16} /> : <Copy aria-hidden="true" size={16} />}{copied ? "Copied" : "Copy URL"}</button></div></div>
            <p className={styles.sendLabel}>Send to your {LABEL} account manager</p>
          </> : <Notice tone="warning" title={`This URL can't be shown. Regenerate it, then send the new URL to your ${LABEL} account manager.`} />}
          {previousUrl ? paused ? <Notice tone="info" title={`Your old URL is paused too. It stops for good on ${formatDateTime(previousUrl.validUntil)}.`} />
            : <Notice tone={oldUrlStillUsed ? "warning" : "info"} title={oldUrlStillUsed
            ? `Leads are still arriving on your old URL. It stops on ${formatDateTime(previousUrl.validUntil)}. Send the new URL to your ${LABEL} account manager.`
            : `Your old URL works until ${formatDateTime(previousUrl.validUntil)}.`} /> : null}
          {confirmReplace ? <span className="field-help">Your old URL keeps working for {NOBROKER_PREVIOUS_URL_DAYS} days. Send the new URL to your {LABEL} account manager before then, or {LABEL} will stop delivering leads.</span> : null}
          <div className={`button-group ${styles.actionRow}`}>
            {confirmReplace ? <>
              <button className="button button--danger" type="button" disabled={busy === "replace"} onClick={() => void run("replace", async () => { await createNoBrokerIntegration(); await reload(); setConfirmReplace(false); setShowUrl(false); setMessage({ tone: "success", text: `New URL created. Send it to your ${LABEL} account manager.` }); })}>{busy === "replace" ? <Loader2 className="spin" aria-hidden="true" size={18} /> : <RefreshCw aria-hidden="true" size={18} />}Regenerate URL</button>
              <button className="button button--secondary" type="button" onClick={() => setConfirmReplace(false)}><X aria-hidden="true" size={18} />Cancel</button>
            </> : <button className={`button ${styles.regenerateButton}`} type="button" onClick={() => setConfirmReplace(true)}><RefreshCw aria-hidden="true" size={18} />Regenerate URL</button>}
            {paused
              ? <button className={`button ${styles.resumeButton}`} type="button" disabled={busy === "resume"} onClick={() => void run("resume", async () => { await setNoBrokerPaused(false); await reload(); })}>{busy === "resume" ? <Loader2 className="spin" aria-hidden="true" size={18} /> : <Play aria-hidden="true" size={18} />}Resume</button>
              : <button className={`button ${styles.pauseButton}`} type="button" disabled={busy === "pause"} onClick={() => setConfirmPause(true)}>{busy === "pause" ? <Loader2 className="spin" aria-hidden="true" size={18} /> : <Pause aria-hidden="true" size={18} />}Pause</button>}
            <button className={`button ${styles.disconnectButton}`} type="button" disabled={busy === "disconnect"} onClick={() => void run("disconnect", async () => { await disconnectNoBroker(); setConfirmReplace(false); setShowUrl(false); await reload(); })}>{busy === "disconnect" ? <Loader2 className="spin" aria-hidden="true" size={18} /> : <Unplug aria-hidden="true" size={18} />}Disconnect</button>
          </div>
        </> : overview.disconnected ? <>
          <p className={styles.disconnectedLine}>Lead delivery stopped<X aria-hidden="true" size={18} /></p>
          <p className="field-help">To receive {LABEL} leads again, generate a new URL and send it to your {LABEL} account manager.</p>
          <div className={`button-group ${styles.actionRow}`}><button className={`button ${styles.generateNewButton}`} type="button" disabled={busy === "create"} onClick={() => void run("create", async () => { await createNoBrokerIntegration(); await reload(); setMessage({ tone: "success", text: `New URL created. Send it to your ${LABEL} account manager.` }); })}>{busy === "create" ? <Loader2 className="spin" aria-hidden="true" size={18} /> : <KeyRound aria-hidden="true" size={18} />}Generate new webhook URL</button></div>
        </> : <>
          <p className="field-help">Create the secret URL {LABEL} will send your leads to.</p>
          <div className="button-group"><button className="button" type="button" disabled={busy === "create"} onClick={() => void run("create", async () => { await createNoBrokerIntegration(); await reload(); })}>{busy === "create" ? <Loader2 className="spin" aria-hidden="true" size={18} /> : <KeyRound aria-hidden="true" size={18} />}Generate webhook URL</button></div>
        </>}
      </div>

      <div className={styles.step}>
        <h3><span className={styles.stepNumber}>2</span>Check that leads arrive</h3>
        {!integration ? <p className="field-help">Generate the webhook URL first.</p>
          : paused ? <>
            <div className="meta-list"><div className="meta-item"><span>Last lead</span><strong>{integration.lastLeadAt ? formatDateTime(integration.lastLeadAt) : "None yet"}</strong></div></div>
            <p className={styles.pausedLine}>Lead delivery paused<Pause aria-hidden="true" size={18} /></p>
          </>
          : integration.lastLeadAt ? <div className={styles.arrival}>
            <strong className={styles.arrivalStatus}>Connected<Check aria-hidden="true" size={18} /></strong>
            <span className="field-help" title={formatDateTime(integration.lastLeadAt)}>Last lead received {nobrokerRelativeTime(integration.lastLeadAt)}</span>
          </div> : <div className="meta-list"><div className="meta-item"><span>Status</span><strong>Waiting for first lead</strong></div></div>}
        {paused ? <p className="field-help">Click Resume to start receiving {LABEL} leads again.</p> : <p className="field-help">The status turns Connected when {LABEL} sends the first lead.</p>}
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
      {confirmPause ? <PauseNoBrokerPopup
        onCancel={() => setConfirmPause(false)}
        onOk={() => { setConfirmPause(false); void run("pause", async () => { await setNoBrokerPaused(true); await reload(); }); }} /> : null}
    </> : null}
  </div></section>;
}

/**
 * Asks before NoBroker leads are paused: Cancel at the top (or Esc) changes nothing; OK pauses. Focus starts on Cancel,
 * so a stray Enter never pauses leads.
 */
function PauseNoBrokerPopup({ onCancel, onOk }: { onCancel: () => void; onOk: () => void }) {
  const titleId = useId();
  const textId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { cancelRef.current?.focus(); }, []);
  return <div className="mvp-invite-popup__backdrop" onKeyDown={(event) => { if (event.key === "Escape") onCancel(); }}>
    <div className={`mvp-invite-popup ${styles.pausePopup}`} role="alertdialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={textId}>
      <button type="button" className={styles.pauseCancel} ref={cancelRef} onClick={onCancel}><X aria-hidden="true" size={16} />Cancel</button>
      <span className={`mvp-invite-popup__icon ${styles.pauseIcon}`} aria-hidden="true"><Pause size={28} /></span>
      <h4 id={titleId}>Pause {LABEL} leads?</h4>
      <p id={textId}>While paused, every lead {LABEL} sends is refused and cannot be recovered later. AgentzPro is not responsible for any leads lost during the pause. Click Resume at any time to start receiving {LABEL} leads in your CRM again.</p>
      <button type="button" className="mvp-invite-popup__ok" onClick={onOk}>OK</button>
    </div>
  </div>;
}

/** "just now", "5 minutes ago", "yesterday", "3 days ago". */
export function nobrokerRelativeTime(iso: string, now = Date.now()): string {
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
