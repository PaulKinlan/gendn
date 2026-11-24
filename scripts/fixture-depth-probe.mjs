// A finite, non-discovered probe for gendn-r3b: show the exact inherited marker/token chain.
// One Deno process prints its environment and exits; never invokes the aggregate.

import * as sys from "./lib/sys.mjs";
console.log(
  `fixture-depth-probe: marker=${sys.env.get("GENDN_FIXTURE_RUN") ?? ""} ` +
    `tokens=${sys.env.get("GENDN_FIXTURE_TOKEN") ?? ""}`,
);
