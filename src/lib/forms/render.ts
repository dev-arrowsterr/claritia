// The form's own page (/f/<id>): what the embed shows in a frame, and a link people can open on its own. Plain
// HTML and a small script: it sends the answers with the page's UTMs, shows errors by each field, tells the page
// around it to resize, and hands the email to Claritia's site script so the visit links to the person.

import { DEFAULT_CONSENT, type FormField, type FormSettings } from "./schema.ts";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function input(f: FormField): string {
  const id = `f_${f.key}`;
  const req = f.required ? " required" : "";
  const ph = f.placeholder ? ` placeholder="${esc(f.placeholder)}"` : "";
  const label = `<label for="${id}">${esc(f.label)}${f.required ? ' <span aria-hidden="true">*</span>' : ""}</label>`;
  const err = `<p class="err" data-err="${f.key}"></p>`;
  switch (f.type) {
    case "hidden":
      return `<input type="hidden" name="${f.key}" data-fill="${esc(f.value ?? "")}">`;
    case "textarea":
      return `<div class="field">${label}<textarea id="${id}" name="${f.key}" rows="4"${req}${ph}></textarea>${err}</div>`;
    case "select":
      return `<div class="field">${label}<div class="choices">${(f.options ?? [])
        .map((o, i) => `<label class="choice"><input type="radio" name="${f.key}" value="${esc(o)}"${f.required && i === 0 ? " required" : ""}> ${esc(o)}</label>`)
        .join("")}</div>${err}</div>`;
    case "multi":
      return `<div class="field">${label}<div class="choices">${(f.options ?? []).map((o) => `<label class="choice"><input type="checkbox" name="${f.key}" value="${esc(o)}"> ${esc(o)}</label>`).join("")}</div>${err}</div>`;
    case "checkbox":
      return `<div class="field"><label class="choice"><input type="checkbox" id="${id}" name="${f.key}"${req}> ${esc(f.label)}</label>${err}</div>`;
    default: {
      const type = f.type === "email" ? "email" : f.type === "phone" ? "tel" : f.type === "number" ? "number" : "text";
      const auto = f.maps_to === "email" ? ' autocomplete="email"' : f.maps_to === "first_name" ? ' autocomplete="given-name"' : f.maps_to === "last_name" ? ' autocomplete="family-name"' : f.maps_to === "company" ? ' autocomplete="organization"' : f.type === "phone" ? ' autocomplete="tel"' : "";
      return `<div class="field">${label}<input id="${id}" type="${type}" name="${f.key}"${req}${ph}${auto}>${err}</div>`;
    }
  }
}

export function formPage(o: { id: string; name: string; fields: FormField[]; settings: FormSettings; token: string; preview: boolean; captchaKey: string | null; topic: string | null }): string {
  const s = o.settings;
  const color = /^#[0-9a-f]{6}$/i.test(s.color ?? "") ? s.color! : "#266df0";
  const consent =
    s.consent === "notice"
      ? `<p class="notice">${esc(s.consent_text || "By sending this, you agree we may email you about our products. You can unsubscribe at any time.")}</p>`
      : `<div class="field"><label class="choice"><input type="checkbox" name="_consent" value="1"> ${esc(s.consent_text || (o.topic ? `${DEFAULT_CONSENT.replace("emails", `${o.topic} emails`)}` : DEFAULT_CONSENT))}</label></div>`;
  const captcha = s.captcha && o.captchaKey ? `<div class="cf-turnstile" data-sitekey="${esc(o.captchaKey)}"></div>` : "";
  const cfg = JSON.stringify({ id: o.id, preview: o.preview, success: s.success_message || "Thanks. We got it.", redirect: s.redirect_url || null }).replace(/</g, "\\u003c");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(o.name)}</title>
