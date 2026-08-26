import { DomainInvariantError } from "./errors.js";

declare const discSelectionSourceIdentityBrand: unique symbol;

export type DiscSelectionSourceIdentityInput =
  | {
      readonly kind: "main_feature";
      readonly titleNumber?: never;
      readonly chapterStart?: never;
      readonly chapterEnd?: never;
    }
  | {
      readonly kind: "dvd_title";
      readonly titleNumber: number;
      readonly chapterStart?: never;
      readonly chapterEnd?: never;
    }
  | {
      readonly kind: "dvd_chapters";
      readonly titleNumber: number;
      readonly chapterStart: number;
      readonly chapterEnd: number;
    };

export type DiscSelectionSourceIdentity =
  DiscSelectionSourceIdentityInput & {
    readonly [discSelectionSourceIdentityBrand]: true;
  };

export function discSelectionSourceDescription(
  identity: DiscSelectionSourceIdentity,
): string {
  switch (identity.kind) {
    case "main_feature":
      return "DVD main feature";
    case "dvd_title":
      return `DVD title ${identity.titleNumber}`;
    case "dvd_chapters":
      return `DVD title ${identity.titleNumber}, chapters ${identity.chapterStart}–${identity.chapterEnd}`;
  }
}

export interface DiscSelectionSourceIdentityColumns {
  sourceKey: string;
  kind: DiscSelectionSourceIdentityInput["kind"];
  titleNumber: number | null;
  chapterStart: number | null;
  chapterEnd: number | null;
}

function invalidSourceIdentity(): never {
  throw new DomainInvariantError("Invalid Disc Selection source identity");
}

function requirePositiveSafeInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    return invalidSourceIdentity();
  }
  return value;
}

function hasOnlyKeys(
  input: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(input);
  return keys.length === expected.length &&
    keys.every((key) => expected.includes(key));
}

export function createDiscSelectionSourceIdentity(
  input: DiscSelectionSourceIdentityInput,
): DiscSelectionSourceIdentity {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return invalidSourceIdentity();
  }
  const candidate = input as Record<string, unknown>;
  switch (candidate.kind) {
    case "main_feature":
      if (!hasOnlyKeys(candidate, ["kind"])) {
        return invalidSourceIdentity();
      }
      return Object.freeze({
        kind: candidate.kind,
      }) as DiscSelectionSourceIdentity;
    case "dvd_title":
      if (!hasOnlyKeys(candidate, ["kind", "titleNumber"])) {
        return invalidSourceIdentity();
      }
      return Object.freeze({
        kind: candidate.kind,
        titleNumber: requirePositiveSafeInteger(candidate.titleNumber),
      }) as DiscSelectionSourceIdentity;
    case "dvd_chapters": {
      if (
        !hasOnlyKeys(candidate, [
          "kind",
          "titleNumber",
          "chapterStart",
          "chapterEnd",
        ])
      ) {
        return invalidSourceIdentity();
      }
      const chapterStart = requirePositiveSafeInteger(candidate.chapterStart);
      const chapterEnd = requirePositiveSafeInteger(candidate.chapterEnd);
      if (chapterEnd < chapterStart) {
        return invalidSourceIdentity();
      }
      return Object.freeze({
        kind: candidate.kind,
        titleNumber: requirePositiveSafeInteger(candidate.titleNumber),
        chapterStart,
        chapterEnd,
      }) as DiscSelectionSourceIdentity;
    }
    default:
      return invalidSourceIdentity();
  }
}

export function serializeDiscSelectionSourceIdentity(
  identity: DiscSelectionSourceIdentity,
): DiscSelectionSourceIdentityColumns {
  switch (identity.kind) {
    case "main_feature":
      return {
        sourceKey: "dvd:main-feature",
        kind: identity.kind,
        titleNumber: null,
        chapterStart: null,
        chapterEnd: null,
      };
    case "dvd_title":
      return {
        sourceKey: `dvd:title:${identity.titleNumber}`,
        kind: identity.kind,
        titleNumber: identity.titleNumber,
        chapterStart: null,
        chapterEnd: null,
      };
    case "dvd_chapters":
      return {
        sourceKey:
          `dvd:title:${identity.titleNumber}:chapters:${identity.chapterStart}-${identity.chapterEnd}`,
        kind: identity.kind,
        titleNumber: identity.titleNumber,
        chapterStart: identity.chapterStart,
        chapterEnd: identity.chapterEnd,
      };
  }
}

export function deserializeDiscSelectionSourceIdentity(
  columns: Omit<DiscSelectionSourceIdentityColumns, "sourceKey">,
): DiscSelectionSourceIdentity {
  switch (columns.kind) {
    case "main_feature":
      if (
        columns.titleNumber !== null ||
        columns.chapterStart !== null ||
        columns.chapterEnd !== null
      ) {
        return invalidSourceIdentity();
      }
      return createDiscSelectionSourceIdentity({ kind: columns.kind });
    case "dvd_title":
      if (
        columns.titleNumber === null ||
        columns.chapterStart !== null ||
        columns.chapterEnd !== null
      ) {
        return invalidSourceIdentity();
      }
      return createDiscSelectionSourceIdentity({
        kind: columns.kind,
        titleNumber: columns.titleNumber,
      });
    case "dvd_chapters":
      if (
        columns.titleNumber === null ||
        columns.chapterStart === null ||
        columns.chapterEnd === null
      ) {
        return invalidSourceIdentity();
      }
      return createDiscSelectionSourceIdentity({
        kind: columns.kind,
        titleNumber: columns.titleNumber,
        chapterStart: columns.chapterStart,
        chapterEnd: columns.chapterEnd,
      });
  }
}
