import { getCurrentUser } from "@/lib/auth";
import { HypersetLayout } from "@/components/HypersetLayout";

export default async function Home() {
  const user = await getCurrentUser();

  const domain = process.env.HYPERSET_DOMAIN ?? "hyperset.internal";
  const supersetUrl =
    (process.env.SUPERSET_PUBLIC_URL || "").trim() ||
    `https://superset.${domain}`;
  const pagesUrl =
    (process.env.PAGES_PUBLIC_URL || "").trim() ||
    `https://pages.${domain}`;

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
