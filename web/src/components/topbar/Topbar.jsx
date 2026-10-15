import React, { useState } from 'react';
import Icon from '../Icon.jsx';
import Kbd from '../ui/Kbd.jsx';
import ProjectPicker from '../ProjectPicker.jsx';
import LoginChips from '../LoginChips.jsx';
import PluginChips from '../PluginChips.jsx';
import SettingsMenu from './SettingsMenu.jsx';
import MoreMenu from './MoreMenu.jsx';
import PollProgress from './PollProgress.jsx';
import { useStrings } from '../../i18n/useStrings.js';
import { fill } from '../../i18n/index.js';

// A label like «last check: 2 min ago» is too long for the button; the full text stays in the title.
// `poll.short` is the part after the label when the caller has it; otherwise whatever
// follows the first colon that has no digit before it, in any language.
const shortPoll = (poll) => poll.short ?? poll.text.replace(/^[^:\d]*:\s*/, '');

/**
 * The board's top bar, in four zones: identity (brand + project), search (+ poll),
 * live state (upgrade, machines, logins, plugins, connection) and actions
 * (metrics, settings, «···»). The strip of indicators is `KpiStrip`, mounted by
 * App right after this header.
 *
 * @param {object} props
 * @param {object[]} props.projects
 * @param {string|null} props.activeProject
 * @param {(id: string) => void} props.onSelectProject
 * @param {(project: object) => void} props.onImported kept for callers; the import dialog lives in MoreMenu
 * @param {(id: string, restricted: boolean) => void} [props.onToggleRestricted] restrict or unrestrict a project
 * @param {(project: object) => void} [props.onRemoveProject] take a project off the board (the caller confirms)
 * @param {() => void} [props.onManageProjects] open the manage-projects dialog
 * @param {string|null} props.fallbackRepo label used while the registry holds a single project
 * @param {object} props.settingsMenu props of `SettingsMenu`
 * @param {object} props.moreMenu props of `MoreMenu`
 * @param {{ name: string, kind?: string }[]} props.machines
 * @param {Record<string, object>} props.machineStatus reachability probed apart, by machine name
 * @param {() => void} props.onOpenMetrics
 * @param {{ busy: boolean, text: string, short?: string, msg: string|null, run: () => void, info?: object|null, cancel?: () => void }} props.poll busy = a cycle runs; the button is never disabled
 * @param {{ busy: boolean, run: () => void }} [props.gitRefresh] refresh the git state of the active tasks
 * @param {string} props.query
 * @param {(q: string) => void} props.setQuery
 * @param {{ current: HTMLInputElement|null }} props.searchRef
 * @param {object|null} props.upgradeChip result of `upgradeChip(upgrade)`
 * @param {() => void} props.onOpenUpgrade
 * @param {boolean} props.connected
 */
