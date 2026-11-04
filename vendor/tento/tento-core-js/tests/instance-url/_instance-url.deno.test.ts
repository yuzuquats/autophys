import { assertEquals } from "jsr:@std/assert";
import { InstanceUrl, type ServiceDomain } from "@tento-core/instance-url.ts";
import { Fixtures } from "../fixture-runner.deno.ts";

type Input =
  | {
    fn: "parseHostname";
    hostname: string;
  }
  | {
    fn: "isRootDomainForHostname";
    hostname: string;
  }
  | {
    fn: "subdomainForHostname";
    hostname: string;
    service?: ServiceDomain;
  }
  | {
    fn: "hostForHostname";
    hostname: string;
    service?: ServiceDomain | null;
  }
  | {
    fn: "urlForHostname";
    hostname: string;
    path?: string;
    service?: ServiceDomain | null;
    protocol?: string;
  }
  | {
    fn: "allowedOriginsForHostname";
    hostname: string;
    protocol?: string;
  };

Fixtures.load<Input, UntypedJson>(
  new URL(".", import.meta.url).pathname,
  "instance-url",
).run(
  (input) => {
    if (input.fn === "parseHostname") {
      return InstanceUrl.parseHostname(input.hostname);
    }
    if (input.fn === "isRootDomainForHostname") {
      return InstanceUrl.isRootDomainForHostname(input.hostname);
    }
    if (input.fn === "subdomainForHostname") {
      return InstanceUrl.subdomainForHostname(
        input.hostname,
        input.service ?? "static",
      );
    }
    if (input.fn === "hostForHostname") {
      return InstanceUrl.hostForHostname(input.hostname, input.service ?? null);
    }
    if (input.fn === "urlForHostname") {
      return InstanceUrl.urlForHostname(
        input.hostname,
        input.path ?? "",
        input.service ?? null,
        input.protocol ?? "https:",
      );
    }
    return InstanceUrl.allowedOriginsForHostname(
      input.hostname,
      input.protocol ?? "https:",
    );
  },
  (result, expected) => {
    assertEquals(result, expected);
  },
);
