import React, { useEffect, useState } from 'react';
import Icon from './Icon.jsx';
import Popover, { usePopover } from './ui/Popover.jsx';
import { useStrings } from '../i18n/useStrings.js';
import { fill } from '../i18n/index.js';

/** Past this many projects the panel offers a filter field. */
const FILTER_FROM = 8;

/**
 * Which project the board is looking at.
 *
 * The board watches several projects but paints **one at a time**. A button
 * with the active project's name opens a panel (a `Popover`): the projects that
 * are not restricted, each with two icon buttons (restrict, remove from the
 * board); a folded private section with the restricted ones; and a last row
 * that opens the full management dialog. The active project is always listed,
 * even when it is restricted, so the button never names a project the list
 * does not have.
 *
 * Removing is not confirmed here: `onRemove(project)` belongs to the caller,
 * which asks. The selection is this device's (`activeProject.js`), not the
 * server's.
 *
 * @param {object} props
 * @param {{ id: string, name?: string, repo?: string, restricted?: boolean }[]} [props.projects]
 * @param {string|null} [props.active] id of the active project
 * @param {(id: string) => void} props.onSelect
 * @param {(id: string, restricted: boolean) => void} [props.onToggleRestricted]
 * @param {(project: object) => void} [props.onRemove]
 * @param {() => void} [props.onManage]
 * @param {string|null} [props.fallback] label used while the registry is empty
 */
export default function ProjectPicker({
  projects = [], active, onSelect, onToggleRestricted, onRemove, onManage, fallback = null,
}) {
  const t = useStrings();
  const pop = usePopover();
  const { close } = pop;
  const [privateOpen, setPrivateOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const p = t.topbar.picker;

  const current = projects.find((x) => x.id === active) ?? null;
  const nameOf = (x) => x.name || x.id;

  // The panel lives at the end of <body>, so Tab would never reach it: move the
  // focus in when it opens (the panel is hidden for one frame while it is placed).
  const isOpen = pop.open;
  useEffect(() => {
    if (!isOpen) return undefined;
    const raf = requestAnimationFrame(() => {
      const panel = pop.panelRef.current;
      (panel?.querySelector('.pm-filter')
        ?? panel?.querySelector('.pm-row.is-active .pm-row-main')
        ?? panel?.querySelector('.pm-row-main, button'))?.focus?.();
    });
    return () => cancelAnimationFrame(raf);
  }, [isOpen, pop.panelRef]);

  if (projects.length === 0) {
    if (onManage) {
      return (
        <button type="button" className="tb-picker pm-trigger" onClick={onManage}>
          <Icon name="folder-git"/>
          <span className="tb-picker-name">{p.manage}</span>
        </button>
      );
    }
    return fallback ? <span className="tb-repo" title={fallback}>{fallback}</span> : null;
  }

  const label = current
    ? `${current.repo ?? ''}${current.assignee ? ` · @${current.assignee}` : ''}`
    : '';
  const needle = filter.trim().toLowerCase();
  const matches = (x) => !needle || `${nameOf(x)} ${x.repo ?? ''}`.toLowerCase().includes(needle);
  const activeRestricted = current?.restricted ? current : null;
  const visible = projects.filter((x) => !x.restricted && matches(x));
  const priv = projects.filter((x) => x.restricted && x !== activeRestricted && matches(x));
  const allPrivate = projects.filter((x) => x.restricted && x !== activeRestricted).length;
  const showFilter = projects.length > FILTER_FROM;
  const empty = !visible.length && !(activeRestricted && matches(activeRestricted)) && !(needle && priv.length);
  const privateShown = privateOpen || Boolean(needle && priv.length);

  const toTrigger = () => { close(); pop.anchorRef.current?.focus?.(); };
  const pick = (id) => { toTrigger(); onSelect?.(id); };

  const row = (x, { restricted, hint }) => (
    <li key={x.id} className={`pm-row${x.id === active ? ' is-active' : ''}`}>
      <button type="button" className="pm-row-main" aria-current={x.id === active ? 'true' : undefined}
        title={x.repo || nameOf(x)} onClick={() => pick(x.id)}>
        <span className="pm-row-name">{nameOf(x)}</span>
        {hint && <span className="pm-row-hint">{p.restrictedHint}</span>}
      </button>
      {onToggleRestricted && (
        <button type="button" className="pm-icon-btn"
          title={restricted ? p.unrestrict : p.restrict}
          aria-label={`${restricted ? p.unrestrict : p.restrict}: ${nameOf(x)}`}
          onClick={(e) => { e.stopPropagation(); onToggleRestricted(x.id, !restricted); }}>
          <Icon name={restricted ? 'eye' : 'eye-off'}/>
        </button>
      )}
      {onRemove && (
        <button type="button" className="pm-icon-btn pm-icon-danger"
          title={p.remove} aria-label={`${p.remove}: ${nameOf(x)}`}
          onClick={(e) => { e.stopPropagation(); toTrigger(); onRemove(x); }}>
          <Icon name="trash"/>
        </button>
      )}
    </li>
  );

  return (
    <>
      <button type="button" {...pop.triggerProps} className="tb-picker pm-trigger"
        aria-haspopup="dialog"
        title={fill(p.switchTitle, { label })}>
        <Icon name="folder-git"/>
        <span className="tb-picker-name">{current ? nameOf(current) : p.choose}</span>
        <Icon name="chevron-down"/>
      </button>
      <Popover pop={pop} placement="bottom-start" label={p.list} className="pm-panel">
        {showFilter && (
          <input className="pm-filter" type="search" spellCheck={false} value={filter}
            aria-label={p.filter} placeholder={p.filterPlaceholder}
            onChange={(e) => setFilter(e.target.value)}/>
        )}
        <ul className="pm-list">
          {activeRestricted && matches(activeRestricted) && row(activeRestricted, { restricted: true, hint: true })}
          {visible.map((x) => row(x, { restricted: false }))}
          {empty && <li className="pm-empty">{p.noMatch}</li>}
        </ul>
        {allPrivate > 0 && (
          <>
            <button type="button" className="pm-private-toggle" aria-expanded={privateShown}
              onClick={() => setPrivateOpen(!privateShown)}>
              <Icon name={privateShown ? 'chevron-down' : 'chevron-right'}/>
              <span>{fill(p.privateN, { n: allPrivate })}</span>
            </button>
            {privateShown && (
              <ul className="pm-list pm-list-private">
                {priv.map((x) => row(x, { restricted: true }))}
              </ul>
            )}
          </>
        )}
        {onManage && (
          <>
            <div className="pm-sep" role="separator"/>
            <button type="button" className="pm-manage" onClick={() => { toTrigger(); onManage(); }}>
              <Icon name="grid"/>
              <span>{p.manage}</span>
            </button>
          </>
        )}
      </Popover>
    </>
  );
}
