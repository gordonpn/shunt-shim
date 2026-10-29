/**
 * Safe, structured diagnostic logging for edge request lifecycles.
 */

export interface DiagnosticRecord {
  timestamp: string;
  requestId: string;
  status: number;
  latencyMs: number;
  provider?: "groq" | "gemini";
  model?: string;
  fallbackReason?: string | undefined;
  attempts?: number;
}

export const DIAGNOSTIC_ALLOWLIST: readonly (keyof DiagnosticRecord)[] = [
  "timestamp",
  "requestId",
  "status",
  "latencyMs",
  "provider",
  "model",
  "fallbackReason",
  "attempts",
] as const;

export type DiagnosticSink = (
  jsonString: string,
  record: DiagnosticRecord,
) => void;

let activeSink: DiagnosticSink | null = null;
let captureEnabled = false;
let capturedRecords: DiagnosticRecord[] = [];

/**
 * Overrides the default logging sink. Used for testing or custom output.
 *
 * @param sink - Callback invoked with the formatted JSON string and parsed record.
 */
export function setDiagnosticSink(sink: DiagnosticSink): void {
  activeSink = sink;
}

/**
 * Enables or disables in-memory diagnostic record retention.
 * Defaults to false to prevent memory growth in long-running worker isolates.
 *
 * @param enabled - Whether to retain emitted records in memory.
 */
export function setDiagnosticCapture(enabled: boolean): void {
  captureEnabled = enabled;
  if (!enabled) {
    capturedRecords = [];
  }
}

/**
 * Resets the logging sink to default console.log output and clears captured records.
 */
export function resetDiagnosticSink(): void {
  activeSink = null;
  captureEnabled = false;
  capturedRecords = [];
}

/**
 * Returns read-only view of in-memory captured diagnostic records.
 *
 * @returns Array of recorded diagnostic records.
 */
export function getCapturedDiagnostics(): readonly DiagnosticRecord[] {
  return capturedRecords;
}

/**
 * Sanitizes a diagnostic record against the strict allowlist and formats as JSON.
 *
 * @param record - Diagnostic record to format.
 * @returns Serialized JSON string containing only allowlisted fields.
 */
export function formatDiagnosticLog(record: DiagnosticRecord): string {
  const sanitized: Record<string, unknown> = {};
  for (const key of DIAGNOSTIC_ALLOWLIST) {
    const val = record[key];
    if (val !== undefined && val !== null) {
      sanitized[key] = val;
    }
  }
  return JSON.stringify(sanitized);
}

/**
 * Emits a structured diagnostic log event to the active sink or console.log.
 *
 * @param record - Diagnostic record to emit.
 */
export function emitDiagnostic(record: DiagnosticRecord): void {
  if (captureEnabled) {
    capturedRecords.push(record);
  }
  const jsonString = formatDiagnosticLog(record);
  if (activeSink) {
    activeSink(jsonString, record);
    return;
  }
  console.log(jsonString);
}
