"use client";

import { useState, useRef, useEffect } from "react";

interface SelectOption {
  value: string;
  label: string;
}

interface SelectProps {
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  placeholder?: string;
  disabled?: boolean;
}

export function Select({
  value,
  onChange,
  options,
  placeholder = "-- select --",
  disabled = false,
}: SelectProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open]);

  const selected = options.find((o) => o.value === value);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => !disabled && setOpen(!open)}
        className={`w-full bg-surface-0 border border-border px-4 py-3 text-sm text-left focus:outline-none focus:border-accent transition-colors ${
          disabled ? "opacity-40 cursor-not-allowed" : "cursor-pointer hover:border-accent/50"
        } ${open ? "border-accent" : ""}`}
      >
        <span className={selected ? "text-white" : "text-muted/40"}>
          {selected ? selected.label : placeholder}
        </span>
        <span className="absolute right-4 top-1/2 -translate-y-1/2 text-muted text-xs">
          {open ? "▲" : "▼"}
        </span>
      </button>

      {open && (
        <div className="absolute z-50 w-full mt-px border border-accent bg-[#0a0a0a] max-h-48 overflow-y-auto">
          {options.length === 0 ? (
            <div className="px-4 py-3 text-xs text-muted">no options</div>
          ) : (
            options.map((opt) => (
              <button
                key={opt.value}
                type="button"
                onClick={() => {
                  onChange(opt.value);
                  setOpen(false);
                }}
                className={`w-full text-left px-4 py-2.5 text-sm transition-colors ${
                  opt.value === value
                    ? "text-accent bg-accent/10"
                    : "text-white hover:bg-accent/5 hover:text-accent"
                }`}
              >
                {opt.label}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
