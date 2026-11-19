import { redirect } from "next/navigation";

/** The Integrations sidebar item with no platform chosen defaults to Facebook, same order as the Integrations page. */
export default function DocsIntegrationsPage(): never {
  redirect("/docs/integrations/facebook");
}
