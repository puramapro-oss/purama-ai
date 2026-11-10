import { Buffer } from 'node:buffer';

/** Text-only, version-pinned Jev boundary. A valid shape is not proof of truth. */
export const JEV_MODEL = 'jev-1.14.0' as const;

const MAX_REQUEST_BYTES = 32_768;
const PROBABILITY_TOLERANCE = 1e-6;
const STABLE_KEY = /^[A-Za-z0-9_-]{1,64}$/;
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export type JevQuestion =
  | {
      type: 'noul';
      instructions: string;
      criteria?: { true?: string; false?: string };
    }
  | {
      type: 'choice';
      instructions: string;
      criteria: Record<string, string>;
    }
  | {
      type: 'score';
      instructions: string;
      criteria: string[];
    };

export interface JevRequest {
  state: string;
  questions: Record<string, JevQuestion>;
}

export type JevAnswer =
  | { type: 'noul'; noul: number }
  | {
      type: 'choice';
      choice: string;
      probabilities: Record<string, number>;
      confidence: number;
    }
  | {
      type: 'score';
      score: number;
      probabilities: Record<string, number>;
      legend: Record<string, string>;
      confidence: number;
    };

export interface JevResponse {
  model: typeof JEV_MODEL;
  answers: Record<string, JevAnswer>;
  usage: { input_tokens: number; output_tokens: number };
}

/** Validation failures expose stable codes only, never request or response data. */
export class JevValidationError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = 'JevValidationError';
    this.code = code;
  }
}

function fail(code: string): never {
  throw new JevValidationError(code);
}

function record(raw: unknown, code: string): Record<string, unknown> {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) fail(code);
  const prototype = Object.getPrototypeOf(raw);
  if (prototype !== Object.prototype && prototype !== null) fail(code);
  return raw as Record<string, unknown>;
}

/** Reading descriptors avoids evaluating getters supplied by a caller. */
function field(value: object, key: string, code: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) fail(code);
  return descriptor.value;
}

