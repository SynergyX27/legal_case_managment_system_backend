import test from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { PDFDocument } from "pdf-lib";
import ExcelJS from "exceljs";
test("shared case teams enforce access, protect membership, export complete selected reports and revoke access", async () => {
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
      ownExtra = await user("extraOwn2", "staff", extraManager.id),
      protectedManager = await user("protectedManager", "manager"),
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
    const current = async (id) => {
      const r = (
        await pool.query("SELECT * FROM legalflow.cases WHERE id=$1", [id])
      ).rows[0];
      return { id, updatedAt: r.updated_at.toISOString() };
    };
    assert.equal((await workspace(member)).cases.length, 0);
    const version = await current("case-one");
    await assert.rejects(
      assign(
        { user: member, body: { cases: [version], memberIds: [extra.id] } },
        response(),
      ),
      (e) => e.status === 403,
    );
    await assign(
      {
        user: actor,
        body: { cases: [version], memberIds: [extra.id, extraManager.id] },
      },
      response(),
    );
    assert.equal((await workspace(member)).cases.length, 1);
    assert.equal((await workspace(managerActor)).cases.length, 1);
    const raw = await accessibleCase(member, "case-one");
    assert(canMessage(customerActor, member, [raw]));
    await assert.rejects(
      accessibleCase(await findUser(stranger.id), "case-one"),
      (e) => e.status === 404,
    );
    await assert.rejects(
      assign(
        { user: actor, body: { cases: [version], memberIds: [] } },
        response(),
      ),
      (e) => e.status === 409,
    );
    // A collaborator can edit existing case details but cannot inject/remove team IDs.
    await pool.query(
      "UPDATE legalflow.users SET permissions='{\"cases.edit\":true}' WHERE id=$1",
      [extra.id],
    );
    const editingVersion = await current("case-one");
    await transaction((c) =>
      saveCase(c, member, {
        ...record("case-one"),
        ...editingVersion,
        title: "Changed by collaborator",
        teamMemberIds: [stranger.id],
      }),
    );
    assert.deepEqual(
      (await accessibleCase(member, "case-one")).data.teamMemberIds,
      [extra.id, extraManager.id],
    );
    const before = await current("case-one");
    await assert.rejects(
      assign(
        {
          user: managerActor,
          body: {
            cases: [before, await current("case-two")],
            memberIds: [ownExtra.id],
            mode: "add",
          },
        },
        response(),
      ),
      (e) => e.status === 404,
    );
    assert.equal(
      (await accessibleCase(member, "case-one")).data.teamMemberIds.includes(
        stranger.id,
      ),
      false,
    );
    const { deleteUser } =
      await import("../src/controllers/users.controller.js");
    await assert.rejects(
      deleteUser(
        {
          user: actor,
          params: { id: extra.id },
          body: {
            updatedAt: (await findUser(extra.id)).updated_at.toISOString(),
          },
        },
        response(),
      ),
      (e) => e.status === 409,
    );
    await assign(
      {
        user: actor,
        body: {
          cases: [await current("case-one")],
          memberIds: [stranger.id, protectedManager.id],
          mode: "add",
        },
      },
      response(),
    );
    await assign(
      {
        user: managerActor,
        body: {
          cases: [await current("case-one")],
          memberIds: [ownExtra.id],
          mode: "add",
        },
      },
      response(),
    );
    assert.equal(
      (await accessibleCase(await findUser(ownExtra.id), "case-one")).staff_id,
      staff.id,
    );
    await assign(
      {
        user: managerActor,
        body: {
          cases: [await current("case-one")],
          memberIds: [extra.id],
        },
      },
      response(),
    );
    await assert.rejects(
      assign(
        {
          user: actor,
          body: {
            cases: [await current("case-one")],
            memberIds: [customer.id],
          },
        },
        response(),
      ),
      (e) => e.status === 422,
    );
    assert(
      (
        await accessibleCase(managerActor, "case-one")
      ).data.teamMemberIds.includes(extraManager.id),
    );
    await assert.rejects(
      assign(
        {
          user: managerActor,
          body: { cases: [await current("case-one")], memberIds: [manager.id] },
        },
        response(),
      ),
      (e) => e.status === 403,
    );
    await assert.rejects(
      assign(
        {
          user: managerActor,
          body: {
            cases: [await current("case-one")],
            memberIds: [stranger.id],
          },
        },
        response(),
      ),
      (e) => e.status === 403,
    );
    await pool.query(
      "UPDATE legalflow.users SET permissions='{\"cases.edit\":true}' WHERE id=$1",
      [managerActor.id],
    );
    const editVersion = await current("case-one");
    await assert.rejects(
      transaction((db) =>
        saveCase(db, managerActor, {
          ...record("case-one"),
          ...editVersion,
          staffId: extra.id,
          managerId: extraManager.id,
        }),
      ),
      (e) => e.status === 403,
    );
    const { bulkUpdate } =
      await import("../src/controllers/case-import.controller.js");
    await assert.rejects(
      bulkUpdate(
        {
          user: managerActor,
          body: {
            cases: [await current("case-one")],
            patch: { staffId: extra.id },
          },
        },
        response(),
      ),
      (e) => e.status === 403,
    );
    const pdf = response();
    await exportCases(
      {
        user: actor,
        body: { caseIds: ["case-one", "case-two"], format: "pdf" },
      },
      pdf,
    );
    await (
      await import("node:fs/promises")
    ).writeFile("/tmp/legalflow-team-report-preview.pdf", pdf.value);
    const merged = await PDFDocument.load(pdf.value);
    assert(merged.getPageCount() >= 4);
    const xlsx = response();
    await exportCases(
      {
        user: actor,
        body: { caseIds: ["case-one", "case-two"], format: "xlsx" },
      },
      xlsx,
    );
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(xlsx.value);
    assert.equal(book.worksheets[0].rowCount, 3);
    assert.equal(book.worksheets[0].getCell("S2").value, 1500);
    assert.match(book.worksheets[0].getCell("Y2").value, /extraStaff/);
    await assert.rejects(
      exportCases(
        {
          user: member,
          body: { caseIds: ["case-one", "case-two"], format: "pdf" },
        },
        response(),
      ),
      (e) => e.status === 404,
    );
    await exportCases(
      {
        user: actor,
        body: {
          caseIds: ["case-one", "case-two"],
          format: "pdf",
          to: "recipient@test.invalid",
        },
      },
      response(),
    );
    const mail = (
      await pool.query(
        "SELECT attachments FROM legalflow.email_outbox WHERE event_key LIKE 'case.export:%'",
      )
    ).rows[0];
    assert.equal(mail.attachments.length, 1);
    assert.equal(
      (
        await PDFDocument.load(
          Buffer.from(mail.attachments[0].content, "base64"),
        )
      ).getPageCount(),
      merged.getPageCount(),
    );
    await assign(
      {
        user: managerActor,
        body: { cases: [await current("case-one")], memberIds: [] },
      },
      response(),
    );
    const kept = await accessibleCase(managerActor, "case-one");
    assert.deepEqual(kept.data.teamMemberIds, [
      extraManager.id,
      stranger.id,
      protectedManager.id,
    ]);
    assert.equal(kept.staff_id, staff.id);
    assert.equal(kept.manager_id, manager.id);
    await assign(
      {
        user: actor,
        body: { cases: [await current("case-one")], memberIds: [] },
      },
      response(),
    );
    assert.equal((await workspace(member)).cases.length, 0);
    await assert.rejects(
      accessibleCase(member, "case-one"),
      (e) => e.status === 404,
    );
  } finally {
    await pool.end();
    await socket.stop();
    await db.close();
  }
});
