import { describe, expect, it } from "vitest";
import { extractGmailPlainText, GMAIL_TEXT_LIMIT, gmailHeader, readBoundedGmailJson } from "../src/tools/gmail-message.js";

function plain(text: string) {
  return { mimeType: "text/plain", filename: "", headers: [{ name: "Content-Type", value: "text/plain; charset=UTF-8" }], body: { data: Buffer.from(text).toString("base64url"), size: Buffer.byteLength(text) } };
}

describe("bounded inline Gmail MIME", () => {
  it("preserves French and emoji, including a final question", () => {
    const text = "Bonjour à tous 🙂\n".repeat(200) + "Dernière question ?";
    expect(extractGmailPlainText(plain(text))).toEqual({ body: text, bodyStatus: "complete" });
  });
  it("accepts exactly 64 KiB and refuses one byte more without a misleading excerpt", () => {
    expect(extractGmailPlainText(plain("a".repeat(GMAIL_TEXT_LIMIT))).bodyStatus).toBe("complete");
    expect(extractGmailPlainText(plain("a".repeat(GMAIL_TEXT_LIMIT + 1)))).toMatchObject({ body: null, bodyStatus: "too_large" });
  });
  it.each(["%?", "A", "QQ=", "Q===", "Q R", "QR", "QQ=Q"])("rejects malformed base64url %s", data => {
    expect(extractGmailPlainText({ mimeType: "text/plain", body: { data } })).toMatchObject({ body: null, bodyStatus: "invalid" });
  });
  it("rejects non-UTF-8 and inconsistent byte counts", () => {
    expect(extractGmailPlainText({ mimeType: "text/plain", body: { data: Buffer.from([0xff]).toString("base64url") } }).bodyStatus).toBe("invalid");
    const part = plain("é"); part.body.size = 1;
    expect(extractGmailPlainText(part).bodyStatus).toBe("invalid");
  });
  it("does not extract HTML or fetch remote assets", () => {
    expect(extractGmailPlainText({ mimeType: "text/html", body: { data: Buffer.from('<img src="https://example.invalid/track">Question').toString("base64url") } })).toMatchObject({ body: null, bodyStatus: "unsupported" });
  });
  it("uses the inline plain alternative and does not expose an attachment as the message", () => {
    const input = { mimeType: "multipart/mixed", parts: [
      { mimeType: "multipart/alternative", parts: [plain("Question complète ?"), { mimeType: "text/html", body: { data: "" } }] },
      { ...plain("secret in attached text"), filename: "private.txt" },
    ] };
    expect(extractGmailPlainText(input)).toEqual({ body: "Question complète ?", bodyStatus: "complete" });
  });
  it("reports an additional unread inline text part instead of dropping it", () => {
    expect(extractGmailPlainText({ mimeType: "multipart/mixed", parts: [plain("A"), { mimeType: "text/html", body: { data: "" } }] }).bodyStatus).toBe("unsupported");
  });
  it.each([
    { mimeType: "TEXT/HTML", body: { data: "" } },
    { mimeType: "multipart/related", parts: [{ mimeType: "text/html", body: { data: "" } }] },
  ])("propagates an unread inline subtree or mixed-case MIME: %j", extra => {
    expect(extractGmailPlainText({ mimeType: "multipart/mixed", parts: [plain("Question 1"), extra] })).toMatchObject({ body: null, bodyStatus: "unsupported" });
  });
  it("reports external text bodies and unsupported charsets", () => {
    expect(extractGmailPlainText({ mimeType: "text/plain", body: { attachmentId: "attachment1", size: 20 } }).bodyStatus).toBe("unsupported");
    const part = plain("bonjour"); part.headers[0]!.value = "text/plain; charset=iso-8859-1";
    expect(extractGmailPlainText(part).bodyStatus).toBe("unsupported");
  });
  it("bounds recursive MIME structures and rejects malformed structures", () => {
    let deep: unknown = plain("A");
    for (let n = 0; n < 14; n++) deep = { mimeType: "multipart/mixed", parts: [deep] };
    expect(extractGmailPlainText(deep).bodyStatus).toBe("invalid");
    expect(extractGmailPlainText({ mimeType: "multipart/mixed", parts: [null] }).bodyStatus).toBe("invalid");
    expect(extractGmailPlainText({ mimeType: "multipart/mixed", parts: Array.from({ length: 101 }, () => plain("a")) }).bodyStatus).toBe("invalid");
  });
  it("reads headers case-insensitively and rejects duplicates and CRLF", () => {
    expect(gmailHeader({ headers: [{ name: "subject", value: "Q" }] }, "Subject")).toBe("Q");
    expect(() => gmailHeader({ headers: [{ name: "Subject", value: "Q" }, { name: "subject", value: "X" }] }, "Subject")).toThrow(/ambigu/);
    expect(() => gmailHeader({ headers: [{ name: "References", value: "<a@b>\r\nBcc: other@example.com" }] }, "References")).toThrow(/invalide/);
  });
});

describe("bounded provider response", () => {
  it("reads a small JSON document and rejects bad JSON", async () => {
    await expect(readBoundedGmailJson(new Response('{"id":"1"}'))).resolves.toEqual({ id: "1" });
    await expect(readBoundedGmailJson(new Response("{"))).rejects.toThrow();
  });
  it("counts streamed bytes even if Content-Length lies", async () => {
    await expect(readBoundedGmailJson(new Response(" ".repeat(2 * 1024 * 1024 + 1), { headers: { "Content-Length": "1" } }))).rejects.toThrow(/volumineuse/);
  });
});
