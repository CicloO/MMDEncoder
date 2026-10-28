import * as Dialog from "@radix-ui/react-dialog";
import { Info, X } from "lucide-react";
import { createPortal } from "react-dom";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { t } from "./i18n";
import type { ReactNode, ButtonHTMLAttributes, DragEvent } from "react";
export function Button({
  children,
  variant = "",
  className = "",
  onClick,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`button ${variant} ${className}`}
      {...rest}
      data-modal-autofocus={rest.autoFocus || undefined}
    >
      {children}
    </button>
  );
}
export function Field({
  label,
  children,
  hint,
  id,
  error,
  help,
}: {
  label: ReactNode;
  children: ReactNode;
  hint?: string;
  id: string;
  error?: string;
  help?: string;
}) {
  const helpId = useId();
  return (
    <div className="field">
      {help ? (
        <div className="field-heading">
          <label htmlFor={id} id={`${helpId}-label`}>
            {label}
          </label>
          <Tooltip id={`${helpId}-help`} text={help}>
            {(show) => (
              <button
                type="button"
                className="field-help"
                onClick={show}
                aria-labelledby={`${helpId}-label ${helpId}-help-label`}
                aria-describedby={`${helpId}-help`}
              >
                <Info size={14} />
                <span className="sr-only" id={`${helpId}-help-label`}>
                  {t("common.moreInfo")}
                </span>
              </button>
            )}
          </Tooltip>
        </div>
      ) : (
        <label htmlFor={id}>{label}</label>
      )}
      {children}
      {error && (
        <span className="inline-error" id={`${id}-error`}>
          {error}
        </span>
      )}
      {hint && (
        <span className="hint" id={`${id}-hint`}>
          {hint}
        </span>
      )}
    </div>
  );
}
export function Select({
  id,
  label,
  value,
  options,
  onChange,
  hint,
  disabled = false,
  help,
}: {
  id: string;
  label: ReactNode;
  value: string | number;
  options: { value: string | number; label: string; disabled?: boolean }[];
  onChange: (value: string) => void;
  hint?: string;
  disabled?: boolean;
  help?: string;
}) {
  return (
    <Field id={id} label={label} hint={hint} help={help}>
      <select
        id={id}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        aria-describedby={hint ? `${id}-hint` : undefined}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value} disabled={o.disabled}>
            {o.label}
          </option>
        ))}
      </select>
    </Field>
  );
}
// Shared pointer/keyboard explanation for label help and unavailable controls.
export function Tooltip({
  id,
  text,
  children,
  label,
}: {
  id: string;
  text: string;
  children: ReactNode | ((show: () => void) => ReactNode);
  label?: string;
}) {
  const [open, setOpen] = useState(false),
    [position, setPosition] = useState({ left: 0, top: 0 });
  const anchor = useRef<HTMLSpanElement>(null),
    popup = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    if (!open || !anchor.current || !popup.current) return;
    const positionPopup = () => {
      if (!anchor.current || !popup.current) return;
      const a = anchor.current.getBoundingClientRect(),
        p = popup.current.getBoundingClientRect();
      const left = Math.max(
        8,
        Math.min(a.left, window.innerWidth - p.width - 8),
      );
      const top =
        a.top >= p.height + 8
          ? a.top - p.height
          : Math.min(a.bottom, window.innerHeight - p.height - 8);
      setPosition({ left, top });
    };
    positionPopup();
    window.addEventListener("resize", positionPopup);
    window.addEventListener("scroll", positionPopup, true);
    return () => {
      window.removeEventListener("resize", positionPopup);
      window.removeEventListener("scroll", positionPopup, true);
    };
  }, [open, text]);
  return (
    <span
      ref={anchor}
      className={`tooltip-anchor${label ? " control-tooltip" : ""}`}
      tabIndex={label ? 0 : undefined}
      role={label ? "group" : undefined}
      aria-label={label}
      aria-disabled={label ? true : undefined}
      aria-describedby={label ? id : undefined}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={(e) => {
        if (!e.currentTarget.contains(document.activeElement)) setOpen(false);
      }}
      onFocus={() => setOpen(true)}
      onBlur={(e) => {
        if (
          !e.currentTarget.contains(e.relatedTarget) &&
          !e.currentTarget.matches(":hover")
        )
          setOpen(false);
      }}
      onKeyDown={(e) => {
        if (open && e.key === "Escape") {
          e.stopPropagation();
          setOpen(false);
        }
      }}
    >
      {typeof children === "function"
        ? children(() => setOpen(true))
        : children}
      {createPortal(
        <span
          ref={popup}
          id={id}
          role="tooltip"
          className="field-tooltip"
          hidden={!open}
          style={position}
        >
          {text}
        </span>,
        document.body,
      )}
    </span>
  );
}
// Keep the external opener across a direct dialog handoff (for example engine
// settings -> logs). Nested dialogs keep their own parent-control return target.
let externalModalOpener: HTMLElement | null = null;
function canFocus(element: HTMLElement | null): element is HTMLElement {
  return (
    !!element?.isConnected &&
    !element.matches(":disabled") &&
    !element.closest('[hidden], [inert], [aria-hidden="true"]') &&
    element.getClientRects().length > 0
  );
}
export function Modal({
  open,
  onClose,
  title,
  description,
  error,
  wide,
  fixedHeight,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description: string;
  error?: string;
  wide?: boolean;
  fixedHeight?: boolean;
  children: ReactNode;
}) {
  const content = useRef<HTMLDivElement>(null);
  const opener = useRef<{
    element: HTMLElement | null;
    dialog: Element | null;
  }>({ element: null, dialog: null });
  useLayoutEffect(() => {
    if (!open) return;
    const active = document.activeElement;
    const element =
      active instanceof HTMLElement &&
      active !== document.body &&
      !content.current?.contains(active)
        ? active
        : null;
    if (element && !element.closest('[role="dialog"]'))
      externalModalOpener = element;
    const target = element || externalModalOpener;
    opener.current = {
      element: target,
      dialog: target?.closest('[role="dialog"]') || null,
    };
  }, [open]);
  return (
    <Dialog.Root open={open} onOpenChange={(v) => !v && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="overlay" />
        <Dialog.Content
          ref={content}
          className={`modal${wide ? " wide" : ""}${fixedHeight ? " modal-fixed" : ""}`}
          onOpenAutoFocus={(event) => {
            const target =
              content.current?.querySelector<HTMLElement>(
                "[data-modal-autofocus], [autofocus]",
              ) || null;
            if (canFocus(target)) {
              target.focus({ preventScroll: true });
              if (document.activeElement === target) event.preventDefault();
            }
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            const { element, dialog } = opener.current;
            const remaining = document.querySelector<HTMLElement>(
              '[role="dialog"][data-state="open"]:not([aria-hidden="true"])',
            );
            if (remaining) {
              if (canFocus(element) && remaining.contains(element))
                element.focus({ preventScroll: true });
              else if (remaining === dialog)
                remaining
                  .querySelector<HTMLElement>(
                    'button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex="0"]',
                  )
                  ?.focus({ preventScroll: true });
              return;
            }
            const target = canFocus(element) ? element : externalModalOpener;
            if (canFocus(target)) target.focus({ preventScroll: true });
            externalModalOpener = null;
          }}
        >
          <div className="modal-scroll">
            <div className="modal-head">
              <div>
                <Dialog.Title>{title}</Dialog.Title>
                <Dialog.Description>{description}</Dialog.Description>
              </div>
              <Dialog.Close asChild>
                <Button
                  onClick={onClose}
                  aria-label={t("common.close")}
                  title={t("common.close")}
                >
                  <X size={18} />
                </Button>
              </Dialog.Close>
            </div>
            <div className="modal-body">
              {children}
              {error && (
                <p className="inline-error" role="alert">
                  {error}
                </p>
              )}
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
// Drag-to-reorder for lists. Uses an internal MIME type so it never mixes with
// file drops; onCommit receives the new id order. With { handle: true } a row
// can only be dragged while the pointer is held on the element given
// sort.handle(id) (e.g. a grip icon); otherwise the whole row drags.
const SORT_TYPE = "application/x-mmd-sort";
export function useDragSort(
  ids: string[],
  onCommit: (ids: string[]) => void,
  enabled = true,
  { handle = false } = {},
) {
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const [armed, setArmed] = useState<string | null>(null);
  const active = enabled && ids.length > 1;
  // Releasing anywhere (not only on the handle) disarms the row.
  useEffect(() => {
    if (!armed) return;
    const release = () => setArmed(null);
    window.addEventListener("pointerup", release);
    return () => window.removeEventListener("pointerup", release);
  }, [armed]);
  const row = (id: string) =>
    active
      ? {
          draggable: !handle || armed === id || dragId === id,
          "data-dragging": dragId === id || undefined,
          "data-drop-target": (overId === id && dragId !== id) || undefined,
          onDragStart: (e: DragEvent) => {
            e.dataTransfer.setData(SORT_TYPE, id);
            e.dataTransfer.effectAllowed = "move";
            setDragId(id);
          },
          onDragOver: (e: DragEvent) => {
            if (!e.dataTransfer.types.includes(SORT_TYPE)) return;
            e.preventDefault();
            e.stopPropagation();
            e.dataTransfer.dropEffect = "move";
            if (overId !== id) setOverId(id);
          },
          onDrop: (e: DragEvent) => {
            if (!e.dataTransfer.types.includes(SORT_TYPE)) return;
            e.preventDefault();
            e.stopPropagation();
            const from = e.dataTransfer.getData(SORT_TYPE);
            setDragId(null);
            setOverId(null);
            if (!from || from === id) return;
            const next = ids.filter((x) => x !== from);
            const at = next.indexOf(id);
            // Dropping on a later item places after it, earlier item before it.
            next.splice(
              ids.indexOf(from) < ids.indexOf(id) ? at + 1 : at,
              0,
              from,
            );
            onCommit(next);
          },
          onDragEnd: () => {
            setDragId(null);
            setOverId(null);
            setArmed(null);
          },
        }
      : {};
  return Object.assign(row, {
    handle: (id: string) =>
      active
        ? {
            className: "drag-handle",
            title: t("common.dragSort"),
            onPointerDown: () => setArmed(id),
          }
        : { className: "drag-handle" },
  });
}
// Queue rows per page, shared by the video and media queues.
export const PAGE_SIZE = 10;
