import { loadConfig } from "@rip-dvd/config";
import Link from "next/link";

export const dynamic = "force-dynamic";

export default function Home() {
  loadConfig();

  return (
    <main>
      <p className="eyebrow">rip-dvd</p>
      <h1>The control plane is running.</h1>
      <p>
        Web, archive, and encode runtimes are ready for the next implementation
        slice.
      </p>
      <Link className="health-link" href="/health">
        View service health
      </Link>
    </main>
  );
}
