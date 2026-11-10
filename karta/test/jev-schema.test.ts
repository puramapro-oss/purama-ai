import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import {
  JEV_MODEL,
  JevValidationError,
  validateJevRequest,
  validateJevResponse,
} from "../src/jev/schema.js";

function makeRequest() {
  return {
    state: "Résultat à vérifier : création terminée 🧠, 東京.",
    questions: {
      ready: {
        type: "noul" as const,
        instructions: "Le résultat satisfait-il les exigences ?",
        criteria: { true: "Exigences vérifiées", false: "Exigences manquantes" },
      },
      route: {
        type: "choice" as const,
        instructions: "Choisir la suite appropriée.",
        criteria: { keep: "Conserver", change: "Corriger" },
      },
      rating: {
        type: "score" as const,
        instructions: "Évaluer la complétude.",
        criteria: ["Absent", "Partiel", "Complet"],
      },
    },
  };
}

function makeResponse() {
  return {
    model: JEV_MODEL,
    answers: {
      ready: { type: "noul" as const, noul: 0.85 },
      route: {
        type: "choice" as const,
        choice: "keep",
        probabilities: { keep: 0.7, change: 0.3 },
        confidence: 0.8,
      },
      rating: {
        type: "score" as const,
        score: 1.1,
        probabilities: { "0": 0.2, "1": 0.5, "2": 0.3 },
        legend: { "0": "Absent", "1": "Partiel", "2": "Complet" },
        confidence: 0.75,
      },
    },
    usage: { input_tokens: 120, output_tokens: 30 },
  };
}

function singleQuestion(question: unknown = { type: "noul", instructions: "Vérifier." }) {
  return { state: "Preuve disponible.", questions: { q: question } };
}

function freezeDeep<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

function wireSize(request: ReturnType<typeof singleQuestion>): number {
  return Buffer.byteLength(JSON.stringify({ ...request, model: JEV_MODEL }), "utf8");
}

