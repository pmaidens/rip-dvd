import { OperationsDashboard } from "../../components/operations-dashboard";
import { DiscIntakePrototype } from "../../components/disc-intake-prototype/prototype";

export const dynamic = "force-dynamic";

export default async function DiscsPage({ searchParams }: { searchParams: Promise<{ variant?: string }> }) {
  const { variant } = await searchParams;
  if (process.env.NODE_ENV === "development" && (variant === "A" || variant === "B" || variant === "C")) {
    return <DiscIntakePrototype variant={variant} />;
  }
  return <OperationsDashboard page="discs" />;
}
