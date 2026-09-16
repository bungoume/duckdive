# Duckdive Privacy Policy

_Last updated: 2026-09-14_

Duckdive is a Chrome extension that searches and visualizes log files stored in Amazon S3 (or S3-compatible / HTTPS storage) entirely inside your browser. This policy explains what data the extension handles and where it goes.

## Summary

- Duckdive has **no server**. The extension talks only to the storage endpoints you configure and, if you enable sign-in, to your identity provider and AWS STS.
- The developer does not receive, collect, or have access to any of your data, credentials, queries, or usage information.
- No analytics, telemetry, crash reporting, or advertising code is included.

## Data the extension handles

| Data                                                                                               | Where it is stored                                                                          | Sent to                                                                                    |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Log data read from your storage                                                                    | Memory and, when the cache is enabled, a private storage area of the browser on your device | Nowhere. It is read directly from the endpoint you configured and never leaves the browser |
| Data source settings (URLs, region, field names, format, identity provider settings, IAM role ARN) | The extension's `localStorage` on your device                                               | Nowhere                                                                                    |
| Static AWS access keys, if you choose the "static keys" mode                                       | The extension's `localStorage` on your device                                               | Only to the S3 endpoint you configured, as request signatures                              |
| Temporary AWS credentials obtained via sign-in                                                     | `chrome.storage.session` (memory only, cleared when the browser closes)                     | Only to the S3 endpoint you configured, as request signatures                              |
| OpenID Connect ID token obtained via sign-in                                                       | Memory, for the duration of one STS call                                                    | AWS STS (`AssumeRoleWithWebIdentity`) at the endpoint you configured                       |
| Your queries and filters                                                                           | The page URL and `localStorage` on your device                                              | Nowhere; they are executed on your device                                                  |

## Permissions

- **storage / unlimitedStorage** — keep your settings and the local range cache of log files on your device. Log files can be large, so the default storage quota is not enough.
- **identity** — open your identity provider's sign-in page (`chrome.identity.launchWebAuthFlow`) so the extension can exchange the resulting ID token for temporary AWS credentials. No Google account data is requested beyond what your identity provider returns in the ID token.
- **Host permission for `*.amazonaws.com`** — read objects from S3 and call STS.
- **Optional host permissions** — when you enter a URL that is not on `amazonaws.com` (for example an S3-compatible service, a CDN, or a local server), the extension asks for access to that specific origin at that moment. You can revoke it from the Data source page or from Chrome's extension settings.

## Third parties

The extension makes network requests only to:

- the storage endpoints you configure (Amazon S3 or any URL you enter);
- your identity provider and AWS STS, only if you enable the sign-in mode.

The developer operates none of these services and has no visibility into the requests.

## Data retention and deletion

Everything is stored on your device. "Clear cache" on the Data source page deletes the local range cache; removing the extension deletes all of its storage.

## Changes

Updates to this policy are published in this repository. The date at the top reflects the latest revision.

## Contact

Open an issue at <https://github.com/bungoume/duckdive/issues>.

---

## 日本語要約

- Duckdive にサーバはありません。拡張が通信するのは、利用者が設定したストレージのエンドポイントと、サインインを有効にした場合の IdP と AWS STS だけです。
- 開発者は利用者のデータ、認証情報、クエリ、利用状況を一切受け取りません。解析・テレメトリ・広告のコードは含まれていません。
- ログデータはメモリと端末内のブラウザ専用領域(キャッシュ)にのみ保存され、外部に送信されません。
- 設定と静的アクセスキーは拡張の `localStorage` に、サインインで得た一時キーは `chrome.storage.session`(メモリのみ)に保存されます。
- `amazonaws.com` 以外の URL を入力した場合は、そのオリジンへのアクセス権限をその場で求めます。権限は Data source ページや Chrome の拡張設定から取り消せます。
- 「Clear cache」でキャッシュを削除でき、拡張を削除するとすべての保存データが消えます。
