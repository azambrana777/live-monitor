import React from 'react';
import Icon from './Icon.jsx';
import { useStrings } from '../i18n/useStrings.js';

/** What the board shows when no project is on screen: none registered, or none picked. */
export default function NoProjectState({ onManage, onImport }) {
  const t = useStrings().app.noProject;
  return (
    <main className="no-project" aria-labelledby="no-project-heading">
      <Icon name="folder" size={40} />
      <h2 className="no-project-title" id="no-project-heading">{t.title}</h2>
      <p className="no-project-hint">{t.hint}</p>
      <div className="no-project-actions">
        <button type="button" className="btn btn-primary" onClick={onManage}>{t.manage}</button>
        <button type="button" className="btn" onClick={onImport}><Icon name="plus" /> {t.import}</button>
      </div>
    </main>
  );
}
