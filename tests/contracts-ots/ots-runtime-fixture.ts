import library from "./fixture.ts";
import { createOtsClient, type OtsLibrary } from "../../src/lib/ots-core.ts";

// Provider and crypto fixtures; the real transport policy executes unchanged.
export const ots = createOtsClient(library as OtsLibrary);
