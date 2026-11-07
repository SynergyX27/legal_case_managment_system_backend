# LegalFlow API

JavaScript ESM, Node.js 22.12+, Express 5, PostgreSQL, private Dropbox storage.

See the root `README.md` for installation, owner creation, Dropbox authorization and Render deployment. `.env.example` documents every environment variable. No credentials or sample records are included.

- `src/routes`: HTTP endpoints and upload limits
- `src/controllers`: auth, users, cases, customers, invoices, calendar, preferences, messaging and document handlers
- `src/models`: database queries, workspace projections, case access and audit records
- `src/services`: access rules, password hashing and Dropbox OAuth/file operations
- `src/validators`: accepted request fields, types and size limits
- `src/middleware`: authentication, CSRF and database-backed sign-in throttling
- `src/config`: validated environment and PostgreSQL connection pool
- `migrations`: ordered SQL schema migrations
- `scripts`: migrations, first owner setup, interrupted file reconciliation and syntax checks
- `test`: security checks and HTTP integration tests using a disposable PostgreSQL-compatible engine

Use `npm ci`, `npm run migrate`, `npm run create-owner`, then `npm run dev`.

`npm test` creates an isolated in-memory PGlite PostgreSQL engine. It does not use your deployment database. Dropbox contract tests replace the provider transport inside the test process only; the application always uses the real Dropbox API.

The API uses a `legalflow` schema, so migrations do not reset or rename unrelated tables. Run migrations once as a deployment step, not concurrently in every server worker. SQL migrations are applied inside a transaction with an advisory lock.

All sessions are stored in PostgreSQL. Cookie credentials never enter browser storage. Origin and CSRF checks apply to mutations, including login, registration and uploads. Production cookies require HTTPS. API errors include a request ID and omit credentials, SQL and stack traces.

Uploaded files are limited by `MAX_FILE_MB` (25 MB by default, at most 100 MB). File signatures are checked. Supported types are PDF, JPEG/PNG/GIF/WebP/AVIF, MP4/MOV, Word, Excel, UTF-8 text and CSV. Content downloads recheck case/owner permissions and stream from Dropbox. Documents never get public shared links.

Upload and delete reservations remain durable across a process interruption. Run `node scripts/reconcile-documents.js` periodically to retry interrupted deletions and remove incomplete uploads older than one hour. Normal uploads use unique, stable IDs to avoid duplicates on retry.

Health endpoints: `GET /api/health/live`, `GET /api/health/ready`. The latter checks database availability and migration metadata. The owner can check/reconnect Dropbox in Settings.
