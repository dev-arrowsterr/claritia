// Makes Claritia's timeline event template on our HubSpot app, once. Prints the id to set as
// HUBSPOT_TIMELINE_TEMPLATE on claritia-intel. Until it's set, email and form activity goes to HubSpot as notes.
//   HUBSPOT_APP_ID=… HUBSPOT_DEVELOPER_KEY=… node scripts/hubspot-timeline.mjs
// The developer key is in the HubSpot developer account under Apps → Get HubSpot API key (check).

const app = process.env.HUBSPOT_APP_ID?.trim();
const key = process.env.HUBSPOT_DEVELOPER_KEY?.trim();
if (!app || !key) {
  console.error("Set HUBSPOT_APP_ID and HUBSPOT_DEVELOPER_KEY.");
  process.exit(1);
}

const base = `https://api.hubapi.com/crm/v3/timeline/${app}/event-templates`;
const list = await fetch(`${base}?hapikey=${encodeURIComponent(key)}`);
if (!list.ok) {
  console.error(`HubSpot answered ${list.status}: ${await list.text()}`);
  process.exit(1);
}
const found = ((await list.json()).results ?? []).find((t) => t.name === "Claritia activity");
if (found) {
  console.log(`HUBSPOT_TIMELINE_TEMPLATE=${found.id}`);
  process.exit(0);
}
const res = await fetch(`${base}?hapikey=${encodeURIComponent(key)}`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    name: "Claritia activity",
    objectType: "contacts",
    headerTemplate: "{{action}}: {{title}}",
    detailTemplate: "{{detail}}",
    tokens: [
      { name: "action", label: "Action", type: "string" },
      { name: "title", label: "Title", type: "string" },
      { name: "detail", label: "Detail", type: "string" },
    ],
  }),
});
if (!res.ok) {
  console.error(`HubSpot answered ${res.status}: ${await res.text()}`);
  process.exit(1);
}
console.log(`HUBSPOT_TIMELINE_TEMPLATE=${(await res.json()).id}`);
