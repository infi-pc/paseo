import type { LookupOptions } from "node:dns";
import type { LookupFunction } from "node:net";

function lookupServiceLoopback(
  _hostname: string,
  options: LookupOptions,
  callback: Parameters<LookupFunction>[2],
): void {
  const addresses = [
    { address: "127.0.0.1", family: 4 },
    { address: "::1", family: 6 },
  ];
  if (options.all) {
    process.nextTick(callback, null, addresses);
  } else {
    process.nextTick(callback, null, addresses[0].address, addresses[0].family);
  }
}

// Keep service traffic on loopback, independent of the machine's localhost DNS entries.
export const serviceLoopbackOptions = {
  host: "localhost",
  autoSelectFamily: true,
  lookup: lookupServiceLoopback,
};