${captcha ? '<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>' : ""}
<style>
:root{color-scheme:light;--ink:#0c0c0b;--muted:#6b6b66;--line:#d9d9d6;--brand:${color};--err:#c62828}
*{box-sizing:border-box}
body{margin:0;background:transparent;color:var(--ink);font:15px/1.5 Geist,ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif}
form{display:flex;flex-direction:column;gap:14px;padding:4px}
.field{display:flex;flex-direction:column;gap:6px}
label{font-size:14px;font-weight:500}
input[type=text],input[type=email],input[type=tel],input[type=number],textarea{font:inherit;width:100%;border:1px solid var(--line);border-radius:6px;padding:9px 11px;background:#fff;color:var(--ink)}
input:focus,textarea:focus{outline:2px solid var(--brand);outline-offset:-1px;border-color:var(--brand)}
.choices{display:flex;flex-direction:column;gap:6px}
.choice{display:flex;gap:8px;align-items:flex-start;font-weight:400}
.choice input{margin-top:3px;accent-color:var(--brand)}
.notice{font-size:12.5px;color:var(--muted);margin:0}
.err{color:var(--err);font-size:12.5px;margin:0;min-height:0}
.err:empty{display:none}
button{font:inherit;font-weight:500;border:0;border-radius:6px;padding:10px 16px;background:var(--brand);color:#fff;cursor:pointer;align-self:flex-start}
button[disabled]{opacity:.6;cursor:default}
.hp{position:absolute;left:-10000px;width:1px;height:1px;overflow:hidden}
.done{padding:4px;font-size:15px}
</style></head><body>
<form id="cf" novalidate>
${o.fields.map(input).join("\n")}
${consent}
${captcha}
<div class="hp" aria-hidden="true"><label>Leave this empty<input type="text" name="_hp" tabindex="-1" autocomplete="off"></label></div>
<input type="hidden" name="_t" value="${esc(o.token)}">
<p class="err" data-err="_form"></p>
<button type="submit">${esc(s.submit_label || "Send")}</button>
</form>
<script>
(function(){
var C=${cfg};var f=document.getElementById("cf");var q=new URLSearchParams(location.search);
var ctx={};try{ctx=JSON.parse(atob((q.get("c")||"").replace(/-/g,"+").replace(/_/g,"/")))||{}}catch(e){ctx={}}
if(!ctx.page){var u={};["utm_source","utm_medium","utm_campaign","utm_term","utm_content","gclid","fbclid","li_fat_id","msclkid"].forEach(function(k){var v=q.get(k);if(v)u[k]=v});ctx={utm:u,page:location.href.split("?")[0],referrer:document.referrer||null}}
f.querySelectorAll("input[data-fill]").forEach(function(h){var k=h.getAttribute("data-fill");h.value=(ctx.utm&&ctx.utm[k])||(ctx.first&&ctx.first[k])||k});
function size(){try{parent.postMessage({type:"claritia-form",id:C.id,height:document.documentElement.scrollHeight},"*")}catch(e){}}
window.addEventListener("load",size);new ResizeObserver(size).observe(document.body);
f.addEventListener("submit",function(ev){ev.preventDefault();
f.querySelectorAll("[data-err]").forEach(function(p){p.textContent=""});
var data={};new FormData(f).forEach(function(v,k){if(data[k]===undefined)data[k]=v;else data[k]=[].concat(data[k],v)});
f.querySelectorAll('input[type=checkbox]:not([name="_consent"])').forEach(function(b){if(b.closest(".choices")){if(data[b.name]&&!Array.isArray(data[b.name]))data[b.name]=[data[b.name]]}else data[b.name]=b.checked});
var btn=f.querySelector("button");btn.disabled=true;
fetch("/api/forms/"+C.id+"/submit"+(C.preview?"?preview=1":""),{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({answers:data,context:ctx})})
.then(function(r){return r.json().then(function(j){return{ok:r.ok,j:j}})})
.then(function(x){btn.disabled=false;
if(!x.ok){var e=x.j.errors||{};var any=false;Object.keys(e).forEach(function(k){var p=f.querySelector('[data-err="'+k+'"]');if(p){p.textContent=e[k];any=true}});if(!any||x.j.error)f.querySelector('[data-err="_form"]').textContent=x.j.error||"Something went wrong. Try again.";size();if(window.turnstile)try{turnstile.reset()}catch(e2){}return}
try{parent.postMessage({type:"claritia-form-done",id:C.id,email:x.j.email||null,redirect:C.redirect},"*")}catch(e){}
if(C.redirect&&parent===window){location.href=C.redirect;return}
var d=document.createElement("p");d.className="done";d.textContent=C.success;f.replaceWith(d);size()})
.catch(function(){btn.disabled=false;f.querySelector('[data-err="_form"]').textContent="Something went wrong. Try again.";size()})})
})();
</script></body></html>`;
}

/** The embed: one script tag finds its form's spot, keeps the visitor's first and latest UTMs, and frames the form. */
export function embedScript(appBase: string): string {
  return `(function(){
var B=${JSON.stringify(appBase)};var K=["utm_source","utm_medium","utm_campaign","utm_term","utm_content","gclid","fbclid","li_fat_id","msclkid"];
function st(k,v){try{if(v===undefined)return JSON.parse(localStorage.getItem(k)||"null");localStorage.setItem(k,JSON.stringify(v))}catch(e){return null}}
var q=new URLSearchParams(location.search);var now={};K.forEach(function(k){var v=q.get(k);if(v)now[k]=v.slice(0,300)});
if(Object.keys(now).length){st("_clr_utm",now);if(!st("_clr_utm1"))st("_clr_utm1",now)}
function ctx(){return{utm:st("_clr_utm")||{},first:st("_clr_utm1")||{},page:location.href.split("#")[0].split("?")[0],referrer:document.referrer||null}}
function b64(o){return btoa(unescape(encodeURIComponent(JSON.stringify(o)))).replace(/\\+/g,"-").replace(/\\//g,"_").replace(/=+$/,"")}
function mount(el){if(el.__clr)return;el.__clr=1;var id=el.getAttribute("data-claritia-form");if(!/^[0-9a-f-]{36}$/.test(id||""))return;
var fr=document.createElement("iframe");fr.src=B+"/f/"+id+"?c="+b64(ctx());fr.title="Form";fr.loading="lazy";fr.style.cssText="width:100%;border:0;display:block;min-height:120px";fr.setAttribute("data-claritia-frame",id);el.appendChild(fr)}
function scan(){document.querySelectorAll("[data-claritia-form]").forEach(function(el){if(el.tagName==="SCRIPT"){var d=document.createElement("div");d.setAttribute("data-claritia-form",el.getAttribute("data-claritia-form"));el.parentNode.insertBefore(d,el);el.removeAttribute("data-claritia-form");mount(d)}else mount(el)})}
window.addEventListener("message",function(e){if(e.origin!==B||!e.data||typeof e.data!=="object")return;var d=e.data;
document.querySelectorAll('iframe[data-claritia-frame="'+d.id+'"]').forEach(function(fr){if(fr.contentWindow!==e.source)return;
if(d.type==="claritia-form"&&d.height)fr.style.height=Math.min(d.height+8,5000)+"px";
if(d.type==="claritia-form-done"){if(d.email&&typeof window.claritia==="function")try{window.claritia("form",d.email)}catch(x){}
try{fr.dispatchEvent(new CustomEvent("claritia:submit",{bubbles:true,detail:{form:d.id}}))}catch(x){}
if(d.redirect&&/^https:\\/\\//.test(d.redirect))location.href=d.redirect}})});
if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",scan);else scan();
})();`;
}
