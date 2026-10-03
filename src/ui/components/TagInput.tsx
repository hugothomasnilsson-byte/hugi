import { useId, useMemo, useRef, useState } from 'react';
import { normalizeTag, parseTagList } from '../../lib/tags';

interface Props {
  tags: string[];
  onChange: (tags: string[]) => void;
  /** Every tag in the library with usage counts, for autocomplete. */
  library: ReadonlyMap<string, number>;
  placeholder?: string;
  autoFocus?: boolean;
}

/** Hashtag field: chips plus a text input that autocompletes from tags already used. */
export function TagInput({ tags, onChange, library, placeholder = 'add a tag', autoFocus }: Props) {
  const [text, setText] = useState('');
  const [active, setActive] = useState(-1);
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();

  const query = normalizeTag(text);
  const options = useMemo(() => {
    const all = [...library.entries()].filter(([t]) => !tags.includes(t));
    if (!query) return all.sort((a, b) => b[1] - a[1]).slice(0, 8).map(([t]) => t);
    const starts = all.filter(([t]) => t.startsWith(query)).sort((a, b) => b[1] - a[1]);
    const contains = all.filter(([t]) => !t.startsWith(query) && t.includes(query)).sort((a, b) => b[1] - a[1]);
    return [...starts, ...contains].slice(0, 8).map(([t]) => t);
  }, [library, tags, query]);

  const showList = open && options.length > 0 && (query.length > 0 || text === '');

  const commit = (raw: string) => {
    const add = parseTagList(raw).filter((t) => !tags.includes(t));
    if (add.length) onChange([...tags, ...add]);
    setText('');
    setActive(-1);
  };

  return (
    <div className="tag-input" onClick={() => inputRef.current?.focus()}>
      <ul className="tag-input__chips" aria-label="Hashtags">
        {tags.map((t) => (
          <li key={t} className="chip chip--solid">
            #{t}
            <button
              type="button"
              className="chip__x"
              aria-label={`Remove #${t}`}
              onClick={(e) => {
                e.stopPropagation();
                onChange(tags.filter((x) => x !== t));
              }}
            >
              ×
            </button>
          </li>
        ))}
        <li className="tag-input__field">
          <span className="tag-input__hash" aria-hidden="true">
            #
          </span>
          <input
            ref={inputRef}
            value={text}
            autoFocus={autoFocus}
            placeholder={tags.length ? '' : placeholder}
            aria-label="Add a hashtag"
            role="combobox"
            aria-expanded={showList}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={showList && active >= 0 ? `${listId}-${active}` : undefined}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            enterKeyHint="done"
            onFocus={() => setOpen(true)}
            onBlur={() => {
              // Let option clicks land before closing; commit what was typed.
              window.setTimeout(() => setOpen(false), 120);
              if (text.trim()) commit(text);
            }}
            onChange={(e) => {
              const v = e.target.value;
              if (/[\s,;]$/.test(v) && v.trim()) commit(v);
              else {
                setText(v);
                setActive(-1);
                setOpen(true);
              }
            }}
            onPaste={(e) => {
              const pasted = e.clipboardData.getData('text');
              if (/[\s,;#]/.test(pasted.trim())) {
                e.preventDefault();
                commit(text + pasted);
              }
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown' && showList) {
                e.preventDefault();
                setActive((a) => (a + 1) % options.length);
              } else if (e.key === 'ArrowUp' && showList) {
                e.preventDefault();
                setActive((a) => (a - 1 + options.length) % options.length);
              } else if (e.key === 'Enter') {
                if (!text && active < 0) return;
                e.preventDefault();
                commit(showList && active >= 0 ? options[active] : text);
              } else if (e.key === 'Tab' && text) {
                e.preventDefault();
                commit(showList ? options[Math.max(0, active)] : text);
              } else if (e.key === 'Backspace' && !text && tags.length) {
                onChange(tags.slice(0, -1));
              } else if (e.key === 'Escape' && open) {
                e.stopPropagation();
                setOpen(false);
              }
            }}
          />
        </li>
      </ul>
      {showList && (
        <ul className="tag-input__list" id={listId} role="listbox">
          {options.map((t, i) => (
            <li
              key={t}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === active}
              className={`tag-input__opt ${i === active ? 'is-active' : ''}`}
              onMouseDown={(e) => {
                e.preventDefault();
                commit(t);
              }}
              onMouseEnter={() => setActive(i)}
            >
              <span>#{t}</span>
              <span className="mono faint">{library.get(t)}</span>
            </li>
          ))}
          {query && (
            <li className="tag-input__new label" aria-hidden="true">
              {`↵ adds #${query}`}
              {options[0] && options[0] !== query ? ` · Tab completes #${options[0]}` : ''}
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
