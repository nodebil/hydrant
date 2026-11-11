import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ResolverDefinition } from "@types";
import { Downloader } from "../../../shared/constants.js";
import { UnsupportedSourceError } from "../source-fetch/errors.js";
import {
  getResolver,
  getResolverForUrl,
  listResolvers,
  registerResolver,
} from "./registry.js";

const makeResolver = (
  id: string,
  priority: number,
  hosts: string[]
): ResolverDefinition => ({
  id,
  downloader: Downloader.Gofile,
  priority,
  matches: (url) => hosts.includes(url.hostname),
  resolve: async () => ({ url: "https://cdn.example/file.bin" }),
});

describe("resolver registry", () => {
  it("registers resolvers and rejects duplicate ids", () => {
    const resolver = makeResolver("registry-dup-resolver", 1, ["dup.example"]);

    registerResolver(resolver);

    assert.equal(getResolver("registry-dup-resolver"), resolver);
    assert.throws(
      () => registerResolver(makeResolver("registry-dup-resolver", 2, [])),
      /already registered/
    );
  });

  it("throws UnsupportedSourceError for unknown resolvers and hosts", () => {
    assert.throws(
      () => getResolver("registry-missing-resolver"),
      (error: unknown) =>
        error instanceof UnsupportedSourceError &&
        error.code === "UNSUPPORTED_HOSTER"
    );

    assert.throws(
      () => getResolverForUrl("https://unregistered.example/file"),
      (error: unknown) =>
        error instanceof UnsupportedSourceError &&
        error.code === "UNSUPPORTED_HOSTER"
    );

    assert.throws(
      () => getResolverForUrl("not a url"),
      (error: unknown) =>
        error instanceof UnsupportedSourceError &&
        error.code === "UNSUPPORTED_HOSTER"
    );

    assert.throws(
      () => getResolverForUrl("javascript:alert(1)"),
      (error: unknown) =>
        error instanceof UnsupportedSourceError &&
        error.code === "UNSUPPORTED_HOSTER"
    );
  });

  it("matches hostnames and picks the highest-priority resolver", () => {
    registerResolver(
      makeResolver("registry-resolver-generic", 50, ["files.example"])
    );
    registerResolver(
      makeResolver("registry-resolver-specific", 10, ["files.example"])
    );
    registerResolver(
      makeResolver("registry-resolver-tie-b", 20, ["other.example"])
    );
    registerResolver(
      makeResolver("registry-resolver-tie-a", 20, ["other.example"])
    );

    assert.equal(
      getResolverForUrl("https://files.example/a").id,
      "registry-resolver-specific"
    );
    assert.equal(
      getResolverForUrl(new URL("https://other.example/a")).id,
      "registry-resolver-tie-a"
    );
  });

  it("lists resolvers by priority then id", () => {
    registerResolver(makeResolver("registry-list-b", 20, []));
    registerResolver(makeResolver("registry-list-a", 20, []));
    registerResolver(makeResolver("registry-list-c", 10, []));

    const ids = listResolvers()
      .map((resolver) => resolver.id)
      .filter((id) => id.startsWith("registry-list-"));

    assert.deepEqual(ids, [
      "registry-list-c",
      "registry-list-a",
      "registry-list-b",
    ]);
  });
});
