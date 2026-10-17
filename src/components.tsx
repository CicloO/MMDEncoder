import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import type { ReactNode, ButtonHTMLAttributes } from "react";
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
