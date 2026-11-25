export const MODEL_SOURCE_EXCERPT_LIMITS = { total: 32_000, perSource: 2000, unit: "utf16" } as const;

interface ExcerptLimits {
  total: number;
  perSource: number;
  unit: "utf16" | "jsonUtf8";
}

export function utf16Prefix(text: string, limit: number): string {
  const last = text.charCodeAt(limit - 1);
  const next = text.charCodeAt(limit);
  const splitsPair = last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff;
  return text.slice(0, splitsPair ? limit - 1 : limit);
}

/** Fill short excerpts first, then share the remaining budget among the longer ones.
 * JSON limits include the pair of quotes needed even for an empty string. */
export function allocateSourceExcerpts(texts: readonly string[], limits: ExcerptLimits): string[] {
  const json = limits.unit === "jsonUtf8";
  const overhead = json ? 2 : 0;
  if (!Number.isSafeInteger(limits.total) || limits.total < overhead * texts.length
    || !Number.isSafeInteger(limits.perSource) || limits.perSource < overhead) throw new RangeError("Invalid excerpt limits");
  const cost = (text: string) => json ? Buffer.byteLength(JSON.stringify(text), "utf8") - overhead : text.length;

  const fit = (text: string, budget: number): string => {
    // A UTF-16 prefix ending inside a surrogate pair is neither valid text nor a
    // monotonic JSON cost. Measure only prefixes ending at a complete code point.
    let upper = Math.min(text.length, budget);
    const longest = utf16Prefix(text, upper);
    if (!json || cost(longest) <= budget) return longest;
    let lower = 0;
    while (lower < upper) {
      const middle = Math.ceil((lower + upper) / 2);
      if (cost(utf16Prefix(text, middle)) <= budget) lower = middle;
      else upper = middle - 1;
    }
    return utf16Prefix(text, lower);
  };

  const excerpt = (text: string, budget: number) => {
    const prefix = fit(text, budget);
    // Preserve original indentation whenever an actual passage fits. Skip long
    // leading whitespace only if the original prefix communicates no content.
    return prefix.trim() ? prefix : fit(text.trimStart(), budget);
  };

  const candidates = texts.map((text, index) => {
    const candidate = excerpt(text, limits.perSource - overhead);
    return { index, candidate, size: cost(candidate) };
  }).sort((left, right) => left.size - right.size);
  const excerpts: string[] = [];
  let remaining = limits.total - overhead * texts.length;
  for (const [position, source] of candidates.entries()) {
    const share = Math.ceil(remaining / (candidates.length - position));
    const text = source.size <= share ? source.candidate : excerpt(source.candidate, share);
    excerpts[source.index] = text;
    remaining -= cost(text);
  }
  return excerpts;
}
