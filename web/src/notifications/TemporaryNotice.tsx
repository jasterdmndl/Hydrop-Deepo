import {
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  createNoticeTimerController,
  NOTICE_DURATION_MS,
  type NoticeDuration,
  type NoticeTimerController,
} from "./noticeTiming";

const FOCUSABLE_SELECTOR =
  'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

function isVisibleFocusable(element: HTMLElement): boolean {
  if (element.closest('[aria-hidden="true"], [inert]')) return false;
  return element.offsetParent !== null || element.getClientRects().length > 0;
}

function findLogicalNearbyFocusTarget(
  noticeElement: HTMLElement | null,
  preferredTarget?: HTMLElement | null,
): HTMLElement | null {
  if (preferredTarget && preferredTarget.isConnected && isVisibleFocusable(preferredTarget)) {
    return preferredTarget;
  }
  if (!noticeElement) return null;

  const scope =
    noticeElement.closest('[role="dialog"], [role="alertdialog"], main') ?? document.body;
  const candidates = Array.from(scope.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (candidate) => !noticeElement.contains(candidate) && isVisibleFocusable(candidate),
  );
  if (candidates.length === 0) return null;

  const following = candidates.find(
    (candidate) =>
      (noticeElement.compareDocumentPosition(candidate) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
  );
  if (following) return following;

  for (let idx = candidates.length - 1; idx >= 0; idx -= 1) {
    const candidate = candidates[idx]!;
    if (
      (noticeElement.compareDocumentPosition(candidate) & Node.DOCUMENT_POSITION_PRECEDING) !== 0
    ) {
      return candidate;
    }
  }
  return null;
}

export interface TemporaryNoticeProps {
  occurrenceId: number | string;
  duration: NoticeDuration;
  className: string;
  role: "status" | "alert";
  closeLabel?: string;
  onDismiss: () => void;
  returnFocusTo?: RefObject<HTMLElement | null>;
  children: ReactNode;
}

export function TemporaryNotice({
  occurrenceId,
  duration,
  className,
  role,
  closeLabel = "Close notification",
  onDismiss,
  returnFocusTo,
  children,
}: TemporaryNoticeProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const controllerRef = useRef<NoticeTimerController | null>(null);
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;

  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const hoveredRef = useRef(hovered);
  const focusedRef = useRef(focused);
  hoveredRef.current = hovered;
  focusedRef.current = focused;

  const keyboardActivatedRef = useRef(false);

  useEffect(() => {
    const controller = createNoticeTimerController({
      durationMs: NOTICE_DURATION_MS[duration],
      onTimeout: () => {
        onDismissRef.current();
      },
    });
    controllerRef.current = controller;

    if (!hoveredRef.current && !focusedRef.current) {
      controller.start();
    }

    return () => {
      controller.cancel();
      if (controllerRef.current === controller) {
        controllerRef.current = null;
      }
    };
  }, [occurrenceId, duration]);

  useEffect(() => {
    const controller = controllerRef.current;
    if (!controller) return;
    if (hovered || focused) {
      controller.pause();
    } else {
      controller.resume();
    }
  }, [hovered, focused]);

  function handlePointerEnter(event: PointerEvent<HTMLDivElement>) {
    if (event.pointerType === "touch") return;
    setHovered(true);
  }

  function handlePointerLeave(event: PointerEvent<HTMLDivElement>) {
    if (event.pointerType === "touch") return;
    setHovered(false);
  }

  function handleFocus() {
    setFocused(true);
  }

  function handleBlur(event: FocusEvent<HTMLDivElement>) {
    const nextTarget = event.relatedTarget as Node | null;
    if (nextTarget && event.currentTarget.contains(nextTarget)) {
      return;
    }
    setFocused(false);
  }

  function handleClosePointerDown() {
    keyboardActivatedRef.current = false;
  }

  function handleCloseKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key === "Enter" || event.key === " ") {
      keyboardActivatedRef.current = true;
    }
  }

  function handleCloseClick(event: MouseEvent<HTMLButtonElement>) {
    controllerRef.current?.cancel();
    const isKeyboard =
      (event.detail === 0 || keyboardActivatedRef.current) &&
      Boolean(containerRef.current && containerRef.current.contains(document.activeElement));
    keyboardActivatedRef.current = false;

    const focusTarget = isKeyboard
      ? findLogicalNearbyFocusTarget(containerRef.current, returnFocusTo?.current)
      : null;

    onDismissRef.current();

    if (focusTarget) {
      window.requestAnimationFrame(() => {
        if (focusTarget.isConnected) {
          focusTarget.focus();
        }
      });
    }
  }

  return (
    <div
      ref={containerRef}
      className={`${className} temp-notice`}
      role={role}
      onPointerEnter={handlePointerEnter}
      onPointerLeave={handlePointerLeave}
      onFocus={handleFocus}
      onBlur={handleBlur}
    >
      <div className="temp-notice__content">{children}</div>
      <button
        type="button"
        className="temp-notice__close"
        aria-label={closeLabel}
        onPointerDown={handleClosePointerDown}
        onKeyDown={handleCloseKeyDown}
        onClick={handleCloseClick}
      >
        <span aria-hidden="true">×</span>
      </button>
    </div>
  );
}
