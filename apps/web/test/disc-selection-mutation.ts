let mutationKeyIndex = 0;

type InvokeCatalogReviewMutation = (
  body: Record<string, unknown>,
) => Promise<Response>;

export async function acknowledgedDiscSelectionCommand(
  invoke: InvokeCatalogReviewMutation,
  command: Record<string, unknown>,
) {
  const previewResponse = await invoke({ ...command, preview: true });
  const preview = await previewResponse.json() as {
    state: string;
    catalogRevision?: string;
    previewToken?: string;
  };
  if (previewResponse.status !== 200 || preview.state !== "available" ||
      !preview.catalogRevision || !preview.previewToken) {
    throw new Error("Expected an available Disc Selection preview");
  }
  mutationKeyIndex += 1;
  return {
    ...command,
    mutationKey: `00000000-0000-4000-8000-${String(mutationKeyIndex).padStart(12, "0")}`,
    expectedCatalogRevision: preview.catalogRevision,
    previewToken: preview.previewToken,
    acknowledge: true,
  };
}

export async function previewAndApplyDiscSelection(
  invoke: InvokeCatalogReviewMutation,
  command: Record<string, unknown>,
) {
  return invoke(await acknowledgedDiscSelectionCommand(invoke, command));
}
