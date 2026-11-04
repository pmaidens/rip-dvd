# Disc intake artwork provider constraints

Research checked on 2026-11-03 for [Research movie and TV artwork APIs and usage constraints](https://github.com/pmaidens/rip-dvd/issues/542). This report records provider facts and constraints for specification work. It makes no production change and selects no artwork policy.

## Findings

TMDB has the image APIs needed to investigate movie and TV artwork. Availability is incomplete by design: movie and series image collections include title logos, while Season image collections document posters only. A transparent logo is a possible asset, not a guaranteed response. The proposed disc-shaped crop and logo composition also need a permission decision because the current API terms restrict derivatives of TMDB Content. Technical availability does not settle that question. Sources and the precise limits follow.

## Image contracts

| Intended asset | Official API | Documented image collections |
| --- | --- | --- |
| Movie artwork and title logo | `GET /3/movie/{movie_id}/images` | `backdrops`, `posters`, `logos` |
| TV Show artwork and title logo | `GET /3/tv/{series_id}/images` | `backdrops`, `posters`, `logos` |
| Season-specific artwork | `GET /3/tv/{series_id}/season/{season_number}/images` | `posters` |

These are documented by the [movie image reference](https://developer.themoviedb.org/reference/movie-images), [TV Series image reference](https://developer.themoviedb.org/reference/tv-series-images) and [TV Season image reference](https://developer.themoviedb.org/reference/tv-season-images). There is no documented Season logo collection in these contracts. A Season poster paired with a TV Show logo would be a product choice, not a Season-logo API capability.

The official schema gives these image entries a path, dimensions, aspect ratio, language and vote fields. It does not provide an alpha-transparency flag or a `file_type` field on the movie/series title-logo entries. Treat format and transparency as asset characteristics to check, not inferred guarantees. The [official OpenAPI schema](https://developer.themoviedb.org/openapi/tmdb-api.json) was inspected for the image and configuration paths only; no authenticated media lookup was made.

TMDB's [logo contribution guidelines](https://www.themoviedb.org/bible/image/5bb6259dc3a3687983000001) prefer SVG, then transparent PNG, then PNG with a solid background. They allow varied title-logo shapes. Consequently, an overlay must tolerate a missing logo, an opaque logo, unusual proportions and inadequate contrast. These are design requirements inferred from the accepted asset formats, not claims that every title has suitable art.

The [image basics guide](https://developer.themoviedb.org/docs/image-basics) explains URL construction from image base URL, supported size and returned file path. Its SVG-to-PNG conversion discussion explicitly concerns company/network logos; it must not be generalized into a guarantee for every movie/TV title-logo path.

## Language, sizing and request behavior

Image-list `language` filters results. `include_image_language` adds requested alternatives, including untagged images via `null`. The [image language guide](https://developer.themoviedb.org/docs/image-languages) says regional image variants are not supported and documents separate default selection rules for poster and backdrop paths. Those defaults do not define the application's preferred title-logo order. A sequence such as preferred language, untagged art, original language and plain-disc fallback remains an explicit product decision.

Read the valid image address and per-kind sizes from [configuration details](https://developer.themoviedb.org/reference/configuration-details), including the secure base URL. Do not assume one size set applies to posters, backdrops and logos, or download originals for every carousel thumbnail. [Append To Response](https://developer.themoviedb.org/docs/append-to-response) can combine a details query with supported image subrequests; image-language parameters still affect those subrequests.

[Application authentication](https://developer.themoviedb.org/docs/authentication-application) supports an API key query parameter or an API Read Access Token in an Authorization bearer header. This is application-level access; the image discovery design does not need a user's write-capable TMDB session. Keeping the read credential in the server-side integration and out of returned image URLs is an architectural recommendation for the contract ticket.

[Rate Limiting](https://developer.themoviedb.org/docs/rate-limiting) says the former 40-requests-per-ten-seconds limit was removed. A changeable upper limit remains in roughly the 40-requests-per-second range, and clients must respect HTTP 429. That is not a throughput entitlement. Bounded concurrency and delayed retries are recommendations, rather than an exact backoff algorithm prescribed by that page.

[Errors](https://developer.themoviedb.org/docs/errors) documents invalid credentials, missing resources, service-offline/maintenance responses, backend timeouts and rate limiting. The image pipeline needs distinct unavailable, missing and retryable outcomes. The public documentation reviewed does not guarantee an image-specific Retry-After header, cache TTL, permanent asset URL or successful future refresh. Do not design an unbounded retry loop around an assumed guarantee.

## Usage, attribution and retention

The [developer FAQ](https://developer.themoviedb.org/docs/faq) permits free noncommercial use with attribution, directs commercial users to licensing, and provides no SLA. It requires an approved, less-prominent TMDB logo in an About/Credits-type section plus a prominent non-endorsement notice:

> This product uses the TMDB API but is not endorsed or certified by TMDB.

The same FAQ says TMDB does not claim ownership of API images/data and removes infringing material when notified. API access therefore does not establish ownership of the underlying artwork.

The current [API Terms of Use](https://www.themoviedb.org/api-terms-of-use), sections 1–4, restrict caching beyond six months, derivatives, and commercial use without a separate written agreement. They require attribution and, on termination, cessation of use and purging cached content. These provisions are constraints, not a perpetual artwork license. The six-month ceiling is not a recommended TTL or permission to retain old files indefinitely by labeling them catalog records.

Unresolved permission question: the reviewed terms do not explain whether a CSS disc mask, crop, or logo composition is an allowed presentation or a prohibited derivative. Resolve that with the provider, an applicable agreement, or another permitted asset treatment before specifying the final rendering. Commercial conditions and underlying artwork rights need their own assessment; a noncommercial API credential does not decide them.

The terms page was read directly from TMDB after the search reader could not fetch it. No account sign-in, acceptance of terms or provider contact was performed. The current FAQ and terms use different non-endorsement wording; the attribution decision should reconcile the current authoritative requirements rather than silently choosing one.

## Repository facts

- The [metadata lookup contract](../../packages/application/src/catalog-automation.ts) and [TMDB adapter](../../packages/application/src/tmdb-catalog-adapter.ts) expose identity/title/year and TV Season/Episode metadata, not artwork collections or an image cache. The current adapter sets a request language and has a bounded request timeout; that is not an image-refresh contract.
- The existing [catalog suggestion route](../../apps/web/app/api/catalog-reviews/%5Bid%5D/suggestion/route.ts) accepts an Original Disc Archive identity. It is not an intake-time artwork endpoint for a disc still being inspected or copied.
- The [web security policy](../../apps/web/next.config.ts) allows same-origin/data images and same-origin connections. Direct browser requests to TMDB's image CDN do not fit that current policy. Same-origin asset delivery would fit; changing the policy would be a separate deliberate contract decision.
- The [captured prototype](../../apps/web/components/disc-intake-prototype/README.md) uses synthetic SVG art. It proves layout behavior and supplies no evidence about provider permissions, real asset availability or persistence.

## Decisions left to the specification

1. How movie, TV Show and Season presentation identity is established before Catalog Review, with confidence, correction and provenance kept separate from disc source identity.
2. Which artwork treatment is permitted, including the planned crop/composite, and how attribution appears in the application.
3. Which language/asset ranking and fallback behavior the operator wants when art or a suitable transparent logo is absent.
4. Which server-side asset and metadata records are retained, refreshed and deleted, with bounded lifetimes and withdrawal/termination behavior.
5. How cache misses, expired data, offline operation, provider failures and stale results after media replacement leave the existing archive workflow usable.

These belong to [Decide movie and TV artwork matching and correction](https://github.com/pmaidens/rip-dvd/issues/541) and [Decide artwork delivery, caching and fallback behavior](https://github.com/pmaidens/rip-dvd/issues/543). The research does not choose the answers or authorize changing preservation behavior.
