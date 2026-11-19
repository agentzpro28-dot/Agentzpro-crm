import { redirect } from "next/navigation";

/** /docs has no content of its own yet: it opens straight on the Integrations doc, Facebook first. */
export default function DocsPage(): never {
  redirect("/docs/integrations/facebook");
}
