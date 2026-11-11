import nodeTest from 'node:test';

// The CLI timeout bounds the entire isolated file. Each case keeps its own
// three-second deadline, including any stricter timeout already declared.
export default function test(name, optionsOrFn, fn) {
  const options = typeof optionsOrFn === 'function' ? {} : optionsOrFn;
  const callback = typeof optionsOrFn === 'function' ? optionsOrFn : fn;
  return nodeTest(name, {
    ...options,
    timeout: Math.min(options?.timeout ?? 3000, 3000),
  }, callback);
}
