// psl ships types its package.json exports don't point to.
declare module "psl" {
  type Parsed = { input: string; tld: string | null; sld: string | null; domain: string | null; subdomain: string | null; listed: boolean };
  type ParseError = { input: string; error: { code: string; message: string } };
  const psl: { parse(domain: string): Parsed | ParseError; get(domain: string): string | null; isValid(domain: string): boolean };
  export default psl;
}
