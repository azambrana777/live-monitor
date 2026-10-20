import React from 'react';
import Dialog from './Dialog.jsx';
import Icon from './Icon.jsx';
import { useStrings } from '../i18n/useStrings.js';
import { api } from '../api.js';
import { fill } from '../i18n/index.js';

/**
 * One of the server's account warnings (`{ code, login, ...details, message }`)
 * in the reader's language; one it has no words for falls back to the
 * server's own English `message`.
 */
export function accountWarningText(t, w) {
  const template = w && t.topbar.manage.accountWarning[w.code];
  if (template) return fill(template, w);
  return typeof w === 'string' ? w : String(w?.message ?? '');
}

/**
 * Every project the board knows, as a responsive grid of cards: open it,
 * restrict or unrestrict it, change the GitHub account it works as, take it off
 * the board. Importing a new one is the header button. Nothing is confirmed here: `onRemove(project)` belongs to the
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

  // The accounts `gh` has a session for, asked once per opening. Per card, what
  // the last change answered: still saving, its warnings, or its refusal.
  const [accounts, setAccounts] = React.useState([]);
  // The login a project without its own account works as, named on that option.
  const [current, setCurrent] = React.useState(null);
  const [notes, setNotes] = React.useState({});
  React.useEffect(() => {
    api.ghAccounts().then((r) => {
      setAccounts(Array.isArray(r?.accounts) ? r.accounts : []);
      setCurrent(typeof r?.current === 'string' ? r.current : null);
    }, () => {});
  }, []);
  const note = (id, value) => setNotes((n) => ({ ...n, [id]: value }));

  const changeAccount = async (x, login) => {
    const ghUser = login || null;
    // The assignee follows the account when it was the account (or nobody);
    // one picked by hand stays.
    const follows = ghUser && (!x.assignee || x.assignee === x.ghUser);
    note(x.id, { busy: true });
    try {
      const saved = await api.setProjectGhAccount(x.id, ghUser, follows ? ghUser : undefined);
      note(x.id, { warnings: Array.isArray(saved?.warnings) ? saved.warnings : [] });
    } catch (e) {
      note(x.id, { error: e.message });
    }
  };

  // The project's own account stays offered even when `gh` lost its session:
  // the warning says so, and the select must not pretend it is another one.
  const accountOptions = (x) => {
    const logins = accounts.map((a) => a.login);
    return x.ghUser && !logins.includes(x.ghUser) ? [...logins, x.ghUser] : logins;
  };

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
                  <div className="pm-field">
                    <dt>{m.account}</dt>
                    <dd>
                      <select
                        className="pm-account" aria-label={`${m.account}: ${name}`}
                        value={x.ghUser ?? ''} disabled={notes[x.id]?.busy}
                        onChange={(e) => changeAccount(x, e.target.value)}
                      >
                        <option value="">{current ? fill(m.accountActiveIs, { login: current }) : m.accountActive}</option>
                        {accountOptions(x).map((login) => <option key={login} value={login}>@{login}</option>)}
                      </select>
                    </dd>
                  </div>
                </dl>
                {notes[x.id]?.error && <p className="pm-account-note" aria-live="polite">{notes[x.id].error}</p>}
                {notes[x.id]?.warnings?.length > 0 && (
                  <ul className="pm-account-note" aria-live="polite">
                    {notes[x.id].warnings.map((w, i) => <li key={i}>{accountWarningText(t, w)}</li>)}
                  </ul>
                )}
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
