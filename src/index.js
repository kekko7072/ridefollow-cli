import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { parseTarget } from './link.js';
import { follow } from './follow.js';

function version() {
  try {
    const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'));
    return pkg.version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

const HELP = `ridefollow-cli — follow a live RideFollow bike ride from your terminal

USAGE
  ridefollow-cli <share-link | token>
  npx ridefollow-cli https://ridefollow.live/?ride=<token>

OPTIONS
  -n, --name <name>   the name shown on a cheer you send      (env RIDEFOLLOW_NAME)
      --api <url>     override the control-plane API base      (env RIDEFOLLOW_API)
      --insecure      skip TLS certificate verification (dev brokers only)
  -h, --help          show this help
  -v, --version       print the version

WHILE WATCHING
  q / Esc   quit                    c   send a cheer to the rider

The rider shares a private link from the RideFollow app; paste it here and you'll
watch their ride on a live terminal dashboard — speed, distance, ETA, route
progress and an event feed, like race day.
Learn more at https://ridefollow.live
`;

export async function main(argv) {
  const opts = { name: '', api: '', insecure: false };
  const positional = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') {
      process.stdout.write(HELP);
      return;
    }
    if (a === '-v' || a === '--version') {
      process.stdout.write(version() + '\n');
      return;
    }
    if (a === '-n' || a === '--name') {
      opts.name = argv[++i] || '';
    } else if (a.startsWith('--name=')) {
      opts.name = a.slice('--name='.length);
    } else if (a === '--api') {
      opts.api = argv[++i] || '';
    } else if (a.startsWith('--api=')) {
      opts.api = a.slice('--api='.length);
    } else if (a === '--insecure') {
      opts.insecure = true;
    } else if (a.startsWith('-')) {
      throw new Error(`unknown option "${a}" — run \`ridefollow-cli --help\``);
    } else {
      positional.push(a);
    }
  }

  if (positional.length === 0) {
    process.stdout.write(HELP);
    throw new Error('paste the ride share link (or its token) to start following');
  }

  const target = parseTarget(positional[0], { apiOverride: opts.api || process.env.RIDEFOLLOW_API });
  await follow(target, { name: opts.name, insecure: opts.insecure });
}
