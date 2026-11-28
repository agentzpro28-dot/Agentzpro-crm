"use client";

import { Building2, Check, Copy, Eye, EyeOff, KeyRound, Loader2, Pause, Play, RefreshCw, Unplug, X } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { LoadingState, Notice, StatusBadge } from "@/components/ui";
import { IntegrationCardTitle } from "@/features/connection/integration-card-title";
import { formatDateTime } from "@/lib/date-utils";
import { PORTAL_PREVIOUS_URL_DAYS, PORTALS, type PortalId, type PortalIntegrationOverview } from "@/lib/portal-leads/portals";
import { createPortalIntegration, disconnectPortalIntegration, getPortalIntegrationOverview, setPortalIntegrationPaused } from "@/services/crm-api-client";
import styles from "./portal-integration-card.module.css";

type Busy = "create" | "replace" | "refresh" | "pause" | "resume" | "disconnect" | null;
type Message = { tone: "success" | "danger" | "warning" | "info"; text: string };

/**
 * A real-estate portal (99acres) on the Integrations page: the company's own secret webhook URL and the 2 setup steps.
 * (Sending the URL to the portal is covered in detail on the public docs page, not repeated here.)
 * Only when a request could not be saved does a "Failed requests" list appear (the last 10: when and why), so the owner
 * knows to contact us; the raw requests stay with our support team. The URL is the only secret, so it is shown only to
 * the owner, hidden until asked.
 */
