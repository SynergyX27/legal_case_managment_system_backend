import { env } from "../config/env.js";
import { assert } from "../utils/errors.js";
import { id } from "../validators/schemas.js";
import {
  stripeClient,
  paymentConfiguration,
  createCheckout,
  paymentStatus,
  processStripeEvent,
} from "../services/payments.service.js";
export const configuration = (req, res) => res.json(paymentConfiguration());
export const checkout = async (req, res) =>
  res.json(await createCheckout(req.user, id.parse(req.params.id)));
export const status = async (req, res) =>
  res.json(await paymentStatus(req.user, id.parse(req.params.id)));
export async function webhook(req, res) {
  assert(
    env.STRIPE_SECRET_KEY && env.STRIPE_WEBHOOK_SECRET,
    503,
    "Stripe webhook is not configured",
  );
  let event;
  try {
    event = stripeClient().webhooks.constructEvent(
      req.body,
      req.headers["stripe-signature"],
      env.STRIPE_WEBHOOK_SECRET,
    );
  } catch {
    return res.status(400).json({ error: "Invalid Stripe webhook signature" });
  }
  await processStripeEvent(event);
  res.json({ received: true });
}
