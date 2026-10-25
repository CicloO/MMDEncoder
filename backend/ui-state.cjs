"use strict";
// What the window sees of the service state: every push, action response and
// "state" query. A video job's log (up to 200 KB each) is read through the
// "logs" action and a media job's whole log through "mediaLog", so here they
// are left out or cut to their tail; the full state stays in the service.
function uiState(state) {
  return JSON.parse(
    JSON.stringify({
      ...state,
      jobs: state.jobs.map(({ log, _maskReady, ...j }) => {
        // The encoder retains the planned path for a mask-only retry, but
        // only a successful commit makes it an output the window may show.
        if (!_maskReady) delete j.maskOutput;
        return j;
      }),
      mediaJobs: state.mediaJobs.map((j) =>
        j.log?.length > 8000 ? { ...j, log: "…" + j.log.slice(-8000) } : j,
      ),
    }),
  );
}
module.exports = { uiState };
