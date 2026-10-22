/**
 * One-at-a-time video upload line.
 * Script progress can run for many chats at once. Only the heavy
 * download/upload waits here, so Render does not hold several 35 MB files.
 */

function createVideoQueue() {
  let active = false;
  const waiting = [];

  function enqueue(task) {
    const ahead = (active ? 1 : 0) + waiting.length;
    let resolve;
    let reject;
    const result = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });

    waiting.push(async () => {
      try {
        resolve(await task());
      } catch (err) {
        reject(err);
      }
    });
    drain();
    return { ahead, result };
  }

  function drain() {
    if (active || waiting.length === 0) return;
    const job = waiting.shift();
    active = true;
    Promise.resolve()
      .then(job)
      .finally(() => {
        active = false;
        drain();
      });
  }

  return { enqueue };
}

const videoQueue = createVideoQueue();

module.exports = { createVideoQueue, videoQueue };
