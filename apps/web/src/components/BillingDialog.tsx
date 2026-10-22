import { useEffect, useRef } from 'react';
import type { MeResponse } from '@yunshuo/contracts';
import { BillingPanel } from './BillingPanel.js';

export function BillingDialog({ me, onClose }: { me: MeResponse; onClose: () => void }) {
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    dialogRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [onClose]);

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="modal modal-billing"
        role="dialog"
        aria-modal="true"
        aria-labelledby="billing-title"
        tabIndex={-1}
        ref={dialogRef}
      >
        <header className="modal-head">
          <div>
            <p className="eyebrow">{me.workspace.name} · 计费</p>
            <h2 id="billing-title">归属报表与预算</h2>
          </div>
          <button type="button" className="modal-close" onClick={onClose}>
            关闭
          </button>
        </header>
        <div className="modal-body billing-modal-body">
          <BillingPanel me={me} />
        </div>
      </div>
    </div>
  );
}
