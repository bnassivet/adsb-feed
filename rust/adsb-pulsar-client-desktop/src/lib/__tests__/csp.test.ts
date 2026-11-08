import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { tileConfig } from "../basemap";

/**
 * The CSP lives in two places kept in sync by hand -- `tauri.conf.json` and
 * `scripts/tauri-dev-config.py` (which overrides it for `tauri dev -c`). A
 * missing source fails silently: tiles just don't load, with a console line.
 * The tile cache fetches tiles (connect-src) and shows them as blob: URLs
 * (img-src), so both directives must cover every basemap host.
 */

const appRoot = path.resolve(__dirname, "../../..");
const conf = JSON.parse(readFileSync(path.join(appRoot, "src-tauri/tauri.conf.json"), "utf8"));
const confCsp: string = conf.app.security.csp;
const devConfig = readFileSync(path.join(appRoot, "../../scripts/tauri-dev-config.py"), "utf8");

/**
 * The CSP `csp()` builds, rebuilt from its adjacent string literals. Exact
 * enough to compare directives, and immune to the hosts being mentioned in a
 * docstring or another function.
 */
function devCsp(): string {
  const body = devConfig.slice(devConfig.indexOf("def csp("), devConfig.indexOf("\ndef ", devConfig.indexOf("def csp(") + 1));
  const ret = body.slice(body.indexOf("return ("));
  return [...ret.matchAll(/f?"([^"]*)"/g)].map((m) => m[1]).join("");
}

function directive(csp: string, name: string): string[] {
  const d = csp.split(";").map((s) => s.trim()).find((s) => s.startsWith(`${name} `));
  return d ? d.split(/\s+/).slice(1) : [];
}

/** The CSP source a tile URL needs: `{s}.` subdomains become a `*.` wildcard. */
function sourceFor(url: string): string {
  const host = new URL(url.replace("{s}", "a")).host;
  return url.includes("{s}.") ? `https://*.${host.split(".").slice(1).join(".")}` : `https://${host}`;
}

const tileSources = [tileConfig("light"), tileConfig("dark"), tileConfig("dark", "k")].map((t) => sourceFor(t.url));

describe("CSP covers the cached basemap", () => {
  it.each(tileSources)("tauri.conf.json lets the cache fetch %s", (src) => {
    expect(directive(confCsp, "connect-src")).toContain(src);
    expect(directive(confCsp, "img-src")).toContain(src);
  });

  it("tauri.conf.json allows blob: images, which is how cached tiles are shown", () => {
    expect(directive(confCsp, "img-src")).toContain("blob:");
  });

  it("scripts/tauri-dev-config.py builds a CSP with the same img-src and connect-src", () => {
    const dev = devCsp();
    expect(directive(dev, "img-src")).toEqual(directive(confCsp, "img-src"));
    // connect-src differs only by the agent port, templated in the dev override.
    const strip = (srcs: string[]) => srcs.filter((s) => !/:(\d+|\{agent_port\})$/.test(s));
    expect(strip(directive(dev, "connect-src"))).toEqual(strip(directive(confCsp, "connect-src")));
  });
});
