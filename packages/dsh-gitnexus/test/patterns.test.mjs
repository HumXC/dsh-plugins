import assert from "node:assert/strict";
import test from "node:test";
import {
  augmentationCandidates,
  extractFilePatterns,
  primaryPattern,
} from "../lib/patterns.js";

const text = (value) => [{ type: "text", text: value }];

test("uses both DSH read providers and the grep expression as primary patterns", () => {
  assert.equal(
    primaryPattern("read", { path: "src/auth/session-store.ts" }),
    "session-store",
  );
  assert.equal(
    primaryPattern("read", { path: "src/current.ts", file_path: "src/legacy.ts" }),
    "current",
  );
  assert.equal(
    primaryPattern("read", { path: null, file_path: "src/legacy.ts" }),
    "legacy",
  );
  assert.equal(primaryPattern("read", { path: null }), undefined);
  assert.equal(primaryPattern("read", { path: "src/ab.ts" }), undefined);
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

test("hash read bodies and source JSON do not create secondary paths", () => {
  const content = text(
    "z7f│src/Unrelated.ts\nZo0│src/Phantom.ts:12: value\nAuN│return source.filename",
  );
  assert.deepEqual(extractFilePatterns(content, 3), []);
  assert.deepEqual(
    augmentationCandidates("read", { path: "src/Session.ts" }, content, 3),
    ["Session"],
  );
  assert.deepEqual(
    augmentationCandidates("read", { file_path: "src/Session.ts" }, text("src/Unrelated.ts"), 3),
    ["Session"],
  );
  assert.deepEqual(
    augmentationCandidates("read", { path: "src/Session.ts" }, text(JSON.stringify({
      paths: ["src/Unrelated.ts"],
    })), 3),
    ["Session"],
  );
});

test("normalized grouped grep content ignores matched source lines and spill text", () => {
  const content = text([
    "Found 3 of 4 matches",
    "",
    "src/AuthService.ts",
    "Line 10: return source.filename",
    "Line 11: src/Phantom.ts",
    "",
    "src/My Session.ts",
    "Line 4: src/Fake.ts:12: source.filename",
    "",
    "(Full grep result stored at: /tmp/grep-results.txt. Read the stored result.)",
  ].join("\n"));
  assert.deepEqual(
    augmentationCandidates("grep", { pattern: "authenticateUser" }, content, 3),
    ["authenticateUser", "AuthService", "My Session"],
  );
});

test("normalized glob lists preserve spaces, order, deduplication, and limits", () => {
  const content = text([
    "src/AuthService.ts",
    "src/authservice.js",
    "src/My Session.ts",
    "src/Third.ts",
    "",
    "(Showing 4 of 100 paths. Full result stored at: /tmp/glob-results.txt.)",
  ].join("\n"));
  assert.deepEqual(
    augmentationCandidates("glob", { pattern: "**/*.ts", path: "src" }, content, 2),
    ["AuthService", "My Session"],
  );
  assert.deepEqual(extractFilePatterns(content, 0), []);
  assert.deepEqual(extractFilePatterns(content, -1), []);
  assert.deepEqual(extractFilePatterns(content, 0.5), []);
});

test("colon grep output extracts the filename without examining its source", () => {
  assert.deepEqual(
    augmentationCandidates("bash", {}, text(
      "src/AuthService.ts:10:src/Phantom.ts\nsrc/Session.ts:4:return source.filename",
    ), 2),
    ["AuthService", "Session"],
  );
});

test("serialized search ContentBlocks only extract explicit paths and match paths", () => {
  const content = [
    ...text(JSON.stringify({ matches: [
      { path: "src/AuthService.ts", lineNumber: 10, line: "src/Phantom.ts" },
      { path: "src/authservice.js", lineNumber: 11, line: "src/Fake.ts:12: value" },
      { path: "src/My Session.ts", lineNumber: 4, line: "return source.filename" },
    ] }, null, 2)),
    { type: "image", source: { type: "base64", media_type: "image/png", data: "" } },
    ...text(JSON.stringify({ root: ".", paths: ["src/Third.ts", "src/Fourth.ts"] })),
  ];
  assert.deepEqual(extractFilePatterns(content, 3), ["AuthService", "My Session", "Third"]);
  assert.deepEqual(extractFilePatterns(text(JSON.stringify({
    text: "src/Phantom.ts",
    nested: { paths: ["src/Fake.ts"] },
  })), 3), []);
  assert.deepEqual(extractFilePatterns(text("{\n  \"paths\": [\n src/Fake.ts"), 3), []);
});

test("extraction stops before oversized response blocks", () => {
  const content = [
    ...text("src/AuthService.ts"),
    ...text(" ".repeat(1_048_576) + "src/Phantom.ts"),
    ...text("src/Session.ts"),
  ];
  assert.deepEqual(extractFilePatterns(content, 3), ["AuthService"]);
});
