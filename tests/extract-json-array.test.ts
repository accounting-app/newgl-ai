import { describe, expect, test } from "bun:test";

import { extractJsonArray } from "@/infra/anthropic/client";

describe("extractJsonArray", () => {
  test("leaves bare JSON alone", () => {
    expect(JSON.parse(extractJsonArray('[{"index":0}]'))).toEqual([{ index: 0 }]);
  });

  test("strips a markdown code fence", () => {
    const fenced = '```json\n[{"index":0,"accountIndex":2,"confidence":0.9,"reason":"fits"}]\n```';
    expect(JSON.parse(extractJsonArray(fenced))).toHaveLength(1);
  });

  test("ignores prose around the array", () => {
    expect(JSON.parse(extractJsonArray('Here you go: [{"index":1}] Hope that helps!'))).toEqual([{ index: 1 }]);
  });
});
