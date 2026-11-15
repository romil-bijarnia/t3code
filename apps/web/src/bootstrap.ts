import { showBootError } from "./lib/bootError";

const entryVersion = document.querySelector<HTMLMetaElement>(
  'meta[name="t3-live-client-version"]',
)?.content;
const entryUrl = new URL(window.location.href);
const trial = entryUrl.searchParams.get("__t3_live_client_trial");
if (trial && trial === entryVersion) {
  document.body.inert = true;
  document.documentElement.dataset.liveClientTrial = trial;
} else if (trial) {
  entryUrl.searchParams.delete("__t3_live_client_trial");
  entryUrl.searchParams.delete("__t3_live_client_focus");
  window.history.replaceState(window.history.state, "", entryUrl);
}

// Shared dev chunks need the React refresh preamble first. Catch failures before React mounts.
void import("./main")
  .then(({ startup }) => startup)
  .catch((error: unknown) => {
    const version = document.querySelector<HTMLMetaElement>(
      'meta[name="t3-live-client-version"]',
    )?.content;
    if (version) void window.desktopBridge?.liveClientUpdates?.fail(version, true).catch(() => {});
    showBootError(error);
  });
