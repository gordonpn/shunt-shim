export interface ProbeOutcome {
  name: string;
  passed: boolean;
  message: string;
  status?: number | undefined;
  durationMs: number;
}

export interface IngressVerifyOptions {
  baseUrl: string;
  token?: string | undefined;
  live?: boolean | undefined;
  timeoutMs?: number | undefined;
}

export interface IngressVerifySummary {
  total: number;
  passed: number;
  failed: number;
  results: ProbeOutcome[];
}

/**
 * Normalizes a base URL by removing any trailing slashes.
 *
 * @param url - Raw base URL string.
 * @returns Cleaned URL string without trailing slashes.
 */
export function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

/**
 * Executes a single HTTP probe with timeout handling.
 */
async function executeProbe(
  name: string,
  fn: (signal: AbortSignal) => Promise<{
    passed: boolean;
    message: string;
    status?: number | undefined;
  }>,
  timeoutMs: number,
): Promise<ProbeOutcome> {
  const startTime = Date.now();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const outcome = await fn(controller.signal);
    const durationMs = Math.max(0, Date.now() - startTime);
    return {
      name,
      passed: outcome.passed,
      message: outcome.message,
      status: outcome.status,
      durationMs,
    };
  } catch (error: unknown) {
    const durationMs = Math.max(0, Date.now() - startTime);
    const isTimeout =
      controller.signal.aborted ||
      (error instanceof Error && error.name === "AbortError");
    const message = isTimeout
      ? `Timed out after ${timeoutMs}ms`
      : error instanceof Error
        ? error.message
        : String(error);
    return {
      name,
      passed: false,
      message,
      durationMs,
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Runs the ingress verification suite against the specified gateway target.
 *
 * @param options - Verification configuration including target URL, auth token, and live flag.
 * @returns Summary of all executed probe outcomes.
 */
export async function runIngressVerification(
  options: IngressVerifyOptions,
): Promise<IngressVerifySummary> {
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const timeoutMs = options.timeoutMs ?? 15000;
  const token = options.token?.trim();
  const results: ProbeOutcome[] = [];

  // Probe 1: GET / (Root health check)
  results.push(
    await executeProbe(
      "GET / (root health probe)",
      async (signal) => {
        const res = await fetch(`${baseUrl}/`, { signal });
        const hasRequestId = Boolean(res.headers.get("x-request-id"));
        if (res.status !== 200) {
          return {
            passed: false,
            status: res.status,
            message: `Expected HTTP 200, received ${res.status}`,
          };
        }
        if (!hasRequestId) {
          return {
            passed: false,
            status: res.status,
            message: "Missing expected x-request-id response header",
          };
        }
        const body = (await res.json()) as {
          status?: string | undefined;
          service?: string | undefined;
        };
        if (body.status !== "ok" || body.service !== "shunt-shim") {
          return {
            passed: false,
            status: res.status,
            message: `Unexpected response body: ${JSON.stringify(body)}`,
          };
        }
        return { passed: true, status: res.status, message: "OK" };
      },
      timeoutMs,
    ),
  );

  // Probe 2: GET /health (Health check alias)
  results.push(
    await executeProbe(
      "GET /health (health alias probe)",
      async (signal) => {
        const res = await fetch(`${baseUrl}/health`, { signal });
        if (res.status !== 200) {
          return {
            passed: false,
            status: res.status,
            message: `Expected HTTP 200, received ${res.status}`,
          };
        }
        const body = (await res.json()) as {
          status?: string | undefined;
          service?: string | undefined;
        };
        if (body.status !== "ok" || body.service !== "shunt-shim") {
          return {
            passed: false,
            status: res.status,
            message: `Unexpected response body: ${JSON.stringify(body)}`,
          };
        }
        return { passed: true, status: res.status, message: "OK" };
      },
      timeoutMs,
    ),
  );

  // Probe 3: GET /v1/models (Unauthenticated)
  results.push(
    await executeProbe(
      "GET /v1/models (unauthenticated protection)",
      async (signal) => {
        const res = await fetch(`${baseUrl}/v1/models`, { signal });
        if (res.status !== 401) {
          return {
            passed: false,
            status: res.status,
            message: `Expected HTTP 401, received ${res.status}`,
          };
        }
        const body = (await res.json()) as {
          error?: { code?: string | undefined } | undefined;
        };
        if (body.error?.code !== "invalid_api_key") {
          return {
            passed: false,
            status: res.status,
            message: `Expected error.code 'invalid_api_key', received: ${JSON.stringify(body)}`,
          };
        }
        return { passed: true, status: res.status, message: "Rejected 401" };
      },
      timeoutMs,
    ),
  );

  // Probe 4: GET /v1/models (Invalid token)
  results.push(
    await executeProbe(
      "GET /v1/models (invalid credentials)",
      async (signal) => {
        const res = await fetch(`${baseUrl}/v1/models`, {
          headers: { Authorization: "Bearer invalid_probe_token_12345" },
          signal,
        });
        if (res.status !== 401) {
          return {
            passed: false,
            status: res.status,
            message: `Expected HTTP 401, received ${res.status}`,
          };
        }
        const body = (await res.json()) as {
          error?: { code?: string | undefined } | undefined;
        };
        if (body.error?.code !== "invalid_api_key") {
          return {
            passed: false,
            status: res.status,
            message: `Expected error.code 'invalid_api_key', received: ${JSON.stringify(body)}`,
          };
        }
        return { passed: true, status: res.status, message: "Rejected 401" };
      },
      timeoutMs,
    ),
  );

  // Probe 5: POST /v1/chat/completions (Unauthenticated)
  results.push(
    await executeProbe(
      "POST /v1/chat/completions (unauthenticated protection)",
      async (signal) => {
        const res = await fetch(`${baseUrl}/v1/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "fast",
            messages: [{ role: "user", content: "probe" }],
          }),
          signal,
        });
        if (res.status !== 401) {
          return {
            passed: false,
            status: res.status,
            message: `Expected HTTP 401, received ${res.status}`,
          };
        }
        return { passed: true, status: res.status, message: "Rejected 401" };
      },
      timeoutMs,
    ),
  );

  // Protected route probes require valid credentials
  if (token) {
    const authHeaders = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    };

    // Probe 6: GET /v1/models (Authenticated catalog)
    results.push(
      await executeProbe(
        "GET /v1/models (authenticated catalog)",
        async (signal) => {
          const res = await fetch(`${baseUrl}/v1/models`, {
            headers: authHeaders,
            signal,
          });
          if (res.status !== 200) {
            return {
              passed: false,
              status: res.status,
              message: `Expected HTTP 200, received ${res.status}`,
            };
          }
          const body = (await res.json()) as {
            object?: string | undefined;
            data?: Array<{ id: string; object: string }> | undefined;
          };
          if (body.object !== "list" || !Array.isArray(body.data)) {
            return {
              passed: false,
              status: res.status,
              message: `Expected object 'list' with data array, received: ${JSON.stringify(body)}`,
            };
          }
          const hasFast = body.data.some((m) => m.id === "fast");
          if (!hasFast) {
            return {
              passed: false,
              status: res.status,
              message: `Model 'fast' missing from catalog: ${JSON.stringify(body.data)}`,
            };
          }
          return { passed: true, status: res.status, message: "Catalog OK" };
        },
        timeoutMs,
      ),
    );

    // Probe 7: POST /v1/models (Method not allowed)
    results.push(
      await executeProbe(
        "POST /v1/models (method constraint)",
        async (signal) => {
          const res = await fetch(`${baseUrl}/v1/models`, {
            method: "POST",
            headers: authHeaders,
            signal,
          });
          if (res.status !== 405) {
            return {
              passed: false,
              status: res.status,
              message: `Expected HTTP 405, received ${res.status}`,
            };
          }
          const allowHeader = res.headers.get("allow") ?? "";
          if (!allowHeader.includes("GET")) {
            return {
              passed: false,
              status: res.status,
              message: `Expected Allow header containing GET, received: '${allowHeader}'`,
            };
          }
          return { passed: true, status: res.status, message: "Rejected 405" };
        },
        timeoutMs,
      ),
    );

    // Probe 8: POST /v1/chat/completions (Stream rejected)
    results.push(
      await executeProbe(
        "POST /v1/chat/completions (stream rejected)",
        async (signal) => {
          const res = await fetch(`${baseUrl}/v1/chat/completions`, {
            method: "POST",
            headers: authHeaders,
            body: JSON.stringify({
              model: "fast",
              stream: true,
              messages: [{ role: "user", content: "test" }],
            }),
            signal,
          });
          if (res.status !== 400) {
            return {
              passed: false,
              status: res.status,
              message: `Expected HTTP 400, received ${res.status}`,
            };
          }
          const body = (await res.json()) as {
            error?:
              | { code?: string | undefined; param?: string | undefined }
              | undefined;
          };
          if (
            body.error?.code !== "unsupported_parameter" ||
            body.error?.param !== "stream"
          ) {
            return {
              passed: false,
              status: res.status,
              message: `Expected unsupported_parameter for param stream, received: ${JSON.stringify(body)}`,
            };
          }
          return { passed: true, status: res.status, message: "Rejected 400" };
        },
        timeoutMs,
      ),
    );

    // Probe 9: POST /v1/chat/completions (Stream options rejected)
    results.push(
      await executeProbe(
        "POST /v1/chat/completions (stream_options rejected)",
        async (signal) => {
          const res = await fetch(`${baseUrl}/v1/chat/completions`, {
            method: "POST",
            headers: authHeaders,
            body: JSON.stringify({
              model: "fast",
              stream_options: { include_usage: true },
              messages: [{ role: "user", content: "test" }],
            }),
            signal,
          });
          if (res.status !== 400) {
            return {
              passed: false,
              status: res.status,
              message: `Expected HTTP 400, received ${res.status}`,
            };
          }
          const body = (await res.json()) as {
            error?:
              | { code?: string | undefined; param?: string | undefined }
              | undefined;
          };
          if (
            body.error?.code !== "unsupported_parameter" ||
            body.error?.param !== "stream_options"
          ) {
            return {
              passed: false,
              status: res.status,
              message: `Expected unsupported_parameter for param stream_options, received: ${JSON.stringify(body)}`,
            };
          }
          return { passed: true, status: res.status, message: "Rejected 400" };
        },
        timeoutMs,
      ),
    );

    // Probe 10: POST /v1/chat/completions (Unknown model)
    results.push(
      await executeProbe(
        "POST /v1/chat/completions (unknown model routing)",
        async (signal) => {
          const res = await fetch(`${baseUrl}/v1/chat/completions`, {
            method: "POST",
            headers: authHeaders,
            body: JSON.stringify({
              model: "nonexistent-model-xyz",
              messages: [{ role: "user", content: "test" }],
            }),
            signal,
          });
          if (res.status !== 404) {
            return {
              passed: false,
              status: res.status,
              message: `Expected HTTP 404, received ${res.status}`,
            };
          }
          const body = (await res.json()) as {
            error?: { code?: string | undefined } | undefined;
          };
          if (body.error?.code !== "model_not_found") {
            return {
              passed: false,
              status: res.status,
              message: `Expected error.code 'model_not_found', received: ${JSON.stringify(body)}`,
            };
          }
          return { passed: true, status: res.status, message: "Rejected 404" };
        },
        timeoutMs,
      ),
    );

    // Probe 11: POST /v1/chat/completions (Payload limit exceeded)
    results.push(
      await executeProbe(
        "POST /v1/chat/completions (10 MB payload limit)",
        async (signal) => {
          const largeBody = new Uint8Array(10 * 1024 * 1024 + 1);
          const res = await fetch(`${baseUrl}/v1/chat/completions`, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
            },
            body: largeBody,
            signal,
          });
          if (res.status !== 413) {
            return {
              passed: false,
              status: res.status,
              message: `Expected HTTP 413, received ${res.status}`,
            };
          }
          const body = (await res.json()) as {
            error?: { code?: string | undefined } | undefined;
          };
          if (body.error?.code !== "payload_too_large") {
            return {
              passed: false,
              status: res.status,
              message: `Expected error.code 'payload_too_large', received: ${JSON.stringify(body)}`,
            };
          }
          return { passed: true, status: res.status, message: "Rejected 413" };
        },
        timeoutMs,
      ),
    );

    // Probe 12: Optional Live Chat Completion
    if (options.live) {
      results.push(
        await executeProbe(
          "POST /v1/chat/completions (live end-to-end completion)",
          async (signal) => {
            const res = await fetch(`${baseUrl}/v1/chat/completions`, {
              method: "POST",
              headers: authHeaders,
              body: JSON.stringify({
                model: "fast",
                messages: [
                  { role: "user", content: "Respond with the word pong." },
                ],
                max_tokens: 16,
              }),
              signal,
            });
            if (res.status !== 200) {
              const errorText = await res.text();
              return {
                passed: false,
                status: res.status,
                message: `Expected HTTP 200, received ${res.status}: ${errorText}`,
              };
            }
            const body = (await res.json()) as {
              id?: string | undefined;
              object?: string | undefined;
              choices?:
                | Array<{ message?: { content?: string | undefined } }>
                | undefined;
            };
            if (!body.choices?.[0]?.message?.content) {
              return {
                passed: false,
                status: res.status,
                message: `Unexpected completion response shape: ${JSON.stringify(body)}`,
              };
            }
            return {
              passed: true,
              status: res.status,
              message: `Completed with ID: ${body.id ?? "unknown"}`,
            };
          },
          Math.max(timeoutMs, 30000),
        ),
      );
    }
  }

  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;

  return {
    total: results.length,
    passed,
    failed,
    results,
  };
}

/**
 * Prints verification summary to stdout and returns appropriate exit code.
 *
 * @param summary - Verification execution summary.
 * @returns 0 if all probes passed, 1 if any probe failed.
 */
export function reportSummary(summary: IngressVerifySummary): number {
  process.stdout.write("\nIngress Verification Report\n");
  process.stdout.write("===========================\n");

  for (const result of summary.results) {
    const statusTag = result.passed ? "[PASS]" : "[FAIL]";
    const statusPart =
      result.status !== undefined ? ` (HTTP ${result.status})` : "";
    const line = `${statusTag} ${result.name}${statusPart} [${result.durationMs}ms]: ${result.message}\n`;
    if (result.passed) {
      process.stdout.write(line);
    } else {
      process.stderr.write(line);
    }
  }

  process.stdout.write("===========================\n");
  const summaryLine = `Total: ${summary.total} | Passed: ${summary.passed} | Failed: ${summary.failed}\n`;
  process.stdout.write(summaryLine);

  return summary.failed === 0 ? 0 : 1;
}

/**
 * Parses command-line arguments for the verification CLI.
 *
 * @param argv - Command-line arguments.
 * @returns Parsed options or null if help was requested or arguments are invalid.
 */
export function parseArgs(
  argv: string[],
): IngressVerifyOptions | "help" | "invalid" {
  let baseUrl: string | undefined;
  let token: string | undefined = process.env.GATEWAY_TOKENS;
  let live = false;
  let timeoutMs: number | undefined;

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (!arg) {
      i++;
      continue;
    }

    if (arg === "-h" || arg === "--help") {
      return "help";
    }

    if (arg === "--live") {
      live = true;
      i++;
      continue;
    }

    if (arg === "--token") {
      token = argv[i + 1];
      i += 2;
      continue;
    }

    if (arg.startsWith("--token=")) {
      token = arg.slice("--token=".length);
      i++;
      continue;
    }

    if (arg === "--timeout") {
      const parsed = Number.parseInt(argv[i + 1] ?? "", 10);
      if (!Number.isNaN(parsed) && parsed > 0) {
        timeoutMs = parsed;
      }
      i += 2;
      continue;
    }

    if (arg.startsWith("--timeout=")) {
      const parsed = Number.parseInt(arg.slice("--timeout=".length), 10);
      if (!Number.isNaN(parsed) && parsed > 0) {
        timeoutMs = parsed;
      }
      i++;
      continue;
    }

    if (!arg.startsWith("-") && baseUrl === undefined) {
      baseUrl = arg;
      i++;
      continue;
    }

    i++;
  }

  if (!baseUrl) {
    return "invalid";
  }

  return {
    baseUrl,
    ...(token !== undefined ? { token } : {}),
    ...(live ? { live } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  };
}

function printUsage(): void {
  const usage = `Usage: node --experimental-strip-types scripts/verify-ingress.ts <baseUrl> [options]

Arguments:
  <baseUrl>               Target gateway base URL (e.g. http://127.0.0.1:8787 or https://shunt-shim.<subdomain>.workers.dev)

Options:
  --token <token>         Gateway bearer token (defaults to GATEWAY_TOKENS environment variable if set)
  --live                  Execute live end-to-end chat completion against upstream model
  --timeout <ms>          Timeout per probe in milliseconds (default: 15000)
  -h, --help              Display this help message
`;
  process.stdout.write(usage);
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));

  if (parsed === "help") {
    printUsage();
    process.exit(0);
    return;
  }

  if (parsed === "invalid") {
    process.stderr.write("Error: Missing required <baseUrl> argument.\n\n");
    printUsage();
    process.exit(1);
    return;
  }

  const summary = await runIngressVerification(parsed);
  const exitCode = reportSummary(summary);
  process.exit(exitCode);
}

const isDirectExecution = process.argv[1]?.endsWith("verify-ingress.ts");

if (isDirectExecution) {
  main().catch((err: unknown) => {
    process.stderr.write(
      `Fatal error: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  });
}
