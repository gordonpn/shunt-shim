import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const corpusPath = new URL(
  "../scripts/eval/decision-cases.jsonl",
  import.meta.url,
);
const rubrics = {
  intent: {
    id: "project-intent",
    kind: "choice",
    values: ["question", "change_request", "status_request", "out_of_domain"],
  },
  provider: {
    id: "eligible-provider-fit",
    kind: "choice",
    values: ["atlas", "lyra", "none"],
  },
  relevance: {
    id: "evidence-relevance",
    kind: "binary",
    values: [true, false],
  },
  recommendation: { id: "preference-fit", kind: "score", values: [0, 1, 2, 3] },
  tool: {
    id: "bounded-agent-action",
    kind: "choice",
    values: [
      "answer",
      "read_local",
      "search_web",
      "edit_local",
      "escalate",
      "reject",
    ],
  },
} as const;

type Category = keyof typeof rubrics;
type Case = {
  schemaVersion: number;
  id: string;
  category: Category;
  split: "tuning" | "holdout";
  tags: string[];
  kind: "binary" | "choice" | "score";
  rubric: { id: string; version: number };
  input: Record<string, unknown>;
  expected: {
    value: string | number | boolean | null;
    allowedAbstentions: string[];
  };
  annotation: { method: string; reviewer: string; rationale: string };
};

// Keep loading inside tests so a missing corpus produces an assertion failure.
function loadCases(): Case[] {
  expect(
    existsSync(corpusPath),
    "the versioned offline corpus must exist",
  ).toBe(true);
  const text = readFileSync(corpusPath, "utf8");
  expect(text.endsWith("\n"), "JSONL must end with a newline").toBe(true);
  return text
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line) as Case);
}

