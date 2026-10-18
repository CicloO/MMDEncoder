import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { useEffect, useState } from "react";
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
}: {
  label: string;
  children: ReactNode;
  hint?: string;
  id: string;
  error?: string;
}) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
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
}: {
  id: string;
  label: string;
  value: string | number;
  options: { value: string | number; label: string }[];
  onChange: (value: string) => void;
  hint?: string;
  disabled?: boolean;
}) {
  return (
    <Field id={id} label={label} hint={hint}>
      <select
        id={id}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        aria-describedby={hint ? `${id}-hint` : undefined}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </Field>
  );
}
export function Modal({
  open,
  onClose,
  title,
  description,
  error,
  wide,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description: string;
  error?: string;
  wide?: boolean;
  children: ReactNode;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={(v) => !v && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="overlay" />
        <Dialog.Content className={wide ? "modal wide" : "modal"}>
          <div className="modal-head">
            <div>
              <Dialog.Title>{title}</Dialog.Title>
              <Dialog.Description>{description}</Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <Button onClick={onClose} aria-label="关闭" title="关闭">
                <X size={18} />
              </Button>
            </Dialog.Close>
          </div>
          {children}
          {error && (
            <p className="inline-error" role="alert">
              {error}
            </p>
          )}
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
            title: "拖动排序",
            onPointerDown: () => setArmed(id),
          }
        : { className: "drag-handle" },
  });
}
// Queue rows per page, shared by the video and media queues.
export const PAGE_SIZE = 10;
