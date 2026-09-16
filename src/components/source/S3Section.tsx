import { useState } from 'preact/hooks';
import { redirectUrl, secondsUntilExpiry, signIn, storeCredentials, type AwsCredentials, type OidcConfig } from '../../auth';
import { t, tx } from '../../i18n';
import { isExtension } from '../../permissions';
import type { AuthMode, SourceConfig } from '../../state';

/** S3 connection settings: region, endpoint, URL style and how credentials are obtained. */
export function S3Section(props: { cfg: SourceConfig; creds: AwsCredentials | null; onChange: (patch: Partial<SourceConfig>) => void; onS3: (patch: Partial<SourceConfig['s3']>) => void; onOidc: (patch: Partial<OidcConfig>) => void; onCreds: (c: AwsCredentials | null) => void }) {
  const { cfg } = props;
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const doSignIn = async () => {
    setAuthBusy(true);
    setAuthError(null);
    try {
      props.onCreds(await signIn(cfg.oidc, true));
    } catch (e) {
      setAuthError(String(e));
    } finally {
      setAuthBusy(false);
    }
  };
  const expiresIn = props.creds ? Math.max(0, Math.round(secondsUntilExpiry(props.creds) / 60)) : 0;
  const input = (value: string, onInput: (v: string) => void, extra: Record<string, unknown> = {}) => <input class="input" value={value} onInput={(e) => onInput((e.target as HTMLInputElement).value)} {...extra} />;

  return (
    <div style="margin-top:8px">
      <h4 style="margin:8px 0 6px;font-size:13px">{t('ds.s3.title')}</h4>
      <div class="grid2">
        <div class="field-row">
          <label>{t('ds.s3.region')}</label>
          {input(cfg.s3.region, (v) => props.onS3({ region: v }))}
        </div>
        <div class="field-row">
          <label>{t('ds.s3.endpoint')}</label>
          {input(cfg.s3.endpoint, (v) => props.onS3({ endpoint: v }), { placeholder: 's3.ap-northeast-1.amazonaws.com' })}
        </div>
        <div class="field-row">
          <label>{t('ds.s3.urlStyle')}</label>
          <select class="input" value={cfg.s3.urlStyle} onChange={(e) => props.onS3({ urlStyle: (e.target as HTMLSelectElement).value as 'vhost' | 'path' })}>
            <option value="vhost">{t('ds.s3.vhost')}</option>
            <option value="path">{t('ds.s3.path')}</option>
          </select>
        </div>
        <div class="field-row">
          <label>{t('ds.s3.auth')}</label>
          <select class="input" value={cfg.authMode} onChange={(e) => props.onChange({ authMode: (e.target as HTMLSelectElement).value as AuthMode })}>
            <option value="oidc">{t('ds.auth.oidc')}</option>
            <option value="static">{t('ds.auth.static')}</option>
            <option value="none">{t('ds.auth.none')}</option>
          </select>
        </div>
      </div>

      {cfg.authMode === 'static' && (
        <>
          <h4 style="margin:12px 0 6px;font-size:13px">{t('ds.key.title')}</h4>
          <div class="alert info">{t('ds.key.warn')}</div>
          <div class="grid2">
            <div class="field-row">
              <label>{t('ds.key.id')}</label>
              {input(cfg.s3.accessKeyId, (v) => props.onS3({ accessKeyId: v }), { autocomplete: 'off' })}
            </div>
            <div class="field-row">
              <label>{t('ds.key.secret')}</label>
              {input(cfg.s3.secretAccessKey, (v) => props.onS3({ secretAccessKey: v }), { type: 'password', autocomplete: 'off' })}
            </div>
            <div class="field-row">
              <label>{t('ds.key.token')}</label>
              {input(cfg.s3.sessionToken, (v) => props.onS3({ sessionToken: v }), { type: 'password', autocomplete: 'off' })}
            </div>
          </div>
        </>
      )}

      {cfg.authMode === 'oidc' && (
        <>
          <h4 style="margin:12px 0 6px;font-size:13px">{t('ds.oidc.title')}</h4>
          <p class="hint" style="margin-top:0">
            {tx('ds.oidc.intro', { api: <code>AssumeRoleWithWebIdentity</code>, url: <code>{redirectUrl()}</code> })}
          </p>
          <div class="grid2">
            <div class="field-row">
              <label>{t('ds.oidc.authUrl')}</label>
              {input(cfg.oidc.authUrl, (v) => props.onOidc({ authUrl: v }), { placeholder: 'https://accounts.google.com/o/oauth2/v2/auth' })}
            </div>
            <div class="field-row">
              <label>{t('ds.oidc.clientId')}</label>
              {input(cfg.oidc.clientId, (v) => props.onOidc({ clientId: v }), { autocomplete: 'off' })}
            </div>
            <div class="field-row">
              <label>{t('ds.oidc.scope')}</label>
              {input(cfg.oidc.scope, (v) => props.onOidc({ scope: v }))}
            </div>
            <div class="field-row">
              <label>{t('ds.oidc.extra')}</label>
              {input(cfg.oidc.extraParams, (v) => props.onOidc({ extraParams: v }))}
            </div>
            <div class="field-row">
              <label>{t('ds.oidc.roleArn')}</label>
              {input(cfg.oidc.roleArn, (v) => props.onOidc({ roleArn: v }), { placeholder: 'arn:aws:iam::123456789012:role/duckdive-readonly' })}
            </div>
            <div class="field-row">
              <label>{t('ds.oidc.duration')}</label>
              <input class="input" type="number" value={cfg.oidc.durationSeconds} onInput={(e) => props.onOidc({ durationSeconds: Number((e.target as HTMLInputElement).value) || 3600 })} />
            </div>
            <div class="field-row">
              <label>{t('ds.oidc.stsEndpoint')}</label>
              {input(cfg.oidc.stsEndpoint, (v) => props.onOidc({ stsEndpoint: v }), { placeholder: `https://sts.${cfg.s3.region || 'ap-northeast-1'}.amazonaws.com/` })}
            </div>
          </div>
          <div class="row" style="margin-top:8px">
            <button class="btn" disabled={authBusy || !isExtension} onClick={doSignIn}>
              {authBusy ? t('ds.oidc.signingIn') : t('ds.oidc.signIn')}
            </button>
            {props.creds ? (
              <span class="hint">
                {t('ds.oidc.signedIn', { as: props.creds.subject ? t('ds.oidc.as', { subject: props.creds.subject }) : '', min: expiresIn })}
                <button
                  class="btn ghost small"
                  onClick={async () => {
                    await storeCredentials(null);
                    props.onCreds(null);
                  }}
                >
                  {t('ds.oidc.signOut')}
                </button>
              </span>
            ) : (
              <span class="hint">{t('ds.oidc.notSignedIn', { ext: isExtension ? '' : t('ds.oidc.extOnly') })}</span>
            )}
          </div>
          {authError && <div class="alert error" style="margin-top:8px">{authError}</div>}
        </>
      )}
    </div>
  );
}
