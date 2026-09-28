import { OperationsDashboard } from "../../components/operations-dashboard";
import { CatalogRecoveryPrototype } from "../../components/catalog-recovery-prototype";

export const dynamic = "force-dynamic";

export default async function CatalogPage({
  searchParams,
}: {
  searchParams: Promise<{ variant?: string }>;
}) {
  const variant = (await searchParams).variant;
  if (
    process.env.NODE_ENV !== "production" &&
    (variant === "inline" || variant === "split" || variant === "staged")
  ) {
    return <CatalogRecoveryPrototype initialVariant={variant} surface="catalog" />;
  }
  return <OperationsDashboard page="catalog" />;
}
