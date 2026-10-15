// Import files in Supabase Storage (the private "imports" bucket), read and written with the secret key. Used by the
// web app's import routes and by claritia-intel, which have SUPABASE_URL and SUPABASE_SECRET_KEY.

const base = () => {
  const url = process.env.SUPABASE_URL?.trim().replace(/\/+$/, "");
  const key = (process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY)?.trim();
  if (!url || !key) throw new Error("Storage is not set up on this server");
  return { url, key };
};

const objectUrl = (url: string, path: string) => `${url}/storage/v1/object/imports/${path.split("/").map(encodeURIComponent).join("/")}`;

/** Paths look like <workspace id>/<upload id>/<file name>. */
export const validPath = (ws: string, path: unknown): path is string =>
  typeof path === "string" && path.length < 500 && path.startsWith(`${ws}/`) && !path.includes("..") && path.split("/").length === 3;

export async function fileSize(path: string): Promise<number | null> {
  const { url, key } = base();
  const res = await fetch(objectUrl(url, path), { method: "HEAD", headers: { Authorization: `Bearer ${key}`, apikey: key } });
  if (!res.ok) return null;
  const n = Number(res.headers.get("content-length"));
  return Number.isFinite(n) ? n : null;
}

export async function openFile(path: string, signal?: AbortSignal): Promise<ReadableStream<Uint8Array>> {
  const { url, key } = base();
  const res = await fetch(objectUrl(url, path), { headers: { Authorization: `Bearer ${key}`, apikey: key }, signal });
  if (!res.ok || !res.body) throw new Error(res.status === 404 || res.status === 400 ? "The file is gone. Upload it again." : `Couldn't read the file (${res.status})`);
  return res.body;
}

export async function putFile(path: string, body: string, contentType: string): Promise<void> {
  const { url, key } = base();
  const res = await fetch(objectUrl(url, path), { method: "POST", headers: { Authorization: `Bearer ${key}`, apikey: key, "content-type": contentType, "x-upsert": "true" }, body });
  if (!res.ok) throw new Error(`Couldn't save the file (${res.status})`);
}

export async function removeFiles(paths: string[]): Promise<void> {
  if (!paths.length) return;
  const { url, key } = base();
  await fetch(`${url}/storage/v1/object/imports`, { method: "DELETE", headers: { Authorization: `Bearer ${key}`, apikey: key, "content-type": "application/json" }, body: JSON.stringify({ prefixes: paths }) });
}
