const { execFileSync, spawnSync } = require("node:child_process");
const { mkdtempSync, rmSync } = require("node:fs");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const DEFAULT_TIMEOUT_SECONDS = 45 * 60;
const DEFAULT_POLL_SECONDS = 30;
const MAX_CONSECUTIVE_POLL_ERRORS = 8;
const NON_RETRYABLE_SUBMIT_PATTERNS = [
  /HTTP status code:\s*(401|403)\b/u,
  /A required agreement is missing or has expired/u,
  /This request requires an in-effect agreement/u,
  /Unable to authenticate/u,
  /Invalid credentials/u,
];

class FatalNotaryStatusError extends Error {}

function readPositiveIntEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer when set.`);
  }
  return parsed;
}

function authArgs() {
  const key = process.env.APPLE_API_KEY;
  const keyId = process.env.APPLE_API_KEY_ID;
  const issuer = process.env.APPLE_API_ISSUER;
  if (!key || !keyId || !issuer) {
    throw new Error("APPLE_API_KEY, APPLE_API_KEY_ID, and APPLE_API_ISSUER are required.");
  }
  return ["--key", key, "--key-id", keyId, "--issuer", issuer];
}

function runNotarytool(args, options = {}) {
  const result = spawnSync("xcrun", ["notarytool", ...args], {
    encoding: "utf8",
    ...options,
  });
  const output = redactNotarySecrets(`${result.stdout || ""}${result.stderr || ""}`).trim();
  if (result.status !== 0) {
    const suffix = output ? `\n\n${output}` : "";
    throw new Error(`notarytool ${args[0]} failed with exit code ${result.status}.${suffix}`);
  }
  return output;
}

function redactNotarySecrets(value) {
  let redacted = value;
  for (const name of ["APPLE_API_KEY", "APPLE_API_KEY_ID", "APPLE_API_ISSUER"]) {
    const secret = process.env[name];
    if (secret) {
      redacted = redacted.replaceAll(secret, `[REDACTED ${name}]`);
    }
  }
  return redacted;
}

function runJsonNotarytool(args) {
  const output = runNotarytool([...args, "--output-format", "json"]);
  try {
    return JSON.parse(output);
  } catch (error) {
    throw new Error(`notarytool returned non-JSON output:\n\n${output}`, { cause: error });
  }
}

function isNonRetryableSubmitError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return NON_RETRYABLE_SUBMIT_PATTERNS.some((pattern) => pattern.test(message));
}

function formatNonRetryableSubmitFailure(error) {
  const message = error instanceof Error ? error.message : String(error);
  return [
    "Apple notarization cannot continue because notarytool returned a non-retryable account/authentication error.",
    "If this mentions a missing or expired agreement, sign the pending Apple Developer or App Store Connect agreement for the team used by APPLE_API_ISSUER, then rerun the release.",
    "",
    message,
  ].join("\n");
}

function sleep(seconds) {
  execFileSync("sleep", [String(seconds)], { stdio: "inherit" });
}

function findAppPath(appOutDir) {
  const entries = fs.readdirSync(appOutDir);
  const appName = entries.find((entry) => entry.endsWith(".app"));
  if (!appName) {
    throw new Error(`Could not find a .app bundle in ${appOutDir}`);
  }
  return path.join(appOutDir, appName);
}

function createNotarizationZip(appPath) {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "threadlines-notarize-"));
  const zipPath = path.join(tempDir, `${path.basename(appPath, ".app")}.zip`);
  execFileSync(
    "ditto",
    ["-c", "-k", "--sequesterRsrc", "--keepParent", path.basename(appPath), zipPath],
    {
      cwd: path.dirname(appPath),
      stdio: "inherit",
    },
  );
  return { tempDir, zipPath };
}

function submit(zipPath) {
  const maxAttempts = readPositiveIntEnv("THREADLINES_NOTARY_SUBMIT_ATTEMPTS", 3);
  let lastError;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      console.log(
        `[threadlines-notary] Submitting ${zipPath} to Apple (attempt ${attempt}/${maxAttempts})...`,
      );
      const result = runJsonNotarytool(["submit", zipPath, ...authArgs()]);
      if (!result.id) {
        throw new Error(
          `notarytool submit did not return a submission id: ${JSON.stringify(result)}`,
        );
      }
      console.log(`[threadlines-notary] Submission id: ${result.id}`);
      return result.id;
    } catch (error) {
      lastError = error;
      if (isNonRetryableSubmitError(error)) {
        throw new Error(formatNonRetryableSubmitFailure(error), { cause: error });
      }
      if (attempt < maxAttempts) {
        console.warn("[threadlines-notary] Submit failed; retrying in 30 seconds.");
        sleep(30);
      }
    }
  }

  throw lastError;
}

function fetchLog(submissionId) {
  try {
    return runNotarytool(["log", submissionId, ...authArgs()]);
  } catch (error) {
    return `Could not fetch notarization log for ${submissionId}.\n${error.message}`;
  }
}

function waitForAccepted(submissionId) {
  const timeoutSeconds = readPositiveIntEnv(
    "THREADLINES_NOTARY_TIMEOUT_SECONDS",
    DEFAULT_TIMEOUT_SECONDS,
  );
  const pollSeconds = readPositiveIntEnv("THREADLINES_NOTARY_POLL_SECONDS", DEFAULT_POLL_SECONDS);
  const started = Date.now();
  let consecutiveErrors = 0;

  while (Date.now() - started < timeoutSeconds * 1000) {
    try {
      const info = runJsonNotarytool(["info", submissionId, ...authArgs()]);
      consecutiveErrors = 0;
      console.log(`[threadlines-notary] ${submissionId}: ${info.status}`);

      if (info.status === "Accepted") {
        return;
      }

      if (info.status === "Invalid" || info.status === "Rejected") {
        throw new FatalNotaryStatusError(
          `Apple notarization returned ${info.status} for ${submissionId}.\n\n${fetchLog(submissionId)}`,
        );
      }
    } catch (error) {
      if (error instanceof FatalNotaryStatusError) {
        throw error;
      }

      consecutiveErrors += 1;
      if (consecutiveErrors > MAX_CONSECUTIVE_POLL_ERRORS) {
        throw error;
      }
      console.warn(
        `[threadlines-notary] Poll failed (${consecutiveErrors}/${MAX_CONSECUTIVE_POLL_ERRORS}); continuing.`,
      );
    }

    sleep(pollSeconds);
  }

  throw new Error(
    `Timed out after ${timeoutSeconds} seconds waiting for Apple notarization submission ${submissionId}. ` +
      "Check it with `xcrun notarytool info` before retrying.",
  );
}

function staple(appPath) {
  console.log(`[threadlines-notary] Stapling ${appPath}...`);
  execFileSync("xcrun", ["stapler", "staple", appPath], { stdio: "inherit" });
  execFileSync("xcrun", ["stapler", "validate", appPath], { stdio: "inherit" });
}

module.exports = async function notarizeAfterSign(context) {
  if (process.platform !== "darwin") return;

  const appPath = findAppPath(context.appOutDir);
  console.log(`[threadlines-notary] Preparing ${appPath} for notarization.`);

  const { tempDir, zipPath } = createNotarizationZip(appPath);
  try {
    const submissionId = submit(zipPath);
    waitForAccepted(submissionId);
    staple(appPath);
    console.log(`[threadlines-notary] Notarization complete for ${appPath}.`);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
};

module.exports.isNonRetryableSubmitError = isNonRetryableSubmitError;
module.exports.formatNonRetryableSubmitFailure = formatNonRetryableSubmitFailure;
module.exports.redactNotarySecrets = redactNotarySecrets;
