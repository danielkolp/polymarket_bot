import { spawn } from "child_process";
import type { BullpenStatus } from "./types";

let cached: BullpenStatus | null = null;

export async function inspectBullpenCli(force = false): Promise<BullpenStatus> {
  if (cached && !force && cached.checkedAt && Date.now() - cached.checkedAt < 10 * 60 * 1000) {
    return cached;
  }

  cached = await new Promise<BullpenStatus>((resolve) => {
    const checkedAt = Date.now();
    let stdout = "";
    let stderr = "";
    const child = spawn("bullpen", ["--help"], {
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const timer = setTimeout(() => {
      child.kill();
      resolve({
        available: false,
        checkedAt,
        helpText: null,
        error: "Timed out while running bullpen --help.",
      });
    }, 3000);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({
        available: false,
        checkedAt,
        helpText: null,
        error: err.message,
      });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const helpText = (stdout || stderr).slice(0, 2000);
      resolve({
        available: code === 0 && helpText.length > 0,
        checkedAt,
        helpText: helpText || null,
        error: code === 0 ? null : stderr || `bullpen --help exited with code ${code}`,
      });
    });
  });

  return cached;
}
