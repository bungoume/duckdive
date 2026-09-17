import { useState } from 'preact/hooks';
import { formatDate } from '../datefmt';
import { t } from '../i18n';
import { newId } from '../sql';
import { loadSavedSearches, storeSavedSearches, type DiscoverState, type SavedSearch, type SearchState } from '../state';
import { Popover } from './ui';

/** "Saved" on the Discover page: keep the query, filters, columns and sort under a name; load one back. */
export function SavedSearches(props: { search: SearchState; discover: DiscoverState; onLoad: (s: SavedSearch) => void }) {
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<SavedSearch[]>(() => loadSavedSearches());
  const [title, setTitle] = useState('');

  const update = (next: SavedSearch[]) => {
    setList(next);
    storeSavedSearches(next);
  };
  const save = () => {
    const name = title.trim() || props.search.query.trim() || t('disc.saved.untitled', { n: list.length + 1 });
    const existing = list.find((s) => s.title === name);
    const item: SavedSearch = { id: existing?.id ?? newId(), title: name, savedAt: new Date().toISOString(), search: props.search, discover: props.discover };
    update(existing ? list.map((s) => (s.id === existing.id ? item : s)) : [...list, item]);
    setTitle('');
  };

  return (
    <Popover
      open={open}
      onClose={() => setOpen(false)}
      align="right"
      width={360}
      button={
        <button class="sql-toggle" onClick={() => setOpen(!open)}>
          {t('disc.saved')}
        </button>
      }
    >
      <h4>{t('disc.saved')}</h4>
      <div class="row mb8">
        <input
          class="input"
          placeholder={t('disc.saved.placeholder')}
          value={title}
          onInput={(e) => setTitle(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') save();
          }}
        />
        <button class="btn primary small" onClick={save}>
          {t('common.save')}
        </button>
      </div>
      {list.length === 0 && <div class="hint">{t('disc.saved.none')}</div>}
      <div class="saved-list">
        {list.map((s) => (
          <div key={s.id} class="item">
            <span
              class="t"
              role="button"
              tabIndex={0}
              title={`${s.search.query || '*'} · ${formatDate(new Date(s.savedAt))}`}
              onClick={() => {
                props.onLoad(s);
                setOpen(false);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  props.onLoad(s);
                  setOpen(false);
                }
              }}
            >
              {s.title}
            </span>
            <button class="btn ghost small danger" onClick={() => update(list.filter((x) => x.id !== s.id))} title={t('common.delete')} aria-label={t('common.delete')}>
              ✕
            </button>
          </div>
        ))}
      </div>
    </Popover>
  );
}
