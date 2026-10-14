import { sendAlerts } from "@/lib/alertSender";
import { serviceClient } from "@/lib/serviceClient";
import { fromDatabase } from "@/lib/syncSecret";

/** The database calls this every minute while alerts are queued. */
export async function POST(request: Request) {
  const sb = serviceClient();
  if (!sb) return Response.json({ error: "The server is not set up for alerts." }, { status: 500 });
  if (!(await fromDatabase(sb, request))) return Response.json({ error: "Not allowed." }, { status: 401 });
  const result = await sendAlerts(sb);
  if (result.errors.length) console.error(`Alerts: ${result.errors.join(" | ")}`);
  return Response.json(result);
}
