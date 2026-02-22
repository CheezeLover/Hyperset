import { getCurrentUser } from "@/lib/auth";
import { HypersetLayout } from "@/components/HypersetLayout";

export default async function Home() {
  const user = await getCurrentUser();

  const supersetUrl =
    process.env.SUPERSET_PUBLIC_URL ??
    `https://superset.${process.env.HYPERSET_DOMAIN ?? "hyperset.internal"}`;
  const pagesUrl =
    process.env.PAGES_PUBLIC_URL ??
    `https://pages.${process.env.HYPERSET_DOMAIN ?? "hyperset.internal"}`;

  return (
    <HypersetLayout
      supersetUrl={supersetUrl}
      pagesUrl={pagesUrl}
      isAdmin={user.isAdmin}
      userId={user.id}
    />
  );
}
