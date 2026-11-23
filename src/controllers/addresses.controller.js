import { z } from "zod";
import { env } from "../config/env.js";
import { can } from "../services/access.service.js";
import { assert, HttpError } from "../utils/errors.js";
const session = z.string().uuid();
function allowed(req) {
  assert(
    can(req.user, "cases.create") || can(req.user, "cases.edit"),
    403,
    "Case permission required",
  );
}
async function google(path, options = {}) {
  assert(
    env.GOOGLE_MAPS_API_KEY,
    503,
    "Address suggestions are unavailable. Enter the address manually.",
  );
  let r;
  try {
    r = await fetch("https://places.googleapis.com/v1/" + path, {
      ...options,
      headers: {
        "X-Goog-Api-Key": env.GOOGLE_MAPS_API_KEY,
        ...options.headers,
      },
      signal: AbortSignal.timeout(10000),
    });
  } catch {
    throw new HttpError(502, "Address suggestions are temporarily unavailable");
  }
  assert(
    r.ok,
    502,
    "Google address suggestions are unavailable. Check the Places API configuration.",
  );
  return r.json();
}
export function config(req, res) {
  allowed(req);
  res.json({ configured: !!env.GOOGLE_MAPS_API_KEY });
}
export async function suggest(req, res) {
  allowed(req);
  const v = z
    .object({ input: z.string().trim().min(3).max(250), sessionToken: session })
    .parse(req.body);
  const r = await google("places:autocomplete", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-FieldMask":
        "suggestions.placePrediction.placeId,suggestions.placePrediction.text.text",
    },
    body: JSON.stringify({
      ...v,
      includedRegionCodes: ["us"],
      languageCode: "en",
    }),
  });
  res.json({
    suggestions: (r.suggestions || [])
      .filter((x) => x.placePrediction)
      .map((x) => ({
        placeId: x.placePrediction.placeId,
        label: x.placePrediction.text.text,
      })),
  });
}
export async function details(req, res) {
  allowed(req);
  const v = z
    .object({
      placeId: z.string().regex(/^[A-Za-z0-9_-]{1,250}$/),
      sessionToken: session,
    })
    .parse(req.body);
  const r = await google(
    "places/" +
      encodeURIComponent(v.placeId) +
      "?sessionToken=" +
      v.sessionToken,
    { headers: { "X-Goog-FieldMask": "addressComponents" } },
  );
  const component = (type, short = false) => {
    const c = r.addressComponents?.find((x) => x.types.includes(type));
    return (short ? c?.shortText : c?.longText) || "";
  };
  assert(
    component("route"),
    422,
    "Choose a street address or enter the address manually.",
  );
  res.json({
    residentAddress: [component("street_number"), component("route")]
      .filter(Boolean)
      .join(" "),
    unit: component("subpremise"),
    county: component("administrative_area_level_2"),
    city:
      component("locality") ||
      component("postal_town") ||
      component("sublocality_level_1"),
    state: component("administrative_area_level_1", true),
    zip: [component("postal_code"), component("postal_code_suffix")]
      .filter(Boolean)
      .join("-"),
  });
}
