import { describe, expect, it } from "vite-plus/test";

import { browserUserAgent } from "./pinnedApps";

describe("browserUserAgent", () => {
  it("drops the app and Electron tokens but keeps the real Chrome version", () => {
    expect(
      browserUserAgent(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) T3 Code (Alpha)/0.0.46 Chrome/146.0.7680.31 Electron/44.4.2 Safari/537.36",
      ),
    ).toBe(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.7680.31 Safari/537.36",
    );
  });

  it("leaves a user agent it cannot parse alone", () => {
    expect(browserUserAgent("curl/8.7.1")).toBe("curl/8.7.1");
  });
});
