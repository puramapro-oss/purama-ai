// Exact-document approval protocol. Keep this route separate from the historical
// endpoint: an older deployed partner-generate-contract ignored `action` and
// sent immediately. A client must never fall back to that URL during rollout.
// This is the same runtime/handler, not a second contract engine or HTTP call.
import "../partner-generate-contract/index.ts";
