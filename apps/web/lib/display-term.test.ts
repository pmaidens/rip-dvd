import { describe, expect, it } from "vitest";

import { displayTerm } from "./display-term";

describe("displayTerm", () => {
  it("formats known media terms and generic domain values", () => {
    expect(displayTerm("archived")).toBe("Already archived");
    expect(displayTerm("audio_cd")).toBe("Audio CD");
    expect(displayTerm("blu_ray")).toBe("Blu-ray");
    expect(displayTerm("dvd")).toBe("DVD");
    expect(displayTerm("dvd_video")).toBe("DVD video");
    expect(displayTerm("in_progress")).toBe("In Progress");
  });
});
