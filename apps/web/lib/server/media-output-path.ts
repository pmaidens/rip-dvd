function normalizedAbsolutePath(value: string): string | null {
  if (!value.startsWith("/") || value.includes("\0")) {
    return null;
  }
  const segments: string[] = [];
  for (const segment of value.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (segments.length === 0) return null;
      segments.pop();
    } else {
      segments.push(segment);
    }
  }
  return `/${segments.join("/")}`;
}

export function mediaOutputPath(
  value: unknown,
  mediaLibraryPath: string,
): string | null {
  if (typeof value !== "string") return null;
  const requested = value.trim();
  if (requested.length === 0 || requested.length > 4_096) return null;
  const library = normalizedAbsolutePath(mediaLibraryPath);
  const outputPath = normalizedAbsolutePath(requested);
  if (
    library === null ||
    outputPath === null ||
    library === "/" ||
    !outputPath.startsWith(`${library}/`) ||
    !outputPath.toLowerCase().endsWith(".mkv")
  ) return null;
  return outputPath;
}
