import { networkInterfaces } from "node:os";
import { pathToFileURL } from "node:url";

// This machine's address on the local network - the one a phone or another
// PC can reach it at, as against "localhost", which every device resolves
// to itself.
//
// It exists because one setting genuinely cannot be localhost: S3_ENDPOINT
// (see orderPhotos.js). A photo is served through a presigned URL, that URL
// carries the storage host, and the phone fetches it directly - so the host
// has to be this machine's real address. Written into `.env` by hand it is
// the single most machine-specific line in the whole repo, stale the moment
// DHCP hands out another address and wrong on anybody else's computer,
// which is exactly what "it works on mine" is made of.
//
// So an unset (or `auto`) S3_ENDPOINT is answered from the network
// interfaces instead. An explicit value always wins - a real deployment
// behind a domain name has to say so.

// Private ranges in the order worth preferring: a home/office LAN first,
// then the big corporate 10/8, and only then 172.16/12, where Docker, WSL
// and Hyper-V put their own bridges (this machine has a 172.29.x one that
// no phone can reach).
const PRIVATE_RANKS = [
  { rank: 0, test: (ip) => ip.startsWith("192.168.") },
  { rank: 1, test: (ip) => ip.startsWith("10.") },
  {
    rank: 2,
    test: (ip) => {
      const [a, b] = ip.split(".").map(Number);
      return a === 172 && b >= 16 && b <= 31;
    },
  },
];

function rankOf(ip) {
  return PRIVATE_RANKS.find((r) => r.test(ip))?.rank ?? 3;
}

/**
 * The best guess at this machine's LAN IPv4, or null when there is none
 * (no network, or only loopback).
 *
 * Deliberately a guess with a visible answer rather than a clever one: the
 * caller logs what it picked at startup, so a machine with several NICs
 * shows the chosen address in the first lines of the log instead of failing
 * silently hours later on a photo nobody can open.
 */
export function lanAddress() {
  const candidates = [];
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family !== "IPv4" || address.internal) continue;
      // 169.254/16 is what an interface gets when DHCP failed - never an
      // address anything can be reached at.
      if (address.address.startsWith("169.254.")) continue;
      candidates.push(address.address);
    }
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => rankOf(a) - rankOf(b));
  return candidates[0];
}

// Also runnable as a one-liner: `node src/lanAddress.js` prints the
// address and exits 1 when there is none. That is how tools/build-apk.*
// ask for it - a Flutter build has to bake this machine's address into the
// app, and the alternative was each script carrying its own copy of the
// heuristic above and drifting from it.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const found = lanAddress();
  if (!found) process.exit(1);
  console.log(found);
}
