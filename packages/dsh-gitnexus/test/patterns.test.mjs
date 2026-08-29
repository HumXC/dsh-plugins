import assert from "node:assert/strict";
import test from "node:test";
import {
  augmentationCandidates,
  extractFilePatterns,
  primaryPattern,
} from "../lib/patterns.js";

const text = (value) => [{ type: "text", text: value }];

test("uses the read basename and grep expression as primary patterns", () => {
  assert.equal(
    primaryPattern("read", { file_path: "src/auth/session-store.ts" }),
    "session-store",
  );
  assert.equal(
    primaryPattern("grep", { pattern: "authenticateUser" }),
    "authenticateUser",
  );
  assert.equal(
    primaryPattern("bash", { command: "rg authenticateUser" }),
    undefined,
  );
});

test("extracts DSH grouped grep paths and glob paths", () => {
  const content = text(
    [
      "Found 2 matches",
      "src/AuthService.ts",
      "Line 10: export class AuthService {}",
      "src/db/user-repo.ts",
      "Line 4: export function loadUser() {}",
    ].join("\n"),
  );

  assert.deepEqual(extractFilePatterns(content, 2), [
    "AuthService",
    "user-repo",
  ]);
});

test("deduplicates primary and secondary patterns case-insensitively", () => {
  const candidates = augmentationCandidates(
    "grep",
    { pattern: "AuthService" },
    text(
      "src/authservice.ts\nLine 1: class AuthService {}\nsrc/Session.ts\nLine 2: class Session {}",
    ),
    3,
  );

  assert.deepEqual(candidates, ["AuthService", "Session"]);
});