describe("offline decision evaluation corpus", () => {
  it("contains 50 unique, nonduplicate fixed inputs", () => {
    const cases = loadCases();
    expect(cases).toHaveLength(50);
    expect(new Set(cases.map((item) => item.id)).size).toBe(50);
    expect(new Set(cases.map((item) => JSON.stringify(item.input))).size).toBe(
      50,
    );
    for (const item of cases) {
      expect(item.id).toMatch(
        /^(intent|provider|relevance|recommendation|tool)-\d{2}$/,
      );
      expect(item.id.startsWith(`${item.category}-`)).toBe(true);
    }
  });

  it("keeps ten cases per category and a fixed 30/20 tuning/holdout split", () => {
    const cases = loadCases();
    for (const category of Object.keys(rubrics)) {
      const subset = cases.filter((item) => item.category === category);
      expect(subset, category).toHaveLength(10);
      expect(subset.filter((item) => item.split === "tuning")).toHaveLength(6);
      expect(subset.filter((item) => item.split === "holdout")).toHaveLength(4);
      const tags = new Set(subset.flatMap((item) => item.tags));
      for (const tag of [
        "positive",
        "negative",
        "boundary",
        "out_of_domain",
        "adversarial",
        "missing_context",
      ]) {
        expect(tags.has(tag), `${category} needs ${tag} coverage`).toBe(true);
      }
    }
  });

  it("preserves split membership and category-specific input fields", () => {
    const textFields: Record<Category, string[]> = {
      intent: ["message", "context"],
      provider: ["request", "requiredCapability"],
      relevance: ["query", "evidenceNeed", "result"],
      recommendation: [],
      tool: ["request", "context"],
    };
    for (const item of loadCases()) {
      const ordinal = Number(item.id.split("-").at(-1));
      expect(item.split).toBe(ordinal <= 6 ? "tuning" : "holdout");
      for (const field of textFields[item.category]) {
        expect(item.input[field], `${item.id}.${field}`).toBeTypeOf("string");
      }
      if (item.category === "recommendation") {
        const preferences = item.input.preferences as Record<string, unknown>;
        expect(preferences).toBeTypeOf("object");
        expect(preferences).not.toBeNull();
        for (const key of ["hardExclusions", "likes", "dislikes"]) {
          expect(Array.isArray(preferences[key])).toBe(true);
          for (const value of preferences[key] as unknown[])
            expect(value).toBeTypeOf("string");
        }
        const candidate = item.input.candidate as Record<string, unknown>;
        expect(candidate).toBeTypeOf("object");
        expect(candidate).not.toBeNull();
        for (const key of ["title", "medium", "description"])
          expect(candidate[key]).toBeTypeOf("string");
      }
      if (item.category === "tool") {
        expect(Array.isArray(item.input.tools)).toBe(true);
        for (const value of item.input.tools as unknown[])
          expect(value).toBeTypeOf("string");
      }
    }
  });

  it("validates schema, rubric versions, labels and manual annotation provenance", () => {
    for (const item of loadCases()) {
      expect(Object.keys(item).sort()).toEqual([
        "annotation",
        "category",
        "expected",
        "id",
        "input",
        "kind",
        "rubric",
        "schemaVersion",
        "split",
        "tags",
      ]);
      expect(item.schemaVersion).toBe(1);
      expect(Object.keys(rubrics)).toContain(item.category);
      const rubric = rubrics[item.category];
      expect(item.rubric).toEqual({ id: rubric.id, version: 1 });
      expect(item.kind).toBe(rubric.kind);
      expect(["tuning", "holdout"]).toContain(item.split);
      expect(Array.isArray(item.tags)).toBe(true);
      expect(item.tags.length).toBeGreaterThan(0);
      expect(new Set(item.tags).size).toBe(item.tags.length);
      expect(item.input).toBeTypeOf("object");
      expect(item.input).not.toBeNull();
      expect(Array.isArray(item.input)).toBe(false);
      expect(Object.keys(item.input).length).toBeGreaterThan(1);
      expect(Object.keys(item.expected).sort()).toEqual([
        "allowedAbstentions",
        "value",
      ]);
      if (item.expected.value === null) {
        expect(item.expected.allowedAbstentions).toEqual(["missing_context"]);
        expect(item.tags).toContain("missing_context");
      } else {
        expect(rubric.values as readonly unknown[]).toContain(
          item.expected.value,
        );
        expect(item.expected.allowedAbstentions).toEqual([]);
      }
      expect(item.annotation.method).toBe("manual-synthetic-review");
      expect(item.annotation.reviewer).toBe("corpus-author");
      expect(item.annotation.rationale.trim().length).toBeGreaterThan(45);
    }
  });

  it("covers both binary labels, every rubric choice and all ordered score anchors", () => {
    const cases = loadCases();
    for (const [category, rubric] of Object.entries(rubrics)) {
      const values = cases
        .filter((item) => item.category === category)
        .map((item) => item.expected.value);
      for (const value of rubric.values)
        expect(values, category).toContain(value);
      expect(values, `${category} needs a defined abstention case`).toContain(
        null,
      );
    }
  });

  it("never labels an unavailable, unverified, exhausted or unsupported provider as eligible", () => {
    for (const item of loadCases().filter(
      (entry) => entry.category === "provider",
    )) {
      expect(item.input.policy).toEqual({
        paidFallbackAllowed: false,
        availabilityOverridesAllowed: false,
      });
      const candidates = item.input.candidates as {
        id: string;
        available: boolean;
        freeEntitlementVerified: boolean;
        remainingRequests: number;
        capabilities: string[];
        profile: string;
      }[];
      expect(candidates.map((candidate) => candidate.id)).toEqual([
        "atlas",
        "lyra",
      ]);
      for (const candidate of candidates) {
        expect(candidate.available).toBeTypeOf("boolean");
        expect(candidate.freeEntitlementVerified).toBeTypeOf("boolean");
        expect(Number.isInteger(candidate.remainingRequests)).toBe(true);
        expect(candidate.remainingRequests).toBeGreaterThanOrEqual(0);
        expect(candidate.profile.length).toBeGreaterThan(15);
        expect(
          candidate.capabilities.every((capability) =>
            ["binary", "choice", "score"].includes(capability),
          ),
        ).toBe(true);
      }
      const eligible = candidates.filter(
        (candidate) =>
          candidate.available &&
          candidate.freeEntitlementVerified &&
          candidate.remainingRequests > 0 &&
          candidate.capabilities.includes(
            String(item.input.requiredCapability),
          ),
      );
      if (item.expected.value === "none") expect(eligible).toHaveLength(0);
      else if (item.expected.value !== null)
        expect(eligible.map((candidate) => candidate.id)).toContain(
          item.expected.value,
        );
    }
  });

  it("keeps tool labels within explicit permissions and the available tool set", () => {
    for (const item of loadCases().filter(
      (entry) => entry.category === "tool",
    )) {
      const authorization = item.input.authorization as Record<string, boolean>;
      for (const permission of [
        "readLocal",
        "writeLocal",
        "externalNetwork",
        "destructive",
      ]) {
        expect(authorization[permission]).toBeTypeOf("boolean");
      }
      expect(authorization.destructive).toBe(false);
      if (
        ["read_local", "edit_local", "search_web"].includes(
          String(item.expected.value),
        )
      ) {
        expect(item.input.tools).toContain(item.expected.value);
        const permission = {
          read_local: "readLocal",
          edit_local: "writeLocal",
          search_web: "externalNetwork",
        }[String(item.expected.value)];
        expect(authorization[permission ?? ""]).toBe(true);
      }
    }
  });
});
