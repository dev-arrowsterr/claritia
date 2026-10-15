// The tools Claritia connects to, for Settings › Sources. Data only, so the browser can load it.

import type { Group, ObjectKind } from "./types.ts";

export type KeyField = { key: string; label: string; secret?: boolean; placeholder?: string };
export type Entry = {
  kind: string;
  label: string;
  group: Group;
  /** For the logo. */
  domain: string;
  /** One-click sign-in when the app is registered; keys otherwise. */
  oauth?: boolean;
  keys?: KeyField[];
  /** Records arrive by webhook to a URL we hand out. */
  hook?: boolean;
  /** Signs its webhooks with a secret the person pastes. */
  hookSecret?: boolean;
  objects: ObjectKind[];
  twoWay?: boolean;
};

const key = (label = "API key"): KeyField[] => [{ key: "api_key", label, secret: true }];

export const CATALOG: Entry[] = [
  { kind: "hubspot", label: "HubSpot", group: "crm", domain: "hubspot.com", oauth: true, keys: key("Private app token"), objects: ["companies", "contacts", "lists"], twoWay: true },
  {
    kind: "salesforce",
    label: "Salesforce",
    group: "crm",
    domain: "salesforce.com",
    oauth: true,
    objects: ["companies", "contacts"],
    twoWay: true,
  },
  { kind: "omniscient", label: "Omniscient", group: "crm", domain: "tryomniscient.com", objects: ["companies", "contacts"], twoWay: true },
  { kind: "pipedrive", label: "Pipedrive", group: "crm", domain: "pipedrive.com", oauth: true, keys: key("API token"), objects: ["companies", "contacts"] },
  { kind: "attio", label: "Attio", group: "crm", domain: "attio.com", oauth: true, keys: key("Access token"), objects: ["companies", "contacts"] },
  { kind: "close", label: "Close", group: "crm", domain: "close.com", keys: key(), objects: ["contacts"] },
  { kind: "mailchimp", label: "Mailchimp", group: "email", domain: "mailchimp.com", oauth: true, keys: key(), objects: ["contacts"] },
  { kind: "klaviyo", label: "Klaviyo", group: "email", domain: "klaviyo.com", keys: key("Private API key"), objects: ["contacts"] },
  {
    kind: "activecampaign",
    label: "ActiveCampaign",
    group: "email",
    domain: "activecampaign.com",
    keys: [{ key: "url", label: "API URL", placeholder: "https://you.api-us1.com" }, ...key()],
    objects: ["contacts"],
  },
  { kind: "brevo", label: "Brevo", group: "email", domain: "brevo.com", keys: key(), objects: ["contacts"] },
  { kind: "kit", label: "Kit", group: "email", domain: "kit.com", keys: key("API secret"), objects: ["contacts", "suppressions"] },
  { kind: "mailerlite", label: "MailerLite", group: "email", domain: "mailerlite.com", keys: key("API token"), objects: ["contacts"] },
  { kind: "stripe", label: "Stripe", group: "product", domain: "stripe.com", keys: key("Restricted key"), objects: ["contacts"] },
  { kind: "intercom", label: "Intercom", group: "product", domain: "intercom.com", keys: key("Access token"), objects: ["contacts"] },
  { kind: "typeform", label: "Typeform", group: "form", domain: "typeform.com", hook: true, hookSecret: true, objects: ["contacts"] },
  { kind: "tally", label: "Tally", group: "form", domain: "tally.so", hook: true, hookSecret: true, objects: ["contacts"] },
  { kind: "webflow", label: "Webflow forms", group: "form", domain: "webflow.com", hook: true, objects: ["contacts"] },
  { kind: "calendly", label: "Calendly", group: "event", domain: "calendly.com", hook: true, hookSecret: true, objects: ["contacts"] },
  { kind: "calcom", label: "Cal.com", group: "event", domain: "cal.com", hook: true, hookSecret: true, objects: ["contacts"] },
  { kind: "api", label: "Webhook", group: "api", domain: "", hook: true, objects: ["contacts"] },
];

export const GROUPS: { id: Group; label: string }[] = [
  { id: "crm", label: "CRMs" },
  { id: "email", label: "Email tools" },
  { id: "form", label: "Forms" },
  { id: "event", label: "Meetings and events" },
  { id: "product", label: "Product and billing" },
  { id: "api", label: "Anything else" },
];

export const entryOf = (kind: string) => CATALOG.find((e) => e.kind === kind);