describe("Jev request schema", () => {
  it("pins the exact provider model", () => {
    expect(JEV_MODEL).toBe("jev-1.14.0");
  });

  it("accepts all three question types and preserves Unicode text", () => {
    const input = makeRequest();
    expect(validateJevRequest(input)).toEqual(input);
  });

  it("accepts optional noul criteria and empty criterion labels", () => {
    for (const criteria of [undefined, {}, { true: "" }, { false: "" }, { true: "", false: "" }]) {
      const question = criteria === undefined
        ? { type: "noul", instructions: "Vérifier." }
        : { type: "noul", instructions: "Vérifier.", criteria };
      expect(() => validateJevRequest(singleQuestion(question))).not.toThrow();
    }
    expect(() => validateJevRequest(singleQuestion({
      type: "choice", instructions: "Choisir.", criteria: { a: "", b: "" },
    }))).not.toThrow();
    expect(() => validateJevRequest(singleQuestion({
      type: "score", instructions: "Noter.", criteria: ["", ""],
    }))).not.toThrow();
  });

  it("rejects malformed request, question-map and question containers", () => {
    for (const input of [null, undefined, false, "request", [], {}]) {
      expect(() => validateJevRequest(input)).toThrow(JevValidationError);
    }
    for (const questions of [null, undefined, [], "q"]) {
      expect(() => validateJevRequest({ state: "Proof", questions })).toThrow(JevValidationError);
    }
    for (const question of [null, [], "noul", { type: "unknown", instructions: "Check" }]) {
      expect(() => validateJevRequest(singleQuestion(question))).toThrow(JevValidationError);
    }
  });

  it("rejects empty, whitespace-only and non-string state or instructions", () => {
    for (const text of ["", " \n\t", null, undefined, 1, false]) {
      expect(() => validateJevRequest({ ...singleQuestion(), state: text })).toThrow(JevValidationError);
      expect(() => validateJevRequest(singleQuestion({ type: "noul", instructions: text })))
        .toThrow(JevValidationError);
    }
  });

  it("enforces one to sixteen questions inclusively", () => {
    for (const count of [0, 1, 16, 17]) {
      const input = {
        state: "Proof",
        questions: Object.fromEntries(Array.from({ length: count }, (_, index) => [
          `q_${index}`, { type: "noul", instructions: "Check" },
        ])),
      };
      if (count === 1 || count === 16) expect(() => validateJevRequest(input)).not.toThrow();
      else expect(() => validateJevRequest(input)).toThrow(JevValidationError);
    }
  });

  it("enforces ASCII identifier syntax and the inclusive 64-character boundary", () => {
    for (const id of ["A", "9_-", "a".repeat(64)]) {
      expect(() => validateJevRequest({
        state: "Proof", questions: { [id]: { type: "noul", instructions: "Check" } },
      })).not.toThrow();
      expect(() => validateJevRequest(singleQuestion({
        type: "choice", instructions: "Choose", criteria: { [id]: "A", alternative: "B" },
      }))).not.toThrow();
    }
    for (const id of ["", "a".repeat(65), "has space", "a.b", "é", "💡", "a\n"]) {
      expect(() => validateJevRequest({
        state: "Proof", questions: { [id]: { type: "noul", instructions: "Check" } },
      })).toThrow(JevValidationError);
      expect(() => validateJevRequest(singleQuestion({
        type: "choice", instructions: "Choose", criteria: { [id]: "A", alternative: "B" },
      }))).toThrow(JevValidationError);
    }
  });

  it("rejects own prototype-related keys in question and option maps", () => {
    for (const key of ["__proto__", "constructor", "prototype"]) {
      const questions = JSON.parse(`{"${key}":{"type":"noul","instructions":"Check"}}`) as unknown;
      expect(() => validateJevRequest({ state: "Proof", questions })).toThrow(JevValidationError);
      const criteria = JSON.parse(`{"${key}":"A","safe":"B"}`) as unknown;
      expect(() => validateJevRequest(singleQuestion({ type: "choice", instructions: "Choose", criteria })))
        .toThrow(JevValidationError);
    }
  });

  it("rejects extra request properties, including a caller-supplied model", () => {
    const inputs: unknown[] = [
      { ...singleQuestion(), model: JEV_MODEL },
      { ...singleQuestion(), unexpected: undefined },
      singleQuestion({ type: "noul", instructions: "Check", extra: true }),
      singleQuestion({ type: "noul", instructions: "Check", criteria: { true: "Yes", maybe: "Maybe" } }),
      singleQuestion({ type: "choice", instructions: "Choose", criteria: { a: "A", b: "B" }, extra: true }),
      singleQuestion({ type: "score", instructions: "Score", criteria: ["A", "B"], extra: true }),
    ];
    for (const input of inputs) expect(() => validateJevRequest(input)).toThrow(JevValidationError);
  });

  it("rejects malformed noul criteria and non-string labels", () => {
    for (const criteria of [null, [], "true", { true: 1 }, { false: null }]) {
      expect(() => validateJevRequest(singleQuestion({ type: "noul", instructions: "Check", criteria })))
        .toThrow(JevValidationError);
    }
  });

  it("enforces two to 255 string-valued choice options", () => {
    for (const count of [1, 2, 255, 256]) {
      const criteria = Object.fromEntries(Array.from({ length: count }, (_, index) => [`o${index}`, "Label"]));
      const input = singleQuestion({ type: "choice", instructions: "Choose", criteria });
      if (count === 2 || count === 255) expect(() => validateJevRequest(input)).not.toThrow();
      else expect(() => validateJevRequest(input)).toThrow(JevValidationError);
    }
    for (const criteria of [undefined, null, ["A", "B"], { a: "A", b: 1 }]) {
      expect(() => validateJevRequest(singleQuestion({ type: "choice", instructions: "Choose", criteria })))
        .toThrow(JevValidationError);
    }
  });

  it("enforces two to ten score labels in an array of strings", () => {
    for (const count of [1, 2, 10, 11]) {
      const input = singleQuestion({ type: "score", instructions: "Score", criteria: Array<string>(count).fill("Label") });
      if (count === 2 || count === 10) expect(() => validateJevRequest(input)).not.toThrow();
      else expect(() => validateJevRequest(input)).toThrow(JevValidationError);
    }
    for (const criteria of [undefined, null, "AB", { "0": "A", "1": "B" }, ["A", 1]]) {
      expect(() => validateJevRequest(singleQuestion({ type: "score", instructions: "Score", criteria })))
        .toThrow(JevValidationError);
    }
  });

  it("counts UTF-8 bytes including the pinned model at the exact 32 KiB limit", () => {
    const input = singleQuestion();
    input.state = "";
    const available = 32_768 - wireSize(input);
    input.state = "🧠".repeat(Math.floor(available / 4)) + "x".repeat(available % 4);
    expect(wireSize(input)).toBe(32_768);
    expect(JSON.stringify(input).length).toBeLessThan(32_768);
    expect(() => validateJevRequest(input)).not.toThrow();
    input.state += "x";
    expect(Buffer.byteLength(JSON.stringify(input), "utf8")).toBeLessThan(32_768);
    expect(wireSize(input)).toBe(32_769);
    expect(() => validateJevRequest(input)).toThrow(JevValidationError);
  });

  it("does not mutate deeply frozen request data", () => {
    const input = freezeDeep(makeRequest());
    const before = structuredClone(input);
    expect(validateJevRequest(input)).toEqual(before);
    expect(input).toEqual(before);
  });
});

