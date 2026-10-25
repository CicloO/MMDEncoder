"use strict";
// At most `n` tasks at a time, started in the order they were queued. Used
// for reading files on import: ffprobe runs for hundreds of files at once
// fight over the disk and process start-up, while a few at a time is about
// twice as fast as one by one.
function createLimit(n) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= n || !queue.length) return;
    active++;
    const { task, resolve, reject } = queue.shift();
    Promise.resolve()
      .then(task)
      .then(resolve, reject)
      .finally(() => {
        active--;
        next();
      });
  };
  return (task) =>
    new Promise((resolve, reject) => {
      queue.push({ task, resolve, reject });
      next();
    });
}
module.exports = { createLimit };
