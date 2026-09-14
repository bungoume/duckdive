import { useEffect, useRef, useState } from 'preact/hooks';
import { Popover } from './ui';
import { TimePicker } from './TimePicker';
import type { TimeRange } from '../datemath';

export function QueryBar(props: {
  query: string;
  range: TimeRange;
  error: string | null;
  busy: boolean;
  onSubmit: (query: string, range: TimeRange) => void;
}) {
  const [text, setText] = useState(props.query);
  const [help, setHelp] = useState(false);
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
          <span style="color:#98a2b3">⌕</span>
          <input
            value={text}
            placeholder='Search (Lucene syntax): e.g. http.status:>=500 AND geo.country:JP  or  "connection reset"'
            onInput={(e) => setText((e.target as HTMLInputElement).value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') props.onSubmit(text, props.range);
            }}
            spellcheck={false}
            autocomplete="off"
          />
          <Popover open={help} onClose={() => setHelp(false)} align="right" width={520} button={<button class="lang" onClick={() => setHelp(!help)}>Syntax</button>}>
            <h4>Query syntax (Lucene)</h4>
            <table class="help-table">
              <tbody>
              <tr><td>error timeout</td><td>Free text: any searchable field contains one of the words (words are OR-ed)</td></tr>
              <tr><td>"connection reset"</td><td>Phrase (substring, case-insensitive). "a b"~3: all words in the same field</td></tr>
              <tr><td>http.status:503</td><td>Field matches value (numbers/booleans exact; strings token match)</td></tr>
              <tr><td>host.name:web-*</td><td>Wildcard: * any characters, ? one character</td></tr>
              <tr><td>path:/api\/v[12]\/.*/</td><td>Regular expression</td></tr>
              <tr><td>http.status:(500 OR 503)</td><td>List of values</td></tr>
              <tr><td>http.latency_ms:&gt;800</td><td>Range: :&gt; :&gt;= :&lt; :&lt;=</td></tr>
              <tr><td>http.bytes:[1000 TO 5000]</td><td>Bracket range (use {'{'}..{'}'} for exclusive, * for open)</td></tr>
              <tr><td>extra.user_id:*</td><td>Field exists (also _exists_:extra.user_id)</td></tr>
              <tr><td>NOT level:info / -level:info</td><td>Negation. +term: required</td></tr>
              <tr><td>a AND (b OR c)</td><td>Boolean operators AND, OR, NOT (upper case), &amp;&amp;, ||, !. Adjacent terms are OR-ed.</td></tr>
              </tbody>
            </table>
            <p class="hint">Nested struct / JSON fields use dot paths (geo.country, extra.user_id). Escape special characters with \ (path:\/api\/v1). Press <kbd>Enter</kbd> to run.</p>
          </Popover>
        </div>
        <TimePicker range={props.range} onChange={(r) => props.onSubmit(text, r)} />
        <button class="btn primary" onClick={() => props.onSubmit(text, props.range)} disabled={props.busy}>
          {props.busy ? 'Running…' : 'Refresh'}
        </button>
      </div>
      {props.error && <div class="qerror">{props.error}</div>}
    </div>
  );
}
