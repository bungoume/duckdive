import { useEffect, useState } from 'preact/hooks';
import { t } from '../../i18n';
import { isExtension, listGrantedOrigins, removeOrigin } from '../../permissions';

/** Host permissions granted at runtime, with a Revoke button for everything but AWS. `refreshKey` reloads the list. */
export function HostsCard(props: { refreshKey: unknown }) {
  const [granted, setGranted] = useState<string[]>([]);
  useEffect(() => {
    listGrantedOrigins().then(setGranted);
  }, [props.refreshKey]);
  if (!isExtension || !granted.length) return null;
  return (
    <div class="card">
      <h2>{t('ds.hosts.title')}</h2>
      <p class="hint" style="margin-top:-6px">
        {t('ds.hosts.hint')}
      </p>
      <table class="kv">
        <tbody>
          {granted.map((g) => (
            <tr>
              <td class="v">{g}</td>
              <td class="a" style="visibility:visible">
                {!/amazonaws\.com/.test(g) && (
                  <button
                    class="btn small"
                    style="visibility:visible;width:auto;height:auto;padding:2px 8px"
                    onClick={async () => {
                      await removeOrigin(g);
                      setGranted(await listGrantedOrigins());
                    }}
                  >
                    {t('ds.hosts.revoke')}
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
