import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return { id: "/", name: "Rip DVD", short_name: "Rip DVD", description: "Disc preservation and encoding operations",
    start_url: "/", scope: "/", display: "standalone", background_color: "#101827", theme_color: "#101827",
    icons: [{ src: "/app-icon/192", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/app-icon/512", sizes: "512x512", type: "image/png", purpose: "any" }] };
}
