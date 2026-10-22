const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

describe("live config fail-closed", () => {
  it("rejects live mode without spending policy", () => {
    const prev = { ...process.env };
    process.env.BOT_MODE = "live";
    process.env.SPENDING_POLICY_ENABLED = "false";
    delete require.cache[require.resolve("../src/config")];
    try {
      assert.throws(() => require("../src/config").loadConfig(), /SPENDING_POLICY_ENABLED/);
    } finally {
      process.env.BOT_MODE = prev.BOT_MODE;
      process.env.SPENDING_POLICY_ENABLED = prev.SPENDING_POLICY_ENABLED;
      delete require.cache[require.resolve("../src/config")];
    }
  });
});
