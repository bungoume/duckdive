import { useEffect, useRef, useState } from 'preact/hooks';
import { t, tx } from '../i18n';
import { updateSettings, useSettings } from '../settings';
import { Popover } from './ui';
import { TimePicker } from './TimePicker';
import type { TimeRange } from '../datemath';

/** Auto-refresh choices: off, then 10 s to 15 min. */
const AUTO_REFRESH = [
  { ms: 0, key: 'off' },
  { ms: 10_000, key: '10s' },
  { ms: 30_000, key: '30s' },
  { ms: 60_000, key: '1m' },
  { ms: 300_000, key: '5m' },
  { ms: 900_000, key: '15m' },
] as const;

export function QueryBar(props: { query: string; range: TimeRange; error: string | null; busy: boolean; onSubmit: (query: string, range: TimeRange) => void }) {
  const [text, setText] = useState(props.query);
  const [help, setHelp] = useState(false);
  const { autoRefreshMs } = useSettings();
  // Sync the input only when the submitted query actually changes (not on mount), so text
  // typed right after mounting is not thrown away.
  const lastQuery = useRef(props.query);
  useEffect(() => {
    if (lastQuery.current !== props.query) {
      lastQuery.current = props.query;
      setText(props.query);
    }
  }, [props.query]);

  return (
    <div>
      <div class="querybar">
        <div class="qinput">
          <span class="subdued" aria-hidden="true">
            ⌕
          </span>
          <input
            value={text}
            placeholder={t('q.placeholder')}
            onInput={(e) => setText(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') props.onSubmit(text, props.range);
            }}
            spellcheck={false}
            autocomplete="off"
          />
          <Popover
            open={help}
            onClose={() => setHelp(false)}
            align="right"
            width={520}
            button={
              <button class="lang" onClick={() => setHelp(!help)}>
                {t('q.syntax')}
              </button>
            }
          >
            <h4>{t('q.syntaxTitle')}</h4>
            <table class="help-table">
              <tbody>
                <tr>
                  <td>error timeout</td>
                  <td>{t('q.help.free')}</td>
                </tr>
                <tr>
                  <td>"connection reset"</td>
                  <td>{t('q.help.phrase')}</td>
                </tr>
                <tr>
                  <td>http.status:503</td>
                  <td>{t('q.help.field')}</td>
                </tr>
                <tr>
                  <td>host.name:web-*</td>
                  <td>{t('q.help.wildcard')}</td>
                </tr>
                <tr>
                  <td>path:/api\/v[12]\/.*/</td>
                  <td>{t('q.help.regex')}</td>
                </tr>
                <tr>
                  <td>http.status:(500 OR 503)</td>
                  <td>{t('q.help.list')}</td>
                </tr>
                <tr>
                  <td>http.latency_ms:&gt;800</td>
                  <td>{t('q.help.range')}</td>
                </tr>
                <tr>
                  <td>http.bytes:[1000 TO 5000]</td>
                  <td>{t('q.help.bracket')}</td>
                </tr>
                <tr>
                  <td>extra.user_id:*</td>
                  <td>{t('q.help.exists')}</td>
                </tr>
                <tr>
                  <td>NOT level:info / -level:info</td>
                  <td>{t('q.help.not')}</td>
                </tr>
                <tr>
                  <td>a AND (b OR c)</td>
                  <td>{t('q.help.bool')}</td>
                </tr>
              </tbody>
            </table>
            <p class="hint">{tx('q.helpNote', { enter: <kbd>Enter</kbd> })}</p>
          </Popover>
        </div>
        <TimePicker range={props.range} onChange={(r) => props.onSubmit(text, r)} />
        <button class="btn primary" onClick={() => props.onSubmit(text, props.range)} disabled={props.busy}>
          {props.busy ? t('q.running') : t('q.refresh')}
        </button>
        <select
          class="input auto-refresh"
          title={t('q.autoRefresh')}
          aria-label={t('q.autoRefresh')}
          value={autoRefreshMs}
          onChange={(e) => updateSettings({ autoRefreshMs: Number(e.currentTarget.value) })}
        >
          {AUTO_REFRESH.map((o) => (
            <option key={o.ms} value={o.ms}>
              {t(`q.ar.${o.key}`)}
            </option>
          ))}
        </select>
      </div>
      {props.error && <div class="qerror">{props.error}</div>}
    </div>
  );
}
