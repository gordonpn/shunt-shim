import { validateEnvironment } from "../src/environment.ts";

try {
  validateEnvironment(process.env);
  process.stdout.write("Gateway environment is valid.\n");
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : "Invalid gateway environment"}\n`,
  );
  process.exitCode = 1;
}
