-- billing-service control plane (schema "billing" in mc_control). No patient data here.
-- Payment-gateway webhooks arrive without a hospital host: this maps the gateway's order/refund ids to the hospital
-- whose database holds them. Written when we create the order/refund, read by the webhook handler.
CREATE TABLE gateway_refs (
  ref text PRIMARY KEY,                 -- order_..., rfnd_...
  kind text NOT NULL CHECK (kind IN ('ORDER','REFUND')),
  tenant_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
