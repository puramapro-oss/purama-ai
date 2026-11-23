/**
 * One internally selected PURAMA text pack, never a public model catalogue.
 * Source checked on 2026-11-23 against the publisher's Hub API and Git LFS oid:
 * https://huggingface.co/api/models/Qwen/Qwen3-0.6B-GGUF/tree/23749fefcc72300e3a2ad315e1317431b06b590a
 * The official repository publishes Q8_0, not Q4_K_M. GGUF includes its tokenizer
 * and chat template; the entire file is covered by the pinned SHA-256.
 */
export const IAO_LOCAL_PACK_MANIFEST = Object.freeze({
  schema: 1,
  id: "purama-text-qwen3-06b-q8-9465e63a22ad",
  repository: "Qwen/Qwen3-0.6B-GGUF",
  revision: "23749fefcc72300e3a2ad315e1317431b06b590a",
  runtime: "llama.rn@0.12.9",
  license: "Apache-2.0",
  model: Object.freeze({
    name: "Qwen3-0.6B-Q8_0.gguf",
    bytes: 639_446_688,
    sha256: "9465e63a22add5354d9bb4b99e90117043c7124007664907259bd16d043bb031",
    url: "https://huggingface.co/Qwen/Qwen3-0.6B-GGUF/resolve/23749fefcc72300e3a2ad315e1317431b06b590a/Qwen3-0.6B-Q8_0.gguf",
  }),
  licenseFile: Object.freeze({
    name: "LICENSE",
    bytes: 11_544,
    sha256: "5de36594c10839788a8c589443a8ef9d8b8d17c65a1b5807206ae037fc36c6bd",
    url: "https://huggingface.co/Qwen/Qwen3-0.6B-GGUF/resolve/23749fefcc72300e3a2ad315e1317431b06b590a/LICENSE",
  }),
  // Conservative application admission limits, not a measured device support list.
  // ~610 MiB weights + native work buffers/KV + JS/application + OS headroom.
  // 3 GiB reported total permits qualification of 4 GB-class devices without
  // confusing marketed RAM with memory actually reported by the operating system.
  minimumMemoryBytes: 3 * 1024 ** 3,
  // Files are streamed to one staging directory and renamed on the same volume.
  // Reserve is in addition to the bytes still needed for that staging directory.
  storageReserveBytes: 256 * 1024 ** 2,
  contextTokens: 2048,
  maximumOutputTokens: 384,
  smokeVersion: "text-completion-v1",
} as const);

export type IaoLocalPackManifest = Readonly<{
  schema: number;
  id: string;
  repository: string;
  revision: string;
  runtime: string;
  license: string;
  model: IaoLocalPackAsset;
  licenseFile: IaoLocalPackAsset;
  minimumMemoryBytes: number;
  storageReserveBytes: number;
  contextTokens: number;
  maximumOutputTokens: number;
  smokeVersion: string;
}>;

export type IaoLocalPackAsset = Readonly<{
  name: string; bytes: number; sha256: string; url: string;
}>;
