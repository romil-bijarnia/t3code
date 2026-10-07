import { useCallback, useRef, useState } from "react";

export function useComposerFocusState() {
  const [isComposerFocused, setIsComposerFocused] = useState(false);
  const [isComposerScrollCollapsed, setScrollCollapsedState] = useState(false);
  // Every editor selection change asks to expand the composer. Skipping the
  // calls that change nothing keeps a send (which resets the editor inside a
  // commit) from feeding React an endless chain of no-op updates.
  const scrollCollapsedRef = useRef(false);
  const setIsComposerScrollCollapsed = useCallback((collapsed: boolean) => {
    if (scrollCollapsedRef.current === collapsed) return;
    scrollCollapsedRef.current = collapsed;
    setScrollCollapsedState(collapsed);
  }, []);

  // Reaching the end of the timeline lifts a scroll collapse without moving
  // DOM focus to the editor.
  const restoreAfterTimelineReachedEnd = useCallback(() => {
    setIsComposerScrollCollapsed(false);
  }, [setIsComposerScrollCollapsed]);

  return {
    isComposerFocused,
    setIsComposerFocused,
    isComposerScrollCollapsed,
    setIsComposerScrollCollapsed,
    restoreAfterTimelineReachedEnd,
  };
}
