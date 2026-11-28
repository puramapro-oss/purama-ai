import { normalizeRoutineInput, normalizeRoutineTimestamp, RoutineValidationError, type RoutineInput } from "./contracts.js";

const MINUTE = 60_000;
type WallTime = { year: number; month: number; day: number; hour: number; minute: number };
const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(timezone: string): Intl.DateTimeFormat {
  let value = formatters.get(timezone);
  if (!value) {
    value = new Intl.DateTimeFormat("en-GB", { timeZone: timezone, calendar: "gregory", numberingSystem: "latn",
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    if (formatters.size >= 100) formatters.clear();
    formatters.set(timezone, value);
  }
  return value;
}
function wallAt(millis: number, zone: string): WallTime {
  const parts = Object.fromEntries(formatter(zone).formatToParts(millis).map(part => [part.type, part.value]));
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day), hour: Number(parts.hour), minute: Number(parts.minute) };
}
function wallMillis(wall: WallTime): number { return Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute); }
function sameDate(left: WallTime, right: WallTime): boolean {
  return left.year === right.year && left.month === right.month && left.day === right.day;
}
function plusDays(wall: WallTime, days: number): WallTime {
  const date = new Date(Date.UTC(wall.year, wall.month - 1, wall.day + days));
  return { ...wall, year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

/** Earliest instant of a folded wall minute; first existing minute after a gap. */
function resolveWall(wall: WallTime, zone: string): number | null {
  const target = wallMillis(wall);
  const offsets = new Set<number>();
  for (let hours = -36; hours <= 36; hours += 6) {
    const instant = target + hours * 60 * MINUTE;
    offsets.add(wallMillis(wallAt(instant, zone)) - instant);
  }
  const candidates = [...offsets].map(offset => target - offset)
    .filter(instant => wallMillis(wallAt(instant, zone)) === target).sort((a, b) => a - b);
  if (candidates.length) return candidates[0];
  // Gaps are rare. A bounded minute scan also handles thirty-minute transitions.
  // A completely skipped calendar date contributes no occurrence.
  for (let instant = target - 26 * 60 * MINUTE; instant <= target + 26 * 60 * MINUTE; instant += MINUTE) {
    const local = wallAt(instant, zone);
    if (sameDate(local, wall) && wallMillis(local) >= target) return instant;
  }
  return null;
}
function isQuiet(wall: WallTime, quiet: NonNullable<RoutineInput["quietHours"]>): boolean {
  const current = `${String(wall.hour).padStart(2, "0")}:${String(wall.minute).padStart(2, "0")}`;
  return quiet.start < quiet.end ? current >= quiet.start && current < quiet.end : current >= quiet.start || current < quiet.end;
}
function afterQuiet(instant: number, input: RoutineInput): number | null {
  const quiet = input.quietHours;
  if (!quiet) return instant;
  const zone = input.schedule.timezone;
  let result = instant;
  for (let attempts = 0; attempts < 3; attempts++) {
    let wall = wallAt(result, zone);
    if (!isQuiet(wall, quiet)) return result;
    const current = `${String(wall.hour).padStart(2, "0")}:${String(wall.minute).padStart(2, "0")}`;
    if (quiet.start > quiet.end && current >= quiet.start) wall = plusDays(wall, 1);
    const [hour, minute] = quiet.end.split(":").map(Number);
    const next = resolveWall({ ...wall, hour, minute }, zone);
    if (next === null) return null;
    if (next < result) {
      // An ambiguous quiet-hours end may already have passed once. Advance
      // through the second fold instead of moving the delivery backwards.
      for (let future = Math.ceil(result / MINUTE) * MINUTE; future <= result + 26 * 60 * MINUTE; future += MINUTE) {
        if (!isQuiet(wallAt(future, zone), quiet)) return future;
      }
      return null;
    }
    result = next;
  }
  return null;
}

/** Interpret a datetime-local field in the selected IANA zone, never the device zone. */
export function routineInstantFromLocal(local: string, timezone: string): string | null {
  if (typeof local !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(local)) throw new RoutineValidationError("Date locale invalide");
  if (typeof timezone !== "string" || !timezone || timezone.length > 100) throw new RoutineValidationError("Fuseau IANA invalide");
  normalizeRoutineTimestamp(`${local}:00Z`);
  try { formatter(timezone); } catch { throw new RoutineValidationError("Fuseau IANA inconnu"); }
  const parts = local.split(/[-T:]/).map(Number);
  const instant = resolveWall({ year: parts[0], month: parts[1], day: parts[2], hour: parts[3], minute: parts[4] }, timezone);
  return instant === null ? null : new Date(instant).toISOString();
}

/** Event callbacks use this same pause/quiet boundary immediately before dispatch. */
export function routineMayDeliverAt(input: RoutineInput, instant: string | Date | number): boolean {
  const config = normalizeRoutineInput(input);
  const millis = instant instanceof Date ? instant.getTime() : typeof instant === "number" ? instant : Date.parse(instant);
  if (!Number.isFinite(millis) || !config.enabled || (config.pausedUntil !== null && Date.parse(config.pausedUntil) > millis)) return false;
  return !config.quietHours || !isQuiet(wallAt(millis, config.schedule.timezone), config.quietHours);
}

/** Strictly future occurrences only. No implicit backlog or retries are generated. */
export function calculateNextOccurrences(input: RoutineInput, after: string | Date | number, count = 3): string[] {
  const config = normalizeRoutineInput(input);
  const start = after instanceof Date ? after.getTime() : typeof after === "number" ? after : Date.parse(after);
  if (!Number.isFinite(start) || !Number.isSafeInteger(count) || count < 1 || count > 10) throw new RoutineValidationError("Aperçu des dates invalide");
  if (!config.enabled || config.schedule.kind === "event") return [];
  const pausedUntil = config.pausedUntil === null ? -Infinity : Date.parse(config.pausedUntil);
  if (config.schedule.kind === "once") {
    const scheduled = Date.parse(config.schedule.at);
    // A pause does not silently move a one-off request to an unrelated date.
    if (scheduled < pausedUntil) return [];
    const instant = afterQuiet(scheduled, config);
    return instant !== null && instant > start ? [new Date(instant).toISOString()] : [];
  }
  const schedule = config.schedule;
  const lower = Math.max(start, pausedUntil);
  // Yesterday's late slot may be deferred into this morning by quiet hours.
  const firstDay = plusDays(wallAt(lower, schedule.timezone), -1);
  const [hour, minute] = schedule.time.split(":").map(Number);
  const result: string[] = [];
  const seen = new Set<number>();
  // Bounded even for hostile date input; weekly schedules need at most seventy
  // days for ten results. The wider bound also covers skipped local dates.
  for (let day = 0; day <= 370 && result.length < count; day++) {
    const wall = { ...plusDays(firstDay, day), hour, minute };
    if (schedule.kind === "weekly" && !schedule.days.includes(new Date(wallMillis(wall)).getUTCDay())) continue;
    const candidate = resolveWall(wall, schedule.timezone);
    if (candidate === null) continue;
    const allowed = afterQuiet(candidate, config);
    if (allowed === null || allowed <= start || allowed < pausedUntil || seen.has(allowed)) continue;
    seen.add(allowed);
    result.push(new Date(allowed).toISOString());
  }
  return result.sort();
}
