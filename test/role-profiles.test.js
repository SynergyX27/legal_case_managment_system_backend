import test from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
test("role presets, checkbox overrides, scope isolation and protected administration", async () => {
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
    { createUserRecord } =
      await import("../src/controllers/auth.controller.js"),
    { findUser } = await import("../src/models/user.model.js"),
    { workspace } = await import("../src/models/workspace.model.js"),
    { saveCase } = await import("../src/controllers/cases.controller.js"),
    { updateUser } = await import("../src/controllers/users.controller.js"),
    { updatePermissions } =
      await import("../src/controllers/permissions.controller.js"),
    { can } = await import("../src/services/access.service.js"),
    { permissionPolicy } = await import("../src/middleware/permissions.js"),
    { roleProfiles } = await import("../src/services/role-profiles.js");
  const res = {
    status() {
      return this;
    },
    json(v) {
      this.value = v;
      return this;
    },
  };
  try {
    await migrate();
    const make = async (name, role, actor, extra = {}) =>
      createUserRecord(
        {
          name,
          email: name + "@test.invalid",
          username: name,
          password: "Test-password-12345",
          role,
          ...extra,
        },
        actor,
      );
    const owner = await make("root", "owner", { role: "owner" });
    const manager = await make("boss", "manager", owner);
    const customer = await make("client", "customer", owner);
    const users = {};
    for (const p of roleProfiles) {
      users[p.id] = await make(p.id, p.baseRole, owner, {
        roleProfile: p.id,
        managerId: p.baseRole === "staff" ? manager.id : "",
      });
      assert.equal(users[p.id].role_profile, p.id);
    }
    const crew = users.crew_1;
    const row = {
      id: "role-case",
      number: "ROLE-1",
      title: "Role test",
      clientId: customer.client_id,
      staffId: crew.id,
      managerId: manager.id,
      residentName: "Tenant",
      residentAddress: "Test",
      status: "Pending",
      priority: "Medium",
      type: "Eviction",
      moneyOwed: 1400,
      notes: "LEGAL SECRET",
      court: "Court secret",
    };
    await transaction((db) => saveCase(db, owner, row));
    const { putInvoice } =
      await import("../src/controllers/invoices.controller.js");
    const invoice = {
      id: "roles-invoice",
      caseId: row.id,
      clientId: customer.client_id,
      date: "2026-11-27",
      dueDate: "2026-12-27",
      lines: [{ description: "Service", qty: 1, price: 100 }],
      taxRate: 0,
      status: "Sent",
    };
    await putInvoice(
      { user: owner, params: { id: invoice.id }, body: invoice },
      res,
    );
    const inv = (
      await pool.query("SELECT * FROM legalflow.invoices WHERE id=$1", [
        invoice.id,
      ])
    ).rows[0];
    await assert.rejects(
      putInvoice(
        {
          user: users.payment,
          params: { id: inv.id },
          body: {
            ...inv.data,
            lines: [{ ...inv.data.lines[0], price: 1 }],
            status: "Paid",
            updatedAt: inv.updated_at.toISOString(),
          },
        },
        res,
      ),
      (e) => e.status === 403,
    );
    await putInvoice(
      {
        user: users.payment,
        params: { id: inv.id },
        body: {
          ...inv.data,
          status: "Paid",
          updatedAt: inv.updated_at.toISOString(),
        },
      },
      res,
    );
    assert.equal(
      (
        await pool.query(
          "SELECT data->>'status' AS status FROM legalflow.invoices WHERE id=$1",
          [inv.id],
        )
      ).rows[0].status,
      "Paid",
    );
    const current = (
      await pool.query("SELECT * FROM legalflow.cases WHERE id=$1", [row.id])
    ).rows[0];
    await transaction((db) =>
      saveCase(db, crew, {
        ...row,
        status: "Active",
        updatedAt: current.updated_at.toISOString(),
      }),
    );
    const active = (
      await pool.query("SELECT * FROM legalflow.cases WHERE id=$1", [row.id])
    ).rows[0];
    assert.equal(active.data.moneyOwed, 1400);
    assert.equal(active.data.notes, "LEGAL SECRET");
    await assert.rejects(
      transaction((db) =>
        saveCase(db, crew, {
          ...row,
          status: "Completed",
          updatedAt: active.updated_at.toISOString(),
        }),
      ),
      (e) => e.status === 403,
    );
    await assert.rejects(
      transaction((db) =>
        saveCase(db, crew, {
          ...row,
          status: "Active",
          moneyOwed: 1,
          updatedAt: active.updated_at.toISOString(),
        }),
      ),
      (e) => e.status === 403,
    );
    assert.equal((await workspace(crew)).cases.length, 1);
    const payload = (await workspace(crew)).cases[0];
    assert.equal(payload.moneyOwed, undefined);
    assert.equal(payload.paidInvoiceTotal, undefined);
    assert.equal(payload.notes, undefined);
    assert.equal(payload.court, undefined);
    assert.equal((await workspace(users.crew_2)).cases.length, 0);
    assert.equal((await workspace(users.financials)).cases.length, 1);
    assert(can(users.payment, "payments.record"));
    assert(!can(users.payment, "invoices.edit"));
    assert(!can(users.financials, "payments.record"));
    assert.throws(
      () =>
        permissionPolicy(
          { user: crew, path: "/permissions/profile_manager", method: "PUT" },
          res,
          () => {},
        ),
      (e) => e.status === 403,
    );
    assert.throws(
      () =>
        permissionPolicy(
          { user: users.admin, path: "/email/status", method: "GET" },
          res,
          () => {},
        ),
      (e) => e.status === 403,
    );
    await assert.rejects(
      make("evil", "owner", users.admin, { roleProfile: "super_admin" }),
      (e) => e.status === 403,
    );
    await assert.rejects(
      make("public", "customer", null, {
        roleProfile: "super_admin",
        permissions: { "cases.view_all": true },
      }),
      (e) => e.status === 403,
    );
    const patch = async (person, body, actor = owner) =>
      updateUser(
        {
          user: actor,
          params: { id: person.id },
          body: {
            role: person.role,
            roleProfile: person.role_profile,
            status: "Active",
            managerId: person.manager_id || "",
            updatedAt: person.updated_at.toISOString(),
            ...body,
          },
        },
        res,
      );
    await patch(crew, { permissions: { "files.upload": false } });
    assert(!can(await findUser(crew.id), "files.upload"));
    assert(can(await findUser(crew.id), "cases.view"));
    const defaults = (await workspace(owner)).rolePermissions.find(
      (r) => r.role === "profile_crew_1",
    );
    assert(defaults);
    assert.equal(
      (await workspace(owner)).rolePermissions.filter(
        (r) => r.role === "profile_manager",
      ).length,
      1,
    );
    await updatePermissions(
      {
        user: owner,
        params: { role: "profile_crew_1" },
        body: {
          updatedAt: defaults.updatedAt,
          permissions: {
            ...defaults.permissions,
            "files.upload": true,
            "chat.use": false,
          },
        },
      },
      res,
    );
    const refreshed = await findUser(crew.id);
    assert(!can(refreshed, "files.upload"));
    assert(!can(refreshed, "chat.use"));
    await patch(refreshed, { permissions: {} });
    assert(can(await findUser(crew.id), "files.upload"));
    await patch(await findUser(users.financials.id), {
      permissions: { "cases.view": false },
    });
    assert.equal(
      (await workspace(await findUser(users.financials.id))).cases.length,
      0,
    );
    await assert.rejects(
      patch(owner, { roleProfile: "admin" }),
      (e) => e.status === 422,
    );
    await assert.rejects(
      patch(
        users.crew_2,
        { permissions: { "permissions.manage": true } },
        users.admin,
      ),
      (e) => [403, 422].includes(e.status),
    );
  } finally {
    await pool.end();
    await socket.stop();
    await db.close();
  }
});
