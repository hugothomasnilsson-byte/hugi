import { useRef } from 'react';

interface Props<T extends string> {
  label: string;
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
}

/** A small set of mutually exclusive options, following the ARIA radio-group pattern. */
export function Segmented<T extends string>({ label, value, options, onChange }: Props<T>) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  return (
    <div className="segmented" role="radiogroup" aria-label={label}>
      {options.map((o, i) => (
        <button
          key={o.value}
          ref={(el) => {
            refs.current[i] = el;
          }}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          tabIndex={value === o.value ? 0 : -1}
          className={`segmented__opt ${value === o.value ? 'is-on' : ''}`}
          onClick={() => onChange(o.value)}
          onKeyDown={(e) => {
            const n = options.length;
            const j =
              e.key === 'ArrowRight' || e.key === 'ArrowDown'
                ? (i + 1) % n
                : e.key === 'ArrowLeft' || e.key === 'ArrowUp'
                  ? (i - 1 + n) % n
                  : e.key === 'Home'
                    ? 0
                    : e.key === 'End'
                      ? n - 1
                      : -1;
            if (j < 0) return;
            e.preventDefault();
            onChange(options[j].value);
            refs.current[j]?.focus();
          }}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
