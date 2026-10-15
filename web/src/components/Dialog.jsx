import React, { useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import Icon from './Icon.jsx';
import { useStrings } from '../i18n/useStrings.js';

// Open dialogs, oldest first: Esc closes only the topmost one.
const openDialogs = [];

/**
 * The board's window: a backdrop and a box, with Esc and the backdrop
 * closing it when `onDismiss` is given. `icon` is an Icon.jsx name; anything
 * else (a literal emoji) is drawn as text. Every dialog the board shows — a
 * question from Claude, a plan to approve, a confirmation that used to be the
 * browser's own — sits on this so they all read the same.
 *
 * Optional extras, all off by default:
 *  - `tone="danger"`: red icon slab and a red 3px strip on top (a risky step).
 *  - `role="alertdialog"`: for a dialog that interrupts with a risk.
 *  - `header`: a node that replaces the default title row; the close button is
 *    still drawn unless `onDismiss` is null.
 *  - `dismissLabel`: the close button's label and tooltip.
 *  - `hint`: a node at the left of the footer, e.g. `<Kbd>Esc</Kbd> closes`.
 */
export default function Dialog({
  title, icon = null, onDismiss = null, wide = false, children, footer = null, className = '',
  tone = 'default', role = 'dialog', header = null, dismissLabel: dismissOpt = null, hint = null,
}) {
  const t = useStrings();
  const dismissLabel = dismissOpt ?? t.app.dialog.closeEsc;
  const box = useRef(null);
  const titleId = useId();
  const token = useRef({});
  useEffect(() => {
    const mine = token.current;
    openDialogs.push(mine);
    return () => { const i = openDialogs.indexOf(mine); if (i >= 0) openDialogs.splice(i, 1); };
  }, []);
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'Escape' || !onDismiss) return;
      if (openDialogs[openDialogs.length - 1] !== token.current) return;
      onDismiss();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onDismiss]);
  useEffect(() => { box.current?.querySelector('[autofocus]')?.focus?.(); }, []);

  const danger = tone === 'danger';
  const close = onDismiss && (
    <button type="button" className="btn btn-close dlg-close" onClick={onDismiss} title={dismissLabel} aria-label={dismissLabel}>
      <Icon name="x" />
    </button>
  );

  // Rendered at <body>, never where it is declared. A dialog opened from the
  // chat panel sat inside `.subpanel-chat`, whose `container-type` (for the
  // tab strip's narrow layout) contains fixed-position descendants: the
  // backdrop and the whole board stopped painting and taking clicks, and the
  // screen went flat dark. No ancestor can do that to a portal.
  return createPortal((
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget && onDismiss) onDismiss(); }}>
      <div className={`modal ${wide ? 'modal-wide' : ''} ${danger ? 'dlg-danger' : ''} ${className}`.trim()}
        role={role} aria-modal="true" aria-labelledby={header ? undefined : titleId} aria-label={header ? title : undefined} ref={box}>
        {header ? (
          <header className="modal-head dlg-head dlg-head-custom">{header}{close}</header>
        ) : (
          <header className="modal-head dlg-head">
            {icon && <span className="modal-icon dlg-icon" aria-hidden="true"><Icon name={icon} /></span>}
            <h2 id={titleId} className="dlg-title">{title}</h2>
            {close}
          </header>
        )}
        <div className="modal-body">{children}</div>
        {(footer || hint) && (
          <footer className="modal-foot">
            {hint && <span className="dlg-hint">{hint}</span>}
            {footer}
          </footer>
        )}
      </div>
    </div>
  ), document.body);
}
