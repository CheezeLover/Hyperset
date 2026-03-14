import { getCurrentUser } from "@/lib/auth";
import { HypersetLayout } from "@/components/HypersetLayout";

export default async function Home() {
  const user = await getCurrentUser();

  const domain = (process.env.HYPERSET_DOMAIN || "").trim() || "hyperset.internal";
  const explicitSupersetUrl = (process.env.SUPERSET_PUBLIC_URL || "").trim();
  const explicitPagesUrl = (process.env.PAGES_PUBLIC_URL || "").trim();
  
  const supersetUrl = explicitSupersetUrl || `https://superset.${domain}`;
  const pagesUrl = explicitPagesUrl || `https://pages.${domain}`;

  console.log("DEBUG: domain:", domain, "pagesUrl:", pagesUrl);

  return (
    <HypersetLayout
      supersetUrl={supersetUrl}
      pagesUrl={pagesUrl}
      isAdmin={user.isAdmin}
      userId={user.id}
      userRoles={user.roles}
    />
  );
}
