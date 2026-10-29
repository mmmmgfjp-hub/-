import React from 'react';

export function Spinner({ light = false }: { light?: boolean }) {
  return <span className={light ? 'spinner spinner--light' : 'spinner'} aria-hidden="true" />;
}

export function Alert({
  kind = 'info',
  children,
}: {
  kind?: 'info' | 'warn' | 'error' | 'success';
  children: React.ReactNode;
}) {
  return (
    <div className={`alert alert--${kind}`} role={kind === 'error' ? 'alert' : 'status'}>
      {children}
    </div>
  );
}

export function Field({
  label,
  hint,
  htmlFor,
  children,
}: {
  label: string;
  hint?: string;
  htmlFor?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="field">
      <label htmlFor={htmlFor}>{label}</label>
      {children}
      {hint ? <span className="hint">{hint}</span> : null}
    </div>
  );
}

export function LoadingBlock({ label }: { label: string }) {
  return (
    <div className="card stack" aria-busy="true">
      <div className="skeleton" style={{ height: 18, width: '42%' }} />
      <div className="skeleton" style={{ height: 14, width: '88%' }} />
      <div className="skeleton" style={{ height: 14, width: '72%' }} />
      <span className="hint">{label}</span>
    </div>
  );
}

export function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  React.useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label={title} onClick={onClose}>
      <div className="modal" onClick={(event) => event.stopPropagation()}>
        <div className="card-title">
          <h2>{title}</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="close">
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <p className="muted small">{children}</p>;
}

/** Money-formatted ratio chip used by the analysis view. */
export function RrChip({ value }: { value: number | null }) {
  if (value === null || !Number.isFinite(value)) return null;
  return <span className="badge badge--gold">1:{value.toFixed(2)}</span>;
}
