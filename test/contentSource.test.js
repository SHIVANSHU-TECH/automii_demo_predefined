const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const {
  customDemoFrom,
  resolveDemo,
  clearContentCache,
} = require("../src/services/contentSource");

const fallback = [
  {
    id: "builtin",
    title: "Built-in demo",
    keywords: ["builtin"],
    aliases: ["built in demo"],
    script: "Built-in script",
    videoUrl: "https://example.com/builtin.mp4",
  },
];

describe("contentSource", () => {
  beforeEach(() => {
    clearContentCache();
    delete process.env.CONTENT_URL;
  });

  it("ignores a portal entry until both script and video link are present", () => {
    assert.equal(customDemoFrom({ script: "Hello", videoUrl: "" }), null);
    assert.equal(customDemoFrom({ script: "", videoUrl: "https://example.com/a.mp4" }), null);
    assert.equal(customDemoFrom({ script: "Hello", videoUrl: "not-a-url" }), null);
  });

  it("uses the portal script and video for any message when both are set", async () => {
    process.env.CONTENT_URL = "https://portal.example/api/content";
    const fetchImpl = async () => ({
      ok: true,
      json: async () => ({
        title: "Client reel",
        script: "Client script",
        videoUrl: "https://cdn.example/client.mp4",
      }),
    });
    const demo = await resolveDemo("anything the user types", fallback, fetchImpl);
    assert.equal(demo.id, "portal-custom");
    assert.equal(demo.script, "Client script");
    assert.equal(demo.videoUrl, "https://cdn.example/client.mp4");
  });

  it("falls back to the built-in demo when the portal is empty", async () => {
    process.env.CONTENT_URL = "https://portal.example/api/content";
    const fetchImpl = async () => ({
      ok: true,
      json: async () => ({ script: "", videoUrl: "" }),
    });
    const demo = await resolveDemo("show me the built in demo", fallback, fetchImpl);
    assert.equal(demo.id, "builtin");
    assert.equal(demo.script, "Built-in script");
  });
});
