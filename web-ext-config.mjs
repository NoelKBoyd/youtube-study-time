// Settings for `npm run dev` and `npm run zip` (Mozilla's web-ext tool, which also drives Chrome).
import { fileURLToPath } from 'node:url';

// Chrome needs an absolute path here; a relative one makes it exit at startup.
const devProfile = fileURLToPath(new URL('./node_modules/.chrome-dev-profile', import.meta.url));

export default {
  // Dev tooling that must not end up in the packaged extension.
  ignoreFiles: [
    'node_modules',
    'test',
    'package.json',
    'package-lock.json',
    'web-ext-config.mjs',
    'web-ext-artifacts',
    'CLAUDE.md',
    'README.md',
    'FEATURES.md',
    '.gitignore'
  ],
  run: {
    startUrl: ['https://www.youtube.com/'],
    // Keep a separate dev profile so the API key and YouTube login survive restarts.
    chromiumProfile: devProfile,
    profileCreateIfMissing: true,
    keepProfileChanges: true,
    // web-ext always adds --disable-blink-features=AutomationControlled (so YouTube/Google
    // bot detection doesn't trip), which makes Chrome show an "unsupported command-line flag"
    // bar. --test-type hides that bar without changing anything else we rely on.
    args: ['--test-type']
  }
};
