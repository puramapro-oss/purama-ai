import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PDFDocument } from "pdf-lib";
import type { ToolExecutionContext } from "../src/engine/types.js";

const h = vi.hoisted(() => ({
  transport: vi.fn<typeof fetch>(),
  uploads: [] as Array<{ request: Request; bytes: Uint8Array }>,
  responseStatus: 200,
}));

// Keep PDFKit and the installed Supabase SDK real. Replace only the database
// client configuration and HTTP boundary; no credential or network is used.
vi.mock("../src/db/supabase.js", async () => {
  const { createClient } = await import("@supabase/supabase-js");
  return {
    supabase: createClient("https://pdf-boundary.invalid", "pdf-boundary-fixture-not-a-secret", {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { fetch: (input, init) => h.transport(input, init) },
    }),
  };
});

import { generatePdfTool } from "../src/tools/pdf.js";

const USER = "11111111-1111-4111-8111-111111111111";
const OTHER_USER = "22222222-2222-4222-8222-222222222222";
const PRIVATE = "PRIVATE_PDF_FILENAME_MUST_NOT_ESCAPE";
const NOW = 1_795_550_000_000;
type PdfParams = Parameters<typeof generatePdfTool.execute>[0];

function params(overrides: Partial<PdfParams> = {}): PdfParams {
  return {
    title: "Rapport de test",
    paragraphs: ["Premier paragraphe de la fixture.", "Deuxième paragraphe."],
    fileName: "rapport.pdf",
    ...overrides,
  };
}

function context(userId = USER): ToolExecutionContext {
  return { userId, agentType: "compta", mode: "live" };
}

// Deliberately enter the concrete tool directly, as callers outside the loop
// must receive the same runtime input guarantees as the normal engine path.
function execute(value: unknown, userId = USER): Promise<{ url: string }> {
  return generatePdfTool.execute(value as PdfParams, context(userId));
}

function uploadedUrl(index = 0): URL {
  expect(h.uploads[index]).toBeDefined();
  return new URL(h.uploads[index]!.request.url);
}

function expectSameOwnedObject(result: { url: string }, fileName: string, userId = USER): void {
  const upload = uploadedUrl();
  const publicUrl = new URL(result.url);
  const objectPath = encodeURI(`agent-documents/${userId}/${NOW}-${fileName}`);
  expect(upload.origin).toBe("https://pdf-boundary.invalid");
  expect(upload.pathname).toBe(`/storage/v1/object/${objectPath}`);
  expect(publicUrl.origin).toBe(upload.origin);
  expect(publicUrl.pathname).toBe(`/storage/v1/object/public/${objectPath}`);
  expect(upload.search).toBe("");
  expect(upload.hash).toBe("");
  expect(publicUrl.search).toBe("");
  expect(publicUrl.hash).toBe("");
  expect(Object.keys(result)).toEqual(["url"]);
}

beforeEach(() => {
  h.transport.mockReset();
  h.uploads = [];
  h.responseStatus = 200;
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  h.transport.mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    const bytes = new Uint8Array(await request.arrayBuffer());
    h.uploads.push({ request, bytes });
    const body = h.responseStatus === 200
      ? { Key: "fixture", Id: "fixture" }
      : { statusCode: String(h.responseStatus), error: "fixture_error", message: "Upload indisponible" };
    return new Response(JSON.stringify(body), {
      status: h.responseStatus,
      headers: { "Content-Type": "application/json" },
    });
  });
});

afterEach(() => { vi.restoreAllMocks(); });

