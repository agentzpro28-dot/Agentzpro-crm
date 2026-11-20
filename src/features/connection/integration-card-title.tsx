import { ExternalLink } from "lucide-react";
import type { ComponentType } from "react";

/** A link to this lead source's public setup guide (/docs/integrations/...), opened in a new tab so the CRM tab stays as it is. */
export type IntegrationGuideLink = { href: string; text: string };

/**
 * Heading of one lead-source card on the Integrations page: an icon badge (brand logo or icon), the title, a one-line
 * description and, when given, a link to the setup guide.
 */
export function IntegrationCardTitle({ id, icon: Icon, title, description, guide }: { id: string; icon: ComponentType<{ size?: number }>; title: string; description: string; guide?: IntegrationGuideLink }) {
  return <div className="integration-card__title">
    <span className="integration-card__icon" aria-hidden="true"><Icon size={20} /></span>
    <div><h2 id={id}>{title}</h2><p>{description}</p>
      {guide ? <p className="integration-card__guide"><a href={guide.href} target="_blank" rel="noopener noreferrer">{guide.text}<ExternalLink aria-hidden="true" size={14} /><span className="sr-only"> (opens in a new tab)</span></a></p> : null}
    </div>
  </div>;
}
