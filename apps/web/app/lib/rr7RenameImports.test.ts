import { describe, expect, it } from "vitest";
// A one-off for the React Router 7 move; the move's last task deletes it.
import { renameImports } from "../../scripts/rr7-rename-imports.mjs";

const run = (src: string) => renameImports(src).source;

describe("renameImports", () => {
  it("moves @remix-run/react imports to react-router", () => {
    expect(run(`import { Link, useLoaderData } from "@remix-run/react";\n`)).toBe(
      `import { Link, useLoaderData } from "react-router";\n`
    );
  });

  it("turns json from @remix-run/cloudflare into data as json", () => {
    expect(run(`import { json } from "@remix-run/cloudflare";\n`)).toBe(`import { data as json } from "react-router";\n`);
  });

  it("moves every listed @remix-run/cloudflare name to react-router", () => {
    const src =
      `import type { LoaderFunctionArgs, ActionFunctionArgs, MetaFunction, AppLoadContext, EntryContext, HandleErrorFunction, HeadersFunction, LinksFunction } from "@remix-run/cloudflare";\n` +
      `import { redirect } from "@remix-run/cloudflare";\n`;
    const out = run(src);
    expect(out).not.toContain("@remix-run");
    expect(out).toContain(`import { redirect } from "react-router";`);
    for (const name of ["LoaderFunctionArgs", "ActionFunctionArgs", "MetaFunction", "AppLoadContext", "EntryContext",
      "HandleErrorFunction", "HeadersFunction", "LinksFunction"]) {
      expect(out).toMatch(new RegExp(`import type \\{[^}]*\\b${name}\\b[^}]*\\} from "react-router";`));
    }
  });

  it("moves @remix-run/cloudflare-pages to @react-router/cloudflare", () => {
    expect(run(`import { createPagesFunctionHandler } from "@remix-run/cloudflare-pages";\n`)).toBe(
      `import { createPagesFunctionHandler } from "@react-router/cloudflare";\n`
    );
  });

  it("moves @remix-run/server-runtime to react-router", () => {
    expect(run(`import type { ServerBuild } from "@remix-run/server-runtime";\n`)).toBe(
      `import type { ServerBuild } from "react-router";\n`
    );
  });

  it("renames the module inside vi.mock, vi.importActual and typeof import", () => {
    const src =
      `vi.mock("@remix-run/react", async () => {\n` +
      `  const actual = await vi.importActual<typeof import("@remix-run/react")>("@remix-run/react");\n` +
      `  return { ...actual };\n});\n`;
    expect(run(src)).toBe(
      `vi.mock("react-router", async () => {\n` +
        `  const actual = await vi.importActual<typeof import("react-router")>("react-router");\n` +
        `  return { ...actual };\n});\n`
    );
  });

  it("merges values into one import and types into one import type", () => {
    const src =
      `import { Form, useLoaderData } from "@remix-run/react";\n` +
      `import type { ShouldRevalidateFunction } from "@remix-run/react";\n` +
      `import type { LoaderFunctionArgs } from "@remix-run/cloudflare";\n` +
      `import { json, redirect } from "@remix-run/cloudflare";\n` +
      `import { useState } from "react";\n`;
    expect(run(src)).toBe(
      `import { Form, useLoaderData, data as json, redirect } from "react-router";\n` +
        `import type { ShouldRevalidateFunction, LoaderFunctionArgs } from "react-router";\n` +
        `import { useState } from "react";\n`
    );
  });

  it("keeps inline type specifiers as written", () => {
    expect(run(`import { type FetcherWithComponents, useFetcher } from "@remix-run/react";\n`)).toBe(
      `import { type FetcherWithComponents, useFetcher } from "react-router";\n`
    );
  });

  it("merges a file importing from both Remix packages into one react-router import", () => {
    const src =
      `import { Form, useActionData, useLoaderData, useNavigation } from "@remix-run/react";\n` +
      `import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/cloudflare";\n` +
      `import { json } from "@remix-run/cloudflare";\n` +
      `import { Plus } from "lucide-react";\n`;
    expect(run(src)).toBe(
      `import { Form, useActionData, useLoaderData, useNavigation, data as json } from "react-router";\n` +
        `import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";\n` +
        `import { Plus } from "lucide-react";\n`
    );
  });

  it("folds into an import from react-router that is already there", () => {
    const src =
      `import type { ShouldRevalidateFunction } from "@remix-run/react";\n` +
      `import { createMemoryRouter } from "react-router";\n`;
    expect(run(src)).toBe(
      `import { createMemoryRouter } from "react-router";\n` +
        `import type { ShouldRevalidateFunction } from "react-router";\n`
    );
  });

  it("reads a multi-line import and wraps a long merged one, one name per line", () => {
    const src =
      `import {\n  Form,\n  Link,\n  useActionData,\n  useFetcher,\n  useLoaderData,\n  useNavigation,\n  useSearchParams,\n} from "@remix-run/react";\n` +
      `import { json, redirect } from "@remix-run/cloudflare";\n`;
    expect(run(src)).toBe(
      `import {\n  Form,\n  Link,\n  useActionData,\n  useFetcher,\n  useLoaderData,\n  useNavigation,\n  useSearchParams,\n` +
        `  data as json,\n  redirect,\n} from "react-router";\n`
    );
  });

  it("throws on RemixServer and RemixBrowser, which are edited by hand", () => {
    expect(() => run(`import { RemixServer } from "@remix-run/react";\n`)).toThrow(/RemixServer/);
    expect(() => run(`import { RemixBrowser } from "@remix-run/react";\n`)).toThrow(/RemixBrowser/);
  });

  it("throws on an unlisted @remix-run/cloudflare name", () => {
    expect(() => run(`import { createCookieSessionStorage } from "@remix-run/cloudflare";\n`)).toThrow(
      /createCookieSessionStorage/
    );
  });

  it("leaves a file without Remix imports unchanged", () => {
    const src = `import { createMemoryRouter } from "react-router";\nimport { useState } from "react";\n`;
    expect(renameImports(src)).toEqual({ source: src, changed: false });
  });

  it("is idempotent: a second run changes nothing", () => {
    const first = renameImports(
      `import { Link } from "@remix-run/react";\nimport { json } from "@remix-run/cloudflare";\nvi.mock("@remix-run/react", () => ({}));\n`
    );
    expect(first.changed).toBe(true);
    expect(renameImports(first.source)).toEqual({ source: first.source, changed: false });
  });
});
