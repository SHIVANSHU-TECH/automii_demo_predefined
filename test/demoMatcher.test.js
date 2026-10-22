const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const {
  loadDemos,
  matchDemo,
  findDemoById,
  listSupportedTopics,
} = require("../src/services/demoMatcher");

const demosPath = path.join(__dirname, "../data/demos.json");
const { demos } = loadDemos(demosPath);

describe("demoMatcher", () => {
  it("loads sample demos from data/demos.json", () => {
    assert.ok(demos.length >= 1);
    assert.ok(demos.every((d) => d.id && d.title && d.script && d.videoUrl));
  });

  it("matches haunted house horror topic via alias", () => {
    const demo = matchDemo(
      "Generate a horror video about a haunted house.",
      demos
    );
    assert.ok(demo);
    assert.equal(demo.id, "horror-haunted-house");
  });

  it("matches AI productivity topic via keywords", () => {
    const demo = matchDemo("Make an AI productivity automation reel", demos);
    assert.ok(demo);
    assert.equal(demo.id, "ai-productivity");
  });

  it("matches Apple HomeView topic via alias", () => {
    const demo = matchDemo("Make a video about Apple HomeView launch", demos);
    assert.ok(demo);
    assert.equal(demo.id, "apple-homeview");
  });

  it("returns null for unknown topics (does not pick a random demo)", () => {
    const demo = matchDemo("Bake a chocolate cake with sprinkles", demos);
    assert.equal(demo, null);
  });

  it("returns null for empty input", () => {
    assert.equal(matchDemo("", demos), null);
    assert.equal(matchDemo("   ", demos), null);
  });

  it("findDemoById works", () => {
    const demo = findDemoById("horror-haunted-house", demos);
    assert.equal(demo.title, "Haunted House Horror Short");
    assert.equal(findDemoById("missing", demos), null);
  });

  it("listSupportedTopics includes titles", () => {
    const list = listSupportedTopics(demos);
    assert.match(list, /Haunted House/);
  });
});
