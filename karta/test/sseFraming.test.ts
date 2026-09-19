import { expect, it } from 'vitest';
const url = new URL('../../supabase/functions/_shared/sse-data.ts', import.meta.url).href;
const { createSSEDataParser } = await import(url);

it.each(['\n\n', '\r\r', '\r\n\r\n', '\r\n\n', '\n\r', '\n\r\n'])(
  'dispatches a complete frame at every supported blank line %j', boundary => {
    const push = createSSEDataParser();
    const output = [...('data: yes' + boundary)].flatMap(char => [...push(char)]);
    expect(output).toEqual(['yes']);
  }
);
it('joins data fields, handles colonless data, and ignores comments and other fields', () => {
  const push = createSSEDataParser();
  expect([...push(':comment\rid:abc\nevent:message\r\ndata: first\rdata\ndata:  second\n\n')])
    .toEqual(['first\n\n second']);
});
it('never dispatches an incomplete frame or treats CRLF as a blank line', () => {
  const push = createSSEDataParser();
  expect([...push('data: pending\r')]).toEqual([]);
  expect([...push('\n')]).toEqual([]);
  expect([...push('\n')]).toEqual(['pending']);
});
it('bounds accumulated event data across many short lines', () => {
  const push = createSSEDataParser(32);
  expect(() => [...push('data: x\n'.repeat(8))]).toThrow(/too large/);
});
it('resets the size budget only after a completed event', () => {
  const push = createSSEDataParser(16);
  expect([...push('data: x\n\n'.repeat(100))]).toHaveLength(100);
});