describe("generate_pdf real PDF and Storage boundaries", () => {
  it.each([USER, OTHER_USER])("preserves French leaf names and the server-owned object path for %s", async userId => {
    const fileName = "État d’équipe – août 2026 (v2).pdf";
    const value = params({ fileName });
    Object.freeze(value.paragraphs);
    Object.freeze(value);

    const result = await execute(value, userId);

    expect(h.transport).toHaveBeenCalledOnce();
    expectSameOwnedObject(result, fileName, userId);
    const { request, bytes } = h.uploads[0]!;
    expect(request.method).toBe("POST");
    expect(request.headers.get("content-type")).toBe("application/pdf");
    expect(request.headers.get("x-upsert")).toBe("false");
    expect(Buffer.from(bytes.subarray(0, 5)).toString("ascii")).toBe("%PDF-");
    const document = await PDFDocument.load(bytes);
    expect(document.getPageCount()).toBe(1);
    expect(value.fileName).toBe(fileName);
  });

  it.each([
    { label: "slash subdirectory", fileName: `${PRIVATE}/rapport.pdf` },
    { label: "backslash subdirectory", fileName: `${PRIVATE}\\rapport.pdf` },
    { label: "owner traversal", fileName: `${PRIVATE}/../../${OTHER_USER}/rapport.pdf` },
    { label: "bucket traversal", fileName: `${PRIVATE}/../../../other-bucket/rapport.pdf` },
    { label: "backslash traversal", fileName: `${PRIVATE}\\..\\..\\${OTHER_USER}\\rapport.pdf` },
    { label: "percent-encoded dot segments", fileName: `${PRIVATE}/%2e%2e/%2e%2e/${OTHER_USER}/rapport.pdf` },
    { label: "percent-encoded separators", fileName: `${PRIVATE}%2f..%2f..%2frapport.pdf` },
    { label: "percent", fileName: `${PRIVATE}-100%.pdf` },
    { label: "query delimiter", fileName: `${PRIVATE}?download=rapport.pdf` },
    { label: "fragment delimiter", fileName: `${PRIVATE}#rapport.pdf` },
    { label: "NUL", fileName: `${PRIVATE}\u0000.pdf` },
    { label: "tab", fileName: `${PRIVATE}\t.pdf` },
    { label: "newline", fileName: `${PRIVATE}\n.pdf` },
    { label: "carriage return", fileName: `${PRIVATE}\r.pdf` },
    { label: "C0 control", fileName: `${PRIVATE}\u001f.pdf` },
    { label: "DEL", fileName: `${PRIVATE}\u007f.pdf` },
    { label: "C1 control", fileName: `${PRIVATE}\u0085.pdf` },
    { label: "unpaired high surrogate", fileName: `${PRIVATE}-\ud800.pdf` },
    { label: "unpaired low surrogate", fileName: `${PRIVATE}-\udfff.pdf` },
    { label: "empty name", fileName: "" },
    { label: "only whitespace", fileName: "   " },
    { label: "leading whitespace", fileName: ` ${PRIVATE}.pdf` },
    { label: "trailing whitespace", fileName: `${PRIVATE}.pdf ` },
    { label: "dot", fileName: "." },
    { label: "dot-dot", fileName: ".." },
    { label: "longer than 200 characters", fileName: "x".repeat(201) },
  ])("rejects $label locally without exposing the filename", async ({ fileName }) => {
    const failure: unknown = await execute(params({ fileName })).then(() => undefined, error => error);

    expect(failure).toBeInstanceOf(Error);
    const message = (failure as Error).message;
    expect(message.length).toBeGreaterThan(0);
    expect(message).not.toContain(PRIVATE);
    expect(message).not.toContain(USER);
    expect(message).not.toContain(OTHER_USER);
    expect(h.transport).not.toHaveBeenCalled();
    expect(h.uploads).toHaveLength(0);
  });

  it.each([
    { label: "missing title", value: { paragraphs: [], fileName: "rapport.pdf" } },
    { label: "missing paragraphs", value: { title: "Rapport", fileName: "rapport.pdf" } },
    { label: "missing filename", value: { title: "Rapport", paragraphs: [] } },
    { label: "non-string title", value: { title: 12, paragraphs: [], fileName: "rapport.pdf" } },
    { label: "non-array paragraphs", value: { title: "Rapport", paragraphs: "abc", fileName: "rapport.pdf" } },
    { label: "non-string paragraph", value: { title: "Rapport", paragraphs: [12], fileName: "rapport.pdf" } },
    { label: "non-string filename", value: { title: "Rapport", paragraphs: [], fileName: 12 } },
    { label: "caller-supplied owner", value: { title: "Rapport", paragraphs: [], fileName: "rapport.pdf", userId: OTHER_USER } },
  ])("validates the generic schema on direct calls: $label", async ({ value }) => {
    await expect(execute(value)).rejects.toThrow();
    expect(h.transport).not.toHaveBeenCalled();
  });

  it("snapshots the validated filename before yielding to PDF rendering", async () => {
    const value = params({ fileName: "rapport-original.pdf" });
    const pending = execute(value);
    // The renderer yields before Storage. Mutating the caller-owned object
    // must not replace the validated leaf or redirect the uploaded document.
    value.fileName = `${PRIVATE}/../../${OTHER_USER}/rapport.pdf`;

    const result = await pending;

    expect(h.transport).toHaveBeenCalledOnce();
    expectSameOwnedObject(result, "rapport-original.pdf");
    expect(result.url).not.toContain(PRIVATE);
    expect(result.url).not.toContain(OTHER_USER);
  });

  it.each([403, 409])("propagates an upload failure (%s) instead of returning a URL", async status => {
    h.responseStatus = status;

    await expect(execute(params())).rejects.toThrow(/upload échoué/);

    expect(h.transport).toHaveBeenCalledOnce();
    expect(uploadedUrl().pathname).toBe(`/storage/v1/object/agent-documents/${USER}/${NOW}-rapport.pdf`);
  });
});
