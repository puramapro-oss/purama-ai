/**
 * Bounded incremental SSE data framing shared by the edge and web clients.
 * CR, LF and CRLF are line endings, including when CRLF spans two chunks.
 * Event names, ids and reconnection are outside this one-request JSON protocol.
 * https://html.spec.whatwg.org/multipage/server-sent-events.html#event-stream-interpretation
 */
export function createSSEDataParser(maxEventChars = 262_144) {
  let line = '';
  let data: string[] = [];
  let eventChars = 0;
  let skipLF = false;
  return function* push(chunk: string): Generator<string> {
    for (const char of chunk) {
      if (skipLF) {
        skipLF = false;
        if (char === '\n') continue;
      }
      if (++eventChars > maxEventChars) throw new Error('SSE event too large / événement trop volumineux');
      if (char !== '\r' && char !== '\n') { line += char; continue; }
      skipLF = char === '\r';
      if (line === '') {
        const event = data.join('\n');
        const hasData = data.length > 0;
        data = [];
        eventChars = 0;
        if (hasData) yield event;
      } else {
        const colon = line.indexOf(':');
        const field = colon < 0 ? line : line.slice(0, colon);
        if (field === 'data') {
          let value = colon < 0 ? '' : line.slice(colon + 1);
          if (value.startsWith(' ')) value = value.slice(1);
          data.push(value);
        }
        line = '';
      }
    }
  };
}
