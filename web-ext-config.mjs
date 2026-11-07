// Settings for `npm run dev` and `npm run zip` (Mozilla's web-ext tool, which also drives Chrome).
import { fileURLToPath } from 'node:url';

// Chrome needs absolute paths here; a relative one makes it exit at startup.
const path = (relative) => fileURLToPath(new URL(relative, import.meta.url));

export default {
  // Only extension/ is loaded and packaged, so dev files (tests, docs, package.json)
  // at the top level never end up in the zip.
  sourceDir: path('./extension'),
  artifactsDir: path('./web-ext-artifacts'),
  run: {
    startUrl: ['https://www.youtube.com/'],
    // Keep a separate dev profile so the API key and YouTube login survive restarts.
    chromiumProfile: path('./node_modules/.chrome-dev-profile'),
    profileCreateIfMissing: true,
    keepProfileChanges: true,
    // web-ext always adds --disable-blink-features=AutomationControlled (so YouTube/Google
    // bot detection doesn't trip), which makes Chrome show an "unsupported command-line flag"
    // bar. --test-type hides that bar without changing anything else we rely on.
    args: ['--test-type']
  }
};
