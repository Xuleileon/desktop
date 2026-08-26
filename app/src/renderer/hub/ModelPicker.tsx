import React, { useEffect, useMemo, useRef, useState } from 'react';

export interface ModelPickerOption {
  id: string;
  label: string;
}

interface ModelPickerProps {
  value: string;
  options: ModelPickerOption[];
  defaultLabel: string;
  ariaLabel: string;
  onChange: (model: string) => void;
}

function ChevronIcon(): React.ReactElement {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
      <path d="M2.5 4l2.5 2.5L7.5 4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function ModelPicker({ value, options, defaultLabel, ariaLabel, onChange }: ModelPickerProps): React.ReactElement {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const currentLabel = useMemo(
    () => (options.find((option) => option.id === value)?.label ?? value) || defaultLabel,
    [defaultLabel, options, value],
  );
  const menuOptions = useMemo(() => {
    if (!value || options.some((option) => option.id === value)) return options;
    return [{ id: value, label: value }, ...options];
  }, [options, value]);

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('pointerdown', closeOutside);
    window.addEventListener('keydown', closeOnEscape);
    return () => {
      window.removeEventListener('pointerdown', closeOutside);
      window.removeEventListener('keydown', closeOnEscape);
    };
  }, [open]);

  const choose = (model: string): void => {
    onChange(model);
    setOpen(false);
  };

  return (
    <div ref={rootRef} className="engine-picker task-model-picker">
      <button
        type="button"
        className="engine-picker__toggle task-model-picker__toggle"
        onClick={(event) => {
          event.stopPropagation();
          setOpen((current) => !current);
        }}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={currentLabel}
      >
        <span className="engine-picker__name task-model-picker__name">{currentLabel}</span>
        <ChevronIcon />
      </button>
      {open && (
        <div className="engine-picker__menu task-model-picker__menu" role="listbox" aria-label={ariaLabel}>
          <button
            type="button"
            className={`engine-picker__item${value === '' ? ' engine-picker__item--active' : ''}`}
            onClick={(event) => { event.stopPropagation(); choose(''); }}
            role="option"
            aria-selected={value === ''}
          >
            <span className="engine-picker__item-name">{defaultLabel}</span>
            {value === '' && <span className="engine-picker__check">✓</span>}
          </button>
          {menuOptions.map((option) => (
            <button
              key={option.id}
              type="button"
              className={`engine-picker__item${option.id === value ? ' engine-picker__item--active' : ''}`}
              onClick={(event) => { event.stopPropagation(); choose(option.id); }}
              role="option"
              aria-selected={option.id === value}
              title={option.label}
            >
              <span className="engine-picker__item-name task-model-picker__option-label">{option.label}</span>
              {option.id === value && <span className="engine-picker__check">✓</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
