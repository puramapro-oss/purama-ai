// Import only upstream proof primitives. Loading the package entrypoint also loads
// request/uuid, although none of that legacy transport is needed here.
import DetachedTimestampFile from "npm:opentimestamps@0.4.9/src/detached-timestamp-file.js";
import Ops from "npm:opentimestamps@0.4.9/src/ops.js";
import Context from "npm:opentimestamps@0.4.9/src/context.js";
import Timestamp from "npm:opentimestamps@0.4.9/src/timestamp.js";
import Notary from "npm:opentimestamps@0.4.9/src/notary.js";
import { createOtsClient, type OtsLibrary } from "../../../src/lib/ots-core.ts";

export const ots = createOtsClient({ DetachedTimestampFile, Ops, Context, Timestamp, Notary } as OtsLibrary);
