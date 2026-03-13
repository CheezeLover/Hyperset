import { getCurrentUser } from "@/lib/auth";
import { HypersetLayout } from "@/components/HypersetLayout";
import { getPagesPublicUrl, getSupersetPublicUrl } from "@/lib/public-urls";

export default async function Home() {
  const user = await getCurrentUser();
  const supersetUrl = getSupersetPublicUrl();
  const pagesUrl = getPagesPublicUrl();

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