function hasField(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function keys(value: object, code: string): string[] {
  const names = Reflect.ownKeys(value);
  const result: string[] = [];
  for (const name of names) {
    if (typeof name !== 'string') fail(code);
    field(value, name, code);
    result.push(name);
  }
  return result;
}

function allowedKeys(value: object, allowed: readonly string[], code: string): void {
  if (keys(value, code).some((key) => !allowed.includes(key))) fail(code);
}

function exactKeys(value: object, expected: readonly string[], code: string): void {
  const actual = keys(value, code);
  if (actual.length !== expected.length || actual.some((key) => !expected.includes(key))) {
    fail(code);
  }
}

function stableKey(key: string): void {
  if (!STABLE_KEY.test(key) || FORBIDDEN_KEYS.has(key)) fail('JEV_REQUEST_KEY');
}

function requestText(raw: unknown, nonempty: boolean): string {
  if (typeof raw !== 'string' || (nonempty && raw.trim().length === 0)) {
    fail('JEV_REQUEST_TEXT');
  }
  // A string this long cannot fit inside the serialized UTF-8 request envelope.
  if (raw.length > MAX_REQUEST_BYTES) fail('JEV_REQUEST_SIZE');
  return raw;
}

function scoreCriteria(raw: unknown): string[] {
  if (!Array.isArray(raw) || Object.getPrototypeOf(raw) !== Array.prototype) {
    fail('JEV_REQUEST_SCORE_CRITERIA');
  }
  if (raw.length < 2 || raw.length > 10) fail('JEV_REQUEST_SCORE_CRITERIA');
  const expected = [...Array.from({ length: raw.length }, (_, index) => String(index)), 'length'];
  const actual = Reflect.ownKeys(raw);
  if (actual.length !== expected.length || actual.some((key) => typeof key !== 'string' || !expected.includes(key))) {
    fail('JEV_REQUEST_SCORE_CRITERIA');
  }
  return Array.from({ length: raw.length }, (_, index) =>
    requestText(field(raw, String(index), 'JEV_REQUEST_SCORE_CRITERIA'), false));
}

function question(raw: unknown): JevQuestion {
  const value = record(raw, 'JEV_REQUEST_QUESTION');
  allowedKeys(value, ['type', 'instructions', 'criteria'], 'JEV_REQUEST_QUESTION');
  const type = field(value, 'type', 'JEV_REQUEST_QUESTION');
  const instructions = requestText(field(value, 'instructions', 'JEV_REQUEST_QUESTION'), true);

  if (type === 'noul') {
    if (!hasField(value, 'criteria')) return { type, instructions };
    const input = record(field(value, 'criteria', 'JEV_REQUEST_NOUL_CRITERIA'), 'JEV_REQUEST_NOUL_CRITERIA');
    allowedKeys(input, ['true', 'false'], 'JEV_REQUEST_NOUL_CRITERIA');
    const criteria: { true?: string; false?: string } = {};
    if (hasField(input, 'true')) criteria.true = requestText(field(input, 'true', 'JEV_REQUEST_NOUL_CRITERIA'), false);
    if (hasField(input, 'false')) criteria.false = requestText(field(input, 'false', 'JEV_REQUEST_NOUL_CRITERIA'), false);
    return { type, instructions, criteria };
  }

  if (type === 'choice') {
    const input = record(field(value, 'criteria', 'JEV_REQUEST_CHOICE_CRITERIA'), 'JEV_REQUEST_CHOICE_CRITERIA');
    const options = keys(input, 'JEV_REQUEST_CHOICE_CRITERIA');
    if (options.length < 2 || options.length > 255) fail('JEV_REQUEST_CHOICE_CRITERIA');
    const criteria: Record<string, string> = {};
    for (const option of options) {
      stableKey(option);
      criteria[option] = requestText(field(input, option, 'JEV_REQUEST_CHOICE_CRITERIA'), false);
    }
    return { type, instructions, criteria };
  }

  if (type === 'score') {
    return {
      type,
      instructions,
      criteria: scoreCriteria(field(value, 'criteria', 'JEV_REQUEST_SCORE_CRITERIA')),
    };
  }

  return fail('JEV_REQUEST_QUESTION_TYPE');
}

/** Return a fresh, allowlisted request; never mutate the caller's objects. */
export function validateJevRequest(raw: unknown): JevRequest {
  try {
    const value = record(raw, 'JEV_REQUEST_INVALID');
    exactKeys(value, ['state', 'questions'], 'JEV_REQUEST_FIELDS');
    const state = requestText(field(value, 'state', 'JEV_REQUEST_FIELDS'), true);
    const input = record(field(value, 'questions', 'JEV_REQUEST_FIELDS'), 'JEV_REQUEST_QUESTIONS');
    const names = keys(input, 'JEV_REQUEST_QUESTIONS');
    if (names.length < 1 || names.length > 16) fail('JEV_REQUEST_QUESTIONS');
    const questions: Record<string, JevQuestion> = {};
    for (const name of names) {
      stableKey(name);
      questions[name] = question(field(input, name, 'JEV_REQUEST_QUESTIONS'));
    }
    const result = { state, questions };
    const serialized = JSON.stringify({ model: JEV_MODEL, ...result });
    if (Buffer.byteLength(serialized, 'utf8') > MAX_REQUEST_BYTES) fail('JEV_REQUEST_SIZE');
    return result;
  } catch (error) {
    if (error instanceof JevValidationError) throw error;
    return fail('JEV_REQUEST_INVALID');
  }
}

function finiteNumber(raw: unknown, min: number, max: number, code: string): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < min || raw > max) fail(code);
  return raw;
}

function probability(raw: unknown): number {
  return finiteNumber(raw, 0, 1, 'JEV_RESPONSE_PROBABILITY');
}

function distribution(raw: unknown, expected: readonly string[]): Record<string, number> {
  const input = record(raw, 'JEV_RESPONSE_DISTRIBUTION');
  exactKeys(input, expected, 'JEV_RESPONSE_DISTRIBUTION');
  const result: Record<string, number> = {};
  let sum = 0;
  for (const key of expected) {
    const value = probability(field(input, key, 'JEV_RESPONSE_DISTRIBUTION'));
    result[key] = value;
    sum += value;
  }
  if (Math.abs(sum - 1) > PROBABILITY_TOLERANCE) fail('JEV_RESPONSE_DISTRIBUTION_SUM');
  return result;
}

