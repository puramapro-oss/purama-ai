// Keep these predicates separate: addresses exclude C0/DEL, header values only
// exclude NUL/newlines here, and 7bit/ASCII still includes codes 0 through 127.
export function hasAsciiControl(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 32 || code === 127) return true;
  }
  return false;
}

export function hasNonAscii(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    if (value.charCodeAt(i) > 127) return true;
  }
  return false;
}

export function hasNulOrNewline(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code === 0 || code === 10 || code === 13) return true;
  }
  return false;
}
