import React, { useEffect, useRef, useState } from 'react';
import Icon from '../Icon.jsx';
import Popover, { usePopover } from '../ui/Popover.jsx';
import { useStrings } from '../../i18n/useStrings.js';
import { fill } from '../../i18n/index.js';
import { POLL_STEPS, elapsedClock, overallPercent, phaseCounts, phaseState, progressText, stepLabelKey } from '../../pollProgress.js';

/** A screen reader hears the progress at most this often (and at once when the step changes). */
const ANNOUNCE_MS = 10000;

/** The step's name in the catalog, or '' when the step is unknown. */
const stepName = (t, step) => { const k = stepLabelKey(step); return k ? t.topbar.poll.steps[k] : ''; };

/** Re-renders every second while `active`, so the elapsed clock is live. */
function useSecondTick(active) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!active) return undefined;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

/** The progress text for a screen reader: changes on a new step, otherwise every ANNOUNCE_MS. */
function useThrottledText(text, step) {
  const [spoken, setSpoken] = useState(text);
  const last = useRef({ at: 0, step });
  useEffect(() => {
    const now = Date.now();
    if (step !== last.current.step || now - last.current.at >= ANNOUNCE_MS) {
      last.current = { at: now, step };
      setSpoken(text);
      return undefined;
    }
    const id = setTimeout(() => { last.current = { at: Date.now(), step }; setSpoken(text); }, ANNOUNCE_MS - (now - last.current.at));
    return () => clearTimeout(id);
  }, [text, step]);
  return text === '' ? '' : spoken;
}

/**
 * The poll button of the top bar. Idle, a click starts a cycle. While one runs
 * the button is never disabled: it shows the spinner and «done/total», and a
 * click opens a panel with the seven phases (several can be in progress at once),
 * the overall bar, the elapsed time, the project being
 * worked on and the cancel button.
 *
 * @param {object} props
 * @param {boolean} props.running a cycle is running (already corrected for staleness)
 * @param {object|null} [props.info] the poll status object of the server
 * @param {string} props.idleText «last search: …», for the label and the title
 * @param {string} props.idleShort the short form shown next to the icon while idle
 * @param {() => void} props.onStart
 * @param {() => void} [props.onCancel]
 */
export default function PollProgress({ running, info, idleText, idleShort, onStart, onCancel }) {
  const t = useStrings();
  const pop = usePopover();
  const now = useSecondTick(running && pop.open);
  const counts = progressText(info);
  const step = stepName(t, info?.step);
  const [done, total] = counts ? counts.split('/') : [];
  const percent = overallPercent(info);
  const cancelling = Boolean(info?.cancelling);
  const spoken = useThrottledText(running && counts ? fill(t.topbar.poll.progress, { done, total }) : '', info?.step);

  if (!running) {
    return (
      <button type="button" className="btn btn-ghost tb-poll" onClick={onStart}
        aria-label={fill(t.topbar.bar.pollNow, { text: idleText })}
        title={fill(t.topbar.bar.pollTitle, { text: idleText })}>
        <Icon name="refresh"/>
        <span className="tb-poll-text">{idleShort}</span>
      </button>
    );
  }

  const tip = step && counts ? fill(t.topbar.poll.tooltip, { step, done, total }) : t.topbar.poll.title;
  const elapsed = info?.startedAt ? elapsedClock(now - info.startedAt) : '';
  return (
    <>
      <button type="button" {...pop.triggerProps} className="btn btn-ghost tb-poll pp-trigger" aria-busy="true"
        aria-haspopup="dialog" aria-label={tip} title={tip}>
        <span className="tb-spin" aria-hidden="true"><Icon name="refresh"/></span>
        <span className="tb-poll-text pp-count" aria-hidden="true">{counts || t.topbar.bar.polling}</span>
        <span className="pp-sr" aria-live="polite" role="status">{spoken}</span>
      </button>
      <Popover pop={pop} placement="bottom-end" label={t.topbar.poll.panel} className="pp-panel">
        <p className="pp-title">{t.topbar.poll.title}</p>
        <div className="pp-overall">
          <div className="pp-bar" role="progressbar" aria-label={fill(t.topbar.poll.overall, { percent })}
            aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
            <span className="pp-bar-fill" style={{ width: `${percent}%` }}/>
          </div>
          <span className="pp-pct">{counts ? `${percent}%` : ''}</span>
        </div>
        <ol className="pp-steps">
          {POLL_STEPS.map((s) => {
            const state = phaseState(info?.phases, s, info);
            const c = phaseCounts(info?.phases, s);
            const num = c && c.total > 0 ? `${c.done}/${c.total}` : (state === 'active' && counts ? counts : '');
            return (
              <li key={s} className={`pp-step pp-${state}`} aria-current={state === 'active' ? 'step' : undefined}>
                <span className="pp-mark" aria-hidden="true">
                  {state === 'done' ? <Icon name="check"/> : state === 'active' ? <span className="tb-spin"><Icon name="refresh"/></span> : <Icon name="circle"/>}
                </span>
                <span className="pp-name">{t.topbar.poll.steps[s]}</span>
                <span className="pp-sr">{t.topbar.poll[state === 'done' ? 'done' : state === 'active' ? 'active' : 'pending']}</span>
                <span className="pp-num">{num}</span>
              </li>
            );
          })}
        </ol>
        {info?.project && <p className="pp-meta">{fill(t.topbar.poll.project, { project: info.project })}</p>}
        {elapsed && <p className="pp-meta">{fill(t.topbar.poll.elapsed, { time: elapsed })}</p>}
        <button type="button" className="btn pp-cancel" disabled={cancelling} onClick={onCancel}>
          {cancelling ? t.topbar.poll.cancelling : t.topbar.poll.cancel}
        </button>
      </Popover>
    </>
  );
}