export function PortalIntegrationCard({ portal }: { portal: PortalId }) {
  const { label } = PORTALS[portal];
  const [overview, setOverview] = useState<PortalIntegrationOverview | null>(null);
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
    void getPortalIntegrationOverview(portal)
      .then((data) => { if (active) setOverview(data); })
      .catch((error: unknown) => { if (active) setMessage({ tone: "danger", text: errorText(error, `${label} details could not be loaded. Try again.`) }); })
      .finally(() => { if (active) setIsLoading(false); });
    return () => { active = false; };
  }, [portal, label]);

  const reload = useCallback(async (): Promise<void> => {
    setOverview(await getPortalIntegrationOverview(portal));
  }, [portal]);

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
  const paused = integration?.paused === true;
  const badge = !overview ? null
    : paused ? { tone: "warning" as const, text: "Paused" }
    : integration ? (integration.lastLeadAt ? { tone: "success" as const, text: "Connected" } : { tone: "warning" as const, text: "Waiting for first lead" })
      : overview.disconnected ? { tone: "danger" as const, text: "Disconnected" }
      : overview.hasIntegration && !canManage ? { tone: "success" as const, text: "Set up" } : { tone: "info" as const, text: "Not set up" };

  return <section className={`panel integration-card integration-card--portal integration-card--portal-${portal}`} aria-labelledby={titleId}><div className="panel__body stack">
    <div className="section-title"><IntegrationCardTitle id={titleId} icon={Building2} title={label} description={`Receive property enquiries from your ${label} account automatically.`} guide={{ href: `/docs/integrations/${portal}`, text: "Read the setup guide before you generate your webhook URL" }} />
      {badge ? <StatusBadge tone={badge.tone}>{badge.text}</StatusBadge> : null}
    </div>
    {message ? <Notice tone={message.tone} title={message.text} /> : null}
    {isLoading ? <LoadingState label={`Loading ${label} details`} /> : null}
    {overview && !canManage ? <Notice tone="info" title={`Only the company owner can set up ${label}.`} /> : null}
    {overview && canManage ? <>
      <div className="google-ads-step">
        <h3><span className="google-step-number">1</span>Generate your webhook URL</h3>
        {integration ? <>
          {webhookUrl ? <>
            <p className="field-help"><strong>Keep this URL secret.</strong> Give it only to {label}: anyone who has it can send leads to your CRM.</p>
            <div className="field"><label htmlFor={urlInputId}>Webhook URL</label>
              <div className="google-copy-row"><input id={urlInputId} type={showUrl ? "text" : "password"} autoComplete="off" readOnly value={webhookUrl} onFocus={(event) => event.currentTarget.select()} />
                <button className="google-copy-row__action" type="button" aria-pressed={showUrl} onClick={() => setShowUrl((current) => !current)}>{showUrl ? <EyeOff aria-hidden="true" size={16} /> : <Eye aria-hidden="true" size={16} />}{showUrl ? "Hide" : "Show"}</button>
                <button className={`google-copy-row__action${copied ? " google-copy-row__action--done" : ""}`} type="button" onClick={() => void copyUrl(webhookUrl)}>{copied ? <Check aria-hidden="true" size={16} /> : <Copy aria-hidden="true" size={16} />}{copied ? "Copied" : "Copy URL"}</button></div></div>
          </> : <Notice tone="warning" title={`This URL can't be shown. Regenerate it, then send the new URL to ${label}.`} />}
          {integration.previousUrl ? paused ? <Notice tone="info" title={`Your old URL is paused too. It stops for good on ${formatDateTime(integration.previousUrl.validUntil)}.`} />
            : <Notice tone={integration.previousUrl.lastLeadAt ? "warning" : "info"} title={integration.previousUrl.lastLeadAt
            ? `Leads are still arriving on your old URL. It stops on ${formatDateTime(integration.previousUrl.validUntil)}. Send the new URL to ${label}.`
            : `Your old URL works until ${formatDateTime(integration.previousUrl.validUntil)}.`} /> : null}
          {confirmReplace ? <span className="field-help">Your old URL keeps working for {PORTAL_PREVIOUS_URL_DAYS} days. Send the new URL to {label} before then, or {label} will stop delivering leads.</span> : null}
          <div className={`button-group ${styles.actionRow}`}>
            {confirmReplace ? <>
              <button className="button button--danger" type="button" disabled={busy === "replace"} onClick={() => void run("replace", async () => { await createPortalIntegration(portal); await reload(); setConfirmReplace(false); setShowUrl(false); setMessage({ tone: "success", text: `New URL created. Send it to ${label}.` }); })}>{busy === "replace" ? <Loader2 className="spin" aria-hidden="true" size={18} /> : <RefreshCw aria-hidden="true" size={18} />}Regenerate URL</button>
              <button className="button button--secondary" type="button" onClick={() => setConfirmReplace(false)}><X aria-hidden="true" size={18} />Cancel</button>
            </> : <button className={`button ${styles.regenerateButton}`} type="button" onClick={() => setConfirmReplace(true)}><RefreshCw aria-hidden="true" size={18} />Regenerate URL</button>}
            {paused
              ? <button className={`button ${styles.resumeButton}`} type="button" disabled={busy === "resume"} onClick={() => void run("resume", async () => { await setPortalIntegrationPaused(portal, false); await reload(); })}>{busy === "resume" ? <Loader2 className="spin" aria-hidden="true" size={18} /> : <Play aria-hidden="true" size={18} />}Resume</button>
              : <button className={`button ${styles.pauseButton}`} type="button" disabled={busy === "pause"} onClick={() => setConfirmPause(true)}>{busy === "pause" ? <Loader2 className="spin" aria-hidden="true" size={18} /> : <Pause aria-hidden="true" size={18} />}Pause</button>}
            <button className={`button ${styles.disconnectButton}`} type="button" disabled={busy === "disconnect"} onClick={() => void run("disconnect", async () => { await disconnectPortalIntegration(portal); setConfirmReplace(false); setShowUrl(false); await reload(); })}>{busy === "disconnect" ? <Loader2 className="spin" aria-hidden="true" size={18} /> : <Unplug aria-hidden="true" size={18} />}Disconnect</button>
          </div>
        </> : overview.disconnected ? <>
          <p className={styles.disconnectedLine}>Lead delivery stopped<X aria-hidden="true" size={18} /></p>
          <p className="field-help">To receive {label} leads again, generate a new URL and send it to your {label} account manager.</p>
          <div className="button-group"><button className="button" type="button" disabled={busy === "create"} onClick={() => void run("create", async () => { await createPortalIntegration(portal); await reload(); setMessage({ tone: "success", text: `New URL created. Send it to ${label}.` }); })}>{busy === "create" ? <Loader2 className="spin" aria-hidden="true" size={18} /> : <KeyRound aria-hidden="true" size={18} />}Generate new webhook URL</button></div>
        </> : <>
          <p className="field-help">Create the secret URL {label} will send your leads to.</p>
          <div className="button-group"><button className="button" type="button" disabled={busy === "create"} onClick={() => void run("create", async () => { await createPortalIntegration(portal); await reload(); })}>{busy === "create" ? <Loader2 className="spin" aria-hidden="true" size={18} /> : <KeyRound aria-hidden="true" size={18} />}Generate webhook URL</button></div>
        </>}
      </div>

      <div className="google-ads-step">
        <h3><span className="google-step-number">2</span>Check that leads arrive</h3>
        {!integration ? <p className="field-help">Generate the webhook URL first.</p>
          : paused ? <>
            <div className="meta-list"><div className="meta-item"><span>Last lead</span><strong>{integration.lastLeadAt ? formatDateTime(integration.lastLeadAt) : "None yet"}</strong></div></div>
            <p className={styles.pausedLine}>Lead delivery paused<Pause aria-hidden="true" size={18} /></p>
          </>
          : integration.lastLeadAt ? <div className="google-arrival">
            <strong className="google-arrival__status">Connected<Check aria-hidden="true" size={18} /></strong>
            <span className="field-help" title={formatDateTime(integration.lastLeadAt)}>Last lead received {relativeTime(integration.lastLeadAt)}</span>
          </div> : <div className="meta-list"><div className="meta-item"><span>Status</span><strong>Waiting for first lead</strong></div></div>}
        {paused ? <p className="field-help">Click Resume to start receiving {label} leads again.</p> : <p className="field-help">The status turns Connected when {label} sends the first lead.</p>}
        {integration ? <div className="button-group">
          <button className="button button--secondary" type="button" disabled={busy === "refresh"} onClick={() => void run("refresh", reload)}>{busy === "refresh" ? <Loader2 className="spin" aria-hidden="true" size={18} /> : <RefreshCw aria-hidden="true" size={18} />}Refresh</button>
        </div> : null}
      </div>

      {integration && integration.failedRequests.length > 0 ? <div className="integration-card__section">
        <div className="section-title"><div><h3>Failed requests</h3><p>These {label} enquiries could not be saved. Contact AgentzPro support with the time shown.</p></div></div>
        <ul className="portal-log-list">{integration.failedRequests.map((entry) => <li key={entry.id} className="portal-log">
          <div className="portal-log__row">
            <span className="portal-log__time">{formatDateTime(entry.createdAt)}</span>
            <StatusBadge tone="danger">Failed</StatusBadge>
          </div>
          <p className="portal-log__error">{entry.reason}</p>
        </li>)}</ul>
      </div> : null}
      {confirmPause ? <PausePortalPopup
        label={label}
        onCancel={() => setConfirmPause(false)}
        onOk={() => { setConfirmPause(false); void run("pause", async () => { await setPortalIntegrationPaused(portal, true); await reload(); }); }} /> : null}
    </> : null}
  </div></section>;
}

