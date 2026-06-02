/**
 * Dark-theme custom select. Native ``<select>`` rendering is jarringly
 * inconsistent across OSes (the OS picks the panel colour, the OS picks
 * the highlight, fonts don't match), and on dark themes it's especially
 * ugly. This component is a tiny, self-contained replacement that:
 *   • Looks identical to the rest of the Vocence form inputs.
 *   • Closes on outside click and Escape.
 *   • Supports keyboard arrow + Enter / Home / End.
 *   • Does not introduce a new dependency.
 *
 * Generic over the option value type, so it can be reused for languages,
 * LLM model ids, voice ids, anything.
 */

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';

export interface SelectOption<T extends string = string> {
  value: T;
  label: string;
  /** Optional second-line description shown in the dropdown only. */
  hint?: string;
}

export interface SelectProps<T extends string = string> {
  value: T;
  onChange: (value: T) => void;
  options: SelectOption<T>[];
  placeholder?: string;
  disabled?: boolean;
  className?: string;
}

export function Select<T extends string = string>({
  value,
  onChange,
  options,
  placeholder = 'Select…',
  disabled = false,
  className = '',
}: SelectProps<T>) {
  const [open, setOpen] = useState(false);
  const [activeIdx, setActiveIdx] = useState<number>(() =>
    Math.max(0, options.findIndex((o) => o.value === value)),
  );
  const rootRef = useRef<HTMLDivElement | null>(null);
  const listboxId = useId();

  const selected = useMemo(
    () => options.find((o) => o.value === value) ?? null,
    [options, value],
  );

  useEffect(() => {
    if (!open) return;
    const onDocPointer = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
      }
    };
    document.addEventListener('pointerdown', onDocPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDocPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // Keep the highlighted row in sync when value changes externally.
  useEffect(() => {
    const i = options.findIndex((o) => o.value === value);
    if (i >= 0) setActiveIdx(i);
  }, [options, value]);

  const commit = (i: number) => {
    const opt = options[i];
    if (!opt) return;
    onChange(opt.value);
    setOpen(false);
  };

  const onTriggerKey = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return;
    if (!open) {
      if (['Enter', ' ', 'ArrowDown', 'ArrowUp'].includes(e.key)) {
        e.preventDefault();
        setOpen(true);
      }
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIdx((i) => Math.min(options.length - 1, i + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIdx((i) => Math.max(0, i - 1));
    } else if (e.key === 'Home') {
      e.preventDefault();
      setActiveIdx(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      setActiveIdx(options.length - 1);
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      commit(activeIdx);
    }
  };

  return (
    <div className={`relative ${className}`} ref={rootRef}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => !disabled && setOpen((v) => !v)}
        onKeyDown={onTriggerKey}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listboxId}
        className={`w-full flex items-center justify-between gap-3 rounded-lg border bg-[#07080A] px-3 py-2 text-sm text-left transition-colors ${
          disabled
            ? 'border-white/10 text-[#666] cursor-not-allowed'
            : open
              ? 'border-[#DFFF00]/40 text-white'
              : 'border-white/15 text-white hover:border-white/25'
        }`}
      >
        <span className={`truncate ${selected ? '' : 'text-[#666]'}`}>
          {selected ? selected.label : placeholder}
        </span>
        <ChevronDown
          size={16}
          className={`shrink-0 text-[#A7B0B7] transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {open && (
        <ul
          id={listboxId}
          role="listbox"
          tabIndex={-1}
          className="absolute z-50 mt-1.5 w-full max-h-72 overflow-y-auto rounded-lg border border-white/15 bg-[#0B0D10] shadow-2xl shadow-black/50 backdrop-blur-xl py-1"
        >
          {options.map((opt, i) => {
            const isSelected = opt.value === value;
            const isActive = i === activeIdx;
            return (
              <li
                key={opt.value}
                role="option"
                aria-selected={isSelected}
                onMouseEnter={() => setActiveIdx(i)}
                onClick={() => commit(i)}
                className={`flex items-center gap-2 px-3 py-2 cursor-pointer text-sm select-none ${
                  isActive
                    ? 'bg-[#DFFF00]/10 text-white'
                    : 'text-[#E8EBF0] hover:bg-white/5'
                }`}
              >
                <Check
                  size={14}
                  className={`shrink-0 ${isSelected ? 'text-[#DFFF00]' : 'opacity-0'}`}
                />
                <div className="min-w-0 flex-1">
                  <div className="truncate leading-tight">{opt.label}</div>
                  {opt.hint && (
                    <div className="text-[11px] text-[#A7B0B7] truncate leading-tight mt-0.5">
                      {opt.hint}
                    </div>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