export default function Topbar({
  projects, activeProject, onSelectProject, onImported, onToggleRestricted, onRemoveProject, onManageProjects, fallbackRepo,
  settingsMenu, moreMenu, machines, machineStatus, onOpenMetrics, poll, gitRefresh,
  query, setQuery, searchRef, upgradeChip: upgradeChipNow, onOpenUpgrade, connected,
}) {
  const t = useStrings();
  // Phone only: the field hides behind a button until it is opened (or holds a query).
  const [searchOpen, setSearchOpen] = useState(false);
  const fieldOpen = searchOpen || query !== '';
  const remotes = machines.filter((m) => m.kind !== 'local');

  const openSearch = () => {
    setSearchOpen(true);
    // The field is display:none until the state lands, so focus after the paint.
    requestAnimationFrame(() => searchRef.current?.focus());
  };

  return (
    <>
      <header className="tb">
        <div className="tb-identity">
          <h1 className="tb-brand">
            <img className="tb-brand-icon" src="/favicon.svg" alt="" />
            <span className="tb-brand-name">Live Monitor</span>{/* i18n-ok: the product name */}
          </h1>
          {/* The board watches several projects and paints one at a time: this
              is the selector. With a single project it is the plain label it
              always was. Importing another one lives in the «···» menu. */}
          <ProjectPicker
            projects={projects}
            active={activeProject}
            onSelect={onSelectProject}
            onToggleRestricted={onToggleRestricted}
            onRemove={onRemoveProject}
            onManage={onManageProjects}
            fallback={fallbackRepo}
          />
        </div>

        <div className="tb-search-zone">
          <button type="button" className="btn btn-icon tb-search-open" aria-label={t.topbar.bar.openSearch}
            title={t.topbar.bar.searchByNumberOrTitle} aria-expanded={fieldOpen} onClick={openSearch}>
            <Icon name="search"/>
          </button>
          <label className={`tb-search${fieldOpen ? ' is-open' : ''}`}>
            <Icon name="search"/>
            <input
              ref={searchRef}
              className="tb-search-input"
              type="text"
              value={query}
              placeholder={t.topbar.bar.searchByNumberOrTitle}
              aria-label={t.topbar.bar.searchTasks}
              onChange={(e) => setQuery(e.target.value)}
              onBlur={() => setSearchOpen(false)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') { setQuery(''); e.currentTarget.blur(); }
              }}
            />
            {query !== '' ? (
              <button className="btn btn-ghost btn-icon btn-xs tb-search-clear" type="button" title={t.topbar.bar.clearSearch}
                aria-label={t.topbar.bar.clearSearch}
                // Keep the field focused: a blur would close it on the phone before the click lands.
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => { setQuery(''); searchRef.current?.focus(); }}><Icon name="x"/></button>
            ) : <Kbd>/</Kbd>}
          </label>
          <PollProgress running={poll.busy} info={poll.info ?? null} idleText={poll.text} idleShort={shortPoll(poll)}
            onStart={poll.run} onCancel={poll.cancel} />
          {gitRefresh && (
            <button type="button" className="btn btn-ghost btn-icon tb-git" onClick={gitRefresh.run} disabled={gitRefresh.busy}
              aria-busy={gitRefresh.busy}
              aria-label={gitRefresh.busy ? t.topbar.bar.gitBusy : t.topbar.bar.gitRefresh}
              title={`${t.topbar.bar.gitTitle}\n${t.topbar.bar.gitTitleSub}`}>
              {gitRefresh.busy ? <span className="tb-spin" aria-hidden="true"><Icon name="branch"/></span> : <Icon name="branch"/>}
            </button>
          )}
          <span className="tb-poll-msg" aria-live="polite">{poll.msg ?? ''}</span>
        </div>

        <div className="tb-live" role="group" aria-label={t.topbar.bar.liveGroup}>
          {/* The SDK is what turns «opus» into today's Opus; an old one is
              the one way left to fall behind on models, so it gets a chip —
              a button that opens the upgrade, and follows it while it runs. */}
          {upgradeChipNow && (
            <button type="button" className={`tb-chip tb-upgrade tb-upgrade-${upgradeChipNow.tone}`}
              title={upgradeChipNow.title} onClick={onOpenUpgrade}>
              {upgradeChipNow.spin
                ? <span className="tb-spin" aria-hidden="true"><Icon name="refresh"/></span>
                : upgradeChipNow.icon ? <Icon name={upgradeChipNow.icon}/> : null}
              <span className="tb-chip-text">{upgradeChipNow.label}</span>
            </button>
          )}
          {machines.length > 1 && remotes.map((m) => {
            const s = machineStatus[m.name];
            const tone = !s ? 'unknown' : !s.online ? 'off' : s.ok ? 'ok' : 'warn';
            const title = !s ? fill(t.topbar.bar.machineChecking, { name: m.name })
              : !s.online ? fill(t.topbar.bar.machineOff, { name: m.name, error: s.error })
                : s.ok ? fill(t.topbar.bar.machineOk, { name: m.name, claude: s.claude })
                  : fill(t.topbar.bar.machineBehind, { name: m.name, claude: s.claude, expected: s.expected });
            return (
              <span key={m.name} className={`tb-machine tb-machine-${tone}`} title={title}>
                <span className="tb-dot" aria-hidden="true" />
                <span className="tb-machine-name">{m.name}</span>
              </span>
            );
          })}
          <LoginChips />
          <PluginChips />
          <span className={`tb-conn ${connected ? 'is-on' : 'is-off'}`} title={connected ? t.topbar.bar.connectedTitle : t.topbar.bar.disconnectedTitle}>
            {connected
              ? <><span className="tb-dot tb-dot-live" aria-hidden="true" /><span className="tb-conn-text">{t.topbar.bar.connected}</span></>
              : <><Icon name="circle"/><span className="tb-conn-text">{t.topbar.bar.reconnecting}</span></>}
          </span>
        </div>

        <div className="tb-actions">
          <button type="button" className="btn btn-md btn-ghost tb-metrics" onClick={onOpenMetrics}
            aria-label={t.topbar.bar.metrics}
            title={t.topbar.bar.metricsTitle}>
            <Icon name="chart-column"/><span className="tb-metrics-text">{t.topbar.bar.metrics}</span>
          </button>
          <SettingsMenu {...settingsMenu} />
          <MoreMenu {...moreMenu} />
        </div>
      </header>
      {!connected && (
        <div className="tb-offline" role="status">
          <Icon name="circle"/> {t.topbar.bar.offline}
        </div>
      )}
    </>
  );
}
