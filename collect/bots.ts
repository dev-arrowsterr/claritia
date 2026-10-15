// Bots: known crawler user agents are dropped. Cloud networks, browser automation and visits with no input are kept
// but marked, so the screens leave them out. A cloud visit that shows real input is unmarked (people on cloud
// desktops like Windows 365 are real buyers).

import { isbot } from "isbot";

// Cloud and hosting networks (ASNs, check yearly). CDNs and VPN gateways are left out on purpose: Apple Private
// Relay runs on Akamai, Cloudflare and Fastly, and company VPNs (Zscaler and others) carry real people.
const HOSTING = new Set([
  16509, 14618, // AWS
  396982, // Google Cloud
  8075, // Microsoft Azure
  14061, // DigitalOcean
  16276, // OVH
  24940, // Hetzner
  63949, // Linode
  20473, // Vultr
  31898, // Oracle Cloud
  45102, // Alibaba Cloud
  132203, // Tencent Cloud
  51167, // Contabo
  12876, // Scaleway
]);

export type BotVerdict = "drop" | "mark" | "hosting" | "ok";

export function botVerdict(input: { ua: string; asn: number | null; ipTrusted: boolean; webdriver?: boolean }): BotVerdict {
  if (!input.ua || isbot(input.ua)) return "drop";
  // Behind a customer's proxy with no proxy secret the IP is the proxy's, so the network says nothing.
  if (input.webdriver) return "mark";
  if (input.ipTrusted && input.asn !== null && HOSTING.has(input.asn)) return "hosting";
  return "ok";
}

/** More than 10 views and no input at all after 30 seconds. */
export function looksAutomated(s: { pageviews: number; startedAt: number; inputs: number }, now = Date.now()): boolean {
  return s.pageviews > 10 && s.inputs === 0 && now - s.startedAt > 30_000;
}
