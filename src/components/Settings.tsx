import { useEffect, useRef, useState } from 'preact/hooks';
import { makeBackup, parseBackup, restoreBackup } from '../backup';
import { describeError } from '../errors';
import { downloadBlob } from '../export';
import { LANGS, setLang, t, useLang, type Lang } from '../i18n';
import { parseDateMath } from '../datemath';
import { browserZone, formatDate, isValidTimeZone, parseIsoDuration } from '../datefmt';
import { DEFAULT_SETTINGS, getSettings, resetSettings, updateSettings, useSettings, type AppSettings, type QuickRange } from '../settings';
import { FormField } from './ui';

const zoneNames = (): string[] => {
  try {
    return (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.('timeZone') ?? [];
  } catch {
    return [];
  }
};

/** Weekday names in the UI language (0 = Sunday). */
function weekdayNames(lang: Lang): string[] {
  const locale = LANGS.find((l) => l.id === lang)?.html ?? 'en';
  const f = new Intl.DateTimeFormat(locale, { weekday: 'long', timeZone: 'UTC' });
  return Array.from({ length: 7 }, (_, i) => f.format(new Date(Date.UTC(2024, 0, 7 + i))));
}

interface Draft {
  dateFormat: string;
  timeZone: string;
  scaled: string;
  quick: string;
}

const draftOf = (s: AppSettings): Draft => ({
  dateFormat: s.dateFormat,
  timeZone: s.timeZone,
  scaled: JSON.stringify(s.scaledDateFormat, null, 2),
  quick: JSON.stringify(s.quickRanges, null, 2),
});

type Errors = Partial<Record<keyof Draft, string>>;

/** Validate the text fields; returns the settings to store, or the per-field errors. */
function parseDraft(d: Draft): { ok: true; value: Partial<AppSettings> } | { ok: false; errors: Errors } {
  const errors: Errors = {};
  const value: Partial<AppSettings> = {};
  if (!d.dateFormat.trim()) errors.dateFormat = t('settings.error.empty');
  else value.dateFormat = d.dateFormat;
  const tz = d.timeZone.trim();
  if (tz && !isValidTimeZone(tz)) errors.timeZone = t('settings.error.tz', { value: tz });
  else value.timeZone = tz;
  try {
    const arr = JSON.parse(d.scaled);
    const good =
      Array.isArray(arr) &&
      arr.length > 0 &&
      arr.every((e) => Array.isArray(e) && e.length === 2 && typeof e[0] === 'string' && typeof e[1] === 'string' && parseIsoDuration(e[0]) !== null && e[1].trim());
    if (!good) errors.scaled = t('settings.error.scaled');
    else value.scaledDateFormat = arr as [string, string][];
  } catch (e) {
    errors.scaled = t('settings.error.json', { error: (e as Error).message });
  }
  try {
    const arr = JSON.parse(d.quick);
    if (!Array.isArray(arr) || !arr.length) errors.quick = t('settings.error.range', { value: d.quick.slice(0, 40) });
    else {
      const out: QuickRange[] = [];
      for (const q of arr) {
        const okShape = q && typeof q === 'object' && typeof q.from === 'string' && typeof q.to === 'string' && (q.display === undefined || typeof q.display === 'string');
        if (!okShape || !parseDateMath(q.from) || !parseDateMath(q.to, true)) {
          errors.quick = t('settings.error.range', { value: JSON.stringify(q) });
          break;
        }
        out.push({ from: q.from, to: q.to, ...(q.display ? { display: q.display } : {}) });
      }
      if (!errors.quick) value.quickRanges = out;
    }
  } catch (e) {
    errors.quick = t('settings.error.json', { error: (e as Error).message });
  }
  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, value };
}

