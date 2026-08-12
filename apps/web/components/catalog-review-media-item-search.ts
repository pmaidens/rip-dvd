import type { MediaItemSearchDto } from "./catalog-review-model";

type MediaItemSearchFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export async function requestMediaItemSearch(
  query: string,
  offset: number,
  options: { archiveId?: string } = {},
  fetcher: MediaItemSearchFetch = fetch,
): Promise<MediaItemSearchDto> {
  const parameters = new URLSearchParams({
    query,
    offset: String(offset),
  });
  if (options.archiveId !== undefined) {
    parameters.set("archiveId", options.archiveId);
  }
  const response = await fetcher(`/api/media-items?${parameters.toString()}`, {
    cache: "no-store",
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error("Media Item search failed");
  }
  return response.json() as Promise<MediaItemSearchDto>;
}
