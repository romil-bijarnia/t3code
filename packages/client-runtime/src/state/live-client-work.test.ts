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
    for (const order of [
      [0, 1, 2],
      [0, 2, 1],
      [1, 0, 2],
      [1, 2, 0],
      [2, 0, 1],
      [2, 1, 0],
    ]) {
      const owners = Array.from({ length: 3 }, retainLiveClientWork);
      try {
        expect(getLiveClientWorkCount()).toBe(3);
        for (const [index, owner] of order.entries()) {
          owners[owner]!();
          owners[owner]!();
          expect(getLiveClientWorkCount()).toBe(2 - index);
        }
      } finally {
        for (const release of owners) release();
      }
    }
  } finally {
    first();
    second();
    unsubscribe();
    removeBroken();
  }
});

it("keeps releases idempotent when an observer releases overlapping work reentrantly", () => {
  let releaseFromObserver = () => {};
  let reenter = false;
  const unsubscribe = subscribeLiveClientWork(() => {
    if (reenter) releaseFromObserver();
  });
  const first = retainLiveClientWork();
  const second = retainLiveClientWork();
  releaseFromObserver = first;
  try {
    expect(getLiveClientWorkCount()).toBe(2);
    reenter = true;
    second();
    expect(getLiveClientWorkCount()).toBe(0);
    first();
    second();
    expect(getLiveClientWorkCount()).toBe(0);
  } finally {
    reenter = false;
    first();
    second();
    unsubscribe();
  }
});
