// Keep one implementation available to both the browser and the self-hosted functions mount.
export { cancelResponseQuietly, createRequestDeadline, RequestDeadlineError } from "../../supabase/functions/_shared/request-deadline.ts";