/** Settings page: preferences that are not tied to a data source. */
export function Settings() {
  const lang = useLang();
  const settings = useSettings();
  const [draft, setDraft] = useState<Draft>(() => draftOf(getSettings()));
  const [errors, setErrors] = useState<Errors>({});
  const [saved, setSaved] = useState(false);
  // a reset (or a change from elsewhere) refreshes the form
  useEffect(() => {
    setDraft(draftOf(settings));
    setErrors({});
  }, [settings]);
  const set = (p: Partial<Draft>) => {
    setDraft({ ...draft, ...p });
    setSaved(false);
  };
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  const previewZone = draft.timeZone.trim() && isValidTimeZone(draft.timeZone.trim()) ? draft.timeZone.trim() : browserZone();
  const preview = draft.dateFormat.trim() ? formatDate(now, draft.dateFormat, previewZone) : '';
  const dirty = JSON.stringify(draft) !== JSON.stringify(draftOf(settings));

  const save = () => {
    const r = parseDraft(draft);
    if (!r.ok) {
      setErrors(r.errors);
      return;
    }
    setErrors({});
    updateSettings(r.value);
    setSaved(true);
  };
  const days = weekdayNames(lang);

  const fileRef = useRef<HTMLInputElement>(null);
  const [restoreMsg, setRestoreMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const download = () => {
    const b = makeBackup();
    downloadBlob(new Blob([JSON.stringify(b, null, 2)], { type: 'application/json' }), `duckdive-backup-${b.exportedAt.slice(0, 10)}.json`);
  };
  const restore = async (file: File | undefined) => {
    if (!file) return;
    try {
      const n = restoreBackup(parseBackup(await file.text()));
      setRestoreMsg({ ok: true, text: t('settings.backup.restored', { n }) });
      // everything reads localStorage at start-up: start over
      setTimeout(() => location.reload(), 800);
    } catch (e) {
      setRestoreMsg({ ok: false, text: t('settings.backup.invalid', { error: describeError(e) }) });
    }
  };

  return (
    <div class="source-page settings-page">
      <div class="card">
        <h2>{t('settings.title')}</h2>
        <FormField label={t('settings.lang')} style="max-width:320px">
          <select class="input lang-select" value={lang} onChange={(e) => setLang(e.currentTarget.value as Lang)}>
            {LANGS.map((l) => (
              <option value={l.id}>{l.label}</option>
            ))}
          </select>
          <span class="hint">{t('settings.lang.hint')}</span>
        </FormField>
        <FormField label={t('settings.theme')} style="max-width:320px">
          <select class="input theme-select" value={settings.theme} onChange={(e) => updateSettings({ theme: e.currentTarget.value as AppSettings['theme'] })}>
            <option value="system">{t('settings.theme.system')}</option>
            <option value="light">{t('settings.theme.light')}</option>
            <option value="dark">{t('settings.theme.dark')}</option>
          </select>
        </FormField>
      </div>

      <div class="card">
        <h2>{t('settings.section.time')}</h2>
        <div class="grid2">
          <FormField label={t('settings.dateFormat')}>
            <input class="input mono" value={draft.dateFormat} onInput={(e) => set({ dateFormat: e.currentTarget.value })} placeholder={DEFAULT_SETTINGS.dateFormat} />
            {errors.dateFormat && <span class="hint error-text">{errors.dateFormat}</span>}
            <span class="hint">{t('settings.dateFormat.hint')}</span>
            {preview && <span class="hint mono">{t('settings.preview', { value: preview })}</span>}
          </FormField>
          <FormField label={t('settings.timeZone')}>
            <input class="input mono" list="ddv-timezones" value={draft.timeZone} onInput={(e) => set({ timeZone: e.currentTarget.value })} placeholder={browserZone()} />
            <datalist id="ddv-timezones">
              {zoneNames().map((z) => (
                <option value={z} />
              ))}
            </datalist>
            {errors.timeZone && <span class="hint error-text">{errors.timeZone}</span>}
            <span class="hint">{t('settings.timeZone.hint', { browser: browserZone() })}</span>
          </FormField>
          <FormField label={t('settings.dow')}>
            <select class="input" value={settings.dayOfWeek} onChange={(e) => updateSettings({ dayOfWeek: Number(e.currentTarget.value) })}>
              {days.map((name, i) => (
                <option value={i}>{name}</option>
              ))}
            </select>
            <span class="hint">{t('settings.dow.hint')}</span>
          </FormField>
        </div>
        <FormField label={t('settings.scaled')}>
          <textarea class="input mono settings-json" value={draft.scaled} onInput={(e) => set({ scaled: e.currentTarget.value })} spellcheck={false} />
          {errors.scaled && <span class="hint error-text">{errors.scaled}</span>}
          <span class="hint">{t('settings.scaled.hint')}</span>
        </FormField>
        <FormField label={t('settings.quickRanges')}>
          <textarea class="input mono settings-json" value={draft.quick} onInput={(e) => set({ quick: e.currentTarget.value })} spellcheck={false} />
          {errors.quick && <span class="hint error-text">{errors.quick}</span>}
          <span class="hint">{t('settings.quickRanges.hint')}</span>
        </FormField>
        <div class="row end" style="gap:10px;align-items:center">
          {saved && !dirty && <span class="hint">{t('settings.saved')}</span>}
          <button class="btn" onClick={resetSettings}>
            {t('settings.reset')}
          </button>
          <button class="btn primary" disabled={!dirty} onClick={save}>
            {t('common.save')}
          </button>
        </div>
      </div>

      <div class="card backup">
        <h2>{t('settings.backup')}</h2>
        <p class="hint">{t('settings.backup.hint')}</p>
        {restoreMsg && <div class={'alert ' + (restoreMsg.ok ? 'ok' : 'error')}>{restoreMsg.text}</div>}
        <div class="row">
          <button class="btn" onClick={download}>
            {t('settings.backup.download')}
          </button>
          <button class="btn" onClick={() => fileRef.current?.click()}>
            {t('settings.backup.restore')}
          </button>
          <input ref={fileRef} type="file" accept=".json,application/json" class="backup-file" onChange={(e) => void restore(e.currentTarget.files?.[0])} />
        </div>
      </div>
    </div>
  );
}
