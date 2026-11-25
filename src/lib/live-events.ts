/**
 * Fired on window when the live stream says a lead was added, changed or deleted, when the stream is live again after
 * being down, and when the tab comes back into view. /leads then checks for new leads (its bar), and a tab in the
 * background checks whether to show the "New lead" pop-up. For an update its detail is a LeadChangeDetail (when the
 * newest changed lead was saved), so /leads can skip changes to older leads; every other case has no detail.
 * Kept in its own module so the shell (task-bell.tsx) and the hooks it mounts can share it without importing each other.
 */
export const LEADS_CHANGED_EVENT = "agentz:leads-changed";