describe("Jev response schema", () => {
  it("accepts a complete response with exact question types and usage", () => {
    const response = makeResponse();
    expect(validateJevResponse(response, validateJevRequest(makeRequest()))).toEqual(response);
  });

  it("rejects malformed response, answer-map and usage containers", () => {
    const request = validateJevRequest(makeRequest());
    for (const value of [null, undefined, [], "response", false]) {
      expect(() => validateJevResponse(value, request)).toThrow(JevValidationError);
      expect(() => validateJevResponse({ ...makeResponse(), answers: value }, request)).toThrow(JevValidationError);
      expect(() => validateJevResponse({ ...makeResponse(), usage: value }, request)).toThrow(JevValidationError);
    }
  });

  it("rejects missing or unpinned response models", () => {
    const request = validateJevRequest(makeRequest());
    for (const model of [undefined, null, "jev", "jev-latest", "jev-1.13.0", "jev-1.14.0 "]) {
      expect(() => validateJevResponse({ ...makeResponse(), model }, request)).toThrow(JevValidationError);
    }
  });

  it("requires precisely the requested answer identifiers", () => {
    const request = validateJevRequest(makeRequest());
    const response = makeResponse();
    const { ready, route, rating } = response.answers;
    for (const answers of [{ route, rating }, { ready, route, rating, extra: ready }, { Ready: ready, route, rating }]) {
      expect(() => validateJevResponse({ ...response, answers }, request)).toThrow(JevValidationError);
    }
  });

  it("rejects absent answers and answer types that disagree with the request", () => {
    const request = validateJevRequest(makeRequest());
    const response = makeResponse();
    for (const answer of [null, [], { noul: 0.5 }, { type: "unknown", noul: 0.5 }, response.answers.rating]) {
      expect(() => validateJevResponse({ ...response, answers: { ...response.answers, ready: answer } }, request))
        .toThrow(JevValidationError);
    }
    expect(() => validateJevResponse({
      ...response, answers: { ...response.answers, route: response.answers.ready },
    }, request)).toThrow(JevValidationError);
  });

  it("requires a finite noul value between zero and one inclusively", () => {
    const request = validateJevRequest(makeRequest());
    for (const noul of [0, 1, NaN, Infinity, -Infinity, -0.01, 1.01, "0.5", null, undefined]) {
      const response = makeResponse();
      const input = { ...response, answers: { ...response.answers, ready: { type: "noul", noul } } };
      if (noul === 0 || noul === 1) expect(() => validateJevResponse(input, request)).not.toThrow();
      else expect(() => validateJevResponse(input, request)).toThrow(JevValidationError);
    }
  });

  it("rejects non-finite, out-of-range or non-number probabilities in both distributions", () => {
    const request = validateJevRequest(makeRequest());
    for (const probability of [NaN, Infinity, -Infinity, -0.1, 1.1, "0.7", null, undefined]) {
      const response = makeResponse();
      expect(() => validateJevResponse({
        ...response,
        answers: { ...response.answers, route: { ...response.answers.route, probabilities: { keep: probability, change: 0.3 } } },
      }, request)).toThrow(JevValidationError);
      expect(() => validateJevResponse({
        ...response,
        answers: { ...response.answers, rating: { ...response.answers.rating, probabilities: { "0": probability, "1": 0.5, "2": 0.3 } } },
      }, request)).toThrow(JevValidationError);
    }
  });

  it("requires the exact choice probability keys", () => {
    const request = validateJevRequest(makeRequest());
    const response = makeResponse();
    for (const probabilities of [{ keep: 1 }, { keep: 0.7, change: 0.3, extra: 0 }, { KEEP: 0.7, change: 0.3 }]) {
      expect(() => validateJevResponse({
        ...response, answers: { ...response.answers, route: { ...response.answers.route, probabilities } },
      }, request)).toThrow(JevValidationError);
    }
  });

  it("checks the selected choice against the maximum probability, allowing ties within tolerance", () => {
    const request = validateJevRequest(makeRequest());
    const cases = [
      { choice: "keep", probabilities: { keep: 0.5, change: 0.5 }, valid: true },
      { choice: "change", probabilities: { keep: 0.5, change: 0.5 }, valid: true },
      { choice: "change", probabilities: { keep: 0.5000002, change: 0.4999998 }, valid: true },
      { choice: "change", probabilities: { keep: 0.500002, change: 0.499998 }, valid: false },
      { choice: "absent", probabilities: { keep: 0.7, change: 0.3 }, valid: false },
    ];
    for (const { choice, probabilities, valid } of cases) {
      const response = makeResponse();
      const input = { ...response, answers: { ...response.answers, route: { ...response.answers.route, choice, probabilities } } };
      if (valid) expect(() => validateJevResponse(input, request)).not.toThrow();
      else expect(() => validateJevResponse(input, request)).toThrow(JevValidationError);
    }
  });

  it("enforces normalized distributions with a 1e-6 sum tolerance", () => {
    const request = validateJevRequest(makeRequest());
    for (const delta of [0.0000005, -0.0000005, 0.000002, -0.000002]) {
      for (const id of ["route", "rating"] as const) {
        const response = makeResponse();
        const answer = id === "route"
          ? { ...response.answers.route, probabilities: { keep: 0.7 + delta, change: 0.3 } }
          : { ...response.answers.rating, probabilities: { "0": 0.2 + delta, "1": 0.5, "2": 0.3 } };
        const input = { ...response, answers: { ...response.answers, [id]: answer } };
        if (Math.abs(delta) < 0.000001) expect(() => validateJevResponse(input, request)).not.toThrow();
        else expect(() => validateJevResponse(input, request)).toThrow(JevValidationError);
      }
    }
  });

  it("requires finite confidence in [0, 1] for choice and score answers", () => {
    const request = validateJevRequest(makeRequest());
    for (const confidence of [0, 1, NaN, Infinity, -0.1, 1.1, "0.8", undefined]) {
      for (const id of ["route", "rating"] as const) {
        const response = makeResponse();
        const input = { ...response, answers: { ...response.answers, [id]: { ...response.answers[id], confidence } } };
        if (confidence === 0 || confidence === 1) expect(() => validateJevResponse(input, request)).not.toThrow();
        else expect(() => validateJevResponse(input, request)).toThrow(JevValidationError);
      }
    }
  });

  it("checks scores against the expected zero-based index with 1e-6 tolerance", () => {
    const request = validateJevRequest(makeRequest());
    for (const score of [1.1, 1.1000005, 1.100002, 1, -1, 3, NaN, Infinity, "1.1"]) {
      const response = makeResponse();
      const input = { ...response, answers: { ...response.answers, rating: { ...response.answers.rating, score } } };
      if (score === 1.1 || score === 1.1000005) expect(() => validateJevResponse(input, request)).not.toThrow();
      else expect(() => validateJevResponse(input, request)).toThrow(JevValidationError);
    }
  });

  it("requires the score legend to match every original label and index exactly", () => {
    const request = validateJevRequest(makeRequest());
    const response = makeResponse();
    for (const legend of [
      undefined,
      { "0": "Absent", "1": "Partiel" },
      { "0": "Absent", "1": "Partiel", "2": "Complet", "3": "Extra" },
      { "0": "Absent", "1": "Complet", "2": "Partiel" },
      { "0": "Absent", "1": "Partiel", "2": "Complet " },
      { "0": "Absent", "1": "Partiel", "2": 2 },
    ]) {
      expect(() => validateJevResponse({
        ...response, answers: { ...response.answers, rating: { ...response.answers.rating, legend } },
      }, request)).toThrow(JevValidationError);
    }
  });

  it("requires exactly the canonical score index keys", () => {
    const request = validateJevRequest(makeRequest());
    const response = makeResponse();
    for (const probabilities of [
      { "0": 0.2, "1": 0.8 },
      { "0": 0.2, "1": 0.5, "2": 0.3, "3": 0 },
      { "00": 0.2, "1": 0.5, "2": 0.3 },
      [0.2, 0.5, 0.3],
    ]) {
      expect(() => validateJevResponse({
        ...response, answers: { ...response.answers, rating: { ...response.answers.rating, probabilities } },
      }, request)).toThrow(JevValidationError);
    }
  });

  it("requires nonnegative safe-integer token usage for both counters", () => {
    const request = validateJevRequest(makeRequest());
    for (const count of [0, Number.MAX_SAFE_INTEGER, -1, 0.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, "30", undefined]) {
      for (const key of ["input_tokens", "output_tokens"] as const) {
        const response = makeResponse();
        const input = { ...response, usage: { ...response.usage, [key]: count } };
        if (count === 0 || count === Number.MAX_SAFE_INTEGER) expect(() => validateJevResponse(input, request)).not.toThrow();
        else expect(() => validateJevResponse(input, request)).toThrow(JevValidationError);
      }
    }
  });

  it("strips unknown provider metadata without mutating either input or propagating prototype keys", () => {
    const expected = makeResponse();
    const providerResponse = {
      ...expected,
      provider_trace: { private: "not part of the normalized result" },
      answers: {
        ready: { ...expected.answers.ready, explanation: "Ignore" },
        route: { ...expected.answers.route, provider_debug: "Ignore" },
        rating: { ...expected.answers.rating, provider_score: 99 },
      },
      usage: { ...expected.usage, total_tokens: 150 },
    };
    Object.defineProperty(providerResponse, "__proto__", {
      value: { polluted: true }, enumerable: true, configurable: true,
    });
    const before = structuredClone(providerResponse);
    const request = freezeDeep(validateJevRequest(makeRequest()));
    const requestBefore = structuredClone(request);
    const actual = validateJevResponse(freezeDeep(providerResponse), request);
    expect(actual).toEqual(expected);
    expect(Object.hasOwn(actual, "__proto__")).toBe(false);
    expect((Object.prototype as Record<string, unknown>).polluted).toBeUndefined();
    expect(providerResponse).toEqual(before);
    expect(request).toEqual(requestBefore);
  });
});
