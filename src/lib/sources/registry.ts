// Connectors by kind. Server only (connectors sign and check webhooks with node:crypto).

import { attio, close, pipedrive } from "./crms.ts";
import { activecampaign, brevo, kit, klaviyo, mailchimp, mailerlite } from "./email.ts";
import { api, calcom, calendly, tally, typeform, webflow } from "./forms.ts";
import { hubspot } from "./hubspot.ts";
import { omniscient } from "./omniscient.ts";
import { intercom, stripe } from "./product.ts";
import { salesforce } from "./salesforce.ts";
import type { Connector } from "./types.ts";

const ALL: Connector[] = [hubspot, salesforce, omniscient, pipedrive, attio, close, mailchimp, klaviyo, activecampaign, brevo, kit, mailerlite, stripe, intercom, typeform, tally, webflow, calendly, calcom, api];
const BY_KIND = new Map(ALL.map((c) => [c.kind, c]));

export const connectorFor = (kind: string): Connector | undefined => BY_KIND.get(kind);
export const CONNECTORS = ALL;
