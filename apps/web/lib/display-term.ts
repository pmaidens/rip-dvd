const domainTerms: Readonly<Record<string, string>> = {
  archived: "Already archived",
  audio_cd: "Audio CD",
  blu_ray: "Blu-ray",
  dvd: "DVD",
  dvd_video: "DVD video",
};

export function displayTerm(value: string): string {
  const knownTerm = domainTerms[value];
  if (knownTerm) {
    return knownTerm;
  }

  return value
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}
