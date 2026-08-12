import type { MediaItemSearchDto } from "./catalog-review-model";

type MediaItemSearchFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export async function requestMediaItemSearch(
  query: string,
  offset: number,
  fetcher: MediaItemSearchFetch = fetch,
): Promise<MediaItemSearchDto> {
  const parameters = new URLSearchParams({
    query,
    offset: String(offset),
  });
  const response = await fetcher(`/api/media-items?${parameters.toString()}`, {
    cache: "no-store",
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error("Media Item search failed");
  }
  return response.json() as Promise<MediaItemSearchDto>;
}
