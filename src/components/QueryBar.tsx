import { useEffect, useRef, useState } from 'preact/hooks';
import type { Field } from '../fields';
import { t, tx } from '../i18n';
import { updateSettings, useSettings } from '../settings';
import { Popover } from './ui';
import { TimePicker } from './TimePicker';
import type { TimeRange } from '../datemath';

const HISTORY_KEY = 'ddv.queryHistory';
const HISTORY_MAX = 20;

function loadHistory(): string[] {
  try {
    const list: unknown = JSON.parse(localStorage.getItem(HISTORY_KEY) ?? '[]');
    return Array.isArray(list) ? list.filter((q): q is string => typeof q === 'string') : [];
  } catch {
    return [];
  }
}

function rememberQuery(q: string) {
  const query = q.trim();
  if (!query) return;
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify([query, ...loadHistory().filter((x) => x !== query)].slice(0, HISTORY_MAX)));
  } catch {
    /* ignore */
  }
}

/** What the drop-down under the input offers: field names for the token at the caret, or recent queries for an empty box. */
interface Suggestions {
  items: string[];
  kind: 'field' | 'history';
  /** the token being completed */
  from: number;
  to: number;
}

/** Auto-refresh choices: off, then 10 s to 15 min. */
const AUTO_REFRESH = [
  { ms: 0, key: 'off' },
  { ms: 10_000, key: '10s' },
  { ms: 30_000, key: '30s' },
  { ms: 60_000, key: '1m' },
  { ms: 300_000, key: '5m' },
  { ms: 900_000, key: '15m' },
] as const;

export function QueryBar(props: { query: string; range: TimeRange; error: string | null; busy: boolean; fields?: Field[]; onSubmit: (query: string, range: TimeRange) => void }) {
  const [text, setText] = useState(props.query);
  const [help, setHelp] = useState(false);
  const [sugg, setSugg] = useState<Suggestions | null>(null);
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const { autoRefreshMs } = useSettings();

  const suggest = (value: string, caret: number) => {
    setSel(0);
    if (!value.trim()) {
      const h = loadHistory();
      setSugg(h.length ? { items: h, kind: 'history', from: 0, to: value.length } : null);
      return;
    }
    const before = value.slice(0, caret);
    const m = /([A-Za-z0-9_.@-]+)$/.exec(before);
    const token = m?.[1] ?? '';
    const from = caret - token.length;
    // no field names inside a value (after the colon) or without a token
    if (!token || (from > 0 && before[from - 1] === ':')) {
      setSugg(null);
      return;
    }
    const lower = token.toLowerCase();
    const items = (props.fields ?? [])
      .filter((f) => f.kind !== 'object' && f.name.toLowerCase().startsWith(lower) && f.name !== token)
      .map((f) => f.name)
      .slice(0, 8);
    setSugg(items.length ? { items, kind: 'field', from, to: caret } : null);
  };
  const apply = (item: string) => {
    if (!sugg) return;
    setSugg(null);
    if (sugg.kind === 'history') {
      setText(item);
      submit(item);
      return;
    }
    const next = text.slice(0, sugg.from) + item + ':' + text.slice(sugg.to);
    const pos = sugg.from + item.length + 1;
    setText(next);
    requestAnimationFrame(() => {
      inputRef.current?.setSelectionRange(pos, pos);
      inputRef.current?.focus();
    });
  };
  const submit = (query: string, range = props.range) => {
    rememberQuery(query);
    setSugg(null);
    props.onSubmit(query, range);
  };
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
            ref={inputRef}
            value={text}
            placeholder={t('q.placeholder')}
            onInput={(e) => {
              setText(e.currentTarget.value);
              suggest(e.currentTarget.value, e.currentTarget.selectionStart ?? e.currentTarget.value.length);
            }}
            onFocus={(e) => suggest(e.currentTarget.value, e.currentTarget.selectionStart ?? e.currentTarget.value.length)}
            onBlur={() => setSugg(null)}
            onKeyDown={(e) => {
              if (sugg) {
                if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                  e.preventDefault();
                  setSel((sel + (e.key === 'ArrowDown' ? 1 : sugg.items.length - 1)) % sugg.items.length);
                  return;
                }
                if (e.key === 'Tab' || (e.key === 'Enter' && sugg.kind === 'history')) {
                  e.preventDefault();
                  apply(sugg.items[sel]);
                  return;
                }
                if (e.key === 'Escape') {
                  setSugg(null);
                  return;
                }
              }
              if (e.key === 'Enter') submit(text);
            }}
            spellcheck={false}
            autocomplete="off"
          />
          {sugg && (
            <div class="suggest" role="listbox">
              {sugg.items.map((item, i) => (
                <div
                  key={item}
                  class={'item' + (i === sel ? ' active' : '')}
                  role="option"
                  aria-selected={i === sel}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    apply(item);
                  }}
                >
                  {sugg.kind === 'history' ? <span class="subdued">↺ </span> : ''}
                  {item}
                </div>
              ))}
            </div>
          )}
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
                <tr>
                  <td>@timestamp:[now-1d/d TO now/d]</td>
                  <td>{t('q.help.datemath')}</td>
                </tr>
              </tbody>
            </table>
            <p class="hint">{tx('q.helpNote', { enter: <kbd>Enter</kbd> })}</p>
            <p class="hint">{tx('q.completeNote', { tab: <kbd>Tab</kbd> })}</p>
          </Popover>
        </div>
        <TimePicker range={props.range} onChange={(r) => submit(text, r)} />
        <button class="btn primary" onClick={() => submit(text)} disabled={props.busy}>
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
