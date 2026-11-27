import test from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { PDFDocument } from "pdf-lib";
import ExcelJS from "exceljs";
test("file manager approvals, direct file authorization, retry idempotency and collection isolation", async () => {
  const db = await PGlite.create(),
    socket = new PGLiteSocketServer({ db, host: "127.0.0.1", port: 0 });
  await socket.start();
  Object.assign(process.env, {
    NODE_ENV: "test",
    DATABASE_URL: `postgresql://test:test@127.0.0.1:${socket.getServerConn().split(":").at(-1)}/test`,
    DB_SSL_MODE: "disable",
    DB_POOL_MAX: "1",
    SESSION_SECRET:
      "case-team-test-secret-0123456789-abcdefghijklmnopqrstuvwxyz",
    APP_ENCRYPTION_KEY: "a".repeat(64),
    APP_ORIGIN: "http://localhost:8080",
    DROPBOX_REDIRECT_URI:
      "http://localhost:8080/api/integrations/dropbox/callback",
    SMTP_ENABLED: "true",
    SMTP_HOST: "smtp.invalid",
    SMTP_USER: "test",
    SMTP_PASSWORD: "test",
    MAIL_FROM: "test@example.invalid",
  });
  const { pool, transaction } = await import("../src/config/database.js"),
    { migrate } = await import("../scripts/migrate.js"),
    { findUser } = await import("../src/models/user.model.js"),
    { createUserRecord } =
      await import("../src/controllers/auth.controller.js"),
    { saveCase } = await import("../src/controllers/cases.controller.js"),
    { assign } = await import("../src/controllers/case-team.controller.js"),
    { exportCases } =
      await import("../src/controllers/case-export.controller.js"),
    { workspace } = await import("../src/models/workspace.model.js"),
    { accessibleCase } = await import("../src/models/case.model.js"),
    { canMessage } = await import("../src/services/access.service.js");
  const response = () => ({
    value: null,
    type() {
      return this;
    },
    set() {
      return this;
    },
    json(v) {
      this.value = v;
      return this;
    },
    send(v) {
      this.value = v;
      return this;
    },
  });
  const nativeFetch = globalThis.fetch;
  try {
    await migrate();
    async function user(username, role, managerId) {
      return createUserRecord(
        {
          name: username,
          email: username + "@test.invalid",
          username,
          password: "Test-password-12345",
          role,
          managerId,
          address: "Test",
        },
        { id: null, role: "owner" },
      );
    }
    const owner = await user("owner", "owner"),
      manager = await user("manager", "manager"),
      staff = await user("staff", "staff", manager.id),
      extraManager = await user("extraManager", "manager"),
      extra = await user("extraStaff", "staff", extraManager.id),
      stranger = await user("stranger", "staff", manager.id),
      customer = await user("customer", "customer");
    const actor = await findUser(owner.id),
      member = await findUser(extra.id),
      managerActor = await findUser(extraManager.id),
      customerActor = await findUser(customer.id);
    const record = (id) => ({
      id,
      number: id,
      title: id,
      clientId: customerActor.client_id,
      staffId: staff.id,
      managerId: manager.id,
      residentName: "Tenant " + id,
      residentAddress: "Test address",
      status: "Pending",
      priority: "Medium",
      type: "Eviction Notice",
      moneyOwed: 1500,
      instructions: "INTERNAL-SECRET",
    });
    for (const id of ["case-one", "case-two"])
      await transaction((c) => saveCase(c, actor, record(id)));

    const { upload, authorizeDocument } =
      await import("../src/controllers/documents.controller.js");
    const fm = await import("../src/controllers/file-manager.controller.js");
    const { image } =
      await import("../src/services/single-case-report.service.js");
    const sql = await (
      await import("node:fs/promises")
    ).readFile(
      new URL("../scripts/sql/file-manager-update.sql", import.meta.url),
      "utf8",
    );
    await pool.query(sql);
    await pool.query(sql);
    const response = () => ({
      value: null,
      status() {
        return this;
      },
      json(v) {
        this.value = v;
        return this;
      },
    });
    const office = await findUser(manager.id),
      field = await findUser(staff.id);
    const remote = new Map();
    let disconnect = false;
    Object.assign(process.env, {});
    // Use a persisted OAuth grant and mocked Dropbox only; no external storage is contacted.
    const { env } = await import("../src/config/env.js");
    env.DROPBOX_APP_KEY = "test-key";
    env.DROPBOX_APP_SECRET = "test-secret";
    env.DROPBOX_REFRESH_TOKEN = "test-refresh";
    globalThis.fetch = async (url, options = {}) => {
      if (!String(url).includes("dropbox")) return nativeFetch(url, options);
      if (String(url).includes("/oauth2/token"))
        return Response.json({ access_token: "token", expires_in: 3600 });
      const arg = JSON.parse(
        options.headers?.["Dropbox-API-Arg"] || options.body || "{}",
      );
      if (String(url).endsWith("/files/upload")) {
        remote.set(arg.path, Buffer.from(options.body));
        if (disconnect) {
          disconnect = false;
          throw new Error("connection lost after upload");
        }
        return Response.json({ id: "remote-file" });
      }
      if (String(url).endsWith("/files/delete_v2")) {
        remote.delete(arg.path);
        return Response.json({ metadata: {} });
      }
      if (String(url).endsWith("/files/download")) {
        const bytes = remote.get(arg.path);
        return options.headers.Range
          ? new Response(bytes.subarray(0, 4), {
              status: 206,
              headers: {
                "Content-Range": `bytes 0-3/${bytes.length}`,
                "Content-Length": "4",
              },
            })
          : new Response(bytes);
      }
      throw new Error("Unexpected storage request");
    };
    const pdf = Buffer.from("%PDF-1.7\n%%EOF");
    const uploadFile = async (id, body = {}, buffer = pdf) => {
      const r = response();
      await upload(
        {
          user: field,
          body: { caseId: "case-one", collectionId: "writ", ...body },
          headers: { "x-upload-id": id },
          file: { originalname: "Writ.pdf", size: buffer.length, buffer },
        },
        r,
      );
      return r.value;
    };
    await assert.rejects(
      upload(
        {
          user: field,
          body: { caseId: "case-one" },
          headers: { "x-upload-user": actor.id },
          file: { originalname: "Writ.pdf", size: pdf.length, buffer: pdf },
        },
        response(),
      ),
      (e) => e.status === 403,
    );
    const pending = await uploadFile("pending-one");
    assert.equal(pending.approval, "pending");
    const reviewAlerts = async () =>
      (
        await pool.query(
          "SELECT * FROM legalflow.notifications WHERE kind='file-review' AND link LIKE '%collectionId=writ&%'",
        )
      ).rows;
    assert.deepEqual(
      (await reviewAlerts()).map((n) => n.user_id).sort(),
      [actor.id, office.id].sort(),
    );
    assert.match((await reviewAlerts())[0].text, /1 file awaiting approval/);
    const queue = response();
    await fm.reviewQueue({ user: office, query: {} }, queue);
    assert.equal(queue.value.totalFiles, 1);
    const unrelatedQueue = response();
    await fm.reviewQueue({ user: managerActor, query: {} }, unrelatedQueue);
    assert.equal(unrelatedQueue.value.totalFiles, 0);
    await assert.rejects(
      fm.reviewQueue({ user: customerActor, query: {} }, response()),
      (e) => e.status === 403,
    );
    await pool.query(
      "UPDATE legalflow.notifications SET read=true WHERE kind='file-review'",
    );
    await uploadFile("pending-one");
    assert((await reviewAlerts()).every((n) => n.read));
    await uploadFile("review-second");
    assert.equal((await reviewAlerts()).length, 2);
    assert((await reviewAlerts()).every((n) => !n.read));
    assert.match((await reviewAlerts())[0].text, /2 files awaiting approval/);

    assert.equal(
      (await workspace(customerActor)).cases[0].attachments.length,
      0,
    );
    await assert.rejects(
      authorizeDocument(customerActor, pending.id),
      (e) => e.status === 404,
    );
    const list = response();
    await fm.files(
      { user: customerActor, params: { id: "case-one" }, query: {} },
      list,
    );
    assert.equal(list.value.files.length, 0);
    const update = (user, file, action, extra = {}) =>
      fm.updateFiles(
        {
          user,
          body: {
            files: [{ id: file.id, updatedAt: file.updatedAt }],
            action,
            ...extra,
          },
        },
        response(),
      );
    await assert.rejects(
      update(field, pending, "approve"),
      (e) => e.status === 403,
    );
    await update(office, pending, "approve");
    assert.match((await reviewAlerts())[0].text, /1 file awaiting approval/);
    const second = (
      await pool.query(
        "SELECT * FROM legalflow.documents WHERE id='review-second'",
      )
    ).rows[0];
    await update(
      office,
      { id: second.id, updatedAt: second.updated_at.toISOString() },
      "reject",
    );
    assert.equal((await reviewAlerts()).length, 0);

    assert.equal(
      (await authorizeDocument(customerActor, pending.id)).approval,
      "approved",
    );
    assert.equal(
      (await workspace(customerActor)).cases.find((c) => c.id === "case-one")
        .attachments.length,
      1,
    );
    const doc = async (id) =>
      (await pool.query("SELECT * FROM legalflow.documents WHERE id=$1", [id]))
        .rows[0];
    const current = async (id) => ({
      id,
      updatedAt: (await doc(id)).updated_at.toISOString(),
    });
    const { content } =
      await import("../src/controllers/documents.controller.js");
    const server = (await import("node:http")).createServer((req, res) => {
      req.params = { id: pending.id };
      req.query = {};
      req.user = customerActor;
      res.status = function (code) {
        this.statusCode = code;
        return this;
      };
      void content(req, res).catch((e) => {
        res.statusCode = e.status || 500;
        res.end("Unavailable");
      });
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const r = await nativeFetch(`http://127.0.0.1:${server.address().port}`, {
        headers: { Range: "bytes=0-3" },
      });
      assert.equal(r.status, 206);
      assert.equal(r.headers.get("content-range"), `bytes 0-3/${pdf.length}`);
      assert.equal(await r.text(), "%PDF");
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
    await update(field, await current(pending.id), "rename", {
      name: "Updated Writ.pdf",
    });
    await assert.rejects(
      authorizeDocument(customerActor, pending.id),
      (e) => e.status === 404,
    );
    const groups = response();
    await fm.collections(
      { user: customerActor, params: { id: "case-one" } },
      groups,
    );
    assert.equal(
      groups.value.collections.find((c) => c.id === "writ").files,
      0,
    );
    await update(office, await current(pending.id), "approve");
    await update(field, await current(pending.id), "move", {
      collectionId: "tenant-ledger",
    });
    assert.equal((await doc(pending.id)).approval, "pending");
    await assert.rejects(
      fm.saveCollection(
        {
          user: field,
          params: { id: "new" },
          body: { name: "Other", section: "docs" },
        },
        response(),
      ),
      (e) => e.status === 403,
    );
    const created = response();
    await fm.saveCollection(
      {
        user: actor,
        params: { id: "new" },
        body: { name: "Owner custom collection", section: "docs" },
      },
      created,
    );
    assert(created.value.id);
    await assert.rejects(
      fm.removeCollection(
        { user: actor, params: { id: "tenant-ledger" } },
        response(),
      ),
      (e) => e.status === 409,
    );
    await assert.rejects(
      fm.removeCollection(
        { user: actor, params: { id: "vis-to" } },
        response(),
      ),
      (e) => e.status === 409,
    );
    await fm.removeCollection(
      { user: actor, params: { id: created.value.id } },
      response(),
    );
    // A lost upload response reuses the reservation and cannot create a duplicate.
    disconnect = true;
    await assert.rejects(uploadFile("retry-one"));
    assert.equal((await doc("retry-one")).state, "uploading");
    const retried = await uploadFile("retry-one");
    assert.equal(retried.approval, "pending");
    assert.equal((await doc("retry-one")).state, "ready");
    await uploadFile("retry-one");
    assert.equal(
      (
        await pool.query(
          "SELECT count(*)::int AS n FROM legalflow.documents WHERE id='retry-one'",
        )
      ).rows[0].n,
      1,
    );
    await assert.rejects(
      uploadFile("retry-one", {}, Buffer.from("%PDF-1.7\nDIFFERENT")),
      (e) => e.status === 409,
    );
    await update(office, await current("retry-one"), "approve");
    const old = await current("retry-one");
    await uploadFile("replacement-one", {
      replaceId: "retry-one",
      updatedAt: old.updatedAt,
    });
    assert.equal(await doc("retry-one"), undefined);
    assert.equal((await doc("replacement-one")).approval, "pending");
    // A hidden image cannot be used to bypass approval through a PDF cover.
    await pool.query(
      "UPDATE legalflow.documents SET mime='image/png' WHERE id='replacement-one'",
    );
    await assert.rejects(
      image("replacement-one", "case-one", customerActor),
      (e) => e.status === 422,
    );
    const folderResults = response();
    await fm.folders(
      { user: customerActor, query: { q: "case-one" } },
      folderResults,
    );
    assert.equal(folderResults.value.folders.length, 1);
    assert.equal(folderResults.value.folders[0].files, 0);
    await assert.rejects(
      fm.files(
        {
          user: await findUser(stranger.id),
          params: { id: "case-one" },
          query: {},
        },
        response(),
      ),
      (e) => e.status === 404,
    );
    const oldVersion = await current("pending-one");
    await pool.query(
      "UPDATE legalflow.documents SET updated_at=updated_at+interval '1 second' WHERE id='pending-one'",
    );
    await assert.rejects(
      update(office, oldVersion, "approve"),
      (e) => e.status === 409,
    );
    await pool.query(
      "INSERT INTO legalflow.documents(id,case_id,name,mime,bytes,kind,dropbox_path,uploaded_by,state,collection_id) SELECT 'bulk-'||n,'case-one','Photo '||n||'.jpg','image/jpeg',12,'image','/fixture/'||n,$1,'ready','vis-to' FROM generate_series(1,1002) n",
      [field.id],
    );
    const first = response();
    await fm.files(
      {
        user: customerActor,
        params: { id: "case-one" },
        query: { collectionId: "vis-to" },
      },
      first,
    );
    assert.equal(first.value.files.length, 50);
    assert.equal(first.value.hasMore, true);
    const last = response();
    await fm.files(
      {
        user: customerActor,
        params: { id: "case-one" },
        query: { collectionId: "vis-to", offset: 1000, kind: "image" },
      },
      last,
    );
    assert.equal(last.value.files.length, 2);
    assert.equal(last.value.hasMore, false);
    const snapshot = (await workspace(customerActor)).cases.find(
      (c) => c.id === "case-one",
    );
    assert.equal(snapshot.attachmentsCount, 1002);
    assert.equal(snapshot.attachments.length, 1000);
    await pool.query("UPDATE legalflow.cases SET manager_id=$2 WHERE id=$1",['case-one',managerActor.id]);
    assert.equal((await workspace(office)).notifications.filter(n=>n.kind==='file-review').length,0);

  } finally {
    globalThis.fetch = nativeFetch;
    await pool.end();
    await socket.stop();
    await db.close();
  }
});
