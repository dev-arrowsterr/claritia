import { appBase } from "@/lib/billing";
import { embedScript } from "@/lib/forms/render";

// The embed script: <script src="https://app.tryclaritia.com/f/embed.js" data-claritia-form="<form id>" async></script>
export function GET() {
  return new Response(embedScript(appBase()), {
    headers: { "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "public, max-age=3600", "Access-Control-Allow-Origin": "*" },
  });
}
