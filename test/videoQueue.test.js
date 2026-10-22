const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { createVideoQueue } = require("../src/services/videoQueue");

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("videoQueue", () => {
  it("runs uploads one at a time and keeps later callers in order", async () => {
    const queue = createVideoQueue();
    const order = [];

    const first = queue.enqueue(async () => {
      order.push("start-1");
      await delay(40);
      order.push("end-1");
      return 1;
    });
    const second = queue.enqueue(async () => {
      order.push("start-2");
      await delay(10);
      order.push("end-2");
      return 2;
    });

    assert.equal(first.ahead, 0);
    assert.equal(second.ahead, 1);
    assert.deepEqual(await Promise.all([first.result, second.result]), [1, 2]);
    assert.deepEqual(order, ["start-1", "end-1", "start-2", "end-2"]);
  });
});
