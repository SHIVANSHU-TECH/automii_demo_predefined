const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { checkConfig } = require("../src/checkConfig");

describe("checkConfig", () => {
  it("validates demos without requiring a real BOT_TOKEN when skipped", () => {
    const prev = process.env.SKIP_TOKEN_CHECK;
    process.env.SKIP_TOKEN_CHECK = "1";
    try {
      const config = checkConfig({ requireToken: false });
      assert.ok(config.demos.length >= 1);
    } finally {
      if (prev === undefined) delete process.env.SKIP_TOKEN_CHECK;
      else process.env.SKIP_TOKEN_CHECK = prev;
    }
  });
});
