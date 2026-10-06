// A finite, non-discovered probe for gendn-r3b: show the exact inherited marker/token chain.
// One Deno process prints its environment and exits; never invokes the aggregate.
console.log(
  `fixture-depth-probe: marker=${Deno.env.get("GENDN_FIXTURE_RUN") ?? ""} ` +
    `tokens=${Deno.env.get("GENDN_FIXTURE_TOKEN") ?? ""}`,
);