/**
 * Asks before this portal's leads are paused: Cancel at the top (or Esc) changes nothing; OK pauses. Focus starts on
 * Cancel, so a stray Enter never pauses leads.
 */
function PausePortalPopup({ label, onCancel, onOk }: { label: string; onCancel: () => void; onOk: () => void }) {
  const titleId = useId();
  const textId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { cancelRef.current?.focus(); }, []);
  return <div className="mvp-invite-popup__backdrop" onKeyDown={(event) => { if (event.key === "Escape") onCancel(); }}>
    <div className={`mvp-invite-popup ${styles.pausePopup}`} role="alertdialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={textId}>
      <button type="button" className={styles.pauseCancel} ref={cancelRef} onClick={onCancel}><X aria-hidden="true" size={16} />Cancel</button>
      <span className={`mvp-invite-popup__icon ${styles.pauseIcon}`} aria-hidden="true"><Pause size={28} /></span>
      <h4 id={titleId}>Pause {label} leads?</h4>
      <p id={textId}>While paused, every lead {label} sends is refused and cannot be recovered later. AgentzPro is not responsible for any leads lost during the pause. Click Resume at any time to start receiving {label} leads in your CRM again.</p>
      <button type="button" className="mvp-invite-popup__ok" onClick={onOk}>OK</button>
    </div>
  </div>;
}

/** "just now", "5 minutes ago", "yesterday", "3 days ago". */
export function relativeTime(iso: string, now = Date.now()): string {
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
