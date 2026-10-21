import React, { useCallback, useState } from 'react';
import Icon from '../Icon.jsx';
import RestartControl from '../RestartControl.jsx';
import ImportProjectDialog from '../ImportProjectDialog.jsx';
import Popover, { usePopover } from '../ui/Popover.jsx';
import { useStrings } from '../../i18n/useStrings.js';

/**
 * The bar's rarely used actions behind one «···» button: import a project,
 * look for updates, restart the board.
 *
 * `RestartControl` is mounted outside the popover on purpose: the popover drops
 * its panel when it closes, and a restart that is waiting for busy work (its
 * poll, its dialogs) has to survive that. Its row is painted into `slot`, an
 * element inside the open panel.
 *
 * @param {object} props
 * @param {boolean} props.checkingUpdates a manual update check is running
 * @param {boolean} props.updatesDisabled the check button waits (check running, offer or upgrade dialog open)
 * @param {() => void} props.onCheckUpdates
 * @param {(project: object) => void} [props.onImported]
 * @param {string|null} [props.defaultAssignee] the board's default assignee, shown by the import dialog
 */
export default function MoreMenu({ checkingUpdates, updatesDisabled, onCheckUpdates, onImported, defaultAssignee }) {
  const t = useStrings();
  const pop = usePopover();
  const { close } = pop;
  const [importing, setImporting] = useState(false);
  const [slot, setSlot] = useState(null);
  const [restartPending, setRestartPending] = useState(false);
  const onEngaged = useCallback((v) => setRestartPending(v), []);

  return (
    <>
      <button type="button" {...pop.triggerProps} className="btn btn-icon btn-md mm-trigger"
        title={t.topbar.more.label} aria-label={restartPending ? t.topbar.more.pending : t.topbar.more.label} aria-haspopup="dialog">
        <Icon name="more" />
        {restartPending && <span className="mm-pending" aria-hidden="true" />}
      </button>
      <Popover pop={pop} placement="bottom-end" label={t.topbar.more.label} className="mm-panel">
        <div className="mm-list" ref={setSlot}>
          <button type="button" className="mm-item" onClick={() => { close(); setImporting(true); }}>
            <span className="mm-icon" aria-hidden="true"><Icon name="folder-git" /></span>
            <span className="mm-text">{t.topbar.more.importProject}</span>
          </button>
          <button type="button" className="mm-item" disabled={updatesDisabled} aria-busy={checkingUpdates}
            onClick={onCheckUpdates}>
            <span className={`mm-icon${checkingUpdates ? ' mm-spin' : ''}`} aria-hidden="true">
              <Icon name={checkingUpdates ? 'refresh' : 'arrow-up'} />
            </span>
            <span className="mm-text">{t.topbar.more.checkUpdates}</span>
          </button>
          <div className="mm-sep" role="separator" />
        </div>
      </Popover>
      {/* Always mounted and never disabled: a restart is askable at any moment. */}
      <RestartControl variant="menu" slot={pop.open ? slot : null} onPicked={close} onEngagedChange={onEngaged} />
      {importing && <ImportProjectDialog defaultAssignee={defaultAssignee} onClose={() => setImporting(false)} onImported={(p) => { setImporting(false); onImported?.(p); }} />}
    </>
  );
}