function answer(raw: unknown, expected: JevQuestion): JevAnswer {
  const value = record(raw, 'JEV_RESPONSE_ANSWER');
  const type = field(value, 'type', 'JEV_RESPONSE_ANSWER');
  if (type !== expected.type) fail('JEV_RESPONSE_ANSWER_TYPE');

  if (expected.type === 'noul') {
    return { type: 'noul', noul: probability(field(value, 'noul', 'JEV_RESPONSE_ANSWER')) };
  }

  const confidence = probability(field(value, 'confidence', 'JEV_RESPONSE_ANSWER'));
  // Confidence is preserved as a provider statistic, never interpreted as certainty.
  if (expected.type === 'choice') {
    const options = Object.keys(expected.criteria);
    const probabilities = distribution(field(value, 'probabilities', 'JEV_RESPONSE_ANSWER'), options);
    const choice = field(value, 'choice', 'JEV_RESPONSE_ANSWER');
    if (typeof choice !== 'string' || !options.includes(choice)) fail('JEV_RESPONSE_CHOICE');
    const maximum = Math.max(...Object.values(probabilities));
    if (maximum - probabilities[choice] > PROBABILITY_TOLERANCE) fail('JEV_RESPONSE_CHOICE_MAX');
    return { type: 'choice', choice, probabilities, confidence };
  }

  const levels = expected.criteria.map((_, index) => String(index));
  const probabilities = distribution(field(value, 'probabilities', 'JEV_RESPONSE_ANSWER'), levels);
  const inputLegend = record(field(value, 'legend', 'JEV_RESPONSE_ANSWER'), 'JEV_RESPONSE_LEGEND');
  exactKeys(inputLegend, levels, 'JEV_RESPONSE_LEGEND');
  const legend: Record<string, string> = {};
  let mean = 0;
  for (let index = 0; index < levels.length; index += 1) {
    const key = String(index);
    if (field(inputLegend, key, 'JEV_RESPONSE_LEGEND') !== expected.criteria[index]) {
      fail('JEV_RESPONSE_LEGEND');
    }
    legend[key] = expected.criteria[index];
    mean += index * probabilities[key];
  }
  const score = finiteNumber(field(value, 'score', 'JEV_RESPONSE_ANSWER'), 0, levels.length - 1, 'JEV_RESPONSE_SCORE');
  if (Math.abs(score - mean) > PROBABILITY_TOLERANCE) fail('JEV_RESPONSE_SCORE_MEAN');
  return { type: 'score', score, probabilities, legend, confidence };
}

function tokenCount(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < 0) fail('JEV_RESPONSE_USAGE');
  return raw;
}

/** Ignore provider metadata by reconstructing only explicitly supported fields. */
export function validateJevResponse(raw: unknown, request: JevRequest): JevResponse {
  try {
    const expected = validateJevRequest(request);
    const value = record(raw, 'JEV_RESPONSE_INVALID');
    if (field(value, 'model', 'JEV_RESPONSE_MODEL') !== JEV_MODEL) fail('JEV_RESPONSE_MODEL');
    const input = record(field(value, 'answers', 'JEV_RESPONSE_ANSWERS'), 'JEV_RESPONSE_ANSWERS');
    const names = Object.keys(expected.questions);
    exactKeys(input, names, 'JEV_RESPONSE_ANSWERS');
    const answers: Record<string, JevAnswer> = {};
    for (const name of names) {
      answers[name] = answer(field(input, name, 'JEV_RESPONSE_ANSWERS'), expected.questions[name]);
    }
    const inputUsage = record(field(value, 'usage', 'JEV_RESPONSE_USAGE'), 'JEV_RESPONSE_USAGE');
    const usage = {
      input_tokens: tokenCount(field(inputUsage, 'input_tokens', 'JEV_RESPONSE_USAGE')),
      output_tokens: tokenCount(field(inputUsage, 'output_tokens', 'JEV_RESPONSE_USAGE')),
    };
    return { model: JEV_MODEL, answers, usage };
  } catch (error) {
    if (error instanceof JevValidationError) throw error;
    return fail('JEV_RESPONSE_INVALID');
  }
}
