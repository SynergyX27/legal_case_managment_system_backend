// Presentation only: never changes authorization, validation or transaction behavior.
const fields = {
  name: "Name",
  email: "Email address",
  phone: "Phone number",
  username: "Username",
  password: "Password",
  clientId: "Customer",
  staffId: "Responsible staff",
  managerId: "Responsible manager",
  workspaceId: "Community",
  caseId: "Case",
  caseIds: "Included cases",
  residentName: "Tenant name",
  residentAddress: "Property address",
  serviceDate: "Service date",
  serviceTime: "Service time",
  moneyOwed: "Original balance",
  monthlyRent: "Monthly rent",
  unit: "Unit number",
  squareFeet: "Square feet",
  taxRate: "Tax rate",
  discount: "Discount",
  dueDate: "Due date",
  issuedDate: "Invoice date",
  items: "Invoice lines",
  qty: "Quantity",
  quantity: "Quantity",
  unitPrice: "Unit price",
  amount: "Amount",
  role: "Role",
  roleProfile: "Role preset",
  status: "Status",
  priority: "Priority",
  number: "Case number",
  title: "Title",
  ref: "Customer reference",
  state: "State",
  zip: "ZIP code",
  message: "Message",
  file: "File",
  folderId: "Folder",
  collectionId: "Collection",
  updatedAt: "This record",
  permissions: "Permissions",
};
export function validationFields(issues = []) {
  return issues.slice(0, 8).map((i) => {
    const path = i.path || [],
      key = path.at(-1),
      label = fields[key] || fields[path[0]] || "This field";
    let message;
    if (key === "username")
      message =
        "Use 3–64 letters, numbers, dots, underscores or hyphens. Do not use spaces, @, # or $.";
    else if (key === "email")
      message = "Enter a complete email address, for example name@example.com.";
    else if (key === "password")
      message = "Use a password with 10–128 characters.";
    else if (i.code === "too_small")
      message =
        i.type === "string"
          ? `Enter at least ${i.minimum} character(s).`
          : i.type === "array"
            ? `Select at least ${i.minimum} item(s).`
            : `Enter a value of ${i.minimum} or more.`;
    else if (i.code === "too_big")
      message =
        i.type === "string"
          ? `Use no more than ${i.maximum} characters.`
          : i.type === "array"
            ? `Select no more than ${i.maximum} items.`
            : `Enter a value of ${i.maximum} or less.`;
    else if (i.code === "invalid_enum_value")
      message = "Choose an available option from the dropdown.";
    else if (/Date$|^date$/.test(String(key)))
      message = "Choose a valid date using the date picker.";
    else if (key === "serviceTime")
      message = "Choose a valid time, for example 10:30.";
    else if (i.code === "invalid_type")
      message =
        i.received === "undefined" || i.received === "null"
          ? "Complete this required field."
          : i.expected === "number"
            ? "Enter a number in this field."
            : "Check this field and choose or enter a valid value.";
    else if (i.code === "unrecognized_keys")
      message =
        "Refresh this page and try saving again. If it continues, ask your administrator to update LegalFlow.";
    else
      message =
        typeof i.message === "string" &&
        !/^(Invalid|Expected|Required|Input)/i.test(i.message)
          ? i.message
          : "Check this field and enter a valid value.";
    return { field: path.join("."), label, message };
  });
}
export function userError(err, req, status) {
  const raw = String(err.message || ""),
    u = req.user,
    owner = u?.role === "owner",
    manager = u?.role === "manager",
    route = String(req.route?.path || req.path || "");
  const support = owner
    ? "If it continues, contact your LegalFlow support person and share the support reference."
    : "If it continues, contact your administrator and share the support reference.";
  const result = (code, title, reason, steps = []) => ({
    code,
    title,
    reason,
    steps:
      owner &&
      u.role_profile &&
      u.role_profile !== "super_admin" &&
      steps.some((s) =>
        /People & access|Workspaces|Settings|Assign team|Customers/.test(s),
      )
        ? [
            ...steps,
            "If the required screen or action is not available to your role, ask a Super Admin to make this change.",
          ]
        : steps,
  });
  if (err.type === "entity.parse.failed")
    return result(
      "CHECK_FORM",
      "Please reopen this form",
      "LegalFlow could not read the submitted information.",
      [
        "Refresh the page or reopen the form and enter the details again. If it continues, contact your administrator.",
      ],
    );
  if (status === 413 && err.code !== "LIMIT_FILE_SIZE")
    return result(
      "SELECTION_TOO_LARGE",
      "This selection is too large",
      "The selected files or information exceed the allowed limit.",
      ["Choose fewer files or cases, or reduce the file size, then try again."],
    );
  if (err.name === "ZodError") {
    const errors = validationFields(err.issues);
    return {
      ...result(
        "CHECK_FIELDS",
        "Please check the form",
        "Some information needs correcting.",
        errors.map((e) => `${e.label}: ${e.message}`),
      ),
      fieldErrors: errors,
    };
  }
  if (err.code === "LIMIT_FILE_SIZE")
    return result(
      "FILE_TOO_LARGE",
      "This file is too large",
      "It exceeds the upload limit.",
      [
        `Choose a smaller file (within the allowed size), or reduce its size before uploading. Do not keep retrying the same file.`,
      ],
    );
  if (err.name === "MulterError")
    return result(
      "UPLOAD_SELECTION",
      "Please check the upload",
      "The selected files could not be accepted.",
      [
        "Use Upload files to select supported files. If a batch fails, try one file at a time.",
      ],
    );
  if (err.code === "23505") {
    const c = String(err.constraint || "");
    const subject = /email/.test(c)
      ? "email address"
      : /username/.test(c)
        ? "username"
        : /ref_id/.test(c)
          ? "case reference"
          : /cases.*number/.test(c)
            ? "case number"
            : "name or reference";
    return result(
      "DUPLICATE_RECORD",
      "This information is already in use",
      `Another record uses this ${subject}.`,
      [
        `Search for the existing record before adding another. If it is a different record, use a different ${subject}.`,
      ],
    );
  }
  if (["23503", "23001"].includes(err.code)) {
    return result(
      "LINKED_RECORDS",
      "This item still has linked information",
      "It cannot be removed while other records depend on it.",
      [
        /users/.test(route)
          ? "Open the person’s assigned cases and reassign them first. Managers may also have staff who need a new manager."
          : /workspaces|company-folders/.test(route)
            ? "Open the workspace or folder and move or remove its contents before deleting it."
            : "Open the item and review its linked cases, invoices, files and conversations. Remove or reassign the links you are authorized to change.",
        support,
      ],
    );
  }
  if (/main login must have access/.test(raw))
    return result(
      "INVOICE_CUSTOMER_ACCESS",
      "The customer cannot receive this invoice yet",
      err.userContext?.caseNumber
        ? `The customer’s main account cannot access case ${err.userContext.caseNumber}${err.userContext.unassigned ? " because it is not assigned to a community" : ""}.`
        : "The customer’s main account cannot access one or more cases on this invoice.",
      owner
        ? [
            "Open each included case. If it says Unassigned workspace, select a community belonging to that customer and click Move case.",
            "Open Workspaces → Customer access → Manage access. Select the customer’s main login, allow the matching community, and save.",
            "Use All customer cases only if this main login is intended to see every case for its customer company.",
            "Return to the invoice and click Email PDF again. The earlier attempt did not send this email.",
          ]
        : [
            "Ask the owner to check the included cases and the main customer login under Workspaces → Customer access.",
            "After access is corrected, ask an authorized billing user to send the invoice again.",
          ],
    );
  if (/active main login|username and password.*customer/.test(raw))
    return result(
      "CUSTOMER_LOGIN_REQUIRED",
      "Complete the customer’s account first",
      "The customer needs an active main login and a valid email address.",
      owner
        ? [
            "Open Customers → Edit customer & access. Check the email, username and Active status; set a password if creating a login.",
            "Save the customer, then return to the invoice and try again.",
          ]
        : [
            "Ask the owner to complete the customer’s main account in Customers before sending the invoice.",
          ],
    );
  if (/Publish.*invoice|invoice.*Draft|published invoices/i.test(raw))
    return result(
      "INVOICE_DRAFT",
      "This invoice is still a draft",
      "Draft invoices are not ready for customers to receive or pay.",
      [
        "An authorized billing user must edit the invoice, change its status to Sent and save it.",
        "Then use Email PDF or Send payment link. Sent is an invoice status; it does not confirm email delivery.",
      ],
    );
  if (
    /Grouped invoices|same customer|Invoice customer must|registered customer with access/.test(
      raw,
    )
  )
    return result(
      "INVOICE_CASE_SELECTION",
      "Check the cases on this invoice",
      raw,
      [
        "Choose cases belonging to the same customer. For grouped apartment invoices, all cases must have the same assigned community and service date.",
        "Check the case’s workspace assignment as well as its property/community text, then select the cases again.",
      ],
    );
  if (/Paid invoices cannot/.test(raw))
    return result(
      "PAID_INVOICE_LOCKED",
      "This paid invoice is protected",
      "Paid invoices cannot be edited or deleted.",
      [
        "Keep the invoice as the payment record. Ask your billing administrator how to handle a correction. Do not create a replacement charge until the payment has been reviewed.",
      ],
    );
  if (/invoice link.*expired|invoice link.*unavailable/i.test(raw))
    return result(
      "INVOICE_LINK_EXPIRED",
      "Please request a new invoice link",
      "This private invoice link has expired or was disabled.",
      [
        "Ask your case team to send a new invoice link. Do not try to change the address in the link.",
      ],
    );
  if (/checkout.*expired/i.test(raw))
    return result(
      "PAYMENT_PAGE_EXPIRED",
      "The payment page expired",
      "This checkout expired before payment was completed.",
      [
        "Refresh the invoice and check whether it is already paid. If it is still unpaid, click Pay online again to open a new payment page.",
      ],
    );
  if (
    /Stripe|checkout|payment.*confirm|payment.*processing|Online payments|Online invoice payments/i.test(
      raw,
    )
  ) {
    if (
      /not configured|finish Stripe setup|webhook|mode does not match/.test(raw)
    )
      return result(
        "PAYMENTS_SETUP",
        "Online payments are not ready",
        "The company’s payment connection needs attention.",
        [
          owner
            ? "Ask the person managing LegalFlow deployment to check the Stripe connection, payment mode and webhook settings."
            : "Contact the owner to complete the company’s online payment setup.",
          "Try again after the connection is confirmed.",
        ],
      );
    return result(
      "PAYMENT_REVIEW",
      "Check the payment before trying again",
      /Paid|Only unpaid/.test(raw)
        ? raw
        : "A payment is in progress or its details need reviewing.",
      [
        "Refresh the invoice and check whether it is already paid. Avoid starting another payment while confirmation is pending.",
        owner
          ? "If it remains unresolved, ask your payment administrator to review the transaction and share the support reference."
          : "If it remains unresolved, contact the owner or billing team.",
      ],
    );
  }
  if (/email delivery is disabled|SMTP|IMAP|mail.*not configured/i.test(raw))
    return result(
      "EMAIL_SETUP",
      "Email is not ready to send",
      "The company’s email connection needs attention.",
      [
        owner
          ? "Open Settings and check the email connection. Ask the person managing the server to finish setup if the connection is disabled."
          : "Ask the owner to check the company’s email connection in Settings.",
        "After setup is confirmed, send the message again.",
      ],
    );
  if (/Dropbox|reconcile documents|upload.*repair/i.test(raw))
    return result(
      "FILE_STORAGE",
      "The file connection needs attention",
      /being saved|currently/.test(raw)
        ? "A file upload is still in progress."
        : "LegalFlow could not complete the file-storage operation.",
      [
        /being saved|currently/.test(raw)
          ? "Wait for the upload to finish, then refresh the folder."
          : owner
            ? "Open Settings → Dropbox and check or reconnect the company’s account. If files are awaiting repair, ask your support person to check them before retrying."
            : "Ask the owner to check the company’s file-storage connection.",
        "Keep any original files on your device until the upload is confirmed.",
      ],
    );
  if (
    /workspace.*contains cases|Delete the communities|customer.*workspaces|Move all cases|Move or delete.*file/i.test(
      raw,
    )
  )
    return result("ITEM_NOT_EMPTY", "This item is not empty", raw, [
      owner
        ? "Open it and review the linked cases, communities or files. Move or delete those items only if they are no longer needed; then retry deletion."
        : "Ask the owner to review the contents before deleting this item.",
    ]);
  if (
    /user has assigned cases|Reassign.*staff|Reassign.*cases|customer.*cases and invoices|additional customer logins/i.test(
      raw,
    )
  )
    return result("ASSIGNMENTS_EXIST", "Reassign linked work first", raw, [
      owner
        ? "Use Case Files and Assign team to reassign the person’s work. Check People & access for staff-to-manager assignments and Workspaces for extra customer logins."
        : "Ask the owner to reassign the linked cases or staff before changing this account.",
      "Try the account change again after the assignments are updated.",
    ]);
  if (
    /requires.*staff|responsible staff|manager.*staff|staff.*manager|assigned.*manager|Choose staff assigned/.test(
      raw,
    )
  )
    return result("CASE_TEAM_REQUIRED", "Check the case team", raw, [
      owner
        ? "Open People & access and assign the staff member to an active manager. Then select that staff/manager pair on the case."
        : manager
          ? "Choose active staff from your own team. Ask the owner to correct the staff-to-manager assignment if it is missing."
          : "Ask your manager or owner to check your staff-to-manager assignment.",
      "Reload the case before saving again.",
    ]);
  if (/Security token|origin is not allowed/i.test(raw))
    return result(
      "SESSION_REFRESH",
      "Please refresh your session",
      "LegalFlow could not verify this request.",
      [
        "Refresh the page and try again. If it continues, sign out and sign back in.",
        "Use the normal LegalFlow website or app. If that still fails, contact your administrator.",
      ],
    );
  if (/Incorrect username|Current password/.test(raw))
    return result("LOGIN_DETAILS", "Check your sign-in details", raw, [
      "Re-enter the username and password carefully. If you have forgotten the password, contact your administrator.",
    ]);
  if (
    /role preset|Unknown role|Permission is not available|assignment type/i.test(
      raw,
    )
  )
    return result(
      "ROLE_SELECTION",
      "Check the selected role",
      "The selected role and permissions cannot be used together.",
      [
        owner
          ? "Open People & access, select an available role preset, and review its checkboxes before saving. Ask a Super Admin to change role defaults."
          : "Ask the owner or a Super Admin to check the role assigned to this account.",
      ],
    );
  if (/Invalid message cursor/.test(raw))
    return result(
      "REOPEN_CONVERSATION",
      "Please reopen this conversation",
      "The message list is out of date.",
      [
        "Return to Messages, open the conversation again, and retry your action.",
      ],
    );
  if (/Duplicate case IDs|Select each case|Select each file/.test(raw))
    return result(
      "DUPLICATE_SELECTION",
      "An item was selected more than once",
      "Each case or file can only be included once.",
      [
        "Clear the duplicate selection, check the remaining items, and try again.",
      ],
    );
  if (
    /Upload identifier|Upload changed|pending upload belongs|Upload was removed/.test(
      raw,
    )
  )
    return result(
      "UPLOAD_REOPEN",
      "Please check this upload",
      "The upload has changed or belongs to a different signed-in account.",
      [
        "Refresh the folder and check whether the file is already there before uploading it again.",
        "Use the account that started the pending upload. If you need to upload a different file, select it as a new upload.",
      ],
    );
  if (/Unsupported range/.test(raw))
    return result(
      "REOPEN_PREVIEW",
      "Please reopen this preview",
      "This part of the file could not be loaded.",
      [
        "Close the preview and open the file again. If playback still fails, use Download and open the file in another app.",
      ],
    );
  if (/Invalid import defaults/.test(raw))
    return result(
      "IMPORT_ASSIGNMENTS",
      "Check the import assignments",
      "The selected customer or team is no longer available.",
      [
        "Reopen the import and select an active customer, staff member and their assigned manager. Preview the spreadsheet again before importing.",
      ],
    );
  if (status === 401)
    return result(
      "SIGN_IN_REQUIRED",
      "Please sign in again",
      "Your session has ended or is no longer valid.",
      [
        "Sign in to continue. If you cannot sign in, ask the owner to check that your account is active.",
      ],
    );
  if (
    status === 403 ||
    /permission.*required|Super Admin|Only the owner|Only owners|Team access required/i.test(
      raw,
    )
  )
    return result(
      "ACCESS_REQUIRED",
      "You do not have access to this action",
      /Super Admin/.test(raw)
        ? "This action is reserved for a Super Admin."
        : "Your role or case assignment does not allow this action.",
      [
        /Super Admin/.test(raw)
          ? "Ask a Super Admin to make this change."
          : owner
            ? "Check People & access for the person’s role and permissions. For customer case access, use Workspaces → Customer access. Ask a Super Admin if these controls are unavailable."
            : "Ask your owner or administrator to check your role, permissions and case or community assignments.",
      ],
    );
  if (status === 404)
    return result(
      "ITEM_UNAVAILABLE",
      "This item is unavailable",
      "It may have been removed, or your account may not have access to it.",
      [
        "Return to the list and refresh it.",
        "If you still need the item, ask the owner to check that it exists and that you have access.",
      ],
    );
  if (status === 429)
    return result(
      "PLEASE_WAIT",
      "Please wait before trying again",
      /15 minutes/.test(raw)
        ? "There have been too many attempts. Wait 15 minutes before trying again."
        : "Too many requests were made in a short time.",
      [
        "Wait for the stated time, or at least one minute if no time is shown. Avoid repeatedly pressing the button.",
      ],
    );
  if (
    /changed|Reload|Refresh|currently being|being sent|synchronization is running/.test(
      raw,
    ) &&
    status < 500
  )
    return result("REFRESH_REQUIRED", "Refresh before continuing", raw, [
      "Refresh or reopen this item to load the latest information. Check whether your earlier change has already been saved.",
      "Reapply only the changes that are still needed, then save again.",
    ]);
  if (/Google|address suggestions|Places API/.test(raw))
    return result(
      "ADDRESS_LOOKUP",
      "Address suggestions are unavailable",
      "The address lookup service could not be reached.",
      [
        "Enter the address, city, state and ZIP code manually.",
        owner
          ? "If suggestions keep failing, ask your support person to check the Google address connection."
          : "If suggestions keep failing, let your administrator know.",
      ],
    );
  if (status >= 500)
    return result(
      "SERVICE_UNAVAILABLE",
      "LegalFlow could not finish this action",
      "A service is temporarily unavailable or needs attention.",
      [
        "Refresh the item and check whether the change was saved before trying again. For payments, check the invoice status first.",
        support,
      ],
    );
  return result(
    "CHECK_REQUEST",
    "Please check this action",
    raw || "The selected information could not be accepted.",
    [
      /file|upload|document|folder|collection/i.test(route)
        ? "Check the selected file or folder and any limits shown, then try again."
        : /invoice|payment/i.test(route)
          ? "Reopen the invoice and check its customer, included cases, amounts and status before trying again."
          : "Review the selected information and any highlighted fields, then try again.",
      support,
    ],
  );
}
export function readableError(info, requestId, status) {
  return [
    info.title,
    info.reason,
    ...info.steps.map((s, i) => `${i + 1}. ${s}`),
    ...(requestId ? [`Support reference: ${requestId}`] : []),
  ].join("\n");
}
