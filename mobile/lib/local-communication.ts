/** Only these exact file-system routes can keep account services inactive. */
export function isLocalCommunicationRoute(segments: readonly string[]): boolean {
  return segments.length === 0
    || (segments.length === 1 && (segments[0] === "index" || segments[0] === "communication"
      || segments[0] === "accessible-one" || segments[0] === "accessibility-watch"));
}

export const COMMUNICATION_TEXT_LIMIT = 2_000;

/** Match TextInput's UTF-16 bound without keeping half of a surrogate pair. */
export function boundCommunicationText(value: string): string {
  const bounded = value.slice(0, COMMUNICATION_TEXT_LIMIT);
  const last = bounded.charCodeAt(bounded.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? bounded.slice(0, -1) : bounded;
}
