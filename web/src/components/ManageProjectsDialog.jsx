import React from 'react';
import Dialog from './Dialog.jsx';
import Icon from './Icon.jsx';
import { useStrings } from '../i18n/useStrings.js';

/**
 * Every project the board knows, as a responsive grid of cards: open it,
 * restrict or unrestrict it, take it off the board. Importing a new one is the
 * header button. Nothing is confirmed here: `onRemove(project)` belongs to the
 * caller, which asks.
 *
 * @param {object} props
 * @param {object[]} props.projects
 * @param {string|null} props.activeProject id of the active project
 * @param {() => void} props.onClose
 * @param {() => void} props.onImport
 * @param {(id: string) => void} props.onSelect
 * @param {(id: string, restricted: boolean) => void} props.onToggleRestricted
 * @param {(project: object) => void} props.onRemove
 */
export default function ManageProjectsDialog({
  projects = [], activeProject, onClose, onImport, onSelect, onToggleRestricted, onRemove,
}) {
  const t = useStrings();
  const m = t.topbar.manage;
  const p = t.topbar.picker;

  const field = (label, value) => (value ? (
    <div className="pm-field">
      <dt>{label}</dt>
      <dd title={value}>{value}</dd>
    </div>
  ) : null);

  return (
    <Dialog
      title={m.title} icon="grid" wide className="pm-dialog"
      onDismiss={onClose}
      footer={(
        <>
          <span className="modal-caption pm-note">{m.note}</span>
          <span className="modal-spacer" />
          <button type="button" className="btn btn-ghost btn-md" onClick={onClose}>{m.close}</button>
        </>
      )}
    >
      <div className="pm-toolbar">
        <button type="button" className="btn btn-primary btn-md" onClick={() => onImport?.()}>
          <Icon name="plus"/> {m.import}
        </button>
      </div>
      {projects.length === 0 ? (
        <p className="pm-empty-state">{m.empty}</p>
      ) : (
        <ul className="pm-grid" aria-label={m.grid}>
          {projects.map((x) => {
            const isActive = x.id === activeProject;
            const name = x.name || x.id;
            return (
              <li key={x.id} className={`pm-card${isActive ? ' is-active' : ''}${x.restricted ? ' is-restricted' : ''}`}>
                <div className="pm-card-head">
                  <h3 className="pm-card-name" title={name}>{name}</h3>
                  {isActive && <span className="pm-badge pm-badge-active">{m.active}</span>}
                  {x.restricted && <span className="pm-badge pm-badge-restricted">{m.restricted}</span>}
                </div>
                <dl className="pm-fields">
                  {field(m.repo, x.repo)}
                  {field(m.path, x.repoPath)}
                  {field(m.assignee, x.assignee ? `@${x.assignee}` : '')}
                </dl>
                <div className="pm-card-actions">
                  <button type="button" className="btn btn-md" onClick={() => { onSelect?.(x.id); onClose?.(); }}>
                    <Icon name="folder-git"/> {m.open}
                  </button>
                  <button type="button" className="btn btn-md btn-icon"
                    title={x.restricted ? p.unrestrict : p.restrict}
                    aria-label={`${x.restricted ? p.unrestrict : p.restrict}: ${name}`}
                    onClick={() => onToggleRestricted?.(x.id, !x.restricted)}>
                    <Icon name={x.restricted ? 'eye' : 'eye-off'}/>
                  </button>
                  <button type="button" className="btn btn-md btn-icon pm-danger"
                    title={p.remove} aria-label={`${p.remove}: ${name}`}
                    onClick={() => onRemove?.(x)}>
                    <Icon name="trash"/>
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Dialog>
  );
}
