import { LoaderCircle } from "lucide-react";
import type { ButtonHTMLAttributes, ReactNode } from "react";

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  tone?: "default" | "primary" | "danger" | "ghost" | "cipher";
  size?: "md" | "sm";
  busy?: boolean;
  icon?: ReactNode;
};

export function Button({ tone = "default", size = "md", busy, icon, children, disabled, className, ...rest }: ButtonProps) {
  const classes = ["btn", tone !== "default" && `btn-${tone}`, size === "sm" && "btn-sm", className]
    .filter(Boolean)
    .join(" ");
  return (
    <button type="button" className={classes} disabled={disabled || busy} aria-busy={busy || undefined} {...rest}>
      {busy ? <LoaderCircle size={16} className="spin" aria-hidden /> : icon}
      {children}
    </button>
  );
}

export function shortAddress(address: string) {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export function shortHandle(handle: string) {
  return `${handle.slice(0, 10)}…${handle.slice(-8)}`;
}

export function duration(seconds: number) {
  if (seconds <= 0) return "ended";
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${Math.max(minutes, 1)}m`;
}

export function seconds(ms: number) {
  return `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}s`;
}
