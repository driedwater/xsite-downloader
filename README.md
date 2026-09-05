# xSiTe weekly downloader

Downloads newly released weekly files from SIT xSiTe / Brightspace.

- Uses Playwright only for login.
- Uses the authenticated Brightspace content API for course files.
- Tracks `.xsite-manifest.json`, so weekly reruns download only new/changed files.
- No credentials are stored in the script. `.env` and browser session files are git-ignored.

## Setup

Install Node.js LTS first. Then, in this folder:

```bash
npm install
npx playwright install chromium
```

These commands work in Windows PowerShell too.

Optional credentials file:

```bash
cp .env.example .env
# edit .env with your own xSiTe username/password
```

If you do not create `.env`, the script prompts for username/password each run. For SSO/MFA trouble, use manual login:

```bash
node download-xsite.js --interactive-login --headed --list-courses
```

## Find your course URLs

```bash
node download-xsite.js --list-courses --headed
```

Copy the `https://xsite.singaporetech.edu.sg/d2l/home/...` URLs you want.

## Configure courses

```bash
cp xsite-courses.example.json xsite-courses.json
```

Edit `xsite-courses.json`:

```json
{
  "downloadDir": "./xsite-downloads",
  "includePathRegex": ["Week\\s+\\d+", "E[- ]?Learning"],
  "excludePathRegex": [],
  "courses": [
    {
      "code": "INFXXXX",
      "name": "Course name",
      "homeUrl": "https://xsite.singaporetech.edu.sg/d2l/home/123456"
    }
  ]
}
```

`includePathRegex` matches the full content path, e.g. `Lectures / Week 5 / Lecture PDF`.

## Run weekly

```bash
node download-xsite.js --config xsite-courses.json
```

Useful variants:

```bash
# preview only
node download-xsite.js --config xsite-courses.json --dry-run

# visible browser for login debugging
node download-xsite.js --config xsite-courses.json --headed

# one course without config
node download-xsite.js --course-url https://xsite.singaporetech.edu.sg/d2l/home/123456 --course-code INFXXXX

# if Playwright Chromium is not installed but Google Chrome is
node download-xsite.js --config xsite-courses.json --chrome
```

## Private-laptop session reuse

Default behavior logs out at the end. On a private laptop, you can save cookies and skip repeated login:

```bash
node download-xsite.js --config xsite-courses.json --interactive-login --save-session --no-logout
node download-xsite.js --config xsite-courses.json --no-logout
```

If the saved session expires, rerun the first command.

## Output

Files are saved as:

```text
xsite-downloads/<course-code>/<content module>/<week>/<topic title>.<ext>
```

Manifest:

```text
xsite-downloads/.xsite-manifest.json
```

Do not send/share `.env`, `.auth/`, or `xsite-downloads/` unless you intend to share the downloaded course materials.
