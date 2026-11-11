import { assert, it } from "@effect/vitest";
import { parseGitRemoteHost } from "../shared/definition.ts";

import {
  repositoryPathFromRemoteUrl,
  transportSafeSourceControlErrorValue,
} from "./SourceControlProvider.ts";

it("removes URL credentials, query parameters, and fragments from error transport values", () => {
  assert.strictEqual(
    transportSafeSourceControlErrorValue(
      "https://user:secret@example.test/org/repo/pull/42?token=secret#discussion",
    ),
    "https://example.test/org/repo/pull/42",
  );
});

it.each([
  ["git@github.com:T3Tools/t3code.git", "T3Tools/t3code"],
  ["github.com:T3Tools/t3code.git", "T3Tools/t3code"],
  ["gitlab.com:T3Tools/platform/t3code", "T3Tools/platform/t3code"],
  ["https://github.com/T3Tools/t3code.git", "T3Tools/t3code"],
  ["C:/repos/t3code", null],
  ["git@[2001:db8::1]:T3Tools/t3code.git", "T3Tools/t3code", "[2001:db8::1]"],
  ["[2001:db8::1]:T3Tools/t3code.git", "T3Tools/t3code", "[2001:db8::1]"],
])(
  "reads the repository path of %s",
  (remoteUrl, expected, expectedHost: string | undefined = undefined) => {
    assert.strictEqual(repositoryPathFromRemoteUrl(remoteUrl), expected);
    if (expectedHost !== undefined) {
      assert.strictEqual(parseGitRemoteHost(remoteUrl)?.host, expectedHost);
    }
  },
);
