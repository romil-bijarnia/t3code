import { expect, it, vi } from "vite-plus/test";

import {
  getLiveClientWorkCount,
  retainLiveClientWork,
  subscribeLiveClientWork,
} from "./live-client-work.ts";

it("retains concurrent work until each owner releases it, without exposing observer failures", () => {
  const changed = vi.fn();
  const unsubscribe = subscribeLiveClientWork(changed);
  const removeBroken = subscribeLiveClientWork(() => {
    throw new Error("broken update observer");
  });
  const first = retainLiveClientWork();
  const second = retainLiveClientWork();
  try {
    expect(getLiveClientWorkCount()).toBe(2);
    first();
    first();
    expect(getLiveClientWorkCount()).toBe(1);
    second();
    expect(getLiveClientWorkCount()).toBe(0);
    expect(changed).toHaveBeenCalledTimes(4);
    unsubscribe();
    const afterUnsubscribe = retainLiveClientWork();
    afterUnsubscribe();
    expect(changed).toHaveBeenCalledTimes(4);
  } finally {
    first();
    second();
    unsubscribe();
    removeBroken();
  }
});
