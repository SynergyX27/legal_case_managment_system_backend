import { assert } from "../utils/errors.js";
import { profileFor, eligiblePermission } from "./role-profiles.js";
import { isSuper, can } from "./access.service.js";
export function validateProfile(actor, data, old) {
  const id =
    data.roleProfile ??
    (old?.role === data.role ? old?.role_profile : undefined);
  const profile = profileFor(id);
  assert(
    (!id && data.role === "owner") ||
      id === "super_admin" ||
      data.permissions?.["permissions.manage"] !== true,
    422,
    "Permission administration is reserved for Super Admin",
  );
  if (actor?.role_profile && actor.role_profile !== "admin" && data.permissions)
    assert(
      can(actor, "permissions.manage"),
      403,
      "Permission management is restricted to Super Admin",
    );
  assert(!id || profile, 422, "Unknown role preset");
  if (id !== "super_admin" && data.role !== "owner")
    assert(
      !data.permissions ||
        Object.entries(data.permissions).every(
          ([k, v]) => !v || eligiblePermission(data.role, k),
        ),
      422,
      "This permission requires an administrative or supervisory role",
    );
  assert(
    !profile || profile.baseRole === data.role,
    422,
    "Role preset does not match its assignment type",
  );
  assert(
    data.role !== "customer" || !id,
    422,
    "Customer portal access is managed separately",
  );
  if (!isSuper(actor)) {
    assert(
      can(actor, "users.manage"),
      403,
      "User management permission required",
    );
    assert(
      data.role !== "owner" && old?.role !== "owner",
      403,
      "Only Super Admin can manage owner accounts",
    );
    assert(
      !data.permissions ||
        Object.entries(data.permissions).every(
          ([k, v]) =>
            v !== true ||
            (profile?.defaults[k] ?? old?.role_permissions?.[k]) === true,
        ),
      403,
      "Admin can remove permissions but cannot grant privileges beyond the role preset",
    );
  }
  assert(
    !profile ||
      profile.id !== "super_admin" ||
      !data.permissions ||
      Object.keys(data.permissions).length === 0,
    422,
    "Super Admin permissions cannot be restricted",
  );
  return id || null;
}
