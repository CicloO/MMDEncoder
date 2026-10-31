"use strict";
// Pure process graph projection. Metadata remains on the command record.
function commandProcesses(c) {
  return [
    ...(c.pipeFrom ? [c.pipeFrom] : []),
    { exe: c.exe, args: c.args },
    ...(c.pipeTo ? [c.pipeTo] : []),
  ];
}
module.exports = { commandProcesses };
