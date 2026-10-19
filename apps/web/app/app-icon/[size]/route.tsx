import { ImageResponse } from "next/og";

export async function GET(_request: Request, context: { params: Promise<{ size: string }> }) {
  const { size: requested } = await context.params;
  const size = Number(requested);
  if (![180, 192, 512].includes(size)) return new Response("Not found", { status: 404 });
  return new ImageResponse(<div style={{ display: "flex", width: "100%", height: "100%", alignItems: "center", justifyContent: "center",
    background: "#101827", color: "#ffffff", fontSize: size * 0.65, fontWeight: 700 }}>R</div>, { width: size, height: size });
}
